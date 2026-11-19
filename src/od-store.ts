/**
 * Where the OpenDesign session lives on disk.
 *
 * One JSON file beside the sidecar, mode 0600, holding only the cookies an
 * authenticated browser sent plus when they last worked. It is a live
 * credential, so it is written atomically (temp file + rename) and never logged.
 */

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { normaliseCookies, type OpenDesignSession } from "./od-session"

const FILE_NAME = "open-design-session.json"

/** `OPENCODE_USAGE_OD_SESSION` wins over a file beside the sidecar database. */
export function resolveSessionPath(sidecarPath: string) {
  const configured = process.env.OPENCODE_USAGE_OD_SESSION
  if (configured !== undefined && configured.length > 0) return configured
  return path.join(path.dirname(sidecarPath), FILE_NAME)
}

/**
 * Read the stored session, or null when there is none.
 *
 * A malformed file reads as "no session" rather than throwing: the dashboard
 * has to keep serving the other providers, and an unreadable credential file is
 * indistinguishable from never having connected.
 */
export function loadSession(file: string): OpenDesignSession | null {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const document = parsed as Record<string, unknown>
    const cookies = normaliseCookies(document.cookies ?? document)
    if (cookies.length === 0) return null
    return {
      cookies,
      confirmedAt: typeof document.confirmedAt === "number" ? document.confirmedAt : null,
      account: typeof document.account === "string" ? document.account : null,
    }
  } catch {
    return null
  }
}

export function saveSession(file: string, session: OpenDesignSession) {
  const document = JSON.stringify(
    { cookies: session.cookies, confirmedAt: session.confirmedAt, account: session.account },
    null,
    2,
  )
  // The rename is what makes a crash mid-write leave the previous session
  // intact; the chmod is what keeps the file private from the first instant.
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, document, { mode: 0o600 })
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // A filesystem without POSIX modes (Windows) keeps the default ACL.
  }
  renameSync(temporary, file)
}

/** Delete the stored session, so a disconnect is not just "stop looking". */
export function clearSession(file: string) {
  rmSync(file, { force: true })
}
