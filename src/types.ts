import type { EventEnvelope, LocationRef } from "@opencode/plugin"

/**
 * Token accounting as published by `TokenUsage.Info`. `input` excludes cached
 * input, `output` excludes reasoning, and cache read/write are separate.
 */
export type TokenUsage = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export type ModelRef = {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

/**
 * `SessionError.Error` as encoded on the event stream. `type` is already a
 * structured code from `toSessionError`, such as `provider.timeout`.
 */
export type ErrorInfo = {
  readonly type: string
  readonly message: string
  readonly status?: number
  /** Raw provider response body, when the provider included one. */
  readonly response?: { readonly body: string }
  /** How long the provider asked to wait before retrying. */
  readonly retryAfterMs?: number
}

export type InterruptReason = "user" | "shutdown" | "superseded" | "inactivity"

export type InboxItemType = "user" | "synthetic" | "compaction" | "move"

export type InboxDelivery = "steer" | "queue"

/** Structured error types emitted by `packages/core/src/session/to-session-error.ts`. */
const knownErrorTypes = new Set([
  "provider.rate-limit",
  "provider.auth",
  "provider.quota",
  "provider.free-limit",
  "provider.content-filter",
  "provider.transport",
  "provider.internal",
  "provider.invalid-output",
  "provider.invalid-request",
  "provider.unsupported-operation",
  "provider.no-route",
  "provider.unknown",
  "provider.timeout",
  "provider.budget-limit",
  "provider.model-budget-limit",
  "permission.rejected",
  "tool.execution",
  "output-limit",
  "compaction.failed",
  "compaction.interrupted",
  "aborted",
  "unknown",
])

export function isKnownErrorType(type: string) {
  return knownErrorTypes.has(type)
}

type Event<Type extends string, Data> = {
  /** Envelope id; identical for every plugin instance that observes this event. */
  readonly id: string
  readonly type: Type
  readonly created: number
  readonly data: Data
  readonly location?: LocationRef
}

export type StepStarted = Event<
  "session.step.started",
  {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly agent?: string
    readonly model?: ModelRef
    readonly started: number
  }
>

export type StepStreamed = Event<"session.step.streamed", { readonly assistantMessageID: string }>

export type TextStarted = Event<"session.text.started", { readonly assistantMessageID: string }>

export type ReasoningStarted = Event<"session.reasoning.started", { readonly assistantMessageID: string }>

export type ToolInputStarted = Event<"session.tool.input.started", { readonly assistantMessageID: string }>

export type StepEnded = Event<
  "session.step.ended",
  {
    readonly assistantMessageID: string
    readonly finish?: string
    readonly rawFinish?: string
    readonly cost?: number
    readonly tokens?: TokenUsage
  }
>

export type StepFailed = Event<
  "session.step.failed",
  {
    readonly assistantMessageID: string
    readonly error: ErrorInfo
    readonly finish?: string
    readonly rawFinish?: string
    readonly cost?: number
    readonly tokens?: TokenUsage
  }
>

export type RetryScheduled = Event<
  "session.retry.scheduled",
  {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly attempt: number
    /** Scheduled retry time: the retry fires at this epoch-millisecond instant. */
    readonly at: number
    readonly error: ErrorInfo
  }
>

export type ExecutionStarted = Event<"session.execution.started", { readonly sessionID: string }>

export type ExecutionSucceeded = Event<"session.execution.succeeded", { readonly sessionID: string }>

export type ExecutionFailed = Event<
  "session.execution.failed",
  { readonly sessionID: string; readonly error: ErrorInfo }
>

export type ExecutionInterrupted = Event<
  "session.execution.interrupted",
  { readonly sessionID: string; readonly reason: InterruptReason }
>

export type InboxEnqueued = Event<
  "session.inbox.enqueued",
  {
    readonly sessionID: string
    /** Inbox message id, referenced later by `session.inbox.delivered`. */
    readonly inboxID: string
    readonly item: { readonly type: InboxItemType; readonly delivery: InboxDelivery }
  }
>

export type InboxDelivered = Event<
  "session.inbox.delivered",
  { readonly sessionID: string; readonly inboxID: string }
>

export type CompactionEnded = Event<
  "session.compaction.ended",
  {
    readonly sessionID: string
    readonly model?: ModelRef
    readonly cost?: number
    readonly tokens?: TokenUsage
  }
>

export type CompactionFailed = Event<
  "session.compaction.failed",
  {
    readonly sessionID: string
    readonly error: ErrorInfo
    readonly cost?: number
    readonly tokens?: TokenUsage
  }
>

export type UsageEvent =
  | StepStarted
  | StepStreamed
  | TextStarted
  | ReasoningStarted
  | ToolInputStarted
  | StepEnded
  | StepFailed
  | RetryScheduled
  | ExecutionStarted
  | ExecutionSucceeded
  | ExecutionFailed
  | ExecutionInterrupted
  | InboxEnqueued
  | InboxDelivered
  | CompactionEnded
  | CompactionFailed

/**
 * Validate one live event envelope into the narrow union the reducer consumes.
 * Returns undefined for every other event on the stream.
 */
export function parseUsageEvent(event: EventEnvelope): UsageEvent | undefined {
  const id = stringField(event.id)
  if (id === undefined || id.length === 0) return undefined
  if (!Number.isFinite(event.created)) return undefined
  switch (event.type) {
    case "session.step.started":
      return stepStarted(event)
    case "session.step.streamed":
      return stepStreamed(event)
    case "session.text.started":
      return textStarted(event)
    case "session.reasoning.started":
      return reasoningStarted(event)
    case "session.tool.input.started":
      return toolInputStarted(event)
    case "session.step.ended":
      return stepEnded(event)
    case "session.step.failed":
      return stepFailed(event)
    case "session.retry.scheduled":
      return retryScheduled(event)
    case "session.execution.started":
      return executionStarted(event)
    case "session.execution.succeeded":
      return executionSucceeded(event)
    case "session.execution.failed":
      return executionFailed(event)
    case "session.execution.interrupted":
      return executionInterrupted(event)
    case "session.inbox.enqueued":
      return inboxEnqueued(event)
    case "session.inbox.delivered":
      return inboxDelivered(event)
    case "session.compaction.ended":
      return compactionEnded(event)
    case "session.compaction.failed":
      return compactionFailed(event)
    default:
      return undefined
  }
}

function envelope<Type extends string, Data>(event: EventEnvelope, type: Type, data: Data) {
  return { id: event.id, type, created: event.created, data, location: event.location }
}

function stepStarted(event: EventEnvelope): StepStarted | undefined {
  if (!isRecord(event.data)) return undefined
  const data = event.data
  const sessionID = stringField(data.sessionID)
  const assistantMessageID = stringField(data.assistantMessageID)
  const started = numberField(data.started)
  if (sessionID === undefined || assistantMessageID === undefined || started === undefined) return undefined
  return envelope(event, "session.step.started", {
    sessionID,
    assistantMessageID,
    agent: stringField(data.agent),
    model: modelRef(data.model),
    started,
  })
}

function stepStreamed(event: EventEnvelope): StepStreamed | undefined {
  const assistantMessageID = messageID(event.data)
  if (assistantMessageID === undefined) return undefined
  return envelope(event, "session.step.streamed", { assistantMessageID })
}

function textStarted(event: EventEnvelope): TextStarted | undefined {
  const assistantMessageID = messageID(event.data)
  if (assistantMessageID === undefined) return undefined
  return envelope(event, "session.text.started", { assistantMessageID })
}

function reasoningStarted(event: EventEnvelope): ReasoningStarted | undefined {
  const assistantMessageID = messageID(event.data)
  if (assistantMessageID === undefined) return undefined
  return envelope(event, "session.reasoning.started", { assistantMessageID })
}

function toolInputStarted(event: EventEnvelope): ToolInputStarted | undefined {
  const assistantMessageID = messageID(event.data)
  if (assistantMessageID === undefined) return undefined
  return envelope(event, "session.tool.input.started", { assistantMessageID })
}

function stepEnded(event: EventEnvelope): StepEnded | undefined {
  if (!isRecord(event.data)) return undefined
  const data = event.data
  const assistantMessageID = messageID(data)
  if (assistantMessageID === undefined) return undefined
  return envelope(event, "session.step.ended", {
    assistantMessageID,
    finish: stringField(data.finish),
    rawFinish: stringField(data.rawFinish),
    cost: numberField(data.cost),
    tokens: tokenUsage(data.tokens),
  })
}

function stepFailed(event: EventEnvelope): StepFailed | undefined {
  if (!isRecord(event.data)) return undefined
  const data = event.data
  const assistantMessageID = messageID(data)
  const error = errorInfo(data.error)
  if (assistantMessageID === undefined || error === undefined) return undefined
  return envelope(event, "session.step.failed", {
    assistantMessageID,
    error,
    finish: stringField(data.finish),
    rawFinish: stringField(data.rawFinish),
    cost: numberField(data.cost),
    tokens: tokenUsage(data.tokens),
  })
}

function retryScheduled(event: EventEnvelope): RetryScheduled | undefined {
  if (!isRecord(event.data)) return undefined
  const data = event.data
  const sessionID = stringField(data.sessionID)
  const assistantMessageID = messageID(data)
  const attempt =
    typeof data.attempt === "number" && Number.isInteger(data.attempt) && data.attempt > 0 ? data.attempt : undefined
  const at = numberField(data.at)
  const error = errorInfo(data.error)
  if (
    sessionID === undefined ||
    assistantMessageID === undefined ||
    attempt === undefined ||
    at === undefined ||
    error === undefined
  )
    return undefined
  return envelope(event, "session.retry.scheduled", { sessionID, assistantMessageID, attempt, at, error })
}

function executionStarted(event: EventEnvelope): ExecutionStarted | undefined {
  const sessionID = sessionIDField(event.data)
  if (sessionID === undefined) return undefined
  return envelope(event, "session.execution.started", { sessionID })
}

function executionSucceeded(event: EventEnvelope): ExecutionSucceeded | undefined {
  const sessionID = sessionIDField(event.data)
  if (sessionID === undefined) return undefined
  return envelope(event, "session.execution.succeeded", { sessionID })
}

function executionFailed(event: EventEnvelope): ExecutionFailed | undefined {
  if (!isRecord(event.data)) return undefined
  const sessionID = sessionIDField(event.data)
  const error = errorInfo(event.data.error)
  if (sessionID === undefined || error === undefined) return undefined
  return envelope(event, "session.execution.failed", { sessionID, error })
}

function executionInterrupted(event: EventEnvelope): ExecutionInterrupted | undefined {
  if (!isRecord(event.data)) return undefined
  const sessionID = sessionIDField(event.data)
  const reason = interruptReason(event.data.reason)
  if (sessionID === undefined || reason === undefined) return undefined
  return envelope(event, "session.execution.interrupted", { sessionID, reason })
}

function inboxEnqueued(event: EventEnvelope): InboxEnqueued | undefined {
  if (!isRecord(event.data)) return undefined
  const data = event.data
  const sessionID = sessionIDField(data)
  const inboxID = stringField(data.inboxID)
  const item = isRecord(data.item) ? data.item : undefined
  const type = item === undefined ? undefined : inboxItemType(item.type)
  const delivery = item === undefined ? undefined : inboxDelivery(item.delivery)
  if (
    sessionID === undefined ||
    inboxID === undefined ||
    inboxID.length === 0 ||
    type === undefined ||
    delivery === undefined
  )
    return undefined
  return envelope(event, "session.inbox.enqueued", { sessionID, inboxID, item: { type, delivery } })
}

function inboxDelivered(event: EventEnvelope): InboxDelivered | undefined {
  if (!isRecord(event.data)) return undefined
  const sessionID = sessionIDField(event.data)
  const inboxID = stringField(event.data.inboxID)
  if (sessionID === undefined || inboxID === undefined || inboxID.length === 0) return undefined
  return envelope(event, "session.inbox.delivered", { sessionID, inboxID })
}

function compactionEnded(event: EventEnvelope): CompactionEnded | undefined {
  if (!isRecord(event.data)) return undefined
  const data = event.data
  const sessionID = stringField(data.sessionID)
  if (sessionID === undefined) return undefined
  return envelope(event, "session.compaction.ended", {
    sessionID,
    model: modelRef(data.model),
    cost: numberField(data.cost),
    tokens: tokenUsage(data.tokens),
  })
}

function compactionFailed(event: EventEnvelope): CompactionFailed | undefined {
  if (!isRecord(event.data)) return undefined
  const data = event.data
  const sessionID = stringField(data.sessionID)
  const error = errorInfo(data.error)
  if (sessionID === undefined || error === undefined) return undefined
  return envelope(event, "session.compaction.failed", {
    sessionID,
    error,
    cost: numberField(data.cost),
    tokens: tokenUsage(data.tokens),
  })
}

function messageID(value: unknown) {
  if (!isRecord(value)) return undefined
  return stringField(value.assistantMessageID)
}

function modelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined
  const id = stringField(value.id)
  const providerID = stringField(value.providerID)
  if (id === undefined || providerID === undefined) return undefined
  return { id, providerID, variant: stringField(value.variant) }
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const cache = isRecord(value.cache) ? value.cache : undefined
  if (cache === undefined) return undefined
  const input = numberField(value.input)
  const output = numberField(value.output)
  const reasoning = numberField(value.reasoning)
  const read = numberField(cache.read)
  const write = numberField(cache.write)
  if (input === undefined || output === undefined || reasoning === undefined) return undefined
  if (read === undefined || write === undefined) return undefined
  return { input, output, reasoning, cache: { read, write } }
}

