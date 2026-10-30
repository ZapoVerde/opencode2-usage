import { describe, expect, test } from "bun:test"
import type { SessionRecord } from "../src/query"
import type { ProjectRecord, SessionProjectRecord } from "../src/read"
import type { CallRow } from "../src/reducer"
import { handleApi, type ApiResult, type WebSnapshot } from "../web/api"

const BASE_CALL: CallRow = {
  callID: "call_base",
  assistantMessageID: "msg_base",
  sessionID: "ses_base",
  parentSessionID: null,
  kind: "step",
  agent: "build",
  providerID: "provider",
  modelID: "model",
  modelVariant: null,
  directory: "/work",
  startedAt: Date.UTC(2026, 9, 24, 10),
  firstTokenAt: Date.UTC(2026, 9, 24, 10) + 100,
  firstTextAt: Date.UTC(2026, 9, 24, 10) + 100,
  streamedAt: Date.UTC(2026, 9, 24, 10) + 1_000,
  endedAt: Date.UTC(2026, 9, 24, 10) + 1_100,
  tokensInput: 10,
  tokensOutput: 20,
  tokensReasoning: 3,
  tokensCacheRead: 40,
  tokensCacheWrite: 5,
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
  recordedAt: Date.UTC(2026, 9, 24, 10) + 1_100,
}

const BASE_SESSION: SessionRecord = {
  id: "ses_base",
  title: "Base session",
  internal: false,
  costUSD: 1,
  tokensInput: 10,
  tokensOutput: 20,
  tokensReasoning: 3,
  tokensCacheRead: 40,
  tokensCacheWrite: 5,
  timeCreated: Date.UTC(2026, 9, 1),
  timeUpdated: Date.UTC(2026, 9, 24),
}

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return { ...BASE_SESSION, ...overrides }
}

