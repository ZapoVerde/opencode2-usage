import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { migrateSchema } from "../src/store"

const root = path.join(import.meta.dir, "..")

describe("cli empty sidecar", () => {
  test("turns prints a clear message when the turn table is empty", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "oc2-usage-cli-"))
    try {
      const sidecarPath = path.join(directory, "usage.db")
      const sidecar = new Database(sidecarPath, { create: true })
      migrateSchema(sidecar)
      sidecar.close()

      const authoritativePath = path.join(directory, "opencode.db")
      const authoritative = new Database(authoritativePath, { create: true })
      authoritative.exec(`
        CREATE TABLE session_v2 (
          id TEXT PRIMARY KEY,
          title TEXT,
          metadata TEXT,
          cost REAL NOT NULL DEFAULT 0,
          tokens_input INTEGER NOT NULL DEFAULT 0,
          tokens_output INTEGER NOT NULL DEFAULT 0,
          tokens_reasoning INTEGER NOT NULL DEFAULT 0,
          tokens_cache_read INTEGER NOT NULL DEFAULT 0,
          tokens_cache_write INTEGER NOT NULL DEFAULT 0,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL
        )
      `)
      authoritative.close()

      const result = Bun.spawnSync(
        ["bun", "run", "cli.ts", "turns", "--db", sidecarPath, "--sessions-db", authoritativePath],
        { cwd: root },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain("no rounds recorded yet")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
