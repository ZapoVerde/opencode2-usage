/**
 * What a real dollar of subscription fee buys, per provider, for one model.
 *
 * Three providers resell the same model three different ways, and the peak /
 * off-peak question lands differently on each. This module turns published
 * figures into a single comparable unit — tokens bought per dollar actually
 * paid — so the comparison is arithmetic rather than intuition.
 *
 * The whole table rests on one distinction:
 *
 * - **clock** — the allowance is denominated in the model's list price as it
 *   applies when the call is made. DeepSeek bills double inside its peak
 *   windows, so a clock-rated allowance buys half the tokens at peak.
 *   Command Code and OpenCode Go both state their allowance this way.
 *
 * - **flat** — one per-token card at every hour, so the clock does not move it.
 *   OpenDesign meters at the console's own card, which is flat all week.
 *
 * That single difference is what makes the answer time-dependent: off-peak the
 * clock-rated plans buy more tokens per fee dollar, at peak the flat-card plan
 * does, and the crossover is exact rather than approximate.
 *
 * Nothing here reaches the network or the database. It takes the plans already
 * in memory plus token counts measured from recorded calls, so it is pure and
 * testable.
 */

import { ADVERTISED_PLANS, allowanceListUSD, type AdvertisedPlan } from "./allowances"
import { PROVIDER_ALIASES } from "./quota-source"
import { isPeak, monthlyFeeAt, type Plans, type ProviderPlan, type TokenTotals } from "./plans"

/** USD per 1M tokens, or tokens per real dollar, for each billable token kind. */
export type RateCard = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
}

/** The three kinds that actually appear on these plans. Cache write is always 0. */
export type TokenShares = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
}

/** One way a plan can price the same model, at one side of the clock. */
export type RateOption = {
  /** List price per 1M tokens, in the unit this plan meters in. */
  readonly perMillion: RateCard
  /** Tokens bought by one real dollar of the monthly fee. */
  readonly tokensPerDollar: RateCard
  /** The same two figures blended at the measured token mix. */
  readonly blendedPerMillion: number | null
  readonly blendedTokensPerDollar: number | null
}

export type ProviderRate = {
  readonly providerID: string
  /** The provider's own name, from the plans file when it has one. */
  readonly label: string
  /** The plan the figures come from. */
  readonly planLabel: string
  readonly modelID: string
  /** Monthly fee in USD at the end of the window. */
  readonly feeUSD: number
  /** Dollars of list-price usage the fee buys, in this plan's own unit. */
  readonly allowanceUSD: number
  /** How that allowance is denominated, which is what makes the clock matter. */
  readonly basis: "clock" | "flat"
  readonly offPeak: RateOption
  readonly peak: RateOption
  readonly calls: number
  /** Where the published allowance comes from. */
  readonly source: string
}

/** A provider's recorded usage for one model, as the table needs it. */
export type RateSample = {
  readonly providerID: string
  readonly modelID: string | null
  /** Epoch ms, used only to decide which side of the clock the call fell on. */
  readonly at: number
  readonly recordedUSD: number
  readonly tokens: TokenTotals
}

export type RateTable = {
  readonly rows: readonly ProviderRate[]
  /**
   * The token mix every blended figure uses.
   *
   * One mix for the whole table, pooled across the rows, because a blended token
   * count is only comparable between plans when the plans are assumed to move the
   * same shape of traffic. Using each provider's own mix would fold a usage
   * difference into what is supposed to be a price comparison.
   */
  readonly mix: TokenShares | null
  /**
   * Share of this window's recorded spend that landed inside a peak window.
   *
   * It is the one figure that says whether the peak column is academic or the
   * main event: at a low share, timing barely registers; at a high one, it
   * decides which plan to use.
   */
  readonly peakShare: number | null
  /** Providers that had calls but no plan price and published allowance to compare. */
  readonly skipped: readonly string[]
}

/**
 * Build the comparison.
 *
 * Each provider contributes one row for the model it spent the most on, because
 * a provider can serve several models at different prices and mixing them into
 * one average would compare nothing in particular. A provider is skipped when
 * its usage has no configured rate or no published allowance, and named in
 * `skipped` so the page can say so rather than quietly drop it.
 */
