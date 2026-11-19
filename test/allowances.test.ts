import { describe, expect, test } from "bun:test"
import {
  advertisedPlan,
  ADVERTISED_PLANS,
  creditsForTokens,
  modelMultiplier,
  planModel,
  windowCap,
} from "../src/allowances"
import { advertisedQuota, creditsUsed, type ModelSpend } from "../src/quota-view"

function plan(providerID: string) {
  const found = advertisedPlan(providerID)
  if (found === undefined) throw new Error(`no plan for ${providerID}`)
  return found
}

const tokens = (input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  reasoning,
  cacheRead,
  cacheWrite,
})
const spend = (modelID: string, costUSD: number, moved = tokens()): ModelSpend => ({
  modelID,
  costUSD,
  calls: 1,
  tokens: moved,
})

describe("advertised plan data", () => {
  test("publishes every plan in use", () => {
    expect(ADVERTISED_PLANS.map((entry) => entry.providerID)).toEqual([
      "commandcode",
      "opencode",
      "opendesign",
    ])
  })

  test("says how each plan denominates its allowance", () => {
    // This is the field the rates comparison turns on: a clock-rated allowance
    // buys half the tokens at peak, a peak-rated one never moves.
    expect(plan("commandcode").basis).toBe("clock")
    expect(plan("opencode").basis).toBe("clock")
    expect(plan("opendesign").basis).toBe("flat")
  })

  test("Command Code GOAT matches the published allowance", () => {
    const cc = plan("commandcode")
    expect(cc.monthlyUSD).toBe(10)
    // "deepseek-v4.1-flash boosted usage: $10 Go, $80 GOAT."
    expect(planModel(cc, "deepseek/deepseek-v4.1-flash")?.monthlyUSD).toBe(80)
    expect(cc.source).toBe("commandcode.ai/docs/plans/goat")
  })

  test("OpenDesign Go matches the published credit table", () => {
    const od = plan("opendesign")
    expect(od.monthlyUSD).toBe(10)
    // Go's console reports 50,000 credits per 5 hours and 150,000 per 7 days,
    // and 2,729 credits per dollar prices those at $18.33 and $54.96. The
    // published pair is $18 and $55; the monthly figure follows from the same
    // rate ($220 is 600,000 credits).
    expect(od.monthlyCreditsUSD).toBe(220)
    expect(od.windows.map((window) => [window.id, window.capUSD])).toEqual([
      ["rolling", 18],
      ["weekly", 55],
      ["monthly", 220],
    ])
  })

  test("OpenCode Go has no credit pool and a per-model allowance", () => {
    const go = plan("opencode")
    expect(go.monthlyUSD).toBe(10)
    expect(go.monthlyCreditsUSD).toBeNull()
    // Windows are shares of the monthly allowance: 20%, 50%, 100%.
    expect(go.windows.map((window) => window.share)).toEqual([0.2, 0.5, 1])
    expect(planModel(go, "deepseek-v4.1-flash")?.monthlyUSD).toBe(80)
  })
})

