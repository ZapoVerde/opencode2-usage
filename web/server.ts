#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import {
  listDatabaseCandidates,
  readCalls,
  readCredentials,
  readProjectDirectory,
  readSessions,
  readTurns,
  selectAuthoritativeDatabase,
} from "../src/read"
import type { TurnRecord } from "../src/query"
import type { CallRow } from "../src/reducer"
import { defaultDatabasePath } from "../src/store"
import { loadPlans } from "../src/plans-file"
import { alignCosts } from "./impute"
import { PROVIDER_ALIASES, QUOTA_TTL_MS, readQuotas } from "../src/quota-source"
import { advertisedPlan } from "../src/allowances"
import { advertisedQuota, emptyQuotas, type ModelSpend } from "../src/quota-view"
import type { AdvertisedQuota, ProviderQuotaStatus, QuotasResponse, QuotaWindow as QuotaWindowStatus } from "../src/quotas"
import { handleApi, type WebSnapshot } from "./api"
import { normaliseCookies, sameCookies, type StoredCookie } from "../src/od-session"
import { clearSession, loadSession, resolveSessionPath, saveSession } from "../src/od-store"
import { readOpenDesign } from "../src/od-source"

type ServerOptions = {
  readonly port: number
  readonly host: string
  readonly db: string | null
  readonly sessionsDB: string | null
  readonly plans: string | null
}

const DEFAULT_PORT = 4599
const LOOPBACK = "127.0.0.1"
const ALL_INTERFACES = "0.0.0.0"

const usage = `Usage: bun run web [flags]

Serves a read-only dashboard for the usage sidecar and the authoritative
OpenCode database. Both databases are opened read-only per request.

Flags:
  --port <number>          Port to listen on (default ${DEFAULT_PORT}; 0 picks a free port)
  --host <address>         ${LOOPBACK} (default, loopback only) or ${ALL_INTERFACES}
  --db <path>              Sidecar database (default: OPENCODE_USAGE_DB or XDG opencode/usage.db)
  --sessions-db <path>     Authoritative database (default: OPENCODE_DB or newest opencode*.db)
  --plans <path>           Fixed-fee plan prices (default: OPENCODE_USAGE_PLANS or usage-plans.json)
  -h, --help               Show this help

Other hosts are refused. Exposing the dashboard requires an explicit --host ${ALL_INTERFACES}.`

const staticFiles = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/summary.js", ["summary.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
])

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  console.log(usage)
  process.exit(0)
}

const parsed = parseArguments(process.argv.slice(2))
if (!parsed.ok) {
  console.error(`error: ${parsed.message}`)
  console.error("")
  console.error(usage)
  process.exit(2)
}
const options = parsed.options

const startup = describeStartup(options)
if (startup.warning !== null) console.error(`warning: ${startup.warning}`)

const server = Bun.serve({
  hostname: options.host,
  port: options.port,
  fetch: requestHandler,
})

const schemeAndHost =
  options.host === ALL_INTERFACES ? `http://${ALL_INTERFACES}:${server.port}` : `http://${LOOPBACK}:${server.port}`
const scope = options.host === ALL_INTERFACES ? "all interfaces" : "loopback only"
console.log(`opencode2-usage web dashboard: ${schemeAndHost} (${scope})`)
console.log(`sidecar:    ${startup.sidecarPath}${startup.sidecarExists ? "" : " (missing)"}`)
console.log(`authoritative: ${startup.sessionsPath ?? "(not found)"}`)
console.log(`plans:      ${startup.plansPath}${startup.plansExists ? "" : " (not found; plan spend hidden)"}`)

async function requestHandler(request: Request) {
  const url = new URL(request.url)
  // Provider status needs network I/O and a cache, so it bypasses the pure
  // in-memory API dispatcher.
  if (url.pathname === "/api/quotas") return json(await quotasResponse(options), 200)
  if (url.pathname === "/api/opendesign/session") return openDesignSessionRoute(request, options)
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
  if (url.pathname.startsWith("/api/")) {
    try {
      const result = handleApi(
        url.pathname,
        url.searchParams,
        loadSnapshot(options, url.pathname),
        Date.now(),
      )
      return json(result.body, result.status)
    } catch (error) {
      // Short message only; stack traces stay in the terminal, never in the response.
      console.error(`web request failed: ${error instanceof Error ? error.message : String(error)}`)
      return json({ error: "internal server error" }, 500)
    }
  }
  return serveStatic(url.pathname)
}

