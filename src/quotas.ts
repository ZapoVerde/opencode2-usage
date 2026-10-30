/**
 * Live provider status scraped from each provider's own API.
 *
 * Recorded calls tell you what you used; these endpoints tell you what the
 * provider thinks you have left. Every provider exposes a different shape, so
 * this module holds one small parser per upstream and normalises them into a
 * single list of windows. Parsing is pure and separate from the network so the
 * shapes are testable without reaching the internet.
 *
 * Nothing here throws on a malformed body: an upstream that changes its schema
 * should degrade to "unavailable" on the dashboard, not break the page.
 */

/** A quota window such as "rolling 5-hour" or "weekly". */
export type QuotaWindow = {
  /** Stable key, e.g. `rolling`, `weekly`, `monthly`. */
  readonly id: string
  /** Human label for the window. */
  readonly label: string
  /** Percent of the allowance consumed, 0–100. Null when the upstream omits it. */
  readonly usedPercent: number | null
  /** True when the upstream reports the window as currently exhausted. */
  readonly limited: boolean
  /** Epoch ms when the window resets, or null when unknown. */
  readonly resetsAt: number | null
}

/** A dollar-denominated budget, such as a Console policy. */
export type QuotaBudget = {
  readonly id: string
  readonly label: string
  readonly limitUSD: number
  readonly spentUSD: number
  readonly resetsAt: number | null
}

export type ProviderQuotaStatus =
  /** The upstream answered and we understood it. */
  | {
      readonly state: "ok"
      /** Account or workspace the numbers belong to, when the API says. */
      readonly account: string | null
      /** Upstream plan name, e.g. `free`, `Pro`. */
      readonly plan: string | null
      readonly windows: readonly QuotaWindow[]
      readonly budgets: readonly QuotaBudget[]
      /** Extra provider-specific facts worth showing verbatim. */
      readonly notes: readonly string[]
    }
  /** The provider has no usage API we can read. */
  | { readonly state: "unsupported"; readonly reason: string }
  /** The API exists but this call failed; `reason` is safe to display. */
  | { readonly state: "error"; readonly reason: string }
  /** No usable credential is stored, so there is nothing to ask. */
  | { readonly state: "missing"; readonly reason: string }

/** A published allowance window, resolved against the live percentage. */
export type AdvertisedWindow = {
  readonly id: string
  readonly label: string
  /** A fraction of the monthly allowance, or a fixed dollar cap. */
  readonly kind: "share" | "cap"
  /** The window's cap in dollars, or null when no allowance is known. */
  readonly capUSD: number | null
  /** Percent the provider reported for this window. */
  readonly upstreamPercent: number | null
  /**
   * Dollars that percentage represents. This is the account's whole usage, which
   * is usually larger than this machine's share whenever the key is used
   * elsewhere.
   */
  readonly upstreamUSD: number | null
  /** Epoch ms when the window resets, when the provider reports it. */
  readonly resetsAt: number | null
}

export type AdvertisedQuota = {
  readonly providerID: string
  readonly label: string
  readonly monthlyUSD: number
  /** Total monthly credits, for plans that publish one pool. */
  readonly monthlyCreditsUSD: number | null
  /** Monthly allowance in dollars, from the plan or the dominant model in use. */
  readonly allowanceUSD: number | null
  /** The model whose allowance the figure came from, when it is per-model. */
  readonly allowanceModel: string | null
  /**
   * Published per-model multiplier: design credits drawn per dollar of DeepSeek
   * list price. Distinct from the recorded-to-credits factor, which also folds in
   * the off-peak/peak and pool conversions.
   */
  readonly multiplier: number | null
  /** True when the window mixed models with different allowances. */
  readonly mixedModels: boolean
  /** Recorded spend in this window, USD. */
  readonly recordedUSD: number
  /** Recorded spend converted into the provider's credits, applying multipliers. */
  readonly creditsUSD: number
  /** Models without a published multiplier, counted at 1x. */
  readonly unknownModels: readonly string[]
  /** Recorded spend on promotional models that draw no credits. */
  readonly unmeteredUSD: number
  readonly models: readonly string[]
  readonly windows: readonly AdvertisedWindow[]
  /** Where the advertised figures come from. */
  readonly source: string
}

export type QuotasResponse = {
  /** Epoch ms when these numbers were fetched. */
  readonly fetchedAt: number
  /** Status keyed by integration id, which is what owns the credential. */
  readonly results: Readonly<Record<string, ProviderQuotaStatus>>
  /**
   * Recorded-call provider id → integration id, for providers whose API is
   * served under a different name. OpenCode records `opencode-go` for Go
   * traffic while the credential belongs to the `opencode` integration.
   */
  readonly aliases: Readonly<Record<string, string>>
  /** Published allowance per integration, for the providers that have one. */
  readonly advertised: Readonly<Record<string, AdvertisedQuota>>
}

