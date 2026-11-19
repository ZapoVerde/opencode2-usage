import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { clearSession, loadSession, resolveSessionPath, saveSession } from "../src/od-store"

function directory() {
  return mkdtempSync(path.join(tmpdir(), "od-store-"))
}

const cookies = [{ name: "session", value: "abc", domain: "open-design.ai" }]

describe("resolveSessionPath", () => {
  test("sits beside the sidecar by default", () => {
    // A deployment that persists the sidecar directory keeps the session across
    // restarts without another variable to set.
    delete process.env.OPENCODE_USAGE_OD_SESSION
    expect(resolveSessionPath("/data/opencode/usage.db")).toBe("/data/opencode/open-design-session.json")
  })

  test("honours the override", () => {
    process.env.OPENCODE_USAGE_OD_SESSION = "/tmp/custom.json"
    try {
      expect(resolveSessionPath("/data/opencode/usage.db")).toBe("/tmp/custom.json")
    } finally {
      delete process.env.OPENCODE_USAGE_OD_SESSION
    }
  })
})

describe("session file", () => {
  test("round-trips the cookies and metadata", () => {
    const file = path.join(directory(), "od.json")
    saveSession(file, { cookies, confirmedAt: 1_700_000_000_000, account: "Jeremy" })
    expect(loadSession(file)).toEqual({ cookies, confirmedAt: 1_700_000_000_000, account: "Jeremy" })
  })

  test("writes the file readable only by its owner", () => {
    // The cookie is a live credential; a world-readable file beside the sidecar
    // would leak it to every process on the machine.
    const file = path.join(directory(), "od.json")
    saveSession(file, { cookies, confirmedAt: null, account: null })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("leaves no temporary file behind", () => {
    const dir = directory()
    const file = path.join(dir, "od.json")
    saveSession(file, { cookies, confirmedAt: null, account: null })
    expect(readFileSync(file, "utf8")).toContain("open-design.ai")
    expect(readdirSync(dir)).toEqual(["od.json"])
  })

  test("reads a malformed file as no session rather than throwing", () => {
    // A half-written or hand-edited file must not stop the dashboard loading the
    // providers that still work.
    const file = path.join(directory(), "od.json")
    writeFileSync(file, "{ not json")
    expect(loadSession(file)).toBeNull()
  })

  test("reads a file with no usable cookie as no session", () => {
    const file = path.join(directory(), "od.json")
    writeFileSync(file, JSON.stringify({ cookies: [] }))
    expect(loadSession(file)).toBeNull()
  })

  test("reads a file whose only cookie is for another host as no session", () => {
    const file = path.join(directory(), "od.json")
    writeFileSync(file, JSON.stringify({ cookies: [{ name: "a", value: "1", domain: "example.com" }] }))
    expect(loadSession(file)).toBeNull()
  })

  test("reads a missing file as no session", () => {
    expect(loadSession(path.join(directory(), "absent.json"))).toBeNull()
  })

  test("clear removes the file", () => {
    const file = path.join(directory(), "od.json")
    saveSession(file, { cookies, confirmedAt: null, account: null })
    clearSession(file)
    expect(loadSession(file)).toBeNull()
  })

  test("clearing an absent file is not an error", () => {
    expect(() => clearSession(path.join(directory(), "absent.json"))).not.toThrow()
  })
})
