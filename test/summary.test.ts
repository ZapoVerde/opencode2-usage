import { describe, expect, test } from "bun:test"
import { summarize } from "../web/public/summary.js"

const base = {
  since: "24h",
  model: "",
  calls: 3006,
  costUSD: 5.3663,
  tokens: 15_700_000,
  ttftAvg: 8_500,
  ttftP95: 26_500,
  tps: 179.8,
  cacheHitRate: 0.98,
  rounds: 135,
  roundP50: 252_000,
  callErrorRate: 0,
  timeouts: 0,
  retries: 0,
}

// A plausible worst case: seven-figure volume, an hour of TTFT, and a
// 60-character provider/model name.
const busy = {
  ...base,
  since: "30d",
  calls: 12_345_678,
  costUSD: 1_234_567.8901,
  tokens: 1_234_567_890_123,
  ttftAvg: 3_600_000,
  ttftP95: 3_599_999,
  tps: 123_456.7,
  cacheHitRate: 1,
  rounds: 12_345_678,
  roundP50: 3_600_000,
  callErrorRate: 0.999,
  timeouts: 12_345_678,
  retries: 12_345_678,
}

function headerOf(text: string) {
  return text.split("\n")[0] ?? ""
}

function modelOfLength(length: number) {
  const prefix = "commandcode-v2/deepseek/"
  return prefix + "x".repeat(length - prefix.length)
}

