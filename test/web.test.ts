import { describe, expect, test } from "bun:test"
import type { SessionRecord, TurnRecord } from "../src/query"
import type { CallRow } from "../src/reducer"
import { handleApi, percentile, type ApiResult, type WebSnapshot } from "../web/api"

const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime()

const baseSession: SessionRecord = {
  id: "ses_real",
  title: "Real work",
  internal: false,
  costUSD: 1.5,
  tokensInput: 100,
  tokensOutput: 50,
  tokensReasoning: 10,
  tokensCacheRead: 1_000,
  tokensCacheWrite: 0,
  timeCreated: new Date(2026, 9, 23, 10).getTime(),
  timeUpdated: new Date(2026, 9, 24, 9).getTime(),
}

const baseCall: CallRow = {
  callID: "call_real",
  assistantMessageID: "msg_real",
  sessionID: "ses_real",
  parentSessionID: null,
  kind: "step",
  agent: "build",
  providerID: "provider",
  modelID: "model",
  modelVariant: null,
  directory: "/work",
  startedAt: new Date(2026, 9, 24, 10).getTime(),
  firstTokenAt: new Date(2026, 9, 24, 10).getTime() + 100,
  firstTextAt: new Date(2026, 9, 24, 10).getTime() + 100,
  streamedAt: new Date(2026, 9, 24, 10).getTime() + 1_100,
  endedAt: new Date(2026, 9, 24, 10).getTime() + 1_200,
  tokensInput: 100,
  tokensOutput: 10,
  tokensReasoning: 2,
  tokensCacheRead: 500,
  tokensCacheWrite: 0,
  costUSD: 0.1,
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
  recordedAt: new Date(2026, 9, 24, 10).getTime() + 1_200,
}

const baseTurn: TurnRecord = {
  turnID: "turn_base",
  sessionID: "ses_real",
  directory: "/work",
  queuedAt: null,
  acceptedAt: new Date(2026, 9, 24, 10).getTime(),
  startedAt: new Date(2026, 9, 24, 10).getTime(),
  endedAt: new Date(2026, 9, 24, 10).getTime() + 30_000,
  status: "completed",
  interruptReason: null,
  errorType: null,
  errorMessage: null,
  errorStatus: null,
  prompts: 1,
  compactions: 0,
  steers: 0,
  retries: 0,
  firstTokenAt: new Date(2026, 9, 24, 10).getTime() + 1_000,
  recordedAt: new Date(2026, 9, 24, 10).getTime(),
  updatedAt: new Date(2026, 9, 24, 10).getTime() + 30_000,
}

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return { ...baseSession, ...overrides }
}

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return { ...baseTurn, ...overrides }
}

function call(overrides: Partial<CallRow>): CallRow {
  return { ...baseCall, ...overrides }
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

type Overview = {
  range: { since: number | null; label: string }
  model: string | null
  totals: {
    calls: number
    sessions: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
      cacheRead: number
      cacheWrite: number
      total: number
    }
    tokensInput: number
    tokensOutput: number
    tokensReasoning: number
    tokensCacheRead: number
    tokensCacheWrite: number
    costUSD: number
    excludedInternal: number
    cacheHitRate: number | null
  }
  callErrors: {
    failed: number
    interrupted: number
    rate: number | null
  }
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
  sidecar: {
    calls: number
    avgTTFT: number | null
    p50TTFT: number | null
    p95TTFT: number | null
    avgTPS: number | null
    firstAt: number | null
    lastAt: number | null
  }
  models: Array<{
    providerID: string | null
    modelID: string | null
    label: string
    calls: number
    sessions: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
      cacheRead: number
      cacheWrite: number
    }
    costUSD: number
  }>
  series: Array<{
    day: string
    costUSD: number
    calls: number
    sessions: number
    tokens: { input: number; output: number; reasoning: number }
    avgTTFT: number | null
    p50TTFT: number | null
    p95TTFT: number | null
    avgTPS: number | null
  }>
  roundSeries: Array<{
    date: string
    rounds: number
    roundMsP50: number | null
    roundMsP95: number | null
    errors: number
    timeouts: number
    retries: number
    cost: number
  }>
  errorSeries: Array<{ date: string; call: number; turn: number }>
}

type Sessions = {
  range: { since: number | null; label: string }
  total: number
  limit: number
  excludedInternal: number
  rows: Array<{
    sessionID: string
    session: string
    title: string | null
    internal: boolean
    updatedAt: number
    calls: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
      cacheRead: number
      cacheWrite: number
    }
    costUSD: number
    avgTTFT: number | null
    avgTPS: number | null
  }>
}

type Calls = {
  range: { since: number | null; label: string }
  total: number
  limit: number
  offset: number
  excludedInternal: number
  rows: Array<{
    callID: string
    sessionID: string
    session: string
    internal: boolean
    kind: string
    status: string
    ttft: number | null
    ttfa: number | null
    tps: number | null
    e2e: number | null
    model: string
    tokens: { input: number | null; output: number | null; reasoning: number | null }
  }>
}

type SessionDetail = {
  session: Sessions["rows"][number]
  callTotal: number
  calls: Calls["rows"]
  roundTotal: number
  rounds: Array<{ turnID: string; roundMs: number | null }>
}

type Meta = {
  range: { since: number | null; label: string }
  capabilities: string[]
  includeInternal: boolean
  sidecar: { path: string; exists: boolean; calls: number; firstAt: number | null; lastAt: number | null }
  sessions: { path: string | null; exists: boolean; source: string | null; error: string | null }
}