describe("model multipliers", () => {
  test("OpenDesign publishes 0.5x for DeepSeek V4.1 Flash", () => {
    // The multiplier is an allowance entitlement: half a credit per list dollar
    // means twice the usage against the same pool, not half. 0.5x for V4.1
    // Flash, 1x for most others, 2x for Haiku and Flash-X, 4x for GPT-6 Luna.
    const od = plan("opendesign")
    expect(modelMultiplier(od, "deepseek-v4.1-flash")).toBe(0.5)
    expect(modelMultiplier(od, "deepseek-v4-pro")).toBe(1)
    expect(modelMultiplier(od, "claude-haiku-5.5")).toBe(4)
    expect(modelMultiplier(od, "glm-5.3-flashx")).toBe(2)
    expect(modelMultiplier(od, "gpt-6-luna")).toBe(4)
  })

  test("Go has no multipliers", () => {
    const go = plan("opencode")
    expect(modelMultiplier(go, "deepseek-v4.1-flash")).toBe(1)
    expect(modelMultiplier(go, "gpt-6-luna")).toBe(1)
  })

  test("the same recorded id means different models on different plans", () => {
    // DeepSeek serves `deepseek-v4.1-flash`, which Go publishes as
    // `deepseek-flash` ($80 allowance). OpenDesign lists `deepseek-v4.1-flash`
    // itself, with no separate allowance. A shared alias would conflate them.
    const go = plan("opencode")
    const od = plan("opendesign")
    expect(planModel(go, "deepseek-v4.1-flash")?.id).toBe("deepseek-flash")
    expect(planModel(go, "deepseek-v4.1-flash")?.monthlyUSD).toBe(80)
    expect(planModel(od, "deepseek-v4.1-flash")?.id).toBe("deepseek-v4.1-flash")
  })

  test("falls back to a dots-to-dashes id", () => {
    expect(planModel(plan("opencode"), "claude-haiku-5-5")?.id).toBe("claude-haiku-5-5")
  })

  test("returns undefined for an unpublished model", () => {
    expect(planModel(plan("opendesign"), "not-a-model")).toBeUndefined()
    expect(modelMultiplier(plan("opendesign"), "not-a-model")).toBeNull()
  })
})

describe("creditsUsed", () => {
  test("reprices tokens at the console card, not recorded dollars", () => {
    // One million uncached input, one million output (reasoning folds into
    // output), and one million cache read, at the console's card.
    const result = creditsUsed(plan("opendesign"), [
      spend("deepseek-v4.1-flash", 0.153, tokens(1_000_000, 1_000_000, 0, 1_000_000)),
    ])
    expect(result.recordedUSD).toBe(0.153)
    // 0.44 + 1.32 + 0.014.
    expect(result.creditsUSD).toBeCloseTo(1.774, 9)
  })

  test("bills reasoning at the output rate", () => {
    const result = creditsUsed(plan("opendesign"), [
      spend("deepseek-v4.1-flash", 0.6, tokens(0, 0, 1_000_000)),
    ])
    expect(result.creditsUSD).toBeCloseTo(1.32, 9)
  })

  test("sums a mixed window with each model's own card", () => {
    const result = creditsUsed(plan("opendesign"), [
      spend("deepseek-v4.1-flash", 10, tokens(1_000_000)),
      spend("kimi-k2.7-code", 4, tokens(1_000_000)),
    ])
    expect(result.recordedUSD).toBe(14)
    // The DeepSeek models share the console card; Kimi keeps its own rate.
    expect(result.creditsUSD).toBeCloseTo(0.44 + 0.95, 9)
  })

  test("counts an unpublished model at 1x and reports it", () => {
    const result = creditsUsed(plan("opendesign"), [spend("mystery-model", 2, tokens(1_000_000))])
    expect(result.creditsUSD).toBe(2)
    expect(result.unknown).toEqual(["mystery-model"])
  })

  test("does not warn about a free unpublished model", () => {
    const result = creditsUsed(plan("opencode"), [spend("nemotron-3.5-super-vl-free", 0)])
    expect(result.creditsUSD).toBe(0)
    expect(result.unknown).toEqual([])
  })

  test("excludes unmetered promo models from credits", () => {
    const result = creditsUsed(plan("opencode"), [spend("deepseek-v4.1-flash", 8), spend("beam-free", 3)])
    expect(result.creditsUSD).toBe(8)
    expect(result.unmeteredUSD).toBe(3)
  })
})

