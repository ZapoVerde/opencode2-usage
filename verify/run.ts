/**
 * Isolated end-to-end verification. It never touches the live OpenCode state:
 * every XDG directory lives under /tmp/oc2-usage-verify.
 *
 * Usage: bun verify/run.ts
 */
import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { startMockProvider } from "./mock-provider"
import type { CallRow } from "../src/reducer"
import { openStore } from "../src/store"

const CLI_DIR = "/config/workspace/opencode2/packages/cli"
const PLUGIN_DIR = "/config/workspace/opencode2-usage"
const PLUGIN_ID = "opencode2-usage"
const PASSWORD = "oc2-usage-verify"
const ROOT = "/tmp/oc2-usage-verify"
const PROJECT = path.join(ROOT, "project")
const CONFIG = path.join(ROOT, "config")
const DATA = path.join(ROOT, "data")
const STATE = path.join(ROOT, "state")
const CACHE = path.join(ROOT, "cache")
const AUTH = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64")
const SESSION_TITLE = "[OC2 internal test] usage verify"
const SESSION_METADATA = {
  oc2InternalTest: true,
  oc2InternalTestOrigin: "opencode2-usage verify/run.ts",
} as const

const provider = startMockProvider()
mkdirs()
writeConfig(provider.url)

const databasePath = path.join(DATA, "opencode", "usage.db")
const summary: unknown[] = []
const servers: Server[] = []

type Server = {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly url: string
  readonly log: string
}