function call(overrides: Partial<CallRow>): CallRow {
  return { ...BASE_CALL, ...overrides }
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

function api(pathname: string, query = "", data = snapshot(), now = Date.now()): ApiResult {
  return handleApi(pathname, new URLSearchParams(query), data, now)
}

function bodyOf<T>(result: ApiResult): T {
  expect(result.status).toBe(200)
  return result.body as T
}

type SeriesPoint = {
  day: string
  label: string
  calls: number
  costUSD: number
}

type Overview = {
  range: { since: number | null; label: string }
  tz: string
  granularity: string
  series: SeriesPoint[]
  roundSeries: Array<{ date: string; label: string }>
  errorSeries: Array<{ date: string; label: string }>
}

type Pivot = {
  range: { since: number | null; label: string }
  tz: string
  granularity: string
  by: string
  metric: string
  columns: Array<{ key: string; label: string; total: number }>
  rows: Array<{ bucket: string; label: string; total: number; cells: Array<{ key: string; value: number }> }>
  total: number
}

type Heatmap = {
  range: { since: number | null; label: string }
  tz: string
  metric: string
  weekdays: string[]
  hours: number[]
  cells: Array<{ weekday: number; hour: number; value: number }>
  max: number
  total: number
}

function keysOf(series: readonly SeriesPoint[]) {
  return series.map((point) => point.day)
}

describe("time-zone buckets", () => {
  const SPRING_NOW = Date.UTC(2026, 2, 29, 6)
  const springCalls = [
    call({ callID: "a", startedAt: Date.UTC(2026, 2, 28, 23, 30) }),
    call({ callID: "b", startedAt: Date.UTC(2026, 2, 29, 1, 30) }),
  ]

  test("hour buckets skip the nonexistent spring-forward hour without duplicates", () => {
    const result = bodyOf<Overview>(
      api(
        "/api/overview",
        "since=2026-03-29&tz=Europe/Berlin&granularity=hour",
        snapshot({ sessions: [session({})], calls: springCalls }),
        SPRING_NOW,
      ),
    )
    const keys = keysOf(result.series)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain("2026-03-29T01:00")
    expect(keys).toContain("2026-03-29T03:00")
    expect(keys).not.toContain("2026-03-29T02:00")
    // 01:30 UTC is 03:30 Berlin after the jump.
    expect(result.series.find((point) => point.day === "2026-03-29T03:00")?.calls).toBe(1)
  })

  test("hour buckets merge the repeated fall-back hour into one key", () => {
    const now = Date.UTC(2026, 9, 25, 4)
    const calls = [
      call({ callID: "first", startedAt: Date.UTC(2026, 9, 25, 0, 30) }),
      call({ callID: "second", startedAt: Date.UTC(2026, 9, 25, 1, 30) }),
    ]
    const result = bodyOf<Overview>(
      api(
        "/api/overview",
        "since=2026-10-25&tz=Europe/Berlin&granularity=hour",
        snapshot({ sessions: [session({})], calls }),
        now,
      ),
    )
    const keys = keysOf(result.series)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter((key) => key === "2026-10-25T02:00")).toHaveLength(1)
    expect(result.series.find((point) => point.day === "2026-10-25T02:00")?.calls).toBe(2)
  })

  test("day, week, and month starts follow the zone's calendar", () => {
    const now = Date.UTC(2026, 10, 1, 12)
    const calls = [
      // 2026-10-05 00:30 Berlin (Monday, October).
      call({ callID: "oct", startedAt: Date.UTC(2026, 9, 4, 22, 30) }),
      // 2026-11-01 00:30 Berlin (Sunday, week starts Monday 2026-10-26).
      call({ callID: "nov", startedAt: Date.UTC(2026, 9, 31, 23, 30) }),
    ]
    const data = snapshot({ sessions: [session({})], calls })

    const days = bodyOf<Overview>(
      api("/api/overview", "since=all&tz=Europe/Berlin&granularity=day", data, now),
    )
    expect(days.series.find((point) => point.day === "2026-10-05")?.label).toBe("10-05")
    expect(days.series.find((point) => point.day === "2026-11-01")?.label).toBe("11-01")

    const weeks = bodyOf<Overview>(
      api("/api/overview", "since=all&tz=Europe/Berlin&granularity=week", data, now),
    )
    const weekKeys = keysOf(weeks.series)
    expect(weekKeys).toContain("2026-10-05")
    expect(weekKeys).toContain("2026-10-26")
    expect(weekKeys).not.toContain("2026-11-02")
    expect(weeks.series.find((point) => point.day === "2026-10-05")?.label).toBe("W41")
    expect(new Set(weekKeys).size).toBe(weekKeys.length)
    expect(weekKeys).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"])

    const months = bodyOf<Overview>(
      api("/api/overview", "since=all&tz=Europe/Berlin&granularity=month", data, now),
    )
    expect(months.series.map((point) => point.day)).toEqual(["2026-10-01", "2026-11-01"])
    expect(months.series.map((point) => point.label)).toEqual(["Oct", "Nov"])
    expect(months.granularity).toBe("month")
    expect(months.tz).toBe("Europe/Berlin")
  })

  test("an absolute since resolves to midnight in the requested zone", () => {
    const bangkok = bodyOf<Overview>(
      api("/api/overview", "since=2026-10-01&tz=Asia/Bangkok", snapshot(), Date.UTC(2026, 9, 25)),
    )
    expect(bangkok.range.since).toBe(Date.UTC(2026, 8, 30, 17))
    expect(bangkok.range.label).toBe("2026-10-01")

    const berlin = bodyOf<Overview>(
      api("/api/overview", "since=2026-10-01&tz=Europe/Berlin", snapshot(), Date.UTC(2026, 9, 25)),
    )
    expect(berlin.range.since).toBe(Date.UTC(2026, 8, 30, 22))

    const utc = bodyOf<Overview>(
      api("/api/overview", "since=2026-10-01", snapshot(), Date.UTC(2026, 9, 25)),
    )
    expect(utc.range.since).toBe(Date.UTC(2026, 9, 1))
  })

  test("invalid tz, granularity, by, and metric are named 400s", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["/api/overview", "tz=Mars/Olympus", "tz"],
      ["/api/heatmap", "tz=not a zone", "tz"],
      ["/api/overview", "granularity=year", "granularity"],
      ["/api/pivot", "by=day", "by"],
      ["/api/pivot", "metric=ttft", "metric"],
      ["/api/heatmap", "metric=tokens", "metric"],
    ]
    for (const [pathname, query, parameter] of cases) {
      const result = api(pathname, query)
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ parameter })
      expect((result.body as { error: string }).error).toContain(parameter)
    }
  })
})