describe("windowCap", () => {
  test("applies a share of the monthly allowance", () => {
    const go = plan("opencode")
    const monthly = go.windows.find((window) => window.id === "monthly")
    const rolling = go.windows.find((window) => window.id === "rolling")
    if (monthly === undefined || rolling === undefined) throw new Error("missing window")
    expect(windowCap(monthly, 80)).toBe(80)
    expect(windowCap(rolling, 80)).toBe(16)
  })

  test("uses a fixed cap where the plan publishes one", () => {
    const od = plan("opendesign")
    const rolling = od.windows.find((window) => window.id === "rolling")
    if (rolling === undefined) throw new Error("missing window")
    expect(windowCap(rolling, 220)).toBe(18)
    // A fixed cap does not depend on the monthly allowance at all.
    expect(windowCap(rolling, null)).toBe(18)
  })

  test("returns null when a share window has no allowance", () => {
    const go = plan("opencode")
    const weekly = go.windows.find((window) => window.id === "weekly")
    if (weekly === undefined) throw new Error("missing window")
    expect(windowCap(weekly, null)).toBeNull()
  })
})

describe("advertisedQuota", () => {
  test("reprices OpenDesign usage at the console card", () => {
    const quota = advertisedQuota({
      integrationID: "opendesign",
      models: ["deepseek-v4.1-flash"],
      spend: [spend("deepseek-v4.1-flash", 0.4, tokens(1_000_000))],
      live: [],
    })
    if (quota === null) throw new Error("expected a quota")
    expect(quota.allowanceUSD).toBe(220)
    expect(quota.recordedUSD).toBeCloseTo(0.4, 8)
    // 1M uncached input at the console's $0.44/M.
    expect(quota.creditsUSD).toBeCloseTo(0.44, 9)
    expect(quota.windows.map((window) => window.capUSD)).toEqual([18, 55, 220])
  })

  test("carries the console's own window limit alongside the published cap", () => {
    // The console reports its limits in credits (50,000 and 150,000 for Go), not
    // dollars. Treating those as dollars put "$50,000" beside "$18" for the same
    // window, so the credit figure travels separately and the page shows both.
    const quota = advertisedQuota({
      integrationID: "opendesign",
      models: ["deepseek-v4.1-flash"],
      spend: [],
      live: [
        { id: "rolling", usedPercent: 50, resetsAt: null, capCredits: 50000 },
        { id: "weekly", usedPercent: 50, resetsAt: null, capCredits: 150000 },
      ],
    })
    if (quota === null) throw new Error("expected a quota")
    const rolling = quota.windows.find((window) => window.id === "rolling")
    // The dollar cap stays the published one; the credit limit is its own field.
    expect(rolling?.capUSD).toBe(18)
    expect(rolling?.capCredits).toBe(50000)
    // Dollars used still come from the published cap, not from the credits.
    expect(rolling?.upstreamUSD).toBeCloseTo(9, 9)
    expect(quota.windows.find((window) => window.id === "monthly")?.capUSD).toBe(220)
  })

  test("turns a Go percentage into dollars against the model allowance", () => {
    const quota = advertisedQuota({
      integrationID: "opencode",
      models: ["deepseek-v4.1-flash"],
      spend: [spend("deepseek-v4.1-flash", 9.22)],
      live: [
        { id: "rolling", usedPercent: 0, resetsAt: null },
        { id: "weekly", usedPercent: 39, resetsAt: null },
        { id: "monthly", usedPercent: 90, resetsAt: null },
      ],
    })
    if (quota === null) throw new Error("expected a quota")
    expect(quota.allowanceUSD).toBe(80)
    expect(quota.mixedModels).toBe(false)
    const monthly = quota.windows.find((window) => window.id === "monthly")
    if (monthly === undefined) throw new Error("missing window")
    // 90% of $80.
    expect(monthly.upstreamUSD).toBeCloseTo(72, 6)
    const weekly = quota.windows.find((window) => window.id === "weekly")
    // 39% of the $40 weekly cap.
    expect(weekly?.upstreamUSD).toBeCloseTo(15.6, 6)
  })

  test("flags a window that mixed models with different allowances", () => {
    const quota = advertisedQuota({
      integrationID: "opencode",
      models: ["deepseek-v4.1-flash", "gpt-6-luna"],
      spend: [spend("deepseek-v4.1-flash", 9), spend("gpt-6-luna", 1)],
      live: [{ id: "monthly", usedPercent: 50, resetsAt: null }],
    })
    if (quota === null) throw new Error("expected a quota")
    expect(quota.mixedModels).toBe(true)
    // The basis is the model that spent the most, not an average.
    expect(quota.allowanceUSD).toBe(80)
    expect(quota.allowanceModel).toBe("DeepSeek V4.1 Flash")
  })

  test("carries the reset time through", () => {
    const resetsAt = Date.parse("2026-11-02T00:00:00.000Z")
    const quota = advertisedQuota({
      integrationID: "opencode",
      models: ["deepseek-v4.1-flash"],
      spend: [],
      live: [{ id: "weekly", usedPercent: 10, resetsAt }],
    })
    if (quota === null) throw new Error("expected a quota")
    expect(quota.windows.find((window) => window.id === "weekly")?.resetsAt).toBe(resetsAt)
  })

  test("returns null for a provider with no published plan", () => {
    expect(
      advertisedQuota({ integrationID: "unpublished", models: [], spend: [], live: [] }),
    ).toBeNull()
  })
})