describe("since parsing and defaults", () => {
  test("parses the window selector values and absolute dates", () => {
    expect(bodyOf<Overview>(api("/api/overview", "since=7d")).range).toEqual({
      since: NOW - 7 * 86_400_000,
      label: "7d",
    })
    expect(bodyOf<Overview>(api("/api/overview", "since=24h")).range.since).toBe(NOW - 86_400_000)
    expect(bodyOf<Overview>(api("/api/overview", "since=90d")).range.since).toBe(NOW - 90 * 86_400_000)
    expect(bodyOf<Overview>(api("/api/overview", "since=all")).range).toEqual({ since: null, label: "all" })
    expect(bodyOf<Overview>(api("/api/overview", "since=2026-10-01")).range.since).toBe(
      new Date(2026, 9, 1).getTime(),
    )
  })

  test("overview defaults to all history while sessions mirror the CLI's 30d default", () => {
    expect(bodyOf<Overview>(api("/api/overview")).range).toEqual({ since: null, label: "all" })
    expect(bodyOf<Calls>(api("/api/calls")).range).toEqual({ since: null, label: "all" })
    expect(bodyOf<Sessions>(api("/api/sessions")).range).toEqual({
      since: NOW - 30 * 86_400_000,
      label: "30d",
    })
  })

  test("invalid, unknown, and malformed values are named 400s", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["/api/calls", "since=yesterday", "since"],
      ["/api/overview", "since=2026-02-31", "since"],
      ["/api/overview", "bogus=1", "bogus"],
      ["/api/calls", "status=weird", "status"],
      ["/api/calls", "limit=0", "limit"],
      ["/api/calls", "limit=banana", "limit"],
      ["/api/calls", "offset=-1", "offset"],
      ["/api/calls", "minTTFT=abc", "minTTFT"],
      ["/api/sessions", "limit=9999", "limit"],
      ["/api/sessions", "sort=weird", "sort"],
      ["/api/sessions", "dir=up", "dir"],
      ["/api/overview", "includeInternal=yes", "includeInternal"],
    ]
    for (const [pathname, query, parameter] of cases) {
      const result = api(pathname, query)
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ parameter })
      expect((result.body as { error: string }).error).toContain(parameter)
    }
  })
})

describe("percentiles", () => {
  test("an empty set has no percentile", () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([], 0.95)).toBeNull()
  })

  test("a single value is its own p50 and p95", () => {
    expect(percentile([42], 0.5)).toBe(42)
    expect(percentile([42], 0.95)).toBe(42)
  })

  test("multiple values interpolate", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(percentile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85)
  })
})

describe("per-day series", () => {
  const day23 = new Date(2026, 9, 23, 23, 30).getTime()
  const day24 = new Date(2026, 9, 24, 11, 0).getTime()
  const data = snapshot({
    sessions: [session({ id: "ses_series", timeUpdated: day24 })],
    calls: [
      call({
        callID: "call_1",
        sessionID: "ses_series",
        startedAt: day23,
        firstTokenAt: day23 + 100,
        firstTextAt: day23 + 100,
        streamedAt: day23 + 1_100,
        tokensInput: 100,
        tokensOutput: 10,
        tokensReasoning: 2,
        tokensCacheRead: 500,
        tokensCacheWrite: 0,
        costUSD: 0.1,
      }),
      call({
        callID: "call_2",
        sessionID: "ses_series",
        startedAt: day24,
        firstTokenAt: day24 + 300,
        firstTextAt: day24 + 300,
        streamedAt: day24 + 1_300,
        tokensInput: 5,
        tokensOutput: 30,
        tokensReasoning: 1,
        tokensCacheRead: 100,
        tokensCacheWrite: 0,
        costUSD: 0.25,
      }),
    ],
  })

  test("buckets by local calendar day using recorded calls", () => {
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", data))
    expect(overview.series.find((point) => point.day === "2026-10-23")).toMatchObject({
      costUSD: 0.1,
      calls: 1,
      sessions: 1,
      tokens: { input: 100, output: 10, reasoning: 2 },
      avgTTFT: 100,
    })
    expect(overview.series.find((point) => point.day === "2026-10-24")).toMatchObject({
      costUSD: 0.25,
      calls: 1,
      sessions: 1,
      tokens: { input: 5, output: 30, reasoning: 1 },
      avgTTFT: 300,
      p50TTFT: 300,
      p95TTFT: 300,
      avgTPS: 30,
    })
  })

  test("totals and sidecar aggregates match the recorded calls", () => {
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", data))
    expect(overview.totals).toMatchObject({
      calls: 2,
      sessions: 1,
      tokens: { input: 105, output: 40, reasoning: 3, cacheRead: 600, cacheWrite: 0, total: 748 },
      tokensInput: 105,
      tokensOutput: 40,
      tokensReasoning: 3,
      tokensCacheRead: 600,
      tokensCacheWrite: 0,
      costUSD: 0.35,
      excludedInternal: 0,
    })
    expect(overview.totals.cacheHitRate).toBeCloseTo(600 / 705)
    expect(overview.totals).not.toHaveProperty("steps")
    expect(overview.totals).not.toHaveProperty("prompts")
    expect(overview.totals).not.toHaveProperty("activeDays")
    expect(overview.sidecar).toEqual({
      calls: 2,
      avgTTFT: 200,
      p50TTFT: 200,
      p95TTFT: 290,
      avgTPS: 20,
      firstAt: day23,
      lastAt: day24,
    })
    expect(overview.models).toEqual([
      {
        providerID: "provider",
        modelID: "model",
        label: "provider/model",
        calls: 2,
        sessions: 1,
        tokens: {
          input: 105,
          output: 40,
          reasoning: 3,
          cache: { read: 600, write: 0 },
          cacheRead: 600,
          cacheWrite: 0,
        },
        costUSD: 0.35,
      },
    ])
  })

  test("a window with no data still has a daily axis and null latencies", () => {
    const overview = bodyOf<Overview>(api("/api/overview", "since=24h", snapshot()))
    expect(overview.series.length).toBeGreaterThan(0)
    expect(overview.series.every((point) => point.calls === 0 && point.avgTTFT === null)).toBe(true)
    expect(overview.totals.cacheHitRate).toBeNull()
  })
})

