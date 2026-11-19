/**
 * Live OpenDesign account status, read with the browser's session cookie.
 *
 * The inference API (`amr-link`) takes an `sk-amr-…` key, but the console's own
 * account API (`amr-api`) authenticates with the session cookie a signed-in
 * browser holds. Every `/api/v1` path answers `401 {"error":"unauthenticated"}`
 * to the key, so the cookie is the only way to read the credit windows.
 *
 * These are the console's own endpoints and shapes, taken from its bundle rather
 * than from documentation, so a rename surfaces as an `error` state with the
 * moving part named instead of as silently zero usage. Parsing is pure and
 * separate from the network so the shapes are testable without the internet.
 */

import { cookieHeader, mergeSetCookies, OPENDESIGN_API, type StoredCookie } from "./od-session"
import type { ProviderQuotaStatus, QuotaWindow } from "./quotas"

const REQUEST_TIMEOUT_MS = 8_000

/** Workspace-scoped routes are routed by this header in the console bundle. */
const WORKSPACE_HEADER = "x-vela-workspace-id"

/** `durationSeconds` and `kind` are the two ways the console labels a window. */
const WINDOW_SECONDS = { 18_000: "rolling", 604_800: "weekly" } as const
const WINDOW_KINDS = { "5h": "rolling", "7d": "weekly" } as const

export type OpenDesignReading = {
  readonly status: ProviderQuotaStatus
  /** Cookies after applying any `Set-Cookie`, when the session was rotated. */
  readonly rotated: readonly StoredCookie[] | null
}

type Context = {
  readonly workspaceID: string
  readonly account: string | null
  readonly plan: string | null
}

/**
 * Read the account's Design Plan windows.
 *
 * The calls are sequential because each needs the previous one: the workspace id
 * comes from the context, the windows from that workspace. One failing call
 * fails the reading with the reason named, because a partial answer here would
 * look like "no usage".
 */