try {
  const first = await startServer()
  await waitForPlugin(first.url)

  const firstSession = await prompt(first.url, "Say hello from the first server.")
  const firstRow = await waitForCompletedStep(firstSession)
  assert.equal(firstRow.kind, "step")
  assert.equal(firstRow.status, "completed")
  assert.equal(firstRow.provider_id, "mock")
  assert.equal(firstRow.model_id, "mock-model")
  assert.equal(firstRow.session_id, firstSession)
  assert.notEqual(firstRow.first_token_at, null)
  assert.notEqual(firstRow.started_at, null)
  assert.ok(Number(firstRow.first_token_at) >= Number(firstRow.started_at))
  assert.ok(Number(firstRow.streamed_at) >= Number(firstRow.first_token_at))
  assert.ok(Number(firstRow.tokens_output) > 0)
  assert.equal(typeof firstRow.cost_usd, "number")

  const firstTurn = await waitForTurn(firstSession, "completed")
  assert.equal(firstRow.turn_id, firstTurn.turn_id)
  assertRound(firstTurn)
  assert.equal(firstTurn.prompts, 1)
  assert.equal(firstTurn.retries, 0)
  assert.notEqual(firstTurn.first_token_at, null)

  const firstTTFT = Number(firstRow.first_token_at) - Number(firstRow.started_at)
  const firstSnapshot = JSON.stringify(firstRow)
  const firstTurnSnapshot = JSON.stringify(firstTurn)
  summary.push({ phase: "first", session: firstSession, row: firstRow, turn: firstTurn, ttftMs: firstTTFT })

  const retrySession = await prompt(first.url, "[[fail:429]] Say hello after a rate limit.")
  const retryRows = await waitForSteps(
    retrySession,
    (rows) => rows.some((row) => row.status === "retried") && rows.some((row) => row.status === "completed"),
  )
  const retriedRow = retryRows.find((row) => row.status === "retried")
  const retryCompletedRow = retryRows.find((row) => row.status === "completed")
  assert.ok(retriedRow, "expected a retried attempt row")
  assert.ok(retryCompletedRow, "expected the retried attempt to complete")
  const retryTurn = await waitForTurn(retrySession, "completed")
  assertRound(retryTurn)
  assert.equal(retryTurn.retries, 1)
  assert.equal(retryTurn.prompts, 1)
  assert.equal(retriedRow.call_id === retryCompletedRow.call_id, false)
  assert.equal(retriedRow.turn_id, retryTurn.turn_id)
  assert.equal(retryCompletedRow.turn_id, retryTurn.turn_id)
  assert.equal(retriedRow.retries, 1)
  assert.equal(retriedRow.last_retry_error_type, "provider.rate-limit")
  assert.equal(retryCompletedRow.retries, 0)
  assert.notEqual(retriedRow.last_retry_at, null)
  summary.push({ phase: "retry", session: retrySession, rows: retryRows, turn: retryTurn })

  const failedSession = await prompt(first.url, "[[fail:500]] Say hello and fail.")
  const failedRow = await waitForFailedStep(failedSession)
  const failedTurn = await waitForTurn(failedSession, "failed")
  assert.equal(failedRow.error_type, "provider.internal")
  assert.equal(failedRow.error_status, 500)
  assert.match(failedRow.error ?? "", /^provider\.internal: /)
  assertRound(failedTurn)
  assert.equal(failedTurn.error_type, "provider.internal")
  assert.equal(failedTurn.error_status, 500)
  assert.equal(failedTurn.prompts, 1)
  summary.push({ phase: "failed", session: failedSession, row: failedRow, turn: failedTurn })

  await stopServer(first)
  await Bun.sleep(500)

  const second = await startServer()
  await waitForPlugin(second.url)
  const secondSession = await prompt(second.url, "Say hello from the restarted server.")
  const secondRow = await waitForCompletedStep(secondSession)
  const secondTurn = await waitForTurn(secondSession, "completed")
  assert.notEqual(secondRow.call_id, firstRow.call_id)
  assert.equal(secondRow.status, "completed")
  assert.equal(secondRow.turn_id, secondTurn.turn_id)
  assertRound(secondTurn)

  const allSteps = stepRows()
  assert.equal(allSteps.length, 5, `expected five step rows, got ${allSteps.length}`)
  assert.equal(new Set(allSteps.map((row) => row.call_id)).size, 5)
  assert.equal(allSteps.filter((row) => row.session_id === firstSession).length, 1)
  assert.equal(allSteps.filter((row) => row.session_id === retrySession).length, 2)
  assert.equal(allSteps.filter((row) => row.session_id === failedSession).length, 1)
  assert.equal(allSteps.filter((row) => row.session_id === secondSession).length, 1)
  assert.equal(JSON.stringify(allSteps.find((row) => row.session_id === firstSession)), firstSnapshot)
  assert.equal(JSON.stringify(turnRows(firstSession)[0]), firstTurnSnapshot)

  const allTurns = turnRows()
  assert.equal(allTurns.length, 4)
  assert.equal(allTurns.filter((turn) => turn.status === "completed").length, 3)
  assert.equal(allTurns.filter((turn) => turn.status === "failed").length, 1)

  const concurrentCallID = "evt_verify_concurrent"
  const concurrent: CallRow = {
    callID: concurrentCallID,
    assistantMessageID: "msg_verify_concurrent",
    sessionID: "ses_verify_concurrent",
    parentSessionID: null,
    kind: "step",
    agent: "verify",
    providerID: "mock",
    modelID: "mock-model",
    modelVariant: null,
    directory: PROJECT,
    startedAt: 1_000,
    firstTokenAt: 1_400,
    firstTextAt: 1_400,
    streamedAt: 1_700,
    endedAt: 1_800,
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
    recordedAt: 1_800,
  }
  const firstWriter = openStore(databasePath)
  const secondWriter = openStore(databasePath)
  assert.equal(firstWriter.reused, false)
  assert.equal(secondWriter.reused, true)
  firstWriter.insert(concurrent)
  secondWriter.insert(concurrent)
  const concurrentCount = firstWriter.count(concurrentCallID)
  const concurrentTotal = firstWriter.count()
  assert.equal(concurrentCount, 1)
  assert.equal(concurrentTotal, 6)

  summary.push({
    phase: "second",
    session: secondSession,
    row: secondRow,
    turn: secondTurn,
    ttftMs: Number(secondRow.first_token_at) - Number(secondRow.started_at),
    totalStepRows: allSteps.length,
    totalTurns: allTurns.length,
    concurrentInstances: { callID: concurrentCallID, inserted: 2, count: concurrentCount },
  })

  await stopServer(second)
  console.log(JSON.stringify({ ok: true, databasePath, summary }, null, 2))
} finally {
  for (const server of servers) await stopServer(server)
  provider.stop()
}

