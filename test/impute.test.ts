import { describe, expect, test } from "bun:test"
import type { CallRow } from "../src/reducer"
import { EMPTY_PLANS, parsePlans, type Plans } from "../src/plans"
import { alignCosts } from "../web/impute"

const plans: Plans = parsePlans({
  providers: {
    opendesign: {
      label: "OpenDesign Go",
      terms: [{ from: "2026-10-01", monthlyUSD: 8 }],
      rates: {
        "deepseek-v4.1-flash": { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 },
      },
    },
    "opencode-go": {
      label: "OpenCode Go",
      terms: [{ from: "2026-09-01", monthlyUSD: 10 }],
      rates: {
        "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      },
    },
  },
})

function call(overrides: Partial<CallRow>): CallRow {
  return {
    callID: "c1",
    assistantMessageID: null,
    sessionID: "s1",
    parentSessionID: null,
    kind: "step",
    agent: null,
    providerID: "opendesign",
    modelID: "deepseek-v4.1-flash",
    modelVariant: null,
    directory: null,
    startedAt: 0,
    firstTokenAt: null,
    firstTextAt: null,
    streamedAt: null,
    endedAt: null,
    tokensInput: 0,
    tokensOutput: 0,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUSD: 0,
    finish: null,
    rawFinish: null,
    status: "completed",
    error: null,
    turnID: null,
    errorType: null,
    errorMessage: null,
    errorStatus: null,
    errorRetryAfterMs: null,
    retries: 0,
    lastRetryErrorType: null,
    lastRetryAt: null,
    recordedAt: 0,
    ...overrides,
  }
}

describe("alignCosts", () => {
  test("reprices a flat-card plan at its own card, not the recorded table", () => {
    // One million uncached input, one million output, one million cache read.
    // OpenCode's table would say $0.15 + $0.60 + $0.003 = $0.753; the console
    // card says $0.44 + $1.32 + $0.014 = $1.774.
    const row = call({
      costUSD: 0.753,
      tokensInput: 1_000_000,
      tokensOutput: 1_000_000,
      tokensCacheRead: 1_000_000,
    })
    const result = alignCosts([row], plans)
    expect(result.calls[0]?.costUSD).toBeCloseTo(1.774, 9)
    expect(result.adjustedUSD).toBeCloseTo(1.774 - 0.753, 9)
    expect(result.adjustedCalls).toBe(1)
    expect(result.unpricedCalls).toBe(0)
  })

  test("bills reasoning at the output rate on the card", () => {
    const row = call({ costUSD: 0.6, tokensReasoning: 1_000_000 })
    expect(alignCosts([row], plans).calls[0]?.costUSD).toBeCloseTo(1.32, 9)
  })

  test("leaves a clock-rated plan on its recorded price", () => {
    // Go's allowance is denominated in the official price at the call's hour, so
    // repricing it at OpenDesign's card would double-count.
    const row = call({
      providerID: "opencode-go",
      costUSD: 0.753,
      tokensInput: 1_000_000,
      tokensOutput: 1_000_000,
      tokensCacheRead: 1_000_000,
    })
    const result = alignCosts([row], plans)
    expect(result.calls[0]?.costUSD).toBe(0.753)
    expect(result.adjustedUSD).toBe(0)
  })

  test("fills a zero on a clock-rated plan from its own rate", () => {
    // The known OpenCode gap: a completed call that reported no price at all.
    const row = call({ providerID: "opencode-go", costUSD: 0, tokensInput: 1_000_000 })
    const result = alignCosts([row], plans)
    expect(result.calls[0]?.costUSD).toBeCloseTo(0.15, 9)
    expect(result.adjustedUSD).toBeCloseTo(0.15, 9)
  })

  test("leaves a zero on a call that moved no tokens alone", () => {
    // An aborted or empty step genuinely cost nothing; repricing it would invent
    // spend out of a call that never ran.
    const row = call({ costUSD: 0 })
    const result = alignCosts([row], plans)
    expect(result.calls[0]?.costUSD).toBe(0)
    expect(result.adjustedUSD).toBe(0)
    expect(result.unpricedCalls).toBe(0)
  })

  test("leaves a null cost alone", () => {
    // Null means "never priced" (failed calls); only a reported price is priced.
    const row = call({ costUSD: null, tokensInput: 1_000_000 })
    const result = alignCosts([row], plans)
    expect(result.calls[0]?.costUSD).toBeNull()
    expect(result.adjustedUSD).toBe(0)
  })

  test("counts a call it cannot price rather than guessing", () => {
    const row = call({ costUSD: 0, modelID: "unlisted-model", tokensInput: 1_000 })
    const result = alignCosts([row], plans)
    expect(result.calls[0]?.costUSD).toBe(0)
    expect(result.adjustedUSD).toBe(0)
    expect(result.unpricedCalls).toBe(1)
  })

  test("does not flag a free model as unpriced", () => {
    // `-free` models are promotional and genuinely cost nothing, so their zero
    // is correct rather than a gap in the books.
    const row = call({ costUSD: 0, providerID: "opencode", modelID: "nemotron-3.5-super-vl-free", tokensInput: 5_000 })
    const result = alignCosts([row], plans)
    expect(result.unpricedCalls).toBe(0)
    expect(result.calls[0]?.costUSD).toBe(0)
  })

  test("is a no-op without a plans file", () => {
    const rows = [call({ costUSD: 0, tokensInput: 1_000_000 })]
    const result = alignCosts(rows, EMPTY_PLANS)
    expect(result.calls[0]?.costUSD).toBe(0)
    expect(result.adjustedUSD).toBe(0)
  })

  test("prices tokens whose cost was recorded as zero", () => {
    const result = alignCosts(
      [call({ costUSD: 0, tokensInput: 1_000_000, tokensOutput: 1_000_000 })],
      plans,
    )
    expect(result.adjustedUSD).toBeCloseTo(0.44 + 1.32, 9)
    expect(result.calls[0]?.costUSD).toBeCloseTo(0.44 + 1.32, 9)
  })
})
