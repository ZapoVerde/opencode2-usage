import path from "node:path"
import { DateTime } from "luxon"
import { modelLabel, shortSession, singleLine } from "../src/format"
import {
  callTime,
  groupErrors,
  isTimeoutTurn,
  isTurnDisplayStatus,
  parseSince,
  selectTurns,
  sessionMatches,
  sidecarCoverage,
  turnFirstTokenMs,
  turnRoundMs,
  turnStatus,
  type ErrorSourceSelection,
  type SessionRecord,
  type TurnDisplayStatus,
  type TurnRecord,
  type TurnSummary,
} from "../src/query"
import type { ProjectRecord, SessionProjectRecord } from "../src/read"
import { metrics, type CallMetrics, type CallRow } from "../src/reducer"
import {
  providerReport,
  type Plans,
  type ProviderReport,
  type TokenTotals,
} from "../src/plans"
import { rateTable } from "../src/rates"
import {
  GRANULARITIES,
  HOURS,
  WEEKDAYS,
  bucketAxis,
  isValidTimeZone,
  seriesAxis,
  type BucketAxis,
  type Granularity,
} from "./time"

// Everything a request needs. The server loads this per request from read-only
// database handles; tests build it directly, so the response assembly stays pure.
// All numeric metrics come from the sidecar's recorded calls and rounds. The
// authoritative database only supplies display metadata: session titles,
// internal-test markers, and project names.
export type WebSnapshot = {
  readonly sidecarPath: string
  readonly sidecarExists: boolean
  readonly calls: readonly CallRow[]
  readonly turns: readonly TurnRecord[]
  readonly sessionsPath: string | null
  readonly sessionsSource: "flag" | "env" | "scan" | null
  readonly sessionsExists: boolean
  readonly sessionsResolveError: string | null
  readonly sessions: readonly SessionRecord[]
  readonly projects?: readonly ProjectRecord[]
  readonly sessionProjects?: readonly SessionProjectRecord[]
  /** Fixed-fee plan configuration; empty when no plans file is configured. */
  readonly plans?: Plans
  readonly plansPath?: string | null
  /**
   * Net change from putting calls on their plan's own price card.
   *
   * Reported so every total can say what it includes: a nonzero figure means the
   * recorded spend shown is the plan's card, not the raw event stream. Positive
   * means OpenCode's table was low.
   */
  readonly imputedCostUSD?: number
  /** Calls carrying tokens that no plan rate could price, left at their recorded value. */
  readonly unpricedCalls?: number
}

export type ApiResult = {
  readonly status: number
  readonly body: unknown
}

const THIRTY_DAYS = 30 * 86_400_000
const SEVEN_DAYS = 7 * 86_400_000
const SESSION_SORTS = ["updated", "cost", "tokens", "ttft", "tps"] as const
const CALL_SORTS = ["started", "cost", "ttft", "tps"] as const
const TURN_SORTS = ["started", "round", "cost", "calls"] as const
const CALL_STATUSES = ["completed", "failed", "retried", "interrupted", "compaction"] as const
const ERROR_SOURCES = ["all", "call", "turn"] as const
const PIVOT_BYS = ["model", "agent", "session", "project"] as const
const PIVOT_METRICS = ["cost", "calls", "tokens"] as const
const HEATMAP_METRICS = ["calls", "cost"] as const

type SessionSort = (typeof SESSION_SORTS)[number]
type CallSort = (typeof CALL_SORTS)[number]
type TurnSort = (typeof TURN_SORTS)[number]
type CallStatus = (typeof CALL_STATUSES)[number]
type ErrorSource = (typeof ERROR_SOURCES)[number]
type PivotBy = (typeof PIVOT_BYS)[number]
type PivotMetric = (typeof PIVOT_METRICS)[number]
type Direction = "asc" | "desc"

type Range = {
  readonly since: number | null
  readonly label: string
}

type CallView = {
  readonly call: CallRow
  readonly metrics: CallMetrics
  readonly internal: boolean
}

class HttpError extends Error {
  readonly status: number
  readonly parameter: string | undefined

  constructor(status: number, message: string, parameter?: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.parameter = parameter
  }
}

/**
 * Map an API path and its query string to `{ status, body }`. Everything here is
 * pure; only the server touches SQLite. Unexpected errors are rethrown for the
 * server to turn into a generic 500 response.
 */
/**
 * Routes this build serves. Kept beside the dispatcher so adding a route means
 * touching one list rather than remembering a second place to declare it.
 */
const ENDPOINT_CAPABILITIES = [
  "meta",
  "overview",
  "sessions",
  "calls",
  "turns",
  "errors",
  "pivot",
  "heatmap",
  "providers",
  "rates",
  "quotas",
] as const

export function handleApi(
  pathname: string,
  parameters: URLSearchParams,
  snapshot: WebSnapshot,
  now: number,
): ApiResult {
  try {
    if (pathname === "/api/meta") return ok(metaResponse(parameters, snapshot, now))
    if (pathname === "/api/overview") {
      requireAuthoritative(snapshot)
      return ok(overviewResponse(parameters, snapshot, now))
    }
    if (pathname === "/api/sessions") {
      requireAuthoritative(snapshot)
      return ok(sessionsResponse(parameters, snapshot, now))
    }
    if (pathname === "/api/calls") {
      requireAuthoritative(snapshot)
      return ok(callsResponse(parameters, snapshot, now))
    }
    if (pathname === "/api/turns") {
      requireAuthoritative(snapshot)
      return ok(turnsResponse(parameters, snapshot, now))
    }
    if (pathname === "/api/errors") {
      requireAuthoritative(snapshot)
      return ok(errorsResponse(parameters, snapshot, now))
    }
    if (pathname === "/api/pivot") {
      requireAuthoritative(snapshot)
      return ok(pivotResponse(parameters, snapshot, now))
    }
    if (pathname === "/api/heatmap") {
      requireAuthoritative(snapshot)
      return ok(heatmapResponse(parameters, snapshot, now))
    }
    if (pathname === "/api/providers") {
      // Plan spend and token counts come from the sidecar and the plans file,
      // so a missing authoritative database only costs the internal-test filter.
      return ok(providersResponse(parameters, snapshot, now))
    }
    if (pathname === "/api/rates") return ok(ratesResponse(parameters, snapshot, now))
    if (pathname.startsWith("/api/session/")) {
      requireAuthoritative(snapshot)
      return ok(sessionResponse(pathname, parameters, snapshot, now))
    }
    if (pathname.startsWith("/api/turn/")) {
      requireAuthoritative(snapshot)
      return ok(turnResponse(pathname, parameters, snapshot, now))
    }
    throw new HttpError(404, "unknown endpoint")
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    const body =
      error.parameter === undefined
        ? { error: error.message }
        : { error: error.message, parameter: error.parameter }
    return { status: error.status, body }
  }
}

function ok(body: unknown): ApiResult {
  return { status: 200, body }
}

function requireAuthoritative(snapshot: WebSnapshot) {
  if (!snapshot.sessionsExists) throw new HttpError(500, "authoritative database not found")
}

function metaResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, ["since", "includeInternal", "tz"])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "all", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const coverage = sidecarCoverage(snapshot.calls)
  return {
    now,
    range,
    tz,
    includeInternal,
    /**
     * Endpoints this build serves.
     *
     * A browser tab left open across an upgrade can call a route an older server
     * does not have, which otherwise surfaces as a bare "unknown endpoint". The
     * client compares this list and says the server is out of date instead.
     */
    capabilities: ENDPOINT_CAPABILITIES,
    // Spend totals are on the plan's own card; this is the net change from the
    // recorded table, and the number of calls that could not be priced at all.
    // Both are surfaced so a total is never silently short.
    imputedCostUSD: snapshot.imputedCostUSD ?? 0,
    unpricedCalls: snapshot.unpricedCalls ?? 0,
    sidecar: {
      path: snapshot.sidecarPath,
      exists: snapshot.sidecarExists,
      calls: coverage.calls,
      firstAt: coverage.firstAt,
      lastAt: coverage.lastAt,
    },
    sessions: {
      path: snapshot.sessionsPath,
      exists: snapshot.sessionsExists,
      source: snapshot.sessionsSource,
      error: snapshot.sessionsResolveError,
    },
  }
}

function overviewResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, ["since", "includeInternal", "tz", "granularity", "model"])
  const tz = parseTimezone(parameters)
  const granularity = parseGranularity(parameters)
  const range = parseRange(parameters, now, "all", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const model = parseModel(parameters)
  const internal = internalSessionSet(snapshot.sessions)
  const selected = selectRecordedCalls(snapshot.calls, range.since, null, internal, includeInternal, model)
  const calls = selected.calls
  // The selector must keep offering every model in the window, so the model
  // breakdown ignores the selected model while still honouring the window and
  // internal-test setting.
  const modelCalls = selectRecordedCalls(snapshot.calls, range.since, null, internal, includeInternal, null).calls
  const totals = recordedTotals(calls, selected.excludedInternal)
  const matchingTurns = turnsForCalls(snapshot.turns, calls)
  const statuses = matchingTurns.map((turn) => turnStatus(turn, now))
  const countStatus = (status: TurnDisplayStatus) => statuses.filter((value) => value === status).length
  const completedRoundMs = matchingTurns
    .filter((turn) => turn.status === "completed")
    .map((turn) => turnRoundMs(turn))
    .filter(isNumber)
  const firstTokenValues = matchingTurns.map((turn) => turnFirstTokenMs(turn)).filter(isNumber)
  const failed = countStatus("failed")
  const interrupted = countStatus("interrupted")
  // Call-level errors, which is the figure the headline rate uses. A round is a
  // container for several calls; it only fails when the whole thing gives up, so
  // a per-round rate hides the individual calls that did error.
  const failedCalls = calls.filter((call) => call.status === "failed").length
  const interruptedCalls = calls.filter((call) => call.status === "interrupted").length
  const coverage = sidecarCoverage(calls)
  const ttfts = metricValues(calls, "ttft")
  const tpss = metricValues(calls, "tps")

  return {
    range,
    tz,
    granularity,
    includeInternal,
    model,
    totals,
    callErrors: {
      failed: failedCalls,
      interrupted: interruptedCalls,
      rate: calls.length === 0 ? null : (failedCalls + interruptedCalls) / calls.length,
    },
    rounds: {
      total: matchingTurns.length,
      running: countStatus("running"),
      stale: countStatus("stale"),
      completed: countStatus("completed"),
      failed,
      interrupted,
      timeouts: matchingTurns.filter(isTimeoutTurn).length,
      errorRate:
        matchingTurns.length === 0 ? null : (failed + interrupted) / matchingTurns.length,
      retries: sum(matchingTurns.map((turn) => turn.retries)),
      roundMs: {
        p50: percentile(completedRoundMs, 0.5),
        p95: percentile(completedRoundMs, 0.95),
        avg: average(completedRoundMs),
      },
      firstTokenMs: { p50: percentile(firstTokenValues, 0.5) },
    },
    sidecar: {
      calls: coverage.calls,
      avgTTFT: average(ttfts),
      p50TTFT: percentile(ttfts, 0.5),
      p95TTFT: percentile(ttfts, 0.95),
      avgTPS: average(tpss),
      firstAt: coverage.firstAt,
      lastAt: coverage.lastAt,
    },
    models: aggregateRecordedModels(modelCalls),
    series: buildSeries(calls, range.since, now, tz, granularity),
    roundSeries: buildRoundSeries(matchingTurns, calls, range.since, now, tz, granularity),
    errorSeries: buildErrorSeries(calls, matchingTurns, range.since, now, tz, granularity),
  }
}

function sessionsResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, ["since", "includeInternal", "q", "model", "limit", "sort", "dir", "tz"])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "30d", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const limit = parseInteger(parameters, "limit", 50, 1, 1_000)
  const sort = parseSort(parameters, SESSION_SORTS, "updated")
  const direction = parseDirection(parameters)
  const query = (parameters.get("q") ?? "").trim().toLowerCase()
  const model = parseModel(parameters)
  const internal = internalSessionSet(snapshot.sessions)
  const selected = selectRecordedCalls(snapshot.calls, range.since, null, internal, includeInternal, model)

  const rows = aggregateRecordedSessions(selected.calls, snapshot.sessions).filter(
    (row) =>
      query.length === 0 ||
      row.id.toLowerCase().includes(query) ||
      (row.title ?? "").toLowerCase().includes(query),
  )
  const sorted = [...rows].sort((left, right) => {
    const order = compareNullable(sessionSortValue(left, sort), sessionSortValue(right, sort), direction)
    return order !== 0 ? order : left.id.localeCompare(right.id)
  })

  return {
    range,
    tz,
    includeInternal,
    model,
    excludedInternal: selected.excludedInternal,
    total: sorted.length,
    limit,
    rows: sorted.slice(0, limit).map(recordedSessionJSON),
  }
}

function callsResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, [
    "since",
    "includeInternal",
    "session",
    "model",
    "status",
    "minTTFT",
    "limit",
    "offset",
    "sort",
    "dir",
    "tz",
  ])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "all", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const limit = parseInteger(parameters, "limit", 100, 1, 1_000)
  const offset = parseInteger(parameters, "offset", 0, 0, Number.MAX_SAFE_INTEGER)
  const sort = parseSort(parameters, CALL_SORTS, "started")
  const direction = parseDirection(parameters)
  const session = parameters.get("session")
  const model = parseModel(parameters)
  const status = parseStatus(parameters)
  const minTTFT = parseNumber(parameters, "minTTFT")
  const internal = internalSessionSet(snapshot.sessions)
  const titles = sessionTitles(snapshot.sessions)

  const views = snapshot.calls
    .filter((call) => range.since === null || callTime(call) >= range.since)
    .filter((call) => session === null || sessionMatches(call.sessionID, session))
    .filter((call) => model === null || matchesModel(call.providerID, call.modelID, model))
    .filter((call) => matchesStatus(call, status))
    .map((call) => ({ call, metrics: metrics(call), internal: internal.has(call.sessionID) }))
    .filter((view) => minTTFT === null || (view.metrics.ttft !== undefined && view.metrics.ttft >= minTTFT))
  const visible = includeInternal ? views : views.filter((view) => !view.internal)
  const sorted = [...visible].sort((left, right) => {
    const order = compareNullable(callSortValue(left, sort), callSortValue(right, sort), direction)
    if (order !== 0) return order
    return callTime(right.call) - callTime(left.call) || left.call.callID.localeCompare(right.call.callID)
  })

  return {
    range,
    tz,
    includeInternal,
    model,
    excludedInternal: includeInternal ? 0 : views.length - visible.length,
    total: sorted.length,
    limit,
    offset,
    rows: sorted.slice(offset, offset + limit).map((view) => callJSON(view, titles)),
  }
}

function turnsResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, [
    "since",
    "includeInternal",
    "session",
    "model",
    "status",
    "onlyErrors",
    "limit",
    "offset",
    "sort",
    "dir",
    "tz",
  ])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "7d", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const status = parseTurnStatus(parameters)
  const onlyErrors = parseBoolean(parameters, "onlyErrors", false)
  const limit = parseInteger(parameters, "limit", 50, 1, 1_000)
  const offset = parseInteger(parameters, "offset", 0, 0, Number.MAX_SAFE_INTEGER)
  const sort = parseSort(parameters, TURN_SORTS, "started")
  const direction = parseDirection(parameters)
  const session = parameters.get("session")
  const model = parseModel(parameters)
  const internal = internalSessionSet(snapshot.sessions)
  const titles = sessionTitles(snapshot.sessions)

  // A round is listed only when at least one of its recorded calls falls in the
  // window and matches the model. The call set is prefiltered here, then
  // selectTurns owns the round definitions (duration, status, timeout, call
  // stats) and the session/status/error filters.
  const windowModelCalls = snapshot.calls.filter(
    (call) =>
      (range.since === null || callTime(call) >= range.since) &&
      (model === null || matchesModel(call.providerID, call.modelID, model)),
  )
  const visibleCalls = includeInternal
    ? windowModelCalls
    : windowModelCalls.filter((call) => !internal.has(call.sessionID))
  const matchingRounds = turnsForCalls(snapshot.turns, visibleCalls)
  const excludedInternal = includeInternal
    ? 0
    : turnsForCalls(
        snapshot.turns,
        windowModelCalls.filter((call) => internal.has(call.sessionID)),
      ).length
  const selected = selectTurns(
    matchingRounds,
    visibleCalls,
    {
      since: null,
      limit: Number.MAX_SAFE_INTEGER,
      session,
      status,
      errorsOnly: onlyErrors,
      includeInternal: true,
      internalSessions: internal,
      titles,
    },
    now,
  )
  const sorted = [...selected.rows].sort((left, right) => {
    const order = compareNullable(turnSortValue(left, sort), turnSortValue(right, sort), direction)
    if (order !== 0) return order
    return right.startedAt - left.startedAt || left.turnID.localeCompare(right.turnID)
  })

  return {
    range,
    tz,
    includeInternal,
    model,
    excludedInternal,
    total: sorted.length,
    limit,
    offset,
    rows: sorted.slice(offset, offset + limit).map(turnJSON),
  }
}

function errorsResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, ["since", "includeInternal", "source", "tz", "model"])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "30d", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const source = parseErrorSource(parameters)
  const model = parseModel(parameters)
  const sources: ErrorSourceSelection = source === "call" ? "calls" : source === "turn" ? "turns" : "both"
  const internal = internalSessionSet(snapshot.sessions)
  const modelCalls =
    model === null
      ? snapshot.calls
      : snapshot.calls.filter((call) => matchesModel(call.providerID, call.modelID, model))
  const visibleModelCalls = includeInternal
    ? modelCalls
    : modelCalls.filter((call) => !internal.has(call.sessionID))
  // Round errors come only from rounds that have a matching recorded call in
  // the window. Call errors keep their existing end-time window.
  const matchingRounds = turnsForCalls(
    snapshot.turns,
    visibleModelCalls.filter((call) => range.since === null || callTime(call) >= range.since),
  )
  const rows = groupErrors({
    calls: visibleModelCalls,
    turns: matchingRounds,
    since: range.since,
    internalSessions: internal,
    includeInternal: true,
    sources,
  })
  return {
    range,
    tz,
    includeInternal,
    model,
    source,
    rows: rows.map((row) => ({
      errorType: row.errorType,
      source: row.source,
      count: row.count,
      sessions: row.sessions,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
      lastMessage: row.lastMessage === null ? null : singleLine(row.lastMessage, 60),
    })),
  }
}

type PivotIndexes = {
  readonly titles: ReadonlyMap<string, string | null>
  readonly projects: ReadonlyMap<string, ProjectRecord>
  readonly projectBySession: ReadonlyMap<string, string>
}

type PivotColumn = {
  readonly key: string
  readonly label: string
  readonly total: number
}

// Recorded calls are the unit for all three metrics. `cost` reads `cost_usd`
// from every recorded call (including compactions and unsuccessful attempts),
// `calls` counts those rows, and `tokens` sums the five token columns.
function pivotResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, [
    "since",
    "until",
    "tz",
    "granularity",
    "by",
    "metric",
    "limit",
    "includeInternal",
    "model",
  ])
  const tz = parseTimezone(parameters)
  const granularity = parseGranularity(parameters)
  const by = parseChoice(parameters, "by", PIVOT_BYS, "model")
  const metric = parseChoice(parameters, "metric", PIVOT_METRICS, "cost")
  const limit = parseInteger(parameters, "limit", 8, 1, 20)
  const includeInternal = parseIncludeInternal(parameters)
  const model = parseModel(parameters)
  const range = parseRange(parameters, now, "7d", tz)
  const until = parseUntil(parameters, now, tz)
  const internal = internalSessionSet(snapshot.sessions)
  const calls = snapshot.calls.filter(
    (call) =>
      inCallWindow(call, range.since, until) &&
      (model === null || matchesModel(call.providerID, call.modelID, model)) &&
      (includeInternal || !internal.has(call.sessionID)),
  )
  const indexes = pivotIndexes(snapshot)
  const labels = new Map<string, string>()
  const columnTotals = new Map<string, number>()
  const rowsByBucket = new Map<string, Map<string, number>>()
  const bucketLabels = new Map<string, string>()
  const starts = calls.map(callTime)
  const axis =
    calls.length === 0
      ? undefined
      : bucketAxis(earliest(starts) ?? now, latest(starts) ?? now, tz, granularity)

  for (const call of calls) {
    const at = axis === undefined ? undefined : bucketAt(axis, callTime(call))
    if (at === undefined) continue
    const dimension = pivotDimension(by, call, indexes)
    const value = pivotValue(metric, call)
    labels.set(dimension.key, dimension.label)
    bucketLabels.set(at.key, at.label)
    columnTotals.set(dimension.key, (columnTotals.get(dimension.key) ?? 0) + value)
    const row = rowsByBucket.get(at.key) ?? new Map<string, number>()
    rowsByBucket.set(at.key, row)
    row.set(dimension.key, (row.get(dimension.key) ?? 0) + value)
  }

  const ranked = [...columnTotals.entries()]
    .map(([key, total]) => ({ key, label: labels.get(key) ?? key, total }))
    .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key))
  const top = ranked.slice(0, limit)
  const rest = ranked.slice(limit)
  const columns: PivotColumn[] =
    rest.length === 0
      ? top
      : [
          ...top,
          {
            key: "__other",
            label: "Other",
            total: rest.reduce((total, column) => total + column.total, 0),
          },
        ]
  const otherKeys = new Set(rest.map((column) => column.key))

  const rows = [...rowsByBucket.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, values]) => {
      const cells = top.flatMap((column) => {
        const value = values.get(column.key) ?? 0
        return value === 0 ? [] : [{ key: column.key, value }]
      })
      const other = [...values.entries()]
        .filter(([key]) => otherKeys.has(key))
        .reduce((total, [, value]) => total + value, 0)
      if (other !== 0) cells.push({ key: "__other", value: other })
      return {
        bucket,
        label: bucketLabels.get(bucket) ?? bucket,
        total: [...values.values()].reduce((total, value) => total + value, 0),
        cells,
      }
    })

  return {
    range,
    tz,
    granularity,
    by,
    metric,
    model,
    columns,
    rows,
    total: columns.reduce((total, column) => total + column.total, 0),
  }
}

function heatmapResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, ["since", "tz", "metric", "includeInternal", "model"])
  const tz = parseTimezone(parameters)
  const metric = parseChoice(parameters, "metric", HEATMAP_METRICS, "calls")
  const includeInternal = parseIncludeInternal(parameters)
  const model = parseModel(parameters)
  const range = parseRange(parameters, now, "30d", tz)
  const internal = internalSessionSet(snapshot.sessions)
  const calls = snapshot.calls.filter(
    (call) =>
      inCallWindow(call, range.since, null) &&
      (model === null || matchesModel(call.providerID, call.modelID, model)) &&
      (includeInternal || !internal.has(call.sessionID)),
  )
  const starts = calls.map(callTime)
  const axis =
    calls.length === 0 ? undefined : bucketAxis(earliest(starts) ?? now, latest(starts) ?? now, tz, "hour")

  const cells = new Map<string, { weekday: number; hour: number; value: number }>()
  for (const call of calls) {
    const at = axis === undefined ? undefined : bucketAt(axis, callTime(call))
    if (at === undefined) continue
    const key = `${at.weekday}\u0000${at.hour}`
    const cell = cells.get(key) ?? { weekday: at.weekday, hour: at.hour, value: 0 }
    cells.set(key, cell)
    cell.value += metric === "calls" ? 1 : (call.costUSD ?? 0)
  }

  const visible = [...cells.values()]
    .filter((cell) => cell.value !== 0)
    .sort((left, right) => left.weekday - right.weekday || left.hour - right.hour)
  const max = visible.reduce((highest, cell) => Math.max(highest, cell.value), 0)
  const total = visible.reduce((sum, cell) => sum + cell.value, 0)
  return {
    range,
    tz,
    metric,
    model,
    weekdays: [...WEEKDAYS],
    hours: [...HOURS],
    cells: visible,
    max,
    total,
  }
}

/**
 * One row per provider, with plan spend for the window.
 *
 * Recorded `cost_usd` is OpenCode's list-price estimate. A fixed-fee plan's real
 * spend is the prorated monthly fee, so both appear side by side: `spendUSD` is
 * what the account paid, `meteredUSD` is what the same tokens would cost at list
 * price. Providers without a plan show `spendUSD: 0` and `plan: null`.
 */
function providersResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, ["since", "tz", "includeInternal", "model"])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "30d", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const model = parseModel(parameters)
  const internal = internalSessionSet(snapshot.sessions)
  const selected = selectRecordedCalls(snapshot.calls, range.since, null, internal, includeInternal, model)
  const plans = snapshot.plans ?? { providers: new Map(), errors: [] }

  const groups = new Map<string, CallRow[]>()
  for (const call of selected.calls) {
    const providerID = call.providerID ?? "unknown"
    const group = groups.get(providerID)
    if (group) group.push(call)
    else groups.set(providerID, [call])
  }

  const rows: ProviderReport[] = [...groups.entries()].map(([providerID, calls]) => {
    const plan = plans.providers.get(providerID) ?? null
    return providerReport({
      plan,
      providerID,
      sessions: new Set(calls.map((call) => call.sessionID)).size,
      since: range.since,
      until: now,
      samples: calls.map((call) => ({
        modelID: call.modelID ?? "unknown",
        at: callTime(call),
        tokens: callTokens(call),
        recordedUSD: call.costUSD ?? 0,
      })),
    })
  })

  rows.sort(
    (left, right) =>
      right.spendUSD - left.spendUSD ||
      (right.meteredUSD ?? 0) - (left.meteredUSD ?? 0) ||
      left.providerID.localeCompare(right.providerID),
  )

  return {
    range,
    tz,
    includeInternal,
    model,
    excludedInternal: selected.excludedInternal,
    plansPath: snapshot.plansPath ?? null,
    planErrors: plans.errors,
    rows: rows.map(providerJSON),
  }
}

/**
 * What a real dollar buys, per provider, for one model.
 *
 * The provider page answers "what did I pay and what was it worth". This answers
 * a different question: given the published allowance and the model's list
 * price, how many tokens does the next dollar of fee buy — at peak and off-peak?
 *
 * The answer is time-dependent because the plans meter the same model
 * differently. Command Code and OpenCode Go quote an allowance in dollars at
 * official API prices, so it tracks DeepSeek's clock; OpenDesign's card is flat
 * at every hour, so it does not. Keeping both columns means the page
 * can show the crossover instead of implying one plan wins outright.
 */
function ratesResponse(parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, ["since", "tz", "includeInternal", "model"])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "30d", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const model = parseModel(parameters)
  const internal = internalSessionSet(snapshot.sessions)
  const selected = selectRecordedCalls(snapshot.calls, range.since, null, internal, includeInternal, model)
  const plans = snapshot.plans ?? { providers: new Map(), errors: [] }

  const table = rateTable({
    plans,
    now,
    samples: selected.calls.map((call) => ({
      providerID: call.providerID ?? "unknown",
      modelID: call.modelID,
      at: callTime(call),
      recordedUSD: call.costUSD ?? 0,
      tokens: callTokens(call),
    })),
  })

  return {
    range,
    tz,
    includeInternal,
    model,
    excludedInternal: selected.excludedInternal,
    plansPath: snapshot.plansPath ?? null,
    planErrors: plans.errors,
    mix: table.mix,
    peakShare: table.peakShare,
    rows: table.rows,
    skipped: table.skipped,
  }
}

function callTokens(call: CallRow): TokenTotals {
  return {
    input: call.tokensInput ?? 0,
    output: call.tokensOutput ?? 0,
    reasoning: call.tokensReasoning ?? 0,
    cacheRead: call.tokensCacheRead ?? 0,
    cacheWrite: call.tokensCacheWrite ?? 0,
  }
}

function providerJSON(row: ProviderReport) {
  return {
    ...row,
    models: row.models.map((model) => ({
      ...model,
      tokens: {
        ...model.tokens,
        total:
          model.tokens.input +
          model.tokens.output +
          model.tokens.reasoning +
          model.tokens.cacheRead +
          model.tokens.cacheWrite,
      },
    })),
  }
}

function inCallWindow(call: CallRow, since: number | null, until: number | null) {
  const at = callTime(call)
  return (since === null || at >= since) && (until === null || at < until)
}
function pivotIndexes(snapshot: WebSnapshot): PivotIndexes {
  return {
    titles: sessionTitles(snapshot.sessions),
    projects: new Map((snapshot.projects ?? []).map((project) => [project.id, project] as const)),
    projectBySession: new Map(
      (snapshot.sessionProjects ?? []).map((row) => [row.sessionID, row.projectID] as const),
    ),
  }
}

function pivotDimension(by: PivotBy, call: CallRow, indexes: PivotIndexes): { key: string; label: string } {
  if (by === "model") {
    if (call.providerID === null || call.modelID === null) return { key: "unknown", label: "unknown" }
    return { key: `${call.providerID}/${call.modelID}`, label: modelLabel(call.providerID, call.modelID) }
  }
  if (by === "agent") {
    const agent = call.agent?.trim()
    return agent === undefined || agent.length === 0
      ? { key: "unknown", label: "unknown" }
      : { key: agent, label: agent }
  }
  if (by === "session") {
    const title = indexes.titles.get(call.sessionID) ?? null
    const short = shortSession(call.sessionID)
    return {
      key: call.sessionID,
      label: title === null || title.trim().length === 0 ? short : `${short} ${singleLine(title, 80)}`,
    }
  }
  const projectID = indexes.projectBySession.get(call.sessionID)
  const project = projectID === undefined ? undefined : indexes.projects.get(projectID)
  if (project === undefined) return { key: "unknown", label: "unknown" }
  const name = project.name?.trim()
  const label = name !== undefined && name.length > 0 ? name : path.basename(project.worktree)
  return { key: project.id, label: label.length === 0 ? "unknown" : label }
}

function pivotValue(metric: PivotMetric, call: CallRow) {
  if (metric === "calls") return 1
  if (metric === "cost") return call.costUSD ?? 0
  return (
    (call.tokensInput ?? 0) +
    (call.tokensOutput ?? 0) +
    (call.tokensReasoning ?? 0) +
    (call.tokensCacheRead ?? 0) +
    (call.tokensCacheWrite ?? 0)
  )
}

