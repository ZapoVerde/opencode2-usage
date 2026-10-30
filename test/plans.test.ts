import { describe, expect, test } from "bun:test"
import {
  EMPTY_PLANS,
  isPeak,
  monthlyFeeAt,
  parsePlans,
  planCoverage,
  providerReport,
  totalTokens,
  type ProviderPlan,
} from "../src/plans"

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
// Query windows are half-open `[since, until)`, so an inclusive final day ends at
// the following UTC midnight.
const nextDay = (iso: string) => day(iso) + 86_400_000

function planOf(document: unknown): ProviderPlan {
  const plans = parsePlans(document)
  expect(plans.errors).toEqual([])
  const plan = plans.providers.get("acme")
  if (plan === undefined) throw new Error("plan missing")
  return plan
}

const sample = (input: {
  at: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  recordedUSD?: number
  modelID?: string
}) => ({
  modelID: input.modelID ?? "model-a",
  at: input.at,
  tokens: {
    input: input.input ?? 0,
    output: input.output ?? 0,
    reasoning: input.reasoning ?? 0,
    cacheRead: input.cacheRead ?? 0,
    cacheWrite: input.cacheWrite ?? 0,
  },
  recordedUSD: input.recordedUSD ?? 0,
})

describe("parsePlans", () => {
  test("accepts a term list and sorts it by date", () => {
    const plan = planOf({
      providers: {
        acme: {
          label: "Acme Go",
          terms: [
            { from: "2026-11-01", monthlyUSD: 10 },
            { from: "2026-10-01", monthlyUSD: 8 },
          ],
        },
      },
    })
    expect(plan.label).toBe("Acme Go")
    expect(plan.terms.map((term) => term.monthlyUSD)).toEqual([8, 10])
    // No declared surcharge: a window only classifies usage by default.
    expect(plan.peakMultiplier).toBe(1)
  })

  test("drops a bad provider instead of failing the whole file", () => {
    const plans = parsePlans({
      providers: {
        good: { terms: [{ from: "2026-10-01", monthlyUSD: 5 }] },
        bad: { terms: [{ from: "not-a-date", monthlyUSD: 5 }] },
      },
    })
    expect([...plans.providers.keys()]).toEqual(["good"])
    expect(plans.errors.length).toBeGreaterThan(0)
    expect(plans.errors[0]).toContain("bad")
  })

  test("rejects malformed input shapes", () => {
    expect(parsePlans(null).errors[0]).toContain("expected a JSON object")
    expect(parsePlans([]).errors[0]).toContain("expected a JSON object")
    expect(parsePlans({ providers: [] }).errors[0]).toContain('"providers" must be an object')
    expect(parsePlans({}).providers.size).toBe(0)
  })

  test("rejects a negative or non-numeric fee", () => {
    const plans = parsePlans({ providers: { acme: { terms: [{ from: "2026-10-01", monthlyUSD: -1 }] } } })
    expect(plans.providers.size).toBe(0)
    expect(plans.errors[0]).toContain("non-negative")
  })

  test("parses peak windows with weekday defaults", () => {
    const plan = planOf({
      providers: {
        acme: {
          terms: [{ from: "2026-10-01", monthlyUSD: 8 }],
          peak: { windows: ["01:00-04:00", "23:00-01:00"] },
        },
      },
    })
    expect(plan.peak).toHaveLength(2)
    expect(plan.peak[0]).toEqual({ startMinute: 60, endMinute: 240, days: [1, 2, 3, 4, 5] })
  })

  test("drops an empty or malformed peak window", () => {
    const plans = parsePlans({
      providers: {
        acme: {
          terms: [{ from: "2026-10-01", monthlyUSD: 8 }],
          peak: { windows: ["03:00-03:00", "nope"] },
        },
      },
    })
    expect(plans.providers.get("acme")?.peak).toHaveLength(0)
    expect(plans.errors).toHaveLength(2)
  })

  test("parses per-model rates and defaults missing kinds to zero", () => {
    const plan = planOf({
      providers: {
        acme: {
          terms: [{ from: "2026-10-01", monthlyUSD: 8 }],
          rates: { "model-a": { input: 0.15, output: 0.6 } },
        },
      },
    })
    expect(plan.rates.get("model-a")).toEqual({ input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 })
  })
})

