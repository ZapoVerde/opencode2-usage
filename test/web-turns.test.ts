import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { SessionRecord, TurnRecord } from "../src/query"
import type { CallRow } from "../src/reducer"
import { readTurns } from "../src/read"
import { handleApi, type ApiResult, type WebSnapshot } from "../web/api"

const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime()
const STARTED = new Date(2026, 9, 24, 10, 0, 0).getTime()

const baseSession: SessionRecord = {
  id: "ses_real",
  title: "Real work",
  internal: false,
  costUSD: 1,
  tokensInput: 100,
  tokensOutput: 50,
  tokensReasoning: 10,
  tokensCacheRead: 500,
  tokensCacheWrite: 0,
  timeCreated: new Date(2026, 9, 23, 10).getTime(),
  timeUpdated: new Date(2026, 9, 24, 11).getTime(),
}

const baseCall: CallRow = {
  callID: "call_1",
  assistantMessageID: "msg_real",
  sessionID: "ses_real",
  parentSessionID: null,
  kind: "step",
  agent: "build",
  providerID: "provider",
  modelID: "model",
  modelVariant: null,
  directory: "/work",
  startedAt: STARTED,
  firstTokenAt: STARTED + 1_000,
  firstTextAt: STARTED + 1_100,
  streamedAt: STARTED + 2_000,
  endedAt: STARTED + 2_100,
  tokensInput: 10,
  tokensOutput: 5,
  tokensReasoning: 1,
  tokensCacheRead: 20,
  tokensCacheWrite: 0,
  costUSD: 0.1,
  finish: "stop",
  rawFinish: "stop",
  status: "completed",
  error: null,
  turnID: "turn_1",
  errorType: null,
  errorMessage: null,
  errorStatus: null,
  errorRetryAfterMs: null,
  retries: 0,
  lastRetryErrorType: null,
  lastRetryAt: null,
  recordedAt: STARTED + 2_100,
}

const baseTurn: TurnRecord = {
  turnID: "turn_1",
  sessionID: "ses_real",
  directory: "/work",
  queuedAt: STARTED - 2_000,
  acceptedAt: STARTED,
  startedAt: STARTED,
  endedAt: STARTED + 30_000,
  status: "completed",
  interruptReason: null,
  errorType: null,
  errorMessage: null,
  errorStatus: null,
  prompts: 1,
  compactions: 0,
  steers: 1,
  retries: 0,
  firstTokenAt: STARTED + 5_000,
  recordedAt: STARTED,
  updatedAt: STARTED + 30_000,
}

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return { ...baseSession, ...overrides }
}

function call(overrides: Partial<CallRow>): CallRow {
  return { ...baseCall, ...overrides }
}

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return { ...baseTurn, ...overrides }
}

function snapshot(overrides: Partial<WebSnapshot> = {}): WebSnapshot {
  return {
    sidecarPath: "/data/usage.db",
    sidecarExists: true,
    calls: [],
    turns: [],
    sessionsPath: "/data/opencode.db",
    sessionsSource: "scan",
    sessionsExists: true,
    sessionsResolveError: null,
    sessions: [],
    projects: [],
    sessionProjects: [],
    ...overrides,
  }
}

function api(pathname: string, query = "", data = snapshot(), now = NOW): ApiResult {
  return handleApi(pathname, new URLSearchParams(query), data, now)
}

function bodyOf<T>(result: ApiResult): T {
  expect(result.status).toBe(200)
  return result.body as T
}

type TurnJson = {
  turnID: string
  sessionID: string
  session: string
  title: string | null
  status: string
  internal: boolean
  timeout: boolean
  queuedAt: number | null
  acceptedAt: number | null
  startedAt: number
  endedAt: number | null
  queueMs: number | null
  roundMs: number | null
  firstTokenMs: number | null
  prompts: number
  steers: number
  compactions: number
  retries: number
  calls: number
  costUSD: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  interruptReason: string | null
  errorType: string | null
  errorMessage: string | null
  errorStatus: number | null
}

type Overview = {
  rounds: {
    total: number
    running: number
    stale: number
    completed: number
    failed: number
    interrupted: number
    timeouts: number
    errorRate: number | null
    retries: number
    roundMs: { p50: number | null; p95: number | null; avg: number | null }
    firstTokenMs: { p50: number | null }
  }
  roundSeries: Array<{
    date: string
    label: string
    rounds: number
    roundMsP50: number | null
    roundMsP95: number | null
    errors: number
    timeouts: number
    retries: number
    cost: number
  }>
  errorSeries: Array<{ date: string; label: string; call: number; turn: number }>
}