type QuotaCacheEntry = {
  readonly key: string
  readonly loadedAt: number
  readonly value: QuotasResponse
}

let quotaCache: QuotaCacheEntry | null = null
let quotaInflight: Promise<QuotasResponse> | null = null

/**
 * Provider status, cached briefly.
 *
 * Each reload would otherwise hit every upstream, and several of these APIs are
 * rate limited. Concurrent callers share one in-flight fetch so a page load and
 * a manual refresh cannot double up.
 */
async function quotasResponse(options: ServerOptions): Promise<QuotasResponse> {
  const sources = resolveSources(options)
  const file = sources.sessionsPath
  if (file === null) return emptyQuotas()

  const key = `${databaseKey(file)}|${fileKey(sources.sidecarPath)}|${quotaKey(sources.openDesignSessionPath)}|${QUOTA_TTL_MS}`
  if (quotaCache !== null && quotaCache.key === key && Date.now() - quotaCache.loadedAt < QUOTA_TTL_MS)
    return quotaCache.value
  if (quotaInflight !== null) return quotaInflight

  quotaInflight = (async () => {
    const credentials = readDatabase(file, readCredentials) ?? []
    const recorded = sources.sidecarExists ? (readDatabase(sources.sidecarPath, readCalls) ?? []) : []
    // The same plan-card repricing the Usage tab uses, so "This machine" and the
    // credits figure are in the same unit and can be compared directly.
    const calls = alignCosts(recorded, loadPlans(sources.plansPath).plans).calls
    const results = await readQuotas({
      credentials,
      openDesign: openDesignSource(sources.openDesignSessionPath),
    })
    const advertised = buildAdvertised(results, calls)
    const value: QuotasResponse = { fetchedAt: Date.now(), results, aliases: PROVIDER_ALIASES, advertised }
    quotaCache = { key, loadedAt: Date.now(), value }
    return value
  })().finally(() => {
    quotaInflight = null
  })
  return quotaInflight
}

/**
 * True when the request came from this page or from no page at all.
 *
 * A browser does not send `Origin` on a same-origin GET, and it cannot remove it
 * from a cross-origin POST, so a present-but-foreign origin is the only signal
 * needed. A non-browser client sends none and is already limited by the
 * loopback bind.
 */
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (origin === null) return true
  const host = request.headers.get("host")
  if (host === null) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * The stored OpenDesign session, in the shape `readQuotas` wants.
 *
 * Rotation is written back only when the cookie values actually changed, so a
 * page that polls every minute does not rewrite the file each time.
 */
function openDesignSource(file: string) {
  const session = loadSession(file)
  if (session === null) return undefined
  return {
    cookies: session.cookies,
    onRotate: (cookies: readonly StoredCookie[]) => {
      if (sameCookies(session.cookies, cookies)) return
      saveSession(file, { cookies, confirmedAt: Date.now(), account: session.account })
    },
  }
}

/**
 * Connect, check, or disconnect the OpenDesign console session.
 *
 * This is the one write route on an otherwise read-only dashboard, because
 * OpenDesign's account API has no key-based access: the only credential that
 * reads the credit windows is the cookie a signed-in browser holds, and there
 * is nowhere else to put it. The route is loopback-only by the server's own
 * host rule, refuses cross-origin callers, and stores the cookie 0600 beside the
 * sidecar. A `DELETE` removes it.
 */
