import { describe, expect, test } from "bun:test"
import {
  humanizeCost,
  humanizeDuration,
  humanizeRate,
  humanizeTPS,
  humanizeTokens,
  retryLabel,
  singleLine,
  tokenTriple,
} from "../src/format"
import {
  aggregateModels,
  aggregateSessions,
  aggregateTotal,
  countExcludedInternalSessions,
  groupErrors,
  isTimeoutTurn,
  parseSince,
  selectCalls,
  selectTurns,
  sessionTotals,
  turnFirstTokenMs,
  turnQueueMs,
  turnRoundMs,
  turnStatus,
  type MessageRecord,
  type SessionRecord,
  type TurnRecord,
} from "../src/query"
import type { CallRow } from "../src/reducer"

const baseCall: CallRow = {
  callID: "call_1",
  assistantMessageID: "msg_1",
  sessionID: "ses_one",
  parentSessionID: null,
  kind: "step",
  agent: "build",
  providerID: "provider",
  modelID: "model",
  modelVariant: null,
  directory: "/work",
  startedAt: 1_000,
  firstTokenAt: 1_300,
  firstTextAt: 1_800,
  streamedAt: 3_800,
  endedAt: 4_000,
  tokensInput: 200,
  tokensOutput: 100,
  tokensReasoning: 20,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  costUSD: 0.001,
  finish: "stop",
  rawFinish: "stop",
  status: "completed",
  error: null,
  turnID: null,
  errorType: null,
  errorMessage: null,
  errorStatus: null,
  errorRetryAfterMs: null,
  retries: 0,
  lastRetryErrorType: null,
  lastRetryAt: null,
  recordedAt: 5_000,
}

function call(overrides: Partial<CallRow>): CallRow {
  return { ...baseCall, ...overrides }
}

const baseSession: SessionRecord = {
  id: "ses_one",
  title: "One",
  internal: false,
  costUSD: 0.001,
  tokensInput: 10,
  tokensOutput: 20,
  tokensReasoning: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  timeCreated: 1_000,
  timeUpdated: 2_000,
}

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return { ...baseSession, ...overrides }
}

const baseMessage: MessageRecord = {
  id: "msg_1",
  sessionID: "ses_one",
  type: "assistant",
  timeCreated: 2_000,
  costUSD: 0.001,
  tokensInput: 10,
  tokensOutput: 20,
  tokensReasoning: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  providerID: "provider",
  modelID: "model",
}

function message(overrides: Partial<MessageRecord>): MessageRecord {
  return { ...baseMessage, ...overrides }
}

const baseTurn: TurnRecord = {
  turnID: "turn_1",
  sessionID: "ses_one",
  directory: "/work",
  queuedAt: 1_000,
  acceptedAt: 1_100,
  startedAt: 1_200,
  endedAt: 2_200,
  status: "completed",
  interruptReason: null,
  errorType: null,
  errorMessage: null,
  errorStatus: null,
  prompts: 1,
  compactions: 0,
  steers: 1,
  retries: 0,
  firstTokenAt: 1_500,
  recordedAt: 1_200,
  updatedAt: 2_200,
}

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return { ...baseTurn, ...overrides }
}

describe("since parsing", () => {
  const now = 1_800_000_000_000

  test("parses relative windows", () => {
    expect(parseSince("7d", now)).toEqual({ ok: true, since: now - 7 * 86_400_000 })
    expect(parseSince("24h", now)).toEqual({ ok: true, since: now - 24 * 3_600_000 })
    expect(parseSince("30m", now)).toEqual({ ok: true, since: now - 30 * 60_000 })
  })

  test("parses an absolute local date", () => {
    expect(parseSince("2026-10-01", now)).toEqual({ ok: true, since: new Date(2026, 9, 1).getTime() })
  })

  test("rejects malformed and impossible values", () => {
    expect(parseSince("7w", now).ok).toBe(false)
    expect(parseSince("2026-02-31", now).ok).toBe(false)
    expect(parseSince("yesterday", now).ok).toBe(false)
  })
})

