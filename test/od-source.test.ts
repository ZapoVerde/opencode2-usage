import { describe, expect, test } from "bun:test"
import { parseContext, parsePlan, parseWindows } from "../src/od-source"

/**
 * These shapes are the console's own, taken from its bundle:
 *
 * - `GET /v1/workspaces/current` → the workspace object, with the membership
 *   tier rather than the plan tier.
 * - `GET /v1/workspaces/:id/billing/coding-plan-usage` → `{ tier, eligible,
 *   windows: [{ durationSeconds, usedCredits, limitCredits, remainingCredits,
 *   resetsAt }] }`, where the credits are decimal strings.
 * - The billing snapshot labels the same two windows by `kind`: `5h` and `7d`.
 *
 * They are undocumented, so pinning them means a rename surfaces as a failing
 * test rather than as a dashboard that quietly shows no usage.
 */

describe("parseContext", () => {
  test("reads the workspace object from workspaces/current", () => {
    const context = parseContext({
      workspaceId: "wrk_1",
      workspaceName: "Jeremy",
      workspaceType: "personal",
      workspaceMemberId: "mem_1",
      role: "owner",
      personalMembershipTier: "go",
    })
    expect(context).toEqual({ workspaceID: "wrk_1", account: "Jeremy", plan: "Go" })
  })

  test("reads a workspace nested under a key", () => {
    const context = parseContext({ workspace: { id: "wrk_2", name: "Studio" } })
    expect(context?.workspaceID).toBe("wrk_2")
    expect(context?.account).toBe("Studio")
    expect(context?.plan).toBeNull()
  })

  test("falls back to planId", () => {
    expect(parseContext({ workspaceId: "w", planId: "pro" })?.plan).toBe("Pro")
  })

  test("returns null when there is no workspace id", () => {
    expect(parseContext({})).toBeNull()
    expect(parseContext(null)).toBeNull()
    expect(parseContext("nope")).toBeNull()
  })
})

describe("parsePlan", () => {
  test("reads the tier the coding-plan response reports", () => {
    expect(parsePlan({ tier: "go" })).toBe("Go")
    expect(parsePlan({ tier: null })).toBeNull()
    expect(parsePlan({})).toBeNull()
  })
})

describe("parseWindows", () => {
  const now = Date.parse("2026-11-12T00:00:00.000Z")

  test("computes the used percentage from the credits", () => {
    const windows = parseWindows({
      tier: "go",
      eligible: true,
      windows: [
        {
          durationSeconds: 18_000,
          usedCredits: "4.5",
          limitCredits: "18",
          remainingCredits: "13.5",
          resetsAt: "2026-11-12T05:00:00.000Z",
        },
        {
          durationSeconds: 604_800,
          usedCredits: "55",
          limitCredits: "55",
          remainingCredits: "0",
          resetsAt: "2026-11-19T00:00:00.000Z",
        },
      ],
    })
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({ id: "rolling", label: "5-hour", usedPercent: 25, limited: false })
    // An exhausted window is marked limited, which is what stops a request.
    expect(windows[1]).toMatchObject({ id: "weekly", label: "7-day", usedPercent: 100, limited: true })
    expect(windows[0]?.resetsAt).toBe(Date.parse("2026-11-12T05:00:00.000Z"))
    expect(windows[0]?.resetsAt).toBeGreaterThan(now)
  })

  test("reads the snapshot's kind-labelled windows", () => {
    // `designPlanWindows` on the billing snapshot uses `kind` instead.
    const windows = parseWindows({
      designPlanWindows: undefined,
      windows: [
        { kind: "7d", limitCredits: "55", remainingCredits: "44" },
        { kind: "5h", limitCredits: "18", remainingCredits: "9" },
      ],
    })
    expect(windows.map((window) => window.id)).toEqual(["rolling", "weekly"])
    expect(windows[0]?.usedPercent).toBe(50)
  })

  test("orders the 5-hour window first regardless of response order", () => {
    const windows = parseWindows([
      { durationSeconds: 604_800, limitCredits: 55, remainingCredits: 40 },
      { durationSeconds: 18_000, limitCredits: 18, remainingCredits: 9 },
    ])
    expect(windows.map((window) => window.id)).toEqual(["rolling", "weekly"])
  })

  test("skips a window with no limit rather than dividing by zero", () => {
    const windows = parseWindows({
      windows: [
        { durationSeconds: 18_000, limitCredits: "0", remainingCredits: "0" },
        { durationSeconds: 604_800, limitCredits: "55", remainingCredits: "55" },
      ],
    })
    expect(windows.map((window) => window.id)).toEqual(["weekly"])
  })

  test("skips a duration the plan does not enforce", () => {
    // A monthly window would be a different product; showing it next to the
    // 5-hour and 7-day caps would misstate which one blocks a request.
    const windows = parseWindows({
      windows: [{ durationSeconds: 2_592_000, limitCredits: "100", remainingCredits: "1" }],
    })
    expect(windows).toEqual([])
  })

  test("accepts a bare array and plain numbers", () => {
    const windows = parseWindows([{ durationSeconds: 18_000, limitCredits: 18, remainingCredits: 4.5 }])
    expect(windows[0]?.usedPercent).toBe(75)
  })

  test("prefers the used figure when both are present", () => {
    // The two must agree; if a response ever carried a stale remainder, the used
    // figure is the one the console displays.
    const windows = parseWindows([
      { durationSeconds: 18_000, usedCredits: "9", limitCredits: "18", remainingCredits: "17" },
    ])
    expect(windows[0]?.usedPercent).toBe(50)
  })

  test("clamps a percentage into 0-100", () => {
    const over = parseWindows({ windows: [{ durationSeconds: 18_000, limitCredits: "18", remainingCredits: "-1" }] })
    expect(over[0]?.usedPercent).toBe(100)
    const under = parseWindows({ windows: [{ durationSeconds: 18_000, limitCredits: "18", remainingCredits: "20" }] })
    expect(under[0]?.usedPercent).toBe(0)
  })

  test("returns nothing for a malformed body instead of throwing", () => {
    expect(parseWindows(null)).toEqual([])
    expect(parseWindows({})).toEqual([])
    expect(parseWindows({ windows: "nope" })).toEqual([])
    expect(parseWindows({ windows: [null, 3, "x"] })).toEqual([])
  })
})
