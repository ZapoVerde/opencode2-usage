import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { EventEnvelope } from "@opencode/plugin"
import { apply, createState, metrics, type CallRow, type ReducerState, type TurnWrite } from "../src/reducer"
import { openStore, type UsageStore } from "../src/store"
import { parseUsageEvent, type ErrorInfo } from "../src/types"

const durable = { aggregateID: "ses_test", seq: 0, version: 1 } as const
const root = mkdtempSync(path.join(os.tmpdir(), "opencode2-usage-turns-"))

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** The exact event fixture used by packages/gui-extensions/src/debug/metrics.test.ts. */
const providerMetricEvents: EventEnvelope[] = [
  {
    id: "evt_started",
    created: 1_000,
    type: "session.step.started",
    durable,
    data: {
      sessionID: "ses_test",
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      started: 1_000,
    },
  },
  {
    id: "evt_reasoning",
    created: 1_300,
    type: "session.reasoning.started",
    durable: { ...durable, seq: 1 },
    data: { sessionID: "ses_test", assistantMessageID: "msg_assistant", ordinal: 0 },
  },
  {
    id: "evt_text",
    created: 1_800,
    type: "session.text.started",
    durable: { ...durable, seq: 2 },
    data: { sessionID: "ses_test", assistantMessageID: "msg_assistant", ordinal: 0 },
  },
  {
    id: "evt_streamed",
    created: 3_800,
    type: "session.step.streamed",
    durable: { ...durable, seq: 3 },
    data: { sessionID: "ses_test", assistantMessageID: "msg_assistant" },
  },
  {
    id: "evt_ended",
    created: 4_000,
    type: "session.step.ended",
    durable: { ...durable, seq: 4 },
    data: {
      sessionID: "ses_test",
      assistantMessageID: "msg_assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
    },
  },
]

function reduceAll(events: readonly EventEnvelope[], now: number, directory = "/work"): readonly CallRow[] {
  const result = reduceWithState(createState(), events, now, directory)
  return result.rows
}

function reduceWithState(state: ReducerState, events: readonly EventEnvelope[], now: number, directory = "/work") {
  const rows: CallRow[] = []
  const turns: TurnWrite[] = []
  let current = state
  for (const envelope of events) {
    const event = parseUsageEvent(envelope)
    if (!event) continue
    const reduction = apply(current, event, { now, directory })
    current = reduction.state
    rows.push(...reduction.rows)
    turns.push(...reduction.turns)
  }
  return { state: current, rows, turns }
}

function started(created: number, options?: { sessionID?: string; assistantMessageID?: string }) {
  return {
    id: `evt_started_${created}`,
    created,
    type: "session.step.started",
    durable,
    data: {
      sessionID: options?.sessionID ?? "ses_test",
      assistantMessageID: options?.assistantMessageID ?? "msg_assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      started: created,
    },
  } satisfies EventEnvelope
}