describe("session aggregation", () => {
  const sessions = [
    session({ id: "ses_one", timeUpdated: 3_000 }),
    session({ id: "ses_two", title: "Two", timeUpdated: 1_000 }),
  ]
  const messages = [
    message({ id: "msg_1", sessionID: "ses_one" }),
    message({ id: "msg_2", sessionID: "ses_one" }),
    message({ id: "msg_user", sessionID: "ses_one", type: "user", costUSD: null }),
    message({ id: "msg_3", sessionID: "ses_two", costUSD: 0.002 }),
  ]
  const calls = [
    // TTFT is a valid zero for this attempt; it must not become null.
    call({ callID: "zero", sessionID: "ses_one", firstTokenAt: 1_000, firstTextAt: null, streamedAt: null }),
    call({ callID: "normal", sessionID: "ses_one", startedAt: 1_000, firstTokenAt: 1_500, firstTextAt: 1_600 }),
  ]

  test("counts steps and enriches with sidecar calls", () => {
    const rows = aggregateSessions(sessions, messages, calls, null)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: "ses_one", steps: 2, recordedCalls: 2, avgTTFT: 250 })
    expect(rows[0]!.avgTPS).toBeCloseTo(100 / 2.2)
    expect(rows[1]).toMatchObject({ id: "ses_two", steps: 1, recordedCalls: 0, avgTTFT: null, avgTPS: null })
  })

  test("a session with no recorded calls reports null, not zero latency", () => {
    const rows = aggregateSessions([session({ id: "ses_empty" })], [], [], null)
    expect(rows[0]!.recordedCalls).toBe(0)
    expect(rows[0]!.avgTTFT).toBeNull()
    expect(rows[0]!.avgTPS).toBeNull()
  })

  test("a real zero TTFT stays zero", () => {
    const rows = aggregateSessions(
      [session({ id: "ses_one" })],
      [],
      [call({ callID: "zero", startedAt: 1_000, firstTokenAt: 1_000, streamedAt: null })],
      null,
    )
    expect(rows[0]!.avgTTFT).toBe(0)
    expect(rows[0]!.avgTPS).toBeNull()
  })

  test("filters by session update time and sorts newest first", () => {
    const rows = aggregateSessions(sessions, messages, calls, 2_000)
    expect(rows.map((row) => row.id)).toEqual(["ses_one"])
  })

  test("summary totals equal the per-session sums", () => {
    const rows = aggregateSessions(sessions, messages, calls, null)
    const totals = sessionTotals(rows, calls)
    expect(totals.sessions).toBe(rows.length)
    expect(totals.steps).toBe(rows.reduce((total, row) => total + row.steps, 0))
    expect(totals.tokensInput).toBe(rows.reduce((total, row) => total + row.tokensInput, 0))
    expect(totals.tokensOutput).toBe(rows.reduce((total, row) => total + row.tokensOutput, 0))
    expect(totals.costUSD).toBeCloseTo(rows.reduce((total, row) => total + row.costUSD, 0))
    expect(totals.recordedCalls).toBe(rows.reduce((total, row) => total + row.recordedCalls, 0))
    expect(totals.avgTTFT).toBe(250)
  })
})

describe("model aggregation", () => {
  const messages = [
    message({ id: "m1", sessionID: "ses_a", costUSD: 0.001, tokensInput: 10, tokensOutput: 20 }),
    message({ id: "m2", sessionID: "ses_a", costUSD: 0.001, tokensInput: 10, tokensOutput: 20 }),
    message({ id: "m3", sessionID: "ses_b", costUSD: 0.002, tokensInput: 5, tokensOutput: 5 }),
    message({
      id: "m4",
      sessionID: "ses_c",
      providerID: "other",
      modelID: "small",
      costUSD: 0.0005,
      tokensInput: 1,
      tokensOutput: 1,
    }),
    message({ id: "user", sessionID: "ses_a", type: "user", costUSD: null }),
  ]
  const calls = [
    call({ callID: "c1", sessionID: "ses_a", startedAt: 1_000, firstTokenAt: 1_300, streamedAt: 3_800 }),
    call({ callID: "c2", sessionID: "ses_a", startedAt: 1_000, firstTokenAt: 1_500, streamedAt: 3_800 }),
  ]

  test("groups by provider/model, counts steps, and sorts by cost", () => {
    const rows = aggregateModels(messages, calls, null)
    expect(rows.map((row) => [row.providerID, row.modelID, row.calls, row.sessions])).toEqual([
      ["provider", "model", 3, 2],
      ["other", "small", 1, 1],
    ])
    expect(rows[0]).toMatchObject({
      tokensInput: 25,
      tokensOutput: 45,
      costUSD: 0.004,
      avgTTFT: 400,
    })
    expect(rows[1]).toMatchObject({ avgTTFT: null, avgTPS: null })
  })

  test("filters assistant rows and sidecar calls by the window", () => {
    const rows = aggregateModels(messages, calls, 2_001)
    expect(rows).toEqual([])
  })
})