async function openDesignSessionRoute(request: Request, options: ServerOptions) {
  const file = resolveSessionPath(options.db ?? process.env.OPENCODE_USAGE_DB ?? defaultDatabasePath())
  if (!sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403)

  if (request.method === "DELETE") {
    clearSession(file)
    quotaCache = null
    return json({ connected: false }, 200)
  }
  if (request.method === "GET") {
    const session = loadSession(file)
    return json(
      {
        connected: session !== null,
        account: session?.account ?? null,
        confirmedAt: session?.confirmedAt ?? null,
      },
      200,
    )
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405)

  const body = (await request.json().catch(() => null)) as unknown
  const raw = body !== null && typeof body === "object" && "session" in body ? body.session : body

  let cookies
  try {
    cookies = normaliseCookies(raw)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "That session could not be read" }, 400)
  }

  // Probe before storing: a cookie that cannot read the console is not a
  // session, and telling you now is better than a dashboard that says
  // "connected" while every window shows an error.
  const reading = await readOpenDesign(cookies)
  if (reading.status.state !== "ok") {
    return json(
      {
        connected: false,
        error: reading.status.state === "error" ? reading.status.reason : "The session could not be verified",
      },
      400,
    )
  }

  const final = reading.rotated ?? cookies
  saveSession(file, {
    cookies: final,
    confirmedAt: Date.now(),
    account: reading.status.account,
  })
  quotaCache = null
  return json({ connected: true, account: reading.status.account }, 200)
}

/**
 * Advertised allowance per integration, with this machine's spend inside each of
 * that provider's quota windows.
 *
 * Windows come from the provider: Go resets on its own schedule, and OpenDesign
 * runs a rolling 5-hour and a 7-day window anchored to the subscription. The
 * reset times the provider reports are used directly, so the spend shown matches
 * the period the percentage covers.
 */
function buildAdvertised(
  results: Readonly<Record<string, ProviderQuotaStatus>>,
  calls: readonly CallRow[],
): Record<string, AdvertisedQuota> {
  const advertised: Record<string, AdvertisedQuota> = {}
  for (const [integrationID, status] of Object.entries(results)) {
    const plan = advertisedPlan(integrationID)
    if (plan === undefined) continue
    const providerIDs = providerIDsFor(integrationID)
    const providerCalls = calls.filter((call) => call.providerID !== null && providerIDs.includes(call.providerID))
    const models = [...new Set(providerCalls.flatMap((call) => (call.modelID === null ? [] : [call.modelID])))]

    // Spend is measured over the widest window the provider enforces, because the
    // narrower ones are subsets of it.
    const live = status.state === "ok" ? status.windows : []
    const widest = widestWindow(plan, live)
    const since = widest ?? null
    const inWindow =
      since === null ? providerCalls : providerCalls.filter((call) => (call.startedAt ?? 0) >= since)
    const spend = modelSpend(inWindow)

    const quota = advertisedQuota({ integrationID, models, spend, live })
    if (quota !== null) advertised[integrationID] = quota
  }
  return advertised
}

/**
 * The start of the widest window the provider reports.
 *
 * Go publishes an explicit monthly reset. OpenDesign publishes only the two
 * Design Plan windows (5 hours and 7 days), so the widest one it reports is the
 * weekly window and its reset is seven days after the window opened.
 */
function widestWindow(plan: ReturnType<typeof advertisedPlan>, live: readonly QuotaWindowStatus[]) {
  const monthly = live.find((window) => window.id === "monthly")
  // Go reports the monthly reset; its window is one month long.
  if (monthly?.resetsAt != null) return monthly.resetsAt - (plan?.providerID === "opencode" ? 31 : 30) * 86_400_000
  const weekly = live.find((window) => window.id === "weekly")
  if (weekly?.resetsAt != null) return weekly.resetsAt - 7 * 86_400_000
  const rolling = live.find((window) => window.id === "rolling")
  if (rolling?.resetsAt != null) return rolling.resetsAt - 5 * 3_600_000
  return null
}

function modelSpend(calls: readonly CallRow[]): ModelSpend[] {
  const byModel = new Map<
    string,
    {
      costUSD: number
      calls: number
      tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
    }
  >()
  for (const call of calls) {
    if (call.modelID === null) continue
    const entry = byModel.get(call.modelID) ?? {
      costUSD: 0,
      calls: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    }
    entry.costUSD += call.costUSD ?? 0
    entry.calls += 1
    entry.tokens.input += call.tokensInput ?? 0
    entry.tokens.output += call.tokensOutput ?? 0
    entry.tokens.reasoning += call.tokensReasoning ?? 0
    entry.tokens.cacheRead += call.tokensCacheRead ?? 0
    entry.tokens.cacheWrite += call.tokensCacheWrite ?? 0
    byModel.set(call.modelID, entry)
  }
  return [...byModel.entries()].map(([modelID, entry]) => ({ modelID, ...entry }))
}