describe("reducer", () => {
  test("mirrors the gui provider metrics fixture", () => {
    const rows = reduceAll(providerMetricEvents, 4_000)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      callID: "evt_started",
      assistantMessageID: "msg_assistant",
      sessionID: "ses_test",
      kind: "step",
      agent: "build",
      providerID: "provider",
      modelID: "model",
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
      costUSD: 0,
      finish: "stop",
      status: "completed",
      error: null,
    })
    expect(metrics(row)).toEqual({ tps: 50, ttft: 300, ttfa: 800, e2e: 2_800 })
  })

  test("reports time to first token from reasoning even when text comes later", () => {
    const rows = reduceAll(providerMetricEvents.slice(0, 3), 2_000)
    expect(rows).toHaveLength(0)
    const state = reduceWithState(createState(), providerMetricEvents.slice(0, 3), 2_000)
    expect(state.state.pending.get("msg_assistant")).toMatchObject({ firstTokenAt: 1_300, firstTextAt: 1_800 })
  })

  test("a retry finalizes the attempt and the next started event gets a new call id", () => {
    const events: EventEnvelope[] = [
      started(1_000),
      {
        id: "evt_text",
        created: 1_200,
        type: "session.text.started",
        durable,
        data: { sessionID: "ses_test", assistantMessageID: "msg_assistant", ordinal: 0 },
      },
      {
        id: "evt_retry",
        created: 1_500,
        type: "session.retry.scheduled",
        durable,
        data: {
          sessionID: "ses_test",
          assistantMessageID: "msg_assistant",
          attempt: 1,
          at: 1_500,
          error: { type: "provider", message: "overloaded" },
        },
      },
      started(2_000),
      {
        id: "evt_streamed",
        created: 2_500,
        type: "session.step.streamed",
        durable,
        data: { sessionID: "ses_test", assistantMessageID: "msg_assistant" },
      },
      {
        id: "evt_ended",
        created: 3_000,
        type: "session.step.ended",
        durable,
        data: {
          sessionID: "ses_test",
          assistantMessageID: "msg_assistant",
          finish: "stop",
          cost: 0.001,
          tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    ]

    const result = reduceWithState(createState(), events, 3_000)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({
      status: "retried",
      startedAt: 1_000,
      firstTextAt: 1_200,
      endedAt: 1_500,
      tokensOutput: null,
    })
    expect(result.rows[1]).toMatchObject({ status: "completed", startedAt: 2_000, endedAt: 3_000, tokensOutput: 20 })
    expect(result.rows[0]!.callID).toBe("evt_started_1000")
    expect(result.rows[1]!.callID).toBe("evt_started_2000")
    expect(result.rows[0]!.callID).not.toBe(result.rows[1]!.callID)
    expect(result.state.pending.size).toBe(0)
  })

  test("an execution interruption closes only that session's pending call", () => {
    const events: EventEnvelope[] = [
      started(1_000, { sessionID: "ses_a", assistantMessageID: "msg_a" }),
      started(1_100, { sessionID: "ses_b", assistantMessageID: "msg_b" }),
      {
        id: "evt_interrupted",
        created: 1_500,
        type: "session.execution.interrupted",
        durable,
        data: { sessionID: "ses_a", reason: "user" },
      },
    ]

    const result = reduceWithState(createState(), events, 1_500)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ sessionID: "ses_a", status: "interrupted", endedAt: 1_500 })
    expect([...result.state.pending.keys()]).toEqual(["msg_b"])
  })

  test("a failed step records the error and optional usage", () => {
    const events: EventEnvelope[] = [
      started(1_000),
      {
        id: "evt_failed",
        created: 1_400,
        type: "session.step.failed",
        durable,
        data: {
          sessionID: "ses_test",
          assistantMessageID: "msg_assistant",
          error: { type: "provider", message: "boom" },
        },
      },
    ]

    const rows = reduceAll(events, 1_400)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: "failed",
      endedAt: 1_400,
      error: "provider: boom",
      costUSD: null,
      tokensInput: null,
    })
  })

  test("compaction is recorded as its own kind without timings", () => {
    const events: EventEnvelope[] = [
      {
        id: "evt_compaction",
        created: 5_000,
        type: "session.compaction.ended",
        durable,
        data: {
          sessionID: "ses_test",
          reason: "auto",
          model: { id: "model", providerID: "provider", variant: "fast" },
          text: "summary",
          cost: 0.002,
          tokens: { input: 11, output: 12, reasoning: 13, cache: { read: 14, write: 15 } },
        },
      },
    ]

    const rows = reduceAll(events, 5_000)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "compaction",
      status: "completed",
      assistantMessageID: null,
      startedAt: null,
      firstTokenAt: null,
      streamedAt: null,
      endedAt: 5_000,
      modelVariant: "fast",
      tokensInput: 11,
      tokensCacheWrite: 15,
      costUSD: 0.002,
    })
    expect(rows[0]!.callID).toBe("evt_compaction")
  })

  test("independent plugin instances collapse to one row for the same attempt", () => {
    const first = reduceWithState(createState(), providerMetricEvents, 4_000)
    const second = reduceWithState(createState(), providerMetricEvents, 4_000)
    expect(first.rows).toHaveLength(1)
    expect(second.rows).toHaveLength(1)
    expect(first.rows[0]!.callID).toBe("evt_started")
    expect(second.rows[0]!.callID).toBe("evt_started")

    const store = openStore(":memory:")
    store.insert(first.rows[0]!)
    store.insert(second.rows[0]!)
    expect(store.count()).toBe(1)
    expect(store.count("evt_started")).toBe(1)
    store.close()
  })

  test("a duplicate ended event cannot insert a second row", () => {
    const ended = providerMetricEvents[4]!
    const rows = reduceAll([...providerMetricEvents, ended], 4_000)
    expect(rows).toHaveLength(1)
  })

  test("pending calls older than thirty minutes are swept", () => {
    const first = reduceWithState(createState(), [started(1_000)], 1_000)
    const later = 1_000 + 30 * 60 * 1_000 + 1
    const result = reduceWithState(
      first.state,
      [
        {
          id: "evt_streamed",
          created: later,
          type: "session.step.streamed",
          durable,
          data: { sessionID: "ses_test", assistantMessageID: "msg_assistant" },
        },
      ],
      later,
    )
    expect(result.rows).toHaveLength(0)
    expect(result.state.pending.size).toBe(0)
  })

  test("a completed round records queue wait, duration, counters, and links its call", () => {
    const events: EventEnvelope[] = [
      inboxEnqueued("inbox_1", "user", "queue", 500),
      inboxDelivered("inbox_1", 900),
      executionStarted("evt_turn", 1_000),
      started(1_000),
      textStarted(1_200),
      ended(1_400),
      executionSucceeded(1_500),
    ]

    const result = reduceWithState(createState(), events, 1_500)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ turnID: "evt_turn", firstTokenAt: 1_200, status: "completed" })
    expect(result.turns.filter((write) => write.kind === "insert")).toHaveLength(1)

    const dbPath = path.join(root, `completed-${crypto.randomUUID()}.db`)
    const store = openStore(dbPath)
    persist(store, result)

    const turn = storedTurn(dbPath, "evt_turn")!
    expect(turn).toMatchObject({
      session_id: "ses_test",
      directory: "/work",
      queued_at: 500,
      accepted_at: 900,
      started_at: 1_000,
      ended_at: 1_500,
      status: "completed",
      interrupt_reason: null,
      prompts: 1,
      compactions: 0,
      steers: 0,
      retries: 0,
      first_token_at: 1_200,
    })
    expect(Number(turn.accepted_at)).toBeLessThanOrEqual(Number(turn.started_at))
    expect(Number(turn.started_at)).toBeLessThanOrEqual(Number(turn.ended_at))
    expect(storedCall(dbPath, "evt_started_1000")?.turn_id).toBe("evt_turn")
    store.close()
  })

  test("a round converges on its call's location when the started event has none", () => {
    const events: EventEnvelope[] = [
      executionStarted("evt_turn", 1_000),
      { ...started(1_000), location: { directory: "/actual" } },
      ended(1_400),
      executionSucceeded(1_500),
    ]

    const result = reduceWithState(createState(), events, 1_500, "/fallback")
    const dbPath = path.join(root, `location-${crypto.randomUUID()}.db`)
    const store = openStore(dbPath)
    persist(store, result)

    expect(storedTurn(dbPath, "evt_turn")?.directory).toBe("/actual")
    expect(storedCall(dbPath, "evt_started_1000")?.directory).toBe("/actual")
    store.close()
  })

  test("a failed execution stores its structured error", () => {
    const events: EventEnvelope[] = [
      executionStarted("evt_turn", 1_000),
      executionFailed(2_000, { type: "provider.internal", message: "upstream exploded", status: 500 }),
    ]

    const result = reduceWithState(createState(), events, 2_000)
    const dbPath = path.join(root, `failed-${crypto.randomUUID()}.db`)
    const store = openStore(dbPath)
    persist(store, result)

    expect(storedTurn(dbPath, "evt_turn")).toMatchObject({
      status: "failed",
      ended_at: 2_000,
      error_type: "provider.internal",
      error_message: "upstream exploded",
      error_status: 500,
    })
    store.close()
  })

  test("an inactivity interruption records its reason", () => {
    const events: EventEnvelope[] = [executionStarted("evt_turn", 1_000), executionInterrupted(5_000, "inactivity")]

    const result = reduceWithState(createState(), events, 5_000)
    const dbPath = path.join(root, `inactivity-${crypto.randomUUID()}.db`)
    const store = openStore(dbPath)
    persist(store, result)

    expect(storedTurn(dbPath, "evt_turn")).toMatchObject({
      status: "interrupted",
      interrupt_reason: "inactivity",
      ended_at: 5_000,
    })
    store.close()
  })

  test("a provider.timeout step failure keeps its type, status, and retry hint", () => {
    const events: EventEnvelope[] = [
      executionStarted("evt_turn", 1_000),
      started(1_000),
      stepFailed(1_600, {
        type: "provider.timeout",
        message: "request timed out",
        status: 504,
        retryAfterMs: 2_000,
      }),
    ]

    const result = reduceWithState(createState(), events, 1_600)
    expect(result.rows[0]).toMatchObject({
      status: "failed",
      error: "provider.timeout: request timed out",
      errorType: "provider.timeout",
      errorMessage: "request timed out",
      errorStatus: 504,
      errorRetryAfterMs: 2_000,
      turnID: "evt_turn",
    })
  })

  test("retries increment the attempt and round counters and keep both attempt rows", () => {
    const events: EventEnvelope[] = [
      executionStarted("evt_turn", 1_000),
      started(1_000),
      retryScheduled(1_500, {
        type: "provider.rate-limit",
        message: "too many requests",
        status: 429,
        retryAfterMs: 2_000,
      }),
      started(3_000),
      ended(4_000),
      executionSucceeded(5_000),
    ]

    const result = reduceWithState(createState(), events, 5_000)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({
      callID: "evt_started_1000",
      status: "retried",
      turnID: "evt_turn",
      retries: 1,
      lastRetryErrorType: "provider.rate-limit",
      lastRetryAt: 2_000,
      endedAt: 1_500,
    })
    expect(result.rows[1]).toMatchObject({
      callID: "evt_started_3000",
      status: "completed",
      turnID: "evt_turn",
      retries: 0,
      lastRetryErrorType: null,
    })

    const dbPath = path.join(root, `retry-${crypto.randomUUID()}.db`)
    const store = openStore(dbPath)
    persist(store, result)
    expect(storedTurn(dbPath, "evt_turn")).toMatchObject({ status: "completed", retries: 1 })
    expect(storedCall(dbPath, "evt_started_1000")).toMatchObject({
      retries: 1,
      last_retry_error_type: "provider.rate-limit",
      last_retry_at: 2_000,
    })
    expect(storedCall(dbPath, "evt_started_3000")).toMatchObject({ retries: 0, turn_id: "evt_turn" })
    store.close()
  })

  test("two reducers over the same stream write one round and one call row", () => {
    const events: EventEnvelope[] = [
      executionStarted("evt_turn", 1_000),
      started(1_000),
      textStarted(1_200),
      ended(1_400),
      executionSucceeded(1_500),
    ]

    const first = reduceWithState(createState(), events, 1_500)
    const second = reduceWithState(createState(), events, 1_500)
    const dbPath = path.join(root, `duplicate-${crypto.randomUUID()}.db`)
    const store = openStore(dbPath)
    persist(store, first)
    persist(store, second)

    expect(countRows(dbPath, "turn")).toBe(1)
    expect(countRows(dbPath, "call")).toBe(1)
    expect(storedTurn(dbPath, "evt_turn")).toMatchObject({ status: "completed", prompts: 0, first_token_at: 1_200 })
    store.close()
  })

  test("a steered delivery increments steers without starting a second round", () => {
    const events: EventEnvelope[] = [
      executionStarted("evt_turn", 1_000),
      inboxEnqueued("inbox_steer", "user", "steer", 1_100),
      inboxDelivered("inbox_steer", 1_200),
      executionSucceeded(2_000),
    ]

    const result = reduceWithState(createState(), events, 2_000)
    expect(result.turns.filter((write) => write.kind === "insert")).toHaveLength(1)

    const dbPath = path.join(root, `steer-${crypto.randomUUID()}.db`)
    const store = openStore(dbPath)
    persist(store, result)
    expect(countRows(dbPath, "turn")).toBe(1)
    expect(storedTurn(dbPath, "evt_turn")).toMatchObject({ status: "completed", prompts: 1, steers: 1 })
    store.close()
  })

  test("unrelated events are ignored", () => {
    const events: EventEnvelope[] = [
      { id: "evt_connected", type: "server.connected", created: 1, data: {} },
      { id: "evt_created", type: "session.created", created: 2, data: { sessionID: "ses_test" } },
      { id: "evt_bad", type: "session.step.started", created: 3, data: { sessionID: "ses_test" } },
    ]
    expect(events.flatMap((event) => parseUsageEvent(event) ?? [])).toHaveLength(0)
    expect(reduceAll(events, 3)).toHaveLength(0)
  })
})