describe("internal-test filtering", () => {
  const sessions = [
    session({ id: "ses_real", title: "Real work", timeUpdated: 4_000 }),
    session({ id: "ses_test", title: "[OC2 internal test] usage verify", internal: true, timeUpdated: 5_000 }),
  ]
  const messages = [
    message({ id: "m_real", sessionID: "ses_real", costUSD: 0.001, tokensInput: 10, tokensOutput: 20 }),
    message({ id: "u_real", sessionID: "ses_real", type: "user", costUSD: null }),
    message({
      id: "m_test",
      sessionID: "ses_test",
      providerID: "mock",
      modelID: "mock-model",
      costUSD: 0.002,
      tokensInput: 1,
      tokensOutput: 2,
    }),
  ]
  const calls = [
    call({ callID: "c_real", sessionID: "ses_real", startedAt: 3_000, providerID: "provider", modelID: "model" }),
    call({ callID: "c_test", sessionID: "ses_test", startedAt: 4_000, providerID: "mock", modelID: "mock-model" }),
    call({ callID: "c_missing", sessionID: "ses_missing", startedAt: 2_000 }),
  ]
  const internalSessions = new Set(["ses_test"])

  test("sessions hide internal rows by default and count the exclusion", () => {
    const rows = aggregateSessions(sessions, messages, calls, null)
    expect(rows.map((row) => row.id)).toEqual(["ses_real"])
    expect(rows[0]!.internal).toBe(false)
    expect(countExcludedInternalSessions(sessions, null, false)).toBe(1)

    const included = aggregateSessions(sessions, messages, calls, null, true)
    expect(included.map((row) => row.id)).toEqual(["ses_test", "ses_real"])
    expect(included[0]!.internal).toBe(true)
    expect(countExcludedInternalSessions(sessions, null, true)).toBe(0)
  })

  test("session totals expose the excluded count", () => {
    const rows = aggregateSessions(sessions, messages, calls, null)
    const totals = sessionTotals(rows, calls, 1)
    expect(totals.sessions).toBe(1)
    expect(totals.excludedInternal).toBe(1)
    expect(totals.recordedCalls).toBe(1)
  })

  test("calls exclude internal sessions but keep calls for unknown sessions", () => {
    const hidden = selectCalls(calls, {
      since: null,
      session: null,
      limit: 10,
      internalSessions,
    })
    expect(hidden.rows.map((view) => view.call.callID)).toEqual(["c_real", "c_missing"])
    expect(hidden.rows.map((view) => view.internal)).toEqual([false, false])
    expect(hidden.excludedInternal).toBe(1)

    const included = selectCalls(calls, {
      since: null,
      session: null,
      limit: 10,
      internalSessions,
      includeInternal: true,
    })
    expect(included.rows.map((view) => view.call.callID)).toEqual(["c_test", "c_real", "c_missing"])
    expect(included.rows[0]!.internal).toBe(true)
    expect(included.excludedInternal).toBe(0)
  })

  test("models hide internal sessions by default and mark included rows", () => {
    const hidden = aggregateModels(messages, calls, null, internalSessions)
    expect(hidden.map((row) => row.modelID)).toEqual(["model"])
    expect(hidden[0]!.internal).toBe(false)

    const included = aggregateModels(messages, calls, null, internalSessions, true)
    expect(included.map((row) => row.modelID)).toEqual(["mock-model", "model"])
    expect(included[0]).toMatchObject({ modelID: "mock-model", internal: true, calls: 1 })
    expect(included[1]!.internal).toBe(false)
  })

  test("totals hide internal sessions and their sidecar calls by default", () => {
    const hidden = aggregateTotal(messages, calls, null, internalSessions)
    expect(hidden).toMatchObject({
      sessions: 1,
      prompts: 1,
      steps: 1,
      tokensInput: 10,
      tokensOutput: 20,
      costUSD: 0.001,
      excludedInternal: 1,
    })
    expect(hidden.sidecar.calls).toBe(2)

    const included = aggregateTotal(messages, calls, null, internalSessions, true)
    expect(included).toMatchObject({ sessions: 2, prompts: 1, steps: 2, excludedInternal: 0 })
    expect(included.sidecar.calls).toBe(3)
  })
})

