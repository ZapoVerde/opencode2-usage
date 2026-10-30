const MAX_LENGTH = 280
const MISSING = "—"
const WINDOW_LABELS = new Map([
  ["24h", "last 24h"],
  ["7d", "last 7d"],
  ["30d", "last 30d"],
  ["90d", "last 90d"],
  ["all", "all time"],
])

// Builds a tweet-sized summary from the same values that drive the KPI tiles.
// Missing values are dropped instead of rendered as a placeholder.
export function summarize(input) {
  const options = { dropProvider: false, p95: true, extras: true }
  let text = buildSummary(input, options)
  if (text.length <= MAX_LENGTH) return text

  if (hasProviderPrefix(input.model)) {
    options.dropProvider = true
    text = buildSummary(input, options)
    if (text.length <= MAX_LENGTH) return text
  }

  options.p95 = false
  text = buildSummary(input, options)
  if (text.length <= MAX_LENGTH) return text

  options.extras = false
  text = buildSummary(input, options)
  return text.length <= MAX_LENGTH ? text : text.slice(0, MAX_LENGTH)
}

function buildSummary(input, options) {
  return [
    headerLine(input, options),
    callsLine(input, options),
    latencyLine(input, options),
    roundsLine(input, options),
  ]
    .filter((line) => line.length > 0)
    .join("\n")
}

function headerLine(input, options) {
  const window = windowLabel(input.since)
  const model = modelLabel(input.model, options.dropProvider)
  const header = window.length > 0 ? `OpenCode usage — ${window}` : "OpenCode usage"
  return model === null ? header : `${header} · ${model}`
}

function windowLabel(since) {
  if (typeof since !== "string") return ""
  const known = WINDOW_LABELS.get(since)
  if (known !== undefined) return known
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) return `since ${since}`
  return ""
}

function modelLabel(model, dropProvider) {
  if (typeof model !== "string") return null
  const value = model.trim()
  if (value.length === 0) return null
  if (!dropProvider) return value
  return value.slice(value.indexOf("/") + 1)
}

function hasProviderPrefix(model) {
  return typeof model === "string" && model.trim().indexOf("/") > 0
}

function callsLine(input, options) {
  const calls = formatValue(input.calls, formatInt)
  const cost = formatValue(input.costUSD, formatCost)
  const tokens = formatValue(input.tokens, formatTokens)
  // Errors sit on the calls line because that is what they are counted over. A
  // round groups several calls and only fails when all of them give up, so a
  // per-round rate hid the individual calls that did error.
  const errored = options.extras ? erroredSegment(input) : null
  return joinSegments([
    calls === null ? null : `${calls} calls`,
    cost,
    tokens === null ? null : `${tokens} tokens`,
    errored,
  ])
}

function latencyLine(input, options) {
  const avg = formatValue(input.ttftAvg, formatDuration)
  const p95 = options.p95 ? formatValue(input.ttftP95, formatDuration) : null
  const tps = formatValue(input.tps, formatTPS)
  const cache = formatValue(input.cacheHitRate, formatPercent)
  return joinSegments([
    ttftSegment(avg, p95),
    tps === null ? null : `${tps} tok/s`,
    cache === null ? null : `${cache} cached`,
  ])
}

function ttftSegment(avg, p95) {
  if (avg !== null && p95 !== null) return `TTFT ${avg} avg (p95 ${p95})`
  if (avg !== null) return `TTFT ${avg} avg`
  if (p95 !== null) return `TTFT p95 ${p95}`
  return null
}

function roundsLine(input, options) {
  const rounds = formatValue(input.rounds, formatInt)
  const p50 = formatValue(input.roundP50, formatDuration)
  const segments = [rounds === null ? null : `${rounds} rounds`, p50 === null ? null : `p50 ${p50}`]
  if (options.extras) {
    const timeouts = positive(input.timeouts)
    const retries = positive(input.retries)
    if (timeouts !== null) segments.push(`${formatInt(timeouts)} timeouts`)
    if (retries !== null) segments.push(`${formatInt(retries)} retries`)
  }
  return joinSegments(segments)
}

// The parenthetical denominator is optional: callers that only know the rate
// still get a bare percentage, and an empty window never reports "0/0".
function erroredSegment(input) {
  const errorRate = positive(input.callErrorRate)
  if (errorRate === null) return null
  const label = `${formatPercent(errorRate)} errored`
  const total = formatValue(input.calls, formatInt)
  const failed = countValue(input.failedCalls)
  const interrupted = countValue(input.interruptedCalls)
  if (total === null || total === "0" || failed === null || interrupted === null) return label
  return `${label} (${formatInt(failed + interrupted)}/${total})`
}

function countValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

function joinSegments(segments) {
  return segments.filter((segment) => segment !== null).join(" · ")
}

// Accepts raw numbers, or strings that are already formatted. A placeholder
// string counts as missing so the caller can pass formatter output directly.
function formatValue(value, formatter) {
  if (typeof value === "number") return Number.isFinite(value) ? formatter(value) : null
  if (typeof value === "string") {
    const text = value.trim()
    if (text.length === 0 || text === MISSING) return null
    return text
  }
  return null
}

export function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING
  const units = [
    [1_000_000_000, "b"],
    [1_000_000, "m"],
    [1_000, "k"],
  ]
  const unit = units.find(([size]) => Math.abs(value) >= size)
  if (unit === undefined) return String(Math.round(value))
  const scaled = value / unit[0]
  const text = Math.abs(scaled) >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)
  return `${text.replace(/\.0$/, "")}${unit[1]}`
}

export function formatCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING
  if (value === 0) return "$0"
  if (Math.abs(value) < 0.001) return "<$0.001"
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
}

export function formatDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING
  const milliseconds = Math.max(0, value)
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`
  if (milliseconds < 3_600_000) return `${(milliseconds / 60_000).toFixed(1)}m`
  return `${(milliseconds / 3_600_000).toFixed(1)}h`
}

export function formatTPS(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING
  return value.toFixed(1)
}

export function formatInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING
  return Math.round(value).toLocaleString("en-US")
}

export function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING
  const percentage = value * 100
  return `${percentage >= 10 ? percentage.toFixed(1) : percentage.toFixed(2)}%`
}
