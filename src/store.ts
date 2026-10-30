import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CallRow, TurnProgress, TurnRow } from "./reducer"
import { isKnownErrorType } from "./types"

export type UsageStore = {
  readonly path: string
  /** True when this store reused a connection already open for the same path. */
  readonly reused: boolean
  insert(row: CallRow): void
  insertTurn(row: TurnRow): void
  updateTurn(turnID: string, progress: TurnProgress): void
  count(callID?: string): number
  close(): void
}

/**
 * Bumped whenever the prepared statements change. A hot-reloaded plugin shares
 * the process-wide connection registry with the generation it replaced, so the
 * old handle is discarded and reopened to migrate the sidecar and reprepare
 * statements that include the new columns.
 */
const SCHEMA_VERSION = 2

const schema = `
CREATE TABLE IF NOT EXISTS call (
  call_id TEXT PRIMARY KEY,
  assistant_message_id TEXT,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  kind TEXT NOT NULL,               -- 'step' | 'compaction'
  agent TEXT,
  provider_id TEXT,
  model_id TEXT,
  model_variant TEXT,
  directory TEXT,
  started_at INTEGER,               -- dispatch epoch ms; NULL for compaction
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
  status TEXT NOT NULL,             -- completed | failed | retried | interrupted
  error TEXT,                       -- combined 'type: message', kept for compatibility
  turn_id TEXT,                     -- session.execution.started event id; NULL when unknown
  error_type TEXT,
  error_message TEXT,
  error_status INTEGER,
  error_retry_after_ms INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  last_retry_error_type TEXT,
  last_retry_at INTEGER,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_session ON call(session_id, started_at);
CREATE INDEX IF NOT EXISTS call_started ON call(started_at);
CREATE INDEX IF NOT EXISTS call_model ON call(provider_id, model_id);

CREATE TABLE IF NOT EXISTS turn (
  turn_id TEXT PRIMARY KEY,          -- session.execution.started event id
  session_id TEXT NOT NULL,
  directory TEXT,
  queued_at INTEGER,                 -- earliest inbox.enqueued in the round
  accepted_at INTEGER,               -- earliest inbox.delivered in the round
  started_at INTEGER NOT NULL,       -- execution.started event time
  ended_at INTEGER,
  status TEXT NOT NULL,              -- running | completed | failed | interrupted
  interrupt_reason TEXT,             -- user | shutdown | superseded | inactivity
  error_type TEXT,
  error_message TEXT,
  error_status INTEGER,
  prompts INTEGER NOT NULL DEFAULT 0,     -- user + synthetic deliveries
  compactions INTEGER NOT NULL DEFAULT 0, -- compaction deliveries
  steers INTEGER NOT NULL DEFAULT 0,      -- deliveries with mode "steer"
  retries INTEGER NOT NULL DEFAULT 0,     -- retry.scheduled events seen in the round
  first_token_at INTEGER,                 -- earliest first_token_at among the round's calls
  recorded_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_session ON turn(session_id, started_at);
CREATE INDEX IF NOT EXISTS turn_started ON turn(started_at);
`

/** Columns added after the first sidecar release. Existing databases are migrated in place. */
const addedCallColumns = [
  ["turn_id", "TEXT"],
  ["error_type", "TEXT"],
  ["error_message", "TEXT"],
  ["error_status", "INTEGER"],
  ["error_retry_after_ms", "INTEGER"],
  ["retries", "INTEGER NOT NULL DEFAULT 0"],
  ["last_retry_error_type", "TEXT"],
  ["last_retry_at", "INTEGER"],
] as const

// Concurrent plugin instances compute the same event-derived call id; the first insert wins.
const insertCall = `
INSERT OR IGNORE INTO call (
  call_id, assistant_message_id, session_id, parent_session_id, kind, agent,
  provider_id, model_id, model_variant, directory, started_at, first_token_at,
  first_text_at, streamed_at, ended_at, tokens_input, tokens_output,
  tokens_reasoning, tokens_cache_read, tokens_cache_write, cost_usd, finish,
  raw_finish, status, error, turn_id, error_type, error_message, error_status,
  error_retry_after_ms, retries, last_retry_error_type, last_retry_at, recorded_at
) VALUES (
  $call_id, $assistant_message_id, $session_id, $parent_session_id, $kind, $agent,
  $provider_id, $model_id, $model_variant, $directory, $started_at, $first_token_at,
  $first_text_at, $streamed_at, $ended_at, $tokens_input, $tokens_output,
  $tokens_reasoning, $tokens_cache_read, $tokens_cache_write, $cost_usd, $finish,
  $raw_finish, $status, $error, $turn_id, $error_type, $error_message, $error_status,
  $error_retry_after_ms, $retries, $last_retry_error_type, $last_retry_at, $recorded_at
)
`