describe("missing metrics stay null", () => {
  test("totals without calls or tokens report null latency and cache hit rate", () => {
    const data = snapshot({
      sessions: [session({ id: "ses_empty", costUSD: 0, tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, tokensCacheRead: 0 })],
    })
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", data))
    expect(overview.totals.cacheHitRate).toBeNull()
    expect(overview.totals.calls).toBe(0)
    expect(overview.sidecar).toEqual({
      calls: 0,
      avgTTFT: null,
      p50TTFT: null,
      p95TTFT: null,
      avgTPS: null,
      firstAt: null,
      lastAt: null,
    })
    const sessions = bodyOf<Sessions>(api("/api/sessions", "since=all", data))
    expect(sessions.rows).toEqual([])
    expect(sessions.total).toBe(0)
  })

  test("a real zero TTFT stays zero while a compaction call has null timings", () => {
    const started = new Date(2026, 9, 24, 10).getTime()
    const data = snapshot({
      sessions: [session({ id: "ses_real", timeUpdated: started })],
      calls: [
        call({ callID: "zero", startedAt: started, firstTokenAt: started, firstTextAt: null, streamedAt: null }),
        call({
          callID: "compact",
          sessionID: "ses_real",
          kind: "compaction",
          startedAt: null,
          firstTokenAt: null,
          firstTextAt: null,
          streamedAt: null,
          status: "completed",
        }),
      ],
    })
    const calls = bodyOf<Calls>(api("/api/calls", "since=all", data))
    expect(calls.rows.find((row) => row.callID === "zero")?.ttft).toBe(0)
    expect(calls.rows.find((row) => row.callID === "compact")).toMatchObject({
      ttft: null,
      ttfa: null,
      tps: null,
      e2e: null,
    })
  })
})

describe("paging", () => {
  const calls = [1, 2, 3, 4, 5].map((index) =>
    call({
      callID: `call_${index}`,
      startedAt: new Date(2026, 9, 24, 10).getTime() + index * 1_000,
      endedAt: new Date(2026, 9, 24, 10).getTime() + index * 1_000 + 500,
    }),
  )

  test("offset slices the newest-first list and keeps the full total", () => {
    const page = bodyOf<Calls>(api("/api/calls", "since=all&limit=2&offset=2", snapshot({ calls })))
    expect(page.total).toBe(5)
    expect(page.limit).toBe(2)
    expect(page.offset).toBe(2)
    expect(page.rows.map((row) => row.callID)).toEqual(["call_3", "call_2"])
  })

  test("a page past the end is empty but total stays intact", () => {
    const page = bodyOf<Calls>(api("/api/calls", "since=all&limit=2&offset=10", snapshot({ calls })))
    expect(page.total).toBe(5)
    expect(page.rows).toEqual([])
  })
})

describe("internal-test filtering", () => {
  const internal = snapshot({
    sessions: [
      session({ id: "ses_real", title: "Real work", timeUpdated: NOW - 3_600_000 }),
      session({
        id: "ses_test",
        title: "[OC2 internal test] usage verify",
        internal: true,
        timeUpdated: NOW - 1_800_000,
      }),
    ],
    calls: [
      call({ callID: "call_real", sessionID: "ses_real", startedAt: NOW - 3_000 }),
      call({ callID: "call_test", sessionID: "ses_test", startedAt: NOW - 2_000 }),
    ],
  })

  test("hidden by default in totals, sessions, and calls", () => {
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", internal))
    expect(overview.totals).toMatchObject({ calls: 1, sessions: 1, costUSD: 0.1, excludedInternal: 1 })
    expect(overview.sidecar.calls).toBe(1)

    const sessions = bodyOf<Sessions>(api("/api/sessions", "since=all", internal))
    expect(sessions.total).toBe(1)
    expect(sessions.excludedInternal).toBe(1)
    expect(sessions.rows[0]?.sessionID).toBe("ses_real")

    const calls = bodyOf<Calls>(api("/api/calls", "since=all", internal))
    expect(calls.total).toBe(1)
    expect(calls.excludedInternal).toBe(1)
    expect(calls.rows[0]?.internal).toBe(false)
  })

  test("included on request and visibly marked", () => {
    const overview = bodyOf<Overview>(api("/api/overview", "since=all&includeInternal=1", internal))
    expect(overview.totals).toMatchObject({ calls: 2, sessions: 2, costUSD: 0.2, excludedInternal: 0 })
    expect(overview.sidecar.calls).toBe(2)

    const sessions = bodyOf<Sessions>(api("/api/sessions", "since=all&includeInternal=true", internal))
    expect(sessions.total).toBe(2)
    expect(sessions.excludedInternal).toBe(0)
    expect(sessions.rows.find((row) => row.sessionID === "ses_test")?.internal).toBe(true)

    const calls = bodyOf<Calls>(api("/api/calls", "since=all&includeInternal=1", internal))
    expect(calls.total).toBe(2)
    expect(calls.excludedInternal).toBe(0)
    expect(calls.rows.find((row) => row.callID === "call_test")?.internal).toBe(true)
  })
})