describe("credits match the OpenDesign console", () => {
  test("the console card is the meter, with no clock or per-call multiplier", () => {
    const od = plan("opendesign")
    const call = tokens(563, 149, 0, 188_032)
    // The popover's own subtotal: 563 x $0.44 + 149 x $1.32 + 188,032 x $0.014.
    expect(creditsForTokens(od, "deepseek-v4-flash", call)).toBeCloseTo(0.0031, 4)
    // V4.1 Flash is metered at the same card; the 0.5x is an entitlement, so the
    // same tokens cost the same credits.
    expect(creditsForTokens(od, "deepseek-v4.1-flash", call)).toBeCloseTo(0.0031, 4)
  })

  test("reproduces the console's 31% weekly reading from its totals", () => {
    // The console's own 7-day totals at the moment of the reading: 354.64M
    // prompt tokens (350.74M of them cache) and 2.28M completion tokens. At the
    // card that is $1.72 + $3.01 + $4.91 = $9.64, which is 32% of the $30 cap;
    // the console rounded to 31%.
    const od = plan("opendesign")
    const credits = creditsForTokens(od, "deepseek-v4.1-flash", tokens(3_900_000, 2_280_000, 0, 350_740_000))
    expect(credits).toBeCloseTo(9.636, 3)
    expect(Math.round((credits! / 30) * 100)).toBe(32)
  })

  test("redistributes the console's spend by kind", () => {
    // Cache is 98.9% of prompt tokens but 51% of the bill; output is 0.64% of
    // tokens but 31% of the bill. A blended factor cannot express this.
    const od = plan("opendesign")
    const total = creditsForTokens(od, "deepseek-v4.1-flash", tokens(3_900_000, 2_280_000, 0, 350_740_000))!
    const cache = creditsForTokens(od, "deepseek-v4.1-flash", tokens(0, 0, 0, 350_740_000))!
    const output = creditsForTokens(od, "deepseek-v4.1-flash", tokens(0, 2_280_000, 0, 0))!
    expect(cache / total).toBeCloseTo(0.51, 2)
    expect(output / total).toBeCloseTo(0.31, 2)
  })

  test("leaves Go and Command Code on their recorded dollars", () => {
    // Their allowance is quoted at official API prices, so the recorded cost is
    // already in the plan's unit; repricing would double-count.
    const go = plan("opencode")
    expect(creditsForTokens(go, "deepseek-v4.1-flash", tokens(1_000_000))).toBeNull()
    expect(creditsUsed(go, [spend("deepseek-v4.1-flash", 8, tokens(1_000_000))]).creditsUSD).toBe(8)
  })
})