function mkdirs() {
  rmSync(ROOT, { recursive: true, force: true })
  for (const directory of [PROJECT, path.join(CONFIG, "opencode"), DATA, STATE, CACHE])
    mkdirSync(directory, { recursive: true })
}

function writeConfig(providerUrl: string) {
  writeFileSync(
    path.join(CONFIG, "opencode", "opencode.json"),
    JSON.stringify(
      {
        providers: {
          mock: {
            name: "Usage Mock",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${providerUrl}/v1`, apiKey: "mock-key" },
            models: {
              "mock-model": {
                name: "Mock Model",
                family: "usage-mock",
                capabilities: { tools: false, input: ["text"], output: ["text"] },
                limit: { context: 32_768, output: 1_024 },
                cost: { input: 1, output: 2 },
              },
            },
          },
        },
        plugins: [{ package: PLUGIN_DIR }],
      },
      null,
      2,
    ),
  )
}

function environment() {
  return {
    ...process.env,
    XDG_DATA_HOME: DATA,
    XDG_CONFIG_HOME: CONFIG,
    XDG_STATE_HOME: STATE,
    XDG_CACHE_HOME: CACHE,
    // Keep the authoritative database inside the fixture even when the caller exports OPENCODE_DB.
    OPENCODE_DB: path.join(DATA, "opencode", "opencode.db"),
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    NO_COLOR: "1",
  }
}

async function startServer() {
  const port = freePort()
  const log = path.join(ROOT, `server-${crypto.randomUUID().slice(0, 8)}.log`)
  const proc = Bun.spawn({
    cmd: ["bun", "run", "--cwd", CLI_DIR, "src/index.ts", "serve", "--port", String(port)],
    env: environment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  void drain(proc.stdout, `${log}.out`)
  void drain(proc.stderr, `${log}.err`)
  const url = `http://127.0.0.1:${port}`
  await waitForServer(url, proc)
  const server = { proc, url, log }
  servers.push(server)
  return server
}

async function drain(stream: ReadableStream<Uint8Array>, file: string) {
  const writer = Bun.file(file).writer()
  for await (const chunk of stream) writer.write(chunk)
  await writer.end()
}

function freePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error("failed to allocate a free port")
  return port
}

async function waitForServer(url: string, proc: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`opencode server exited with ${proc.exitCode}`)
    const response = await fetch(`${url}/api/info`, { headers: { authorization: AUTH } }).catch(() => undefined)
    if (response?.ok) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${url}`)
}

async function waitForPlugin(url: string) {
  const deadline = Date.now() + 20_000
  const query = new URLSearchParams({ "location[directory]": PROJECT })
  while (Date.now() < deadline) {
    const value = await api(url, `/api/plugin?${query}`)
    const failure = pluginFailure(value)
    if (failure) throw new Error(`plugin failed to load: ${failure}`)
    if (pluginActive(value)) return
    await Bun.sleep(100)
  }
  throw new Error("timed out waiting for the usage plugin to become active")
}

function pluginFailure(value: unknown) {
  const state = pluginState(value)
  if (state?.status === "failed") return state.error ?? "unknown plugin failure"
  return undefined
}

function pluginActive(value: unknown) {
  return pluginState(value)?.status === "active"
}

function pluginState(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined
  const plugin = value.data.find((item) => isRecord(item) && item.id === PLUGIN_ID)
  if (!isRecord(plugin) || !isRecord(plugin.state)) return undefined
  const status = plugin.state.status
  const error = plugin.state.error
  return { status: typeof status === "string" ? status : undefined, error: typeof error === "string" ? error : undefined }
}

async function prompt(url: string, text: string) {
  const created = await api(url, "/api/session", {
    method: "POST",
    body: JSON.stringify({
      title: SESSION_TITLE,
      metadata: SESSION_METADATA,
      location: { directory: PROJECT },
      model: { providerID: "mock", id: "mock-model" },
    }),
  })
  const sessionID = sessionIDFrom(created)
  assert.equal(sessionMetadata(created)?.oc2InternalTest, true, "created session did not carry the internal marker")
  assert.equal(sessionMetadata(created)?.oc2InternalTestOrigin, SESSION_METADATA.oc2InternalTestOrigin)
  await api(url, `/api/session/${sessionID}/prompt`, { method: "POST", body: JSON.stringify({ text }) })
  return sessionID
}

function sessionMetadata(value: unknown) {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.metadata)) return undefined
  return value.data.metadata
}

function sessionIDFrom(value: unknown) {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.id !== "string")
    throw new Error("session.create did not return a session id")
  return value.data.id
}

async function api(url: string, route: string, init?: RequestInit) {
  const response = await fetch(`${url}${route}`, {
    ...init,
    headers: { authorization: AUTH, "content-type": "application/json", ...init?.headers },
  })
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`)
  return response.json()
}

type CallRecord = {
  call_id: string
  kind: string
  status: string
  provider_id: string | null
  model_id: string | null
  session_id: string
  started_at: number | null
  first_token_at: number | null
  streamed_at: number | null
  tokens_output: number | null
  cost_usd: number | null
  error: string | null
  turn_id: string | null
  error_type: string | null
  error_status: number | null
  retries: number
  last_retry_error_type: string | null
  last_retry_at: number | null
}

type TurnRecord = {
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

function stepRows(sessionID?: string) {
  if (!existsSync(databasePath)) return []
  const db = new Database(databasePath, { readonly: true })
  const rows = sessionID
    ? db.query<CallRecord, [string]>("SELECT * FROM call WHERE kind = 'step' AND session_id = ?").all(sessionID)
    : db.query<CallRecord, []>("SELECT * FROM call WHERE kind = 'step'").all()
  db.close()
  return rows
}

function turnRows(sessionID?: string) {
  if (!existsSync(databasePath)) return []
  const db = new Database(databasePath, { readonly: true })
  const rows = sessionID
    ? db.query<TurnRecord, [string]>("SELECT * FROM turn WHERE session_id = ? ORDER BY started_at").all(sessionID)
    : db.query<TurnRecord, []>("SELECT * FROM turn ORDER BY started_at").all()
  db.close()
  return rows
}

async function waitForCompletedStep(sessionID: string) {
  const rows = await waitForSteps(sessionID, (steps) => steps.some((row) => row.status === "completed"))
  return rows.find((row) => row.status === "completed")!
}

async function waitForFailedStep(sessionID: string) {
  const rows = await waitForSteps(sessionID, (steps) => steps.some((row) => row.status === "failed"))
  return rows.find((row) => row.status === "failed")!
}

async function waitForSteps(sessionID: string, done: (rows: CallRecord[]) => boolean) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const rows = stepRows(sessionID)
    if (done(rows)) return rows
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for step rows for ${sessionID}`)
}

async function waitForTurn(sessionID: string, status: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const turn = turnRows(sessionID).find((row) => row.status === status)
    if (turn) return turn
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for a ${status} turn for ${sessionID}`)
}

function assertRound(turn: TurnRecord) {
  assert.notEqual(turn.accepted_at, null, `turn ${turn.turn_id} has no accepted_at`)
  assert.ok(turn.queued_at === null || Number(turn.queued_at) <= Number(turn.accepted_at))
  assert.ok(
    Number(turn.accepted_at) <= turn.started_at && turn.started_at <= Number(turn.ended_at),
    `turn ${turn.turn_id} has an implausible accepted_at -> ended_at span`,
  )
}

async function stopServer(server: Server) {
  const index = servers.findIndex((candidate) => candidate.proc === server.proc)
  if (index >= 0) servers.splice(index, 1)
  if (server.proc.exitCode !== null) return
  server.proc.kill("SIGTERM")
  const exited = await Promise.race([server.proc.exited, Bun.sleep(10_000).then(() => undefined)])
  if (exited !== undefined) return
  server.proc.kill("SIGKILL")
  await server.proc.exited
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