describe("session filters", () => {
  const data = snapshot({
    sessions: [
      session({ id: "ses_real", title: "Real work", timeUpdated: NOW - 1_000 }),
      session({ id: "ses_other", title: "Other project", timeUpdated: NOW - 2_000 }),
    ],
    calls: [
      call({
        callID: "call_real",
        sessionID: "ses_real",
        providerID: "provider",
        modelID: "model",
        startedAt: NOW - 1_000,
        costUSD: 0.1,
      }),
      call({
        callID: "call_other",
        sessionID: "ses_other",
        providerID: "other",
        modelID: "small",
        startedAt: NOW - 2_000,
        costUSD: 0.2,
      }),
    ],
  })

  test("q matches title and session id substrings case-insensitively", () => {
    const byTitle = bodyOf<Sessions>(api("/api/sessions", "since=all&q=REAL", data))
    expect(byTitle.total).toBe(1)
    expect(byTitle.rows[0]?.sessionID).toBe("ses_real")

    const byID = bodyOf<Sessions>(api("/api/sessions", "since=all&q=other", data))
    expect(byID.total).toBe(1)
    expect(byID.rows[0]?.sessionID).toBe("ses_other")
  })

  test("model and limit filter the rows without losing the total", () => {
    const filtered = bodyOf<Sessions>(api("/api/sessions", "since=all&model=provider/model", data))
    expect(filtered.total).toBe(1)
    expect(filtered.rows[0]?.sessionID).toBe("ses_real")

    const limited = bodyOf<Sessions>(api("/api/sessions", "since=all&limit=1", data))
    expect(limited.total).toBe(2)
    expect(limited.limit).toBe(1)
    expect(limited.rows).toHaveLength(1)
  })

  test("the default 30d window excludes older recorded calls", () => {
    const old = session({ id: "ses_old", timeUpdated: NOW - 40 * 86_400_000 })
    const fresh = session({ id: "ses_fresh", timeUpdated: NOW - 86_400_000 })
    const both = snapshot({
      sessions: [old, fresh],
      calls: [
        call({ callID: "old", sessionID: "ses_old", startedAt: NOW - 40 * 86_400_000 }),
        call({ callID: "fresh", sessionID: "ses_fresh", startedAt: NOW - 86_400_000 }),
      ],
    })
    expect(bodyOf<Sessions>(api("/api/sessions", "", both)).total).toBe(1)
    expect(bodyOf<Sessions>(api("/api/sessions", "since=all", both)).total).toBe(2)
  })

  test("sorts by recorded-call cost and keeps missing latency last", () => {
    const costed = session({ id: "ses_cost" })
    const free = session({ id: "ses_free" })
    const sorted = bodyOf<Sessions>(
      api(
        "/api/sessions",
        "since=all&sort=cost&dir=asc",
        snapshot({
          sessions: [costed, free],
          calls: [
            call({ callID: "cost", sessionID: "ses_cost", startedAt: NOW - 1_000, costUSD: 5 }),
            call({ callID: "free", sessionID: "ses_free", startedAt: NOW - 2_000, costUSD: 1 }),
          ],
        }),
      ),
    )
    expect(sorted.rows.map((row) => row.sessionID)).toEqual(["ses_free", "ses_cost"])

    const withCalls = snapshot({
      sessions: [session({ id: "ses_real" }), session({ id: "ses_none" })],
      calls: [
        call({ callID: "c", sessionID: "ses_real", startedAt: NOW - 1_000 }),
        call({
          callID: "no_latency",
          sessionID: "ses_none",
          startedAt: NOW - 2_000,
          firstTokenAt: null,
          firstTextAt: null,
          streamedAt: null,
        }),
      ],
    })
    const byTTFT = bodyOf<Sessions>(api("/api/sessions", "since=all&sort=ttft&dir=asc", withCalls))
    expect(byTTFT.rows[0]?.sessionID).toBe("ses_real")
    expect(byTTFT.rows[1]?.avgTTFT).toBeNull()
  })
})

describe("call filters and sorting", () => {
  const started = new Date(2026, 9, 24, 10).getTime()
  const calls = [
    call({ callID: "completed", startedAt: started, firstTokenAt: started + 100, streamedAt: started + 1_100 }),
    call({
      callID: "failed",
      startedAt: started + 1_000,
      firstTokenAt: started + 1_500,
      status: "failed",
      error: "message: boom",
    }),
    call({
      callID: "retried",
      startedAt: started + 2_000,
      firstTokenAt: null,
      firstTextAt: null,
      streamedAt: null,
      status: "retried",
    }),
    call({ callID: "interrupted", startedAt: started + 3_000, firstTokenAt: started + 3_200, status: "interrupted" }),
    call({
      callID: "compaction",
      kind: "compaction",
      startedAt: null,
      firstTokenAt: null,
      firstTextAt: null,
      streamedAt: null,
      endedAt: started + 4_000,
      recordedAt: started + 4_000,
    }),
    call({
      callID: "other",
      sessionID: "ses_other",
      providerID: "other",
      modelID: "small",
      startedAt: started + 5_000,
      firstTokenAt: started + 5_050,
      streamedAt: started + 6_050,
    }),
  ]
  const data = snapshot({ calls })

  test("status names step outcomes and compactions separately", () => {
    const failed = bodyOf<Calls>(api("/api/calls", "since=all&status=failed", data))
    expect(failed.rows.map((row) => row.callID)).toEqual(["failed"])
    expect(bodyOf<Calls>(api("/api/calls", "since=all&status=compaction", data)).rows[0]?.callID).toBe("compaction")
    const completed = bodyOf<Calls>(api("/api/calls", "since=all&status=completed", data))
    expect(completed.rows.map((row) => row.callID).sort()).toEqual(["completed", "other"])
  })

  test("model, session prefix, and minTTFT narrow the list", () => {
    expect(bodyOf<Calls>(api("/api/calls", "since=all&model=other/small", data)).total).toBe(1)
    expect(bodyOf<Calls>(api("/api/calls", "since=all&session=other", data)).rows[0]?.callID).toBe("other")
    expect(bodyOf<Calls>(api("/api/calls", "since=all&session=ses_other", data)).total).toBe(1)
    const slow = bodyOf<Calls>(api("/api/calls", "since=all&minTTFT=150", data))
    expect(slow.rows.map((row) => row.callID).sort()).toEqual(["failed", "interrupted"])
  })

  test("counts errors over calls, not over rounds", () => {
    // One failed and one interrupted call out of six. The round-based rate that
    // used to be the headline answers a different question -- a round only
    // fails when every call in it gives up -- so the two must not be conflated.
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", data))
    expect(overview.callErrors).toEqual({ failed: 1, interrupted: 1, rate: 2 / 6 })
    expect(overview.totals.calls).toBe(6)
    // A retried call that later succeeded is not an error.
    expect(overview.callErrors.failed + overview.callErrors.interrupted).toBe(2)
  })

  test("sorting by latency keeps nulls last in both directions", () => {
    const ascending = bodyOf<Calls>(api("/api/calls", "since=all&sort=ttft&dir=asc", data))
    expect(ascending.rows.slice(0, 3).map((row) => row.ttft)).toEqual([50, 100, 200])
    expect(ascending.rows.slice(-2).map((row) => row.ttft)).toEqual([null, null])
    const descending = bodyOf<Calls>(api("/api/calls", "since=all&sort=ttft&dir=desc", data))
    expect(descending.rows.slice(0, 3).map((row) => row.ttft)).toEqual([500, 200, 100])
    expect(descending.rows.slice(-2).map((row) => row.ttft)).toEqual([null, null])
  })
})

