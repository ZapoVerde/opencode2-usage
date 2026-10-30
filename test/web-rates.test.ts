import { describe, expect, test } from "bun:test"
import type { SessionRecord } from "../src/query"
import type { CallRow } from "../src/reducer"
import { parsePlans } from "../src/plans"
import { handleApi, type ApiResult, type WebSnapshot } from "../web/api"

const NOW = Date.parse("2026-10-28T12:00:00Z")
const HOUR = 3_600_000

const session: SessionRecord = {
  id: "ses_one",
  title: "Rates work",
  internal: false,
  costUSD: 0,
  tokensInput: 0,
  tokensOutput: 0,
  tokensReasoning: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  timeCreated: NOW - 24 * HOUR,
  timeUpdated: NOW,
}

function call(overrides: Partial<CallRow>): CallRow {
  return {
    callID: "call_one",
    assistantMessageID: "msg_one",
    sessionID: session.id,
    parentSessionID: null,
    kind: "step",
    agent: "build",
    // The recorded id, which is what the plan aliases to `opencode`.
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
    modelVariant: null,
    directory: "/work",
    startedAt: NOW - HOUR,
    firstTokenAt: NOW - HOUR,
    firstTextAt: NOW - HOUR,
    streamedAt: NOW - HOUR,
    endedAt: NOW,
    tokensInput: 1_000_000,
    tokensOutput: 0,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUSD: 0.15,
    finish: "stop",
    rawFinish: "stop",
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
    recordedAt: NOW,
    ...overrides,
  }
}

function snapshot(overrides: Partial<WebSnapshot> = {}): WebSnapshot {
  return {
    sidecarPath: "/data/usage.db",
    sidecarExists: true,
    calls: [],
    turns: [],
    sessionsPath: "/data/opencode.db",
    sessionsSource: "scan",
    sessionsExists: true,
    sessionsResolveError: null,
    sessions: [session],
    projects: [],
    sessionProjects: [],
    ...overrides,
  }
}

function api(query: string, data: WebSnapshot): ApiResult {
  return handleApi("/api/rates", new URLSearchParams(query), data, NOW)
}

/**
 * The real advertised table is used, so this also pins the shipped rates: the
 * provider ids below are the ones the dashboard actually publishes.
 */
const plans = parsePlans({
  providers: {
    "opencode-go": {
      terms: [{ from: "2026-10-01", monthlyUSD: 10 }],
      peak: { windows: ["01:00-04:00", "06:00-10:00"], days: [1, 2, 3, 4, 5] },
      peakModels: ["deepseek-v4.1-flash"],
      peakMultiplier: 2,
      rates: { "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
    },
  },
})

type RatesBody = {
  rows: Array<{
    providerID: string
    planLabel: string
    modelID: string
    feeUSD: number
    allowanceUSD: number
    basis: "clock" | "peak"
    offPeak: { blendedTokensPerDollar: number | null; blendedPerMillion: number | null }
    peak: { blendedTokensPerDollar: number | null; blendedPerMillion: number | null }
    calls: number
    source: string
  }>
  mix: { input: number; output: number; cacheRead: number } | null
  peakShare: number | null
  skipped: string[]
  planErrors: string[]
  plansPath: string | null
}

describe("/api/rates", () => {
  test("reports tokens per fee dollar on both sides of the clock", () => {
    const body = api(
      "since=7d&tz=UTC",
      snapshot({ plans, plansPath: "/data/usage-plans.json", calls: [call({})] }),
    ).body as RatesBody

    expect(body.planErrors).toEqual([])
    expect(body.plansPath).toBe("/data/usage-plans.json")
    expect(body.rows).toHaveLength(1)
    const row = body.rows[0]!
    // `opencode-go` records under the plan published as `opencode`, and its
    // `deepseek-flash` allowance is $80/month at official API prices.
    expect(row.providerID).toBe("opencode-go")
    expect(row.planLabel).toBe("OpenCode Go")
    expect(row.basis).toBe("clock")
    expect(row.allowanceUSD).toBe(80)
    expect(row.feeUSD).toBe(10)
    // 1M input tokens a call at your mix is all input, so the blended figure is
    // the input rate: $8 of usage per fee dollar over $0.15 per 1M tokens.
    expect(row.offPeak.blendedPerMillion).toBeCloseTo(0.15, 9)
    expect(row.offPeak.blendedTokensPerDollar).toBeCloseTo((80 / 10 / 0.15) * 1_000_000, 6)
    // Peak doubles DeepSeek's card, so the same fee buys half the tokens.
    expect(row.peak.blendedTokensPerDollar).toBeCloseTo(row.offPeak.blendedTokensPerDollar! / 2, 6)
  })

  test("measures the peak share from this window's spend", () => {
    const body = api(
      "since=7d&tz=UTC",
      snapshot({
        plans,
        calls: [
          // 2026-10-28T02:00Z is inside the 01:00-04:00 peak window.
          call({ callID: "peak", startedAt: Date.parse("2026-10-28T02:00:00Z"), costUSD: 3 }),
          call({ callID: "off", startedAt: Date.parse("2026-10-28T12:00:00Z"), costUSD: 1 }),
        ],
      }),
    ).body as RatesBody
    expect(body.peakShare).toBeCloseTo(0.75, 9)
  })

  test("names a provider it could not compare", () => {
    const body = api(
      "since=7d&tz=UTC",
      snapshot({
        plans,
        calls: [
          call({}),
          call({ callID: "b", providerID: "unpublished", modelID: "whatever", costUSD: 1 }),
        ],
      }),
    ).body as RatesBody
    expect(body.rows.map((row) => row.providerID)).toEqual(["opencode-go"])
    expect(body.skipped).toEqual(["unpublished"])
  })

  test("is served by a build that advertises the endpoint", () => {
    const meta = handleApi("/api/meta", new URLSearchParams("since=7d&tz=UTC"), snapshot(), NOW)
    const capabilities = (meta.body as { capabilities: string[] }).capabilities
    expect(capabilities).toContain("rates")
  })

  test("rejects a model filter that is not provider-qualified", () => {
    // The same validation the other views apply, so a bad filter cannot be
    // silently ignored here and honoured elsewhere.
    const result = api("since=7d&tz=UTC&model=deepseek-v4.1-flash", snapshot())
    expect(result.status).toBe(400)
    expect((result.body as { parameter?: string }).parameter).toBe("model")
  })
})