function executionStarted(id: string, created: number): EventEnvelope {
  return { id, created, type: "session.execution.started", durable, data: { sessionID: "ses_test" } }
}

function executionSucceeded(created: number): EventEnvelope {
  return {
    id: `evt_execution_succeeded_${created}`,
    created,
    type: "session.execution.succeeded",
    durable,
    data: { sessionID: "ses_test" },
  }
}

function executionFailed(created: number, error: ErrorInfo): EventEnvelope {
  return {
    id: `evt_execution_failed_${created}`,
    created,
    type: "session.execution.failed",
    durable,
    data: { sessionID: "ses_test", error },
  }
}

function executionInterrupted(created: number, reason: string): EventEnvelope {
  return {
    id: `evt_execution_interrupted_${created}`,
    created,
    type: "session.execution.interrupted",
    durable,
    data: { sessionID: "ses_test", reason },
  }
}

function inboxEnqueued(inboxID: string, type: string, delivery: string, created: number): EventEnvelope {
  return {
    id: `evt_enqueued_${inboxID}`,
    created,
    type: "session.inbox.enqueued",
    durable,
    data: { sessionID: "ses_test", inboxID, item: { type, delivery } },
  }
}

function inboxDelivered(inboxID: string, created: number): EventEnvelope {
  return {
    id: `evt_delivered_${inboxID}`,
    created,
    type: "session.inbox.delivered",
    durable,
    data: { sessionID: "ses_test", inboxID },
  }
}