export function rateTable(input: {
  readonly plans: Plans
  readonly samples: readonly RateSample[]
  readonly now: number
  /** The published allowance table. Defaults to the real one; tests pass a fixture. */
  readonly advertised?: readonly AdvertisedPlan[]
}): RateTable {
  const advertisedPlans = input.advertised ?? ADVERTISED_PLANS
  const byProvider = new Map<string, Map<string, { recordedUSD: number; calls: number }>>()
  for (const sample of input.samples) {
    if (sample.modelID === null) continue
    const models = byProvider.get(sample.providerID) ?? new Map()
    const entry = models.get(sample.modelID) ?? { recordedUSD: 0, calls: 0 }
    entry.recordedUSD += sample.recordedUSD
    entry.calls += 1
    models.set(sample.modelID, entry)
    byProvider.set(sample.providerID, models)
  }

  const rows: ProviderRate[] = []
  const skipped: string[] = []
  const pooled = shares(addAllTokens(input.samples.map((sample) => sample.tokens)))
  let peakUSD = 0
  let totalUSD = 0
  for (const sample of input.samples) {
    if (sample.recordedUSD <= 0) continue
    totalUSD += sample.recordedUSD
    const plan = input.plans.providers.get(sample.providerID)
    if (plan !== undefined && isPeak(plan, sample.at, sample.modelID)) peakUSD += sample.recordedUSD
  }
  for (const [providerID, models] of byProvider) {
    const plan = input.plans.providers.get(providerID) ?? null
    const advertised = advertisedFor(providerID, advertisedPlans)
    const chosen = plan === null || advertised === null ? null : dominantRatedModel(models, plan, advertised)
    if (plan === null || advertised === null || chosen === null) {
      if ([...models.values()].some((model) => model.calls > 0)) skipped.push(providerID)
      continue
    }
    const feeUSD = monthlyFeeAt(plan, input.now)
    if (feeUSD === null || feeUSD <= 0) {
      skipped.push(providerID)
      continue
    }
    const rate = plan.rates.get(chosen.modelID)
    const allowanceUSD = allowanceListUSD(advertised, chosen.modelID)
    if (rate === undefined || allowanceUSD === null) {
      skipped.push(providerID)
      continue
    }

    const offPeakCard = { input: rate.input, output: rate.output, cacheRead: rate.cacheRead }
    // A plan with no peak windows has one price all week; only a declared
    // surcharge can double it.
    const peakCard = scaleCard(offPeakCard, plan.peak.length === 0 ? 1 : plan.peakMultiplier)
    const flatValued = advertised.basis === "flat"
    const perFeeDollar = allowanceUSD / feeUSD

    rows.push({
      providerID,
      label: plan.label ?? providerID,
      planLabel: advertised.label,
      modelID: chosen.modelID,
      feeUSD,
      allowanceUSD,
      basis: advertised.basis,
      offPeak: option(perFeeDollar, flatValued ? peakCard : offPeakCard, pooled),
      peak: option(perFeeDollar, peakCard, pooled),
      calls: chosen.calls,
      source: advertised.source,
    })
  }

  // Ordered by the ordinary case: most tokens per fee dollar off-peak, which is
  // 17 hours of every weekday and all weekend. The peak column is where the
  // ordering inverts, and the page marks the winner of each column rather than
  // baking one ranking into the row order.
  rows.sort(
    (left, right) =>
      (right.offPeak.blendedTokensPerDollar ?? 0) - (left.offPeak.blendedTokensPerDollar ?? 0) ||
      left.label.localeCompare(right.label),
  )
  return { rows, mix: pooled, peakShare: totalUSD === 0 ? null : peakUSD / totalUSD, skipped }
}

/**
 * The plan that owns a recorded provider id.
 *
 * OpenCode records Go calls under `opencode-go` while the console bills them
 * under `opencode`, so the alias has to be followed rather than guessed.
 */
function advertisedFor(providerID: string, plans: readonly AdvertisedPlan[]): AdvertisedPlan | null {
  const find = (id: string) => plans.find((plan) => plan.providerID === id)
  return find(providerID) ?? find(PROVIDER_ALIASES[providerID] ?? "") ?? null
}

/**
 * The model a provider spent most on, restricted to models the plan prices and
 * publishes an allowance for. Spending is the tie-break a reader would expect:
 * the row describes where that provider's money actually went.
 */
function dominantRatedModel(
  models: Map<string, { recordedUSD: number; calls: number }>,
  plan: ProviderPlan,
  advertised: AdvertisedPlan,
) {
  let best: { modelID: string; recordedUSD: number; calls: number } | null = null
  for (const [modelID, entry] of models) {
    if (plan.rates.get(modelID) === undefined) continue
    if (allowanceListUSD(advertised, modelID) === null) continue
    if (best === null || entry.recordedUSD > best.recordedUSD) best = { modelID, ...entry }
  }
  return best
}

function option(perFeeDollar: number, card: RateCard, mix: TokenShares | null): RateOption {
  const tokensPerDollar = {
    input: perMillionToTokens(perFeeDollar, card.input),
    output: perMillionToTokens(perFeeDollar, card.output),
    cacheRead: perMillionToTokens(perFeeDollar, card.cacheRead),
  }
  const blendedPerMillion = mix === null ? null : blend(card, mix)
  return {
    perMillion: card,
    tokensPerDollar,
    blendedPerMillion,
    // A blend at a share of nothing has no meaning, so it stays null rather
    // than reporting an infinite token count.
    blendedTokensPerDollar:
      blendedPerMillion === null || blendedPerMillion <= 0
        ? null
        : perMillionToTokens(perFeeDollar, blendedPerMillion),
  }
}

/** Tokens one fee dollar buys, given dollars of usage per fee dollar and a price. */
function perMillionToTokens(perFeeDollar: number, pricePerMillion: number) {
  if (!(pricePerMillion > 0)) return 0
  return (perFeeDollar / pricePerMillion) * 1_000_000
}

function blend(card: RateCard, mix: TokenShares) {
  return mix.input * card.input + mix.output * card.output + mix.cacheRead * card.cacheRead
}

function scaleCard(card: RateCard, multiplier: number): RateCard {
  return {
    input: card.input * multiplier,
    output: card.output * multiplier,
    cacheRead: card.cacheRead * multiplier,
  }
}

/** Share of all billable tokens by kind, with reasoning folded into output. */
function shares(tokens: TokenTotals): TokenShares | null {
  const input = tokens.input
  const output = tokens.output + tokens.reasoning
  const cacheRead = tokens.cacheRead
  const total = input + output + cacheRead
  if (total === 0) return null
  return { input: input / total, output: output / total, cacheRead: cacheRead / total }
}

function addAllTokens(all: readonly TokenTotals[]): TokenTotals {
  return all.reduce(
    (sum, tokens) => ({
      input: sum.input + tokens.input,
      output: sum.output + tokens.output,
      reasoning: sum.reasoning + tokens.reasoning,
      cacheRead: sum.cacheRead + tokens.cacheRead,
      cacheWrite: sum.cacheWrite + tokens.cacheWrite,
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  )
}

