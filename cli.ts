#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  cachePair,
  errorLabel,
  formatDate,
  formatDateTime,
  humanizeCost,
  humanizeDuration,
  humanizeRate,
  humanizeTPS,
  modelLabel,
  renderTable,
  retryLabel,
  shortSession,
  singleLine,
  statusLabel,
  tokenTriple,
  truncate,
} from "./src/format"
import {
  aggregateModels,
  aggregateSessions,
  aggregateTotal,
  countExcludedInternalSessions,
  groupErrors,
  isTurnDisplayStatus,
  parseSince,
  selectCalls,
  selectTurns,
  sessionTotals,
  type ErrorSourceSelection,
  type Range,
  type TurnDisplayStatus,
} from "./src/query"
import {
  listDatabaseCandidates,
  readCalls,
  readMessages,
  readSessions,
  readTurns,
  selectAuthoritativeDatabase,
} from "./src/read"
import { defaultDatabasePath } from "./src/store"

type Command = "calls" | "sessions" | "models" | "total" | "turns" | "errors"

type Options = {
  readonly command: Command
  readonly since: string | null
  readonly json: boolean
  readonly db: string | null
  readonly sessionsDB: string | null
  readonly noColor: boolean
  readonly session: string | null
  readonly limit: number | null
  readonly summary: boolean
  readonly verbose: boolean
  readonly includeInternal: boolean
  readonly status: TurnDisplayStatus | null
  readonly errorsOnly: boolean
  readonly callsOnly: boolean
  readonly turnsOnly: boolean
}

type ParseResult = { readonly ok: true; readonly options: Options } | { readonly ok: false; readonly message: string }

const usage = `Usage: bun run cli.ts <command> [flags]

Commands:
  calls      One line per sidecar-recorded call
  sessions   Per-session totals from the authoritative database (default last 30d)
  models     Per-provider/model rollup from the authoritative database
  turns      One line per round (default last 7d)
  errors     Grouped call and round errors (default last 30d)
  total      Grand totals for the window

Common flags:
  --since <7d|24h|30m|YYYY-MM-DD>   Limit the window
  --json                            Emit stable JSON instead of a table
  --db <path>                       Sidecar database (default: XDG opencode/usage.db)
  --sessions-db <path>              Authoritative database (default: OPENCODE_DB or newest opencode*.db)
  --no-color                        Accepted for scripts; output is already plain text
  --verbose                         Show the authoritative database source under table output
  --include-internal                Include sessions marked as internal test data

Command flags:
  calls:     --session <id or prefix>  --limit N (default 50)
  sessions:  --limit N (default 20)    --summary
  turns:     --status <running|stale|completed|failed|interrupted>
             --errors                  --session <id or prefix>  --limit N (default 25)
  errors:    --calls  --turns

The sidecar only covers calls made while the plugin was running. Cost and token
totals come from the authoritative database and cover its full history.`

