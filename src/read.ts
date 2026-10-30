import { Database } from "bun:sqlite"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import type { MessageRecord, SessionRecord, TurnRecord } from "./query"
import type { CallRow } from "./reducer"

// Only an explicit boolean true marks a session as internal. Malformed metadata,
// missing metadata, and string values such as "true" stay non-internal.
export function isInternalMetadata(metadata: string | null | undefined) {
  if (metadata === null || metadata === undefined) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return false
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false
  return (parsed as Record<string, unknown>).oc2InternalTest === true
}

export type DatabaseCandidate = {
  readonly path: string
  readonly mtimeMs: number
}

// The candidate list is filesystem input for `selectAuthoritativeDatabase`, so the
// selection logic stays pure and testable without touching disk.
export function listDatabaseCandidates(directory: string): readonly DatabaseCandidate[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("opencode") && entry.name.endsWith(".db"))
    .map((entry) => {
      const file = path.join(directory, entry.name)
      return { path: file, mtimeMs: statSync(file).mtimeMs }
    })
}

export type AuthoritativeSelection =
  | { readonly ok: true; readonly path: string; readonly source: "flag" | "env" | "scan" }
  | { readonly ok: false; readonly message: string }

// Resolution order matches the server: explicit flag, then OPENCODE_DB, then the
// newest opencode*.db in the data directory. The data directory itself is resolved
// by the caller so this selection stays independent of the filesystem.
export function selectAuthoritativeDatabase(options: {
  readonly dataDirectory: string
  readonly candidates: readonly DatabaseCandidate[]
  readonly explicitPath?: string | null
  readonly envPath?: string | null
}): AuthoritativeSelection {
  if (options.explicitPath) return { ok: true, path: options.explicitPath, source: "flag" }

  if (options.envPath)
    return {
      ok: true,
      path: path.isAbsolute(options.envPath) ? options.envPath : path.resolve(options.dataDirectory, options.envPath),
      source: "env",
    }

  const newest = options.candidates
    .filter((candidate) => {
      const name = path.basename(candidate.path)
      return name.startsWith("opencode") && name.endsWith(".db") && name !== "usage.db"
    })
    .reduce<DatabaseCandidate | undefined>((best, candidate) => {
      if (!best) return candidate
      if (candidate.mtimeMs > best.mtimeMs) return candidate
      if (candidate.mtimeMs === best.mtimeMs && candidate.path < best.path) return candidate
      return best
    }, undefined)

  if (!newest)
    return {
      ok: false,
      message: `no authoritative OpenCode database found in ${options.dataDirectory} (looked for opencode*.db; pass --sessions-db <path> or set OPENCODE_DB)`,
    }
  return { ok: true, path: newest.path, source: "scan" }
}

type RawCall = {
  call_id: string
  assistant_message_id: string | null
  session_id: string
  parent_session_id: string | null
  kind: string
  agent: string | null
  provider_id: string | null
  model_id: string | null
  model_variant: string | null
  directory: string | null
  started_at: number | null
  first_token_at: number | null
  first_text_at: number | null
  streamed_at: number | null
  ended_at: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  cost_usd: number | null
  finish: string | null
  raw_finish: string | null
  status: string
  error: string | null
  // Columns added by schema v2; absent when reading a sidecar that has not migrated yet.
  turn_id?: string | null
  error_type?: string | null
  error_message?: string | null
  error_status?: number | null
  error_retry_after_ms?: number | null
  retries?: number | null
  last_retry_error_type?: string | null
  last_retry_at?: number | null
  recorded_at: number
}

export function readCalls(db: Database): readonly CallRow[] {
  return db.query<RawCall, []>("SELECT * FROM call").all().map((row) => ({
    callID: row.call_id,
    assistantMessageID: row.assistant_message_id,
    sessionID: row.session_id,
    parentSessionID: row.parent_session_id,
    kind: row.kind as CallRow["kind"],
    agent: row.agent,
    providerID: row.provider_id,
    modelID: row.model_id,
    modelVariant: row.model_variant,
    directory: row.directory,
    startedAt: row.started_at,
    firstTokenAt: row.first_token_at,
    firstTextAt: row.first_text_at,
    streamedAt: row.streamed_at,
    endedAt: row.ended_at,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    tokensReasoning: row.tokens_reasoning,
    tokensCacheRead: row.tokens_cache_read,
    tokensCacheWrite: row.tokens_cache_write,
    costUSD: row.cost_usd,
    finish: row.finish,
    rawFinish: row.raw_finish,
    status: row.status as CallRow["status"],
    error: row.error,
    turnID: row.turn_id ?? null,
    errorType: row.error_type ?? null,
    errorMessage: row.error_message ?? null,
    errorStatus: row.error_status ?? null,
    errorRetryAfterMs: row.error_retry_after_ms ?? null,
    retries: row.retries ?? 0,
    lastRetryErrorType: row.last_retry_error_type ?? null,
    lastRetryAt: row.last_retry_at ?? null,
    recordedAt: row.recorded_at,
  }))
}

type RawTurn = {
  turn_id: string
  session_id: string
  directory: string | null
  queued_at: number | null
  accepted_at: number | null
  started_at: number
  ended_at: number | null
  status: string
  interrupt_reason: string | null
  error_type: string | null
  error_message: string | null
  error_status: number | null
  prompts: number
  compactions: number
  steers: number
  retries: number
  first_token_at: number | null
  recorded_at: number
  updated_at: number
}