// The started event id is the turn identity, so duplicate writers collapse on insert.
const insertTurn = `
INSERT OR IGNORE INTO turn (
  turn_id, session_id, directory, queued_at, accepted_at, started_at, ended_at,
  status, interrupt_reason, error_type, error_message, error_status, prompts,
  compactions, steers, retries, first_token_at, recorded_at, updated_at
) VALUES (
  $turn_id, $session_id, $directory, $queued_at, $accepted_at, $started_at, $ended_at,
  $status, $interrupt_reason, $error_type, $error_message, $error_status, $prompts,
  $compactions, $steers, $retries, $first_token_at, $recorded_at, $updated_at
)
`

// Every instance sees every event, so progress converges by taking the highest
// counter and the earliest timestamp rather than overwriting a peer's write.
const updateTurn = `
UPDATE turn SET
  status = COALESCE($status, status),
  directory = CASE WHEN $directory IS NULL THEN directory ELSE $directory END,
  ended_at = COALESCE(ended_at, $ended_at),
  interrupt_reason = COALESCE($interrupt_reason, interrupt_reason),
  error_type = COALESCE($error_type, error_type),
  error_message = COALESCE($error_message, error_message),
  error_status = COALESCE($error_status, error_status),
  prompts = CASE WHEN $prompts IS NULL THEN prompts ELSE MAX(prompts, $prompts) END,
  compactions = CASE WHEN $compactions IS NULL THEN compactions ELSE MAX(compactions, $compactions) END,
  steers = CASE WHEN $steers IS NULL THEN steers ELSE MAX(steers, $steers) END,
  retries = CASE WHEN $retries IS NULL THEN retries ELSE MAX(retries, $retries) END,
  first_token_at = CASE
    WHEN $first_token_at IS NULL THEN first_token_at
    WHEN first_token_at IS NULL THEN $first_token_at
    ELSE MIN(first_token_at, $first_token_at)
  END,
  accepted_at = CASE
    WHEN $accepted_at IS NULL THEN accepted_at
    WHEN accepted_at IS NULL THEN $accepted_at
    ELSE MIN(accepted_at, $accepted_at)
  END,
  queued_at = CASE
    WHEN $queued_at IS NULL THEN queued_at
    WHEN queued_at IS NULL THEN $queued_at
    ELSE MIN(queued_at, $queued_at)
  END,
  updated_at = MAX(updated_at, $updated_at)
WHERE turn_id = $turn_id
`

export function defaultDatabasePath() {
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "usage.db")
}

/** `dbPath` plugin option wins over `OPENCODE_USAGE_DB`, which wins over the XDG default. */
export function resolveDatabasePath(options: Readonly<Record<string, unknown>>) {
  const configured = options.dbPath
  if (typeof configured === "string" && configured.length > 0) return configured
  return process.env.OPENCODE_USAGE_DB ?? defaultDatabasePath()
}