describe("session detail", () => {
  const oldCall = call({
    callID: "old",
    startedAt: new Date(2026, 8, 1, 10).getTime(),
    firstTokenAt: new Date(2026, 8, 1, 10).getTime() + 100,
  })
  const newCall = call({ callID: "new", startedAt: new Date(2026, 9, 24, 10).getTime() })
  const testCall = call({
    callID: "test",
    sessionID: "ses_test",
    startedAt: new Date(2026, 9, 24, 11).getTime(),
  })
  const data = snapshot({
    sessions: [
      session({ id: "ses_real", costUSD: 4.5 }),
      session({ id: "ses_test", title: "[OC2 internal test] usage verify", internal: true }),
    ],
    calls: [oldCall, newCall, testCall],
  })

  test("returns windowed recorded-call totals plus all matching calls", () => {
    const detail = bodyOf<SessionDetail>(api("/api/session/ses_real", "since=all", data))
    expect(detail.session).toMatchObject({
      sessionID: "ses_real",
      calls: 2,
      costUSD: 0.2,
    })
    expect(detail.session).not.toHaveProperty("steps")
    expect(detail.session).not.toHaveProperty("recordedCalls")
    expect(detail.callTotal).toBe(2)
    expect(detail.calls.map((row) => row.callID)).toEqual(["new", "old"])
    expect(detail.roundTotal).toBe(0)
  })

  test("since filters the session totals and its calls", () => {
    const detail = bodyOf<SessionDetail>(api("/api/session/ses_real", "since=2026-10-01", data))
    expect(detail.callTotal).toBe(1)
    expect(detail.calls[0]?.callID).toBe("new")
    expect(detail.session.costUSD).toBe(0.1)
    expect(detail.session.calls).toBe(1)
  })

  test("unknown and hidden internal sessions are 404s", () => {
    expect(api("/api/session/ses_missing", "since=all", data).status).toBe(404)
    expect(api("/api/session/ses_test", "since=all", data).status).toBe(404)
    const included = bodyOf<SessionDetail>(api("/api/session/ses_test", "since=all&includeInternal=1", data))
    expect(included.session.internal).toBe(true)
    expect(included.callTotal).toBe(1)
  })
})