type Turns = {
  range: { since: number | null; label: string }
  total: number
  limit: number
  offset: number
  excludedInternal: number
  rows: TurnJson[]
}

type Errors = {
  range: { since: number | null; label: string }
  source: string
  rows: Array<{
    errorType: string | null
    source: "call" | "turn"
    count: number
    sessions: number
    firstAt: number
    lastAt: number
    lastMessage: string | null
  }>
}

type SessionDetail = {
  session: { sessionID: string; calls: number }
  callTotal: number
  calls: Array<{ callID: string; turnID: string | null }>
  roundTotal: number
  rounds: TurnJson[]
}

type TurnDetail = {
  turn: TurnJson
  callTotal: number
  calls: Array<{ callID: string; turnID: string | null }>
}

describe("round aggregates", () => {
  test("zero rounds keep every duration null and retries at a real zero", () => {
    const data = snapshot({ sessions: [session({})] })
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", data))
    expect(overview.rounds).toEqual({
      total: 0,
      running: 0,
      stale: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      timeouts: 0,
      errorRate: null,
      retries: 0,
      roundMs: { p50: null, p95: null, avg: null },
      firstTokenMs: { p50: null },
    })
    expect(overview.roundSeries).toEqual([])
    expect(overview.errorSeries).toEqual([])
  })

  test("one completed round reports its duration and linked call cost", () => {
    const data = snapshot({
      sessions: [session({})],
      turns: [turn({})],
      calls: [
        call({ callID: "c1", turnID: "turn_1", costUSD: 0.1, tokensInput: 10, tokensOutput: 5, tokensReasoning: 1 }),
        call({ callID: "c2", turnID: "turn_1", costUSD: 0.2, tokensInput: 1, tokensOutput: 2, tokensReasoning: 3 }),
      ],
    })
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", data))
    expect(overview.rounds).toEqual({
      total: 1,
      running: 0,
      stale: 0,
      completed: 1,
      failed: 0,
      interrupted: 0,
      timeouts: 0,
      errorRate: 0,
      retries: 0,
      roundMs: { p50: 30_000, p95: 30_000, avg: 30_000 },
      firstTokenMs: { p50: 5_000 },
    })
    expect(overview.roundSeries.find((point) => point.date === "2026-10-24")).toEqual({
      date: "2026-10-24",
      label: "10-24",
      rounds: 1,
      roundMsP50: 30_000,
      roundMsP95: 30_000,
      errors: 0,
      timeouts: 0,
      retries: 0,
      cost: 0.30000000000000004,
    })

    const turns = bodyOf<Turns>(api("/api/turns", "since=all", data))
    expect(turns.total).toBe(1)
    expect(turns.rows[0]).toMatchObject({
      turnID: "turn_1",
      title: "Real work",
      status: "completed",
      queueMs: 2_000,
      roundMs: 30_000,
      firstTokenMs: 5_000,
      calls: 2,
      costUSD: 0.30000000000000004,
      tokens: { input: 11, output: 7, reasoning: 4, cacheRead: 40, cacheWrite: 0 },
    })
  })

  test("many rounds interpolate percentiles and count display statuses", () => {
    const turns = [
      turn({
        turnID: "completed_1",
        endedAt: STARTED + 1_000,
        firstTokenAt: STARTED + 100,
        updatedAt: STARTED + 1_000,
      }),
      turn({
        turnID: "completed_2",
        endedAt: STARTED + 2_000,
        firstTokenAt: STARTED + 200,
        updatedAt: STARTED + 2_000,
      }),
      turn({
        turnID: "completed_3",
        endedAt: STARTED + 3_000,
        firstTokenAt: STARTED + 300,
        updatedAt: STARTED + 3_000,
      }),
      turn({
        turnID: "failed",
        status: "failed",
        endedAt: STARTED + 4_000,
        firstTokenAt: null,
        errorType: "provider.internal",
        errorMessage: "boom",
        errorStatus: 500,
        retries: 1,
        updatedAt: STARTED + 4_000,
      }),
      turn({
        turnID: "timeout",
        status: "interrupted",
        interruptReason: "inactivity",
        endedAt: STARTED + 5_000,
        firstTokenAt: null,
        updatedAt: STARTED + 5_000,
      }),
      turn({
        turnID: "running",
        status: "running",
        endedAt: null,
        firstTokenAt: null,
        updatedAt: NOW - 1_000,
      }),
      turn({
        turnID: "stale",
        status: "running",
        endedAt: null,
        firstTokenAt: null,
        updatedAt: NOW - 2 * 3_600_000,
      }),
    ]
    const calls = turns.map((entry) =>
      call({ callID: `c_${entry.turnID}`, turnID: entry.turnID, startedAt: entry.startedAt }),
    )
    const data = snapshot({ sessions: [session({})], turns, calls })
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", data))
    expect(overview.rounds).toMatchObject({
      total: 7,
      running: 1,
      stale: 1,
      completed: 3,
      failed: 1,
      interrupted: 1,
      timeouts: 1,
      retries: 1,
      roundMs: { p50: 2_000, p95: 2_900, avg: 2_000 },
      firstTokenMs: { p50: 200 },
    })
    expect(overview.rounds.errorRate).toBeCloseTo(2 / 7)
    expect(overview.rounds.roundMs.p95).toBe(2_900)

    const all = bodyOf<Turns>(api("/api/turns", "since=all", data))
    expect(all.rows.find((row) => row.turnID === "stale")?.status).toBe("stale")
    expect(all.rows.find((row) => row.turnID === "timeout")?.timeout).toBe(true)
  })
})

