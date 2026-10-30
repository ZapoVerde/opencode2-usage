import type {
  CompactionEnded,
  CompactionFailed,
  ErrorInfo,
  InboxDelivery,
  InboxItemType,
  InterruptReason,
  ModelRef,
  StepEnded,
  StepFailed,
  StepStarted,
  TokenUsage,
  UsageEvent,
} from "./types"

export type CallKind = "step" | "compaction"
export type CallStatus = "completed" | "failed" | "retried" | "interrupted"
export type TurnStatus = "running" | "completed" | "failed" | "interrupted"

/** One finalized call row, mirroring the `call` table columns. */
export type CallRow = {
  readonly callID: string
  readonly assistantMessageID: string | null
  readonly sessionID: string
  readonly parentSessionID: string | null
  readonly kind: CallKind
  readonly agent: string | null
  readonly providerID: string | null
  readonly modelID: string | null
  readonly modelVariant: string | null
  readonly directory: string | null
  readonly startedAt: number | null
  readonly firstTokenAt: number | null
  readonly firstTextAt: number | null
  readonly streamedAt: number | null
  readonly endedAt: number | null
  readonly tokensInput: number | null
  readonly tokensOutput: number | null
  readonly tokensReasoning: number | null
  readonly tokensCacheRead: number | null
  readonly tokensCacheWrite: number | null
  readonly costUSD: number | null
  readonly finish: string | null
  readonly rawFinish: string | null
  readonly status: CallStatus
  /** Combined `type: message` string, kept for compatibility with early rows. */
  readonly error: string | null
  readonly turnID: string | null
  readonly errorType: string | null
  readonly errorMessage: string | null
  readonly errorStatus: number | null
  readonly errorRetryAfterMs: number | null
  readonly retries: number
  readonly lastRetryErrorType: string | null
  readonly lastRetryAt: number | null
  readonly recordedAt: number
}