describe("recorded-call totals", () => {
  const started = new Date(2026, 9, 24, 10).getTime()
  const first = call({
    callID: "first",
    sessionID: "ses_first",
    providerID: "provider",
    modelID: "one",
    startedAt: started,
    firstTokenAt: started + 100,
    firstTextAt: started + 100,
    streamedAt: started + 1_100,
    tokensInput: 10,
    tokensOutput: 20,
    tokensReasoning: 3,
    tokensCacheRead: 40,
    tokensCacheWrite: 5,
    costUSD: 0.5,
    turnID: "turn_first",
  })
  const second = call({
    callID: "second",
    sessionID: "ses_second",
    providerID: "provider",
    modelID: "two",
    startedAt: started + 5_000,
    firstTokenAt: started + 5_300,
    firstTextAt: started + 5_300,
    streamedAt: started + 6_300,
    tokensInput: 7,
    tokensOutput: 11,
    tokensReasoning: 13,
    tokensCacheRead: 17,
    tokensCacheWrite: 19,
    costUSD: 0.75,
    turnID: "turn_second",
  })
  const data = snapshot({
    sessions: [
      session({
        id: "ses_first",
        costUSD: 9_999,
        tokensInput: 9_999,
        tokensOutput: 9_999,
        tokensReasoning: 9_999,
        tokensCacheRead: 9_999,
        tokensCacheWrite: 9_999,
        timeUpdated: started + 99_000,
      }),
      session({
        id: "ses_second",
        costUSD: 9_999,
        tokensInput: 9_999,
        tokensOutput: 9_999,
        tokensReasoning: 9_999,
        tokensCacheRead: 9_999,
        tokensCacheWrite: 9_999,
        timeUpdated: started + 99_000,
      }),
    ],
    calls: [first, second],
    turns: [
      turn({ turnID: "turn_first", endedAt: started + 1_000, updatedAt: started + 1_000 }),
      turn({
        turnID: "turn_second",
        startedAt: started + 5_000,
        acceptedAt: started + 5_000,
        endedAt: started + 6_000,
        updatedAt: started + 6_000,
      }),
    ],
  })

  // Legacy authoritative message rows must never reach a total. The snapshot
  // type intentionally has no messages field; injecting one proves the API cannot
  // accidentally reintroduce the old authoritative cost/token path.
  const legacy = { ...data, messages: [{ costUSD: 88_888, tokensInput: 88_888 }] } as WebSnapshot

  test("totals equal the recorded calls and ignore authoritative numbers", () => {
    const overview = bodyOf<Overview>(api("/api/overview", "since=all", legacy))
    expect(overview.totals).toEqual({
      calls: 2,
      sessions: 2,
      tokens: {
        input: 17,
        output: 31,
        reasoning: 16,
        cache: { read: 57, write: 24 },
        cacheRead: 57,
        cacheWrite: 24,
        total: 145,
      },
      tokensInput: 17,
      tokensOutput: 31,
      tokensReasoning: 16,
      tokensCacheRead: 57,
      tokensCacheWrite: 24,
      costUSD: 1.25,
      cacheHitRate: 57 / 74,
      excludedInternal: 0,
    })
    expect(overview.totals).not.toHaveProperty("steps")
    expect(overview.totals).not.toHaveProperty("prompts")
    expect(overview.totals).not.toHaveProperty("activeDays")
    expect(overview.rounds.total).toBe(2)
    expect(overview.sidecar.calls).toBe(2)
    expect(overview.sidecar.firstAt).toBe(started)
    expect(overview.sidecar.lastAt).toBe(started + 5_000)
    expect(overview.models.map((row) => [row.label, row.calls, row.costUSD])).toEqual([
      ["provider/two", 1, 0.75],
      ["provider/one", 1, 0.5],
    ])
  })

  test("authoritative session totals do not change sessions rows", () => {
    const sessions = bodyOf<Sessions>(api("/api/sessions", "since=all", legacy))
    expect(sessions.rows).toHaveLength(2)
    expect(sessions.rows[0]).toMatchObject({
      sessionID: "ses_second",
      calls: 1,
      tokens: { input: 7, output: 11, reasoning: 13, cacheRead: 17, cacheWrite: 19 },
      costUSD: 0.75,
      updatedAt: started + 5_000,
    })
    expect(sessions.rows[0]).not.toHaveProperty("steps")
    expect(sessions.rows[0]).not.toHaveProperty("recordedCalls")
  })
})