/** Provider ids that bill against one integration's credential. */
function providerIDsFor(integrationID: string) {
  const ids = [integrationID]
  for (const [providerID, alias] of Object.entries(PROVIDER_ALIASES))
    if (alias === integrationID) ids.push(providerID)
  return ids
}

async function serveStatic(pathname: string) {
  if (pathname === "/favicon.ico") return new Response(null, { status: 204, headers })
  const entry = staticFiles.get(pathname)
  if (entry === undefined) return json({ error: "not found" }, 404)
  const file = Bun.file(path.join(import.meta.dir, "public", entry[0]))
  if (!(await file.exists())) return json({ error: "not found" }, 404)
  return new Response(file, { headers: { ...headers, "content-type": entry[1] } })
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  })
}

type SnapshotNeeds = {
  readonly calls: boolean
  readonly turns: boolean
  readonly sessions: boolean
  readonly projects: boolean
}

type SnapshotSources = {
  readonly sidecarPath: string
  readonly sidecarExists: boolean
  readonly sessionsPath: string | null
  readonly sessionsSource: "flag" | "env" | "scan" | null
  readonly sessionsResolveError: string | null
  readonly plansPath: string
  readonly openDesignSessionPath: string
}

// Every number on the dashboard comes from recorded calls and rounds. The
// authoritative database is only read for display metadata (titles, internal
// markers, project names); message rows are never read, which keeps the cold
// snapshot build in the low milliseconds.
function snapshotNeeds(pathname: string): SnapshotNeeds {
  if (pathname === "/api/meta")
    return { calls: true, turns: false, sessions: true, projects: false }
  if (pathname === "/api/calls")
    return { calls: true, turns: false, sessions: true, projects: false }
  if (pathname === "/api/turns" || pathname === "/api/errors" || pathname.startsWith("/api/turn/"))
    return { calls: true, turns: true, sessions: true, projects: false }
  if (pathname === "/api/pivot" || pathname === "/api/heatmap")
    return { calls: true, turns: false, sessions: true, projects: true }
  if (pathname === "/api/providers" || pathname === "/api/rates")
    return { calls: true, turns: false, sessions: true, projects: false }
  if (pathname === "/api/overview" || pathname === "/api/sessions" || pathname.startsWith("/api/session/"))
    return { calls: true, turns: true, sessions: true, projects: false }
  return { calls: false, turns: false, sessions: false, projects: false }
}

const CACHE_TTL_MS = 5_000
const RETRY_AFTER_FAILURE_MS = 5_000

type SnapshotCacheEntry = {
  readonly key: string
  readonly loadedAt: number
  readonly value: WebSnapshot
}

type SnapshotFailure = {
  readonly key: string
  readonly at: number
}

// Snapshots are cached per need profile (which of calls/turns/sessions/projects
// an endpoint reads), so light endpoints never pay for or re-trigger a read they
// do not need. Serving is stale-while-revalidate: a cached snapshot is returned
// immediately even when its key or age says it is stale, and that request
// schedules a single background rebuild for the profile. The first request for a
// profile still builds synchronously, and a failed rebuild leaves the last good
// snapshot in place.
const snapshotCache = new Map<string, SnapshotCacheEntry>()
const refreshing = new Set<string>()
const refreshFailures = new Map<string, SnapshotFailure>()

function loadSnapshot(options: ServerOptions, pathname: string): WebSnapshot {
  const needs = snapshotNeeds(pathname)
  const profile = needProfile(needs)
  const sources = resolveSources(options)
  const key = snapshotKey(profile, sources)
  const now = Date.now()
  const cached = snapshotCache.get(profile)

  if (cached === undefined) {
    const value = buildSnapshot(needs, sources)
    snapshotCache.set(profile, { key, loadedAt: now, value })
    return value
  }

  if (cached.key !== key || now - cached.loadedAt >= CACHE_TTL_MS) {
    const failure = refreshFailures.get(profile)
    // A failing key is retried after a short pause instead of on every request;
    // the failure itself is logged only when the failing key changes.
    if (failure === undefined || failure.key !== key || now - failure.at >= RETRY_AFTER_FAILURE_MS)
      scheduleRefresh(profile, key, needs, sources)
  }
  return cached.value
}