/** Percent values arrive as either 0–100 or 0–1 depending on the upstream. */
function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  return Math.round(Math.min(value, 100) * 10) / 10
}

/** ISO string, epoch seconds, or epoch ms to epoch ms. */
function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Anything below ~2001 in ms is really seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * OpenCode Zen Go allowance: `GET /zen/go/v1/usage`.
 *
 * Shape: `{ usage: { rolling, weekly, monthly } }` where each meter is
 * `{ status: "ok" | "rate-limited", percent, resetsAt }`.
 */
export function parseGoUsage(body: unknown): ProviderQuotaStatus {
  const usage = record(record(body)?.usage)
  if (usage === null) return { state: "error", reason: "unexpected Go usage response" }
  const labels: Record<string, string> = { rolling: "5-hour", weekly: "Weekly", monthly: "Monthly" }
  const windows: QuotaWindow[] = []
  for (const [id, label] of Object.entries(labels)) {
    const meter = record(usage[id])
    if (meter === null) continue
    windows.push({
      id,
      label,
      usedPercent: percent(meter.percent),
      limited: meter.status === "rate-limited",
      resetsAt: timestamp(meter.resetsAt),
    })
  }
  if (windows.length === 0) return { state: "error", reason: "Go usage had no meters" }
  return { state: "ok", account: null, plan: "Go", windows, budgets: [], notes: [] }
}

/**
 * OpenCode Console budgets: `GET /console/api/policies/current-budgets`.
 *
 * An empty array is a valid answer meaning the workspace has no spend caps, so
 * it is reported as `ok` with no budgets rather than as an error.
 */
export function parseConsoleBudgets(body: unknown): ProviderQuotaStatus {
  if (!Array.isArray(body)) return { state: "error", reason: "unexpected budgets response" }
  const budgets: QuotaBudget[] = []
  for (const item of array(body)) {
    const budget = record(item)
    if (budget === null) continue
    const limitUSD = budget.limitDollars
    const spentUSD = budget.spentDollars
    if (typeof limitUSD !== "number" || typeof spentUSD !== "number") continue
    budgets.push({
      id: typeof budget.ruleID === "string" ? budget.ruleID : `budget-${budgets.length}`,
      label: typeof budget.scope === "string" ? budget.scope : "Budget",
      limitUSD,
      spentUSD,
      resetsAt: timestamp(budget.resetsAt),
    })
  }
  return { state: "ok", account: null, plan: null, windows: [], budgets, notes: [] }
}

/**
 * OpenAI (ChatGPT plan): `GET /backend-api/wham/usage`.
 *
 * Primary/secondary windows are rolling rate limits; `credits` and
 * `rate_limit_reset_credits` are worth surfacing because they decide whether a
 * blocked request can recover early.
 */
export function parseOpenAIUsage(body: unknown): ProviderQuotaStatus {
  const root = record(body)
  if (root === null) return { state: "error", reason: "unexpected usage response" }
  const rateLimit = record(root.rate_limit)
  const windows: QuotaWindow[] = []
  for (const [key, label] of [
    ["primary_window", "Primary"],
    ["secondary_window", "Secondary"],
  ] as const) {
    const window = record(rateLimit?.[key])
    if (window === null) continue
    windows.push({
      id: key === "primary_window" ? "primary" : "secondary",
      label,
      usedPercent: percent(window.used_percent),
      limited: rateLimit?.limit_reached === true,
      resetsAt: timestamp(window.reset_at),
    })
  }

  const notes: string[] = []
  const credits = record(root.credits)
  if (credits !== null && credits.has_credits === true) {
    notes.push(
      typeof credits.balance === "number" ? `$${credits.balance.toFixed(2)} in credits` : "Has credits available",
    )
  }
  const resets = record(root.rate_limit_reset_credits)
  if (typeof resets?.available_count === "number" && resets.available_count > 0)
    notes.push(
      `${resets.available_count} reset credit${resets.available_count === 1 ? "" : "s"}`,
    )
  const spend = record(root.spend_control)
  if (spend?.reached === true) notes.push("Spend control reached")

  return {
    state: "ok",
    account: typeof root.email === "string" ? root.email : null,
    plan: typeof root.plan_type === "string" ? root.plan_type : null,
    windows,
    budgets: [],
    notes,
  }
}
