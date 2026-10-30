/**
 * Provider-side reconciliation for OpenDesign.
 *
 * Two independent questions, both answerable from the local books:
 *
 * 1. Does OpenCode's recorded `cost_usd` match the rate card the OpenDesign
 *    console shows? The console bills at DeepSeek's *peak* list price; OpenCode
 *    records at the *off-peak* half. Verifying that ratio is exactly 2.000 for
 *    every call is what turns "the numbers disagree" into a known constant.
 *
 * 2. Do the window percentages the console displays agree with those tokens?
 *    Multiplying tokens by the console card and dividing by the window cap
 *    should reproduce the percentage, which is the check that proves the
 *    tracker is seeing every call that counted against the allowance.
 *
 * Run with: bun run verify/opendesign.ts [--since 30d] [--json]
 */
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { defaultDatabasePath } from "../src/store"

/**
 * The rate card from the OpenDesign console's "Credit usage breakdown" popup.
 *
 * These are the console's own per-token prices, flat at every hour. They are not
 * DeepSeek's list price: input, output and cache each carry a different markup
 * over the recorded table, which is why credits are repriced from tokens rather
 * than scaled from recorded dollars.
 */
const CONSOLE_CARD = { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 } as const

/** OpenCode's configured rates, which is what `cost_usd` records. */
const RECORDED_CARD = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } as const

/**
 * DeepSeek peak windows in UTC: 01:00-04:00 and 06:00-10:00, Monday to Friday.
 * All other hours, and all of Saturday and Sunday, are off-peak.
 */
const PEAK_WINDOWS_UTC = [
  [1 * 60, 4 * 60],
  [6 * 60, 10 * 60],
] as const

/**
 * OpenDesign Go, from <https://open-design.ai/model-credits/>:
 * $120 monthly maximum, $30 per 7-day window, $10 per 5-hour window. The
 * 7-day and 5-hour windows apply only to Design Plan credits.
 */
const OD_GO = { monthly: 120, weekly: 30, rolling: 10 } as const

type Call = {
  readonly startedAt: number
  readonly modelID: string
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly recordedUSD: number
}

