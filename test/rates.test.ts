import { describe, expect, test } from "bun:test"
import { allowanceListUSD } from "../src/allowances"
import { parsePlans } from "../src/plans"
import { rateTable, type RateSample } from "../src/rates"

const NOW = Date.parse("2026-10-28T12:00:00Z")
const PEAK_HOUR = Date.parse("2026-10-28T02:00:00Z") // Wednesday, inside 01:00-04:00
const OFF_PEAK_HOUR = Date.parse("2026-10-28T12:00:00Z")

const tokens = (input: number, output: number, cacheRead: number) => ({
  input,
  output,
  reasoning: 0,
  cacheRead,
  cacheWrite: 0,
})

function sample(overrides: Partial<RateSample> & Pick<RateSample, "providerID" | "modelID">): RateSample {
  return {
    at: OFF_PEAK_HOUR,
    recordedUSD: 1,
    tokens: tokens(1_000_000, 0, 0),
    ...overrides,
  }
}

const plans = parsePlans({
  providers: {
    // A clock-metered plan: $20 of usage at official API prices for $10, and
    // DeepSeek's rate doubles inside the peak windows.
    clocked: {
      label: "Clocked Plan",
      terms: [{ from: "2026-10-01", monthlyUSD: 10 }],
      peak: { windows: ["01:00-04:00", "06:00-10:00"], days: [1, 2, 3, 4, 5] },
      peakMultiplier: 2,
      rates: { "model-a": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
    },
    // The same allowance, but the plan meters one card at every hour, so its
    // rate does not move with the clock.
    flat: {
      label: "Flat Plan",
      terms: [{ from: "2026-10-01", monthlyUSD: 10 }],
      peak: { windows: ["01:00-04:00", "06:00-10:00"], days: [1, 2, 3, 4, 5] },
      peakMultiplier: 2,
      rates: { "model-a": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
    },
  },
})

/**
 * The advertised tables, rebuilt here so the test does not depend on the live
 * plans file or on which providers happen to be configured today.
 */
const advertised = {
  clocked: {
    providerID: "clocked",
    label: "Clocked Plan",
    monthlyUSD: 10,
    monthlyCreditsUSD: null,
    windows: [],
    models: [{ id: "model-a", name: "Model A", multiplier: 1, card: null, monthlyUSD: 20, requestsPer5h: null, unmetered: false }],
    basis: "clock" as const,
    source: "test",
  },
  flat: {
    providerID: "flat",
    label: "Flat Plan",
    monthlyUSD: 10,
    monthlyCreditsUSD: 60,
    windows: [],
    models: [{ id: "model-a", name: "Model A", multiplier: 1, card: null, monthlyUSD: null, requestsPer5h: null, unmetered: false }],
    basis: "flat" as const,
    source: "test",
  },
}

describe("allowanceListUSD", () => {
  test("uses a published per-model allowance as-is", () => {
    expect(allowanceListUSD(advertised.clocked, "model-a")).toBe(20)
  })

  test("inverts the credit pool so a 1x model reaches half the pool", () => {
    // credits = 2 x usage x multiplier, so a $60 pool is $30 of 1x usage.
    expect(allowanceListUSD(advertised.flat, "model-a")).toBe(30)
  })

  test("returns null for a model the plan does not publish", () => {
    expect(allowanceListUSD(advertised.clocked, "model-z")).toBeNull()
  })
})

describe("rateTable", () => {
  test("a clock-metered allowance buys half the tokens at peak", () => {
    const table = rateTable({
      plans,
      now: NOW,
      advertised: [advertised.clocked, advertised.flat],
      samples: [sample({ providerID: "clocked", modelID: "model-a" })],
    })
    // Alias tuning is not involved: the two providers differ only in `basis`,
    // so register the advertised table for the ids under test.
    if (table.rows.length === 0) throw new Error(`expected a row, skipped: ${table.skipped.join(",")}`)
    const row = table.rows[0]!
    expect(row.basis).toBe("clock")
    expect(row.offPeak.tokensPerDollar.input).toBeCloseTo((20 / 10 / 0.15) * 1_000_000, 6)
    expect(row.peak.tokensPerDollar.input).toBeCloseTo((20 / 10 / 0.3) * 1_000_000, 6)
    expect(row.offPeak.tokensPerDollar.input / row.peak.tokensPerDollar.input).toBeCloseTo(2, 9)
  })

  test("a flat card is the same at every hour", () => {
    const table = rateTable({
      plans,
      now: NOW,
      advertised: [advertised.clocked, advertised.flat],
      samples: [sample({ providerID: "flat", modelID: "model-a" })],
    })
    const row = table.rows[0]!
    expect(row.basis).toBe("flat")
    // $30 of card usage for a $10 fee, priced at the card.
    expect(row.offPeak.tokensPerDollar.input).toBeCloseTo((30 / 10 / 0.3) * 1_000_000, 6)
    expect(row.peak.tokensPerDollar.input).toBeCloseTo(row.offPeak.tokensPerDollar.input, 9)
  })

  test("a plan with no peak windows has one price all week", () => {
    const flatRates = parsePlans({
      providers: {
        clocked: {
          terms: [{ from: "2026-10-01", monthlyUSD: 10 }],
          rates: { "model-a": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
        },
      },
    })
    const table = rateTable({
      plans: flatRates,
      now: NOW,
      advertised: [advertised.clocked, advertised.flat],
      samples: [sample({ providerID: "clocked", modelID: "model-a", at: PEAK_HOUR })],
    })
    const row = table.rows[0]!
    expect(row.offPeak.tokensPerDollar.input).toBeCloseTo(row.peak.tokensPerDollar.input, 9)
  })

  test("names providers it could not price instead of dropping them", () => {
    const table = rateTable({
      plans,
      now: NOW,
      advertised: [advertised.clocked, advertised.flat],
      samples: [
        sample({ providerID: "clocked", modelID: "model-a" }),
        sample({ providerID: "unpriced", modelID: "model-a" }),
      ],
    })
    expect(table.rows.map((row) => row.providerID)).toEqual(["clocked"])
    expect(table.skipped).toEqual(["unpriced"])
  })

  test("picks the model the provider actually spent on", () => {
    const priced = parsePlans({
      providers: {
        clocked: {
          terms: [{ from: "2026-10-01", monthlyUSD: 10 }],
          rates: {
            "model-a": { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
            "model-b": { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
          },
        },
      },
    })
    const bothModels = {
      ...advertised.clocked,
      models: [
        ...advertised.clocked.models,
        { id: "model-b", name: "Model B", multiplier: 1, card: null, monthlyUSD: 20, requestsPer5h: null, unmetered: false },
      ],
    }
    const table = rateTable({
      plans: priced,
      now: NOW,
      advertised: [bothModels],
      samples: [
        sample({ providerID: "clocked", modelID: "model-a", recordedUSD: 0.1 }),
        sample({ providerID: "clocked", modelID: "model-b", recordedUSD: 5 }),
      ],
    })
    expect(table.rows[0]?.modelID).toBe("model-b")
  })

  test("blends every row at one pooled mix, not each provider's own", () => {
    // Two providers, deliberately different shapes: if the blend used each
    // provider's own mix the prices would not be comparable between rows.
    const table = rateTable({
      plans,
      now: NOW,
      advertised: [advertised.clocked, advertised.flat],
      samples: [
        sample({ providerID: "clocked", modelID: "model-a", tokens: tokens(10_000_000, 0, 0) }),
        sample({ providerID: "flat", modelID: "model-a", tokens: tokens(0, 10_000_000, 0) }),
      ],
    })
    const clocked = table.rows.find((row) => row.providerID === "clocked")!
    const flat = table.rows.find((row) => row.providerID === "flat")!
    expect(table.mix?.input).toBeCloseTo(0.5, 9)
    expect(table.mix?.output).toBeCloseTo(0.5, 9)
    // Same mix on both rows: the input share of the blended price is equal even
    // though one provider moved only input and the other only output.
    const blendOf = (row: typeof clocked) =>
      (row.offPeak.perMillion.input * 0.5 + row.offPeak.perMillion.output * 0.5)
    expect(clocked.offPeak.blendedPerMillion).toBeCloseTo(blendOf(clocked), 9)
    expect(flat.offPeak.blendedPerMillion).toBeCloseTo(blendOf(flat), 9)
  })

  test("reports the share of spend that landed at peak", () => {
    const table = rateTable({
      plans,
      now: NOW,
      advertised: [advertised.clocked, advertised.flat],
      samples: [
        sample({ providerID: "clocked", modelID: "model-a", at: PEAK_HOUR, recordedUSD: 3 }),
        sample({ providerID: "clocked", modelID: "model-a", at: OFF_PEAK_HOUR, recordedUSD: 1 }),
      ],
    })
    expect(table.peakShare).toBeCloseTo(0.75, 9)
  })

  test("has no peak share when nothing was spent", () => {
    const table = rateTable({ plans, now: NOW, advertised: [advertised.clocked], samples: [] })
    expect(table.peakShare).toBeNull()
    expect(table.rows).toEqual([])
  })
})
