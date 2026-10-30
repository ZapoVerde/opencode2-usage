/**
 * Fixed-fee plan pricing.
 *
 * A subsidised plan (OpenCode, Command Code, OpenDesign Go) bills a monthly fee
 * instead of per-token rates, so the sidecar's recorded `cost_usd` is not what
 * the account was charged. This module derives, from a small JSON file:
 *
 * - the plan spend that falls inside the query window,
 * - the effective USD you paid per 1M tokens of each kind,
 * - the list-price equivalent of the same usage, for comparison,
 * - a peak/off-peak split for upstreams that publish time-of-day windows.
 *
 * Everything here is pure so the API and tests can call it directly.
 */

const DAY_MS = 86_400_000
const MAX_DAYS = 3_660

export type Rate = {
  /** USD per 1M input tokens on a cache miss. */
  readonly input: number
  /** USD per 1M output tokens; reasoning bills here too. */
  readonly output: number
  /** USD per 1M cache-read tokens. */
  readonly cacheRead: number
  /** USD per 1M cache-write tokens. */
  readonly cacheWrite: number
}

export type PlanTerm = {
  /** UTC midnight of the first day the fee applies. */
  readonly from: number
  readonly monthlyUSD: number
}

export type PeakWindow = {
  /** Minutes since UTC midnight, inclusive. */
  readonly startMinute: number
  /** Minutes since UTC midnight, exclusive; below `startMinute` wraps past midnight. */
  readonly endMinute: number
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  readonly days: readonly number[]
}

export type ProviderPlan = {
  readonly providerID: string
  readonly label: string | null
  readonly terms: readonly PlanTerm[]
  readonly peak: readonly PeakWindow[]
  /** When set, only these models use the peak windows; every other model is off-peak. */
  readonly peakModels: readonly string[] | null
  /** List price per model, used to weigh spend across token kinds. */
  readonly rates: ReadonlyMap<string, Rate>
  /**
   * Multiplier applied to list cost inside peak windows. Defaults to 1: the
   * windows classify usage, and a plan subscriber pays the same fee regardless.
   * Set it only when the upstream publishes a real peak surcharge.
   */
  readonly peakMultiplier: number
}

export type Plans = {
  readonly providers: ReadonlyMap<string, ProviderPlan>
  readonly errors: readonly string[]
}

export const EMPTY_PLANS: Plans = { providers: new Map(), errors: [] }

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Parse the plans document. A malformed provider is dropped with a message
 * rather than failing the read: one typo must not blank the plan columns.
 */
export function parsePlans(input: unknown): Plans {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { providers: new Map(), errors: ["plans: expected a JSON object"] }

  const document = input as Record<string, unknown>
  const providers = new Map<string, ProviderPlan>()
  if (document.providers === undefined) return { providers, errors: [] }
  if (document.providers === null || typeof document.providers !== "object" || Array.isArray(document.providers))
    return { providers, errors: ['plans: "providers" must be an object'] }

  const errors: string[] = []
  for (const [providerID, value] of Object.entries(document.providers as Record<string, unknown>)) {
    const plan = parseProvider(providerID, value, errors)
    if (plan !== null) providers.set(providerID, plan)
  }
  return { providers, errors }
}

function parseProvider(providerID: string, value: unknown, errors: string[]): ProviderPlan | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`plans.${providerID}: expected an object`)
    return null
  }
  const entry = value as Record<string, unknown>
  const terms = parseTerms(providerID, entry.terms, errors)
  if (terms.length === 0) {
    errors.push(`plans.${providerID}: no valid terms (each needs "from" and "monthlyUSD")`)
    return null
  }
  return {
    providerID,
    label: typeof entry.label === "string" && entry.label.trim().length > 0 ? entry.label.trim() : null,
    terms,
    peak: parsePeak(providerID, entry.peak, errors),
    peakModels:
      Array.isArray(entry.peakModels) && entry.peakModels.every((item) => typeof item === "string")
        ? (entry.peakModels as string[])
        : null,
    rates: parseRates(providerID, entry.rates, errors),
    peakMultiplier:
      typeof entry.peakMultiplier === "number" && Number.isFinite(entry.peakMultiplier) && entry.peakMultiplier >= 1
        ? entry.peakMultiplier
        : 1,
  }
}