export async function readOpenDesign(
  cookies: readonly StoredCookie[],
  /** The API origin. Overridable so a test can point the same code at a local server. */
  base = process.env.OPENCODE_USAGE_OD_API ?? OPENDESIGN_API,
): Promise<OpenDesignReading> {
  if (cookies.length === 0)
    return { status: { state: "missing", reason: "No OpenDesign console session is connected" }, rotated: null }

  let latest = cookies
  let rotated = false

  const call = async (path: string, workspaceID?: string) => {
    const headers: Record<string, string> = { accept: "application/json", cookie: cookieHeader(latest) }
    if (workspaceID !== undefined) headers[WORKSPACE_HEADER] = workspaceID
    let response: Response
    try {
      response = await fetch(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new Failure("OpenDesign could not be reached")
    }
    const merged = mergeSetCookies(latest, response.headers)
    if (cookieHeader(merged) !== cookieHeader(latest)) {
      latest = merged
      rotated = true
    }
    if (response.status === 401 || response.status === 403)
      throw new Failure("The saved OpenDesign session was rejected; connect the console again")
    if (!response.ok) throw new Failure(`OpenDesign returned HTTP ${response.status} for ${path}`)
    return (await response.json().catch(() => null)) as unknown
  }

  try {
    const context = parseContext(await call("/v1/workspaces/current"))
    if (context === null) throw new Failure("OpenDesign did not report a workspace")
    const body = await call(
      `/v1/workspaces/${encodeURIComponent(context.workspaceID)}/billing/coding-plan-usage`,
      context.workspaceID,
    )
    const plan = parsePlan(body) ?? context.plan
    const windows = parseWindows(body)
    // A personal workspace on no paid tier answers cleanly with no windows; that
    // is a real state, not a failure, and the caps below still show.
    if (windows.length === 0 && !hasCodingPlan(body))
      return {
        status: {
          state: "ok",
          account: context.account,
          plan,
          windows: [],
          budgets: [],
          notes: ["No Design Plan credits on this workspace"],
        },
        rotated: rotated ? latest : null,
      }
    if (windows.length === 0) throw new Failure("OpenDesign reported no Design Plan windows for this workspace")
    return {
      status: { state: "ok", account: context.account, plan, windows, budgets: [], notes: [] },
      rotated: rotated ? latest : null,
    }
  } catch (error) {
    return { status: failure(error), rotated: rotated ? latest : null }
  }
}

class Failure extends Error {}

function failure(error: unknown): ProviderQuotaStatus {
  if (error instanceof Failure) return { state: "error", reason: error.message }
  return { state: "error", reason: "OpenDesign returned an unrecognised response" }
}

/**
 * The workspace the session belongs to and its name.
 *
 * `workspaces/current` reports the workspace object itself; a wrapper key is
 * accepted too rather than pinning to one envelope. The plan tier is not here —
 * it lives on the coding-plan response — so this falls back to the membership
 * tier, which the console's workspace schema carries.
 */
export function parseContext(body: unknown): Context | null {
  const root = record(body)
  if (root === null) return null
  const workspace = record(root.workspace) ?? record(root.currentWorkspaceContext) ?? root
  const workspaceID = text(workspace.workspaceId) ?? text(workspace.id)
  if (workspaceID === null) return null
  return {
    workspaceID,
    account: text(workspace.workspaceName) ?? text(workspace.name) ?? text(root.email),
    plan: titleCase(text(workspace.personalMembershipTier) ?? text(workspace.planId)),
  }
}

/** The tier the coding-plan response reports, which is the authoritative plan. */
export function parsePlan(body: unknown): string | null {
  return titleCase(text(record(body)?.tier))
}

/**
 * The Design Plan windows, as the console's own card reads them.
 *
 * The console reports credits used and remaining as decimal strings, so the
 * percentage is computed from them rather than from a float divide where it can
 * be avoided. Windows are keyed by `durationSeconds` on the coding-plan response
 * and by `kind` (`5h` / `7d`) on the billing snapshot, so both are accepted:
 * dropping a window because a field was renamed would read as "no usage".
 */
export function parseWindows(body: unknown): QuotaWindow[] {
  const root = record(body)
  const list = Array.isArray(root?.windows) ? root.windows : Array.isArray(body) ? body : []
  const windows: QuotaWindow[] = []
  for (const item of list) {
    const entry = record(item)
    if (entry === null) continue
    const limit = amount(entry.limitCredits)
    const used = amount(entry.usedCredits)
    const remaining = amount(entry.remainingCredits)
    if (limit === null || limit <= 0 || (used === null && remaining === null)) continue
    const id = windowID(entry)
    if (id === undefined) continue
    const usedPercent =
      used !== null ? (used / limit) * 100 : remaining === null ? 0 : (1 - remaining / limit) * 100
    windows.push({
      id,
      label: id === "rolling" ? "5-hour" : "7-day",
      // Rounded to a tenth the way the console displays it, so the number on
      // this page and the number there never disagree by a rounding step.
      usedPercent: Math.min(100, Math.max(0, Math.round(usedPercent * 10) / 10)),
      limited: remaining !== null ? remaining <= 0 : used !== null && used >= limit,
      resetsAt: timestamp(entry.resetsAt),
      capCredits: limit,
    })
  }
  return windows.sort((left, right) => (left.id === "rolling" ? -1 : 1) - (right.id === "rolling" ? -1 : 1))
}

/** True when the workspace is on a paid Design Plan at all. */
function hasCodingPlan(body: unknown) {
  const root = record(body)
  if (root === null) return false
  if (root.eligible === false) return false
  const tier = text(root.tier)
  return tier !== null && tier !== "free"
}

function windowID(entry: Record<string, unknown>) {
  const seconds = amount(entry.durationSeconds ?? entry.duration_seconds)
  if (seconds !== null) return WINDOW_SECONDS[seconds as keyof typeof WINDOW_SECONDS]
  const kind = text(entry.kind ?? entry.window)
  if (kind !== null) return WINDOW_KINDS[kind as keyof typeof WINDOW_KINDS]
  return undefined
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Credits arrive as decimal strings (`"4.5"`) on the coding-plan response. */
function amount(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function timestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? Math.round(value * 1000) : value
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function titleCase(value: string | null) {
  if (value === null) return null
  return value.charAt(0).toUpperCase() + value.slice(1)
}