describe("monthlyFeeAt", () => {
  const plan = planOf({
    providers: {
      acme: {
        terms: [
          { from: "2026-10-01", monthlyUSD: 8 },
          { from: "2026-11-01", monthlyUSD: 10 },
        ],
      },
    },
  })

  test("is null before the first term", () => {
    expect(monthlyFeeAt(plan, day("2026-09-30"))).toBeNull()
  })

  test("applies the term in effect", () => {
    expect(monthlyFeeAt(plan, day("2026-10-01"))).toBe(8)
    expect(monthlyFeeAt(plan, day("2026-10-31"))).toBe(8)
    expect(monthlyFeeAt(plan, day("2026-11-01"))).toBe(10)
  })
})

describe("planCoverage", () => {
  test("prorates by real month length", () => {
    const plan = planOf({ providers: { acme: { terms: [{ from: "2026-10-01", monthlyUSD: 31 }] } } })
    // October has 31 days, so one day is exactly $1.
    expect(planCoverage(plan, day("2026-10-01"), nextDay("2026-10-01")).spendUSD).toBeCloseTo(1, 10)
    expect(planCoverage(plan, day("2026-10-01"), day("2026-11-01")).spendUSD).toBeCloseTo(31, 10)
    // February is shorter, so its days cost more each.
    const february = planOf({ providers: { acme: { terms: [{ from: "2026-02-01", monthlyUSD: 28 }] } } })
    expect(planCoverage(february, day("2026-02-01"), nextDay("2026-02-01")).spendUSD).toBeCloseTo(1, 10)
    // A 7-day window is 7 days of fee, not 8, regardless of where it starts.
    expect(planCoverage(plan, day("2026-10-25"), day("2026-11-01")).spendUSD).toBeCloseTo(7, 10)
    expect(planCoverage(plan, day("2026-10-25"), day("2026-11-01")).days).toBeCloseTo(7, 10)
  })

  test("charges nothing before the plan starts", () => {
    const plan = planOf({ providers: { acme: { terms: [{ from: "2026-10-20", monthlyUSD: 10 }] } } })
    expect(planCoverage(plan, day("2026-10-01"), day("2026-10-19")).spendUSD).toBe(0)
    expect(planCoverage(plan, day("2026-10-01"), day("2026-10-19")).days).toBe(0)
  })

  test("clamps a window that starts before the plan", () => {
    const plan = planOf({ providers: { acme: { terms: [{ from: "2026-10-20", monthlyUSD: 31 }] } } })
    const coverage = planCoverage(plan, day("2026-10-01"), day("2026-10-21"))
    expect(coverage.days).toBe(1)
    expect(coverage.spendUSD).toBeCloseTo(1, 10)
  })

  test("returns zero for an inverted window", () => {
    const plan = planOf({ providers: { acme: { terms: [{ from: "2026-10-01", monthlyUSD: 10 }] } } })
    expect(planCoverage(plan, day("2026-10-20"), day("2026-10-01"))).toEqual({ days: 0, spendUSD: 0 })
  })
})

describe("isPeak", () => {
  const plan = planOf({
    providers: {
      acme: {
        terms: [{ from: "2026-10-01", monthlyUSD: 8 }],
        peak: { windows: ["01:00-04:00", "23:00-01:00"], days: [1, 2, 3, 4, 5] },
      },
    },
  })

  // 2026-10-28 is a Wednesday.
  test("matches inside a weekday window", () => {
    expect(isPeak(plan, Date.parse("2026-10-28T02:00:00Z"), "model-a")).toBe(true)
    // The window ends at 04:00 exclusive, and midday belongs to neither window.
    expect(isPeak(plan, Date.parse("2026-10-28T04:00:00Z"), "model-a")).toBe(false)
    expect(isPeak(plan, Date.parse("2026-10-28T12:00:00Z"), "model-a")).toBe(false)
  })

  test("wraps a window across midnight", () => {
    // 00:30 and 23:30 are only inside the wrapping 23:00-01:00 window.
    expect(isPeak(plan, Date.parse("2026-10-28T23:30:00Z"), "model-a")).toBe(true)
    expect(isPeak(plan, Date.parse("2026-10-29T00:30:00Z"), "model-a")).toBe(true)
    expect(isPeak(plan, Date.parse("2026-10-29T01:30:00Z"), "model-a")).toBe(true)
    expect(isPeak(plan, Date.parse("2026-10-29T12:30:00Z"), "model-a")).toBe(false)
  })

  test("ignores weekends", () => {
    // 2026-10-31 is a Saturday.
    expect(isPeak(plan, Date.parse("2026-10-31T02:00:00Z"), "model-a")).toBe(false)
  })

  test("restricts to listed models when peakModels is set", () => {
    const limited = planOf({
      providers: {
        acme: {
          terms: [{ from: "2026-10-01", monthlyUSD: 8 }],
          peak: { windows: ["01:00-04:00"] },
          peakModels: ["model-a"],
        },
      },
    })
    expect(isPeak(limited, Date.parse("2026-10-28T02:00:00Z"), "model-a")).toBe(true)
    expect(isPeak(limited, Date.parse("2026-10-28T02:00:00Z"), "model-b")).toBe(false)
  })

  test("a plan without windows is never peak", () => {
    const flat = planOf({ providers: { acme: { terms: [{ from: "2026-10-01", monthlyUSD: 8 }] } } })
    expect(isPeak(flat, Date.parse("2026-10-28T02:00:00Z"), "model-a")).toBe(false)
  })
})