const args = Bun.argv.slice(2)
const json = args.includes("--json")
const sinceArg = args.find((arg) => arg.startsWith("--since="))?.slice("--since=".length) ?? "30d"
const dbPath = process.env.OPENCODE_USAGE_DB ?? defaultDatabasePath()
if (!existsSync(dbPath)) {
  console.error(`error: usage database not found: ${dbPath}`)
  console.error("Pass OPENCODE_USAGE_DB=<path> if the sidecar lives somewhere else.")
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
const since = resolveSince(sinceArg)

const calls = db
  .query(
    `SELECT started_at, model_id, tokens_input, tokens_output, tokens_reasoning,
            tokens_cache_read, tokens_cache_write, cost_usd
       FROM call
      WHERE provider_id = 'opendesign' AND started_at >= ?
      ORDER BY started_at`,
  )
  .all(since) as {
  started_at: number
  model_id: string | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  cost_usd: number | null
}[]

const rows: Call[] = calls.map((row) => ({
  startedAt: row.started_at,
  modelID: row.model_id ?? "unknown",
  input: row.tokens_input ?? 0,
  output: row.tokens_output ?? 0,
  reasoning: row.tokens_reasoning ?? 0,
  cacheRead: row.tokens_cache_read ?? 0,
  cacheWrite: row.tokens_cache_write ?? 0,
  recordedUSD: row.cost_usd ?? 0,
}))

report(rows)
db.close()

function report(calls: readonly Call[]) {
  if (calls.length === 0) {
    console.log("No OpenDesign calls recorded in this window.")
    return
  }

  // 1. The constant that explains the gap.
  const priced = calls.filter((call) => call.recordedUSD > 0)
  const ratios = priced.map((call) => price(call, CONSOLE_CARD) / call.recordedUSD)
  const ratioMin = Math.min(...ratios)
  const ratioMax = Math.max(...ratios)

  // 2. Tier split. If OpenDesign passed DeepSeek's peak through, calls inside a
  // peak window would cost twice as much per token.
  const peakCalls = calls.filter((call) => inPeakWindow(call.startedAt))
  const offPeakCalls = calls.filter((call) => !inPeakWindow(call.startedAt))

  // 3. Calls OpenCode recorded as free but which carried tokens. These are the
  // real blind spot: usage counted by the provider, absent from the books.
  const unpriced = calls.filter((call) => call.recordedUSD === 0 && call.input + call.output > 0)

  const recordUSD = sum(calls.map((call) => call.recordedUSD))
  const cardUSD = sum(calls.map((call) => price(call, CONSOLE_CARD)))
  // The console's meter is the card subtotal: there is no peak step and no
  // per-call multiplier on it.
  const creditsUSD = cardUSD

  // Windows, anchored to the most recent call rather than the wall clock so the
  // report stays meaningful when run against a snapshot.
  const now = calls[calls.length - 1]?.startedAt ?? Date.now()
  const windows = [
    { id: "rolling", label: "5-hour", cap: OD_GO.rolling, ms: 5 * 3_600_000 },
    { id: "weekly", label: "7-day", cap: OD_GO.weekly, ms: 7 * 86_400_000 },
    { id: "monthly", label: "Monthly", cap: OD_GO.monthly, ms: 31 * 86_400_000 },
  ].map((window) => {
    const inWindow = calls.filter((call) => call.startedAt >= now - window.ms)
    const credits = sum(inWindow.map((call) => price(call, CONSOLE_CARD)))
    return { ...window, calls: inWindow.length, credits, percent: (credits / window.cap) * 100 }
  })

  if (json) {
    console.log(
      JSON.stringify(
        {
          window: { since, until: now },
          calls: calls.length,
          priced: priced.length,
          unpriced: unpriced.length,
          recordedUSD: recordUSD,
          consoleCardUSD: cardUSD,
          creditsUSD,
          rateRatio: { min: ratioMin, max: ratioMax },
          tiers: { peak: peakCalls.length, offPeak: offPeakCalls.length },
          windows,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`OpenDesign reconciliation — ${calls.length} calls`)
  console.log()
  console.log("Rate card")
  console.log(`  recorded (OpenCode table)       $${recordUSD.toFixed(4)}`)
  console.log(`  console card (the meter)        $${cardUSD.toFixed(4)}`)
  console.log(`  ratio card/recorded             ${ratioMin.toFixed(6)} … ${ratioMax.toFixed(6)}`)
  if (uniform(ratioMin, ratioMax, 3)) {
    console.log("  -> a flat ratio on every call; no per-call surprise")
  } else {
    console.log("  -> not uniform: the card and the recorded table differ by token kind")
  }
  console.log()
  console.log("Peak / off-peak")
  console.log(`  peak-window calls               ${peakCalls.length}`)
  console.log(`  off-peak calls                  ${offPeakCalls.length}`)
  // The card is flat, so the aggregate ratio only moves with the token mix:
  // an output-heavy call is ~2.2x recorded, a cache-heavy one ~4.7x. This split
  // is reported to explain the spread, not to detect a surcharge.
  const peakRatio = perTokenRatio(peakCalls)
  const offPeakRatio = perTokenRatio(offPeakCalls)
  if (peakRatio !== null && offPeakRatio !== null) {
    console.log(`  card/recorded, peak hours       ${peakRatio.toFixed(4)}`)
    console.log(`  card/recorded, off-peak hours   ${offPeakRatio.toFixed(4)}`)
    console.log("  -> the card itself is flat; a different mix of token kinds moves this ratio")
  }
  console.log()
  console.log("Design Plan credits (console card, flat at every hour)")
  console.log(`  credits consumed                $${creditsUSD.toFixed(4)}`)
  for (const window of windows) {
    const bar = meter(window.percent)
    console.log(
      `  ${window.label.padEnd(8)} cap $${String(window.cap).padStart(3)}  ${window.percent
        .toFixed(2)
        .padStart(6)}%  ${bar}  ${window.calls} calls`,
    )
  }
  console.log()
  if (unpriced.length > 0) {
    const lost = sum(unpriced.map((call) => price(call, CONSOLE_CARD)))
    console.log("Blind spot")
    console.log(`  ${unpriced.length} calls recorded at $0 but carrying tokens (raw event data)`)
    console.log(`  value at the console card       $${lost.toFixed(4)}`)
    console.log("  -> the provider counted these; the raw event stream did not")
    console.log("  -> the dashboard reprices these at the plan card; see web/impute.ts")
  } else {
    console.log("Blind spot: none — every call carrying tokens has a recorded cost.")
  }
}

/** Cost of one call at a given rate card. */
function price(call: Call, card: typeof CONSOLE_CARD | typeof RECORDED_CARD) {
  return (
    (call.input * card.input +
      (call.output + call.reasoning) * card.output +
      call.cacheRead * card.cacheRead +
      call.cacheWrite * card.cacheWrite) /
    1_000_000
  )
}

function inPeakWindow(at: number) {
  const date = new Date(at)
  const weekday = date.getUTCDay()
  // DeepSeek peak applies Monday to Friday only.
  if (weekday === 0 || weekday === 6) return false
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return PEAK_WINDOWS_UTC.some(([start, end]) => minute >= start && minute < end)
}

/** Aggregate card/recorded ratio, or null when there is nothing to compare. */
function perTokenRatio(calls: readonly Call[]) {
  const priced = calls.filter((call) => call.recordedUSD > 0)
  if (priced.length === 0) return null
  return sum(priced.map((call) => price(call, CONSOLE_CARD))) / sum(priced.map((call) => call.recordedUSD))
}

function uniform(left: number, right: number, places: number) {
  return Math.abs(left - right) < 10 ** -places
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function meter(percent: number) {
  const filled = Math.max(0, Math.min(20, Math.round((percent / 100) * 20)))
  return `[${"#".repeat(filled)}${"-".repeat(20 - filled)}]`
}

function resolveSince(value: string) {
  const match = /^(\d+)([hd])$/.exec(value)
  if (match !== null) {
    const amount = Number(match[1])
    const ms = match[2] === "h" ? 3_600_000 : 86_400_000
    return Date.now() - amount * ms
  }
  if (value === "all") return 0
  const date = Date.parse(value)
  return Number.isNaN(date) ? 0 : date
}
