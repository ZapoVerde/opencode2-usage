import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { advertisedPlan } from "../src/allowances"

/**
 * The reconciliation depends on the two rate cards and the peak schedule being
 * exactly right. These tests pin the three published constants the verifier
 * relies on, so a provider changing them surfaces as a failure rather than a
 * quietly wrong burn rate.
 */

// The card shown in the OpenDesign console's "Credit usage breakdown" popup.
const CONSOLE_CARD = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 } as const
// OpenCode's configured rates, which is what `cost_usd` records.
const RECORDED_CARD = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } as const

function cardCost(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite?: number },
  card: typeof CONSOLE_CARD | typeof RECORDED_CARD,
) {
  return (
    (tokens.input * card.input +
      tokens.output * card.output +
      tokens.cacheRead * card.cacheRead +
      (tokens.cacheWrite ?? 0) * card.cacheWrite) /
    1_000_000
  )
}

describe("console rate card", () => {
  test("is DeepSeek's published peak price", () => {
    // api-docs.deepseek.com/quick_start/pricing, deepseek-flash peak tier.
    expect<number>(CONSOLE_CARD.input).toBe(0.3)
    expect<number>(CONSOLE_CARD.output).toBe(1.2)
    expect<number>(CONSOLE_CARD.cacheRead).toBe(0.006)
  })

  test("is exactly double the recorded off-peak card", () => {
    // Off-peak is half of peak on every line, which is why the card/recorded
    // ratio is a constant 2 rather than varying per token type.
    expect<number>(CONSOLE_CARD.input).toBe(RECORDED_CARD.input * 2)
    expect<number>(CONSOLE_CARD.output).toBe(RECORDED_CARD.output * 2)
    expect<number>(CONSOLE_CARD.cacheRead).toBe(RECORDED_CARD.cacheRead * 2)
  })

  test("reproduces the two calls verified against the console", () => {
    // Both were matched in the books by token fingerprint. Reasoning tokens bill
    // at the output rate, so they are folded into output before costing.
    const calls = [
      // 2026-10-29T11:43:23Z, off-peak hour.
      { input: 795, output: 896 + 8333, cacheRead: 93952, console: 0.0119, recorded: 0.005938506 },
      // 2026-10-29T09:38:47Z, peak hour.
      { input: 646, output: 133 + 2614, cacheRead: 207616, console: 0.0048, recorded: 0.002367948 },
    ]
    for (const call of calls) {
      const list = cardCost(call, CONSOLE_CARD)
      const offPeak = cardCost(call, RECORDED_CARD)
      // The console displays 4dp and rounds its subtotal up, so allow one
      // display unit rather than demanding an exact string match.
      expect(Math.abs(list - call.console)).toBeLessThan(0.0001)
      expect(offPeak).toBeCloseTo(call.recorded, 9)
      expect(list / offPeak).toBeCloseTo(2, 9)
    }
  })
})

describe("the live plans file", () => {
  /**
   * Command Code and OpenCode Go both quote their allowance in dollars at
   * official API prices, so DeepSeek's time-of-day tier passes straight
   * through to what the plan meters. Leaving those plans without peak
   * windows made the dashboard's API-list figure read $12 for work the
   * provider charged $15.
   */
  const file = "/data/opencode/usage-plans.json"

  test("declares DeepSeek peak windows for the clock-metered plans", () => {
    if (!existsSync(file)) return
    const plans = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>
    for (const id of ["commandcode", "opencode-go"]) {
      const provider = plans.providers[id]
      expect(provider.peakMultiplier).toBe(2)
      expect(provider.peak.windows).toEqual(["01:00-04:00", "06:00-10:00"])
      expect(provider.peak.days).toEqual([1, 2, 3, 4, 5])
      // Scoped to the DeepSeek models, so another vendor's model routed
      // through the same plan does not inherit a surcharge it does not charge.
      expect(Array.isArray(provider.peakModels)).toBe(true)
      expect(provider.peakModels.every((model: string) => model.includes("deepseek"))).toBe(true)
    }
  })

  test("gives OpenDesign one flat card, not DeepSeek's clock", () => {
    if (!existsSync(file)) return
    const plans = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>
    const provider = plans.providers.opendesign
    // The console's Credit usage breakdown is the meter: input $0.44/M, output
    // $1.32/M, cache read $0.014/M. It is the same at every hour, so there is no
    // peak block and no peak multiplier to apply.
    expect(provider.peak).toBeUndefined()
    expect(provider.peakMultiplier).toBeUndefined()
    expect(provider.rates["deepseek-v4.1-flash"]).toEqual({
      input: 0.44,
      output: 1.32,
      cacheRead: 0.014,
      cacheWrite: 0.44,
    })
    expect(provider.rates["deepseek-v4-flash"]).toEqual(provider.rates["deepseek-v4.1-flash"])
  })

  test("the plans file and the advertised card agree, so credits cannot drift", () => {
    if (!existsSync(file)) return
    const plans = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>
    const od = advertisedPlan("opendesign")
    if (od === undefined) throw new Error("missing OpenDesign plan")
    for (const id of ["deepseek-v4.1-flash", "deepseek-v4-flash"]) {
      const model = od.models.find((entry) => entry.id === id)
      if (model?.card === null || model?.card === undefined) throw new Error(`missing card for ${id}`)
      // `web/impute.ts` prices calls from the plans file; `quota-view.ts` prices
      // credits from this card. One must not move without the other.
      expect(plans.providers.opendesign.rates[id]).toEqual({
        input: model.card.input,
        output: model.card.output,
        cacheRead: model.card.cacheRead,
        cacheWrite: model.card.cacheWrite,
      })
    }
  })
})

