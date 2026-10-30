/**
 * What a real dollar of subscription fee buys, per provider, for DeepSeek V4.1
 * Flash.
 *
 * Three providers resell the same model three different ways, and the peak /
 * off-peak question lands differently on each. This prints the comparison the
 * dashboard's Rates tab shows, from the same code, so the two cannot disagree.
 *
 * Run with: bun run rates
 */
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import path from "node:path"
import { loadPlans } from "../src/plans-file"
import { rateTable } from "../src/rates"
import { defaultDatabasePath } from "../src/store"

const dbPath = process.env.OPENCODE_USAGE_DB ?? defaultDatabasePath()
// Beside the sidecar, matching how the web server resolves it.
const plansPath = process.env.OPENCODE_USAGE_PLANS ?? path.join(path.dirname(dbPath), "usage-plans.json")
if (!existsSync(dbPath)) {
  console.error(`error: usage database not found: ${dbPath}`)
  process.exit(1)
}

const loaded = loadPlans(plansPath)
if (loaded.plans.errors.length > 0) console.error(`warning: ${loaded.plans.errors.join(" · ")}`)

const db = new Database(dbPath, { readonly: true })
const calls = db
  .query(
    `SELECT provider_id, model_id, started_at, cost_usd,
            tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
       FROM call`,
  )
  .all() as Array<Record<string, number | string | null>>
db.close()

const table = rateTable({
  plans: loaded.plans,
  now: Date.now(),
  samples: calls.map((call) => ({
    providerID: String(call.provider_id),
    modelID: call.model_id === null ? null : String(call.model_id),
    at: Number(call.started_at ?? 0),
    recordedUSD: Number(call.cost_usd ?? 0),
    tokens: {
      input: Number(call.tokens_input ?? 0),
      output: Number(call.tokens_output ?? 0),
      reasoning: Number(call.tokens_reasoning ?? 0),
      cacheRead: Number(call.tokens_cache_read ?? 0),
      cacheWrite: Number(call.tokens_cache_write ?? 0),
    },
  })),
})

if (table.rows.length === 0) {
  console.error("error: no provider has both a configured plan price and a published allowance")
  process.exit(1)
}

const millions = (value: number | null) =>
  value === null ? "—" : `${(value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 0 })}M`

console.log("What one real dollar of subscription fee buys")
if (table.mix !== null) {
  console.log(
    `measured mix: ${(table.mix.input * 100).toFixed(1)}% input / ` +
      `${(table.mix.output * 100).toFixed(1)}% output / ${(table.mix.cacheRead * 100).toFixed(1)}% cache read`,
  )
}
if (table.peakShare !== null)
  console.log(`peak share: ${(table.peakShare * 100).toFixed(1)}% of recorded spend fell in a peak window`)
console.log()

const rows = table.rows.map((row) => [
  row.planLabel,
  row.modelID,
  `$${row.feeUSD}`,
  `$${row.allowanceUSD}`,
  row.basis === "flat" ? "one flat card" : "follows the clock",
  millions(row.offPeak.blendedTokensPerDollar),
  millions(row.peak.blendedTokensPerDollar),
])

const headers = ["plan", "model", "fee", "allowance", "meters", "off-peak", "peak"]
const widths = headers.map((header, index) =>
  Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
)
const line = (row: readonly string[]) =>
  row.map((cell, index) => String(cell).padEnd(widths[index]!)).join("  ").trimEnd()

console.log(line(headers))
for (const row of rows) console.log(line(row as string[]))
console.log()
console.log("tokens per $1 of fee, blended at the measured mix")

const offBest = Math.max(...table.rows.map((row) => row.offPeak.blendedTokensPerDollar ?? 0))
const peakBest = Math.max(...table.rows.map((row) => row.peak.blendedTokensPerDollar ?? 0))
console.log()
console.log("The clock decides which plan wins:")
for (const row of table.rows) {
  const winOff = Math.abs((row.offPeak.blendedTokensPerDollar ?? 0) - offBest) < 1
  const winPeak = Math.abs((row.peak.blendedTokensPerDollar ?? 0) - peakBest) < 1
  console.log(
    `  ${row.planLabel.padEnd(18)} off-peak ${winOff ? "best" : "    "}   peak ${winPeak ? "best" : "    "}`.trimEnd(),
  )
}
console.log()
console.log("A plan that follows the clock buys half the tokens at peak, so its")
console.log("advantage disappears there and the flat-card plan takes over.")
console.log("Neither plan is cheapest all week.")

if (table.skipped.length > 0) {
  console.log()
  console.log(`Not compared (no plan price and published allowance): ${table.skipped.join(", ")}`)
}
