import { metrics, type CallMetrics, type CallRow, type TurnStatus } from "./reducer"

// A window filter carried into every table and the JSON envelope.
export type Range = {
  readonly since: number | null
  readonly label: string
}

export type SinceParse = { readonly ok: true; readonly since: number } | { readonly ok: false; readonly message: string }

// Parse `7d`, `24h`, `30m`, or a local `YYYY-MM-DD` date. Invalid input never reaches the query layer.
export function parseSince(input: string, now: number): SinceParse {
  const relative = /^(\d+)([dhm])$/.exec(input)
  if (relative) {
    const amount = Number(relative[1])
    if (!Number.isSafeInteger(amount)) return { ok: false, message: `invalid --since value: ${input}` }
    const unit = relative[2] === "d" ? 86_400_000 : relative[2] === "h" ? 3_600_000 : 60_000
    return { ok: true, since: now - amount * unit }
  }

  const absolute = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (!absolute) return { ok: false, message: `invalid --since value: ${input} (expected 7d, 24h, 30m, or YYYY-MM-DD)` }
  const year = Number(absolute[1])
  const month = Number(absolute[2])
  const day = Number(absolute[3])
  const date = new Date(year, month - 1, day)
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    return { ok: false, message: `invalid --since date: ${input}` }
  return { ok: true, since: date.getTime() }
}

// Local midnight at the start of the date containing `ms`.
export function localDay(ms: number) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function callTime(call: CallRow) {
  return call.startedAt ?? call.endedAt ?? call.recordedAt
}

// A session id matches its full value, either prefix form, or a bare prefix without `ses_`.
export function sessionMatches(sessionID: string, filter: string) {
  return sessionID === filter || sessionID.startsWith(filter) || sessionID.startsWith(`ses_${filter}`)
}

export type CallView = {
  readonly call: CallRow
  readonly metrics: CallMetrics
  readonly internal: boolean
}

export type CallSelection = {
  readonly since: number | null
  readonly session: string | null
  readonly limit: number
  readonly internalSessions?: ReadonlySet<string>
  readonly includeInternal?: boolean
}

export type CallSelectionResult = {
  readonly rows: readonly CallView[]
  readonly excludedInternal: number
}

// Newest first. Compactions sort by their end time because they have no start time.
export function selectCalls(calls: readonly CallRow[], selection: CallSelection): CallSelectionResult {
  const matching = calls
    .filter((call) => selection.since === null || callTime(call) >= selection.since)
    .filter((call) => selection.session === null || sessionMatches(call.sessionID, selection.session))
  const internal = (call: CallRow) => selection.internalSessions?.has(call.sessionID) ?? false
  const visible = selection.includeInternal ? matching : matching.filter((call) => !internal(call))
  const excludedInternal = selection.includeInternal ? 0 : matching.filter(internal).length
  const rows = visible
    .sort((left, right) => callTime(right) - callTime(left) || left.callID.localeCompare(right.callID))
    .slice(0, selection.limit)
    .map((call) => ({ call, metrics: metrics(call), internal: internal(call) }))
  return { rows, excludedInternal }
}

export type TurnRecord = {
  readonly turnID: string
  readonly sessionID: string
  readonly directory: string | null
  readonly queuedAt: number | null
  readonly acceptedAt: number | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly status: TurnStatus
  readonly interruptReason: string | null
  readonly errorType: string | null
  readonly errorMessage: string | null
  readonly errorStatus: number | null
  readonly prompts: number
  readonly compactions: number
  readonly steers: number
  readonly retries: number
  readonly firstTokenAt: number | null
  readonly recordedAt: number
  readonly updatedAt: number
}

export const TURN_STATUSES = ["running", "stale", "completed", "failed", "interrupted"] as const
export type TurnDisplayStatus = (typeof TURN_STATUSES)[number]

export function isTurnDisplayStatus(value: string): value is TurnDisplayStatus {
  return TURN_STATUSES.some((status) => status === value)
}

export const STALE_TURN_MS = 60 * 60 * 1_000

// A running round becomes stale only when its last write is more than one hour old.
export function turnStatus(turn: TurnRecord, now: number): TurnDisplayStatus {
  return turn.status === "running" && now - turn.updatedAt > STALE_TURN_MS ? "stale" : turn.status
}

// Queue wait is unavailable when the round had no enqueue before execution.
export function turnQueueMs(turn: TurnRecord) {
  return turn.queuedAt === null ? null : turn.startedAt - turn.queuedAt
}