function turnResponse(pathname: string, parameters: URLSearchParams, snapshot: WebSnapshot, now: number) {
  requireParameters(parameters, ["since", "includeInternal", "tz"])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "all", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const turnID = parseTurnID(pathname)
  const found = snapshot.turns.find((turn) => turn.turnID === turnID)
  if (found === undefined) throw new HttpError(404, "turn not found")
  const internal = internalSessionSet(snapshot.sessions)
  if (internal.has(found.sessionID) && !includeInternal) throw new HttpError(404, "turn not found")

  // The drill-down uses the same round rule as the overview and tables: a round
  // with no matching recorded call in the window is not shown.
  const matchingCalls = snapshot.calls.filter(
    (call) =>
      call.turnID === turnID &&
      (range.since === null || callTime(call) >= range.since) &&
      (includeInternal || !internal.has(call.sessionID)),
  )
  if (matchingCalls.length === 0) throw new HttpError(404, "turn not found")

  const titles = sessionTitles(snapshot.sessions)
  const summary = selectTurns(
    [found],
    matchingCalls,
    {
      since: null,
      limit: 1,
      session: null,
      status: null,
      errorsOnly: false,
      includeInternal: true,
      internalSessions: internal,
      titles,
    },
    now,
  ).rows[0]
  if (summary === undefined) throw new HttpError(404, "turn not found")

  const calls = matchingCalls
    .map((call) => ({ call, metrics: metrics(call), internal: internal.has(call.sessionID) }))
    .sort(
      (left, right) =>
        callTime(right.call) - callTime(left.call) || left.call.callID.localeCompare(right.call.callID),
    )

  return {
    range,
    tz,
    includeInternal,
    turn: turnJSON(summary),
    callTotal: calls.length,
    calls: calls.map((view) => callJSON(view, titles)),
  }
}

function sessionResponse(
  pathname: string,
  parameters: URLSearchParams,
  snapshot: WebSnapshot,
  now: number,
) {
  requireParameters(parameters, ["since", "includeInternal", "tz", "model"])
  const tz = parseTimezone(parameters)
  const range = parseRange(parameters, now, "all", tz)
  const includeInternal = parseIncludeInternal(parameters)
  const model = parseModel(parameters)
  const sessionID = parseSessionID(pathname)
  const internal = internalSessionSet(snapshot.sessions)
  const metadata = snapshot.sessions.find((session) => session.id === sessionID)
  // Hidden internal sessions stay invisible even when their id is known.
  if (metadata?.internal === true && !includeInternal) throw new HttpError(404, "session not found")

  const selected = selectRecordedCalls(
    snapshot.calls.filter((call) => call.sessionID === sessionID),
    range.since,
    null,
    internal,
    includeInternal,
    model,
  )
  const summary = aggregateRecordedSessions(selected.calls, snapshot.sessions)[0]
  if (summary === undefined) throw new HttpError(404, "session not found")

  const titles = sessionTitles(snapshot.sessions)
  const calls = [...selected.calls].sort(
    (left, right) => callTime(right) - callTime(left) || left.callID.localeCompare(right.callID),
  )
  const rounds = selectTurns(
    turnsForCalls(snapshot.turns, selected.calls),
    selected.calls,
    {
      since: null,
      limit: Number.MAX_SAFE_INTEGER,
      session: sessionID,
      status: null,
      errorsOnly: false,
      includeInternal: true,
      internalSessions: internal,
      titles,
    },
    now,
  ).rows

  return {
    range,
    tz,
    includeInternal,
    model,
    session: recordedSessionJSON(summary),
    callTotal: calls.length,
    calls: calls.map((call) => callJSON({ call, metrics: metrics(call), internal: summary.internal }, titles)),
    roundTotal: rounds.length,
    rounds: rounds.map(turnJSON),
  }
}

type RecordedSessionSummary = {
  readonly id: string
  readonly title: string | null
  readonly internal: boolean
  readonly updatedAt: number
  readonly calls: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  readonly costUSD: number
  readonly avgTTFT: number | null
  readonly avgTPS: number | null
}

