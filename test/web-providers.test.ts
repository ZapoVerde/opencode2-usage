import { describe, expect, test } from "bun:test"
import type { SessionRecord } from "../src/query"
import type { CallRow } from "../src/reducer"
import { parsePlans } from "../src/plans"
import { handleApi, type ApiResult, type WebSnapshot } from "../web/api"

const NOW = Date.parse("2026-10-28T12:00:00Z")
const DAY = 86_400_000

const session: SessionRecord = {
  id: "ses_one",
  title: "Provider work",
  internal: false,
  costUSD: 0,
  tokensInput: 0,
  tokensOutput: 0,
  tokensReasoning: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  timeCreated: NOW - DAY,
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
    providerID: "acme",
    modelID: "model-a",
    modelVariant: null,
    directory: "/work",
    startedAt: NOW - 3_600_000,
    firstTokenAt: NOW - 3_599_000,
    firstTextAt: NOW - 3_599_000,
    streamedAt: NOW - 3_500_000,
    endedAt: NOW - 3_400_000,
    tokensInput: 1_000,
    tokensOutput: 100,
    tokensReasoning: 20,
    tokensCacheRead: 5_000,
    tokensCacheWrite: 0,
    costUSD: 0.25,
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
    recordedAt: NOW - 3_400_000,
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
  return handleApi("/api/providers", new URLSearchParams(query), data, NOW)
}

type ProvidersBody = {
  rows: Array<{
    providerID: string
    label: string | null
    calls: number
    sessions: number
    spendUSD: number
    paidDays: number
    recordedUSD: number
    meteredUSD: number | null
    valueRatio: number | null
    paid: { blended: number | null; input: number | null }
    metered: { blended: number | null }
    peak: { calls: number; listUSD: number | null; paid: { blended: number | null } }
    offPeak: { calls: number; listUSD: number | null; paid: { blended: number | null } }
    models: Array<{ modelID: string; calls: number; meteredUSD: number | null }>
  }>
  planErrors: string[]
  plansPath: string | null
}

const plans = parsePlans({
  providers: {
    acme: {
      terms: [{ from: "2026-10-01", monthlyUSD: 31 }],
      rates: { "model-a": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
    },
  },
})

describe("provider plan rollup", () => {
  test("groups calls by provider and prorates the fee", () => {
    const body = api(
      "since=7d&tz=UTC",
      snapshot({
        plans,
        plansPath: "/data/usage-plans.json",
        calls: [
          call({ callID: "a", providerID: "acme" }),
          call({ callID: "b", providerID: "other", modelID: "model-b", costUSD: 0.5 }),
        ],
      }),
    ).body as ProvidersBody

    expect(body.plansPath).toBe("/data/usage-plans.json")
    expect(body.planErrors).toEqual([])
    expect(body.rows.map((row) => row.providerID)).toEqual(["acme", "other"])

    const acme = body.rows[0]
    expect(acme?.label).toBeNull()
    expect(acme?.calls).toBe(1)
    expect(acme?.sessions).toBe(1)
    // Seven days of a 31-day, $31 plan.
    expect(acme?.spendUSD).toBeCloseTo(7, 6)
    expect(acme?.paidDays).toBe(7)
    // 1k input @ $1/M + (100 output + 20 reasoning) @ $2/M + 5k cache read @ $0.1/M.
    expect(acme?.meteredUSD).toBeCloseTo(0.00174, 8)
    expect(acme?.recordedUSD).toBeCloseTo(0.25, 8)
  })

  test("a provider without a plan reports zero spend and null rates", () => {
    const body = api(
      "since=7d&tz=UTC",
      snapshot({ plans, calls: [call({ providerID: "other", modelID: "model-b", costUSD: 0.5 })] }),
    ).body as ProvidersBody
    const other = body.rows[0]
    expect(other?.spendUSD).toBe(0)
    expect(other?.paidDays).toBe(0)
    expect(other?.valueRatio).toBeNull()
    expect(other?.paid.blended).toBeNull()
    // Recorded cost still gives a list-price figure and blended rate.
    expect(other?.meteredUSD).toBeCloseTo(0.5, 8)
    expect(other?.metered.blended).not.toBeNull()
  })

  test("orders providers by spend, then by list value", () => {
    const body = api(
      "since=7d&tz=UTC",
      snapshot({
        plans,
        calls: [call({ callID: "a", providerID: "acme" }), call({ callID: "b", providerID: "other", costUSD: 5 })],
      }),
    ).body as ProvidersBody
    expect(body.rows.map((row) => row.providerID)).toEqual(["acme", "other"])
  })

  test("respects the model filter", () => {
    const body = api(
      "since=7d&tz=UTC&model=acme/model-a",
      snapshot({ plans, calls: [call({ callID: "a" }), call({ callID: "b", modelID: "model-z" })] }),
    ).body as ProvidersBody
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]?.models.map((model) => model.modelID)).toEqual(["model-a"])
  })

  test("excludes internal-test sessions unless asked", () => {
    const hidden = api(
      "since=7d&tz=UTC",
      snapshot({
        plans,
        sessions: [{ ...session, internal: true }],
        calls: [call({})],
      }),
    ).body as ProvidersBody
    expect(hidden.rows).toHaveLength(0)

    const shown = api(
      "since=7d&tz=UTC&includeInternal=1",
      snapshot({ plans, sessions: [{ ...session, internal: true }], calls: [call({})] }),
    ).body as ProvidersBody
    expect(shown.rows).toHaveLength(1)
  })

  test("surfaces plan file errors without failing the request", () => {
    const body = api(
      "since=7d&tz=UTC",
      snapshot({ plans: { providers: new Map(), errors: ["plans.acme: nope"] }, calls: [call({})] }),
    ).body as ProvidersBody
    expect(body.planErrors).toEqual(["plans.acme: nope"])
    expect(body.rows).toHaveLength(1)
  })

  test("works without an authoritative database", () => {
    // Only the internal-test filter needs that database, so plan spend must not
    // disappear just because it is missing.
    const body = api(
      "since=7d&tz=UTC",
      snapshot({ plans, sessions: [], sessionsExists: false, calls: [call({})] }),
    ).body as ProvidersBody
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]?.spendUSD).toBeCloseTo(7, 6)
  })

  test("rejects an unknown parameter", () => {
    const result = api("since=7d&tz=UTC&bogus=1", snapshot())
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ error: 'unknown parameter "bogus"', parameter: "bogus" })
  })
})