function errorInfo(value: unknown): ErrorInfo | undefined {
  if (!isRecord(value)) return undefined
  const type = stringField(value.type)
  const message = stringField(value.message)
  if (type === undefined || message === undefined) return undefined
  const status = optionalInteger(value.status, 100, 599)
  if (status === false) return undefined
  const retryAfterMs =
    typeof value.retryAfterMs === "number" && Number.isInteger(value.retryAfterMs) && value.retryAfterMs >= 0
      ? value.retryAfterMs
      : undefined
  if (value.retryAfterMs !== undefined && retryAfterMs === undefined) return undefined
  const response = value.response === undefined ? undefined : responseBody(value.response)
  if (value.response !== undefined && response === undefined) return undefined
  return { type, message, status, response, retryAfterMs }
}

function responseBody(value: unknown) {
  if (!isRecord(value)) return undefined
  const body = stringField(value.body)
  if (body === undefined) return undefined
  return { body }
}

function sessionIDField(value: unknown) {
  if (!isRecord(value)) return undefined
  return stringField(value.sessionID)
}

function interruptReason(value: unknown) {
  if (value === "user" || value === "shutdown" || value === "superseded" || value === "inactivity") return value
  return undefined
}

function inboxItemType(value: unknown) {
  if (value === "user" || value === "synthetic" || value === "compaction" || value === "move") return value
  return undefined
}

function inboxDelivery(value: unknown) {
  if (value === "steer" || value === "queue") return value
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** `undefined` when absent, `false` when present but invalid. */
function optionalInteger(value: unknown, minimum: number, maximum: number) {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) return false
  return value
}