function main(argv: readonly string[]) {
  const first = argv[0]
  if (first === "--help" || first === "-h") {
    console.log(usage)
    return 0
  }

  const parsed = parseArgs(argv)
  if (!parsed.ok) return fail(parsed.message)
  const options = parsed.options
  const now = Date.now()
  const resolvedRange = resolveRange(options, now)
  if (!resolvedRange.ok) return fail(resolvedRange.message)
  const range = resolvedRange.range
  const dataDirectory = path.dirname(defaultDatabasePath())
  const selection = selectAuthoritativeDatabase({
    dataDirectory,
    candidates: listDatabaseCandidates(dataDirectory),
    explicitPath: options.sessionsDB,
    envPath: process.env.OPENCODE_DB,
  })
  if (!selection.ok) {
    console.error(`error: ${selection.message}`)
    return 1
  }
  const sessionsPath = selection.path

  const sidecarPath = options.db ?? process.env.OPENCODE_USAGE_DB ?? defaultDatabasePath()
  const sidecar = openReadOnly(sidecarPath)
  const calls = sidecar ? readCalls(sidecar) : []
  const turns = sidecar ? readTurns(sidecar) : []
  sidecar?.close()

  if (options.command === "calls" || options.command === "turns" || options.command === "errors") {
    const authoritative = openReadOnly(sessionsPath)
    if (!authoritative) return missingAuthoritative(sessionsPath, dataDirectory)
    const sessions = readSessions(authoritative)
    authoritative.close()
    const internalSessions = new Set(sessions.filter((session) => session.internal).map((session) => session.id))
    const titles = new Map(sessions.map((session) => [session.id, session.title]))

    if (options.command === "calls") {
      const selected = selectCalls(calls, {
        since: range.since,
        session: options.session,
        limit: options.limit ?? 50,
        internalSessions,
        includeInternal: options.includeInternal,
      })
      printCalls(
        selected.rows,
        range,
        options.json,
        calls.length,
        sidecar !== undefined,
        sidecarPath,
        sessionsPath,
        options.verbose,
        selected.excludedInternal,
      )
      return 0
    }

    if (options.command === "turns") {
      const selected = selectTurns(
        turns,
        calls,
        {
          since: range.since,
          limit: options.limit ?? 25,
          session: options.session,
          status: options.status,
          errorsOnly: options.errorsOnly,
          includeInternal: options.includeInternal,
          internalSessions,
          titles,
        },
        now,
      )
      printTurns(
        selected.rows,
        range,
        options.json,
        turns.length,
        sidecar !== undefined,
        sidecarPath,
        sessionsPath,
        options.verbose,
        selected.excludedInternal,
      )
      return 0
    }

    const sources = errorSources(options)
    printErrors(
      groupErrors({
        calls,
        turns,
        since: range.since,
        internalSessions,
        includeInternal: options.includeInternal,
        sources,
      }),
      range,
      options.json,
      sessionsPath,
      options.verbose,
      sources === "both",
    )
    return 0
  }

  const authoritative = openReadOnly(sessionsPath)
  if (!authoritative) return missingAuthoritative(sessionsPath, dataDirectory)
  const sessions = readSessions(authoritative)
  const internalSessions = new Set(sessions.filter((session) => session.internal).map((session) => session.id))
  const messages = readMessages(authoritative)
  authoritative.close()

  if (options.command === "sessions") {
    const rows = aggregateSessions(
      sessions,
      messages,
      calls,
      range.since,
      options.includeInternal,
      turns,
    )
    const excludedInternal = countExcludedInternalSessions(sessions, range.since, options.includeInternal)
    if (options.summary)
      printSessionsSummary(
        sessionTotals(rows, calls, excludedInternal),
        range,
        options.json,
        sessionsPath,
        options.verbose,
      )
    else
      printSessions(
        rows.slice(0, options.limit ?? 20),
        range,
        options.json,
        sessionsPath,
        options.verbose,
        excludedInternal,
      )
    return 0
  }

  if (options.command === "models") {
    printModels(
      aggregateModels(messages, calls, range.since, internalSessions, options.includeInternal),
      range,
      options.json,
      sessionsPath,
      options.verbose,
    )
    return 0
  }

  printTotal(
    aggregateTotal(messages, calls, range.since, internalSessions, options.includeInternal, turns),
    range,
    options.json,
    sessionsPath,
  )
  return 0
}

function missingAuthoritative(sessionsPath: string, dataDirectory: string) {
  console.error(`error: authoritative database not found: ${sessionsPath}`)
  console.error(`data directory: ${dataDirectory}`)
  console.error("Pass --sessions-db <path> or set OPENCODE_DB if it lives somewhere else.")
  return 1
}