function parseTerms(providerID: string, value: unknown, errors: string[]): PlanTerm[] {
  if (!Array.isArray(value)) {
    errors.push(`plans.${providerID}.terms: expected an array`)
    return []
  }
  const terms: PlanTerm[] = []
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`plans.${providerID}.terms: expected objects`)
      continue
    }
    const term = item as Record<string, unknown>
    const from = parseDate(term.from)
    if (from === null) {
      errors.push(`plans.${providerID}.terms: "from" must be a YYYY-MM-DD date`)
      continue
    }
    const monthlyUSD = term.monthlyUSD
    if (typeof monthlyUSD !== "number" || !Number.isFinite(monthlyUSD) || monthlyUSD < 0) {
      errors.push(`plans.${providerID}.terms: "monthlyUSD" must be a non-negative number`)
      continue
    }
    terms.push({ from, monthlyUSD })
  }
  return terms.sort((left, right) => left.from - right.from)
}

function parsePeak(providerID: string, value: unknown, errors: string[]): PeakWindow[] {
  if (value === undefined) return []
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`plans.${providerID}.peak: expected an object`)
    return []
  }
  const peak = value as Record<string, unknown>
  if (peak.windows === undefined) return []
  if (!Array.isArray(peak.windows)) {
    errors.push(`plans.${providerID}.peak.windows: expected an array of HH:MM-HH:MM`)
    return []
  }
  const days =
    Array.isArray(peak.days) && peak.days.every((day) => typeof day === "number" && day >= 1 && day <= 7)
      ? (peak.days as number[])
      : [1, 2, 3, 4, 5]
  const windows: PeakWindow[] = []
  for (const item of peak.windows) {
    const window = typeof item === "string" ? parseWindow(item) : null
    if (window === null) {
      errors.push(`plans.${providerID}.peak.windows: invalid window ${JSON.stringify(item)}`)
      continue
    }
    windows.push({ ...window, days })
  }
  return windows
}

function parseWindow(value: string): Omit<PeakWindow, "days"> | null {
  const match = TIME_PATTERN.exec(value.trim())
  if (match === null) return null
  const startHour = Number(match[1])
  const startMinute = Number(match[2])
  const endHour = Number(match[3])
  const endMinute = Number(match[4])
  const start = startHour * 60 + startMinute
  const end = endHour * 60 + endMinute
  // An empty window would silently classify nothing; reject it instead.
  if (start === end) return null
  return { startMinute: start, endMinute: end }
}

function parseRates(providerID: string, value: unknown, errors: string[]): Map<string, Rate> {
  const rates = new Map<string, Rate>()
  if (value === undefined) return rates
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`plans.${providerID}.rates: expected an object of modelID -> rates`)
    return rates
  }
  for (const [modelID, item] of Object.entries(value as Record<string, unknown>)) {
    const rate = parseRate(item)
    if (rate === null) {
      errors.push(`plans.${providerID}.rates.${modelID}: expected non-negative input/output/cacheRead/cacheWrite`)
      continue
    }
    rates.set(modelID, rate)
  }
  return rates
}

function parseRate(value: unknown): Rate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const input = entry.input ?? 0
  const output = entry.output ?? 0
  const cacheRead = entry.cacheRead ?? 0
  const cacheWrite = entry.cacheWrite ?? 0
  for (const candidate of [input, output, cacheRead, cacheWrite])
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) return null
  return {
    input: input as number,
    output: output as number,
    cacheRead: cacheRead as number,
    cacheWrite: cacheWrite as number,
  }
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string") return null
  const match = DATE_PATTERN.exec(value.trim())
  if (match === null) return null
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(at) ? at : null
}