describe("turn filters", () => {
  const turns = [
    turn({ turnID: "completed", status: "completed", startedAt: STARTED }),
    turn({ turnID: "failed", status: "failed", startedAt: STARTED + 1_000, errorType: "provider.internal" }),
    turn({ turnID: "interrupted", status: "interrupted", startedAt: STARTED + 2_000 }),
    turn({ turnID: "running", status: "running", startedAt: STARTED + 3_000, endedAt: null, updatedAt: NOW }),
    turn({
      turnID: "stale",
      status: "running",
      startedAt: STARTED + 4_000,
      endedAt: null,
      updatedAt: NOW - 2 * 3_600_000,
    }),
    turn({ turnID: "old", status: "completed", startedAt: NOW - 10 * 86_400_000 }),
  ]
  const calls = turns.map((entry) =>
    call({ callID: `call_${entry.turnID}`, turnID: entry.turnID, startedAt: entry.startedAt }),
  )
  const data = snapshot({ turns, calls })

  test("onlyErrors excludes completed rounds and status validates", () => {
    const all = bodyOf<Turns>(api("/api/turns", "since=all", data))
    expect(all.total).toBe(6)

    const errors = bodyOf<Turns>(api("/api/turns", "since=all&onlyErrors=true", data))
    expect(errors.total).toBe(4)
    expect(errors.rows.map((row) => row.turnID)).not.toContain("completed")
    expect(errors.rows.map((row) => row.turnID)).not.toContain("old")

    const stale = bodyOf<Turns>(api("/api/turns", "since=all&status=stale", data))
    expect(stale.rows.map((row) => row.turnID)).toEqual(["stale"])

    for (const [query, parameter] of [
      ["since=all&status=bogus", "status"],
      ["since=all&onlyErrors=banana", "onlyErrors"],
    ] as const) {
      const result = api("/api/turns", query, data)
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ parameter })
    }
  })

  test("defaults to 7d and pages with a total", () => {
    expect(bodyOf<Turns>(api("/api/turns", "", data)).total).toBe(5)
    const page = bodyOf<Turns>(api("/api/turns", "since=all&limit=2&offset=2", data))
    expect(page.total).toBe(6)
    expect(page.limit).toBe(2)
    expect(page.offset).toBe(2)
    expect(page.rows).toHaveLength(2)
  })

  test("rounds without a matching recorded call are never listed", () => {
    const modelData = snapshot({
      turns: [
        turn({ turnID: "provider", startedAt: STARTED }),
        turn({ turnID: "other", startedAt: STARTED + 1_000 }),
        turn({ turnID: "empty", startedAt: STARTED + 2_000 }),
      ],
      calls: [
        call({ callID: "c_provider", turnID: "provider", providerID: "provider", modelID: "model" }),
        call({ callID: "c_other", turnID: "other", providerID: "other", modelID: "small" }),
      ],
    })
    expect(
      bodyOf<Turns>(api("/api/turns", "since=all&model=provider/model", modelData)).rows.map((row) => row.turnID),
    ).toEqual(["provider"])
    expect(
      bodyOf<Turns>(api("/api/turns", "since=all&model=other/small", modelData)).rows.map((row) => row.turnID),
    ).toEqual(["other"])

    const all = bodyOf<Turns>(api("/api/turns", "since=all", modelData))
    expect(all.total).toBe(2)
    expect(all.rows.map((row) => row.turnID)).toEqual(["other", "provider"])
    expect(all.rows.map((row) => row.turnID)).not.toContain("empty")
  })
})