// Sessions are the distinct sessions that have a matching recorded call. The
// authoritative row only contributes its title and internal-test marker; its
// cost, tokens, step count, and updated time never appear here.
function aggregateRecordedSessions(
  calls: readonly CallRow[],
  sessions: readonly SessionRecord[],
): readonly RecordedSessionSummary[] {
  const metadata = new Map(sessions.map((session) => [session.id, session] as const))
  const groups = new Map<string, CallRow[]>()
  for (const call of calls) {
    const group = groups.get(call.sessionID)
    if (group) group.push(call)
    else groups.set(call.sessionID, [call])
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      const recorded = metadata.get(id)
      return {
        id,
        title: recorded?.title ?? null,
        internal: recorded?.internal ?? false,
        updatedAt: group.map(callTime).reduce((latest, at) => Math.max(latest, at), 0),
        calls: group.length,
        tokensInput: sum(group.map((call) => call.tokensInput ?? 0)),
        tokensOutput: sum(group.map((call) => call.tokensOutput ?? 0)),
        tokensReasoning: sum(group.map((call) => call.tokensReasoning ?? 0)),
        tokensCacheRead: sum(group.map((call) => call.tokensCacheRead ?? 0)),
        tokensCacheWrite: sum(group.map((call) => call.tokensCacheWrite ?? 0)),
        costUSD: sum(group.map((call) => call.costUSD ?? 0)),
        avgTTFT: average(metricValues(group, "ttft")),
        avgTPS: average(metricValues(group, "tps")),
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

// Every window, internal-test, and model filter goes through this one path, so
// totals, sessions, rounds, series, pivot, and heatmap cannot disagree about
// which recorded calls they describe.
function selectRecordedCalls(
  calls: readonly CallRow[],
  since: number | null,
  until: number | null,
  internal: ReadonlySet<string>,
  includeInternal: boolean,
  model: string | null,
) {
  const matching = calls.filter((call) => {
    const at = callTime(call)
    if (since !== null && at < since) return false
    if (until !== null && at >= until) return false
    return model === null || matchesModel(call.providerID, call.modelID, model)
  })
  const visible = includeInternal ? matching : matching.filter((call) => !internal.has(call.sessionID))
  const excludedInternal = includeInternal
    ? 0
    : new Set(matching.filter((call) => internal.has(call.sessionID)).map((call) => call.sessionID)).size
  return { calls: visible, excludedInternal }
}

function turnsForCalls(turns: readonly TurnRecord[], calls: readonly CallRow[]) {
  const turnIDs = new Set(calls.flatMap((call) => (call.turnID === null ? [] : [call.turnID])))
  return turns.filter((turn) => turnIDs.has(turn.turnID))
}

type RecordedTotals = {
  readonly calls: number
  readonly sessions: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly total: number
  }
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  readonly costUSD: number
  readonly cacheHitRate: number | null
  readonly excludedInternal: number
}

function recordedTotals(calls: readonly CallRow[], excludedInternal: number): RecordedTotals {
  const input = sum(calls.map((call) => call.tokensInput ?? 0))
  const output = sum(calls.map((call) => call.tokensOutput ?? 0))
  const reasoning = sum(calls.map((call) => call.tokensReasoning ?? 0))
  const cacheRead = sum(calls.map((call) => call.tokensCacheRead ?? 0))
  const cacheWrite = sum(calls.map((call) => call.tokensCacheWrite ?? 0))
  return {
    calls: calls.length,
    sessions: new Set(calls.map((call) => call.sessionID)).size,
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
      cacheRead,
      cacheWrite,
      // The provider console's "total tokens" counts cache inside input, so the
      // cache read is part of the total rather than an extra bucket beside it.
      total: input + output + reasoning + cacheRead + cacheWrite,
    },
    // Flat aliases keep the response comparable with `cli.ts total --json`.
    tokensInput: input,
    tokensOutput: output,
    tokensReasoning: reasoning,
    tokensCacheRead: cacheRead,
    tokensCacheWrite: cacheWrite,
    costUSD: sum(calls.map((call) => call.costUSD ?? 0)),
    cacheHitRate: cacheRead + input === 0 ? null : cacheRead / (cacheRead + input),
    excludedInternal,
  }
}

type ModelRow = {
  readonly providerID: string | null
  readonly modelID: string | null
  readonly label: string
  readonly calls: number
  readonly sessions: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly costUSD: number
}

// The selector and the model breakdown share this list. It only contains models
// that have a recorded call in the window, so an internal-test-only model never
// reaches the client unless internal rows are explicitly included.
function aggregateRecordedModels(calls: readonly CallRow[]): readonly ModelRow[] {
  const groups = new Map<
    string,
    {
      providerID: string | null
      modelID: string | null
      calls: number
      sessions: Set<string>
      tokensInput: number
      tokensOutput: number
      tokensReasoning: number
      tokensCacheRead: number
      tokensCacheWrite: number
      costUSD: number
    }
  >()
  for (const call of calls) {
    const key = `${call.providerID ?? ""}\u0000${call.modelID ?? ""}`
    const group = groups.get(key) ?? {
      providerID: call.providerID,
      modelID: call.modelID,
      calls: 0,
      sessions: new Set<string>(),
      tokensInput: 0,
      tokensOutput: 0,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      costUSD: 0,
    }
    groups.set(key, group)
    group.calls += 1
    group.sessions.add(call.sessionID)
    group.tokensInput += call.tokensInput ?? 0
    group.tokensOutput += call.tokensOutput ?? 0
    group.tokensReasoning += call.tokensReasoning ?? 0
    group.tokensCacheRead += call.tokensCacheRead ?? 0
    group.tokensCacheWrite += call.tokensCacheWrite ?? 0
    group.costUSD += call.costUSD ?? 0
  }
  return [...groups.values()]
    .map((group) => ({
      providerID: group.providerID,
      modelID: group.modelID,
      label: modelLabel(group.providerID, group.modelID),
      calls: group.calls,
      sessions: group.sessions.size,
      tokens: {
        input: group.tokensInput,
        output: group.tokensOutput,
        reasoning: group.tokensReasoning,
        cache: { read: group.tokensCacheRead, write: group.tokensCacheWrite },
        cacheRead: group.tokensCacheRead,
        cacheWrite: group.tokensCacheWrite,
      },
      costUSD: group.costUSD,
    }))
    .sort(
      (left, right) =>
        right.costUSD - left.costUSD ||
        right.calls - left.calls ||
        left.label.localeCompare(right.label),
    )
}

type DayBucket = {
  readonly sessions: Set<string>
  costUSD: number
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  calls: number
  readonly ttfts: number[]
  readonly tpss: number[]
}

function buildSeries(
  calls: readonly CallRow[],
  since: number | null,
  now: number,
  tz: string,
  granularity: Granularity,
) {
  const times = calls.map(callTime)
  const axis = seriesAxis(since, earliest(times), latest(times), now, tz, granularity)

  const buckets = new Map<string, DayBucket>()
  const bucket = (key: string) => {
    const existing = buckets.get(key)
    if (existing) return existing
    const created: DayBucket = {
      sessions: new Set<string>(),
      costUSD: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensReasoning: 0,
      calls: 0,
      ttfts: [],
      tpss: [],
    }
    buckets.set(key, created)
    return created
  }

  for (const call of calls) {
    const at = bucketAt(axis, callTime(call))
    if (at === undefined) continue
    const day = bucket(at.key)
    day.sessions.add(call.sessionID)
    day.calls += 1
    day.costUSD += call.costUSD ?? 0
    day.tokensInput += call.tokensInput ?? 0
    day.tokensOutput += call.tokensOutput ?? 0
    day.tokensReasoning += call.tokensReasoning ?? 0
    const view = metrics(call)
    if (isNumber(view.ttft)) day.ttfts.push(view.ttft)
    if (isNumber(view.tps)) day.tpss.push(view.tps)
  }

  return axis.buckets.map((at) => {
    const current = buckets.get(at.key)
    if (current === undefined)
      return {
        day: at.key,
        label: at.label,
        sessions: 0,
        costUSD: 0,
        tokens: { input: 0, output: 0, reasoning: 0 },
        calls: 0,
        avgTTFT: null,
        p50TTFT: null,
        p95TTFT: null,
        avgTPS: null,
        p50TPS: null,
        p95TPS: null,
      }
    return {
      day: at.key,
      label: at.label,
      sessions: current.sessions.size,
      costUSD: current.costUSD,
      tokens: {
        input: current.tokensInput,
        output: current.tokensOutput,
        reasoning: current.tokensReasoning,
      },
      calls: current.calls,
      avgTTFT: average(current.ttfts),
      p50TTFT: percentile(current.ttfts, 0.5),
      p95TTFT: percentile(current.ttfts, 0.95),
      avgTPS: average(current.tpss),
      p50TPS: percentile(current.tpss, 0.5),
      p95TPS: percentile(current.tpss, 0.95),
    }
  })
}

type RoundDayBucket = {
  rounds: number
  readonly durations: number[]
  errors: number
  timeouts: number
  retries: number
  cost: number
}

// Round duration uses completed rounds only, matching the overview tile.
// Round cost comes from the matching call rows linked by turn_id, so the model
// filter changes the cost while the round's own duration stays unchanged.
function buildRoundSeries(
  turns: readonly TurnRecord[],
  calls: readonly CallRow[],
  since: number | null,
  now: number,
  tz: string,
  granularity: Granularity,
) {
  const costs = new Map<string, number>()
  for (const call of calls) {
    if (call.turnID === null) continue
    costs.set(call.turnID, (costs.get(call.turnID) ?? 0) + (call.costUSD ?? 0))
  }

  const axis = seriesAxis(
    since,
    earliest(turns.map((turn) => turn.startedAt)),
    latest(turns.map((turn) => turn.startedAt)),
    now,
    tz,
    granularity,
  )
  const buckets = new Map<string, RoundDayBucket>()
  for (const turn of turns) {
    const at = bucketAt(axis, turn.startedAt)
    if (at === undefined) continue
    const bucket = buckets.get(at.key) ?? {
      rounds: 0,
      durations: [],
      errors: 0,
      timeouts: 0,
      retries: 0,
      cost: 0,
    }
    buckets.set(at.key, bucket)
    bucket.rounds += 1
    if (turn.status === "completed") {
      const duration = turnRoundMs(turn)
      if (isNumber(duration)) bucket.durations.push(duration)
    }
    if (turn.status === "failed" || turn.status === "interrupted") bucket.errors += 1
    if (isTimeoutTurn(turn)) bucket.timeouts += 1
    bucket.retries += turn.retries
    bucket.cost += costs.get(turn.turnID) ?? 0
  }

  return axis.buckets.map((at) => {
    const bucket = buckets.get(at.key)
    if (bucket === undefined)
      return {
        date: at.key,
        label: at.label,
        rounds: 0,
        roundMsP50: null,
        roundMsP95: null,
        roundMsAvg: null,
        errors: 0,
        timeouts: 0,
        retries: 0,
        cost: 0,
      }
    return {
      date: at.key,
      label: at.label,
      rounds: bucket.rounds,
      roundMsP50: percentile(bucket.durations, 0.5),
      roundMsP95: percentile(bucket.durations, 0.95),
      roundMsAvg: average(bucket.durations),
      errors: bucket.errors,
      timeouts: bucket.timeouts,
      retries: bucket.retries,
      cost: bucket.cost,
    }
  })
}

// Error days use the error event time, matching `errors` grouping. The series
// keeps call and round sources separate so the chart can stack them.
function buildErrorSeries(
  calls: readonly CallRow[],
  turns: readonly TurnRecord[],
  since: number | null,
  now: number,
  tz: string,
  granularity: Granularity,
) {
  const callErrors = calls.filter(
    (call) =>
      (call.status === "failed" || call.status === "interrupted") &&
      (since === null || (call.endedAt ?? call.recordedAt) >= since),
  )
  const turnErrors = turns.filter(
    (turn) =>
      (turn.status === "failed" || turn.status === "interrupted") &&
      (since === null || (turn.endedAt ?? turn.updatedAt) >= since),
  )
  const times = [
    ...callErrors.map((call) => call.endedAt ?? call.recordedAt),
    ...turnErrors.map((turn) => turn.endedAt ?? turn.updatedAt),
  ]
  const axis = seriesAxis(since, earliest(times), latest(times), now, tz, granularity)
  const buckets = new Map<string, { call: number; turn: number }>()
  const bucket = (key: string) => {
    const existing = buckets.get(key)
    if (existing) return existing
    const created = { call: 0, turn: 0 }
    buckets.set(key, created)
    return created
  }

  for (const call of callErrors) {
    const at = bucketAt(axis, call.endedAt ?? call.recordedAt)
    if (at !== undefined) bucket(at.key).call += 1
  }
  for (const turn of turnErrors) {
    const at = bucketAt(axis, turn.endedAt ?? turn.updatedAt)
    if (at !== undefined) bucket(at.key).turn += 1
  }

  return axis.buckets.map((at) => ({
    date: at.key,
    label: at.label,
    call: buckets.get(at.key)?.call ?? 0,
    turn: buckets.get(at.key)?.turn ?? 0,
  }))
}

// The axis provides the continuous bucket starts; data only fills the buckets
// that actually contain events.
function bucketAt(axis: BucketAxis, ms: number) {
  const index = axis.indexOf(ms)
  return index === -1 ? undefined : axis.buckets[index]
}

function parseRange(
  parameters: URLSearchParams,
  now: number,
  fallback: "all" | "30d" | "7d",
  zone: string,
): Range {
  if (!parameters.has("since")) {
    if (fallback === "30d") return { since: now - THIRTY_DAYS, label: "30d" }
    if (fallback === "7d") return { since: now - SEVEN_DAYS, label: "7d" }
    return { since: null, label: "all" }
  }
  const raw = (parameters.get("since") ?? "").trim()
  if (raw === "all") return { since: null, label: "all" }
  const absolute = parseAbsoluteDate(raw, zone)
  if (absolute !== undefined) {
    if (absolute === null) throw invalidSince()
    return { since: absolute, label: raw }
  }
  const parsed = parseSince(raw, now)
  if (!parsed.ok) throw invalidSince()
  return { since: parsed.since, label: raw }
}

function invalidSince() {
  return new HttpError(
    400,
    'invalid parameter "since": expected 24h, 7d, 30d, 90d, all, or YYYY-MM-DD',
    "since",
  )
}

// An absent `until` means no upper bound. A date-only value resolves to that
// zone's midnight and is exclusive, so `until=2026-10-02` includes all of Oct 1.
function parseUntil(parameters: URLSearchParams, now: number, zone: string): number | null {
  const raw = parameters.get("until")
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed === "all") return null
  const absolute = parseAbsoluteDate(trimmed, zone)
  if (absolute !== undefined) {
    if (absolute === null) throw invalidUntil()
    return absolute
  }
  const parsed = parseSince(trimmed, now)
  if (!parsed.ok) throw invalidUntil()
  return parsed.since
}