/** Monthly fee in effect at `at`, or null before the first term. */
export function monthlyFeeAt(plan: ProviderPlan, at: number): number | null {
  let fee: number | null = null
  for (const term of plan.terms) {
    if (term.from > at) break
    fee = term.monthlyUSD
  }
  return fee
}

function daysInMonth(at: number) {
  const date = new Date(at)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
}

function startOfUtcDay(at: number) {
  return Math.floor(at / DAY_MS) * DAY_MS
}

/**
 * Covered days and the plan spend for [since, until], prorated by real time.
 *
 * Each UTC day costs `monthlyUSD / daysInMonth`, and a day only bills for the
 * part of it inside the window. So a 7-day query charges exactly 7/31 of a
 * 31-day month, and a plan starting at 00:00 on the 20th charges from there.
 * Days before the first term are free, as are windows that end before it.
 */
export function planCoverage(plan: ProviderPlan, since: number | null, until: number) {
  const first = plan.terms[0]?.from
  if (first === undefined) return { days: 0, spendUSD: 0 }
  const start = Math.max(since ?? first, first)
  if (until <= start) return { days: 0, spendUSD: 0 }

  // Walk in UTC-day slices so a term that starts mid-window bills each slice at
  // the fee in effect when it began.
  const limit = Math.min(until, start + MAX_DAYS * DAY_MS)
  let cursor = startOfUtcDay(start)
  let days = 0
  let spendUSD = 0
  while (cursor < limit) {
    const dayEnd = cursor + DAY_MS
    const fee = monthlyFeeAt(plan, cursor)
    if (fee !== null) {
      const fraction = (Math.min(dayEnd, limit) - Math.max(cursor, start)) / DAY_MS
      if (fraction > 0) {
        days += fraction
        spendUSD += (fee / daysInMonth(cursor)) * fraction
      }
    }
    cursor = dayEnd
  }
  return { days, spendUSD }
}

/** True when `at` lands in a configured peak window that applies to this model. */
export function isPeak(plan: ProviderPlan, at: number, modelID: string | null): boolean {
  if (plan.peak.length === 0) return false
  if (plan.peakModels !== null && (modelID === null || !plan.peakModels.includes(modelID))) return false
  const date = new Date(at)
  const weekday = ((date.getUTCDay() + 6) % 7) + 1
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return plan.peak.some((window) => {
    if (!window.days.includes(weekday)) return false
    if (window.startMinute < window.endMinute)
      return minute >= window.startMinute && minute < window.endMinute
    return minute >= window.startMinute || minute < window.endMinute
  })
}

export type TokenTotals = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export const ZERO_TOKENS: TokenTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export function sumTokens(values: readonly TokenTotals[]): TokenTotals {
  return values.reduce<TokenTotals>(
    (sum, value) => ({
      input: sum.input + value.input,
      output: sum.output + value.output,
      reasoning: sum.reasoning + value.reasoning,
      cacheRead: sum.cacheRead + value.cacheRead,
      cacheWrite: sum.cacheWrite + value.cacheWrite,
    }),
    ZERO_TOKENS,
  )
}

export function totalTokens(tokens: TokenTotals) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

/**
 * List-price cost of one model's tokens in USD, or null when that model has no
 * configured rate. `multiplier` folds in peak pricing (2 for a peak hour).
 */
export function listCost(
  plan: ProviderPlan | null,
  modelID: string,
  tokens: TokenTotals,
  multiplier = 1,
): number | null {
  const rate = plan?.rates.get(modelID)
  if (rate === undefined) return null
  const cost =
    tokens.input * rate.input +
    (tokens.output + tokens.reasoning) * rate.output +
    tokens.cacheRead * rate.cacheRead +
    tokens.cacheWrite * rate.cacheWrite
  return (cost / 1_000_000) * multiplier
}

/** List cost split by token kind, so spend can be weighted per kind. */
export type KindCost = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export const ZERO_KIND_COST: KindCost = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