describe("round math and status", () => {
  test("queue, round, and first-token math handle NULL cases", () => {
    expect(turnQueueMs(turn({ queuedAt: null }))).toBeNull()
    expect(turnQueueMs(turn({ queuedAt: 1_000, startedAt: 1_250 }))).toBe(250)
    expect(turnRoundMs(turn({ acceptedAt: 1_100, startedAt: 1_200, endedAt: 2_200 }))).toBe(1_100)
    expect(turnRoundMs(turn({ acceptedAt: null, startedAt: 1_200, endedAt: 2_200 }))).toBe(1_000)
    expect(turnRoundMs(turn({ endedAt: null }))).toBeNull()
    expect(turnFirstTokenMs(turn({ firstTokenAt: 1_500, startedAt: 1_200 }))).toBe(300)
    expect(turnFirstTokenMs(turn({ firstTokenAt: null }))).toBeNull()
  })

  test("a running round is stale only after an hour without updates", () => {
    const now = 10_000_000
    expect(turnStatus(turn({ status: "running", updatedAt: now - 3_600_001 }), now)).toBe("stale")
    expect(turnStatus(turn({ status: "running", updatedAt: now - 3_600_000 }), now)).toBe("running")
    expect(turnStatus(turn({ status: "completed", updatedAt: now - 7_200_000 }), now)).toBe("completed")
  })

  test("timeout covers provider.timeout and inactivity interruption", () => {
    expect(isTimeoutTurn(turn({ status: "failed", errorType: "provider.timeout" }))).toBe(true)
    expect(isTimeoutTurn(turn({ status: "interrupted", interruptReason: "inactivity" }))).toBe(true)
    expect(isTimeoutTurn(turn({ status: "interrupted", interruptReason: "user" }))).toBe(false)
  })

  test("session p50 and total round metrics include completed and failed rounds", () => {
    const turns = [
      turn({ turnID: "r1", status: "completed", acceptedAt: 1_100, startedAt: 1_200, endedAt: 2_200 }),
      turn({ turnID: "r2", status: "completed", acceptedAt: 1_100, startedAt: 1_200, endedAt: 3_200 }),
      turn({ turnID: "r3", status: "failed", errorType: "provider.internal" }),
      turn({ turnID: "r4", status: "interrupted", interruptReason: "inactivity" }),
    ]
    const rows = aggregateSessions([session({ id: "ses_one" })], [], [], null, false, turns)
    expect(rows[0]).toMatchObject({ roundP50Ms: 1_600, failedRounds: 2 })
    const totals = aggregateTotal([], [], null, new Set(), false, turns)
    expect(totals).toMatchObject({
      rounds: 4,
      failedRounds: 1,
      timeouts: 1,
      errorRate: 0.5,
    })
    expect(totals.p95RoundMs).toBeCloseTo(2_050)
  })
})

