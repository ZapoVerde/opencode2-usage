import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CallRow, TurnRow } from "../src/reducer"
import { migrateSchema, openStore } from "../src/store"

const root = mkdtempSync(path.join(os.tmpdir(), "opencode2-usage-store-"))

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("store connections", () => {
  test("two stores for the same resolved path share one connection", () => {
    const dbPath = path.join(root, "shared.db")
    const first = openStore(dbPath)
    const second = openStore(path.join(root, ".", "shared.db"))

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)

    first.insert(row("call_shared"))
    second.insert(row("call_shared"))
    expect(second.count("call_shared")).toBe(1)
  })

  test("stores for different paths do not share a connection", () => {
    const first = openStore(path.join(root, "first.db"))
    const second = openStore(path.join(root, "second.db"))

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(false)

    first.insert(row("call_first"))
    expect(first.count("call_first")).toBe(1)
    expect(second.count("call_first")).toBe(0)
  })

  test("a schema-version bump reopens the cached connection", () => {
    const dbPath = path.join(root, "reloaded.db")
    const first = openStore(dbPath)
    expect(first.reused).toBe(false)
    const registry = (
      globalThis as unknown as Record<symbol, Map<string, { schemaVersion?: number }> | undefined>
    )[Symbol.for("opencode2-usage.store.connections")]
    const cached = registry?.get(path.resolve(dbPath))
    expect(cached?.schemaVersion).toBe(2)
    // A generation loaded before schema v2 lives in the same process registry.
    if (cached) cached.schemaVersion = 1

    const reopened = openStore(dbPath)
    expect(reopened.reused).toBe(false)

    reopened.insertTurn(turn("evt_reload"))
    const db = new Database(dbPath, { readonly: true })
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM turn").get()?.n).toBe(1)
    db.close()
  })
})

describe("schema migration", () => {
  test("an old-shaped call table gains the new columns once and keeps its rows", () => {
    const dbPath = path.join(root, "legacy.db")
    const db = new Database(dbPath, { create: true })
    db.exec(legacySchema)
    db.prepare(
      "INSERT INTO call (call_id, session_id, kind, status, error, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("call_aborted", "ses_legacy", "step", "failed", "aborted: Step interrupted", 1_000)
    db.prepare(
      "INSERT INTO call (call_id, session_id, kind, status, error, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("call_unknown", "ses_legacy", "step", "failed", "mystery: not a known type", 2_000)

    migrateSchema(db)
    const columnsAfterFirst = tableColumns(db, "call")
    const rowsAfterFirst = db.query<Record<string, unknown>, []>("SELECT * FROM call ORDER BY call_id").all()
    migrateSchema(db)

    expect(tableColumns(db, "call")).toEqual(columnsAfterFirst)
    expect(db.query<Record<string, unknown>, []>("SELECT * FROM call ORDER BY call_id").all()).toEqual(rowsAfterFirst)
    expect(columnsAfterFirst).toEqual(expect.arrayContaining(addedColumns))
    expect(columnsAfterFirst.filter((name) => name === "turn_id")).toHaveLength(1)
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM call").get()?.n).toBe(2)
    expect(rowsAfterFirst[0]).toMatchObject({
      call_id: "call_aborted",
      error: "aborted: Step interrupted",
      error_type: "aborted",
      retries: 0,
    })
    expect(rowsAfterFirst[1]).toMatchObject({
      call_id: "call_unknown",
      error: "mystery: not a known type",
      error_type: null,
      retries: 0,
    })
    expect(tableColumns(db, "turn")).toEqual(expect.arrayContaining(turnColumns))

    db.close()
    const store = openStore(dbPath)
    expect(store.count()).toBe(2)
    store.insert(row("call_after_migration"))
    expect(store.count()).toBe(3)
  })
})

describe("turn writes", () => {
  test("insert is idempotent and progress takes the highest counter and earliest timestamp", () => {
    const dbPath = path.join(root, "turns.db")
    const store = openStore(dbPath)
    store.insertTurn(turn("evt_turn"))
    store.insertTurn(turn("evt_turn"))
    store.updateTurn("evt_turn", {
      status: "completed",
      endedAt: 2_000,
      prompts: 2,
      steers: 1,
      retries: 1,
      firstTokenAt: 1_500,
      updatedAt: 2_000,
    })
    // A late instance with a shorter prefix of the stream must not lower the row.
    store.updateTurn("evt_turn", { prompts: 1, steers: 0, retries: 0, firstTokenAt: 1_800, updatedAt: 2_001 })

    const db = new Database(dbPath, { readonly: true })
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM turn").get()?.n).toBe(1)
    expect(db.query<Record<string, unknown>, []>("SELECT * FROM turn").get()).toMatchObject({
      turn_id: "evt_turn",
      status: "completed",
      ended_at: 2_000,
      prompts: 2,
      steers: 1,
      retries: 1,
      first_token_at: 1_500,
      updated_at: 2_001,
    })
    db.close()
  })
})

const addedColumns = [
  "turn_id",
  "error_type",
  "error_message",
  "error_status",
  "error_retry_after_ms",
  "retries",
  "last_retry_error_type",
  "last_retry_at",
]

const turnColumns = [
  "turn_id",
  "session_id",
  "directory",
  "queued_at",
  "accepted_at",
  "started_at",
  "ended_at",
  "status",
  "interrupt_reason",
  "error_type",
  "error_message",
  "error_status",
  "prompts",
  "compactions",
  "steers",
  "retries",
  "first_token_at",
  "recorded_at",
  "updated_at",
]

const legacySchema = `
CREATE TABLE call (
  call_id TEXT PRIMARY KEY,
  assistant_message_id TEXT,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  kind TEXT NOT NULL,
  agent TEXT,
  provider_id TEXT,
  model_id TEXT,
  model_variant TEXT,
  directory TEXT,
  started_at INTEGER,
  first_token_at INTEGER,
  first_text_at INTEGER,
  streamed_at INTEGER,
  ended_at INTEGER,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  cost_usd REAL,
  finish TEXT,
  raw_finish TEXT,
  status TEXT NOT NULL,
  error TEXT,
  recorded_at INTEGER NOT NULL
);
`

function tableColumns(db: Database, table: string) {
  return db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((column) => column.name)
}

function turn(turnID: string): TurnRow {
  return {
    turnID,
    sessionID: "ses_store_test",
    directory: root,
    queuedAt: 900,
    acceptedAt: 950,
    startedAt: 1_000,
    endedAt: null,
    status: "running",
    interruptReason: null,
    errorType: null,
    errorMessage: null,
    errorStatus: null,
    prompts: 0,
    compactions: 0,
    steers: 0,
    retries: 0,
    firstTokenAt: null,
    recordedAt: 1_000,
    updatedAt: 1_000,
  }
}

function row(callID: string): CallRow {
  return {
    callID,
    assistantMessageID: null,
    sessionID: "ses_store_test",
    parentSessionID: null,
    kind: "step",
    agent: "test",
    providerID: "mock",
    modelID: "mock-model",
    modelVariant: null,
    directory: root,
    startedAt: 1_000,
    firstTokenAt: 1_100,
    firstTextAt: 1_200,
    streamedAt: 1_300,
    endedAt: 1_400,
    tokensInput: 1,
    tokensOutput: 2,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUSD: 0.001,
    finish: "stop",
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
    recordedAt: 1_400,
  }
}