// Running rounds have no end, so their round duration is unavailable.
export function turnRoundMs(turn: TurnRecord) {
  return turn.endedAt === null ? null : turn.endedAt - (turn.acceptedAt ?? turn.startedAt)
}

export function turnFirstTokenMs(turn: TurnRecord) {
  return turn.firstTokenAt === null ? null : turn.firstTokenAt - turn.startedAt
}

// A provider timeout is recorded on the call/round; inactivity interruption is
// the round-level timeout form.
export function isTimeoutTurn(turn: TurnRecord) {
  return (
    turn.errorType === "provider.timeout" || (turn.status === "interrupted" && turn.interruptReason === "inactivity")
  )
}

// Rounds group inactivity interruptions under the timeout type. Their raw
// error_type remains NULL, which is what JSON's errorType reports.
export function turnErrorType(turn: TurnRecord) {
  if (turn.errorType !== null) return turn.errorType
  return isTimeoutTurn(turn) ? "provider.timeout" : null
}

export function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

export type TurnSummary = {
  readonly turnID: string
  readonly sessionID: string
  readonly title: string | null
  readonly internal: boolean
  readonly status: TurnDisplayStatus
  readonly timeout: boolean
  readonly queuedAt: number | null
  readonly acceptedAt: number | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly queueMs: number | null
  readonly roundMs: number | null
  readonly firstTokenMs: number | null
  readonly prompts: number
  readonly steers: number
  readonly compactions: number
  readonly retries: number
  readonly calls: number
  readonly costUSD: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  readonly interruptReason: string | null
  readonly errorType: string | null
  readonly errorMessage: string | null
  readonly errorStatus: number | null
}

export type TurnSelection = {
  readonly since: number | null
  readonly limit: number
  readonly session: string | null
  readonly status: TurnDisplayStatus | null
  readonly errorsOnly: boolean
  readonly includeInternal: boolean
  readonly internalSessions: ReadonlySet<string>
  readonly titles?: ReadonlyMap<string, string | null>
}

export type TurnSelectionResult = {
  readonly rows: readonly TurnSummary[]
  readonly excludedInternal: number
}

type TurnCallStats = {
  calls: number
  costUSD: number
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  tokensCacheWrite: number
}

export function selectTurns(
  turns: readonly TurnRecord[],
  calls: readonly CallRow[],
  selection: TurnSelection,
  now: number,
): TurnSelectionResult {
  const stats = new Map<string, TurnCallStats>()
  for (const call of calls) {
    if (call.turnID === null) continue
    const existing = stats.get(call.turnID) ?? {
      calls: 0,
      costUSD: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
    }
    stats.set(call.turnID, existing)
    existing.calls += 1
    existing.costUSD += call.costUSD ?? 0
    existing.tokensInput += call.tokensInput ?? 0
    existing.tokensOutput += call.tokensOutput ?? 0
    existing.tokensReasoning += call.tokensReasoning ?? 0
    existing.tokensCacheRead += call.tokensCacheRead ?? 0
    existing.tokensCacheWrite += call.tokensCacheWrite ?? 0
  }

  const matching = turns
    .filter((turn) => selection.since === null || turn.startedAt >= selection.since)
    .filter((turn) => selection.session === null || sessionMatches(turn.sessionID, selection.session))
  const internal = (turn: TurnRecord) => selection.internalSessions.has(turn.sessionID)
  const visible = selection.includeInternal ? matching : matching.filter((turn) => !internal(turn))
  const excludedInternal = selection.includeInternal ? 0 : matching.filter(internal).length
  const rows = visible
    .map((turn) => ({ turn, status: turnStatus(turn, now) }))
    .filter(({ status }) => selection.status === null || status === selection.status)
    .filter(({ status }) => !selection.errorsOnly || status !== "completed")
    .sort(
      (left, right) => right.turn.startedAt - left.turn.startedAt || left.turn.turnID.localeCompare(right.turn.turnID),
    )
    .slice(0, selection.limit)
    .map(({ turn, status }) => {
      const callStats = stats.get(turn.turnID)
      return {
        turnID: turn.turnID,
        sessionID: turn.sessionID,
        title: selection.titles?.get(turn.sessionID) ?? null,
        internal: internal(turn),
        status,
        timeout: isTimeoutTurn(turn),
        queuedAt: turn.queuedAt,
        acceptedAt: turn.acceptedAt,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        queueMs: turnQueueMs(turn),
        roundMs: turnRoundMs(turn),
        firstTokenMs: turnFirstTokenMs(turn),
        prompts: turn.prompts,
        steers: turn.steers,
        compactions: turn.compactions,
        retries: turn.retries,
        calls: callStats?.calls ?? 0,
        costUSD: callStats?.costUSD ?? 0,
        tokensInput: callStats?.tokensInput ?? 0,
        tokensOutput: callStats?.tokensOutput ?? 0,
        tokensReasoning: callStats?.tokensReasoning ?? 0,
        tokensCacheRead: callStats?.tokensCacheRead ?? 0,
        tokensCacheWrite: callStats?.tokensCacheWrite ?? 0,
        interruptReason: turn.interruptReason,
        errorType: turn.errorType,
        errorMessage: turn.errorMessage,
        errorStatus: turn.errorStatus,
      }
    })
  return { rows, excludedInternal }
}