/** One round row, keyed by the `session.execution.started` event id. */
export type TurnRow = {
  readonly turnID: string
  readonly sessionID: string
  readonly directory: string | null
  readonly queuedAt: number | null
  readonly acceptedAt: number | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly status: TurnStatus
  readonly interruptReason: InterruptReason | null
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

/** Turn fields a later event advances. Omitted fields stay untouched. */
export type TurnProgress = {
  readonly status?: TurnStatus
  readonly directory?: string
  readonly endedAt?: number
  readonly interruptReason?: InterruptReason
  readonly errorType?: string
  readonly errorMessage?: string
  readonly errorStatus?: number
  readonly prompts?: number
  readonly compactions?: number
  readonly steers?: number
  readonly retries?: number
  readonly firstTokenAt?: number
  readonly acceptedAt?: number
  readonly queuedAt?: number
  readonly updatedAt: number
}

export type TurnWrite =
  | { readonly kind: "insert"; readonly row: TurnRow }
  | { readonly kind: "progress"; readonly turnID: string; readonly progress: TurnProgress }

/** One in-flight step, keyed by assistant message ID until it finalizes or retries. */
export type PendingCall = {
  readonly callID: string
  readonly assistantMessageID: string
  readonly sessionID: string
  readonly agent?: string
  readonly model?: ModelRef
  readonly directory: string
  readonly startedAt: number
  readonly firstTokenAt?: number
  readonly firstTextAt?: number
  readonly streamedAt?: number
  /** `session.execution.started` event id active when this attempt started. */
  readonly turnID?: string
  readonly retries: number
  readonly lastRetryErrorType?: string
  readonly lastRetryAt?: number
  /** Event time of the last mutation; drives the 30-minute sweep. */
  readonly seenAt: number
}

/** An inbox item that has been enqueued but not yet delivered. */
export type InboxEntry = {
  readonly type: InboxItemType
  readonly delivery: InboxDelivery
  readonly created: number
}

type ActiveTurn = {
  readonly turnID: string
  readonly prompts: number
  readonly compactions: number
  readonly steers: number
  readonly retries: number
  readonly firstTokenAt?: number
}

/**
 * Per-session delivery state between rounds. Counters and timestamps collect
 * delivered items until the next `session.execution.started` consumes them.
 */
export type RoundState = {
  /** Earliest inbox enqueue time that may belong to the next round. */
  readonly queuedAt?: number
  /** First inbox delivery time for the next round; `started` falls back to its own time. */
  readonly acceptedAt?: number
  readonly active?: ActiveTurn
  readonly prompts: number
  readonly compactions: number
  readonly steers: number
}

export type ReducerState = {
  readonly pending: ReadonlyMap<string, PendingCall>
  readonly rounds: ReadonlyMap<string, RoundState>
  readonly inbox: ReadonlyMap<string, InboxEntry>
}

export type ReducerContext = {
  /** Wall-clock time used for `recorded_at` and the pending sweep. */
  readonly now: number
  /** Fallback directory when the event envelope carries no location. */
  readonly directory: string
}

export type Reduction = {
  readonly state: ReducerState
  readonly rows: readonly CallRow[]
  readonly turns: readonly TurnWrite[]
}

export const PENDING_TTL_MS = 30 * 60 * 1_000

export function createState(): ReducerState {
  return { pending: new Map(), rounds: new Map(), inbox: new Map() }
}

/** Apply one event, returning the next state and any rows to persist. */
export function apply(state: ReducerState, event: UsageEvent, context: ReducerContext): Reduction {
  const pending = new Map(state.pending)
  const rounds = new Map(state.rounds)
  const inbox = new Map(state.inbox)
  sweep(pending, context.now)
  const rows: CallRow[] = []
  const turns: TurnWrite[] = []

  const record = (row: CallRow) => {
    rows.push(row)
    noteFirstToken(rounds, row)
    // `execution.started` carries no location, so an instance's fallback can
    // differ per Location. Calls do carry one; converge the round on it.
    if (row.turnID !== null && row.directory !== null)
      turns.push({
        kind: "progress",
        turnID: row.turnID,
        progress: { directory: row.directory, updatedAt: context.now },
      })
  }

  switch (event.type) {
    case "session.step.started": {
      const round = rounds.get(event.data.sessionID)
      pending.set(event.data.assistantMessageID, started(event, context, round?.active?.turnID))
      break
    }
    case "session.text.started": {
      update(pending, event.data.assistantMessageID, context.now, (call) => ({
        ...call,
        firstTokenAt: call.firstTokenAt ?? event.created,
        firstTextAt: call.firstTextAt ?? event.created,
      }))
      break
    }
    case "session.reasoning.started":
    case "session.tool.input.started": {
      update(pending, event.data.assistantMessageID, context.now, (call) => ({
        ...call,
        firstTokenAt: call.firstTokenAt ?? event.created,
      }))
      break
    }
    case "session.step.streamed": {
      update(pending, event.data.assistantMessageID, context.now, (call) => ({
        ...call,
        streamedAt: event.created,
      }))
      break
    }
    case "session.step.ended": {
      const call = pending.get(event.data.assistantMessageID)
      if (!call) break
      pending.delete(call.assistantMessageID)
      record(completed(call, event, context.now))
      break
    }
    case "session.step.failed": {
      const call = pending.get(event.data.assistantMessageID)
      if (!call) break
      pending.delete(call.assistantMessageID)
      record(failed(call, event, context.now))
      break
    }
    case "session.retry.scheduled": {
      const call = pending.get(event.data.assistantMessageID)
      if (call) {
        pending.delete(call.assistantMessageID)
        record(
          stepRow(
            { ...call, retries: call.retries + 1, lastRetryErrorType: event.data.error.type, lastRetryAt: event.data.at },
            "retried",
            context.now,
            { endedAt: event.created },
          ),
        )
      }
      const active = updateActive(rounds, event.data.sessionID, (turn) => ({ ...turn, retries: turn.retries + 1 }))
      if (active)
        turns.push({
          kind: "progress",
          turnID: active.turnID,
          progress: {
            retries: active.retries,
            firstTokenAt: active.firstTokenAt,
            updatedAt: context.now,
          },
        })
      break
    }
    case "session.execution.started": {
      const round = rounds.get(event.data.sessionID) ?? emptyRound()
      turns.push({
        kind: "insert",
        row: {
          turnID: event.id,
          sessionID: event.data.sessionID,
          directory: event.location?.directory ?? context.directory,
          queuedAt: round.queuedAt ?? null,
          acceptedAt: round.acceptedAt ?? event.created,
          startedAt: event.created,
          endedAt: null,
          status: "running",
          interruptReason: null,
          errorType: null,
          errorMessage: null,
          errorStatus: null,
          prompts: round.prompts,
          compactions: round.compactions,
          steers: round.steers,
          retries: 0,
          firstTokenAt: null,
          recordedAt: context.now,
          updatedAt: context.now,
        },
      })
      // A missed terminal event leaves the previous turn `running`; a new round
      // simply replaces it as the active turn rather than rewriting its status.
      rounds.set(event.data.sessionID, {
        prompts: 0,
        compactions: 0,
        steers: 0,
        active: {
          turnID: event.id,
          prompts: round.prompts,
          compactions: round.compactions,
          steers: round.steers,
          retries: 0,
        },
      })
      break
    }
    case "session.execution.succeeded": {
      const active = endActive(rounds, event.data.sessionID)
      if (!active) break
      turns.push({
        kind: "progress",
        turnID: active.turnID,
        progress: {
          status: "completed",
          endedAt: event.created,
          firstTokenAt: active.firstTokenAt,
          updatedAt: context.now,
        },
      })
      break
    }
    case "session.execution.failed": {
      const active = endActive(rounds, event.data.sessionID)
      if (!active) break
      turns.push({
        kind: "progress",
        turnID: active.turnID,
        progress: {
          status: "failed",
          endedAt: event.created,
          errorType: event.data.error.type,
          errorMessage: event.data.error.message,
          errorStatus: event.data.error.status,
          firstTokenAt: active.firstTokenAt,
          updatedAt: context.now,
        },
      })
      break
    }
    case "session.execution.interrupted": {
      for (const call of pending.values()) {
        if (call.sessionID !== event.data.sessionID) continue
        pending.delete(call.assistantMessageID)
        record(stepRow(call, "interrupted", context.now, { endedAt: event.created }))
      }
      const active = endActive(rounds, event.data.sessionID)
      if (!active) break
      turns.push({
        kind: "progress",
        turnID: active.turnID,
        progress: {
          status: "interrupted",
          interruptReason: event.data.reason,
          endedAt: event.created,
          firstTokenAt: active.firstTokenAt,
          updatedAt: context.now,
        },
      })
      break
    }
    case "session.inbox.enqueued": {
      inbox.set(event.data.inboxID, {
        type: event.data.item.type,
        delivery: event.data.item.delivery,
        created: event.created,
      })
      const round = rounds.get(event.data.sessionID) ?? emptyRound()
      if (!round.active) rounds.set(event.data.sessionID, { ...round, queuedAt: earliest(round.queuedAt, event.created) })
      break
    }
    case "session.inbox.delivered": {
      const entry = inbox.get(event.data.inboxID)
      if (!entry) break
      inbox.delete(event.data.inboxID)
      const round = rounds.get(event.data.sessionID) ?? emptyRound()
      const active = delivery(round.active, entry)
      if (active)
        rounds.set(event.data.sessionID, { ...round, active })
      else
        rounds.set(event.data.sessionID, {
          ...round,
          acceptedAt: round.acceptedAt ?? event.created,
          queuedAt: earliest(round.queuedAt, entry.created),
          prompts: round.prompts + (isPrompt(entry) ? 1 : 0),
          compactions: round.compactions + (entry.type === "compaction" ? 1 : 0),
          steers: round.steers + (entry.delivery === "steer" ? 1 : 0),
        })
      if (!active) break
      turns.push({
        kind: "progress",
        turnID: active.turnID,
        progress: {
          prompts: active.prompts,
          compactions: active.compactions,
          steers: active.steers,
          updatedAt: context.now,
        },
      })
      break
    }
    case "session.compaction.ended": {
      record(compaction(event, context))
      break
    }
    case "session.compaction.failed": {
      record(compactionFailure(event, context))
      break
    }
  }

  return { state: { pending, rounds, inbox }, rows, turns }
}

function started(event: StepStarted, context: ReducerContext, turnID: string | undefined): PendingCall {
  return {
    // Deterministic per attempt: every plugin instance sees the same started event id.
    callID: event.id,
    assistantMessageID: event.data.assistantMessageID,
    sessionID: event.data.sessionID,
    agent: event.data.agent,
    model: event.data.model,
    directory: event.location?.directory ?? context.directory,
    startedAt: event.data.started,
    turnID,
    retries: 0,
    seenAt: context.now,
  }
}

function update(
  pending: Map<string, PendingCall>,
  assistantMessageID: string,
  now: number,
  change: (call: PendingCall) => PendingCall,
) {
  const call = pending.get(assistantMessageID)
  if (!call) return
  pending.set(assistantMessageID, { ...change(call), seenAt: now })
}

function sweep(pending: Map<string, PendingCall>, now: number) {
  for (const [assistantMessageID, call] of pending)
    if (now - call.seenAt > PENDING_TTL_MS) pending.delete(assistantMessageID)
}

function emptyRound(): RoundState {
  return { prompts: 0, compactions: 0, steers: 0 }
}

function earliest(current: number | undefined, next: number) {
  return current === undefined ? next : Math.min(current, next)
}

function isPrompt(entry: InboxEntry) {
  return entry.type === "user" || entry.type === "synthetic"
}

/** Advance the active turn's delivery counters; returns undefined when no round is active. */
function delivery(active: ActiveTurn | undefined, entry: InboxEntry) {
  if (!active) return undefined
  return {
    ...active,
    prompts: active.prompts + (isPrompt(entry) ? 1 : 0),
    compactions: active.compactions + (entry.type === "compaction" ? 1 : 0),
    steers: active.steers + (entry.delivery === "steer" ? 1 : 0),
  }
}

function updateActive(
  rounds: Map<string, RoundState>,
  sessionID: string,
  change: (active: ActiveTurn) => ActiveTurn,
) {
  const round = rounds.get(sessionID)
  if (!round?.active) return undefined
  const active = change(round.active)
  rounds.set(sessionID, { ...round, active })
  return active
}

/** Clear the active turn and return it so the terminal event can persist its final fields. */
function endActive(rounds: Map<string, RoundState>, sessionID: string) {
  const round = rounds.get(sessionID)
  if (!round?.active) return undefined
  rounds.set(sessionID, { ...round, active: undefined })
  return round.active
}

/** Track the earliest first token across every call finalized in the round. */
function noteFirstToken(rounds: Map<string, RoundState>, row: CallRow) {
  const firstTokenAt = row.firstTokenAt
  if (row.turnID === null || firstTokenAt === null) return
  updateActive(rounds, row.sessionID, (active) =>
    active.turnID === row.turnID ? { ...active, firstTokenAt: earliest(active.firstTokenAt, firstTokenAt) } : active,
  )
}

function completed(call: PendingCall, event: StepEnded, now: number): CallRow {
  return stepRow(call, "completed", now, {
    endedAt: event.created,
    tokens: event.data.tokens,
    cost: event.data.cost,
    finish: event.data.finish,
    rawFinish: event.data.rawFinish,
  })
}

function failed(call: PendingCall, event: StepFailed, now: number): CallRow {
  return stepRow(call, "failed", now, {
    endedAt: event.created,
    tokens: event.data.tokens,
    cost: event.data.cost,
    finish: event.data.finish,
    rawFinish: event.data.rawFinish,
    error: event.data.error,
  })
}

type StepOutcome = {
  readonly endedAt: number
  readonly tokens?: TokenUsage
  readonly cost?: number
  readonly finish?: string
  readonly rawFinish?: string
  readonly error?: ErrorInfo
}

function stepRow(call: PendingCall, status: CallStatus, recordedAt: number, outcome: StepOutcome): CallRow {
  return {
    callID: call.callID,
    assistantMessageID: call.assistantMessageID,
    sessionID: call.sessionID,
    // The live event stream carries parentID only on session.created, which is not replayed on subscribe.
    parentSessionID: null,
    kind: "step",
    agent: call.agent ?? null,
    providerID: call.model?.providerID ?? null,
    modelID: call.model?.id ?? null,
    modelVariant: call.model?.variant ?? null,
    directory: call.directory,
    startedAt: call.startedAt,
    firstTokenAt: call.firstTokenAt ?? null,
    firstTextAt: call.firstTextAt ?? null,
    streamedAt: call.streamedAt ?? null,
    endedAt: outcome.endedAt,
    tokensInput: outcome.tokens?.input ?? null,
    tokensOutput: outcome.tokens?.output ?? null,
    tokensReasoning: outcome.tokens?.reasoning ?? null,
    tokensCacheRead: outcome.tokens?.cache.read ?? null,
    tokensCacheWrite: outcome.tokens?.cache.write ?? null,
    costUSD: outcome.cost ?? null,
    finish: outcome.finish ?? null,
    rawFinish: outcome.rawFinish ?? null,
    status,
    error: outcome.error === undefined ? null : `${outcome.error.type}: ${outcome.error.message}`,
    turnID: call.turnID ?? null,
    errorType: outcome.error?.type ?? null,
    errorMessage: outcome.error?.message ?? null,
    errorStatus: outcome.error?.status ?? null,
    errorRetryAfterMs: outcome.error?.retryAfterMs ?? null,
    retries: call.retries,
    lastRetryErrorType: call.lastRetryErrorType ?? null,
    lastRetryAt: call.lastRetryAt ?? null,
    recordedAt,
  }
}

function compaction(event: CompactionEnded, context: ReducerContext): CallRow {
  return {
    // Keyed by the ended event so concurrent plugin instances collapse on insert.
    callID: event.id,
    assistantMessageID: null,
    sessionID: event.data.sessionID,
    parentSessionID: null,
    kind: "compaction",
    agent: null,
    providerID: event.data.model?.providerID ?? null,
    modelID: event.data.model?.id ?? null,
    modelVariant: event.data.model?.variant ?? null,
    directory: event.location?.directory ?? context.directory,
    startedAt: null,
    firstTokenAt: null,
    firstTextAt: null,
    streamedAt: null,
    endedAt: event.created,
    tokensInput: event.data.tokens?.input ?? null,
    tokensOutput: event.data.tokens?.output ?? null,
    tokensReasoning: event.data.tokens?.reasoning ?? null,
    tokensCacheRead: event.data.tokens?.cache.read ?? null,
    tokensCacheWrite: event.data.tokens?.cache.write ?? null,
    costUSD: event.data.cost ?? null,
    finish: null,
    rawFinish: null,
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
    recordedAt: context.now,
  }
}

function compactionFailure(event: CompactionFailed, context: ReducerContext): CallRow {
  return {
    // Keyed by the failed event so concurrent plugin instances collapse on insert.
    callID: event.id,
    assistantMessageID: null,
    sessionID: event.data.sessionID,
    parentSessionID: null,
    kind: "compaction",
    agent: null,
    providerID: null,
    modelID: null,
    modelVariant: null,
    directory: event.location?.directory ?? context.directory,
    startedAt: null,
    firstTokenAt: null,
    firstTextAt: null,
    streamedAt: null,
    endedAt: event.created,
    tokensInput: event.data.tokens?.input ?? null,
    tokensOutput: event.data.tokens?.output ?? null,
    tokensReasoning: event.data.tokens?.reasoning ?? null,
    tokensCacheRead: event.data.tokens?.cache.read ?? null,
    tokensCacheWrite: event.data.tokens?.cache.write ?? null,
    costUSD: event.data.cost ?? null,
    finish: null,
    rawFinish: null,
    status: "failed",
    error: `${event.data.error.type}: ${event.data.error.message}`,
    turnID: null,
    errorType: event.data.error.type,
    errorMessage: event.data.error.message,
    errorStatus: event.data.error.status ?? null,
    errorRetryAfterMs: event.data.error.retryAfterMs ?? null,
    retries: 0,
    lastRetryErrorType: null,
    lastRetryAt: null,
    recordedAt: context.now,
  }
}

export type CallMetrics = {
  readonly tps?: number
  readonly ttft?: number
  readonly ttfa?: number
  readonly e2e?: number
}

/**
 * Provider metrics with the same semantics as the app's live reducer:
 * TTFT starts at dispatch; TPS measures output tokens from the first text
 * (falling back to the first token) until the streamed boundary.
 */
export function metrics(
  row: Pick<CallRow, "startedAt" | "firstTokenAt" | "firstTextAt" | "streamedAt" | "tokensOutput">,
): CallMetrics {
  const ttft = elapsed(row.startedAt, row.firstTokenAt)
  const ttfa = elapsed(row.startedAt, row.firstTextAt)
  const e2e = elapsed(row.startedAt, row.streamedAt)
  // Output tokens exclude reasoning, so measure them from the answer start when one exists.
  const generation = elapsed(row.firstTextAt ?? row.firstTokenAt, row.streamedAt)
  const output = row.tokensOutput
  return {
    tps: generation && output && generation > 0 && output > 0 ? output / (generation / 1_000) : undefined,
    ttft,
    ttfa,
    e2e,
  }
}

function elapsed(start: number | null | undefined, end: number | null | undefined) {
  if (start === null || start === undefined || end === null || end === undefined) return
  return Math.max(0, end - start)
}