describe("turn selection and error grouping", () => {
  const now = 10_000_000
  const turns = [
    turn({ turnID: "t_completed", startedAt: 4_000, updatedAt: 4_500 }),
    turn({ turnID: "t_failed", startedAt: 3_000, status: "failed", errorType: "provider.internal" }),
    turn({
      turnID: "t_running",
      startedAt: 2_000,
      status: "running",
      endedAt: null,
      updatedAt: now - 10_000,
    }),
    turn({
      turnID: "t_stale",
      startedAt: 1_000,
      status: "running",
      endedAt: null,
      updatedAt: now - 3_600_001,
    }),
  ]
  const selection = {
    since: null,
    limit: 10,
    session: null,
    status: null,
    errorsOnly: false,
    includeInternal: false,
    internalSessions: new Set<string>(),
    titles: new Map([["ses_one", "One"]]),
  }

  test("--errors keeps every round whose displayed status is not completed", () => {
    const all = selectTurns(turns, [], selection, now)
    expect(all.rows.map((row) => row.status)).toEqual(["completed", "failed", "running", "stale"])
    const errors = selectTurns(turns, [], { ...selection, errorsOnly: true }, now)
    expect(errors.rows.map((row) => row.turnID)).toEqual(["t_failed", "t_running", "t_stale"])
  })

  test("status filtering uses the stale classification", () => {
    const stale = selectTurns(turns, [], { ...selection, status: "stale" }, now)
    expect(stale.rows.map((row) => row.turnID)).toEqual(["t_stale"])
    const running = selectTurns(turns, [], { ...selection, status: "running" }, now)
    expect(running.rows.map((row) => row.turnID)).toEqual(["t_running"])
  })

  test("turn rows count linked calls and sum their cost and tokens", () => {
    const calls = [
      call({ callID: "c1", turnID: "t_completed", costUSD: 0.001, tokensInput: 10, tokensOutput: 20 }),
      call({ callID: "c2", turnID: "t_completed", costUSD: 0.002, tokensInput: 1, tokensOutput: 2 }),
      call({ callID: "c3", turnID: null, costUSD: 9, tokensInput: 999, tokensOutput: 999 }),
    ]
    const rows = selectTurns(turns, calls, selection, now)
    expect(rows.rows.find((row) => row.turnID === "t_completed")).toMatchObject({
      calls: 2,
      costUSD: 0.003,
      tokensInput: 11,
      tokensOutput: 22,
    })
  })

  test("internal turns are excluded by default and counted", () => {
    const real = turn({ turnID: "t_real", sessionID: "ses_real" })
    const test = turn({ turnID: "t_test", sessionID: "ses_test" })
    const internalSessions = new Set(["ses_test"])
    const hidden = selectTurns([real, test], [], { ...selection, internalSessions }, now)
    expect(hidden.rows.map((row) => row.turnID)).toEqual(["t_real"])
    expect(hidden.excludedInternal).toBe(1)
    const included = selectTurns([real, test], [], { ...selection, internalSessions, includeInternal: true }, now)
    expect(included.rows.map((row) => row.turnID)).toEqual(["t_real", "t_test"])
    expect(included.rows[1]!.internal).toBe(true)
    expect(included.excludedInternal).toBe(0)
  })

  test("errors group by source and type, sort by count, and keep the last message", () => {
    const calls = [
      call({
        callID: "c_rate_1",
        status: "failed",
        errorType: "provider.rate-limit",
        errorMessage: "limited once",
        endedAt: 10_000,
      }),
      call({
        callID: "c_rate_2",
        status: "failed",
        errorType: "provider.rate-limit",
        errorMessage: "limited again",
        endedAt: 20_000,
      }),
      call({
        callID: "c_internal",
        status: "failed",
        errorType: "provider.internal",
        errorMessage: "boom",
        endedAt: 15_000,
      }),
      call({ callID: "c_completed", status: "completed", endedAt: 30_000 }),
      call({ callID: "c_none", status: "interrupted", errorType: null, endedAt: 12_000 }),
    ]
    const roundErrors = [
      turn({ turnID: "t_500", status: "failed", errorType: "provider.internal", endedAt: 16_000 }),
      turn({ turnID: "t_timeout", status: "interrupted", interruptReason: "inactivity", endedAt: 17_000 }),
    ]
    const groups = groupErrors({
      calls,
      turns: roundErrors,
      since: null,
      internalSessions: new Set(),
      includeInternal: false,
      sources: "both",
    })
    expect(groups[0]).toMatchObject({ errorType: "provider.rate-limit", source: "call", count: 2 })
    expect(groups[0]!.lastMessage).toBe("limited again")
    expect(groups.map((group) => [group.errorType, group.source])).toEqual([
      ["provider.rate-limit", "call"],
      ["provider.internal", "call"],
      ["provider.internal", "turn"],
      ["provider.timeout", "turn"],
      [null, "call"],
    ])
    const onlyTurns = groupErrors({
      calls,
      turns: roundErrors,
      since: null,
      internalSessions: new Set(),
      includeInternal: false,
      sources: "turns",
    })
    expect(onlyTurns.every((group) => group.source === "turn")).toBe(true)
    expect(onlyTurns).toHaveLength(2)
  })
})

describe("humanization", () => {
  test("tokens", () => {
    expect(humanizeTokens(0)).toBe("0")
    expect(humanizeTokens(999)).toBe("999")
    expect(humanizeTokens(1_200)).toBe("1.2k")
    expect(humanizeTokens(3_400_000)).toBe("3.4m")
    expect(humanizeTokens(null)).toBe("—")
    expect(tokenTriple(null, null, null)).toBe("—")
  })

  test("cost", () => {
    expect(humanizeCost(0)).toBe("$0")
    expect(humanizeCost(0.0004)).toBe("<$0.001")
    expect(humanizeCost(0.0014)).toBe("$0.0014")
    expect(humanizeCost(null)).toBe("—")
  })

  test("durations distinguish missing from zero", () => {
    expect(humanizeDuration(428)).toBe("428ms")
    expect(humanizeDuration(1_200)).toBe("1.2s")
    expect(humanizeDuration(0)).toBe("0ms")
    expect(humanizeDuration(null)).toBe("—")
  })

  test("TPS uses one decimal and never prints NaN", () => {
    expect(humanizeTPS(50)).toBe("50.0")
    expect(humanizeTPS(0)).toBe("0.0")
    expect(humanizeTPS(null)).toBe("—")
    expect(humanizeTPS(Number.NaN)).toBe("—")
  })

  test("retry, rate, and single-line helpers", () => {
    expect(retryLabel(0)).toBe("—")
    expect(retryLabel(3)).toBe("3")
    expect(humanizeRate(0.125)).toBe("12.5%")
    expect(humanizeRate(null)).toBe("—")
    expect(singleLine("first line\n  second line", 40)).toBe("first line second line")
    expect(singleLine(null, 40)).toBe("—")
  })
})