export function listCostByKind(
  plan: ProviderPlan | null,
  modelID: string,
  tokens: TokenTotals,
  multiplier = 1,
): KindCost | null {
  const rate = plan?.rates.get(modelID)
  if (rate === undefined) return null
  return {
    input: (tokens.input * rate.input * multiplier) / 1_000_000,
    output: (tokens.output * rate.output * multiplier) / 1_000_000,
    reasoning: (tokens.reasoning * rate.output * multiplier) / 1_000_000,
    cacheRead: (tokens.cacheRead * rate.cacheRead * multiplier) / 1_000_000,
    cacheWrite: (tokens.cacheWrite * rate.cacheWrite * multiplier) / 1_000_000,
  }
}

export function addKindCost(left: KindCost, right: KindCost): KindCost {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

export function kindCostTotal(cost: KindCost) {
  return cost.input + cost.output + cost.reasoning + cost.cacheRead + cost.cacheWrite
}

/** USD per 1M tokens, blended and split by kind. */
export type Rates = {
  readonly blended: number | null
  readonly input: number | null
  readonly output: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
}

export type BucketReport = {
  readonly calls: number
  readonly tokens: TokenTotals
  /** List-price cost of this bucket's tokens, or null without peak windows. */
  readonly listUSD: number | null
  /** Effective paid rate, splitting this bucket's share of the fee by list cost. */
  readonly paid: Rates
  /** List rate for the same tokens. */
  readonly metered: Rates
}

export type ProviderReport = {
  readonly providerID: string
  readonly label: string | null
  readonly calls: number
  readonly sessions: number
  readonly tokens: TokenTotals
  /** Prorated plan fee for the window. Zero when no plan is configured. */
  readonly spendUSD: number
  /** UTC days in the window the fee covered. */
  readonly paidDays: number
  /** Recorded cost from OpenCode, for comparison only. */
  readonly recordedUSD: number
  /** List-price equivalent of the recorded usage, or null without rates. */
  readonly meteredUSD: number | null
  /** `meteredUSD / spendUSD`; above 1 means the plan delivered more than it cost. */
  readonly valueRatio: number | null
  /** Paid USD per 1M tokens, blended and split by kind. */
  readonly paid: Rates
  /** List USD per 1M tokens, blended and split by kind. */
  readonly metered: Rates
  /** Peak and off-peak halves; both are empty when the plan has no windows. */
  readonly peak: BucketReport
  readonly offPeak: BucketReport
  readonly models: readonly ModelReport[]
}

export type ModelReport = {
  readonly modelID: string
  readonly calls: number
  readonly tokens: TokenTotals
  readonly recordedUSD: number
  readonly meteredUSD: number | null
  readonly peakCalls: number
  readonly offPeakCalls: number
}

type Sample = {
  readonly modelID: string
  readonly at: number
  readonly tokens: TokenTotals
  readonly recordedUSD: number
}

/**
 * Roll one provider's calls into the report the dashboard renders.
 *
 * `spendUSD` is what the fixed fee actually cost for the window; `meteredUSD` is
 * what the same tokens would have cost at list price, so `valueRatio` says how
 * much value the plan delivered per dollar. List price comes from configured
 * rates when present and falls back to OpenCode's recorded cost, which is itself
 * a catalog estimate. Spend is split across token kinds by their list-cost share
 * so the per-kind paid rate reflects the plan's discount, not a token share.
 * Without either source the per-kind figures stay null rather than invented.
 */
export function providerReport(input: {
  readonly plan: ProviderPlan | null
  readonly providerID: string
  readonly sessions: number
  readonly since: number | null
  readonly until: number
  readonly samples: readonly Sample[]
}): ProviderReport {
  const plan = input.plan
  const coverage = plan === null ? { days: 0, spendUSD: 0 } : planCoverage(plan, input.since, input.until)
  const tokens = sumTokens(input.samples.map((sample) => sample.tokens))
  const total = totalTokens(tokens)
  const recordedUSD = input.samples.reduce((sum, sample) => sum + sample.recordedUSD, 0)

  const kinds = { peak: ZERO_KIND_COST, offPeak: ZERO_KIND_COST }
  const recordedKinds = { peak: 0, offPeak: 0 }
  const bucketTokens = { peak: ZERO_TOKENS, offPeak: ZERO_TOKENS }
  const bucketCalls = { peak: 0, offPeak: 0 }
  const models = new Map<
    string,
    {
      calls: number
      tokens: TokenTotals[]
      recordedUSD: number
      /** List cost accumulated per call, so peak windows keep their surcharge. */
      listUSD: number
      /** True once any call for this model had a configured rate. */
      priced: boolean
      peak: number
      offPeak: number
    }
  >()
  let priced = 0

  for (const sample of input.samples) {
    const peak = plan !== null && isPeak(plan, sample.at, sample.modelID)
    const side = peak ? "peak" : "offPeak"
    // Configured rates win; otherwise OpenCode's recorded cost is used, which is
    // already a list-price estimate from the provider's catalog. Either way the
    // number means "what these tokens would cost without the plan". The peak
    // multiplier defaults to 1, so a window changes bucketing but not the price
    // unless the plans file declares a real surcharge.
    const cost = listCostByKind(plan, sample.modelID, sample.tokens, peak ? plan.peakMultiplier : 1)
    if (cost !== null) {
      kinds[side] = addKindCost(kinds[side], cost)
      priced += 1
    } else if (sample.recordedUSD > 0) {
      recordedKinds[side] += sample.recordedUSD
      priced += 1
    }
    bucketTokens[side] = sumTokens([bucketTokens[side], sample.tokens])
    bucketCalls[side] += 1

    const model = models.get(sample.modelID) ?? {
      calls: 0,
      tokens: [],
      recordedUSD: 0,
      listUSD: 0,
      priced: false,
      peak: 0,
      offPeak: 0,
    }
    model.calls += 1
    model.tokens.push(sample.tokens)
    model.recordedUSD += sample.recordedUSD
    if (cost !== null) {
      // Summing per call is what preserves peak pricing; recomputing from the
      // model's aggregate tokens would flatten every call to one tier.
      model.listUSD += kindCostTotal(cost)
      model.priced = true
    }
    if (peak) model.peak += 1
    else model.offPeak += 1
    models.set(sample.modelID, model)
  }

  // A split is only meaningful when the plan actually defines peak hours.
  const hasWindows = plan !== null && plan.peak.length > 0
  const listKinds: KindCost = {
    input: kinds.peak.input + kinds.offPeak.input,
    output: kinds.peak.output + kinds.offPeak.output,
    reasoning: kinds.peak.reasoning + kinds.offPeak.reasoning,
    cacheRead: kinds.peak.cacheRead + kinds.offPeak.cacheRead,
    cacheWrite: kinds.peak.cacheWrite + kinds.offPeak.cacheWrite,
  }
  const listTotal = kindCostTotal(listKinds)
  const recordedTotal = recordedKinds.peak + recordedKinds.offPeak
  // List-value of the window: explicit rates where they exist, recorded cost for
  // everything they do not cover.
  const meteredUSD =
    priced === 0 ? null : listTotal + recordedTotal > 0 ? listTotal + recordedTotal : null

  const bucket = (side: "peak" | "offPeak"): BucketReport => {
    const sideTokens = bucketTokens[side]
    const sideTotal = totalTokens(sideTokens)
    const sideList = kindCostTotal(kinds[side]) + recordedKinds[side]
    // Split the fee by list cost when known, so a peak bucket that burns more
    // output tokens carries more of the plan's cost than a cheap cache-read one.
    const share = meteredUSD === null || meteredUSD === 0 ? (total === 0 ? 0 : sideTotal / total) : sideList / meteredUSD
    const spendUSD = hasWindows ? coverage.spendUSD * share : 0
    return {
      calls: bucketCalls[side],
      tokens: sideTokens,
      listUSD: hasWindows && priced > 0 ? sideList : null,
      paid: hasWindows ? paidRates(spendUSD, sideTokens, kinds[side]) : EMPTY_RATES,
      metered: hasWindows ? listRates(sideTokens, kinds[side], sideTotal === 0 ? null : sideList) : EMPTY_RATES,
    }
  }

  return {
    providerID: input.providerID,
    label: plan?.label ?? null,
    calls: input.samples.length,
    sessions: input.sessions,
    tokens,
    spendUSD: coverage.spendUSD,
    paidDays: coverage.days,
    recordedUSD,
    meteredUSD,
    valueRatio: meteredUSD === null || coverage.spendUSD === 0 ? null : meteredUSD / coverage.spendUSD,
    paid: paidRates(coverage.spendUSD, tokens, listKinds),
    metered: listRates(tokens, listKinds, meteredUSD),
    peak: bucket("peak"),
    offPeak: bucket("offPeak"),
    models: [...models.entries()]
      .map(([modelID, model]) => {
        const modelTokens = sumTokens(model.tokens)
        return {
          modelID,
          calls: model.calls,
          tokens: modelTokens,
          recordedUSD: model.recordedUSD,
          // Same basis as the provider total: configured rates summed per call,
          // falling back to recorded cost when the model has no rate.
          meteredUSD: model.priced ? model.listUSD : model.recordedUSD,
          peakCalls: model.peak,
          offPeakCalls: model.offPeak,
        }
      })
      .sort(
        (left, right) =>
          (right.meteredUSD ?? 0) - (left.meteredUSD ?? 0) || left.modelID.localeCompare(right.modelID),
      ),
  }
}

export const EMPTY_RATES: Rates = {
  blended: null,
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
}

/**
 * Paid USD per 1M tokens of each kind.
 *
 * The plan fee is split across token kinds by their *list* cost share, so the
 * per-kind figure answers "what did a million of these tokens effectively cost
 * me under the plan". Without per-kind list prices, no kind split is knowable
 * and only the blended rate is returned.
 */
function paidRates(spendUSD: number, tokens: TokenTotals, kinds: KindCost): Rates {
  const total = totalTokens(tokens)
  const listTotal = kindCostTotal(kinds)
  const rate = (kindTokens: number, kindCost: number) => {
    if (spendUSD === 0 || kindTokens === 0 || listTotal === 0) return null
    return ((spendUSD * (kindCost / listTotal)) / kindTokens) * 1_000_000
  }
  return {
    blended: spendUSD === 0 || total === 0 ? null : (spendUSD / total) * 1_000_000,
    input: listTotal === 0 ? null : rate(tokens.input, kinds.input),
    output: listTotal === 0 ? null : rate(tokens.output + tokens.reasoning, kinds.output + kinds.reasoning),
    cacheRead: listTotal === 0 ? null : rate(tokens.cacheRead, kinds.cacheRead),
    cacheWrite: listTotal === 0 ? null : rate(tokens.cacheWrite, kinds.cacheWrite),
  }
}

function listRates(tokens: TokenTotals, kinds: KindCost, meteredUSD: number | null): Rates {
  const total = totalTokens(tokens)
  const listTotal = kindCostTotal(kinds)
  const rate = (kindTokens: number, kindCost: number) =>
    kindTokens === 0 ? null : (kindCost / kindTokens) * 1_000_000
  return {
    // Blended list price is knowable even without per-kind rates, because the
    // recorded cost already totals every token.
    blended: total === 0 || meteredUSD === null ? null : (meteredUSD / total) * 1_000_000,
    input: listTotal === 0 ? null : rate(tokens.input, kinds.input),
    output: listTotal === 0 ? null : rate(tokens.output + tokens.reasoning, kinds.output + kinds.reasoning),
    cacheRead: listTotal === 0 ? null : rate(tokens.cacheRead, kinds.cacheRead),
    cacheWrite: listTotal === 0 ? null : rate(tokens.cacheWrite, kinds.cacheWrite),
  }
}
