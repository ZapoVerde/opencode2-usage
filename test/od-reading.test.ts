import { describe, expect, test } from "bun:test"
import { readOpenDesign } from "../src/od-source"
import type { StoredCookie } from "../src/od-session"

/**
 * The reading path against a local stand-in for the console.
 *
 * This is the part that has to be right in ways a pure parser cannot prove: the
 * workspace id from one call scopes the next, a rejected cookie is an error
 * rather than an empty list, and a rotated session is handed back so it can be
 * stored.
 */

const cookies: readonly StoredCookie[] = [{ name: "session", value: "abc", domain: "open-design.ai" }]

const CONTEXT = {
  workspaceId: "wrk_1",
  workspaceName: "Jeremy",
  workspaceType: "personal",
  workspaceMemberId: "mem_1",
  personalMembershipTier: "go",
}

const USAGE = {
  workspaceId: "wrk_1",
  eligible: true,
  tier: "go",
  windows: [
    { durationSeconds: 18_000, usedCredits: "4.5", limitCredits: "18", remainingCredits: "13.5", resetsAt: "2026-11-12T05:00:00.000Z" },
    { durationSeconds: 604_800, usedCredits: "11", limitCredits: "55", remainingCredits: "44", resetsAt: "2026-11-19T00:00:00.000Z" },
  ],
}

/** Start a stand-in console and return its API origin plus what it saw. */
function console(options: {
  readonly usage?: unknown
  readonly status?: number
  readonly setCookie?: string
}) {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      seen.push(url.pathname)
      if (options.status !== undefined) return new Response("{}", { status: options.status })
      const headers = new Headers({ "content-type": "application/json" })
      if (options.setCookie !== undefined) headers.append("set-cookie", options.setCookie)
      if (url.pathname === "/v1/workspaces/current")
        return new Response(JSON.stringify(CONTEXT), { headers })
      if (url.pathname === "/v1/workspaces/wrk_1/billing/coding-plan-usage")
        return new Response(JSON.stringify(options.usage ?? USAGE), { headers })
      if (url.pathname === "/v1/workspaces/wrk_1/wallet/balance")
        return new Response(JSON.stringify({ balanceUsd: "0.00" }), { headers })
      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers })
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => server.stop(true),
  }
}

describe("readOpenDesign", () => {
  test("reads the windows and scopes the usage call to the workspace", async () => {
    const fake = console({})
    try {
      const reading = await readOpenDesign(cookies, fake.base)
      expect(reading.status.state).toBe("ok")
      if (reading.status.state !== "ok") return
      expect(reading.status.account).toBe("Jeremy")
      expect(reading.status.plan).toBe("Go")
      expect(reading.status.windows).toHaveLength(2)
      expect(reading.status.windows[0]).toMatchObject({ id: "rolling", usedPercent: 25 })
      expect(reading.status.windows[1]).toMatchObject({ id: "weekly", usedPercent: 20 })
      // The workspace id from the first call is what the second is scoped to; a
      // hardcoded or missing id would 404 above.
      expect(fake.seen).toContain("/v1/workspaces/wrk_1/billing/coding-plan-usage")
      // A zero balance is not a note worth showing.
      expect(reading.status.notes).toEqual([])
    } finally {
      fake.stop()
    }
  })

  test("does not call anything without a cookie", async () => {
    const fake = console({})
    try {
      const reading = await readOpenDesign([], fake.base)
      expect(reading.status.state).toBe("missing")
      expect(fake.seen).toEqual([])
    } finally {
      fake.stop()
    }
  })

  test("reports a rejected session as an error, not as no usage", async () => {
    const fake = console({ status: 401 })
    try {
      const reading = await readOpenDesign(cookies, fake.base)
      expect(reading.status.state).toBe("error")
      if (reading.status.state !== "error") return
      expect(reading.status.reason).toMatch(/rejected/i)
    } finally {
      fake.stop()
    }
  })

  test("names the failing path on an unexpected status", async () => {
    const fake = console({ status: 500 })
    try {
      const reading = await readOpenDesign(cookies, fake.base)
      expect(reading.status.state).toBe("error")
      if (reading.status.state !== "error") return
      expect(reading.status.reason).toContain("500")
      expect(reading.status.reason).toContain("/v1/workspaces/current")
    } finally {
      fake.stop()
    }
  })

  test("hands back a rotated cookie so it can be stored", async () => {
    const fake = console({ setCookie: "session=rotated; Path=/; HttpOnly" })
    try {
      const reading = await readOpenDesign(cookies, fake.base)
      expect(reading.status.state).toBe("ok")
      expect(reading.rotated).toEqual([{ name: "session", value: "rotated", domain: "open-design.ai" }])
    } finally {
      fake.stop()
    }
  })

  test("reports no rotation when the response sets nothing", async () => {
    const fake = console({})
    try {
      expect((await readOpenDesign(cookies, fake.base)).rotated).toBeNull()
    } finally {
      fake.stop()
    }
  })

  test("treats a non-personal workspace with no windows as answered, not failed", async () => {
    const fake = console({ usage: { workspaceId: "wrk_1", eligible: true, tier: "free", windows: [] } })
    try {
      const reading = await readOpenDesign(cookies, fake.base)
      expect(reading.status.state).toBe("ok")
      if (reading.status.state !== "ok") return
      expect(reading.status.windows).toEqual([])
      expect(reading.status.notes[0]).toMatch(/no design plan credits/i)
    } finally {
      fake.stop()
    }
  })

  test("fails when a paid workspace answers with no windows", async () => {
    // A paid tier with an empty window list means the shape changed, not that
    // the allowance is unlimited.
    const fake = console({ usage: { workspaceId: "wrk_1", eligible: true, tier: "go", windows: [] } })
    try {
      const reading = await readOpenDesign(cookies, fake.base)
      expect(reading.status.state).toBe("error")
    } finally {
      fake.stop()
    }
  })

  test("reports an unreachable host rather than throwing", async () => {
    // Port 1 is reserved and refuses immediately on Linux and macOS.
    const reading = await readOpenDesign(cookies, "http://127.0.0.1:1")
    expect(reading.status.state).toBe("error")
    if (reading.status.state !== "error") return
    expect(reading.status.reason).toMatch(/could not be reached/i)
  })
})