export function openStore(dbPath: string): UsageStore {
  const key = storeKey(dbPath)
  const registry = connections()
  const existing = registry.get(key)
  const connection = existing?.schemaVersion === SCHEMA_VERSION ? existing : connect(dbPath)
  if (connection !== existing) registry.set(key, connection)
  return {
    path: dbPath,
    reused: connection === existing,
    insert(row) {
      connection.insert.run({
        $call_id: row.callID,
        $assistant_message_id: row.assistantMessageID,
        $session_id: row.sessionID,
        $parent_session_id: row.parentSessionID,
        $kind: row.kind,
        $agent: row.agent,
        $provider_id: row.providerID,
        $model_id: row.modelID,
        $model_variant: row.modelVariant,
        $directory: row.directory,
        $started_at: row.startedAt,
        $first_token_at: row.firstTokenAt,
        $first_text_at: row.firstTextAt,
        $streamed_at: row.streamedAt,
        $ended_at: row.endedAt,
        $tokens_input: row.tokensInput,
        $tokens_output: row.tokensOutput,
        $tokens_reasoning: row.tokensReasoning,
        $tokens_cache_read: row.tokensCacheRead,
        $tokens_cache_write: row.tokensCacheWrite,
        $cost_usd: row.costUSD,
        $finish: row.finish,
        $raw_finish: row.rawFinish,
        $status: row.status,
        $error: row.error,
        $turn_id: row.turnID,
        $error_type: row.errorType,
        $error_message: row.errorMessage,
        $error_status: row.errorStatus,
        $error_retry_after_ms: row.errorRetryAfterMs,
        $retries: row.retries,
        $last_retry_error_type: row.lastRetryErrorType,
        $last_retry_at: row.lastRetryAt,
        $recorded_at: row.recordedAt,
      })
    },
    insertTurn(row) {
      connection.insertTurn.run({
        $turn_id: row.turnID,
        $session_id: row.sessionID,
        $directory: row.directory,
        $queued_at: row.queuedAt,
        $accepted_at: row.acceptedAt,
        $started_at: row.startedAt,
        $ended_at: row.endedAt,
        $status: row.status,
        $interrupt_reason: row.interruptReason,
        $error_type: row.errorType,
        $error_message: row.errorMessage,
        $error_status: row.errorStatus,
        $prompts: row.prompts,
        $compactions: row.compactions,
        $steers: row.steers,
        $retries: row.retries,
        $first_token_at: row.firstTokenAt,
        $recorded_at: row.recordedAt,
        $updated_at: row.updatedAt,
      })
    },
    updateTurn(turnID, progress) {
      connection.updateTurn.run({
        $turn_id: turnID,
        $status: progress.status ?? null,
        $directory: progress.directory ?? null,
        $ended_at: progress.endedAt ?? null,
        $interrupt_reason: progress.interruptReason ?? null,
        $error_type: progress.errorType ?? null,
        $error_message: progress.errorMessage ?? null,
        $error_status: progress.errorStatus ?? null,
        $prompts: progress.prompts ?? null,
        $compactions: progress.compactions ?? null,
        $steers: progress.steers ?? null,
        $retries: progress.retries ?? null,
        $first_token_at: progress.firstTokenAt ?? null,
        $accepted_at: progress.acceptedAt ?? null,
        $queued_at: progress.queuedAt ?? null,
        $updated_at: progress.updatedAt,
      })
    },
    count(callID) {
      const row = callID === undefined ? connection.countAll.get() : connection.countCall.get(callID)
      return row?.n ?? 0
    },
    close() {
      // The connection is shared by every plugin instance loaded for this path, so
      // one instance's teardown must not close it while another may still write.
      // The process owns the connection lifetime; process exit closes it.
    },
  }
}

type Connection = ReturnType<typeof connect>

// Plugin reload re-evaluates this module, so the registry must survive on
// globalThis. This mirrors how in-process plugins keep reload-durable state.
const CONNECTIONS = Symbol.for("opencode2-usage.store.connections")

function connections() {
  const globals = globalThis as unknown as Record<symbol, Map<string, Connection> | undefined>
  return (globals[CONNECTIONS] ??= new Map())
}

/** In-memory databases belong to one connection, so each open gets its own key. */
function storeKey(dbPath: string) {
  return dbPath === ":memory:" ? `${dbPath}:${crypto.randomUUID()}` : path.resolve(dbPath)
}

function connect(dbPath: string) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  migrateSchema(db)
  return {
    schemaVersion: SCHEMA_VERSION,
    insert: db.prepare(insertCall),
    insertTurn: db.prepare(insertTurn),
    updateTurn: db.prepare(updateTurn),
    countAll: db.query<{ n: number }, []>("SELECT count(*) AS n FROM call"),
    countCall: db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM call WHERE call_id = ?"),
  }
}

/**
 * Create the current schema, then add any columns the live sidecar predates.
 * `ALTER TABLE ADD COLUMN` runs only for missing names so existing rows survive
 * and a second open is a no-op. Exported for the migration test.
 */
export function migrateSchema(db: Database) {
  db.exec(schema)
  const columns = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('call')")
      .all()
      .map((column) => column.name),
  )
  for (const [name, definition] of addedCallColumns)
    if (!columns.has(name)) db.exec(`ALTER TABLE call ADD COLUMN ${name} ${definition}`)
  db.exec("CREATE INDEX IF NOT EXISTS call_turn ON call(turn_id)")
  backfillErrorTypes(db)
}

/**
 * Earlier releases stored only the combined `error` text. Recover the structured
 * type when its prefix is a known classification; unknown prefixes stay NULL.
 */
function backfillErrorTypes(db: Database) {
  const rows = db
    .query<{ call_id: string; error: string }, []>(
      "SELECT call_id, error FROM call WHERE error_type IS NULL AND error IS NOT NULL",
    )
    .all()
  const update = db.prepare("UPDATE call SET error_type = $error_type WHERE call_id = $call_id")
  for (const row of rows) {
    const match = /^([a-z][a-z0-9.-]*): /.exec(row.error)
    if (!match || !isKnownErrorType(match[1]!)) continue
    update.run({ $error_type: match[1]!, $call_id: row.call_id })
  }
}