export function readTurns(db: Database): readonly TurnRecord[] {
  const present = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'turn'")
    .get()
  if (!present || present.n === 0) return []
  return db.query<RawTurn, []>("SELECT * FROM turn").all().map((row) => ({
    turnID: row.turn_id,
    sessionID: row.session_id,
    directory: row.directory,
    queuedAt: row.queued_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status as TurnRecord["status"],
    interruptReason: row.interrupt_reason,
    errorType: row.error_type,
    errorMessage: row.error_message,
    errorStatus: row.error_status,
    prompts: row.prompts,
    compactions: row.compactions,
    steers: row.steers,
    retries: row.retries,
    firstTokenAt: row.first_token_at,
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at,
  }))
}

type RawSession = {
  id: string
  title: string | null
  metadata: string | null
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  time_created: number
  time_updated: number
}

export function readSessions(db: Database): readonly SessionRecord[] {
  return db
    .query<RawSession, []>(
      `SELECT id, title, metadata, cost, tokens_input, tokens_output, tokens_reasoning,
              tokens_cache_read, tokens_cache_write, time_created, time_updated
       FROM session_v2`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      internal: isInternalMetadata(row.metadata),
      costUSD: row.cost,
      tokensInput: row.tokens_input,
      tokensOutput: row.tokens_output,
      tokensReasoning: row.tokens_reasoning,
      tokensCacheRead: row.tokens_cache_read,
      tokensCacheWrite: row.tokens_cache_write,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    }))
}

export type ProjectRecord = {
  readonly id: string
  readonly name: string | null
  readonly worktree: string
}

export type SessionProjectRecord = {
  readonly sessionID: string
  readonly projectID: string
}

export type ProjectDirectory = {
  readonly projects: readonly ProjectRecord[]
  readonly sessionProjects: readonly SessionProjectRecord[]
}

type RawProject = {
  id: string
  name: string | null
  worktree: string
}

type RawSessionProject = {
  session_id: string
  project_id: string
}

/**
 * Authoritative project names and the session → project mapping. Kept separate
 * from `readSessions` so existing callers keep their narrower row shape.
 */
export function readProjectDirectory(db: Database): ProjectDirectory {
  return {
    projects: db
      .query<RawProject, []>("SELECT id, name, worktree FROM project")
      .all()
      .map((row) => ({ id: row.id, name: row.name, worktree: row.worktree })),
    sessionProjects: db
      .query<RawSessionProject, []>("SELECT id AS session_id, project_id FROM session_v2")
      .all()
      .map((row) => ({ sessionID: row.session_id, projectID: row.project_id })),
  }
}

export type CredentialRecord = {
  readonly id: string
  readonly integrationID: string
  readonly label: string
  readonly active: boolean
  /** OAuth tokens and API keys, exactly as the server stores them. */
  readonly value:
    | { readonly type: "key"; readonly key: string }
    | { readonly type: "oauth"; readonly access: string; readonly refresh?: string }
    | { readonly type: "external" }
  readonly metadata: Readonly<Record<string, unknown>>
}

type RawCredential = {
  id: string
  integration_id: string
  label: string
  active: number | null
  value: string
}

/**
 * Connected credentials, for the provider status view.
 *
 * The dashboard never writes these and never logs them; only the integration id,
 * active flag, and the non-secret metadata reach the browser.
 */
export function readCredentials(db: Database): readonly CredentialRecord[] {
  return db
    .query<RawCredential, []>(
      "SELECT id, integration_id, label, active, value FROM credential ORDER BY integration_id, label",
    )
    .all()
    .flatMap((row) => {
      const value = parseCredentialValue(row.value)
      if (value === null) return []
      return [
        {
          id: row.id,
          integrationID: row.integration_id,
          label: row.label,
          active: row.active === 1,
          value: value.value,
          metadata: value.metadata,
        },
      ]
    })
}

/** Tolerates schema drift: a value we cannot read drops that one credential. */
function parseCredentialValue(raw: string): { value: CredentialRecord["value"]; metadata: Record<string, unknown> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const entry = parsed as Record<string, unknown>
  const metadata = entry.metadata
  const meta =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {}
  if (entry.type === "key" && typeof entry.key === "string") return { value: { type: "key", key: entry.key }, metadata: meta }
  if (entry.type === "oauth" && typeof entry.access === "string")
    return {
      value: {
        type: "oauth",
        access: entry.access,
        ...(typeof entry.refresh === "string" ? { refresh: entry.refresh } : {}),
      },
      metadata: meta,
    }
  if (entry.type === "external") return { value: { type: "external" }, metadata: meta }
  return null
}

type RawMessage = {
  id: string
  session_id: string
  type: string
  time_created: number
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  provider_id: string | null
  model_id: string | null
}

export function readMessages(db: Database): readonly MessageRecord[] {
  // JSON extraction keeps message content and tool payloads out of memory.
  return db
    .query<RawMessage, []>(
      `SELECT id, session_id, type, time_created,
              json_extract(data, '$.cost') AS cost,
              json_extract(data, '$.tokens.input') AS tokens_input,
              json_extract(data, '$.tokens.output') AS tokens_output,
              json_extract(data, '$.tokens.reasoning') AS tokens_reasoning,
              json_extract(data, '$.tokens.cache.read') AS tokens_cache_read,
              json_extract(data, '$.tokens.cache.write') AS tokens_cache_write,
              json_extract(data, '$.model.providerID') AS provider_id,
              json_extract(data, '$.model.id') AS model_id
       FROM session_message
       WHERE type IN ('user', 'assistant')
       ORDER BY time_created`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      sessionID: row.session_id,
      type: row.type,
      timeCreated: row.time_created,
      costUSD: row.cost,
      tokensInput: row.tokens_input,
      tokensOutput: row.tokens_output,
      tokensReasoning: row.tokens_reasoning,
      tokensCacheRead: row.tokens_cache_read,
      tokensCacheWrite: row.tokens_cache_write,
      providerID: row.provider_id,
      modelID: row.model_id,
    }))
}