describe("pivot", () => {
  const NOW = Date.UTC(2026, 9, 25, 12)
  const sessions = [session({ id: "ses_base", title: "Base session" })]
  const models = Array.from({ length: 10 }, (_, index) => `m${index}`)
  const calls = models.map((modelID, index) =>
    call({
      callID: `call_${modelID}`,
      modelID,
      providerID: "p",
      costUSD: index + 1,
      startedAt: Date.UTC(2026, 9, 24, 10 + index),
      recordedAt: Date.UTC(2026, 9, 24, 10 + index),
    }),
  )

  test("keeps the top N by total and folds the rest into Other", () => {
    const pivot = bodyOf<Pivot>(
      api("/api/pivot", "since=7d&tz=UTC&by=model&metric=cost&limit=3", snapshot({ sessions, calls }), NOW),
    )
    expect(pivot.columns.map((column) => column.key)).toEqual(["p/m9", "p/m8", "p/m7", "__other"])
    expect(pivot.columns.map((column) => column.total)).toEqual([10, 9, 8, 28])
    expect(pivot.columns.at(-1)?.label).toBe("Other")
    expect(pivot.total).toBe(55)

    for (const row of pivot.rows) {
      expect(row.total).toBeCloseTo(row.cells.reduce((total, cell) => total + cell.value, 0))
      expect(row.cells.every((cell) => cell.value !== 0)).toBe(true)
    }
    expect(pivot.rows).toHaveLength(1)
  })

  test("column totals equal row sums and zero cells are omitted", () => {
    const spread = [
      call({ callID: "a", providerID: "p", modelID: "a", costUSD: 1, startedAt: Date.UTC(2026, 9, 24, 1) }),
      call({ callID: "b", providerID: "p", modelID: "b", costUSD: 2, startedAt: Date.UTC(2026, 9, 24, 2) }),
      call({ callID: "c", providerID: "p", modelID: "a", costUSD: 4, startedAt: Date.UTC(2026, 9, 25, 1) }),
      call({ callID: "z", providerID: "p", modelID: "zero", costUSD: 0, startedAt: Date.UTC(2026, 9, 25, 2) }),
    ]
    const pivot = bodyOf<Pivot>(
      api("/api/pivot", "since=7d&tz=UTC&by=model&metric=cost&limit=2", snapshot({ sessions, calls: spread }), NOW),
    )
    expect(pivot.columns).toEqual([
      { key: "p/a", label: "p/a", total: 5 },
      { key: "p/b", label: "p/b", total: 2 },
      { key: "__other", label: "Other", total: 0 },
    ])
    expect(pivot.rows.map((row) => row.bucket)).toEqual(["2026-10-24", "2026-10-25"])
    for (const row of pivot.rows) {
      expect(row.total).toBeCloseTo(row.cells.reduce((total, cell) => total + cell.value, 0))
      expect(row.cells.every((cell) => cell.value !== 0)).toBe(true)
    }
    for (const column of pivot.columns) {
      const fromRows = pivot.rows.reduce(
        (total, row) => total + (row.cells.find((cell) => cell.key === column.key)?.value ?? 0),
        0,
      )
      expect(fromRows).toBeCloseTo(column.total)
    }
    expect(pivot.total).toBeCloseTo(7)
  })

  test("groups sessions by short id plus title, agents by id, and counts calls", () => {
    const titled = [
      session({ id: "ses_one", title: "First task" }),
      session({ id: "ses_two", title: null }),
    ]
    const data = snapshot({
      sessions: titled,
      calls: [
        call({ callID: "1", sessionID: "ses_one", agent: "build", startedAt: Date.UTC(2026, 9, 24, 1) }),
        call({ callID: "2", sessionID: "ses_one", agent: "build", startedAt: Date.UTC(2026, 9, 24, 2) }),
        call({ callID: "3", sessionID: "ses_two", agent: null, startedAt: Date.UTC(2026, 9, 24, 3) }),
      ],
    })
    const sessionsPivot = bodyOf<Pivot>(
      api("/api/pivot", "since=7d&by=session&metric=calls", data, NOW),
    )
    expect(sessionsPivot.columns.find((column) => column.key === "ses_one")?.label).toBe("one First task")
    expect(sessionsPivot.columns.find((column) => column.key === "ses_two")?.label).toBe("two")
    expect(sessionsPivot.columns.find((column) => column.key === "ses_one")?.total).toBe(2)
    expect(sessionsPivot.total).toBe(3)

    const agents = bodyOf<Pivot>(api("/api/pivot", "since=7d&by=agent&metric=calls", data, NOW))
    expect(agents.columns.map((column) => [column.key, column.total])).toEqual([
      ["build", 2],
      ["unknown", 1],
    ])
  })

  test("groups projects by authoritative name and by worktree basename", () => {
    const projects: ProjectRecord[] = [
      { id: "p_named", name: "Named Project", worktree: "/work/ignored" },
      { id: "p_tree", name: null, worktree: "/work/repo-name" },
    ]
    const sessionProjects: SessionProjectRecord[] = [
      { sessionID: "ses_named", projectID: "p_named" },
      { sessionID: "ses_tree", projectID: "p_tree" },
    ]
    const data = snapshot({
      projects,
      sessionProjects,
      sessions: [
        session({ id: "ses_named" }),
        session({ id: "ses_tree" }),
        session({ id: "ses_orphan" }),
      ],
      calls: [
        call({ callID: "n", sessionID: "ses_named", costUSD: 3, startedAt: Date.UTC(2026, 9, 24, 1) }),
        call({ callID: "t", sessionID: "ses_tree", costUSD: 2, startedAt: Date.UTC(2026, 9, 24, 2) }),
        call({ callID: "o", sessionID: "ses_orphan", costUSD: 1, startedAt: Date.UTC(2026, 9, 24, 3) }),
      ],
    })
    const pivot = bodyOf<Pivot>(api("/api/pivot", "since=7d&by=project&metric=cost", data, NOW))
    expect(pivot.columns.map((column) => [column.key, column.label, column.total])).toEqual([
      ["p_named", "Named Project", 3],
      ["p_tree", "repo-name", 2],
      ["unknown", "unknown", 1],
    ])
  })

  test("tokens sum every token column and cost uses cost_usd", () => {
    const data = snapshot({
      sessions,
      calls: [
        call({
          callID: "tokens",
          tokensInput: 1,
          tokensOutput: 2,
          tokensReasoning: 3,
          tokensCacheRead: 4,
          tokensCacheWrite: 5,
          costUSD: 0.25,
        }),
      ],
    })
    const tokens = bodyOf<Pivot>(api("/api/pivot", "since=7d&metric=tokens", data, NOW))
    expect(tokens.total).toBe(15)
    const cost = bodyOf<Pivot>(api("/api/pivot", "since=7d&metric=cost", data, NOW))
    expect(cost.total).toBeCloseTo(0.25)
  })

  test("an absolute until is exclusive in the requested zone", () => {
    const data = snapshot({
      sessions,
      calls: [
        call({ callID: "inside", costUSD: 1, startedAt: Date.UTC(2026, 9, 1, 16, 30) }),
        call({ callID: "edge", costUSD: 1, startedAt: Date.UTC(2026, 9, 1, 17) }),
      ],
    })
    const pivot = bodyOf<Pivot>(
      api("/api/pivot", "since=2026-10-01&until=2026-10-02&tz=Asia/Bangkok", data, NOW),
    )
    expect(pivot.range.since).toBe(Date.UTC(2026, 8, 30, 17))
    expect(pivot.total).toBe(1)
    expect(pivot.rows.map((row) => row.bucket)).toEqual(["2026-10-01"])
  })

  test("an empty window returns empty arrays and zero totals", () => {
    const pivot = bodyOf<Pivot>(api("/api/pivot", "since=24h", snapshot(), NOW))
    expect(pivot.rows).toEqual([])
    expect(pivot.columns).toEqual([])
    expect(pivot.total).toBe(0)
    expect(pivot.granularity).toBe("day")
    expect(pivot.by).toBe("model")
    expect(pivot.metric).toBe("cost")
  })
})