function parseArgs(argv: readonly string[]): ParseResult {
  const command = commandFrom(argv[0])
  if (!command) return { ok: false, message: argv[0] === undefined ? "missing command" : `unknown command: ${argv[0]}` }

  let since: string | null = null
  let json = false
  let db: string | null = null
  let sessionsDB: string | null = null
  let noColor = false
  let session: string | null = null
  let limit: number | null = null
  let summary = false
  let verbose = false
  let includeInternal = false
  let status: TurnDisplayStatus | null = null
  let errorsOnly = false
  let callsOnly = false
  let turnsOnly = false

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) break
    if (!argument.startsWith("--")) return { ok: false, message: `unexpected argument: ${argument}` }
    const equals = argument.indexOf("=")
    const name = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)

    if (
      name === "--json" ||
      name === "--no-color" ||
      name === "--summary" ||
      name === "--verbose" ||
      name === "--include-internal" ||
      name === "--errors" ||
      name === "--calls" ||
      name === "--turns"
    ) {
      if (inline !== undefined) return { ok: false, message: `${name} does not take a value` }
      if (name === "--json") json = true
      if (name === "--no-color") noColor = true
      if (name === "--summary") summary = true
      if (name === "--verbose") verbose = true
      if (name === "--include-internal") includeInternal = true
      if (name === "--errors") errorsOnly = true
      if (name === "--calls") callsOnly = true
      if (name === "--turns") turnsOnly = true
      continue
    }

    const value = inline ?? argv[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith("--")))
      return { ok: false, message: `missing value for ${name}` }
    if (inline === undefined) index += 1

    if (name === "--since") since = value
    else if (name === "--db") db = value
    else if (name === "--sessions-db") sessionsDB = value
    else if (name === "--session") session = value
    else if (name === "--status") {
      if (!isTurnDisplayStatus(value))
        return { ok: false, message: `invalid --status value: ${value} (expected running, stale, completed, failed, or interrupted)` }
      status = value
    } else if (name === "--limit") {
      if (!/^\d+$/.test(value)) return { ok: false, message: `invalid --limit value: ${value}` }
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed < 1) return { ok: false, message: `invalid --limit value: ${value}` }
      limit = parsed
    } else return { ok: false, message: `unknown flag: ${name}` }
  }

  if (session !== null && command !== "calls" && command !== "turns")
    return { ok: false, message: "--session is only valid for calls and turns" }
  if (summary && command !== "sessions") return { ok: false, message: "--summary is only valid for sessions" }
  if (limit !== null && command !== "calls" && command !== "sessions" && command !== "turns")
    return { ok: false, message: "--limit is only valid for calls, sessions, and turns" }
  if (status !== null && command !== "turns") return { ok: false, message: "--status is only valid for turns" }
  if (errorsOnly && command !== "turns") return { ok: false, message: "--errors is only valid for turns" }
  if ((callsOnly || turnsOnly) && command !== "errors")
    return { ok: false, message: "--calls and --turns are only valid for errors" }

  return {
    ok: true,
    options: {
      command,
      since,
      json,
      db,
      sessionsDB,
      noColor,
      session,
      limit,
      summary,
      verbose,
      includeInternal,
      status,
      errorsOnly,
      callsOnly,
      turnsOnly,
    },
  }
}

function commandFrom(value: string | undefined): Command | undefined {
  if (
    value === "calls" ||
    value === "sessions" ||
    value === "models" ||
    value === "total" ||
    value === "turns" ||
    value === "errors"
  )
    return value
  return undefined
}

function errorSources(options: Options): ErrorSourceSelection {
  if (options.callsOnly && !options.turnsOnly) return "calls"
  if (options.turnsOnly && !options.callsOnly) return "turns"
  return "both"
}

function resolveRange(
  options: Options,
  now: number,
): { readonly ok: true; readonly range: Range } | { readonly ok: false; readonly message: string } {
  if (options.since === null && options.command === "sessions")
    return { ok: true, range: { since: now - 30 * 86_400_000, label: "30d" } }
  if (options.since === null && options.command === "turns")
    return { ok: true, range: { since: now - 7 * 86_400_000, label: "7d" } }
  if (options.since === null && options.command === "errors")
    return { ok: true, range: { since: now - 30 * 86_400_000, label: "30d" } }
  if (options.since === null) return { ok: true, range: { since: null, label: "all time" } }
  const parsed = parseSince(options.since, now)
  if (!parsed.ok) return parsed
  return { ok: true, range: { since: parsed.since, label: options.since } }
}

function fail(message: string) {
  console.error(`error: ${message}`)
  console.error("")
  console.error(usage)
  return 2
}

function openReadOnly(file: string) {
  if (!existsSync(file)) return undefined
  const db = new Database(file, { readonly: true })
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}