function needProfile(needs: SnapshotNeeds) {
  return `${needs.calls ? 1 : 0}${needs.turns ? 1 : 0}${needs.sessions ? 1 : 0}${needs.projects ? 1 : 0}`
}

function resolveSources(options: ServerOptions): SnapshotSources {
  const dataDirectory = path.dirname(defaultDatabasePath())
  const selection = selectAuthoritativeDatabase({
    dataDirectory,
    candidates: listDatabaseCandidates(dataDirectory),
    explicitPath: options.sessionsDB,
    envPath: process.env.OPENCODE_DB,
  })
  const sidecarPath = options.db ?? process.env.OPENCODE_USAGE_DB ?? defaultDatabasePath()
  return {
    sidecarPath,
    sidecarExists: existsSync(sidecarPath),
    sessionsPath: selection.ok ? selection.path : null,
    sessionsSource: selection.ok ? selection.source : null,
    sessionsResolveError: selection.ok ? null : selection.message,
    plansPath: resolvePlansPath(options, sidecarPath),
    openDesignSessionPath: resolveSessionPath(sidecarPath),
  }
}

/** `--plans` wins over `OPENCODE_USAGE_PLANS`, which wins over a file beside the sidecar. */
function resolvePlansPath(options: ServerOptions, sidecarPath: string) {
  if (options.plans !== null) return options.plans
  if (process.env.OPENCODE_USAGE_PLANS !== undefined) return process.env.OPENCODE_USAGE_PLANS
  return path.join(path.dirname(sidecarPath), "usage-plans.json")
}

function snapshotKey(profile: string, sources: SnapshotSources) {
  return [
    profile,
    sources.sessionsPath ?? "-",
    sources.sessionsPath === null ? "-" : databaseKey(sources.sessionsPath),
    sources.sessionsSource ?? "-",
    sources.sidecarPath,
    sources.sidecarExists ? databaseKey(sources.sidecarPath) : "-",
    sources.plansPath,
    fileKey(sources.plansPath),
  ].join("|")
}

function scheduleRefresh(
  profile: string,
  key: string,
  needs: SnapshotNeeds,
  sources: SnapshotSources,
) {
  if (refreshing.has(profile)) return
  refreshing.add(profile)
  // The SQLite reads are synchronous, so the rebuild is deferred past this
  // request's response. It still blocks the event loop while it runs.
  setTimeout(() => {
    try {
      const value = buildSnapshot(needs, sources)
      snapshotCache.set(profile, { key, loadedAt: Date.now(), value })
      refreshFailures.delete(profile)
    } catch (error) {
      const failure = refreshFailures.get(profile)
      refreshFailures.set(profile, { key, at: Date.now() })
      if (failure?.key !== key)
        console.error(
          `web snapshot refresh failed (${profile}): ${error instanceof Error ? error.message : String(error)}`,
        )
    } finally {
      refreshing.delete(profile)
    }
  }, 0)
}

function buildSnapshot(needs: SnapshotNeeds, sources: SnapshotSources): WebSnapshot {
  const sidecar =
    sources.sidecarExists && (needs.calls || needs.turns)
      ? readSidecar(sources.sidecarPath, needs.calls, needs.turns)
      : { calls: [], turns: [] }
  const sessionsPath = sources.sessionsPath
  const sessions =
    sessionsPath === null || !needs.sessions ? undefined : readDatabase(sessionsPath, readSessions)
  const projectDirectory =
    needs.projects && sessionsPath !== null
      ? readDatabase(sessionsPath, readProjectDirectory)
      : undefined
  const plans = loadPlans(sources.plansPath)
  // Put each call on its plan's own price card. A flat-card plan (OpenDesign)
  // meters at the console's per-token prices, which are not OpenCode's recorded
  // table; a clock-rated plan keeps its recorded price, which is already the
  // official price for the hour. See web/impute.ts for why this is read-time.
  const imputed = alignCosts(sidecar.calls, plans.plans)
  return {
    sidecarPath: sources.sidecarPath,
    sidecarExists: sources.sidecarExists,
    calls: imputed.calls,
    turns: sidecar.turns,
    imputedCostUSD: imputed.adjustedUSD,
    unpricedCalls: imputed.unpricedCalls,
    sessionsPath,
    sessionsSource: sources.sessionsSource,
    sessionsExists: sessions !== undefined,
    sessionsResolveError: sources.sessionsResolveError,
    sessions: sessions ?? [],
    projects: projectDirectory?.projects ?? [],
    sessionProjects: projectDirectory?.sessionProjects ?? [],
    plans: plans.plans,
    plansPath: plans.path,
  }
}