describe("heatmap", () => {
  const NOW = Date.UTC(2026, 9, 25, 12)
  const calls = [
    // Monday 08:00 and 08:30 in Bangkok.
    call({ callID: "mon_1", startedAt: Date.UTC(2026, 9, 19, 1), costUSD: 0.1 }),
    call({ callID: "mon_2", startedAt: Date.UTC(2026, 9, 19, 1, 30), costUSD: 0.2 }),
    // Tuesday 00:00 in Bangkok (Monday 17:00 UTC).
    call({ callID: "tue", startedAt: Date.UTC(2026, 9, 19, 17), costUSD: 0.3 }),
    // Sunday 19:00 in Bangkok.
    call({ callID: "sun", startedAt: Date.UTC(2026, 9, 25, 12), costUSD: 0.4 }),
  ]

  test("maps calls to the zone's weekday and hour with sparse cells", () => {
    const heatmap = bodyOf<Heatmap>(
      api("/api/heatmap", "since=7d&tz=Asia/Bangkok", snapshot({ calls }), NOW),
    )
    expect(heatmap.weekdays).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    expect(heatmap.hours).toEqual(Array.from({ length: 24 }, (_, hour) => hour))
    expect(heatmap.cells).toEqual([
      { weekday: 1, hour: 8, value: 2 },
      { weekday: 2, hour: 0, value: 1 },
      { weekday: 7, hour: 19, value: 1 },
    ])
    expect(heatmap.max).toBe(2)
    expect(heatmap.total).toBe(4)
    expect(heatmap.metric).toBe("calls")
    expect(heatmap.tz).toBe("Asia/Bangkok")
  })

  test("the same calls land in different cells in UTC", () => {
    const heatmap = bodyOf<Heatmap>(
      api("/api/heatmap", "since=7d&tz=UTC", snapshot({ calls }), NOW),
    )
    expect(heatmap.cells).toContainEqual({ weekday: 1, hour: 1, value: 2 })
    expect(heatmap.cells).toContainEqual({ weekday: 1, hour: 17, value: 1 })
    expect(heatmap.cells).toContainEqual({ weekday: 7, hour: 12, value: 1 })
    expect(heatmap.total).toBe(4)
    expect(heatmap.max).toBe(2)
  })

  test("cost sums cost_usd and keeps max and total consistent", () => {
    const heatmap = bodyOf<Heatmap>(
      api("/api/heatmap", "since=7d&tz=Asia/Bangkok&metric=cost", snapshot({ calls }), NOW),
    )
    expect(heatmap.cells).toEqual([
      { weekday: 1, hour: 8, value: 0.30000000000000004 },
      { weekday: 2, hour: 0, value: 0.3 },
      { weekday: 7, hour: 19, value: 0.4 },
    ])
    expect(heatmap.max).toBeCloseTo(0.4)
    expect(heatmap.total).toBeCloseTo(1)
  })

  test("an empty window returns no cells and zero totals", () => {
    const heatmap = bodyOf<Heatmap>(api("/api/heatmap", "since=24h", snapshot(), NOW))
    expect(heatmap.cells).toEqual([])
    expect(heatmap.max).toBe(0)
    expect(heatmap.total).toBe(0)
    expect(heatmap.range.since).toBe(NOW - 86_400_000)
  })
})