export type ErrorSource = "call" | "turn"
export type ErrorSourceSelection = "both" | "calls" | "turns"

export type ErrorGroup = {
  readonly errorType: string | null
  readonly source: ErrorSource
  readonly count: number
  readonly sessions: number
  readonly firstAt: number
  readonly lastAt: number
  readonly lastMessage: string | null
}

type ErrorOccurrence = {
  readonly errorType: string | null
  readonly source: ErrorSource
  readonly sessionID: string
  readonly at: number
  readonly message: string | null
}

type ErrorAccumulator = {
  readonly errorType: string | null
  readonly source: ErrorSource
  count: number
  readonly sessions: Set<string>
  firstAt: number
  lastAt: number
  lastMessage: string | null
  lastMessageAt: number
}

// Failed and interrupted calls/rounds are grouped per source so JSON can name
// exactly where each error came from. Inactivity interruptions group as the
// round-level provider.timeout form.
export function groupErrors(options: {
  readonly calls: readonly CallRow[]
  readonly turns: readonly TurnRecord[]
  readonly since: number | null
  readonly internalSessions: ReadonlySet<string>
  readonly includeInternal: boolean
  readonly sources: ErrorSourceSelection
}): readonly ErrorGroup[] {
  const occurrences: ErrorOccurrence[] = []
  if (options.sources === "both" || options.sources === "calls")
    for (const call of options.calls) {
      if (call.status !== "failed" && call.status !== "interrupted") continue
      if (options.since !== null && (call.endedAt ?? call.recordedAt) < options.since) continue
      if (!options.includeInternal && options.internalSessions.has(call.sessionID)) continue
      occurrences.push({
        errorType: call.errorType,
        source: "call",
        sessionID: call.sessionID,
        at: call.endedAt ?? call.recordedAt,
        message: call.errorMessage ?? call.error,
      })
    }
  if (options.sources === "both" || options.sources === "turns")
    for (const turn of options.turns) {
      if (turn.status !== "failed" && turn.status !== "interrupted") continue
      if (options.since !== null && (turn.endedAt ?? turn.updatedAt) < options.since) continue
      if (!options.includeInternal && options.internalSessions.has(turn.sessionID)) continue
      occurrences.push({
        errorType: turnErrorType(turn),
        source: "turn",
        sessionID: turn.sessionID,
        at: turn.endedAt ?? turn.updatedAt,
        message: turn.errorMessage,
      })
    }

  const groups = new Map<string, ErrorAccumulator>()
  for (const occurrence of occurrences) {
    const key = `${occurrence.source}\u0000${occurrence.errorType ?? ""}`
    const existing = groups.get(key)
    const group =
      existing ?? {
        errorType: occurrence.errorType,
        source: occurrence.source,
        count: 0,
        sessions: new Set<string>(),
        firstAt: occurrence.at,
        lastAt: occurrence.at,
        lastMessage: null,
        lastMessageAt: Number.NEGATIVE_INFINITY,
      }
    if (!existing) groups.set(key, group)
    group.count += 1
    group.sessions.add(occurrence.sessionID)
    group.firstAt = Math.min(group.firstAt, occurrence.at)
    group.lastAt = Math.max(group.lastAt, occurrence.at)
    if (occurrence.message !== null && occurrence.at >= group.lastMessageAt) {
      group.lastMessage = occurrence.message
      group.lastMessageAt = occurrence.at
    }
  }

  return [...groups.values()]
    .map((group) => ({
      errorType: group.errorType,
      source: group.source,
      count: group.count,
      sessions: group.sessions.size,
      firstAt: group.firstAt,
      lastAt: group.lastAt,
      lastMessage: group.lastMessage,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        (left.errorType ?? "\uffff").localeCompare(right.errorType ?? "\uffff") ||
        left.source.localeCompare(right.source),
    )
}

export type SessionRecord = {
  readonly id: string
  readonly title: string | null
  readonly internal: boolean
  readonly costUSD: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  readonly timeCreated: number
  readonly timeUpdated: number
}

export type MessageRecord = {
  readonly id: string
  readonly sessionID: string
  readonly type: string
  readonly timeCreated: number
  readonly costUSD: number | null
  readonly tokensInput: number | null
  readonly tokensOutput: number | null
  readonly tokensReasoning: number | null
  readonly tokensCacheRead: number | null
  readonly tokensCacheWrite: number | null
  readonly providerID: string | null
  readonly modelID: string | null
}

export type SessionSummary = {
  readonly id: string
  readonly title: string | null
  readonly internal: boolean
  readonly updatedAt: number
  readonly steps: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  readonly costUSD: number
  readonly recordedCalls: number
  readonly avgTTFT: number | null
  readonly avgTPS: number | null
  readonly roundP50Ms: number | null
  readonly failedRounds: number
}

// Counts the windowed sessions hidden by the default view. With
// --include-internal the view hides nothing, so the count is zero.
export function countExcludedInternalSessions(
  sessions: readonly SessionRecord[],
  since: number | null,
  includeInternal: boolean,
) {
  if (includeInternal) return 0
  return sessions.filter((session) => (since === null || session.timeUpdated >= since) && session.internal).length
}

// Sessions are selected by `time_updated`, then carry their lifetime authoritative
// totals. Sidecar enrichment uses every recorded call for that session, so a
// session outside the sidecar's coverage keeps `null` latency rather than `0`.
export function aggregateSessions(
  sessions: readonly SessionRecord[],
  messages: readonly MessageRecord[],
  calls: readonly CallRow[],
  since: number | null,
  includeInternal = false,
  turns: readonly TurnRecord[] = [],
): readonly SessionSummary[] {
  const steps = new Map<string, number>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    steps.set(message.sessionID, (steps.get(message.sessionID) ?? 0) + 1)
  }

  const callsBySession = new Map<string, CallRow[]>()
  for (const call of calls) {
    const existing = callsBySession.get(call.sessionID)
    if (existing) existing.push(call)
    else callsBySession.set(call.sessionID, [call])
  }

  const turnsBySession = new Map<string, TurnRecord[]>()
  for (const turn of turns) {
    const existing = turnsBySession.get(turn.sessionID)
    if (existing) existing.push(turn)
    else turnsBySession.set(turn.sessionID, [turn])
  }

  return sessions
    .filter((session) => since === null || session.timeUpdated >= since)
    .filter((session) => includeInternal || !session.internal)
    .map((session) => {
      const recorded = callsBySession.get(session.id) ?? []
      const views = recorded.map((call) => metrics(call))
      const sessionTurns = turnsBySession.get(session.id) ?? []
      const completedRounds = sessionTurns
        .filter((turn) => turn.status === "completed")
        .map((turn) => turnRoundMs(turn))
        .filter((round): round is number => round !== null && Number.isFinite(round))
      return {
        id: session.id,
        title: session.title,
        internal: session.internal,
        updatedAt: session.timeUpdated,
        steps: steps.get(session.id) ?? 0,
        tokensInput: session.tokensInput,
        tokensOutput: session.tokensOutput,
        tokensReasoning: session.tokensReasoning,
        tokensCacheRead: session.tokensCacheRead,
        tokensCacheWrite: session.tokensCacheWrite,
        costUSD: session.costUSD,
        recordedCalls: recorded.length,
        avgTTFT: averageMetric(views, "ttft"),
        avgTPS: averageMetric(views, "tps"),
        roundP50Ms: percentile(completedRounds, 0.5),
        failedRounds: sessionTurns.filter((turn) => turn.status === "failed" || turn.status === "interrupted")
          .length,
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

export type SessionsTotals = {
  readonly sessions: number
  readonly steps: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  readonly costUSD: number
  readonly recordedCalls: number
  readonly avgTTFT: number | null
  readonly avgTPS: number | null
  readonly excludedInternal: number
}

// The summary covers every selected session, not just the displayed `--limit` slice.
export function sessionTotals(
  rows: readonly SessionSummary[],
  calls: readonly CallRow[],
  excludedInternal = 0,
): SessionsTotals {
  const ids = new Set(rows.map((row) => row.id))
  const views = calls.filter((call) => ids.has(call.sessionID)).map((call) => metrics(call))
  return {
    sessions: rows.length,
    steps: sum(rows.map((row) => row.steps)),
    tokensInput: sum(rows.map((row) => row.tokensInput)),
    tokensOutput: sum(rows.map((row) => row.tokensOutput)),
    tokensReasoning: sum(rows.map((row) => row.tokensReasoning)),
    tokensCacheRead: sum(rows.map((row) => row.tokensCacheRead)),
    tokensCacheWrite: sum(rows.map((row) => row.tokensCacheWrite)),
    costUSD: sum(rows.map((row) => row.costUSD)),
    recordedCalls: sum(rows.map((row) => row.recordedCalls)),
    avgTTFT: averageMetric(views, "ttft"),
    avgTPS: averageMetric(views, "tps"),
    excludedInternal,
  }
}

export type ModelSummary = {
  readonly providerID: string | null
  readonly modelID: string | null
  readonly internal: boolean
  readonly calls: number
  readonly sessions: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  readonly costUSD: number
  readonly avgTTFT: number | null
  readonly avgTPS: number | null
}

type ModelAccumulator = {
  readonly providerID: string | null
  readonly modelID: string | null
  allInternal: boolean
  calls: number
  readonly sessions: Set<string>
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  tokensCacheWrite: number
  costUSD: number
}

function modelKey(providerID: string | null, modelID: string | null) {
  return `${providerID ?? ""}\u0000${modelID ?? ""}`
}

// Assistant message rows are one step each, so `calls` here means completed steps, not attempts.
// A model row is internal only when every contributing session is internal; mixed usage stays real.
export function aggregateModels(
  messages: readonly MessageRecord[],
  calls: readonly CallRow[],
  since: number | null,
  internalSessions: ReadonlySet<string> = new Set(),
  includeInternal = false,
): readonly ModelSummary[] {
  const accumulators = new Map<string, ModelAccumulator>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    if (since !== null && message.timeCreated < since) continue
    const internal = internalSessions.has(message.sessionID)
    if (!includeInternal && internal) continue
    const key = modelKey(message.providerID, message.modelID)
    const existing = accumulators.get(key)
    const accumulator =
      existing ??
      {
        providerID: message.providerID,
        modelID: message.modelID,
        allInternal: true,
        calls: 0,
        sessions: new Set<string>(),
        tokensInput: 0,
        tokensOutput: 0,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        costUSD: 0,
      }
    if (!existing) accumulators.set(key, accumulator)
    accumulator.allInternal = accumulator.allInternal && internal
    accumulator.calls += 1
    accumulator.sessions.add(message.sessionID)
    accumulator.tokensInput += message.tokensInput ?? 0
    accumulator.tokensOutput += message.tokensOutput ?? 0
    accumulator.tokensReasoning += message.tokensReasoning ?? 0
    accumulator.tokensCacheRead += message.tokensCacheRead ?? 0
    accumulator.tokensCacheWrite += message.tokensCacheWrite ?? 0
    accumulator.costUSD += message.costUSD ?? 0
  }

  const viewsByModel = new Map<string, CallMetrics[]>()
  for (const call of calls) {
    if (since !== null && callTime(call) < since) continue
    if (!includeInternal && internalSessions.has(call.sessionID)) continue
    const key = modelKey(call.providerID, call.modelID)
    const views = viewsByModel.get(key)
    if (views) views.push(metrics(call))
    else viewsByModel.set(key, [metrics(call)])
  }

  return [...accumulators.entries()]
    .map(([key, accumulator]) => {
      const views = viewsByModel.get(key) ?? []
      return {
        providerID: accumulator.providerID,
        modelID: accumulator.modelID,
        internal: accumulator.allInternal,
        calls: accumulator.calls,
        sessions: accumulator.sessions.size,
        tokensInput: accumulator.tokensInput,
        tokensOutput: accumulator.tokensOutput,
        tokensReasoning: accumulator.tokensReasoning,
        tokensCacheRead: accumulator.tokensCacheRead,
        tokensCacheWrite: accumulator.tokensCacheWrite,
        costUSD: accumulator.costUSD,
        avgTTFT: averageMetric(views, "ttft"),
        avgTPS: averageMetric(views, "tps"),
      }
    })
    .sort(
      (left, right) =>
        right.costUSD - left.costUSD ||
        right.calls - left.calls ||
        modelKey(left.providerID, left.modelID).localeCompare(modelKey(right.providerID, right.modelID)),
    )
}

export type SidecarCoverage = {
  readonly calls: number
  readonly firstAt: number | null
  readonly lastAt: number | null
}

export function sidecarCoverage(calls: readonly CallRow[]): SidecarCoverage {
  if (calls.length === 0) return { calls: 0, firstAt: null, lastAt: null }
  const times = calls.map((call) => callTime(call))
  return { calls: calls.length, firstAt: Math.min(...times), lastAt: Math.max(...times) }
}

export type TotalTotals = {
  readonly sessions: number
  readonly prompts: number
  readonly steps: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  readonly costUSD: number
  readonly activeDays: number
  readonly rounds: number
  readonly failedRounds: number
  readonly timeouts: number
  readonly p95RoundMs: number | null
  readonly errorRate: number | null
  readonly excludedInternal: number
  readonly sidecar: SidecarCoverage
}

// Totals come from authoritative user/assistant message rows in the window.
// The sidecar block follows the same internal-session filter, because its call
// count describes the visible data, not the raw sidecar database.
export function aggregateTotal(
  messages: readonly MessageRecord[],
  calls: readonly CallRow[],
  since: number | null,
  internalSessions: ReadonlySet<string> = new Set(),
  includeInternal = false,
  turns: readonly TurnRecord[] = [],
): TotalTotals {
  const windowed = messages.filter((message) => since === null || message.timeCreated >= since)
  const visible = windowed.filter((message) => includeInternal || !internalSessions.has(message.sessionID))
  const steps = visible.filter((message) => message.type === "assistant")
  const visibleCalls = includeInternal ? calls : calls.filter((call) => !internalSessions.has(call.sessionID))
  const windowTurns = turns.filter((turn) => since === null || turn.startedAt >= since)
  const visibleTurns = includeInternal
    ? windowTurns
    : windowTurns.filter((turn) => !internalSessions.has(turn.sessionID))
  const failedRounds = visibleTurns.filter((turn) => turn.status === "failed").length
  const interruptedRounds = visibleTurns.filter((turn) => turn.status === "interrupted").length
  const completedRounds = visibleTurns
    .filter((turn) => turn.status === "completed")
    .map((turn) => turnRoundMs(turn))
    .filter((round): round is number => round !== null && Number.isFinite(round))
  return {
    sessions: new Set(visible.map((message) => message.sessionID)).size,
    prompts: visible.filter((message) => message.type === "user").length,
    steps: steps.length,
    tokensInput: sum(steps.map((message) => message.tokensInput ?? 0)),
    tokensOutput: sum(steps.map((message) => message.tokensOutput ?? 0)),
    tokensReasoning: sum(steps.map((message) => message.tokensReasoning ?? 0)),
    tokensCacheRead: sum(steps.map((message) => message.tokensCacheRead ?? 0)),
    tokensCacheWrite: sum(steps.map((message) => message.tokensCacheWrite ?? 0)),
    costUSD: sum(steps.map((message) => message.costUSD ?? 0)),
    activeDays: new Set(visible.map((message) => localDay(message.timeCreated))).size,
    rounds: visibleTurns.length,
    failedRounds,
    timeouts: visibleTurns.filter((turn) => isTimeoutTurn(turn)).length,
    p95RoundMs: percentile(completedRounds, 0.95),
    errorRate: visibleTurns.length === 0 ? null : (failedRounds + interruptedRounds) / visibleTurns.length,
    excludedInternal: includeInternal
      ? 0
      : new Set(windowed.filter((message) => internalSessions.has(message.sessionID)).map((message) => message.sessionID))
          .size,
    sidecar: sidecarCoverage(visibleCalls),
  }
}

function averageMetric(views: readonly CallMetrics[], key: "ttft" | "tps") {
  const values = views
    .map((view) => view[key])
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
  if (values.length === 0) return null
  return sum(values) / values.length
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0)
}