describe("round windowing", () => {
  test("a round is included only when a linked call is inside the window", () => {
    const data = snapshot({
      turns: [
        turn({ turnID: "call_in", startedAt: STARTED - 5 * 86_400_000 }),
        turn({ turnID: "call_out", startedAt: STARTED }),
        turn({ turnID: "no_call", startedAt: STARTED }),
      ],
      calls: [
        call({
          callID: "in",
          turnID: "call_in",
          startedAt: new Date(2026, 9, 24, 10).getTime(),
        }),
        call({
          callID: "out",
          turnID: "call_out",
          startedAt: new Date(2026, 9, 20, 10).getTime(),
        }),
      ],
    })
    const result = bodyOf<Turns>(api("/api/turns", "since=2026-10-24&tz=UTC", data))
    expect(result.total).toBe(1)
    expect(result.rows.map((row) => row.turnID)).toEqual(["call_in"])
  })
})

describe("error grouping", () => {
  const calls = [
    call({
      callID: "rate_1",
      status: "failed",
      errorType: "provider.rate-limit",
      errorMessage: "429 slow down",
      endedAt: STARTED + 1_000,
    }),
    call({
      callID: "rate_2",
      status: "failed",
      errorType: "provider.rate-limit",
      errorMessage: "429 again",
      endedAt: STARTED + 2_000,
    }),
    call({
      callID: "aborted",
      status: "failed",
      errorType: "aborted",
      errorMessage: "interrupted",
      endedAt: STARTED + 3_000,
    }),
    call({ callID: "completed", status: "completed", endedAt: STARTED + 4_000 }),
    call({
      callID: "old",
      status: "failed",
      errorType: "provider.transport",
      endedAt: NOW - 40 * 86_400_000,
    }),
    call({
      callID: "internal",
      sessionID: "ses_test",
      status: "failed",
      errorType: "provider.quota",
      endedAt: STARTED + 5_000,
    }),
    call({ callID: "turn_failed_call", turnID: "turn_failed", endedAt: STARTED + 6_000 }),
    call({ callID: "turn_timeout_call", turnID: "turn_timeout", endedAt: STARTED + 7_000 }),
    call({ callID: "turn_completed_call", turnID: "turn_completed", endedAt: STARTED + 8_000 }),
  ]
  const turns = [
    turn({
      turnID: "turn_failed",
      status: "failed",
      errorType: "provider.internal",
      errorMessage: "500 from provider",
      errorStatus: 500,
      endedAt: STARTED + 6_000,
    }),
    turn({
      turnID: "turn_timeout",
      status: "interrupted",
      interruptReason: "inactivity",
      endedAt: STARTED + 7_000,
    }),
    turn({ turnID: "turn_completed", status: "completed" }),
    turn({
      turnID: "turn_orphan_failed",
      status: "failed",
      errorType: "provider.internal",
      endedAt: STARTED + 9_000,
    }),
  ]
  const data = snapshot({
    sessions: [
      session({ id: "ses_real" }),
      session({ id: "ses_test", title: "[OC2 internal test] usage verify", internal: true }),
    ],
    calls,
    turns,
  })

  test("groups by source and type with count-descending order", () => {
    const errors = bodyOf<Errors>(api("/api/errors", "since=all", data))
    expect(errors.source).toBe("all")
    expect(errors.rows.map((row) => [row.source, row.errorType, row.count])).toEqual([
      ["call", "provider.rate-limit", 2],
      ["call", "aborted", 1],
      ["turn", "provider.internal", 1],
      ["turn", "provider.timeout", 1],
      ["call", "provider.transport", 1],
    ])
    expect(errors.rows[0]?.lastMessage).toBe("429 again")
    expect(errors.rows.find((row) => row.source === "turn" && row.errorType === "provider.internal")?.count).toBe(1)
  })

  test("source and internal filters narrow the groups", () => {
    const callsOnly = bodyOf<Errors>(api("/api/errors", "since=all&source=call", data))
    expect(callsOnly.rows.every((row) => row.source === "call")).toBe(true)
    expect(callsOnly.rows.map((row) => row.errorType)).toEqual([
      "provider.rate-limit",
      "aborted",
      "provider.transport",
    ])

    const turnsOnly = bodyOf<Errors>(api("/api/errors", "since=all&source=turn", data))
    expect(turnsOnly.rows.map((row) => row.errorType)).toEqual(["provider.internal", "provider.timeout"])

    const included = bodyOf<Errors>(api("/api/errors", "since=all&includeInternal=1", data))
    expect(included.rows.find((row) => row.errorType === "provider.quota")?.count).toBe(1)

    const invalid = api("/api/errors", "since=all&source=bogus", data)
    expect(invalid.status).toBe(400)
    expect(invalid.body).toMatchObject({ parameter: "source" })
  })

  test("defaults to 30d and filters by the error end time", () => {
    const errors = bodyOf<Errors>(api("/api/errors", "", data))
    expect(errors.range.label).toBe("30d")
    expect(errors.rows.some((row) => row.errorType === "provider.transport")).toBe(false)
  })
})

