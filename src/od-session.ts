/**
 * OpenDesign session cookies, kept in the shape the browser sends them.
 *
 * OpenDesign's account API authenticates with a session cookie rather than an
 * API key: the `sk-amr-…` key opens inference on `amr-link`, while everything
 * under `amr-api/open-design.ai/api/v1` answers 401 to it. The only credential
 * that reaches the usage windows is the cookie a signed-in browser holds, so
 * this module is the boundary where a pasted storage_state, a cookie array, or
 * a raw `Cookie` header becomes the one list of cookies we replay.
 *
 * Filtering to the OpenDesign hosts is what stops an unrelated browser cookie
 * from being stored and later sent to the provider.
 */

export type StoredCookie = {
  readonly name: string
  readonly value: string
  /** Leading dot removed, lowercased. */
  readonly domain: string
}

export type OpenDesignSession = {
  readonly cookies: readonly StoredCookie[]
  /** Epoch ms the cookies were last confirmed to authenticate. */
  readonly confirmedAt: number | null
  /** Account the session belonged to at that confirmation, for display. */
  readonly account: string | null
}

/** The API host, and the site that owns the cookie jar. */
export const OPENDESIGN_API = "https://amr-api.open-design.ai/api"
export const OPENDESIGN_HOST = "open-design.ai"

/** Domains a cookie may carry for us to replay it to the API. */
const ALLOWED_DOMAINS = [OPENDESIGN_HOST, "amr-api.open-design.ai"]

export function isOpenDesignDomain(domain: string) {
  const bare = domain.replace(/^\./, "").toLowerCase()
  return ALLOWED_DOMAINS.some((allowed) => bare === allowed || bare.endsWith(`.${allowed}`))
}

/**
 * Turn whatever the user pasted into cookies.
 *
 * People copy different things out of a browser, so every one of these works:
 *
 * - a raw `a=1; b=2` Cookie header (Network → any request → Request Headers)
 * - the same with a `Cookie:` or `cookie:` label in front
 * - a whole `curl` command (Network → Copy → Copy as cURL)
 * - a whole `fetch(...)` snippet (Copy as fetch)
 * - a Playwright `storage_state.json`, or a cookie array / single cookie
 * - the `document.cookie` string from the console
 *
 * A pasted value carries no domain, so it is trusted as-is: the only reason to
 * paste one is that it came from a request to the API.
 */
export function normaliseCookies(input: unknown): StoredCookie[] {
  if (typeof input === "string") {
    const trimmed = input.trim()
    if (trimmed.length === 0) throw new Error("The session is empty.")
    // A pasted header, cURL command, or fetch snippet can all begin with a brace
    // (`{ headers: … }`), so transport extraction runs first and JSON parsing is
    // only attempted when that finds nothing.
    const fromTransport = extractCookieFromRequest(unescapeWindowsCmd(trimmed))
    if (fromTransport !== null) return dedupe(parseCookieHeader(fromTransport))
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        throw new Error("That looks like JSON but could not be parsed.")
      }
      return normaliseCookies(parsed)
    }
    const cookies = parseCookieHeader(stripCookieLabel(unescapeWindowsCmd(trimmed)))
    if (cookies.length === 0)
      throw new Error(
        "No cookies were found in that. Copy the Cookie request header (or a whole Copy as cURL) for a request to amr-api.open-design.ai.",
      )
    return dedupe(cookies)
  }

  if (Array.isArray(input)) {
    const cookies = input
      .map((item) => normaliseCookie(item))
      .filter((cookie): cookie is StoredCookie => cookie !== null)
    if (cookies.length === 0)
      throw new Error(`No cookies for ${OPENDESIGN_HOST} were found in that list.`)
    return dedupe(cookies)
  }

  if (isRecord(input)) {
    if (Array.isArray(input.cookies)) return normaliseCookies(input.cookies)
    // A browser's `document.cookie` is not a thing, but a `{ cookie: "..." }`
    // object is a common shape from someone writing a script by hand.
    if (typeof input.cookie === "string") return normaliseCookies(input.cookie)
    if (typeof input.Cookie === "string") return normaliseCookies(input.Cookie)
    const single = normaliseCookie(input)
    if (single !== null) return [single]
  }

  throw new Error("Expected a Cookie header, a Copy as cURL, a storage_state.json, or a cookie array.")
}

/** A pasted header often keeps its `cookie:` label; the pairs after it are what matter. */
function stripCookieLabel(text: string) {
  return text.replace(/^\s*cookie\s*:\s*/i, "")
}

/**
 * Undo the escaping in a Windows `cmd` cURL export.
 *
 * Firefox and Chrome on Windows copy `curl --url ^"https://…^" -b ^"a=^%^2Fb^"`.
 * In cmd, `^` escapes whatever follows it, so `^%` is a literal `%` and `^"` a
 * literal quote. Only text that shows that signature is rewritten, so a value
 * that happens to contain a caret of its own survives unchanged.
 */
function unescapeWindowsCmd(text: string) {
  if (!text.includes('^"') && !text.includes("^%")) return text
  return text.replace(/\^(.)/gs, "$1")
}

