/**
 * Put every call on its plan's own price card.
 *
 * OpenCode records `cost_usd` from its provider catalog, which is not always the
 * price the plan meters against. For a flat-card plan (OpenDesign) the recorded
 * table disagrees with the console by a *different* factor for input, output,
 * and cache read, so scaling the recorded dollar cannot reconcile it. The only
 * honest fix is to price the recorded tokens at the plan's card.
 *
 * Clock-rated plans (Go, Command Code) are left alone: their recorded cost is
 * already the official price at the call's hour, which is the unit their
 * allowance is denominated in. The one exception is the old zero-cost gap:
 * OpenCode occasionally reports `cost = 0` on a completed call that clearly used
 * tokens, so a zero is filled from the plan's own rate there.
 *
 * Two rules keep this from inventing spend:
 *
 * - A `null` cost is "never priced" (a failed or aborted attempt) and stays
 *   null. Only calls that actually completed and moved tokens are touched.
 * - A model the plans file does not price keeps whatever OpenCode recorded, and
 *   is counted in `unpricedCalls` when it carried tokens, so a total can say it
 *   is short rather than imply completeness.
 */
import type { CallRow } from "../src/reducer"
import { listCost, type Plans } from "../src/plans"
import { advertisedPlan, creditsForTokens } from "../src/allowances"

export type AlignedCosts = {
  /** Calls with a price on the plan's own table. */
  readonly calls: readonly CallRow[]
  /** Net change from repricing, USD. Positive means the books were short. */
  readonly adjustedUSD: number
  /** Calls whose cost changed. */
  readonly adjustedCalls: number
  /** Calls carrying tokens that no plan rate could price. */
  readonly unpricedCalls: number
}

/**
 * Price each call's tokens at its plan's table.
 *
 * Returns the rows unchanged when no plans are loaded, so a deployment without a
 * plans file behaves exactly as before.
 */
export function alignCosts(calls: readonly CallRow[], plans: Plans | undefined): AlignedCosts {
  if (plans === undefined || plans.providers.size === 0)
    return { calls, adjustedUSD: 0, adjustedCalls: 0, unpricedCalls: countUnpriced(calls) }

  let adjustedUSD = 0
  let adjustedCalls = 0
  let unpricedCalls = 0
  const corrected = calls.map((call) => {
    // A `null` cost means the attempt never completed, so there is no token
    // count to price and no price to correct.
    if (call.costUSD === null) return call
    const tokens = {
      input: call.tokensInput ?? 0,
      output: call.tokensOutput ?? 0,
      reasoning: call.tokensReasoning ?? 0,
      cacheRead: call.tokensCacheRead ?? 0,
      cacheWrite: call.tokensCacheWrite ?? 0,
    }
    const moved = totalTokens(tokens) > 0
    if (call.providerID === null || call.modelID === null) {
      if (call.costUSD === 0 && moved) unpricedCalls += 1
      return call
    }

    const plan = plans.providers.get(call.providerID) ?? null
    const advertised = advertisedPlan(call.providerID)
    const flat = advertised?.basis === "flat"

    // A flat-card plan is always repriced, because its card is the meter even
    // when OpenCode reported a positive number from a different table. A
    // clock-rated plan is only filled when the recorded price is missing.
    if (!flat && !(call.costUSD === 0 && moved)) {
      if (call.costUSD === 0 && moved) unpricedCalls += 1
      return call
    }

    // The plan's published card wins over the plans file, so the code carries
    // the meter with it: a deployment cannot silently fall back to OpenCode's
    // table because a runtime JSON file was not updated alongside it.
    const cost =
      advertised === undefined || advertised === null
        ? null
        : creditsForTokens(advertised, call.modelID, tokens)
    const resolved = cost === null ? listCost(plan, call.modelID, tokens) : cost
    if (resolved === null) {
      // A model named `-free` is promotional: it genuinely costs nothing, so a
      // zero is correct rather than missing. Only an unpriced *paid* model is
      // something the books are short of.
      if (!call.modelID.toLowerCase().includes("free") && (call.costUSD === 0 || flat))
        unpricedCalls += 1
      return call
    }
    // A call that moved no tokens genuinely cost nothing; leave its zero alone.
    if (!moved) return call
    const delta = resolved - call.costUSD
    if (Math.abs(delta) > 1e-12) {
      adjustedUSD += delta
      adjustedCalls += 1
    }
    return { ...call, costUSD: resolved }
  })

  return { calls: corrected, adjustedUSD, adjustedCalls, unpricedCalls }
}

function totalTokens(tokens: {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

function countUnpriced(calls: readonly CallRow[]) {
  return calls.filter(
    (call) =>
      call.costUSD === 0 &&
      call.providerID !== null &&
      call.modelID !== null &&
      (call.tokensInput ?? 0) + (call.tokensOutput ?? 0) > 0,
  ).length
}
