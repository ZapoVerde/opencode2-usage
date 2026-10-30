/**
 * Advertised plan limits, as the providers publish them.
 *
 * A usage percentage on its own is hard to act on, and each provider counts
 * usage against its own quota in its own way. This module holds the published
 * limits for the two plans in use, with the source for each figure so it can be
 * re-checked when a provider changes them.
 *
 * Nothing here is measured. It is a static reference table, plus the small
 * amount of arithmetic needed to turn recorded cost into the units a provider
 * actually bills against.
 */

/** A quota window: its cap, and where that cap comes from. */
export type QuotaWindow = {
  readonly id: string
  readonly label: string
  /**
   * How the window is limited:
   * - `share` — a fraction of the monthly allowance (OpenCode Go).
   * - `cap` — a fixed dollar cap (OpenDesign Go).
   */
  readonly kind: "share" | "cap"
  /** Fraction of the monthly allowance, for `share` windows. */
  readonly share: number | null
  /** Dollar cap, for `cap` windows. */
  readonly capUSD: number | null
}

/** USD per 1M tokens on the provider's own rate card. */
export type PlanCard = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type PlanModel = {
  /** Model id as the provider publishes it. */
  readonly id: string
  readonly name: string
  /**
   * Credit multiplier: how many credits one dollar of *list-price* model usage
   * consumes. OpenDesign's Go plan draws 0.5 credits per list dollar for
   * DeepSeek V4.1 Flash, so the same $120 of Design Plan credits buys twice the
   * usage a 1× model gets. A lower multiplier means *more* usage, not less.
   */
  readonly multiplier: number
  /**
   * The provider's own per-token price, when it publishes one. Credits are
   * computed from tokens at these rates, never by scaling a blended recorded
   * dollar total: OpenCode's recorded table and the provider's card differ by a
   * different factor for every token kind (input, output, cache), so a single
   * multiplier cannot reconcile them.
   */
  readonly card: PlanCard | null
  /** Monthly allowance at official API prices, for plans that publish per-model figures. */
  readonly monthlyUSD: number | null
  /** Estimated requests per 5-hour window, where published. */
  readonly requestsPer5h: number | null
  /** True for promotional models that draw nothing from the allowance. */
  readonly unmetered: boolean
}

export type AdvertisedPlan = {
  readonly providerID: string
  readonly label: string
  /** Regular monthly subscription price in USD. */
  readonly monthlyUSD: number
  /** Total credits available per month. */
  readonly monthlyCreditsUSD: number | null
  readonly windows: readonly QuotaWindow[]
  readonly models: readonly PlanModel[]
  /**
   * What the allowance is denominated in, which decides whether the hour of the
   * day changes how many tokens it buys.
   *
   * - `clock` — dollars at the model's official API price as it applies when the
   *   call is made. DeepSeek doubles inside its peak windows, so the same
   *   allowance buys half the tokens at peak. Command Code and OpenCode Go both
   *   quote their allowance this way.
   * - `flat` — one published rate card at every hour. OpenDesign's Design Plan
   *   credits are charged from the console's own per-token card, which does not
   *   move with DeepSeek's clock; the card is the only price that matters.
   *
   * Getting this backwards inverts the whole comparison: it turns a plan that
   * gets cheaper at peak into one that gets more expensive.
   */
  readonly basis: "clock" | "flat"
  /** Where these numbers come from. */
  readonly source: string
}

/**
 * OpenCode Go.
 *
 * Source: `packages/console/app/src/component/go-models.ts` — per-model monthly
 * allowance "at official API prices", e.g. `deepseek-flash` at $80 — plus
 * `go.faq.a9` in `i18n/en.ts`: the quota is "20% of the monthly allowance per
 * 5 hours, 50% per week, and 100% per month", and `go.meta.description` for the
 * $10 monthly price. All in this repository, so these can be re-verified.
 */