describe("deepseek peak windows", () => {
  // 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
  const PEAK = [
    [60, 240],
    [360, 600],
  ] as const

  function inPeak(at: number) {
    const date = new Date(at)
    const weekday = date.getUTCDay()
    if (weekday === 0 || weekday === 6) return false
    const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
    return PEAK.some(([start, end]) => minute >= start && minute < end)
  }

  test("classifies the two verified calls", () => {
    // 2026-10-29 is a Thursday.
    expect(inPeak(Date.parse("2026-10-29T09:38:47Z"))).toBe(true)
    expect(inPeak(Date.parse("2026-10-29T11:43:23Z"))).toBe(false)
  })

  test("excludes weekends even inside a peak hour", () => {
    // 2026-10-31 is a Saturday, 2026-11-01 a Sunday.
    expect(inPeak(Date.parse("2026-10-31T02:00:00Z"))).toBe(false)
    expect(inPeak(Date.parse("2026-11-01T07:00:00Z"))).toBe(false)
    // The same hour on a weekday is peak.
    expect(inPeak(Date.parse("2026-10-30T02:00:00Z"))).toBe(true)
  })

  test("treats the window boundaries as half-open", () => {
    expect(inPeak(Date.parse("2026-10-29T01:00:00Z"))).toBe(true)
    expect(inPeak(Date.parse("2026-10-29T03:59:59Z"))).toBe(true)
    expect(inPeak(Date.parse("2026-10-29T04:00:00Z"))).toBe(false)
    expect(inPeak(Date.parse("2026-10-29T05:59:59Z"))).toBe(false)
    expect(inPeak(Date.parse("2026-10-29T06:00:00Z"))).toBe(true)
    expect(inPeak(Date.parse("2026-10-29T10:00:00Z"))).toBe(false)
  })
})

describe("credit entitlement", () => {
  test("the multiplier changes how far the pool reaches, not the per-call meter", () => {
    // Inverting `credits = 2 x usage x multiplier` reproduces the published
    // monthly usage column. A lower multiplier is *more* usage, not less.
    const pool = 120
    const published = [
      { multiplier: 0.5, monthlyUsage: 120 },
      { multiplier: 1, monthlyUsage: 60 },
      { multiplier: 2, monthlyUsage: 30 },
      { multiplier: 4, monthlyUsage: 15 },
    ]
    for (const entry of published) {
      expect(pool / (2 * entry.multiplier)).toBe(entry.monthlyUsage)
    }
  })

  test("the console card, not the multiplier, is the meter", () => {
    // The card is the same at every hour and for every model that shares it, so
    // the same tokens cost the same credits regardless of the model multiplier.
    const card = { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 }
    const tokens = { input: 3_900_000, output: 2_280_000, cacheRead: 350_740_000, cacheWrite: 0 }
    const cost =
      (tokens.input * card.input +
        tokens.output * card.output +
        tokens.cacheRead * card.cacheRead +
        tokens.cacheWrite * card.cacheWrite) /
      1_000_000
    expect(cost).toBeCloseTo(9.636, 3)
    // The console displayed 31% of its $30 weekly cap; the card gives 32%.
    expect(Math.round((cost / 30) * 100)).toBe(32)
  })
})
