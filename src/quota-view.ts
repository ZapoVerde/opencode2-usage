import type { AdvertisedQuota, AdvertisedWindow, QuotasResponse } from "./quotas"
import { advertisedPlan, creditsForTokens, planModel, windowCap, type AdvertisedPlan } from "./allowances"

/** A model and the tokens it moved in the window. */
export type ModelSpend = {
  readonly modelID: string
  /** Recorded cost, USD, for comparison with the provider's meter. */
  readonly costUSD: number
  readonly calls: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
}

/**
 * What the recorded usage costs in the provider's own accounting units.
 *
 * A plan that publishes a per-token card is repriced from its tokens, kind by
 * kind. That is the only way to match the provider: OpenDesign's card and
 * OpenCode's recorded table differ by a different factor for input, output, and
 * cache, so scaling a blended recorded dollar lands somewhere between the truth
 * and a guess. Plans without a card (Go, Command Code) fall back to the recorded
 * cost, which is what their allowance is denominated in.
 *
 * A model the plan does not publish contributes its dollars at 1x and is
 * reported in `unknown`, so the total is never silently understated.
 */
export function creditsUsed(plan: AdvertisedPlan, spend: readonly ModelSpend[]) {
  let creditsUSD = 0
  let recordedUSD = 0
  const unknown: string[] = []
  let unmeteredUSD = 0
  for (const model of spend) {
    recordedUSD += model.costUSD
    const resolved = planModel(plan, model.modelID)
    if (resolved === undefined) {
      // Unpublished models still cost something; count them at 1x rather than
      // dropping them, but say so. A free model costs nothing, so it needs no
      // warning even though the plan does not list it.
      creditsUSD += model.costUSD
      if (model.costUSD > 0 && !unknown.includes(model.modelID)) unknown.push(model.modelID)
      continue
    }
    if (resolved.unmetered) {
      unmeteredUSD += model.costUSD
      continue
    }
    const fromCard = creditsForTokens(plan, model.modelID, model.tokens)
    creditsUSD += fromCard ?? model.costUSD
  }
  return { creditsUSD, recordedUSD, unknown, unmeteredUSD }
}

/**
 * Build the advertised-allowance view for one provider, already resolved for the
 * models in use and the live percentages that upstream reported.
 *
 * `spent` is the recorded usage inside each quota window, so the "used" column
 * reflects this machine's share of the allowance rather than the account total.
 * The two differ whenever the same key is used elsewhere, which is exactly the
 * case the interface has to make legible.
 */
export function advertisedQuota(input: {
  readonly integrationID: string
  readonly models: readonly string[]
  readonly spend: readonly ModelSpend[]
  /** Live percentages keyed by window id, as the provider reported them. */
  readonly live: readonly {
    readonly id: string
    readonly usedPercent: number | null
    readonly resetsAt: number | null
    /** The cap in the provider's own credit unit, when it reports one. */
    readonly capCredits?: number | null
  }[]
}): AdvertisedQuota | null {
  const plan = advertisedPlan(input.integrationID)
  if (plan === undefined) return null

  const used = creditsUsed(plan, input.spend)
  const dominant = plan.monthlyCreditsUSD === null ? dominantAllowance(plan, input.spend) : null
  const allowanceUSD = plan.monthlyCreditsUSD ?? dominant?.monthlyUSD ?? null
  const livePercent = new Map(input.live.map((window) => [window.id, window.usedPercent] as const))
  const liveReset = new Map(input.live.map((window) => [window.id, window.resetsAt] as const))
  const liveCap = new Map(
    input.live.flatMap((window) =>
      typeof window.capCredits === "number" && Number.isFinite(window.capCredits)
        ? [[window.id, window.capCredits] as const]
        : [],
    ),
  )

  return {
    providerID: plan.providerID,
    label: plan.label,
    monthlyUSD: plan.monthlyUSD,
    monthlyCreditsUSD: plan.monthlyCreditsUSD,
    allowanceUSD,
    allowanceModel: dominant?.name ?? null,
    multiplier: input.models.length === 1 ? (planModel(plan, input.models[0]!)?.multiplier ?? null) : null,
    mixedModels: dominant?.mixed ?? false,
    recordedUSD: used.recordedUSD,
    creditsUSD: used.creditsUSD,
    unknownModels: used.unknown,
    unmeteredUSD: used.unmeteredUSD,
    models: input.models,
    windows: plan.windows.map((window): AdvertisedWindow => {
      const percent = livePercent.get(window.id) ?? null
      const capUSD = windowCap(window, allowanceUSD)
      return {
        id: window.id,
        label: window.label,
        kind: window.kind,
        capUSD,
        // The provider's own limit, kept in its unit. OpenDesign reports it in
        // credits; turning that into dollars needs a rate it does not publish,
        // so both are carried and the page shows whichever it was given.
        capCredits: liveCap.get(window.id) ?? null,
        // The upstream percentage is of the account's whole allowance, so its
        // dollar value is the percentage of the cap.
        upstreamPercent: percent,
        upstreamUSD: percent !== null && capUSD !== null ? (percent / 100) * capUSD : null,
        resetsAt: liveReset.get(window.id) ?? null,
      }
    }),
    source: plan.source,
  }
}

/**
 * The allowance the provider's percentage most plausibly refers to.
 *
 * Go publishes an allowance per model rather than one pool, so a window that
 * mixed an $80 model with a $15 one has no exact single figure. The model that
 * consumed most of the spend is the best available basis, and `mixed` says
 * whether that basis is shared, so the interface can present it as an estimate
 * instead of a measurement.
 */
function dominantAllowance(plan: AdvertisedPlan, spend: readonly ModelSpend[]) {
  let best: { name: string; monthlyUSD: number; costUSD: number } | null = null
  const allowances = new Set<number>()
  for (const model of spend) {
    const resolved = planModel(plan, model.modelID)
    if (resolved?.monthlyUSD === null || resolved?.monthlyUSD === undefined) continue
    if (!resolved.unmetered) allowances.add(resolved.monthlyUSD)
    if (best === null || model.costUSD > best.costUSD)
      best = { name: resolved.name, monthlyUSD: resolved.monthlyUSD, costUSD: model.costUSD }
  }
  if (best === null) return null
  return { name: best.name, monthlyUSD: best.monthlyUSD, mixed: allowances.size > 1 }
}

/** Empty response for when no authoritative database is available. */
export function emptyQuotas(): QuotasResponse {
  return { fetchedAt: Date.now(), results: {}, aliases: {}, advertised: {} }
}