describe("summarize", () => {
  test("reproduces the documented four-line summary", () => {
    const text = summarize({
      ...base,
      model: "commandcode/deepseek/deepseek-v4.1-flash",
      callErrorRate: 0.133,
    })
    expect(text).toBe(
      [
        "OpenCode usage — last 24h · commandcode/deepseek/deepseek-v4.1-flash",
        // Errors are counted over calls, so they belong on the calls line.
        "3,006 calls · $5.3663 · 15.7m tokens · 13.3% errored",
        "TTFT 8.5s avg (p95 26.5s) · 179.8 tok/s · 98.0% cached",
        "135 rounds · p50 4.2m",
      ].join("\n"),
    )
  })

  test("omits the model for all models and adds exactly one for a selected model", () => {
    expect(headerOf(summarize(base))).toBe("OpenCode usage — last 24h")

    const selected = summarize({ ...base, model: "commandcode/deepseek/deepseek-v4.1-flash" })
    const header = headerOf(selected)
    expect(header).toBe(
      "OpenCode usage — last 24h · commandcode/deepseek/deepseek-v4.1-flash",
    )
    expect(header.split(" · ")).toHaveLength(2)
    expect(header.match(/commandcode\/deepseek\/deepseek-v4\.1-flash/g)).toHaveLength(1)
  })

  test("renders zero values and drops missing values", () => {
    const zero = summarize({
      ...base,
      calls: 0,
      costUSD: 0,
      tokens: 0,
      ttftAvg: 0,
      ttftP95: 0,
      tps: 0,
      cacheHitRate: 0,
      rounds: 0,
      roundP50: 0,
      callErrorRate: 0,
      timeouts: 0,
      retries: 0,
    })
    expect(zero).toContain("0 calls · $0 · 0 tokens")
    expect(zero).toContain("TTFT 0ms avg (p95 0ms) · 0.0 tok/s · 0.00% cached")
    expect(zero).toContain("0 rounds · p50 0ms")
    expect(zero).not.toContain("errored")

    const tiny = summarize({ ...base, calls: 1, costUSD: 0.0004, tokens: 1_200_000 })
    expect(tiny).toContain("1 calls · <$0.001 · 1.2m tokens")

    const partial = summarize({
      since: "7d",
      model: "",
      calls: 12,
      costUSD: Number.NaN,
      tokens: undefined,
      ttftAvg: null,
      ttftP95: null,
      tps: 5,
      cacheHitRate: null,
      rounds: null,
      roundP50: undefined,
      callErrorRate: null,
      timeouts: Number.POSITIVE_INFINITY,
      retries: null,
    })
    expect(partial).toBe("OpenCode usage — last 7d\n12 calls\n5.0 tok/s")
    expect(partial).not.toMatch(/NaN|undefined|null| · —|— · /)
  })

  test("only adds errored, timeout, and retry suffixes when non-zero", () => {
    const quiet = summarize(base)
    expect(quiet.split("\n").at(-1)).toBe("135 rounds · p50 4.2m")
    expect(quiet).not.toContain("errored")
    expect(quiet).not.toContain("timeouts")
    expect(quiet).not.toContain("retries")

    const noisy = summarize({ ...base, callErrorRate: 0.13, timeouts: 2, retries: 4 })
    // The rate rides on the calls line; timeouts and retries stay on rounds.
    expect(noisy.split("\n")[1]).toBe("3,006 calls · $5.3663 · 15.7m tokens · 13.0% errored")
    expect(noisy.split("\n").at(-1)).toBe("135 rounds · p50 4.2m · 2 timeouts · 4 retries")
  })

  test("adds the error denominator only when the counts are usable", () => {
    const counted = summarize({
      ...base,
      calls: 133,
      callErrorRate: 19 / 133,
      failedCalls: 2,
      interruptedCalls: 17,
    })
    expect(counted.split("\n")[1]).toBe("133 calls · $5.3663 · 15.7m tokens · 14.3% errored (19/133)")

    const bare = summarize({ ...base, calls: 133, callErrorRate: 19 / 133 })
    expect(bare.split("\n")[1]).toBe("133 calls · $5.3663 · 15.7m tokens · 14.3% errored")

    const incomplete = summarize({
      ...base,
      calls: 133,
      callErrorRate: 19 / 133,
      failedCalls: 2,
    })
    expect(incomplete.split("\n")[1]).toBe("133 calls · $5.3663 · 15.7m tokens · 14.3% errored")

    // An empty window must not render "0/0".
    const emptyWindow = summarize({
      ...base,
      calls: 0,
      callErrorRate: 0.5,
      failedCalls: 1,
      interruptedCalls: 1,
    })
    expect(emptyWindow.split("\n")[1]).toBe("0 calls · $5.3663 · 15.7m tokens · 50.0% errored")
  })

  test("labels every window", () => {
    const labels: Array<[string, string]> = [
      ["24h", "last 24h"],
      ["7d", "last 7d"],
      ["30d", "last 30d"],
      ["90d", "last 90d"],
      ["all", "all time"],
      ["2026-10-01", "since 2026-10-01"],
    ]
    for (const [since, label] of labels) {
      expect(headerOf(summarize({ ...base, since }))).toBe(`OpenCode usage — ${label}`)
    }
  })

  test("keeps a realistic worst case with a 60-character model within 280 characters", () => {
    const model = "commandcode-v2/deepseek/deepseek-v4.1-flash-thinking-2026-x1"
    expect(model).toHaveLength(60)

    const text = summarize({ ...busy, model })
    expect(text.length).toBeLessThanOrEqual(280)
    expect(text).not.toContain("commandcode-v2/")
    expect(text).toContain("deepseek/deepseek-v4.1-flash-thinking-2026-x1")
    expect(text).toContain("p95")
    expect(text).toContain("99.9% errored")
  })

  test("degrades model, then p95, then the optional suffixes", () => {
    const prefixGone = summarize({ ...busy, model: modelOfLength(80) })
    expect(prefixGone.length).toBeLessThanOrEqual(280)
    expect(prefixGone).not.toContain("commandcode-v2/")
    expect(prefixGone).not.toContain("p95")
    expect(prefixGone).toContain("errored")
    expect(prefixGone).toContain("timeouts")
    expect(prefixGone).toContain("retries")

    const suffixesGone = summarize({ ...busy, model: modelOfLength(90) })
    expect(suffixesGone.length).toBeLessThanOrEqual(280)
    expect(suffixesGone).not.toContain("commandcode-v2/")
    expect(suffixesGone).not.toContain("p95")
    expect(suffixesGone).not.toContain("errored")
    expect(suffixesGone).not.toContain("timeouts")
    expect(suffixesGone).not.toContain("retries")

    expect(summarize({ ...busy, model: modelOfLength(200) }).length).toBeLessThanOrEqual(280)
  })
})
