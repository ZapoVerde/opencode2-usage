import { describe, expect, test } from "bun:test"
import { parseConsoleBudgets, parseGoUsage, parseOpenAIUsage } from "../src/quotas"

describe("parseGoUsage", () => {
  test("reads every meter the Go API publishes", () => {
    const status = parseGoUsage({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-10-29T13:40:33.765Z" },
        weekly: { status: "ok", percent: 39, resetsAt: "2026-11-02T00:00:00.000Z" },
        monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-05T10:48:27.000Z" },
      },
    })
    expect(status.state).toBe("ok")
    if (status.state !== "ok") return
    expect(status.plan).toBe("Go")
    expect(status.windows.map((window) => window.id)).toEqual(["rolling", "weekly", "monthly"])
    expect(status.windows[0]?.label).toBe("5-hour")
    expect(status.windows[1]?.usedPercent).toBe(39)
    expect(status.windows[2]?.limited).toBe(true)
    expect(status.windows[1]?.resetsAt).toBe(Date.parse("2026-11-02T00:00:00.000Z"))
  })

  test("skips a meter the response omits", () => {
    const status = parseGoUsage({
      usage: { weekly: { status: "ok", percent: 10, resetsAt: "2026-11-02T00:00:00.000Z" } },
    })
    if (status.state !== "ok") throw new Error("expected ok")
    expect(status.windows.map((window) => window.id)).toEqual(["weekly"])
  })

  test("reports an error rather than throwing on a bad body", () => {
    expect(parseGoUsage(null).state).toBe("error")
    expect(parseGoUsage({}).state).toBe("error")
    expect(parseGoUsage({ usage: {} }).state).toBe("error")
    expect(parseGoUsage("nope").state).toBe("error")
  })

  test("clamps a percent outside 0-100", () => {
    const status = parseGoUsage({
      usage: { weekly: { status: "ok", percent: 140, resetsAt: "2026-11-02T00:00:00.000Z" } },
    })
    if (status.state !== "ok") throw new Error("expected ok")
    expect(status.windows[0]?.usedPercent).toBe(100)
  })
})

describe("parseConsoleBudgets", () => {
  test("reads spend caps", () => {
    const status = parseConsoleBudgets([
      {
        ruleID: "rule_1",
        limitDollars: 50,
        spentDollars: 12.5,
        scope: "workspace",
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    ])
    if (status.state !== "ok") throw new Error("expected ok")
    expect(status.budgets).toEqual([
      {
        id: "rule_1",
        label: "workspace",
        limitUSD: 50,
        spentUSD: 12.5,
        resetsAt: Date.parse("2026-11-01T00:00:00.000Z"),
      },
    ])
  })

  test("treats an empty workspace as ok with no budgets", () => {
    const status = parseConsoleBudgets([])
    expect(status.state).toBe("ok")
    if (status.state !== "ok") return
    expect(status.budgets).toEqual([])
  })

  test("drops a budget missing its amounts", () => {
    const status = parseConsoleBudgets([{ ruleID: "rule_1" }, { limitDollars: 5, spentDollars: 1 }])
    if (status.state !== "ok") throw new Error("expected ok")
    // The second entry has no ruleID but usable amounts, so it still counts.
    expect(status.budgets).toHaveLength(1)
    expect(status.budgets[0]?.limitUSD).toBe(5)
  })

  test("reports an error for a non-array body", () => {
    expect(parseConsoleBudgets({ budgets: [] }).state).toBe("error")
    expect(parseConsoleBudgets(null).state).toBe("error")
  })
})

describe("parseOpenAIUsage", () => {
  test("reads rate-limit windows, plan, and reset credits", () => {
    const status = parseOpenAIUsage({
      email: "someone@example.com",
      plan_type: "free",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 12.5, reset_at: 1795855250 },
        secondary_window: { used_percent: 3, reset_at: 1795855250 },
      },
      credits: { has_credits: true, balance: 4.25 },
      rate_limit_reset_credits: { available_count: 2 },
      spend_control: { reached: false },
    })
    if (status.state !== "ok") throw new Error("expected ok")
    expect(status.plan).toBe("free")
    expect(status.account).toBe("someone@example.com")
    expect(status.windows.map((window) => window.id)).toEqual(["primary", "secondary"])
    expect(status.windows[0]?.usedPercent).toBe(12.5)
    // Epoch seconds are widened to milliseconds.
    expect(status.windows[0]?.resetsAt).toBe(1795855250000)
    expect(status.notes).toContain("$4.25 in credits")
    expect(status.notes).toContain("2 reset credits")
  })

  test("omits a null secondary window", () => {
    const status = parseOpenAIUsage({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 0, reset_at: 1795855250 }, secondary_window: null },
    })
    if (status.state !== "ok") throw new Error("expected ok")
    expect(status.windows).toHaveLength(1)
    expect(status.notes).toEqual([])
  })

  test("marks a limited account", () => {
    const status = parseOpenAIUsage({
      plan_type: "free",
      rate_limit: { limit_reached: true, primary_window: { used_percent: 100, reset_at: 1795855250 } },
    })
    if (status.state !== "ok") throw new Error("expected ok")
    expect(status.windows[0]?.limited).toBe(true)
  })

  test("reports an error for a non-object body", () => {
    expect(parseOpenAIUsage(null).state).toBe("error")
    expect(parseOpenAIUsage([]).state).toBe("error")
  })
})
