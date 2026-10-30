import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import {
  isInternalMetadata,
  readCredentials,
  selectAuthoritativeDatabase,
  type DatabaseCandidate,
} from "../src/read"

const dataDirectory = path.join("/home", "user", ".local", "share", "opencode")

function candidate(name: string, mtimeMs: number): DatabaseCandidate {
  return { path: path.join(dataDirectory, name), mtimeMs }
}

describe("internal metadata", () => {
  test("only a boolean true marks a session internal", () => {
    expect(isInternalMetadata('{"oc2InternalTest":true}')).toBe(true)
    expect(isInternalMetadata('{"oc2InternalTest":false}')).toBe(false)
    expect(isInternalMetadata('{"oc2InternalTest":"true"}')).toBe(false)
    expect(isInternalMetadata('{"oc2InternalTest":1}')).toBe(false)
  })

  test("missing, null, and malformed metadata stay non-internal", () => {
    expect(isInternalMetadata(undefined)).toBe(false)
    expect(isInternalMetadata(null)).toBe(false)
    expect(isInternalMetadata("")).toBe(false)
    expect(isInternalMetadata("not json")).toBe(false)
    expect(isInternalMetadata("true")).toBe(false)
    expect(isInternalMetadata("[]")).toBe(false)
  })
})

describe("authoritative database selection", () => {
  test("the explicit flag wins over the environment and scanning", () => {
    const result = selectAuthoritativeDatabase({
      dataDirectory,
      candidates: [candidate("opencode-local.db", 900)],
      explicitPath: "/custom/explicit.db",
      envPath: "/env/override.db",
    })
    expect(result).toEqual({ ok: true, path: "/custom/explicit.db", source: "flag" })
  })

  test("the environment wins over scanning", () => {
    const result = selectAuthoritativeDatabase({
      dataDirectory,
      candidates: [candidate("opencode-local.db", 900)],
      envPath: "/env/override.db",
    })
    expect(result).toEqual({ ok: true, path: "/env/override.db", source: "env" })
  })

  test("an absolute OPENCODE_DB is used unchanged", () => {
    const result = selectAuthoritativeDatabase({
      dataDirectory,
      candidates: [],
      envPath: "/opencode2-state/data/opencode/opencode-local.db",
    })
    expect(result).toEqual({ ok: true, path: "/opencode2-state/data/opencode/opencode-local.db", source: "env" })
  })

  test("a relative OPENCODE_DB resolves under the data directory", () => {
    const result = selectAuthoritativeDatabase({
      dataDirectory,
      candidates: [],
      envPath: "opencode-local.db",
    })
    expect(result).toEqual({
      ok: true,
      path: path.join(dataDirectory, "opencode-local.db"),
      source: "env",
    })
  })

  test("scanning ignores usage.db and WAL sidecars, then picks the newest", () => {
    const result = selectAuthoritativeDatabase({
      dataDirectory,
      candidates: [
        candidate("usage.db", 1_000),
        candidate("usage.db-wal", 1_000),
        candidate("opencode-local.db-wal", 900),
        candidate("opencode-local.db-shm", 900),
        candidate("opencode.db", 100),
        candidate("opencode-local.db", 200),
      ],
    })
    expect(result).toEqual({
      ok: true,
      path: path.join(dataDirectory, "opencode-local.db"),
      source: "scan",
    })
  })

  test("scanning picks opencode.db when it is genuinely the newest", () => {
    const result = selectAuthoritativeDatabase({
      dataDirectory,
      candidates: [candidate("opencode-local.db", 200), candidate("opencode.db", 300)],
    })
    expect(result).toEqual({
      ok: true,
      path: path.join(dataDirectory, "opencode.db"),
      source: "scan",
    })
  })

  test("an empty directory errors with the data directory in the message", () => {
    const result = selectAuthoritativeDatabase({ dataDirectory, candidates: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(dataDirectory)
    expect(result.message).toContain("--sessions-db")
  })

  test("a directory with only ignored files errors instead of choosing one", () => {
    const result = selectAuthoritativeDatabase({
      dataDirectory,
      candidates: [candidate("usage.db", 900), candidate("opencode-local.db-wal", 950)],
    })
    expect(result.ok).toBe(false)
  })
})

describe("credential reading", () => {
  function database() {
    const db = new Database(":memory:")
    db.run(`CREATE TABLE credential (
      id TEXT PRIMARY KEY,
      integration_id TEXT,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      connector_id TEXT,
      method_id TEXT,
      active INTEGER
    )`)
    return db
  }

  test("reads key and oauth credentials with their metadata", () => {
    const db = database()
    db.run("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?)", [
      "cred_key",
      "acme",
      "Acme",
      JSON.stringify({ type: "key", key: "sk-1", metadata: { orgID: "wrk_1" } }),
      1,
    ])
    db.run("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?)", [
      "cred_oauth",
      "other",
      "Other",
      JSON.stringify({ type: "oauth", access: "at-1", refresh: "rt-1", metadata: { email: "a@b.c" } }),
      1,
    ])
    const rows = readCredentials(db)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ integrationID: "acme", active: true, value: { type: "key", key: "sk-1" } })
    expect(rows[1]).toMatchObject({ value: { type: "oauth", access: "at-1" } })
    expect(rows[0]?.metadata).toEqual({ orgID: "wrk_1" })
    db.close()
  })

  test("marks a credential inactive when the column is not 1", () => {
    const db = database()
    db.run("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?)", [
      "cred_old",
      "acme",
      "Old",
      JSON.stringify({ type: "key", key: "sk-old" }),
      0,
    ])
    expect(readCredentials(db)[0]?.active).toBe(false)
    db.close()
  })

  test("drops a credential whose value cannot be read", () => {
    const db = database()
    for (const [id, value] of [
      ["cred_bad_json", "not json"],
      ["cred_unknown_type", JSON.stringify({ type: "mystery" })],
      ["cred_no_key", JSON.stringify({ type: "key" })],
      ["cred_external", JSON.stringify({ type: "external" })],
    ] as const)
      db.run("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1)", [id, "acme", id, value])
    const rows = readCredentials(db)
    // `external` is a valid type with no secret, so it survives; the three
    // malformed rows do not.
    expect(rows.map((row) => row.id)).toEqual(["cred_external"])
    expect(rows[0]?.value).toEqual({ type: "external" })
    db.close()
  })

  test("defaults missing metadata to an empty object", () => {
    const db = database()
    db.run("INSERT INTO credential VALUES ('cred_one', 'acme', 'Acme', ?, NULL, NULL, 1)", [
      JSON.stringify({ type: "key", key: "sk-1" }),
    ])
    expect(readCredentials(db)[0]?.metadata).toEqual({})
    db.close()
  })
})
