import { readFileSync, statSync } from "node:fs"
import { EMPTY_PLANS, parsePlans, type Plans } from "./plans"

/**
 * Read `usage-plans.json` without ever throwing.
 *
 * The web server is read-only and must keep serving even when the file is
 * missing, malformed, or being edited. A failed read returns the last good
 * document (or empty plans) and the parse errors travel to `/api/meta` so the
 * dashboard can say what is wrong instead of silently showing zero spend.
 */
export function loadPlans(file: string | null): { readonly plans: Plans; readonly path: string | null } {
  if (file === null) return { plans: EMPTY_PLANS, path: null }
  let signature: string
  try {
    const info = statSync(file)
    signature = `${info.mtimeMs}:${info.size}`
  } catch {
    return { plans: EMPTY_PLANS, path: file }
  }
  const cached = cache.get(file)
  if (cached !== undefined && cached.signature === signature) return { plans: cached.plans, path: file }

  const plans = readPlans(file)
  cache.set(file, { signature, plans })
  return { plans, path: file }
}

const cache = new Map<string, { signature: string; plans: Plans }>()

function readPlans(file: string): Plans {
  try {
    return parsePlans(JSON.parse(readFileSync(file, "utf8")))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { providers: new Map(), errors: [`plans: ${message}`] }
  }
}