const GO_WINDOWS: readonly QuotaWindow[] = [
  { id: "rolling", label: "5-hour", kind: "share", share: 0.2, capUSD: null },
  { id: "weekly", label: "Weekly", kind: "share", share: 0.5, capUSD: null },
  { id: "monthly", label: "Monthly", kind: "share", share: 1, capUSD: null },
]

const GO_MODELS: readonly PlanModel[] = [
  ["kimi-k3", "Kimi K3", 110, 15],
  ["kimi-k3.1-pro", "Kimi K3.1 Pro", 147, 15],
  ["qwen3.8-max", "Qwen3.8 Max", 160, 15],
  ["grok-4.7", "Grok 4.7", 169, 15],
  ["glm-5.3", "GLM-5.3", 220, 15],
  ["step-5-preview", "Step 5 Preview", 430, 15],
  ["gemini-4-argon", "Gemini 4 Argon", 440, 30],
  ["glm-5.2", "GLM-5.2", 880, 60],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 1050, 15],
  ["kimi-k2.7-code", "Kimi K2.7 Code", 1350, 60],
  ["hy4-preview", "Hy4 preview", 1350, 30],
  ["gpt-5.6-luna", "GPT 5.6 Luna", 2050, 15],
  ["minimax-m3", "MiniMax M3", 3200, 60],
  ["mimo-v2.6-pro", "MiMo-V2.6-Pro", 3250, 15],
  ["mimo-v2.5-pro", "MiMo-V2.5-Pro", 3250, 15],
  ["minimax-m3.1-flash", "MiniMax M3.1 Flash", 3880, 20],
  ["claude-haiku-5-5", "Claude Haiku 5.5", 3850, 15],
  ["qwen3.7-plus", "Qwen3.7 Plus", 4300, 60],
  ["gpt-6-luna", "GPT 6 Luna", 4230, 15],
  ["hy3", "Hy3", 4300, 60],
  ["qwen3.8-flash", "Qwen3.8 Flash", 5400, 30],
  ["glm-5.3-flash", "GLM-5.3-Flash", 6320, 60],
  ["deepseek-flash", "DeepSeek V4.1 Flash", 34670, 80],
  ["longcat-2.0", "LongCat-2.0", 11400, 60],
  ["mimo-v2.6-flash", "MiMo-V2.6-Flash", 30100, 60],
  ["mimo-v2.5", "MiMo-V2.5", 30100, 60],
  ["muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", 45300, 60],
  ["muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 45300, 60],
  // Promotional models: listed with an "∞" allowance and no metering.
  ["beam-free", "Beam Free", null, null],
  ["iceman-contributor-free", "Iceman Contributor Free", null, null],
].map(([id, name, requestsPer5h, monthlyUSD]) => ({
  id: id as string,
  name: name as string,
  // Go has no model-level multiplier: every dollar of usage draws one dollar of
  // the allowance.
  multiplier: 1,
  card: null,
  monthlyUSD: monthlyUSD as number | null,
  requestsPer5h: requestsPer5h as number | null,
  unmetered: monthlyUSD === null,
}))

/**
 * OpenDesign Go.
 *
 * Source: <https://open-design.ai/model-credits/> — "Credits by plan" gives Go
 * a $120 monthly maximum with $30 per 7-day window and $10 per 5-hour window,
 * and "Design Plan models and credit multipliers" gives the per-model multiplier.
 * <https://open-design.ai/pricing/> prices Go at $10/month ($8 first month).
 *
 * The multipliers are what make the pricing page add up: DeepSeek V4.1 Flash
 * lists $120 of monthly usage against a $60 base while every 1× model lists $60.
 * A 0.5× multiplier consumes half a credit per list dollar, so the same credit
 * pool reaches twice as far. That is the whole of the "0.5" on DeepSeek.
 *
 * The credit price of a token is the console's own card — input $0.44/M, output
 * $1.32/M, cache read $0.014/M, cache write $0.44/M — taken from the "Credit
 * usage breakdown" popup. It is a flat card at every hour: OpenDesign does not
 * pass DeepSeek's peak/off-peak tier through. OpenCode's recorded table
 * ($0.15 / $0.60 / $0.003) is a different price for every kind, so credits must
 * be computed from tokens at this card, not from a blended recorded dollar.
 */