describe("providerReport", () => {
  const plan = planOf({
    providers: {
      acme: {
        terms: [{ from: "2026-10-01", monthlyUSD: 31 }],
        rates: { "model-a": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
      },
    },
  })

  test("splits spend and list value across a window", () => {
    const report = providerReport({
      plan,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: day("2026-10-11"),
      samples: [sample({ at: day("2026-10-02"), input: 1_000_000, output: 1_000_000 })],
    })
    // Ten covered days at $1 each.
    expect(report.spendUSD).toBeCloseTo(10, 6)
    expect(report.paidDays).toBe(10)
    // 1M input at $1 + 1M output at $2.
    expect(report.meteredUSD).toBeCloseTo(3, 6)
    expect(report.valueRatio).toBeCloseTo(0.3, 6)
  })

  test("charges the paid rate per kind from list-cost share", () => {
    const report = providerReport({
      plan,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [sample({ at: day("2026-10-01"), input: 1_000_000, output: 1_000_000 })],
    })
    // $1 of spend split 1:2 by list cost, over 1M tokens of each kind.
    expect(report.paid.input).toBeCloseTo(1 / 3, 6)
    expect(report.paid.output).toBeCloseTo(2 / 3, 6)
    expect(report.metered.input).toBeCloseTo(1, 6)
    expect(report.metered.output).toBeCloseTo(2, 6)
  })

  test("prices reasoning as output", () => {
    const report = providerReport({
      plan,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [sample({ at: day("2026-10-01"), output: 500_000, reasoning: 500_000 })],
    })
    expect(report.meteredUSD).toBeCloseTo(2, 6)
  })

  test("falls back to recorded cost when the plan has no rates", () => {
    const plain = planOf({ providers: { acme: { terms: [{ from: "2026-10-01", monthlyUSD: 10 }] } } })
    const report = providerReport({
      plan: plain,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [sample({ at: day("2026-10-01"), input: 1_000, recordedUSD: 0.5 })],
    })
    expect(report.meteredUSD).toBeCloseTo(0.5, 6)
    expect(report.metered.blended).toBeCloseTo(500, 6)
    // No per-kind list price exists when only the recorded total is known.
    expect(report.paid.input).toBeNull()
  })

  test("reports no plan spend without a plan", () => {
    const report = providerReport({
      plan: null,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [sample({ at: day("2026-10-01"), input: 1_000, recordedUSD: 0.25 })],
    })
    expect(report.spendUSD).toBe(0)
    expect(report.meteredUSD).toBeCloseTo(0.25, 6)
    expect(report.valueRatio).toBeNull()
    expect(report.paid.blended).toBeNull()
  })

  test("splits peak from off-peak only when windows exist", () => {
    const windowed = planOf({
      providers: {
        acme: {
          terms: [{ from: "2026-10-01", monthlyUSD: 31 }],
          peak: { windows: ["01:00-04:00"] },
          peakMultiplier: 2,
          rates: { "model-a": { input: 1, output: 1 } },
        },
      },
    })
    const report = providerReport({
      plan: windowed,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-28"),
      until: nextDay("2026-10-28"),
      samples: [
        sample({ at: Date.parse("2026-10-28T02:00:00Z"), input: 1_000_000 }),
        sample({ at: Date.parse("2026-10-28T12:00:00Z"), input: 1_000_000 }),
      ],
    })
    expect(report.peak.calls).toBe(1)
    expect(report.offPeak.calls).toBe(1)
    // Peak input is charged at the 2x multiplier.
    expect(report.peak.listUSD).toBeCloseTo(2, 6)
    expect(report.offPeak.listUSD).toBeCloseTo(1, 6)
    // The peak multiplier is upstream's price, so peak input lists at 2x.
    expect(report.peak.metered.input).toBeCloseTo(2, 6)
    expect(report.offPeak.metered.input).toBeCloseTo(1, 6)
    // The fee follows list cost, so peak carries 2/3 of it over 1M tokens and
    // the peak's effective paid rate equals the off-peak list rate.
    expect(report.peak.paid.input).toBeCloseTo((2 / 3) * 1, 6)
    expect(report.offPeak.paid.input).toBeCloseTo((1 / 3) * 1, 6)
  })

  test("a window alone does not change the price", () => {
    // Classifying peak hours is not the same as claiming a surcharge: a plan
    // subscriber pays the same monthly fee whenever the call happened.
    const windowed = planOf({
      providers: {
        acme: {
          terms: [{ from: "2026-10-01", monthlyUSD: 31 }],
          peak: { windows: ["01:00-04:00"] },
          rates: { "model-a": { input: 1, output: 1 } },
        },
      },
    })
    const report = providerReport({
      plan: windowed,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-28"),
      until: nextDay("2026-10-28"),
      samples: [
        sample({ at: Date.parse("2026-10-28T02:00:00Z"), input: 1_000_000 }),
        sample({ at: Date.parse("2026-10-28T12:00:00Z"), input: 1_000_000 }),
      ],
    })
    expect(report.peak.calls).toBe(1)
    expect(report.offPeak.calls).toBe(1)
    // Both buckets list at the same $1/M and cost $1 each.
    expect(report.peak.listUSD).toBeCloseTo(1, 6)
    expect(report.offPeak.listUSD).toBeCloseTo(1, 6)
    expect(report.meteredUSD).toBeCloseTo(2, 6)
  })

  test("a clock-metered plan doubles at peak and lists the real total", () => {
    // Command Code and OpenCode Go both state their allowance in dollars at
    // official API prices, and DeepSeek bills double inside its peak windows.
    // The dashboard's API-list figure must therefore apply the surcharge, or it
    // reports $12 for work the provider charged $15.
    const clocked = planOf({
      providers: {
        acme: {
          terms: [{ from: "2026-10-01", monthlyUSD: 10 }],
          peak: { windows: ["01:00-04:00", "06:00-10:00"], days: [1, 2, 3, 4, 5] },
          peakModels: ["model-a"],
          peakMultiplier: 2,
          rates: { "model-a": { input: 0.15, output: 0.6, cacheRead: 0.003 } },
        },
      },
    })
    const report = providerReport({
      plan: clocked,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-28"),
      until: nextDay("2026-10-28"),
      samples: [
        // 02:00 UTC on a Wednesday: inside the first peak window.
        sample({ at: Date.parse("2026-10-28T02:00:00Z"), input: 1_000_000 }),
        // 12:00 UTC: off-peak.
        sample({ at: Date.parse("2026-10-28T12:00:00Z"), input: 1_000_000 }),
      ],
    })
    expect(report.peak.calls).toBe(1)
    expect(report.offPeak.calls).toBe(1)
    // $0.30 at peak against $0.15 off-peak, so the pair lists at $0.45 rather
    // than the $0.30 a static off-peak-only table would show.
    expect(report.peak.listUSD).toBeCloseTo(0.3, 9)
    expect(report.offPeak.listUSD).toBeCloseTo(0.15, 9)
    expect(report.meteredUSD).toBeCloseTo(0.45, 9)
  })

  test("a peak surcharge only applies to the declared models", () => {
    // The peak windows are DeepSeek's. A provider reselling another vendor's
    // model through the same plan must not inherit a surcharge that vendor
    // does not charge.
    const clocked = planOf({
      providers: {
        acme: {
          terms: [{ from: "2026-10-01", monthlyUSD: 10 }],
          peak: { windows: ["01:00-04:00"], days: [1, 2, 3, 4, 5] },
          peakModels: ["deepseek-flash"],
          peakMultiplier: 2,
          rates: {
            "deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
            "other-model": { input: 1, output: 1, cacheRead: 1 },
          },
        },
      },
    })
    const report = providerReport({
      plan: clocked,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-28"),
      until: nextDay("2026-10-28"),
      samples: [sample({ at: Date.parse("2026-10-28T02:00:00Z"), input: 1_000_000, modelID: "other-model" })],
    })
    expect(report.peak.calls).toBe(0)
    expect(report.offPeak.calls).toBe(1)
    expect(report.meteredUSD).toBeCloseTo(1, 9)
  })

  test("omits the split for a flat plan", () => {
    const flat = planOf({ providers: { acme: { terms: [{ from: "2026-10-01", monthlyUSD: 10 }] } } })
    const report = providerReport({
      plan: flat,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [sample({ at: day("2026-10-01"), input: 10 })],
    })
    expect(report.peak.listUSD).toBeNull()
    expect(report.peak.metered.blended).toBeNull()
    expect(report.peak.paid.blended).toBeNull()
  })

  test("groups models highest list cost first", () => {
    const report = providerReport({
      plan,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [
        sample({ at: day("2026-10-01"), modelID: "model-a", input: 100_000 }),
        sample({ at: day("2026-10-01"), modelID: "model-b", input: 900_000, recordedUSD: 5 }),
      ],
    })
    expect(report.models.map((model) => model.modelID)).toEqual(["model-b", "model-a"])
    // model-b has no rate, so its recorded cost stands in for list price.
    expect(report.models[0]?.meteredUSD).toBeCloseTo(5, 6)
  })
})

describe("empty plans", () => {
  test("EMPTY_PLANS has no providers or errors", () => {
    expect(EMPTY_PLANS.providers.size).toBe(0)
    expect(EMPTY_PLANS.errors).toEqual([])
  })

  test("totalTokens counts every kind", () => {
    expect(totalTokens({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })).toBe(15)
  })
})

describe("providerReport peak pricing", () => {
  // DeepSeek's schedule: peak doubles list price inside two weekday windows.
  const plan = planOf({
    providers: {
      acme: {
        terms: [{ from: "2026-10-01", monthlyUSD: 310 }],
        rates: { "model-a": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
        peak: { windows: ["01:00-04:00", "06:00-10:00"], days: [1, 2, 3, 4, 5] },
        peakMultiplier: 2,
      },
    },
  })

  test("charges peak calls at the multiplier", () => {
    // 2026-10-01 is a Thursday; 02:00 UTC is inside the first peak window.
    const report = providerReport({
      plan,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [sample({ at: Date.parse("2026-10-01T02:00:00Z"), input: 1_000_000 })],
    })
    // 1M input at $1, doubled by the peak multiplier.
    expect(report.meteredUSD).toBeCloseTo(2, 6)
    expect(report.peak.calls).toBe(1)
    expect(report.offPeak.calls).toBe(0)
  })

  test("leaves off-peak calls at list price", () => {
    // 11:00 UTC is outside both windows.
    const report = providerReport({
      plan,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [sample({ at: Date.parse("2026-10-01T11:00:00Z"), input: 1_000_000 })],
    })
    expect(report.meteredUSD).toBeCloseTo(1, 6)
    expect(report.offPeak.calls).toBe(1)
  })

  test("per-model list cost agrees with the provider total", () => {
    // The model row used to reprice the aggregate token counts at one tier,
    // which disagreed with the total whenever a window mixed peak and off-peak.
    const report = providerReport({
      plan,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [
        sample({ at: Date.parse("2026-10-01T02:00:00Z"), input: 1_000_000 }),
        sample({ at: Date.parse("2026-10-01T11:00:00Z"), input: 1_000_000 }),
      ],
    })
    // Peak $2 + off-peak $1.
    expect(report.meteredUSD).toBeCloseTo(3, 6)
    const model = report.models.find((entry) => entry.modelID === "model-a")
    expect(model?.meteredUSD).toBeCloseTo(3, 6)
    // Per-model peak counts stay consistent with the buckets.
    expect(model?.peakCalls).toBe(1)
    expect(model?.offPeakCalls).toBe(1)
  })

  test("model rows sum to the provider list value", () => {
    const report = providerReport({
      plan,
      providerID: "acme",
      sessions: 1,
      since: day("2026-10-01"),
      until: nextDay("2026-10-01"),
      samples: [
        sample({ at: Date.parse("2026-10-01T02:00:00Z"), input: 1_000_000 }),
        sample({ at: Date.parse("2026-10-01T11:00:00Z"), input: 500_000 }),
      ],
    })
    const sum = report.models.reduce((total, entry) => total + (entry.meteredUSD ?? 0), 0)
    expect(sum).toBeCloseTo(report.meteredUSD ?? 0, 6)
  })
})