function printCalls(
  views: ReturnType<typeof selectCalls>["rows"],
  range: Range,
  json: boolean,
  totalCalls: number,
  sidecarExists: boolean,
  sidecarPath: string,
  sessionsDB: string,
  verbose: boolean,
  excludedInternal: number,
) {
  if (json) {
    const rows = views.map(({ call, metrics, internal }) => ({
      callID: call.callID,
      sessionID: call.sessionID,
      session: shortSession(call.sessionID),
      internal,
      kind: call.kind,
      status: call.status,
      startedAt: call.startedAt,
      firstTokenAt: call.firstTokenAt,
      firstTextAt: call.firstTextAt,
      streamedAt: call.streamedAt,
      endedAt: call.endedAt,
      providerID: call.providerID,
      modelID: call.modelID,
      modelVariant: call.modelVariant,
      agent: call.agent,
      tokens: {
        input: call.tokensInput,
        output: call.tokensOutput,
        reasoning: call.tokensReasoning,
        cacheRead: call.tokensCacheRead,
        cacheWrite: call.tokensCacheWrite,
      },
      costUSD: call.costUSD,
      ttft: metrics.ttft ?? null,
      ttfa: metrics.ttfa ?? null,
      tps: metrics.tps ?? null,
      e2e: metrics.e2e ?? null,
      retries: call.retries,
      errorType: call.errorType ?? call.lastRetryErrorType,
      finish: call.finish,
      error: call.error,
    }))
    console.log(JSON.stringify({ command: "calls", sessionsDB, range, excludedInternal, rows }, null, 2))
    return
  }

  if (views.length === 0) {
    if (totalCalls === 0)
      console.log(
        sidecarExists
          ? `no calls recorded yet (${sidecarPath})`
          : `no calls recorded yet (sidecar database not found: ${sidecarPath})`,
      )
    else console.log("no calls match the current filters")
    printSource(sessionsDB, verbose)
    return
  }

  const headers = [
    "STARTED",
    "SESSION",
    "MODEL",
    "AGENT",
    "TOKENS",
    "CACHE",
    "COST",
    "TTFT",
    "TTFA",
    "TPS",
    "E2E",
    "STATUS",
    "RETRY",
    "ERR",
  ]
  const rows = views.map(({ call, metrics, internal }) => [
    formatDateTime(call.startedAt),
    `${shortSession(call.sessionID)}${internal ? " · test" : ""}`,
    modelLabel(call.providerID, call.modelID),
    call.agent ?? "—",
    tokenTriple(call.tokensInput, call.tokensOutput, call.tokensReasoning),
    cachePair(call.tokensCacheRead, call.tokensCacheWrite),
    humanizeCost(call.costUSD),
    humanizeDuration(metrics.ttft),
    humanizeDuration(metrics.ttfa),
    humanizeTPS(metrics.tps),
    humanizeDuration(metrics.e2e),
    statusLabel(call.kind, call.status),
    retryLabel(call.retries),
    truncate(call.errorType ?? call.lastRetryErrorType ?? "—", 24),
  ])
  console.log(
    renderTable(headers, rows, [
      "left",
      "left",
      "left",
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "left",
      "right",
      "left",
    ]),
  )
  printSource(sessionsDB, verbose)
}