function invalidUntil() {
  return new HttpError(
    400,
    'invalid parameter "until": expected 24h, 7d, 30d, 90d, all, or YYYY-MM-DD',
    "until",
  )
}

// `undefined` means the value is not date-shaped; `null` means it looked like a
// date but is not a real calendar date in that zone.
function parseAbsoluteDate(raw: string, zone: string): number | null | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined
  const at = DateTime.fromISO(raw, { zone })
  if (!at.isValid || at.toISODate() !== raw) return null
  return at.startOf("day").toMillis()
}

function parseTimezone(parameters: URLSearchParams) {
  const raw = parameters.get("tz")
  if (raw === null) return "UTC"
  const zone = raw.trim()
  if (zone.length === 0 || !isValidTimeZone(zone))
    throw new HttpError(400, 'invalid parameter "tz": expected an IANA time zone name', "tz")
  return zone
}

function parseGranularity(parameters: URLSearchParams): Granularity {
  return parseChoice(parameters, "granularity", GRANULARITIES, "day")
}

function parseChoice<T extends string>(
  parameters: URLSearchParams,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = parameters.get(name)
  if (raw === null) return fallback
  const match = allowed.find((value) => value === raw)
  if (match === undefined)
    throw new HttpError(400, `invalid parameter "${name}": expected one of ${allowed.join(", ")}`, name)
  return match
}

function parseBoolean(parameters: URLSearchParams, name: string, fallback: boolean) {
  const raw = parameters.get(name)
  if (raw === null) return fallback
  if (raw === "true" || raw === "1" || raw === "") return true
  if (raw === "false" || raw === "0") return false
  throw new HttpError(400, `invalid parameter "${name}": expected true or false`, name)
}

function parseIncludeInternal(parameters: URLSearchParams) {
  return parseBoolean(parameters, "includeInternal", false)
}

// The model parameter is always `providerID/modelID`. A bare model id cannot
// identify a provider, so reject it instead of silently matching nothing.
function parseModel(parameters: URLSearchParams): string | null {
  const raw = parameters.get("model")
  if (raw === null) return null
  const model = raw.trim()
  if (model.length === 0) return null
  if (!model.includes("/"))
    throw new HttpError(400, 'invalid parameter "model": expected provider/model', "model")
  return model
}

function parseInteger(
  parameters: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = parameters.get(name)
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw))
    throw new HttpError(
      400,
      `invalid parameter "${name}": expected an integer between ${minimum} and ${maximum}`,
      name,
    )
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new HttpError(
      400,
      `invalid parameter "${name}": expected an integer between ${minimum} and ${maximum}`,
      name,
    )
  return value
}

function parseNumber(parameters: URLSearchParams, name: string): number | null {
  const raw = parameters.get(name)
  if (raw === null) return null
  if (!/^\d+(\.\d+)?$/.test(raw))
    throw new HttpError(
      400,
      `invalid parameter "${name}": expected a non-negative number of milliseconds`,
      name,
    )
  const value = Number(raw)
  if (!Number.isFinite(value))
    throw new HttpError(
      400,
      `invalid parameter "${name}": expected a non-negative number of milliseconds`,
      name,
    )
  return value
}

function parseSort<T extends string>(
  parameters: URLSearchParams,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = parameters.get("sort")
  if (raw === null) return fallback
  const match = allowed.find((value) => value === raw)
  if (match === undefined)
    throw new HttpError(400, `invalid parameter "sort": expected one of ${allowed.join(", ")}`, "sort")
  return match
}

function parseDirection(parameters: URLSearchParams): Direction {
  const raw = parameters.get("dir")
  if (raw === null) return "desc"
  if (raw === "asc" || raw === "desc") return raw
  throw new HttpError(400, 'invalid parameter "dir": expected asc or desc', "dir")
}