// The authoritative database's identity is the mtime and size of both the main
// file and its WAL. No database handle survives the read.
function readDatabase<T>(
  file: string,
  read: (db: Database) => T,
): T | undefined {
  const db = openReadOnly(file)
  if (db === undefined) return undefined
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function databaseKey(file: string) {
  return `${fileKey(file)}|${fileKey(`${file}-wal`)}`
}

function fileKey(file: string) {
  try {
    const info = statSync(file)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return "-"
  }
}

/** The session file is part of the cache key: connecting must invalidate a cached status. */
function quotaKey(file: string) {
  return fileKey(file)
}

function readSidecar(
  file: string,
  readCallRows: boolean,
  readTurnRows: boolean,
): { calls: readonly CallRow[]; turns: readonly TurnRecord[] } {
  if (!readCallRows && !readTurnRows) return { calls: [], turns: [] }
  const db = openReadOnly(file)
  if (db === undefined) return { calls: [], turns: [] }
  try {
    return {
      calls: readCallRows ? readCalls(db) : [],
      turns: readTurnRows ? readTurns(db) : [],
    }
  } catch (error) {
    // An existing but never-initialized sidecar has no `call` table yet.
    if (error instanceof Error && error.message.includes("no such table")) return { calls: [], turns: [] }
    throw error
  } finally {
    db.close()
  }
}

function openReadOnly(file: string) {
  if (!existsSync(file)) return undefined
  const db = new Database(file, { readonly: true })
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function describeStartup(options: ServerOptions) {
  const dataDirectory = path.dirname(defaultDatabasePath())
  const selection = selectAuthoritativeDatabase({
    dataDirectory,
    candidates: listDatabaseCandidates(dataDirectory),
    explicitPath: options.sessionsDB,
    envPath: process.env.OPENCODE_DB,
  })
  const sidecarPath = options.db ?? process.env.OPENCODE_USAGE_DB ?? defaultDatabasePath()
  const plansPath = resolvePlansPath(options, sidecarPath)
  return {
    sidecarPath,
    sidecarExists: existsSync(sidecarPath),
    sessionsPath: selection.ok ? selection.path : null,
    plansPath,
    plansExists: existsSync(plansPath),
    warning: selection.ok ? null : selection.message,
  }
}

function parseArguments(argv: readonly string[]):
  | { readonly ok: true; readonly options: ServerOptions }
  | { readonly ok: false; readonly message: string } {
  let port = DEFAULT_PORT
  let host = LOOPBACK
  let db: string | null = null
  let sessionsDB: string | null = null
  let plans: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) break
    if (!argument.startsWith("--")) return { ok: false, message: `unexpected argument: ${argument}` }
    const equals = argument.indexOf("=")
    const name = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)
    const value = inline ?? argv[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith("--")))
      return { ok: false, message: `missing value for ${name}` }
    if (inline === undefined) index += 1

    if (name === "--port") {
      if (!/^\d+$/.test(value)) return { ok: false, message: `invalid --port value: ${value}` }
      const candidate = Number(value)
      if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 65_535)
        return { ok: false, message: `invalid --port value: ${value}` }
      port = candidate
    } else if (name === "--host") {
      if (value !== LOOPBACK && value !== ALL_INTERFACES)
        return {
          ok: false,
          message: `refusing --host ${value}: use ${LOOPBACK} (loopback only) or pass --host ${ALL_INTERFACES} explicitly`,
        }
      host = value
    } else if (name === "--db") db = value
    else if (name === "--sessions-db") sessionsDB = value
    else if (name === "--plans") plans = value
    else return { ok: false, message: `unknown flag: ${name}` }
  }

  return { ok: true, options: { port, host, db, sessionsDB, plans } }
}