describe("model filtering", () => {
  const started = new Date(2026, 9, 24, 10).getTime()
  const calls = [
    call({
      callID: "a1",
      sessionID: "ses_a",
      providerID: "provider",
      modelID: "alpha",
      startedAt: started,
      firstTokenAt: started + 100,
      firstTextAt: started + 100,
      streamedAt: started + 1_100,
      tokensInput: 10,
      tokensOutput: 2,
      tokensReasoning: 1,
      tokensCacheRead: 4,
      tokensCacheWrite: 0,
      costUSD: 1,
      turnID: "turn_a",
    }),
    call({
      callID: "a2",
      sessionID: "ses_a",
      providerID: "provider",
      modelID: "alpha",
      startedAt: started + 2_000,
      firstTokenAt: started + 2_100,
      firstTextAt: started + 2_100,
      streamedAt: started + 3_100,
      tokensInput: 20,
      tokensOutput: 4,
      tokensReasoning: 2,
      tokensCacheRead: 8,
      tokensCacheWrite: 0,
      costUSD: 2,
      turnID: "turn_a",
    }),
    call({
      callID: "b1",
      sessionID: "ses_b",
      providerID: "provider",
      modelID: "beta",
      startedAt: started + 5_000,
      firstTokenAt: started + 5_300,
      firstTextAt: started + 5_300,
      streamedAt: started + 6_300,
      tokensInput: 40,
      tokensOutput: 8,
      tokensReasoning: 4,
      tokensCacheRead: 16,
      tokensCacheWrite: 0,
      costUSD: 4,
      turnID: "turn_b",
    }),
  ]
  const data = snapshot({
    sessions: [session({ id: "ses_a" }), session({ id: "ses_b" })],
    calls,
    turns: [
      turn({
        turnID: "turn_a",
        endedAt: started + 1_000,
        firstTokenAt: started + 100,
        updatedAt: started + 1_000,
      }),
      turn({
        turnID: "turn_b",
        startedAt: started + 5_000,
        acceptedAt: started + 5_000,
        endedAt: started + 10_000,
        firstTokenAt: started + 5_300,
        updatedAt: started + 10_000,
      }),
      // A round with no matching recorded call never contributes to the totals.
      turn({ turnID: "turn_orphan", startedAt: started + 20_000, endedAt: started + 21_000 }),
    ],
  })
  const alpha = bodyOf<Overview>(api("/api/overview", "since=all&model=provider/alpha", data))
  const beta = bodyOf<Overview>(api("/api/overview", "since=all&model=provider/beta", data))
  const all = bodyOf<Overview>(api("/api/overview", "since=all", data))

  test("totals, rounds, sidecar aggregates, and series narrow to the model while models stay complete", () => {
    expect(alpha.totals).toMatchObject({
      calls: 2,
      sessions: 1,
      tokens: { input: 30, output: 6, reasoning: 3, total: 51 },
      costUSD: 3,
    })
    expect(beta.totals).toMatchObject({ calls: 1, sessions: 1, costUSD: 4 })
    // The selector data is computed for the window and internal setting only,
    // so selecting a model cannot remove the other choices.
    expect(alpha.models).toEqual(all.models)
    expect(beta.models).toEqual(all.models)
    expect(all.models.map((row) => row.label)).toEqual(["provider/beta", "provider/alpha"])

    expect(alpha.rounds).toMatchObject({
      total: 1,
      completed: 1,
      roundMs: { p50: 1_000, p95: 1_000, avg: 1_000 },
      firstTokenMs: { p50: 100 },
    })
    expect(beta.rounds).toMatchObject({
      total: 1,
      roundMs: { p50: 5_000, p95: 5_000, avg: 5_000 },
      firstTokenMs: { p50: 300 },
    })
    expect(all.rounds.total).toBe(2)
    expect(all.rounds.roundMs.p50).toBe(3_000)
    expect(all.rounds.roundMs.p95).toBe(4_800)

    expect(alpha.sidecar).toMatchObject({ calls: 2, avgTTFT: 100, avgTPS: 3 })
    expect(beta.sidecar).toMatchObject({ calls: 1, avgTTFT: 300, avgTPS: 8 })
    expect(alpha.sidecar.firstAt).toBe(started)
    expect(alpha.sidecar.lastAt).toBe(started + 2_000)
    expect(beta.sidecar.firstAt).toBe(started + 5_000)

    const seriesCost = (overview: Overview) =>
      overview.series.reduce((total, point) => total + point.costUSD, 0)
    expect(seriesCost(alpha)).toBeCloseTo(3)
    expect(seriesCost(beta)).toBeCloseTo(4)
    expect(seriesCost(all)).toBeCloseTo(7)
    expect(alpha.series.reduce((total, point) => total + point.calls, 0)).toBe(2)
    expect(beta.series.reduce((total, point) => total + point.calls, 0)).toBe(1)

    expect(alpha.roundSeries.reduce((total, point) => total + point.rounds, 0)).toBe(1)
    expect(alpha.roundSeries.reduce((total, point) => total + point.cost, 0)).toBeCloseTo(3)
    expect(beta.roundSeries.reduce((total, point) => total + point.rounds, 0)).toBe(1)
    expect(beta.roundSeries.reduce((total, point) => total + point.cost, 0)).toBeCloseTo(4)
  })

  test("two non-overlapping models add up to the all-model total", () => {
    expect(alpha.totals.calls + beta.totals.calls).toBe(all.totals.calls)
    expect(alpha.totals.tokens.input + beta.totals.tokens.input).toBe(all.totals.tokens.input)
    expect(alpha.totals.tokens.output + beta.totals.tokens.output).toBe(all.totals.tokens.output)
    expect(alpha.totals.tokens.reasoning + beta.totals.tokens.reasoning).toBe(all.totals.tokens.reasoning)
    expect(alpha.totals.tokens.cacheRead + beta.totals.tokens.cacheRead).toBe(all.totals.tokens.cacheRead)
    expect(alpha.totals.tokens.cacheWrite + beta.totals.tokens.cacheWrite).toBe(all.totals.tokens.cacheWrite)
    expect(alpha.totals.costUSD + beta.totals.costUSD).toBeCloseTo(all.totals.costUSD)
  })

  test("rounds follow the model filter and exclude rounds without matching calls", () => {
    const allTurns = bodyOf<{ total: number; rows: Array<{ turnID: string }> }>(
      api("/api/turns", "since=all", data),
    )
    expect(allTurns.total).toBe(2)
    expect(allTurns.rows.map((row) => row.turnID)).not.toContain("turn_orphan")
    const alphaTurns = bodyOf<{ total: number; rows: Array<{ turnID: string }> }>(
      api("/api/turns", "since=all&model=provider/alpha", data),
    )
    expect(alphaTurns.total).toBe(1)
    expect(alphaTurns.rows.map((row) => row.turnID)).toEqual(["turn_a"])
    const betaTurns = bodyOf<{ total: number; rows: Array<{ turnID: string }> }>(
      api("/api/turns", "since=all&model=provider/beta", data),
    )
    expect(betaTurns.total).toBe(1)
    expect(betaTurns.rows.map((row) => row.turnID)).toEqual(["turn_b"])
  })
})

describe("internal-test-only models", () => {
  const data = snapshot({
    sessions: [session({ id: "ses_mock", internal: true, title: "[OC2 internal test] mock" })],
    calls: [
      call({
        callID: "mock",
        sessionID: "ses_mock",
        providerID: "mock",
        modelID: "test-model",
        startedAt: NOW - 1_000,
      }),
    ],
  })

  test("are absent from models and selector data unless internal rows are included", () => {
    const hidden = bodyOf<Overview>(api("/api/overview", "since=all", data))
    expect(hidden.totals.calls).toBe(0)
    expect(hidden.models).toEqual([])
    expect(hidden.models.some((row) => row.label === "mock/test-model")).toBe(false)

    const included = bodyOf<Overview>(api("/api/overview", "since=all&includeInternal=1", data))
    expect(included.models.map((row) => row.label)).toEqual(["mock/test-model"])
    expect(included.totals.calls).toBe(1)
  })
})