function retryScheduled(created: number, error: ErrorInfo): EventEnvelope {
  return {
    id: `evt_retry_${created}`,
    created,
    type: "session.retry.scheduled",
    durable,
    data: { sessionID: "ses_test", assistantMessageID: "msg_assistant", attempt: 1, at: created + 500, error },
  }
}

function stepFailed(created: number, error: ErrorInfo): EventEnvelope {
  return {
    id: `evt_failed_${created}`,
    created,
    type: "session.step.failed",
    durable,
    data: { sessionID: "ses_test", assistantMessageID: "msg_assistant", error },
  }
}

function textStarted(created: number): EventEnvelope {
  return {
    id: `evt_text_${created}`,
    created,
    type: "session.text.started",
    durable,
    data: { sessionID: "ses_test", assistantMessageID: "msg_assistant", ordinal: 0 },
  }
}

function ended(created: number): EventEnvelope {
  return {
    id: `evt_ended_${created}`,
    created,
    type: "session.step.ended",
    durable,
    data: {
      sessionID: "ses_test",
      assistantMessageID: "msg_assistant",
      finish: "stop",
      cost: 0.001,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  }
}

function persist(store: UsageStore, result: { rows: readonly CallRow[]; turns: readonly TurnWrite[] }) {
  for (const row of result.rows) store.insert(row)
  for (const write of result.turns)
    if (write.kind === "insert") store.insertTurn(write.row)
    else store.updateTurn(write.turnID, write.progress)
}

type StoredRow = Record<string, unknown>

function storedTurn(dbPath: string, turnID: string) {
  return storedRow(dbPath, "SELECT * FROM turn WHERE turn_id = ?", turnID)
}

function storedCall(dbPath: string, callID: string) {
  return storedRow(dbPath, "SELECT * FROM call WHERE call_id = ?", callID)
}

function storedRow(dbPath: string, sql: string, id: string) {
  const db = new Database(dbPath, { readonly: true })
  const row = db.query<StoredRow, [string]>(sql).get(id)
  db.close()
  return row
}

function countRows(dbPath: string, table: "call" | "turn") {
  const db = new Database(dbPath, { readonly: true })
  const row = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
  db.close()
  return row?.n ?? 0
}
