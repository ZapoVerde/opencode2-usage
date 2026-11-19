/**
 * Fetch live provider status from each provider's own API.
 *
 * The dashboard is otherwise a pure reader of local SQLite, so this module is
 * the one place that talks to the network. It stays opt-in: a provider with no
 * credential or no known usage API is reported as such rather than skipped, so
 * the page can explain what it knows and what it cannot.
 *
 * Credentials come from the same authoritative database the dashboard already
 * reads read-only, which means no dependency on a running OpenCode server.
 */

import { parseConsoleBudgets, parseGoUsage, parseOpenAIUsage, type ProviderQuotaStatus } from "./quotas"
import type { CredentialRecord } from "./read"
import { readOpenDesign } from "./od-source"
import type { StoredCookie } from "./od-session"

const REQUEST_TIMEOUT_MS = 8_000
const OPENCODE_CONSOLE = "https://opencode.ai/console"
const OPENAI_USAGE = "https://chatgpt.com/backend-api/wham/usage"

/** Long enough that a page reload does not re-hit every upstream. */
export const QUOTA_TTL_MS = 60_000

type Credential = CredentialRecord

export type QuotaSources = {
  readonly credentials: readonly Credential[]
  /**
   * OpenDesign has no API key that reads account usage: the console's own
   * endpoints need the session cookie a signed-in browser holds. It arrives
   * separately from `credentials` because it is not a stored OpenCode
   * credential and only this dashboard knows where it lives.
   */
  readonly openDesign?: {
    readonly cookies: readonly StoredCookie[]
    /** Called when the console rotates the session, so the new value is kept. */
    readonly onRotate: (cookies: readonly StoredCookie[]) => void
  }
}

/**
 * Recorded-call provider id → the integration that owns its credential.
 *
 * OpenCode serves Go through the `opencode` integration but records calls under
 * `opencode-go`, so the two have to be reconciled somewhere explicit rather than
 * by prefix guessing.
 */
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "opencode-go": "opencode",
}

/**
 * Read every provider we know how to ask.
 *
 * Each provider is fetched concurrently and independently: one slow or broken
 * upstream must not delay or blank the others.
 */
export async function readQuotas(sources: QuotaSources): Promise<Record<string, ProviderQuotaStatus>> {
  const byIntegration = activeCredentials(sources.credentials)
  const [opencode, openai, commandcode, opendesign] = await Promise.all([
    opencodeStatus(byIntegration.get("opencode")),
    openaiStatus(byIntegration.get("openai")),
    Promise.resolve<ProviderQuotaStatus>({
      state: "unsupported",
      reason: "Command Code publishes a model list but no usage or balance API",
    }),
    openDesignStatus(sources.openDesign),
  ])
  return { opencode, openai, commandcode, opendesign }
}

/**
 * OpenDesign, from the console session cookie.
 *
 * Without a stored session the provider is `missing` rather than `unsupported`:
 * the API exists and the dashboard can read it, it just needs the browser's
 * cookie. Saying which of those it is tells you whether connecting will help.
 */
async function openDesignStatus(session: QuotaSources["openDesign"]): Promise<ProviderQuotaStatus> {
  if (session === undefined || session.cookies.length === 0)
    return { state: "missing", reason: "No OpenDesign console session is connected" }
  const reading = await readOpenDesign(session.cookies)
  if (reading.rotated !== null) session.onRotate(reading.rotated)
  return reading.status
}

/**
 * One active credential per integration. A provider can hold several (an old
 * key and a current one), and only the active row is the one in use.
 */
function activeCredentials(credentials: readonly Credential[]) {
  const active = new Map<string, Credential>()
  for (const credential of credentials) {
    if (!credential.active) continue
    // Later rows win, matching the server's "newest active" behaviour.
    active.set(credential.integrationID, credential)
  }
  return active
}

async function opencodeStatus(credential: Credential | undefined): Promise<ProviderQuotaStatus> {
  if (credential === undefined)
    return { state: "missing", reason: "No OpenCode Console credential is connected" }
  const token = bearer(credential)
  if (token === null) return { state: "missing", reason: "The OpenCode Console credential has no access token" }
  const workspaceID = credential.metadata.orgID
  if (typeof workspaceID !== "string")
    return { state: "missing", reason: "The OpenCode Console credential has no workspace id" }

  const server = typeof credential.metadata.server === "string" ? credential.metadata.server : OPENCODE_CONSOLE
  const origin = new URL(server).origin
  const [go, budgets] = await Promise.all([
    request(`${origin}/zen/go/v1/usage`, token, { "x-opencode-org-id": workspaceID }).then(parseStatus(parseGoUsage)),
    request(`${server}/api/policies/current-budgets`, token, { "x-org-id": workspaceID }).then(
      parseStatus(parseConsoleBudgets),
    ),
  ])

  // Go is the headline; its absence (a 403 for a non-Go workspace) just means we
  // fall back to budgets alone.
  const base = go.state === "ok" ? go : budgets.state === "ok" ? budgets : null
  if (base === null) return budgets.state === "error" ? budgets : go
  return {
    state: "ok",
    account: typeof credential.metadata.email === "string" ? credential.metadata.email : null,
    plan: go.state === "ok" ? "Go" : null,
    windows: go.state === "ok" ? go.windows : [],
    budgets: budgets.state === "ok" ? budgets.budgets : [],
    notes: typeof credential.metadata.orgName === "string" ? [`Workspace ${credential.metadata.orgName}`] : [],
  }
}

async function openaiStatus(credential: Credential | undefined): Promise<ProviderQuotaStatus> {
  if (credential === undefined) return { state: "missing", reason: "No OpenAI credential is connected" }
  const token = bearer(credential)
  if (token === null) return { state: "missing", reason: "The OpenAI credential has no access token" }
  const accountID = credential.metadata.accountID
  const status = await request(OPENAI_USAGE, token, {
    ...(typeof accountID === "string" ? { "chatgpt-account-id": accountID } : {}),
  }).then(parseStatus(parseOpenAIUsage))
  return status
}

/** Bearer token from either an API key or an OAuth access token. */
function bearer(credential: Credential) {
  if (credential.value.type === "key") return credential.value.key
  if (credential.value.type === "oauth") return credential.value.access
  return null
}

/** Turn a settled response into a parsed status, mapping transport failures to `error`. */
function parseStatus(parse: (body: unknown) => ProviderQuotaStatus) {
  return (result: { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: string }) =>
    result.ok ? parse(result.body) : { state: "error", reason: result.reason } as ProviderQuotaStatus
}

async function request(
  url: string,
  token: string,
  headers: Record<string, string>,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: string }> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      // 401/403 usually means the token expired; say so without echoing the body.
      if (response.status === 401 || response.status === 403)
        return { ok: false, reason: "The saved credential was rejected; reconnect it in OpenCode" }
      return { ok: false, reason: `The provider returned HTTP ${response.status}` }
    }
    return { ok: true, body: await response.json() }
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      return { ok: false, reason: "The provider did not answer in time" }
    return { ok: false, reason: "The provider could not be reached" }
  }
}