function parseStatus(parameters: URLSearchParams): CallStatus | null {
  const raw = parameters.get("status")
  if (raw === null) return null
  const match = CALL_STATUSES.find((value) => value === raw)
  if (match === undefined)
    throw new HttpError(
      400,
      `invalid parameter "status": expected one of ${CALL_STATUSES.join(", ")}`,
      "status",
    )
  return match
}

function parseTurnStatus(parameters: URLSearchParams): TurnDisplayStatus | null {
  const raw = parameters.get("status")
  if (raw === null) return null
  if (!isTurnDisplayStatus(raw))
    throw new HttpError(
      400,
      'invalid parameter "status": expected one of running, stale, completed, failed, interrupted',
      "status",
    )
  return raw
}

function parseErrorSource(parameters: URLSearchParams): ErrorSource {
  const raw = parameters.get("source")
  if (raw === null) return "all"
  const match = ERROR_SOURCES.find((value) => value === raw)
  if (match === undefined)
    throw new HttpError(400, 'invalid parameter "source": expected one of call, turn, all', "source")
  return match
}

function parseSessionID(pathname: string) {
  const raw = pathname.slice("/api/session/".length)
  let sessionID: string
  try {
    sessionID = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'invalid parameter "session": malformed session id', "session")
  }
  if (sessionID.length === 0 || sessionID.includes("/")) throw new HttpError(404, "session not found")
  return sessionID
}

function parseTurnID(pathname: string) {
  const raw = pathname.slice("/api/turn/".length)
  let turnID: string
  try {
    turnID = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'invalid parameter "turn": malformed turn id', "turn")
  }
  if (turnID.length === 0 || turnID.includes("/")) throw new HttpError(404, "turn not found")
  return turnID
}

function requireParameters(parameters: URLSearchParams, allowed: readonly string[]) {
  for (const key of parameters.keys())
    if (!allowed.includes(key)) throw new HttpError(400, `unknown parameter "${key}"`, key)
}

function internalSessionSet(sessions: readonly SessionRecord[]) {
  return new Set(sessions.filter((session) => session.internal).map((session) => session.id))
}

function sessionTitles(sessions: readonly SessionRecord[]): ReadonlyMap<string, string | null> {
  return new Map(sessions.map((session) => [session.id, session.title] as const))
}

function matchesModel(providerID: string | null, modelID: string | null, filter: string) {
  return providerID !== null && modelID !== null && `${providerID}/${modelID}` === filter
}

function matchesStatus(call: CallRow, status: CallStatus | null) {
  if (status === null) return true
  if (status === "compaction") return call.kind === "compaction"
  return call.kind === "step" && call.status === status
}

function sessionSortValue(row: RecordedSessionSummary, sort: SessionSort): number | null {
  if (sort === "updated") return row.updatedAt
  if (sort === "cost") return row.costUSD
  if (sort === "tokens") return row.tokensInput + row.tokensOutput + row.tokensReasoning
  if (sort === "ttft") return row.avgTTFT
  return row.avgTPS
}

function callSortValue(view: CallView, sort: CallSort): number | null {
  if (sort === "started") return callTime(view.call)
  if (sort === "cost") return view.call.costUSD
  if (sort === "ttft") return isNumber(view.metrics.ttft) ? view.metrics.ttft : null
  return isNumber(view.metrics.tps) ? view.metrics.tps : null
}

function turnSortValue(row: TurnSummary, sort: TurnSort): number | null {
  if (sort === "started") return row.startedAt
  if (sort === "round") return row.roundMs
  if (sort === "cost") return row.costUSD
  return row.calls
}

// Missing values sort last in both directions, which keeps blank latency cells
// out of the way instead of pretending they are zero.
function compareNullable(left: number | null, right: number | null, direction: Direction) {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  const order = left - right
  if (order === 0) return 0
  return direction === "asc" ? order : -order
}

function recordedSessionJSON(row: RecordedSessionSummary) {
  return {
    sessionID: row.id,
    session: shortSession(row.id),
    title: row.title,
    internal: row.internal,
    updatedAt: row.updatedAt,
    calls: row.calls,
    tokens: {
      input: row.tokensInput,
      output: row.tokensOutput,
      reasoning: row.tokensReasoning,
      cache: { read: row.tokensCacheRead, write: row.tokensCacheWrite },
      cacheRead: row.tokensCacheRead,
      cacheWrite: row.tokensCacheWrite,
    },
    costUSD: row.costUSD,
    avgTTFT: row.avgTTFT,
    avgTPS: row.avgTPS,
  }
}

function turnJSON(row: TurnSummary) {
  return {
    turnID: row.turnID,
    sessionID: row.sessionID,
    session: shortSession(row.sessionID),
    title: row.title,
    status: row.status,
    internal: row.internal,
    timeout: row.timeout,
    queuedAt: row.queuedAt,
    acceptedAt: row.acceptedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    queueMs: row.queueMs,
    roundMs: row.roundMs,
    firstTokenMs: row.firstTokenMs,
    prompts: row.prompts,
    steers: row.steers,
    compactions: row.compactions,
    retries: row.retries,
    calls: row.calls,
    costUSD: row.costUSD,
    tokens: {
      input: row.tokensInput,
      output: row.tokensOutput,
      reasoning: row.tokensReasoning,
      cache: { read: row.tokensCacheRead, write: row.tokensCacheWrite },
      cacheRead: row.tokensCacheRead,
      cacheWrite: row.tokensCacheWrite,
    },
    interruptReason: row.interruptReason,
    errorType: row.errorType,
    errorMessage: row.errorMessage,
    errorStatus: row.errorStatus,
  }
}

function callJSON(view: CallView, titles: ReadonlyMap<string, string | null>) {
  const call = view.call
  const measured = view.metrics
  return {
    callID: call.callID,
    sessionID: call.sessionID,
    session: shortSession(call.sessionID),
    sessionTitle: titles.get(call.sessionID) ?? null,
    internal: view.internal,
    kind: call.kind,
    status: call.status,
    turnID: call.turnID,
    startedAt: call.startedAt,
    firstTokenAt: call.firstTokenAt,
    firstTextAt: call.firstTextAt,
    streamedAt: call.streamedAt,
    endedAt: call.endedAt,
    providerID: call.providerID,
    modelID: call.modelID,
    modelVariant: call.modelVariant,
    model: modelLabel(call.providerID, call.modelID),
    agent: call.agent,
    tokens: {
      input: call.tokensInput,
      output: call.tokensOutput,
      reasoning: call.tokensReasoning,
      cache: { read: call.tokensCacheRead, write: call.tokensCacheWrite },
      cacheRead: call.tokensCacheRead,
      cacheWrite: call.tokensCacheWrite,
    },
    costUSD: call.costUSD,
    ttft: isNumber(measured.ttft) ? measured.ttft : null,
    ttfa: isNumber(measured.ttfa) ? measured.ttfa : null,
    tps: isNumber(measured.tps) ? measured.tps : null,
    e2e: isNumber(measured.e2e) ? measured.e2e : null,
    retries: call.retries,
    errorType: call.errorType ?? call.lastRetryErrorType,
    errorMessage: call.errorMessage,
    errorStatus: call.errorStatus,
    finish: call.finish,
    error: call.error,
  }
}

function metricValues(calls: readonly CallRow[], key: "ttft" | "tps") {
  return calls.map((call) => metrics(call)[key]).filter(isNumber)
}

function isNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 1) return sorted[0] ?? null
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const low = sorted[lower]
  const high = sorted[upper]
  if (low === undefined || high === undefined) return null
  if (lower === upper) return low
  return low + (high - low) * (position - lower)
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function earliest(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((lowest, value) => Math.min(lowest, value), Number.POSITIVE_INFINITY)
}

function latest(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((highest, value) => Math.max(highest, value), Number.NEGATIVE_INFINITY)
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0)
}