const OD_WINDOWS: readonly QuotaWindow[] = [
  { id: "rolling", label: "5-hour", kind: "cap", share: null, capUSD: 10 },
  { id: "weekly", label: "7-day", kind: "cap", share: null, capUSD: 30 },
  { id: "monthly", label: "Monthly", kind: "cap", share: null, capUSD: 120 },
]

/**
 * The console card. These are the prices the Credit usage breakdown shows, and
 * the ones the plan's weekly percentage is computed from.
 *
 * Verified for the DeepSeek models against the popover's own arithmetic. The
 * other models keep the rates the plans file already published; they are not
 * DeepSeek's clock either, so the same flat treatment applies.
 */
const OD_CARD: PlanCard = { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 }

const OD_CARDS: Readonly<Record<string, PlanCard>> = {
  "deepseek-v4.1-flash": OD_CARD,
  "deepseek-v4-flash": OD_CARD,
  "deepseek-v4-flash-vision-exp": OD_CARD,
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-haiku-5.5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "glm-5.3-flash": { input: 0.11952, output: 0.41831, cacheRead: 0.03, cacheWrite: 0 },
  "glm-5.3-flashx": { input: 0.29879, output: 1.04577, cacheRead: 0.09, cacheWrite: 0 },
  "kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.15, cacheWrite: 0 },
  "mimo-v2.6-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  "mimo-v2.6-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
  "minimax-m3.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
  "hy4-preview": { input: 0.834, output: 2.501, cacheRead: 0.042, cacheWrite: 0 },
}

const OD_MODELS: readonly PlanModel[] = [
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 0.5],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 1],
  ["deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision Exp", 1],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 1],
  ["glm-5.3-flash", "GLM-5.3 Flash", 1],
  ["glm-5.3-flashx", "GLM-5.3 Flash-X", 2],
  ["claude-haiku-5.5", "Claude Haiku 5.5", 2],
  ["gpt-6-luna", "GPT-6 Luna", 4],
  ["kimi-k2.7-code", "Kimi K2.7 Code", 1],
  ["mimo-v2.6-flash", "MiMo V2.6 Flash", 1],
  ["mimo-v2.6-pro", "MiMo V2.6 Pro", 1],
  ["hy4-preview", "Hunyuan H4 Preview", 1],
  ["minimax-m3.1-flash", "MiniMax M3.1 Flash", 1],
].map((entry) => ({
  id: entry[0] as string,
  name: entry[1] as string,
  multiplier: entry[2] as number,
  // Another vendor's model keeps its own published rate rather than inheriting
  // a DeepSeek card it never quoted.
  card: OD_CARDS[entry[0] as string] ?? null,
  monthlyUSD: null,
  requestsPer5h: null,
  unmetered: false,
}))

/**
 * Command Code GOAT.
 *
 * Source: <https://commandcode.ai/docs/plans/goat> and the provider's pricing
 * page. GOAT is $10/month with per-model monthly allowances at official API
 * prices; the `deepseek-v4.1-flash` deal line reads "$10 Go, $80 GOAT",
 * confirmed by the plan's own model table (`"DeepSeek V4.1 Flash (latest)" …
 * "credits": "$80"`). The rolling windows are the same 20% / 50% / 100% shape
 * Command Code documents for every plan, applied to the plan's monthly credit
 * allocation.
 */
const COMMANDCODE_WINDOWS: readonly QuotaWindow[] = [
  { id: "rolling", label: "5-hour", kind: "share", share: 0.2, capUSD: null },
  { id: "weekly", label: "Weekly", kind: "share", share: 0.5, capUSD: null },
  { id: "monthly", label: "Monthly", kind: "share", share: 1, capUSD: null },
]