describe("session and turn detail", () => {
  const oldStarted = new Date(2026, 8, 1, 10).getTime()
  const newStarted = new Date(2026, 9, 24, 10).getTime()
  const oldTurn = turn({
    turnID: "turn_old",
    queuedAt: oldStarted - 1_000,
    acceptedAt: oldStarted,
    startedAt: oldStarted,
    endedAt: oldStarted + 1_000,
    firstTokenAt: oldStarted + 100,
    updatedAt: oldStarted + 1_000,
  })
  const newTurn = turn({ turnID: "turn_new", startedAt: newStarted })
  const oldCall = call({
    callID: "call_old",
    turnID: "turn_old",
    startedAt: oldStarted,
    firstTokenAt: oldStarted + 100,
    firstTextAt: oldStarted + 100,
    streamedAt: oldStarted + 900,
    endedAt: oldStarted + 1_000,
    recordedAt: oldStarted + 1_000,
  })
  const newCall = call({
    callID: "call_new",
    turnID: "turn_new",
    startedAt: newStarted,
    firstTokenAt: newStarted + 100,
    firstTextAt: newStarted + 100,
    streamedAt: newStarted + 1_100,
    endedAt: newStarted + 1_200,
    recordedAt: newStarted + 1_200,
    costUSD: 0.2,
  })
  const data = snapshot({
    sessions: [
      session({ id: "ses_real" }),
      session({ id: "ses_test", title: "[OC2 internal test] usage verify", internal: true }),
    ],
    turns: [
      oldTurn,
      newTurn,
      turn({ turnID: "turn_test", sessionID: "ses_test" }),
      turn({ turnID: "turn_orphan" }),
    ],
    calls: [oldCall, newCall, call({ callID: "call_test", sessionID: "ses_test", turnID: "turn_test" })],
  })

  test("session detail adds rounds and keeps windowed calls", () => {
    const detail = bodyOf<SessionDetail>(api("/api/session/ses_real", "since=all", data))
    expect(detail.session).toMatchObject({ sessionID: "ses_real", calls: 2 })
    expect(detail.roundTotal).toBe(2)
    expect(detail.rounds.map((row) => row.turnID)).toEqual(["turn_new", "turn_old"])
    expect(detail.callTotal).toBe(2)

    const windowed = bodyOf<SessionDetail>(api("/api/session/ses_real", "since=2026-10-01", data))
    expect(windowed.roundTotal).toBe(1)
    expect(windowed.rounds[0]?.turnID).toBe("turn_new")
    expect(windowed.callTotal).toBe(1)
  })

  test("turn detail returns that round's calls and enforces visibility", () => {
    const detail = bodyOf<TurnDetail>(api("/api/turn/turn_new", "since=all", data))
    expect(detail.turn.turnID).toBe("turn_new")
    expect(detail.callTotal).toBe(1)
    expect(detail.calls.map((row) => row.callID)).toEqual(["call_new"])

    expect(api("/api/turn/turn_missing", "since=all", data).status).toBe(404)
    expect(api("/api/turn/turn_orphan", "since=all", data).status).toBe(404)
    expect(api("/api/turn/turn_old", "since=2026-10-01", data).status).toBe(404)
    expect(api("/api/turn/turn_test", "since=all", data).status).toBe(404)
    expect(bodyOf<TurnDetail>(api("/api/turn/turn_test", "since=all&includeInternal=1", data)).turn.internal).toBe(true)
  })
})

describe("a sidecar without the turn table", () => {
  test("readTurns renders empty instead of crashing", () => {
    const db = new Database(":memory:")
    expect(readTurns(db)).toEqual([])
    db.close()
  })

  test("round responses stay empty while call errors still group", () => {
    const data = snapshot({
      turns: [],
      calls: [call({ callID: "failed", status: "failed", errorType: "provider.internal", endedAt: STARTED })],
    })
    expect(bodyOf<Overview>(api("/api/overview", "since=all", data)).rounds.total).toBe(0)
    expect(bodyOf<Turns>(api("/api/turns", "since=all", data)).rows).toEqual([])
    expect(bodyOf<Errors>(api("/api/errors", "since=all", data)).rows[0]?.errorType).toBe("provider.internal")
  })
})