function printSessions(
  rows: ReturnType<typeof aggregateSessions>,
  range: Range,
  json: boolean,
  sessionsDB: string,
  verbose: boolean,
  excludedInternal: number,
) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          command: "sessions",
          sessionsDB,
          range,
          excludedInternal,
          rows: rows.map((row) => ({
            sessionID: row.id,
            session: shortSession(row.id),
            title: row.title,
            internal: row.internal,
            updatedAt: row.updatedAt,
            steps: row.steps,
            tokens: {
              input: row.tokensInput,
              output: row.tokensOutput,
              reasoning: row.tokensReasoning,
              cacheRead: row.tokensCacheRead,
              cacheWrite: row.tokensCacheWrite,
            },
            costUSD: row.costUSD,
            recordedCalls: row.recordedCalls,
            avgTTFT: row.avgTTFT,
            avgTPS: row.avgTPS,
            roundP50Ms: row.roundP50Ms,
            failedRounds: row.failedRounds,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  if (rows.length === 0) {
    console.log("no sessions in the selected window")
    printSource(sessionsDB, verbose)
    return
  }

  const headers = [
    "SESSION",
    "TITLE",
    "UPDATED",
    "STEPS",
    "TOKENS",
    "CACHE",
    "COST",
    "CALLS",
    "TTFT",
    "TPS",
    "ROUND",
    "ERRS",
  ]
  const table = rows.map((row) => [
    shortSession(row.id),
    truncate(row.internal ? `[test] ${row.title ?? "—"}` : (row.title ?? "—"), 40),
    formatDateTime(row.updatedAt),
    String(row.steps),
    tokenTriple(row.tokensInput, row.tokensOutput, row.tokensReasoning),
    cachePair(row.tokensCacheRead, row.tokensCacheWrite),
    humanizeCost(row.costUSD),
    String(row.recordedCalls),
    humanizeDuration(row.avgTTFT),
    humanizeTPS(row.avgTPS),
    humanizeDuration(row.roundP50Ms),
    row.failedRounds === 0 ? "—" : String(row.failedRounds),
  ])
  console.log(
    renderTable(headers, table, [
      "left",
      "left",
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
    ]),
  )
  printSource(sessionsDB, verbose)
}

function printSessionsSummary(
  totals: ReturnType<typeof sessionTotals>,
  range: Range,
  json: boolean,
  sessionsDB: string,
  verbose: boolean,
) {
  if (json) {
    console.log(
      JSON.stringify(
        { command: "sessions", sessionsDB, range, excludedInternal: totals.excludedInternal, totals },
        null,
        2,
      ),
    )
    return
  }
  console.log(
    renderTable(
      ["METRIC", "VALUE"],
      [
        ["sessions", String(totals.sessions)],
        ["steps", String(totals.steps)],
        ["tokens in/out/think", tokenTriple(totals.tokensInput, totals.tokensOutput, totals.tokensReasoning)],
        ["cache r/w", cachePair(totals.tokensCacheRead, totals.tokensCacheWrite)],
        ["cost", humanizeCost(totals.costUSD)],
        ["recorded calls", String(totals.recordedCalls)],
        ["avg TTFT", humanizeDuration(totals.avgTTFT)],
        ["avg TPS", humanizeTPS(totals.avgTPS)],
      ],
      ["left", "right"],
    ),
  )
  printSource(sessionsDB, verbose)
}

function printModels(
  rows: ReturnType<typeof aggregateModels>,
  range: Range,
  json: boolean,
  sessionsDB: string,
  verbose: boolean,
) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          command: "models",
          sessionsDB,
          range,
          rows: rows.map((row) => ({
            providerID: row.providerID,
            modelID: row.modelID,
            model: modelLabel(row.providerID, row.modelID),
            internal: row.internal,
            calls: row.calls,
            sessions: row.sessions,
            tokens: {
              input: row.tokensInput,
              output: row.tokensOutput,
              reasoning: row.tokensReasoning,
              cacheRead: row.tokensCacheRead,
              cacheWrite: row.tokensCacheWrite,
            },
            costUSD: row.costUSD,
            avgTTFT: row.avgTTFT,
            avgTPS: row.avgTPS,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  if (rows.length === 0) {
    console.log("no model activity in the selected window")
    printSource(sessionsDB, verbose)
    return
  }

  const headers = ["MODEL", "CALLS", "SESSIONS", "TOKENS", "CACHE", "COST", "TTFT", "TPS"]
  const table = rows.map((row) => [
    modelLabel(row.providerID, row.modelID),
    String(row.calls),
    String(row.sessions),
    tokenTriple(row.tokensInput, row.tokensOutput, row.tokensReasoning),
    cachePair(row.tokensCacheRead, row.tokensCacheWrite),
    humanizeCost(row.costUSD),
    humanizeDuration(row.avgTTFT),
    humanizeTPS(row.avgTPS),
  ])
  console.log(
    renderTable(headers, table, ["left", "right", "right", "right", "right", "right", "right", "right"]),
  )
  printSource(sessionsDB, verbose)
}

function printTurns(
  rows: ReturnType<typeof selectTurns>["rows"],
  range: Range,
  json: boolean,
  totalTurns: number,
  sidecarExists: boolean,
  sidecarPath: string,
  sessionsDB: string,
  verbose: boolean,
  excludedInternal: number,
) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          command: "turns",
          sessionsDB,
          range,
          excludedInternal,
          rows: rows.map((row) => ({
            turnID: row.turnID,
            sessionID: row.sessionID,
            session: shortSession(row.sessionID),
            title: row.title,
            status: row.status,
            internal: row.internal,
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
              cacheRead: row.tokensCacheRead,
              cacheWrite: row.tokensCacheWrite,
            },
            interruptReason: row.interruptReason,
            errorType: row.errorType,
            errorMessage: row.errorMessage,
            errorStatus: row.errorStatus,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  if (rows.length === 0) {
    if (totalTurns === 0)
      console.log(
        sidecarExists
          ? `no rounds recorded yet (${sidecarPath})`
          : `no rounds recorded yet (sidecar database not found: ${sidecarPath})`,
      )
    else console.log("no rounds match the current filters")
    printSource(sessionsDB, verbose)
    return
  }

  const headers = ["STARTED", "SESSION", "STATUS", "QUEUE", "ROUND", "TTFT", "P/S", "CALLS", "COST", "RETRY", "ERROR"]
  const table = rows.map((row) => {
    const title = row.internal ? `[test] ${row.title ?? "—"}` : (row.title ?? "—")
    return [
      formatDateTime(row.startedAt),
      `${shortSession(row.sessionID)}  ${truncate(title, 40)}`,
      row.status,
      humanizeDuration(row.queueMs),
      humanizeDuration(row.roundMs),
      humanizeDuration(row.firstTokenMs),
      `${row.prompts}/${row.steers}`,
      String(row.calls),
      humanizeCost(row.costUSD),
      String(row.retries),
      truncate(row.errorType ?? (row.timeout ? "provider.timeout" : "—"), 24),
    ]
  })
  console.log(
    renderTable(headers, table, [
      "left",
      "left",
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "left",
    ]),
  )
  printSource(sessionsDB, verbose)
}

function printErrors(
  rows: ReturnType<typeof groupErrors>,
  range: Range,
  json: boolean,
  sessionsDB: string,
  verbose: boolean,
  showSource: boolean,
) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          command: "errors",
          sessionsDB,
          range,
          rows: rows.map((row) => ({
            errorType: row.errorType,
            source: row.source,
            count: row.count,
            sessions: row.sessions,
            firstAt: row.firstAt,
            lastAt: row.lastAt,
            lastMessage: row.lastMessage === null ? null : singleLine(row.lastMessage, 60),
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  if (rows.length === 0) {
    console.log("no errors in the selected window")
    printSource(sessionsDB, verbose)
    return
  }

  const headers = showSource
    ? ["TYPE", "SOURCE", "COUNT", "SESSIONS", "FIRST", "LAST", "MESSAGE"]
    : ["TYPE", "COUNT", "SESSIONS", "FIRST", "LAST", "MESSAGE"]
  const table = rows.map((row) => {
    const values = [
      errorLabel(row.errorType),
      String(row.count),
      String(row.sessions),
      formatDateTime(row.firstAt),
      formatDateTime(row.lastAt),
      singleLine(row.lastMessage, 60),
    ]
    return showSource ? [values[0]!, row.source, ...values.slice(1)] : values
  })
  console.log(
    renderTable(
      headers,
      table,
      showSource
        ? ["left", "left", "right", "right", "left", "left", "left"]
        : ["left", "right", "right", "left", "left", "left"],
    ),
  )
  printSource(sessionsDB, verbose)
}

function printTotal(
  totals: ReturnType<typeof aggregateTotal>,
  range: Range,
  json: boolean,
  sessionsDB: string,
) {
  if (json) {
    console.log(JSON.stringify({ command: "total", sessionsDB, range, totals }, null, 2))
    return
  }

  console.log(
    renderTable(
      ["METRIC", "VALUE"],
      [
        ["sessions", String(totals.sessions)],
        ["prompts", String(totals.prompts)],
        ["steps", String(totals.steps)],
        ["rounds", String(totals.rounds)],
        ["failed rounds", String(totals.failedRounds)],
        ["timeouts", String(totals.timeouts)],
        ["p95 round", humanizeDuration(totals.p95RoundMs)],
        ["error rate", humanizeRate(totals.errorRate)],
        ["tokens in/out/think", tokenTriple(totals.tokensInput, totals.tokensOutput, totals.tokensReasoning)],
        ["cache r/w", cachePair(totals.tokensCacheRead, totals.tokensCacheWrite)],
        ["cost", humanizeCost(totals.costUSD)],
        ["active days", String(totals.activeDays)],
      ],
      ["left", "right"],
    ),
  )
  console.log("")
  if (totals.excludedInternal > 0)
    console.log(`excluding ${totals.excludedInternal} internal-test sessions (use --include-internal)`)
  if (totals.sidecar.calls === 0)
    console.log("sidecar: no calls recorded, so TTFT/TPS are unavailable")
  else
    console.log(
      `sidecar: ${totals.sidecar.calls} call${totals.sidecar.calls === 1 ? "" : "s"} recorded, ${formatDate(
        totals.sidecar.firstAt,
      )} to ${formatDate(totals.sidecar.lastAt)} (local time)`,
    )
  console.log(
    "note: cost and token totals come from the authoritative database; TTFT/TPS only cover sidecar-recorded calls.",
  )
  console.log(`source: ${sessionsDB}`)
}

function printSource(sessionsDB: string, verbose: boolean) {
  if (verbose) console.log(`source: ${sessionsDB}`)
}

process.exitCode = main(process.argv.slice(2))