/**
 * Only the models this tracker has priced are listed. Anything else falls into
 * `unknownModels` and is counted at 1x, which is the honest answer: the plan's
 * per-model allowance is published, but not the figures for every model.
 */
const COMMANDCODE_MODELS: readonly PlanModel[] = [
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 80],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 60],
  ["deepseek-v4.1-flash-fast", "DeepSeek V4.1 Flash Fast", 60],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 20],
].map(([id, name, monthlyUSD]) => ({
  id: id as string,
  name: name as string,
  multiplier: 1,
  card: null,
  monthlyUSD: monthlyUSD as number,
  requestsPer5h: null,
  unmetered: false,
}))

export const ADVERTISED_PLANS: readonly AdvertisedPlan[] = [
  {
    providerID: "commandcode",
    label: "Command Code GOAT",
    monthlyUSD: 10,
    monthlyCreditsUSD: null,
    windows: COMMANDCODE_WINDOWS,
    models: COMMANDCODE_MODELS,
    // Its allowance is "monthly usage at official API prices", which is
    // DeepSeek's published rate — including its peak windows.
    basis: "clock",
    source: "commandcode.ai/docs/plans/goat",
  },
  {
    providerID: "opencode",
    label: "OpenCode Go",
    monthlyUSD: 10,
    monthlyCreditsUSD: null,
    windows: GO_WINDOWS,
    models: GO_MODELS,
    // `go-models.ts` calls its allowances "monthly usage at official API
    // prices", so DeepSeek's time-of-day tier passes straight through.
    basis: "clock",
    source: "packages/console/app/src/component/go-models.ts",
  },
  {
    providerID: "opendesign",
    label: "OpenDesign Go",
    monthlyUSD: 10,
    monthlyCreditsUSD: 120,
    windows: OD_WINDOWS,
    models: OD_MODELS,
    // One published card at every hour: the console's per-token prices are the
    // meter, and DeepSeek's time-of-day tier is not passed through.
    basis: "flat",
    source: "open-design.ai/model-credits",
  },
]

export function advertisedPlan(integrationID: string) {
  return ADVERTISED_PLANS.find((plan) => plan.providerID === integrationID)
}

/**
 * Recorded model id → published model id, per plan.
 *
 * OpenCode records the alias it routes by, which is not always the id the
 * provider lists. Go publishes DeepSeek's served alias `deepseek-v4.1-flash` as
 * `deepseek-flash`, while OpenDesign genuinely lists a model called
 * `deepseek-v4.1-flash` — so the mapping cannot be global without making one
 * plan resolve the other's model.
 */
const MODEL_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  opencode: {
    "deepseek-v4.1-flash": "deepseek-flash",
    "deepseek-v4-flash": "deepseek-flash",
    "deepseek-v4-flash-vision-exp": "deepseek-flash",
    "claude-haiku-5.5": "claude-haiku-5-5",
  },
  // Command Code records the vendor-qualified id; its plan lists the bare one.
  commandcode: {
    "deepseek/deepseek-v4.1-flash": "deepseek-v4.1-flash",
    "deepseek/deepseek-v4-flash": "deepseek-v4-flash",
    "deepseek/deepseek-v4.1-flash-fast": "deepseek-v4.1-flash-fast",
    "deepseek/deepseek-v4-pro": "deepseek-v4-pro",
  },
}

/**
 * The published model behind a recorded id for one plan.
 *
 * Tries the recorded id, a plan-specific alias, then a dots-to-dashes form,
 * which covers `claude-haiku-5.5` → `claude-haiku-5-5` on the Go list.
 */