describe("sessions recorded-call rows", () => {
  const started = new Date(2026, 9, 24, 9).getTime()
  const data = snapshot({
    sessions: [session({ id: "ses_real", timeUpdated: started + 999_000 })],
    calls: [
      call({
        callID: "older",
        sessionID: "ses_real",
        startedAt: started,
        tokensInput: 1,
        tokensOutput: 2,
        tokensReasoning: 3,
        costUSD: 0.1,
      }),
      call({
        callID: "latest",
        sessionID: "ses_real",
        startedAt: started + 60_000,
        tokensInput: 4,
        tokensOutput: 5,
        tokensReasoning: 6,
        costUSD: 0.2,
      }),
    ],
  })

  test("use the latest matching call time and carry no step column", () => {
    const sessions = bodyOf<Sessions>(api("/api/sessions", "since=all", data))
    expect(sessions.rows[0]).toMatchObject({
      sessionID: "ses_real",
      calls: 2,
      updatedAt: started + 60_000,
      tokens: { input: 5, output: 7, reasoning: 9 },
    })
    expect(sessions.rows[0]?.costUSD).toBeCloseTo(0.3)
    expect(sessions.rows[0]).not.toHaveProperty("steps")
    expect(sessions.rows[0]).not.toHaveProperty("tokenTotal")
  })
})

describe("model parameter validation", () => {
  const endpoints = [
    "/api/overview",
    "/api/sessions",
    "/api/calls",
    "/api/turns",
    "/api/errors",
    "/api/pivot",
    "/api/heatmap",
    "/api/session/ses_real",
  ]

  test("a model without a provider separator is a named 400", () => {
    for (const pathname of endpoints) {
      const result = api(pathname, "since=all&model=provider-only")
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ parameter: "model" })
      expect((result.body as { error: string }).error).toContain("model")
    }
  })

  test("model ids may themselves contain slashes", () => {
    const result = api("/api/overview", "since=all&model=provider/deepseek/v4.1")
    expect(result.status).toBe(200)
  })
})

describe("meta", () => {
  test("reports paths and raw sidecar coverage", () => {
    const first = new Date(2026, 9, 20, 9).getTime()
    const last = new Date(2026, 9, 24, 9).getTime()
    const data = snapshot({
      calls: [call({ startedAt: first }), call({ callID: "call_2", startedAt: last })],
    })
    const meta = bodyOf<Meta>(api("/api/meta", "", data))
    expect(meta.sidecar).toEqual({
      path: "/data/usage.db",
      exists: true,
      calls: 2,
      firstAt: first,
      lastAt: last,
    })
    expect(meta.sessions).toEqual({
      path: "/data/opencode.db",
      exists: true,
      source: "scan",
      error: null,
    })
  })

  test("a missing sidecar and unresolved authoritative database stay explicit", () => {
    const data = snapshot({
      sidecarExists: false,
      calls: [],
      sessionsPath: null,
      sessionsSource: null,
      sessionsExists: false,
      sessionsResolveError: "no authoritative OpenCode database found",
    })
    const meta = bodyOf<Meta>(api("/api/meta", "", data))
    expect(meta.sidecar).toEqual({
      path: "/data/usage.db",
      exists: false,
      calls: 0,
      firstAt: null,
      lastAt: null,
    })
    expect(meta.sessions).toMatchObject({
      path: null,
      exists: false,
      error: "no authoritative OpenCode database found",
    })

    const result = api("/api/overview", "", data)
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: "authoritative database not found" })
  })
})

describe("unknown endpoints", () => {
  test("an unknown API route is a 404 JSON error", () => {
    const result = api("/api/nope")
    expect(result.status).toBe(404)
    expect(result.body).toEqual({ error: "unknown endpoint" })
  })
})

describe("endpoint capabilities", () => {
  test("meta advertises every route the page calls", () => {
    // A browser tab left open across an upgrade reads this list to tell "the
    // server is old" apart from a genuine failure.
    const meta = bodyOf<Meta>(api("/api/meta", "since=7d"))
    expect(meta.capabilities).toContain("providers")
    expect(meta.capabilities).toContain("quotas")
    expect(meta.capabilities).toContain("overview")
  })

  test("every advertised capability is routable", () => {
    const meta = bodyOf<Meta>(api("/api/meta", "since=7d"))
    for (const endpoint of meta.capabilities) {
      // `quotas` needs network I/O, so the HTTP layer answers it before the
      // dispatcher; it is covered by the quota tests instead.
      if (endpoint === "quotas") continue
      // Every route here answers without an id; the session and turn detail
      // routes are not in the list.
      expect(api(`/api/${endpoint}`, "since=7d").status).not.toBe(404)
    }
  })
})

describe("client capability contract", () => {
  test("every route the page gates on is one the server advertises", async () => {
    // The page refuses to call a view's routes when the server does not list
    // them, so a name it requires but the server omits would leave that view
    // permanently stale. This walks the per-view map rather than a single flat
    // list, because adding a tab must not silently skip the check.
    const app = await Bun.file(
      new URL("../web/public/app.js", import.meta.url).pathname,
    ).text()
    const block = /const VIEW_ENDPOINTS = \{[\s\S]*?\n\}/.exec(app)
    if (block === null) throw new Error("VIEW_ENDPOINTS not found")

    // Every view the URL can select must appear, so a new tab cannot be added
    // without also declaring (and therefore checking) what it needs.
    for (const view of ["usage", "providers", "rates"])
      expect(block[0]).toContain(`${view}: [`)

    const names = [...block[0].matchAll(/"([^"]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    )
    expect(names.length).toBeGreaterThan(0)
    const capabilities = bodyOf<Meta>(api("/api/meta", "since=7d")).capabilities
    for (const name of names) expect(capabilities).toContain(name)
  })

  test("the stale-server message names how to restart", async () => {
    const app = await Bun.file(
      new URL("../web/public/app.js", import.meta.url).pathname,
    ).text()
    // The message is the only guidance a user gets; it must name both ways the
    // server runs here (a local `bun run web` and the Docker container).
    expect(app).toContain("bun run web")
    expect(app).toContain("docker restart opencode2-usage")
  })
})