/**
 * Pull the cookie out of a `curl` command or a `fetch` snippet.
 *
 * A DevTools "Copy all as cURL" is a long list of commands, most of them for
 * static assets that carry no session. So every cookie flag in the text is
 * collected and merged, and a set that contains the session cookie wins: taking
 * the first match would pick whichever request happened to come first.
 *
 * Returns null when the text is not one of those, so a plain header falls
 * through to the normal parser.
 */
function extractCookieFromRequest(text: string): string | null {
  const found: string[] = []

  // `curl '…' -H 'cookie: a=1; b=2'` / `-b 'a=1; b=2'` / `--cookie 'a=1; b=2'`
  for (const match of text.matchAll(/(?:-H|--header)\s+(['"])\s*cookie\s*:\s*([^'"]*)\1/gi))
    if (match[2] !== undefined) found.push(match[2].trim())
  for (const match of text.matchAll(/(?:-b|--cookie)\s+(['"])([^'"]*)\1/gi))
    if (match[2] !== undefined) found.push(match[2].trim())

  // `"cookie": "a=1; b=2"` or `"Cookie": "a=1; b=2"` as a JSON object property,
  // which is what Copy as fetch produces.
  for (const match of text.matchAll(/"cookie"\s*:\s*"([^"]+)"/gi))
    if (match[1] !== undefined) found.push(unescapeJson(match[1]).trim())

  // `headers: { ... }` written without quotes.
  for (const match of text.matchAll(/(?:^|[{,\s])cookie\s*:\s*['"`]([^'"`]+)['"`]/gi))
    if (match[1] !== undefined) found.push(match[1].trim())

  const usable = found.filter((header) => header.length > 0)
  if (usable.length === 0) return null
  // A header with the session cookie is the only one worth replaying; the others
  // are analytics and attribution from asset requests.
  return usable.find((header) => SESSION_COOKIE.test(header)) ?? usable[0] ?? null
}

/** Both halves of what the console sets: the token and its per-workspace twin. */
const SESSION_COOKIE = /(?:__Secure-)?better-auth\.session_token/i

/** A JSON string literal's escapes are already decoded by JSON, but a snippet may not be strict JSON. */
function unescapeJson(value: string) {
  try {
    return JSON.parse(`"${value.replaceAll('"', '\\"')}"`) as string
  } catch {
    return value
  }
}

function normaliseCookie(value: unknown): StoredCookie | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (name.length === 0 || typeof value.value !== "string") return null
  // A pasted single cookie or array may omit the domain; the header form does.
  const domain = typeof value.domain === "string" && value.domain.length > 0 ? value.domain : OPENDESIGN_HOST
  if (!isOpenDesignDomain(domain)) return null
  return { name, value: value.value, domain: domain.replace(/^\./, "").toLowerCase() }
}

function parseCookieHeader(header: string): StoredCookie[] {
  return header.split(";").flatMap((pair) => {
    const eq = pair.indexOf("=")
    if (eq <= 0) return []
    const name = pair.slice(0, eq).trim()
    if (name.length === 0) return []
    return [{ name, value: pair.slice(eq + 1).trim(), domain: OPENDESIGN_HOST }]
  })
}

/** Last write wins per name, which is how a browser resolves duplicates from two paths. */
export function dedupe(cookies: readonly StoredCookie[]): StoredCookie[] {
  const byName = new Map<string, StoredCookie>()
  for (const cookie of cookies) byName.set(cookie.name, cookie)
  return [...byName.values()]
}

export function cookieHeader(cookies: readonly StoredCookie[]) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
}

/**
 * Apply whatever the response asked us to set.
 *
 * OpenDesign may slide the session on a request, in which case replaying the
 * stale value next time would fail a probe that had just succeeded. A cookie
 * cleared with `Max-Age=0` or a past `Expires` is removed rather than stored.
 */
export function mergeSetCookies(cookies: readonly StoredCookie[], headers: Headers): StoredCookie[] {
  const next = new Map(cookies.map((cookie) => [cookie.name, cookie]))
  const lines =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitCombinedSetCookie(headers.get("set-cookie"))
  for (const line of lines) {
    const [pair, ...attributes] = line.split(";")
    if (pair === undefined) continue
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    if (name.length === 0) continue
    const value = pair.slice(eq + 1).trim()

    const expired = attributes.some((attribute) => {
      const [key, attributeValue] = attribute.split("=")
      const lowered = key?.trim().toLowerCase()
      if (lowered === "max-age" && attributeValue !== undefined)
        return Number(attributeValue.trim()) <= 0
      if (lowered === "expires" && attributeValue !== undefined) {
        const at = Date.parse(attributeValue.trim())
        return Number.isFinite(at) && at <= Date.now()
      }
      return false
    })
    if (expired) next.delete(name)
    else next.set(name, { name, value, domain: OPENDESIGN_HOST })
  }
  return [...next.values()]
}

/** `getSetCookie` is the correct reader, but a combined header still appears. */
function splitCombinedSetCookie(header: string | null): string[] {
  if (header === null) return []
  // A comma inside an `Expires` attribute must not split the line.
  return header.split(/,(?=\s*[^;,=]+=[^;]*;)/)
}

export function sameCookies(left: readonly StoredCookie[], right: readonly StoredCookie[]) {
  if (left.length !== right.length) return false
  const byName = new Map(right.map((cookie) => [cookie.name, cookie.value]))
  return left.every((cookie) => byName.get(cookie.name) === cookie.value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