export function planModel(plan: AdvertisedPlan, modelID: string): PlanModel | undefined {
  const direct = plan.models.find((model) => model.id === modelID)
  if (direct !== undefined) return direct
  const alias = MODEL_ALIASES[plan.providerID]?.[modelID]
  if (alias !== undefined) {
    const aliased = plan.models.find((model) => model.id === alias)
    if (aliased !== undefined) return aliased
  }
  return plan.models.find((model) => model.id === modelID.replaceAll(".", "-"))
}

/** The published model entry, for the allowance table and display. */
export function modelMultiplier(plan: AdvertisedPlan, modelID: string): number | null {
  return planModel(plan, modelID)?.multiplier ?? null
}

/**
 * Credits a call consumes, priced from its tokens at the plan's own card.
 *
 * OpenDesign's console bills the "Credit usage breakdown" card — input
 * (excluding cache), output, and cache read each at their own rate — and the
 * weekly percentage is that subtotal divided by the window cap. There is no
 * peak/off-peak step and no per-model multiplier on the meter: the card is the
 * meter. The published 0.5× is an allowance entitlement (V4.1 Flash's monthly
 * usage is $120 against $60 for a 1× model), not a discount applied to each
 * call, so folding it into the per-call price would put the dashboard below the
 * console it is meant to reconcile with.
 *
 * Pricing per token kind is the whole point: OpenCode's recorded table
 * ($0.15/$0.60/$0.003) differs from the card by a different factor for input,
 * output, and cache, so no single multiplier on a recorded dollar can match.
 */
export function creditsForTokens(
  plan: AdvertisedPlan,
  modelID: string,
  tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  },
): number | null {
  const model = planModel(plan, modelID)
  if (model === undefined) return null
  if (model.unmetered) return 0
  const card = model.card
  if (card === null) return null
  return (
    (tokens.input * card.input +
      (tokens.output + tokens.reasoning) * card.output +
      tokens.cacheRead * card.cacheRead +
      tokens.cacheWrite * card.cacheWrite) /
    1_000_000
  )
}

/**
 * Credits the pool draws per dollar of published monthly usage.
 *
 * The pricing page gives Go a $120 pool and lists $60 of monthly usage for a 1×
 * model, so inverting the table gives `credits = 2 × usage × multiplier`. That
 * factor describes the entitlement only; it is not applied to the per-call
 * meter, which is the flat card.
 */
const CREDITS_PER_USAGE_USD = 2

/**
 * Dollars of list-price usage one month's fee buys, in the plan's own metering
 * unit.
 *
 * Two shapes are in use:
 *
 * - **Per-model allowance.** Go and Command Code publish a dollar figure per
 *   model at official API prices, e.g. `deepseek-flash` at $80. That is already
 *   the answer.
 * - **One credit pool.** OpenDesign publishes one shared pool ($120/month) and a
 *   per-model multiplier. The published per-model "monthly usage" is the pool
 *   inverted through that multiplier: $120 at 0.5×, $60 at 1×, $30 at 2×, $15
 *   at 4×. A lower multiplier means *more* usage against the same pool.
 *
 * The meter itself is separate: every call is priced at the plan's per-token
 * card, and the window caps ($10 / $30 / $120) apply to that card spend.
 *
 * Returns null for a model the plan does not publish, or one that draws nothing.
 */
export function allowanceListUSD(plan: AdvertisedPlan, modelID: string): number | null {
  const model = planModel(plan, modelID)
  if (model === undefined || model.unmetered) return null
  if (plan.monthlyCreditsUSD === null) return model.monthlyUSD
  return plan.monthlyCreditsUSD / (CREDITS_PER_USAGE_USD * model.multiplier)
}

/** A window's dollar cap, resolving `share` windows against a monthly allowance. */
export function windowCap(window: QuotaWindow, monthlyAllowanceUSD: number | null): number | null {
  if (window.kind === "cap") return window.capUSD
  if (window.share === null || monthlyAllowanceUSD === null) return null
  return window.share * monthlyAllowanceUSD
}
