import { summarize } from "./summary.js"

const SINCE_VALUES = ["24h", "7d", "30d", "90d", "all"]
const SESSION_SORTS = ["updated", "cost", "tokens", "ttft", "tps"]
const CALL_SORTS = ["started", "cost", "ttft", "tps"]
const TURN_SORTS = ["started", "round", "cost", "calls"]
const TURN_STATUSES = ["running", "stale", "completed", "failed", "interrupted"]
const ERROR_SOURCES = ["all", "call", "turn"]
const DIRECTIONS = ["asc", "desc"]
const GRANULARITIES = ["hour", "day", "week", "month"]
const PIVOT_BYS = ["model", "agent", "session", "project"]
const PIVOT_METRICS = ["cost", "calls", "tokens"]
const HEATMAP_METRICS = ["calls", "cost"]
const VIEWS = ["usage", "providers", "rates"]
// Routes each view calls, so a build missing one only loses the views that need
// it. Checking the union instead would lock you out of the Usage page because a
// newer tab is unavailable on an older server.
const VIEW_ENDPOINTS = {
  usage: ["overview", "sessions", "calls", "turns", "errors", "pivot", "heatmap"],
  providers: ["providers", "quotas"],
  rates: ["rates"],
}
const RESTART_HINT = "Restart it (bun run web, or docker restart opencode2-usage) to load the current version."
const STALE_SERVER = `The dashboard server is out of date and does not serve this view. ${RESTART_HINT}`
const PAGE_SIZE = 50
const ROUNDS_PAGE_SIZE = 50
const SESSIONS_LIMIT = 500
const CONTROLS_STORAGE_KEY = "opencode.usage.controls"
// Pivot columns hash into this palette, drawn from the dashboard's CSS colours.
const PIVOT_PALETTE = [
  "#6ea8fe",
  "#4f8cff",
  "#34d399",
  "#a78bfa",
  "#f59e0b",
  "#f87171",
  "#fbbf24",
  "#4ade80",
  "#60a5fa",
  "#f472b6",
  "#5eead4",
  "#c084fc",
]
const OTHER_COLOUR = "#5b6675"
const ACCENT_COLOUR = "#6ea8fe"
const DEFAULT_STATE = {
  since: "7d",
  gran: "day",
  includeInternal: false,
  q: "",
  model: "",
  sessionsSort: "updated",
  sessionsDir: "desc",
  callsSort: "started",
  callsDir: "desc",
  offset: 0,
  session: null,
  turnsStatus: "",
  turnsErrorsOnly: false,
  turnsSort: "started",
  turnsDir: "desc",
  turnsOffset: 0,
  turn: null,
  errorSource: "all",
  by: "model",
  metric: "cost",
  hmetric: "calls",
  view: "usage",
  provider: "",
}


// Everything the browser requests is resolved against this page's own directory, so the dashboard
// also works behind a reverse-proxy path prefix such as /usage/ without knowing the prefix.
const API_BASE = new URL("./api/", document.baseURI)
// The browser's resolved zone travels in the query string of every API request,
// never in the page URL, so buckets match the viewer's calendar.
const TIME_ZONE = (() => {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof resolved === "string" && resolved.length > 0 ? resolved : "UTC"
})()


const namespaceSource = document.querySelector("#svg-namespace svg")
const SVG_NAMESPACE = namespaceSource ? namespaceSource.namespaceURI : ""
// Chart legends toggle a line without a round trip: the choice lives with the
// chart element so it survives a refresh of the same view.
const hiddenChartLines = new WeakMap()

const sinceSelect = document.getElementById("since")
const granularityGroup = document.getElementById("granularity")
const granularityButtons = granularityGroup === null ? [] : [...granularityGroup.querySelectorAll("[data-gran]")]
const modelSelect = document.getElementById("model")
const searchInput = document.getElementById("q")
const internalInput = document.getElementById("includeInternal")
const refreshButton = document.getElementById("refresh")
const copySummaryButton = document.getElementById("copy-summary")
const copySummaryStatus = document.getElementById("copy-summary-status")
const controls = document.getElementById("controls")
const controlsMore = document.getElementById("controls-more")
const controlsToggle = document.getElementById("controls-toggle")
const controlsToggleIcon = document.getElementById("controls-toggle-icon")
const modelField = document.getElementById("model-field")
const modelProvider = document.getElementById("model-provider")
const modelSeparator = document.getElementById("model-separator")
const modelName = document.getElementById("model-name")
const banner = document.getElementById("banner")
const errorBox = document.getElementById("error")
const kpiCore = document.getElementById("kpis-core")
const kpiLatency = document.getElementById("kpis-latency")
const kpiRounds = document.getElementById("kpis-rounds")
const coverage = document.getElementById("coverage")
const chartCost = document.getElementById("chart-cost")
const chartTokens = document.getElementById("chart-tokens")
const chartTtft = document.getElementById("chart-ttft")
const chartTps = document.getElementById("chart-tps")
const chartRounds = document.getElementById("chart-rounds")
const chartErrors = document.getElementById("chart-errors")
const costCaption = document.getElementById("cost-caption")
const tokensCaption = document.getElementById("tokens-caption")
const ttftCaption = document.getElementById("ttft-caption")
const tpsCaption = document.getElementById("tps-caption")
const roundCaption = document.getElementById("round-caption")
const errorCaption = document.getElementById("error-caption")
const sessionsContainer = document.getElementById("sessions")
const sessionsSummary = document.getElementById("sessions-summary")
const roundsContainer = document.getElementById("rounds")
const roundsSummary = document.getElementById("rounds-summary")
const roundsPage = document.getElementById("rounds-page")
const roundsPrev = document.getElementById("rounds-prev")
const roundsNext = document.getElementById("rounds-next")
const turnStatusSelect = document.getElementById("turn-status")
const turnErrorsInput = document.getElementById("turn-errors")
const callsContainer = document.getElementById("calls")
const callsSummary = document.getElementById("calls-summary")
const callsPage = document.getElementById("calls-page")
const callsPrev = document.getElementById("calls-prev")
const callsNext = document.getElementById("calls-next")
const errorsContainer = document.getElementById("errors")
const errorsSummary = document.getElementById("errors-summary")
const errorSourceSelect = document.getElementById("error-source")
const pivotContainer = document.getElementById("pivot")
const pivotChart = document.getElementById("pivot-chart")
const pivotLegend = document.getElementById("pivot-legend")
const pivotSummary = document.getElementById("pivot-summary")
const pivotBySelect = document.getElementById("pivot-by")
const pivotMetricSelect = document.getElementById("pivot-metric")
const heatmapContainer = document.getElementById("heatmap")
const heatmapLegend = document.getElementById("heatmap-legend")
const heatmapSummary = document.getElementById("heatmap-summary")
const heatmapMetricGroup = document.getElementById("heatmap-metric")
const heatmapMetricButtons =
  heatmapMetricGroup === null ? [] : [...heatmapMetricGroup.querySelectorAll("[data-hmetric]")]
const viewUsage = document.getElementById("view-usage")
const viewProvider = document.getElementById("view-provider")
const viewRates = document.getElementById("view-rates")
const ratesPage = document.getElementById("rates-page")
const viewNav = document.getElementById("views")
const detail = document.getElementById("detail")
const detailBackdrop = document.getElementById("detail-backdrop")
const detailTitle = document.getElementById("detail-title")
const detailId = document.getElementById("detail-id")
const detailBody = document.getElementById("detail-body")
const detailClose = document.getElementById("detail-close")

let state = readState()
let controlsCollapsed = readControlsCollapsed()
let lastCharts = null
let lastPivot = null
let lastOverview = null
let requestID = 0
let controller = null
let searchTimer = null
let copyLabelTimer = null

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

for (const button of viewNav.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    const view = button.dataset.view ?? DEFAULT_STATE.view
    if (view === state.view) return
    state.view = view
    applyView()
    history.pushState(null, "", urlForState())
    void refresh()
  })
}

refreshButton.addEventListener("click", () => commit(false))
copySummaryButton.addEventListener("click", () => void copySummary())
controlsToggle.addEventListener("click", () => {
  controlsCollapsed = !controlsCollapsed
  applyControlsCollapsed()
  writeControlsCollapsed(controlsCollapsed)
})
sinceSelect.addEventListener("change", () => {
  state.since = sinceSelect.value
  state.offset = 0
  state.turnsOffset = 0
  commit(true)
})
for (const button of granularityButtons) {
  button.addEventListener("click", () => {
    const gran = button.dataset.gran ?? DEFAULT_STATE.gran
    if (gran === state.gran) return
    state.gran = gran
    commit(true)
  })
}
pivotBySelect.addEventListener("change", () => {
  state.by = pivotBySelect.value
  commit(true)
})
pivotMetricSelect.addEventListener("change", () => {
  state.metric = pivotMetricSelect.value
  commit(true)
})
for (const button of heatmapMetricButtons) {
  button.addEventListener("click", () => {
    const hmetric = button.dataset.hmetric ?? DEFAULT_STATE.hmetric
    if (hmetric === state.hmetric) return
    state.hmetric = hmetric
    commit(true)
  })
}

modelSelect.addEventListener("change", () => {
  state.model = modelSelect.value
  state.offset = 0
  state.turnsOffset = 0
  commit(true)
})
searchInput.addEventListener("input", () => {
  state.q = searchInput.value
  state.offset = 0
  if (searchTimer !== null) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    commit(false)
  }, 220)
})
internalInput.addEventListener("change", () => {
  state.includeInternal = internalInput.checked
  state.offset = 0
  state.turnsOffset = 0
  commit(true)
})
callsPrev.addEventListener("click", () => {
  if (state.offset === 0) return
  state.offset = Math.max(0, state.offset - PAGE_SIZE)
  commit(true)
})
callsNext.addEventListener("click", () => {
  state.offset += PAGE_SIZE
  commit(true)
})
roundsPrev.addEventListener("click", () => {
  if (state.turnsOffset === 0) return
  state.turnsOffset = Math.max(0, state.turnsOffset - ROUNDS_PAGE_SIZE)
  commit(true)
})
roundsNext.addEventListener("click", () => {
  state.turnsOffset += ROUNDS_PAGE_SIZE
  commit(true)
})
turnStatusSelect.addEventListener("change", () => {
  state.turnsStatus = turnStatusSelect.value
  state.turnsOffset = 0
  commit(true)
})
turnErrorsInput.addEventListener("change", () => {
  state.turnsErrorsOnly = turnErrorsInput.checked
  state.turnsOffset = 0
  commit(true)
})
errorSourceSelect.addEventListener("change", () => {
  state.errorSource = errorSourceSelect.value
  commit(true)
})
detailClose.addEventListener("click", () => closePanel(true))
detailBackdrop.addEventListener("click", () => closePanel(true))
window.addEventListener("popstate", () => {
  state = readState()
  applyView()
  syncControls()
  void refresh()
})
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (state.session !== null || state.turn !== null)) closePanel(true)
})
window.addEventListener("resize", () => {
  if (lastCharts !== null || lastPivot !== null) queueChartRedraw()
})

let chartRedrawTimer = null
function queueChartRedraw() {
  if (chartRedrawTimer !== null) clearTimeout(chartRedrawTimer)
  chartRedrawTimer = setTimeout(() => {
    chartRedrawTimer = null
    if (lastCharts !== null) renderCharts(lastCharts)
    if (lastPivot !== null) renderPivotChart(lastPivot)
  }, 120)
}

applyControlsCollapsed()
applyView()
syncControls()
history.replaceState(null, "", urlForState())
void refresh()

function readControlsCollapsed() {
  try {
    return localStorage.getItem(CONTROLS_STORAGE_KEY) === "collapsed"
  } catch {
    return false
  }
}

function writeControlsCollapsed(collapsed) {
  try {
    localStorage.setItem(CONTROLS_STORAGE_KEY, collapsed ? "collapsed" : "expanded")
  } catch {
    // Storage can be unavailable (private mode, blocked origin); the current view still applies.
  }
}

// Swap the two pages and mark the active tab. The provider view reuses the same
// window/model filters, so switching never refetches or loses the selection.
function applyView() {
  const providers = state.view === "providers"
  const rates = state.view === "rates"
  viewUsage.hidden = providers || rates
  viewProvider.hidden = !providers
  viewRates.hidden = !rates
  // The rates view still reads the window (it measures the token mix and how
  // much spend fell at peak), so only the provider page hides the controls.
  controls.hidden = providers
  for (const button of viewNav.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === state.view
    button.classList.toggle("is-active", active)
    if (active) button.setAttribute("aria-current", "page")
    else button.removeAttribute("aria-current")
  }
}

function applyControlsCollapsed() {
  controls.classList.toggle("is-collapsed", controlsCollapsed)
  // The hidden attribute removes the extra controls from layout and the tab order.
  controlsMore.hidden = controlsCollapsed
  controlsToggle.setAttribute("aria-expanded", controlsCollapsed ? "false" : "true")
  controlsToggle.setAttribute("aria-label", controlsCollapsed ? "Expand controls" : "Collapse controls")
  // Down points at the controls it opens; up points at the row it closes.
  controlsToggleIcon.setAttribute("d", controlsCollapsed ? "M6 9l6 6 6-6" : "M6 15l6-6 6 6")
}

function readState() {
  const parameters = new URLSearchParams(location.search)
  const since = parameters.get("since")
  const offsetValue = parameters.get("offset")
  const turnsOffsetValue = parameters.get("toffset")
  const session = parameters.get("session") || null
  const turn = parameters.get("turn") || null
  return {
    since: SINCE_VALUES.includes(since) || /^\d{4}-\d{2}-\d{2}$/.test(since ?? "") ? since : DEFAULT_STATE.since,
    gran: oneOf(parameters.get("gran"), GRANULARITIES, DEFAULT_STATE.gran),
    includeInternal:
      parameters.get("includeInternal") === "1" || parameters.get("includeInternal") === "true",
    q: parameters.get("q") ?? "",
    model: parameters.get("model") ?? "",
    sessionsSort: oneOf(parameters.get("ssort"), SESSION_SORTS, DEFAULT_STATE.sessionsSort),
    sessionsDir: oneOf(parameters.get("sdir"), DIRECTIONS, DEFAULT_STATE.sessionsDir),
    callsSort: oneOf(parameters.get("csort"), CALL_SORTS, DEFAULT_STATE.callsSort),
    callsDir: oneOf(parameters.get("cdir"), DIRECTIONS, DEFAULT_STATE.callsDir),
    offset:
      /^\d+$/.test(offsetValue ?? "") && Number.isSafeInteger(Number(offsetValue)) ? Number(offsetValue) : 0,
    session: turn !== null ? null : session,
    turnsStatus: oneOf(parameters.get("tstatus"), TURN_STATUSES, ""),
    turnsErrorsOnly: parameters.get("terrors") === "1" || parameters.get("terrors") === "true",
    turnsSort: oneOf(parameters.get("tsort"), TURN_SORTS, DEFAULT_STATE.turnsSort),
    turnsDir: oneOf(parameters.get("tdir"), DIRECTIONS, DEFAULT_STATE.turnsDir),
    turnsOffset:
      /^\d+$/.test(turnsOffsetValue ?? "") && Number.isSafeInteger(Number(turnsOffsetValue))
        ? Number(turnsOffsetValue)
        : 0,
    turn,
    errorSource: oneOf(parameters.get("esource"), ERROR_SOURCES, DEFAULT_STATE.errorSource),
    by: oneOf(parameters.get("by"), PIVOT_BYS, DEFAULT_STATE.by),
    metric: oneOf(parameters.get("metric"), PIVOT_METRICS, DEFAULT_STATE.metric),
    hmetric: oneOf(parameters.get("hmetric"), HEATMAP_METRICS, DEFAULT_STATE.hmetric),
    view: oneOf(parameters.get("view"), VIEWS, DEFAULT_STATE.view),
    provider: parameters.get("provider") ?? DEFAULT_STATE.provider,
  }
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function stateParameters() {
  const parameters = new URLSearchParams()
  parameters.set("since", state.since)
  if (state.gran !== DEFAULT_STATE.gran) parameters.set("gran", state.gran)
  if (state.includeInternal) parameters.set("includeInternal", "1")
  if (state.q.length > 0) parameters.set("q", state.q)
  if (state.model.length > 0) parameters.set("model", state.model)
  if (state.sessionsSort !== DEFAULT_STATE.sessionsSort) parameters.set("ssort", state.sessionsSort)
  if (state.sessionsDir !== DEFAULT_STATE.sessionsDir) parameters.set("sdir", state.sessionsDir)
  if (state.callsSort !== DEFAULT_STATE.callsSort) parameters.set("csort", state.callsSort)
  if (state.callsDir !== DEFAULT_STATE.callsDir) parameters.set("cdir", state.callsDir)
  if (state.offset > 0) parameters.set("offset", String(state.offset))
  if (state.session !== null) parameters.set("session", state.session)
  if (state.turnsStatus.length > 0) parameters.set("tstatus", state.turnsStatus)
  if (state.turnsErrorsOnly) parameters.set("terrors", "1")
  if (state.turnsSort !== DEFAULT_STATE.turnsSort) parameters.set("tsort", state.turnsSort)
  if (state.turnsDir !== DEFAULT_STATE.turnsDir) parameters.set("tdir", state.turnsDir)
  if (state.turnsOffset > 0) parameters.set("toffset", String(state.turnsOffset))
  if (state.turn !== null) parameters.set("turn", state.turn)
  if (state.errorSource !== DEFAULT_STATE.errorSource) parameters.set("esource", state.errorSource)
  if (state.by !== DEFAULT_STATE.by) parameters.set("by", state.by)
  if (state.metric !== DEFAULT_STATE.metric) parameters.set("metric", state.metric)
  if (state.hmetric !== DEFAULT_STATE.hmetric) parameters.set("hmetric", state.hmetric)
  if (state.view !== DEFAULT_STATE.view) parameters.set("view", state.view)
  if (state.provider.length > 0) parameters.set("provider", state.provider)
  return parameters
}

function urlForState() {
  const query = stateParameters().toString()
  return `${location.pathname}${query.length > 0 ? `?${query}` : ""}`
}

function commit(push) {
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  syncControls()
  if (push) history.pushState(null, "", urlForState())
  else history.replaceState(null, "", urlForState())
  void refresh()
}

function syncControls() {
  if (!SINCE_VALUES.includes(state.since) && ![...sinceSelect.options].some((option) => option.value === state.since))
    sinceSelect.append(new Option(state.since, state.since))
  sinceSelect.value = state.since
  for (const button of granularityButtons) {
    const active = button.dataset.gran === state.gran
    button.classList.toggle("is-active", active)
    button.setAttribute("aria-pressed", active ? "true" : "false")
  }
  internalInput.checked = state.includeInternal
  if (searchInput.value !== state.q) searchInput.value = state.q
  selectIntendedModel()
  updateModelField()
  turnStatusSelect.value = state.turnsStatus
  turnErrorsInput.checked = state.turnsErrorsOnly
  errorSourceSelect.value = state.errorSource
  pivotBySelect.value = state.by
  pivotMetricSelect.value = state.metric
  for (const button of heatmapMetricButtons) {
    const active = button.dataset.hmetric === state.hmetric
    button.classList.toggle("is-active", active)
    button.setAttribute("aria-pressed", active ? "true" : "false")
  }
}

// The native select is transparent over this field, so the visible text comes
// from these spans. Split the first slash: providers are flat, model ids may not be.
function updateModelField() {
  const value = state.model
  const separator = value.indexOf("/")
  const provider = separator === -1 ? "" : value.slice(0, separator)
  modelProvider.textContent = provider
  modelProvider.hidden = provider.length === 0
  modelSeparator.hidden = provider.length === 0
  modelName.textContent = value.length === 0 ? "All models" : value.slice(separator + 1)
  modelField.title = value.length === 0 ? "All models" : value
}

function closePanel(push) {
  state.session = null
  state.turn = null
  closeDetailPanel()
  if (push) commit(true)
  else void refresh()
}

async function refresh() {
  const id = ++requestID
  if (controller !== null) controller.abort()
  controller = new AbortController()
  const signal = controller.signal
  refreshButton.disabled = true

  const common = new URLSearchParams()
  common.set("since", state.since)
  common.set("tz", TIME_ZONE)
  if (state.includeInternal) common.set("includeInternal", "1")
  // The select is only a view of this value; queries always read the intended
  // model from state so a not-yet-populated option list cannot widen the filter.
  const model = state.model

  const failures = []

  // Meta settles first and gates the rest: a server that predates this page's
  // routes would answer 404 to them, so there is no point asking.
  const meta = await fetchJson(apiURL("meta", common), signal).then(
    (value) => ({ ok: true, value }),
    (reason) => ({ ok: false, reason }),
  )
  if (id !== requestID) return
  refreshButton.disabled = false
  if (!meta.ok) {
    failures.push(meta.reason)
    renderFailures(failures)
    return
  }
  const stale = checkCapabilities(meta.value, state.view)
  renderMeta(meta.value, stale)
  if (stale !== null) {
    clearView(state.view)
    return
  }

  // The provider page reuses the same window and model filters but needs none of
  // the usage tables, so it asks only for providers and quotas.
  if (state.view === "rates") {
    const ratesQuery = new URLSearchParams(common)
    if (model.length > 0) ratesQuery.set("model", model)
    const rates = await fetchJson(apiURL("rates", ratesQuery), signal).then(
      (value) => ({ ok: true, value }),
      (reason) => ({ ok: false, reason }),
    )
    if (id !== requestID) return
    if (rates.ok) renderRates(rates.value)
    else failures.push(rates.reason)
    renderFailures(failures)
    return
  }

  if (state.view === "providers") {
    const providersQuery = new URLSearchParams(common)
    if (model.length > 0) providersQuery.set("model", model)
    const [providers, quotas] = await Promise.allSettled([
      fetchJson(apiURL("providers", providersQuery), signal),
      // Quotas take no filters: the response is the account's whole status.
      fetchJson(apiURL("quotas", new URLSearchParams()), signal),
    ])
    if (id !== requestID) return
    if (providers.status === "fulfilled")
      renderProviders(providers.value, quotas.status === "fulfilled" ? quotas.value : null)
    else failures.push(providers.reason)
    if (quotas.status === "rejected") failures.push(quotas.reason)
    renderFailures(failures)
    return
  }

  const overviewQuery = new URLSearchParams(common)
  overviewQuery.set("granularity", state.gran)
  if (model.length > 0) overviewQuery.set("model", model)

  const pivotQuery = new URLSearchParams(common)
  pivotQuery.set("granularity", state.gran)
  pivotQuery.set("by", state.by)
  pivotQuery.set("metric", state.metric)
  if (model.length > 0) pivotQuery.set("model", model)

  const heatmapQuery = new URLSearchParams(common)
  heatmapQuery.set("metric", state.hmetric)
  if (model.length > 0) heatmapQuery.set("model", model)

  const sessionsQuery = new URLSearchParams(common)
  sessionsQuery.set("limit", String(SESSIONS_LIMIT))
  sessionsQuery.set("sort", state.sessionsSort)
  sessionsQuery.set("dir", state.sessionsDir)
  if (state.q.trim().length > 0) sessionsQuery.set("q", state.q.trim())
  if (model.length > 0) sessionsQuery.set("model", model)

  const callsQuery = new URLSearchParams(common)
  callsQuery.set("limit", String(PAGE_SIZE))
  callsQuery.set("offset", String(state.offset))
  callsQuery.set("sort", state.callsSort)
  callsQuery.set("dir", state.callsDir)
  if (model.length > 0) callsQuery.set("model", model)

  const turnsQuery = new URLSearchParams(common)
  turnsQuery.set("limit", String(ROUNDS_PAGE_SIZE))
  turnsQuery.set("offset", String(state.turnsOffset))
  turnsQuery.set("sort", state.turnsSort)
  turnsQuery.set("dir", state.turnsDir)
  if (state.turnsStatus.length > 0) turnsQuery.set("status", state.turnsStatus)
  if (state.turnsErrorsOnly) turnsQuery.set("onlyErrors", "1")
  if (model.length > 0) turnsQuery.set("model", model)

  const errorsQuery = new URLSearchParams(common)
  errorsQuery.set("source", state.errorSource)
  if (model.length > 0) errorsQuery.set("model", model)

  const openedSession = state.session
  const openedTurn = state.turn
  const detailPath =
    openedTurn !== null
      ? `turn/${encodeURIComponent(openedTurn)}`
      : openedSession !== null
        ? `session/${encodeURIComponent(openedSession)}`
        : null
  // The overview fetch starts first and paints the KPIs as soon as it settles.
  // The remaining requests are only sent after that paint so their cold snapshot
  // builds cannot delay the first KPI frame.
  const overviewFetch = fetchJson(apiURL("overview", overviewQuery), signal)

  const overview = await overviewFetch.then(
    (value) => ({ ok: true, value }),
    (reason) => ({ ok: false, reason }),
  )
  if (id !== requestID) return
  if (overview.ok) {
    lastCharts = overview.value
    renderOverview(overview.value)
  } else failures.push(overview.reason)

  const remainingSettled = Promise.allSettled([
    fetchJson(apiURL("sessions", sessionsQuery), signal),
    fetchJson(apiURL("calls", callsQuery), signal),
    fetchJson(apiURL("turns", turnsQuery), signal),
    fetchJson(apiURL("errors", errorsQuery), signal),
    fetchJson(apiURL("pivot", pivotQuery), signal),
    fetchJson(apiURL("heatmap", heatmapQuery), signal),
    detailPath === null ? Promise.resolve(null) : fetchJson(apiURL(detailPath, common), signal),
  ])
  const [sessions, calls, turns, errors, pivot, heatmap, detailResult] = await remainingSettled
  if (id !== requestID) return

  if (sessions.status === "fulfilled") renderSessions(sessions.value)
  else failures.push(sessions.reason)
  if (calls.status === "fulfilled") renderCalls(calls.value)
  else failures.push(calls.reason)
  if (turns.status === "fulfilled") renderTurns(turns.value)
  else failures.push(turns.reason)
  if (errors.status === "fulfilled") renderErrors(errors.value)
  else failures.push(errors.reason)
  if (pivot.status === "fulfilled") renderPivot(pivot.value)
  else failures.push(pivot.reason)
  if (heatmap.status === "fulfilled") renderHeatmap(heatmap.value)
  else failures.push(heatmap.reason)

  if (openedTurn !== null) {
    if (detailResult.status === "fulfilled" && detailResult.value !== null) renderTurnDetail(detailResult.value)
    else if (detailResult.status === "rejected") renderTurnDetailError(detailResult.reason)
  } else if (openedSession !== null) {
    if (detailResult.status === "fulfilled" && detailResult.value !== null) renderDetail(detailResult.value)
    else if (detailResult.status === "rejected") renderDetailError(detailResult.reason)
  } else closeDetailPanel()

  renderFailures(failures)
}

function renderFailures(failures) {
  if (failures.length > 0) showError([...new Set(failures.map(failureMessage))].join(" · "))
  else hideError()
}

// A 404 carrying our own "unknown endpoint" body means the request reached a
// server whose route table predates this page. Reporting the raw text sends
// people looking for a bug in the page instead of at the stale process.
function failureMessage(failure) {
  if (failure instanceof ApiError && failure.status === 404 && failure.message === "unknown endpoint")
    return STALE_SERVER
  return errorMessage(failure)
}

function apiURL(path, parameters) {
  const url = new URL(path, API_BASE)
  url.search = parameters.toString()
  return url
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body !== null && typeof body.error === "string" ? body.error : `Request failed (${response.status})`
    throw new ApiError(message, response.status)
  }
  return body
}

// A server built before this page's routes existed answers 404 to them, which
// reads as "unknown endpoint" and looks like a bug in the page. Say what it is.
function checkCapabilities(meta, view) {
  const required = VIEW_ENDPOINTS[view] ?? []
  const capabilities = meta?.capabilities
  // No list at all means the build predates the handshake, so it is older than
  // any build whose routes this page can rely on.
  if (!Array.isArray(capabilities)) return STALE_SERVER
  const missing = required.filter((endpoint) => !capabilities.includes(endpoint))
  if (missing.length === 0) return null
  return `The dashboard server is out of date: it does not serve ${missing.join(", ")}. ${RESTART_HINT}`
}

// Leaving a view's previous contents on screen under a "cannot load" banner
// would show numbers from a build this page can no longer talk to.
function clearView(view) {
  if (view === "providers") document.getElementById("provider-page")?.replaceChildren()
  else if (view === "rates") ratesPage.replaceChildren()
}

function renderMeta(meta, stale) {
  if (stale !== null && stale !== undefined) {
    banner.hidden = false
    banner.className = "banner banner-warn"
    banner.textContent = stale
    return
  }
  const sidecar = meta.sidecar
  if (!sidecar.exists) {
    banner.hidden = false
    banner.className = "banner banner-warn"
    banner.textContent = `Sidecar database not found: ${sidecar.path}. Every metric on this page comes from recorded calls, so the dashboard cannot show usage until the tracker writes a call.`
  } else if (sidecar.calls === 0) {
    banner.hidden = false
    banner.className = "banner banner-warn"
    banner.textContent = `Sidecar is empty: ${sidecar.path} has no recorded calls yet. Every metric on this page comes from recorded calls.`
  } else {
    banner.hidden = true
  }
}

function renderOverview(overview) {
  lastOverview = overview
  const totals = overview.totals
  const sidecar = overview.sidecar
  const rounds = overview.rounds ?? {}
  const roundMs = rounds.roundMs ?? {}
  kpiCore.replaceChildren()
  kpiCore.append(
    kpiRows(
      "Cost",
      formatCost(totals.costUSD),
      [
        ["calls", formatInt(totals.calls)],
        ["sessions", formatInt(totals.sessions)],
      ],
      `Every recorded call in this window is priced on its plan's own card, so the total matches what the plan's meter charges. ${formatInt(totals.excludedInternal)} internal-test excluded.`,
    ),
    tokenKpi(totals.tokens),
    kpi(
      "Error rate",
      formatPercent(overview.callErrors?.rate ?? null),
      callErrorDetail(overview.callErrors, totals.calls),
      "Calls that ended failed or interrupted, divided by every recorded call in this window. A retry that later succeeded is not counted; a round that fell over shows up under Rounds.",
    ),
  )

  kpiLatency.replaceChildren()
  kpiLatency.append(
    kpiRows(
      "TTFT",
      formatDuration(sidecar.avgTTFT),
      [
        ["p50", formatDuration(sidecar.p50TTFT)],
        ["p95", formatDuration(sidecar.p95TTFT)],
      ],
      "Time from request dispatch to the first model output, over recorded calls.",
    ),
    kpiRows(
      "TPS",
      formatTPS(sidecar.avgTPS),
      [["cache hit", formatPercent(totals.cacheHitRate)]],
      "Average output tokens per second. Cache hit is cache read divided by input plus cache read.",
    ),
  )

  const roundRows = []
  if (rounds.running > 0) roundRows.push(["running", formatInt(rounds.running)])
  if (rounds.stale > 0) roundRows.push(["stale", formatInt(rounds.stale)])
  roundRows.push(["failed", formatInt(rounds.failed)])
  if (rounds.interrupted > 0) roundRows.push(["interrupted", formatInt(rounds.interrupted)])
  kpiRounds.replaceChildren()
  kpiRounds.append(
    kpiRows("Rounds", formatInt(rounds.total), roundRows),
    kpiRows("Round duration", formatDuration(roundMs.p50), [
      ["p95", formatDuration(roundMs.p95)],
      ["avg", formatDuration(roundMs.avg)],
    ]),
    kpiRows(
      "Timeouts",
      formatInt(rounds.timeouts),
      [["retries", formatInt(rounds.retries)]],
      "Rounds interrupted for inactivity. Retries counts scheduled provider retries across rounds.",
    ),
  )

  coverage.textContent =
    sidecar.firstAt === null || sidecar.lastAt === null
      ? "No recorded calls in this window; calls before the tracker was installed are not included."
      : `Recorded calls from ${formatDateTime(sidecar.firstAt)} to ${formatDateTime(sidecar.lastAt)}; calls before the tracker was installed are not included.`

  costCaption.textContent = `· window total ${formatCost(totals.costUSD)}`
  tokensCaption.textContent = "· all billed tokens, cache included"
  ttftCaption.textContent = "· avg / p50 / p95 from recorded calls"
  tpsCaption.textContent = "· avg / p50 / p95 from recorded calls"
  roundCaption.textContent = `· ${formatInt(rounds.total)} rounds · avg / p50 / p95 of completed rounds`
  const errorTotal = (overview.errorSeries ?? []).reduce((total, point) => total + point.call + point.turn, 0)
  errorCaption.textContent = `· ${formatInt(errorTotal)} errors · calls and rounds shown separately`
  populateModels(overview.models)
  renderCharts(overview)
}

function callErrorDetail(errors, calls) {
  if (errors === undefined || errors === null || !(calls > 0)) return "no calls"
  return `${formatInt(errors.failed + errors.interrupted)} of ${formatInt(calls)} calls`
}

function kpi(label, value, detailText, note) {
  const card = kpiCard(label, value)
  if (detailText) card.append(element("div", "kpi-detail", detailText))
  addKpiNote(card, label, note)
  return card
}

function kpiRows(label, value, rows, note) {
  const card = kpiCard(label, value)
  const list = element("dl", "kpi-token-rows")
  for (const [rowLabel, rowValue] of rows) list.append(tokenRow(rowLabel, rowValue))
  card.append(list)
  addKpiNote(card, label, note)
  return card
}

function kpiCard(label, value) {
  const card = element("div", "kpi")
  card.append(element("div", "kpi-label", label), element("div", "kpi-value", value))
  return card
}

function addKpiNote(card, label, note) {
  if (note === undefined) return
  card.title = note
  const description = element("span", "visually-hidden", note)
  description.id = `kpi-${label.toLowerCase().replace(/\s+/g, "-")}-description`
  card.setAttribute("aria-describedby", description.id)
  card.append(description)
}

function tokenKpi(tokens) {
  const note =
    "Headline is every billed token: input, output, thinking, cache read and cache write. " +
    "The provider console folds cache read into input, so its input and total match these two rows together."
  const card = element("div", "kpi kpi-tokens")
  card.title = note
  const description = element("span", "visually-hidden", note)
  description.id = "tokens-kpi-description"
  card.setAttribute("aria-describedby", description.id)

  const rows = element("dl", "kpi-token-rows")
  rows.append(
    tokenRow("input", formatTokens(tokens.input)),
    tokenRow("output", formatTokens(tokens.output)),
    tokenRow("thinking", formatTokens(tokens.reasoning)),
    tokenRow("cache read", formatTokens(tokens.cacheRead), "kpi-token-cache kpi-token-extra"),
  )
  if (tokens.cacheWrite > 0) rows.append(tokenRow("cache write", formatTokens(tokens.cacheWrite), "kpi-token-extra"))

  card.append(
    element("div", "kpi-label", "Total tokens"),
    element("div", "kpi-value", formatTokens(tokens.total)),
    rows,
    description,
  )
  return card
}

function tokenRow(label, value, className) {
  const row = element("div", className === undefined ? "kpi-token-row" : `kpi-token-row ${className}`)
  const term = element("dt", "kpi-token-label", label)
  term.title = label
  row.append(term, element("dd", "kpi-token-value", value))
  return row
}

function populateModels(models) {
  const values = new Map()
  for (const model of models) {
    if (model.modelID === null) continue
    const value = model.providerID === null ? model.modelID : `${model.providerID}/${model.modelID}`
    if (!values.has(value)) values.set(value, model.label ?? value)
  }
  modelSelect.replaceChildren()
  modelSelect.append(new Option("All models", ""))
  for (const [value, label] of values) modelSelect.append(new Option(label, value))
  selectIntendedModel()
}

// Keep the intended model visible and selected without inventing calls for it.
// A model missing from the current window stays selected through a disabled
// placeholder, so the select never falls back to All models behind the state.
function selectIntendedModel() {
  for (const option of modelSelect.querySelectorAll("option[data-missing-model]")) option.remove()
  if (state.model.length === 0) {
    modelSelect.value = ""
    return
  }
  const present = [...modelSelect.options].some((option) => option.value === state.model)
  if (!present) {
    const placeholder = new Option(state.model, state.model, true, true)
    placeholder.disabled = true
    placeholder.dataset.missingModel = "1"
    modelSelect.append(placeholder)
  }
  modelSelect.value = state.model
}

function renderSessions(response) {
  sessionsContainer.replaceChildren()
  const parts = [`${formatInt(response.total)} session${response.total === 1 ? "" : "s"}`]
  if (response.excludedInternal > 0)
    parts.push(`${formatInt(response.excludedInternal)} internal-test excluded`)
  if (response.total > response.rows.length) parts.push(`showing ${formatInt(response.rows.length)}`)
  sessionsSummary.textContent = parts.join(" · ")

  if (response.rows.length === 0) {
    sessionsContainer.append(element("p", "empty", "No sessions match these filters."))
    return
  }

  const rows = response.rows.map((row) => ({
    cells: [
      sessionIDCell(row.sessionID, row.session),
      titleCell(row.title, row.internal),
      cell(formatInt(row.calls), "right mono"),
      cell(`${formatTokens(row.tokens.input)} / ${formatTokens(row.tokens.output)} / ${formatTokens(row.tokens.reasoning)}`, "right mono"),
      cell(`${formatTokens(row.tokens.cacheRead)} / ${formatTokens(row.tokens.cacheWrite)}`, "right mono"),
      cell(formatCost(row.costUSD), "right mono"),
      cell(formatDuration(row.avgTTFT), "right mono"),
      cell(formatTPS(row.avgTPS), "right mono"),
      cell(formatDateTime(row.updatedAt)),
    ],
    activate: () => openSession(row.sessionID),
    ariaLabel: `Open session ${row.title ?? row.session}`,
  }))
  sessionsContainer.append(buildTable(sessionColumns(), rows, "Sessions"))
}

function renderCalls(response) {
  if (response.rows.length === 0 && response.total > 0 && response.offset > 0) {
    state.offset = Math.max(0, Math.floor((response.total - 1) / PAGE_SIZE) * PAGE_SIZE)
    history.replaceState(null, "", urlForState())
    void refresh()
    return
  }

  callsContainer.replaceChildren()
  const total = response.total
  const first = total === 0 ? 0 : response.offset + 1
  const last = Math.min(response.offset + response.rows.length, total)
  callsPage.textContent = total === 0 ? "0 calls" : `${formatInt(first)}–${formatInt(last)} of ${formatInt(total)}`
  callsPrev.disabled = response.offset === 0
  callsNext.disabled = response.offset + PAGE_SIZE >= total
  const callParts = [`${formatInt(total)} matching call${total === 1 ? "" : "s"}`]
  if (response.excludedInternal > 0)
    callParts.push(`${formatInt(response.excludedInternal)} internal-test excluded`)
  callsSummary.textContent = callParts.join(" · ")

  if (response.rows.length === 0) {
    callsContainer.append(element("p", "empty", "No recorded calls match these filters."))
    return
  }
  callsContainer.append(buildTable(callColumns(true), callRows(response.rows), "Recorded calls"))
}

function renderTurns(response) {
  if (response.rows.length === 0 && response.total > 0 && response.offset > 0) {
    state.turnsOffset = Math.max(0, Math.floor((response.total - 1) / ROUNDS_PAGE_SIZE) * ROUNDS_PAGE_SIZE)
    history.replaceState(null, "", urlForState())
    void refresh()
    return
  }

  roundsContainer.replaceChildren()
  const total = response.total
  const first = total === 0 ? 0 : response.offset + 1
  const last = Math.min(response.offset + response.rows.length, total)
  roundsPage.textContent = total === 0 ? "0 rounds" : `${formatInt(first)}–${formatInt(last)} of ${formatInt(total)}`
  roundsPrev.disabled = response.offset === 0
  roundsNext.disabled = response.offset + ROUNDS_PAGE_SIZE >= total
  const parts = [`${formatInt(total)} round${total === 1 ? "" : "s"}`]
  if (response.excludedInternal > 0)
    parts.push(`${formatInt(response.excludedInternal)} internal-test excluded`)
  roundsSummary.textContent = parts.join(" · ")

  if (response.rows.length === 0) {
    roundsContainer.append(element("p", "empty", "No rounds match these filters."))
    return
  }
  roundsContainer.append(buildTable(turnColumns(true, true), turnRows(response.rows, true, true), "Rounds"))
}

function renderErrors(response) {
  errorsContainer.replaceChildren()
  const measured = response.rows.reduce((total, row) => total + row.count, 0)
  errorsSummary.textContent = `${formatInt(response.rows.length)} group${response.rows.length === 1 ? "" : "s"} · ${formatInt(measured)} error${measured === 1 ? "" : "s"}`
  if (response.rows.length === 0) {
    errorsContainer.append(element("p", "empty", "No errors in this window."))
    return
  }
  const maximum = Math.max(...response.rows.map((row) => row.count), 1)
  const columns = [
    header("Type"),
    header("Source"),
    header("Count", "right"),
    header("Sessions", "right"),
    header("First"),
    header("Last"),
    header("Message"),
    header("Share", "right"),
  ]
  const rows = response.rows.map((row) => ({
    cells: [
      cell(row.errorType ?? "(none)", "mono"),
      errorSourceCell(row.source),
      cell(formatInt(row.count), "right mono"),
      cell(formatInt(row.sessions), "right mono"),
      cell(formatDateTime(row.firstAt)),
      cell(formatDateTime(row.lastAt)),
      errorMessageCell(row.lastMessage),
      errorShareCell(row.count, maximum),
    ],
  }))
  errorsContainer.append(buildTable(columns, rows, "Errors"))
}

let lastProviders = null

// The Providers view replaces the whole usage page rather than adding a card to
// it, so the usage page keeps its original layout and the detail gets room.
let lastQuotas = null

function renderProviders(response, quotas) {
  lastProviders = response
  lastQuotas = quotas ?? lastQuotas
  const rows = providerRows(response)
  const page = document.getElementById("provider-page")
  page.replaceChildren()

  const head = element("div", "section-head")
  head.append(
    element(
      "h2",
      "",
      "Providers",
    ),
    element("span", "heading-note", "Fixed-fee plans: what you paid vs. what the tokens would have cost"),
  )
  page.append(head)

  const problems = planErrors(response.planErrors ?? [])
  if (problems !== null) page.append(problems)
  if (rows.length === 0) {
    page.append(element("p", "provider-empty", "No recorded calls in this window."))
    return
  }

  const paid = rows.reduce((total, row) => total + (row.spendUSD ?? 0), 0)
  const list = rows.reduce((total, row) => total + (row.meteredUSD ?? 0), 0)
  const configured = rows.filter((row) => (row.spendUSD ?? 0) > 0).length
  const summary = element("p", "coverage")
  summary.textContent =
    `${formatInt(rows.length)} provider${rows.length === 1 ? "" : "s"} in this window` +
    (configured === 0
      ? " · no plan prices configured"
      : ` · paid ${formatCost(paid)} · list value ${formatCost(list)}` +
        (paid > 0 ? ` · ${(list / paid).toFixed(2)}× value` : ""))

  const detail = element("div", "provider-detail")
  page.append(summary, providerTabStrip(rows, detail, rows), detail)
  renderProviderDetail(detail, rows)
}

// What a real dollar buys, per provider, for the model each one served most.
//
// The two price columns are the point: the plans meter the same model
// differently, so the question "which is cheaper" has a different answer at
// peak and off-peak. Showing one blended ranking would hide that.
function renderRates(response) {
  ratesPage.replaceChildren()
  const rows = Array.isArray(response.rows) ? response.rows : []

  const head = element("div", "section-head")
  head.append(
    element("h2", "", "Rates"),
    element("span", "heading-note", "Tokens bought by one real dollar of plan fee"),
  )
  ratesPage.append(head)

  const problems = planErrors(response.planErrors ?? [])
  if (problems !== null) ratesPage.append(problems)

  if (rows.length === 0) {
    ratesPage.append(
      element("p", "provider-empty", "No provider in this window has both a plan price and a published allowance."),
    )
    return
  }

  // The mix and the clock share are what make the headline figures concrete, so
  // state them rather than leaving the reader to wonder what "blended" means.
  const facts = []
  const mix = response.mix
  if (mix !== null && mix !== undefined)
    facts.push(
      `${(mix.input * 100).toFixed(1)}% input · ${(mix.output * 100).toFixed(1)}% output · ` +
        `${(mix.cacheRead * 100).toFixed(1)}% cache read`,
    )
  if (typeof response.peakShare === "number")
    facts.push(
      `${(response.peakShare * 100).toFixed(0)}% of this window's spend fell in DeepSeek's peak hours ` +
        "(only the clock-rated plans change there; OpenDesign's card does not)",
    )
  if (facts.length > 0) ratesPage.append(element("p", "coverage", facts.join(" · ")))

  ratesPage.append(ratesSummaryTable(rows))
  ratesPage.append(ratesKindTable(rows))
  ratesPage.append(ratesNotes(response))
}

// One row per provider: the plan terms, then the two price columns.
//
// The columns carry a `th-sub` unit line rather than a second header row, so the
// narrow layout can drop the header to just "Off-peak" / "Peak" without colspans
// that would no longer line up once columns are hidden.
function ratesSummaryTable(rows) {
  const wrap = element("div", "table-wrap rates-table rates-summary")
  const table = element("table", "data-table")
  table.append(element("caption", "visually-hidden", "Tokens bought per real dollar of plan fee"))

  const bestOff = Math.max(...rows.map((row) => row.offPeak?.blendedTokensPerDollar ?? 0))
  const bestPeak = Math.max(...rows.map((row) => row.peak?.blendedTokensPerDollar ?? 0))

  const thead = document.createElement("thead")
  const headRow = document.createElement("tr")
  headRow.append(
    ratesHeader("Provider", "", "", "left"),
    ratesHeader("Fee", "per month", "col-fee"),
    ratesHeader("Allowance", "per month", "col-allowance"),
    ratesHeader("Meters", "how the hour applies", "col-meters", "left"),
    ratesHeader("Off-peak", "tokens / $1", "group-start"),
    ratesHeader("Off-peak", "$ / 1M", "col-optional"),
    ratesHeader("Peak", "tokens / $1", "group-start"),
    ratesHeader("Peak", "$ / 1M", "col-optional"),
  )
  thead.append(headRow)

  const body = document.createElement("tbody")
  for (const row of rows) {
    const tr = document.createElement("tr")
    // The plan name is the thing being compared; the model id says what the
    // numbers are for, since a provider can serve several. The terms line only
    // shows on narrow screens, where those columns are hidden.
    const name = element("td", "rate-provider")
    name.append(element("div", "rate-name", row.planLabel ?? row.label ?? row.providerID))
    name.append(element("div", "rate-model mono", row.modelID ?? "unknown"))
    name.append(
      element(
        "div",
        "rate-terms",
        `${formatCost(row.feeUSD)}/mo · $${formatNumber(row.allowanceUSD)} allowance · ` +
          (row.basis === "flat" ? "one flat card" : "follows the clock"),
      ),
    )
    tr.append(
      name,
      element("td", "right col-fee", formatCost(row.feeUSD)),
      element("td", "right col-allowance", `$${formatNumber(row.allowanceUSD)}`),
      element("td", "rate-meter col-meters", row.basis === "flat" ? "one flat card" : "follows the clock"),
      ratesTokenCell(row.offPeak?.blendedTokensPerDollar, bestOff, "group-start", "Off-peak"),
      element("td", "right col-optional", formatUnitRate(row.offPeak?.blendedPerMillion)),
      ratesTokenCell(row.peak?.blendedTokensPerDollar, bestPeak, "group-start", "Peak"),
      element("td", "right col-optional", formatUnitRate(row.peak?.blendedPerMillion)),
    )
    body.append(tr)
  }

  table.append(thead, body)
  wrap.append(table)
  return wrap
}

function ratesHeader(label, sub, extra, align) {
  const cell = element("th", [align ?? "right", extra].filter(Boolean).join(" "))
  const main = element("div", "th-main", label)
  cell.append(main)
  if (sub) cell.append(element("div", "th-sub", sub))
  return cell
}

function ratesTokenCell(value, best, extra, label) {
  const cell = element("td", `right mono${extra ? " " + extra : ""}`, formatTokensPer(value))
  if (label) cell.dataset.label = label
  if (typeof value === "number" && value > 0 && Math.abs(value - best) < 1) cell.classList.add("is-best")
  return cell
}

// Per token kind, which is where the mix actually lives: cache reads are ~98% of
// the tokens and only a third of the cost, so the blended figure alone hides the
// two rates that matter for a different workload.
function ratesKindTable(rows) {
  const wrap = element("div", "table-wrap rates-table rates-kinds")
  const table = element("table", "data-table")
  table.append(element("caption", "visually-hidden", "Tokens per real dollar, by token kind"))

  const thead = document.createElement("thead")
  const headRow = document.createElement("tr")
  headRow.append(
    ratesHeader("Provider", "", "", "left"),
    ratesHeader("When", "", "", "left"),
    ratesHeader("Input", "tokens / $1"),
    ratesHeader("Output", "tokens / $1"),
    ratesHeader("Cache read", "tokens / $1"),
    ratesHeader("Blended", "tokens / $1"),
  )
  thead.append(headRow)

  const body = document.createElement("tbody")
  for (const row of rows) {
    // A flat meter prices every hour the same, so a second row would repeat the
    // first exactly and only add noise.
    const flat = row.basis === "flat"
    const sides = flat
      ? [["every hour", row.peak]]
      : [
          ["off-peak", row.offPeak],
          ["peak", row.peak],
        ]
    for (const [side, option] of sides) {
      const tr = document.createElement("tr")
      tr.append(
        element("td", "rate-provider", row.planLabel ?? row.label ?? row.providerID),
        element("td", "rate-meter rate-when", side),
        ratesKindCell(option?.tokensPerDollar?.input, "Input"),
        ratesKindCell(option?.tokensPerDollar?.output, "Output"),
        ratesKindCell(option?.tokensPerDollar?.cacheRead, "Cache read"),
        ratesKindCell(option?.blendedTokensPerDollar, "Blended"),
      )
      body.append(tr)
    }
  }

  table.append(thead, body)
  wrap.append(table)
  return wrap
}

function ratesKindCell(value, label) {
  const cell = element("td", "right mono", formatTokensPer(value))
  cell.dataset.label = label
  return cell
}

function ratesNotes(response) {
  const box = element("div", "rates-notes")
  const clock = element("p", "provider-dim-note")
  clock.textContent =
    "Follows the clock: the allowance is dollars at the model's official API price, so peak hours " +
    "(01:00-04:00 and 06:00-10:00 UTC, Monday to Friday) buy half as many tokens."
  const flatNote = element("p", "provider-dim-note")
  flatNote.textContent =
    "One flat card: the provider meters tokens at its own per-token prices, which do not move " +
    "with DeepSeek's clock. That is why the same plan's rate is identical at peak and off-peak."
  box.append(clock, flatNote)

  const skipped = Array.isArray(response.skipped) ? response.skipped : []
  if (skipped.length > 0) {
    const note = element("p", "provider-dim-note")
    note.textContent = `No plan price and published allowance, so not compared: ${skipped.join(", ")}.`
    box.append(note)
  }

  const sources = [...new Set((Array.isArray(response.rows) ? response.rows : []).map((row) => row.source))]
  if (sources.length > 0) box.append(element("p", "allowance-source", `Allowances from ${sources.join(" · ")}`))
  return box
}

// Token counts run to the billions here, so a plain integer would be unreadable
// and would widen the column past what a phone can show.
function formatTokensPer(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (value === 0) return "0"
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ]
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(2)}${suffix}`
    }
  }
  return formatInt(value)
}

/** Repaint only the selected provider's panel, leaving the tab strip and its focus alone. */
function renderProviderDetail(container, rows) {
  container.replaceChildren()
  const selected = selectProvider(rows)
  if (selected !== null) container.append(providerDetail(selected, rows))
}

// A tab per provider. The selected provider gets the detail panel; the tabs are
// the only thing that changes when switching, so this never refetches.
function providerTabStrip(rows, detail, allRows) {
  const strip = element("div", "segmented provider-tabs", "")
  strip.setAttribute("role", "tablist")
  strip.setAttribute("aria-label", "Provider")
  for (const row of rows) {
    const id = row.providerID ?? "unknown"
    const button = element("button", "", row.label || id)
    button.type = "button"
    button.dataset.provider = id
    button.setAttribute("role", "tab")
    const active = id === selectProvider(rows)?.providerID
    button.classList.toggle("is-active", active)
    button.setAttribute("aria-selected", active ? "true" : "false")
    button.addEventListener("click", () => {
      if (state.provider === id) return
      state.provider = id
      history.pushState(null, "", urlForState())
      // Repaint the tab state and the detail panel only, so the focused tab
      // button survives the switch for keyboard users.
      for (const other of strip.querySelectorAll("button")) {
        const isActive = other.dataset.provider === id
        other.classList.toggle("is-active", isActive)
        other.setAttribute("aria-selected", isActive ? "true" : "false")
      }
      renderProviderDetail(detail, allRows)
    })
    strip.append(button)
  }
  return strip
}

// Keep the open tab when it still has calls, otherwise fall back to the first
// provider so a window change cannot leave an empty panel.
function selectProvider(rows) {
  const chosen = rows.find((row) => (row.providerID ?? "unknown") === state.provider)
  return chosen ?? rows[0] ?? null
}

function providerRows(response) {
  return Array.isArray(response.rows) ? response.rows : []
}

// Surfaced on the provider page itself, so a broken plans file cannot silently
// show zero spend.
function planErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null
  const note = element("div", "banner banner-warn")
  note.textContent = `Plan file problems: ${errors.join(" · ")}`
  return note
}

function providerDetail(row, rows) {
  const section = element("section", "provider-card")
  const head = element("div", "provider-head")
  head.append(
    element("span", "provider-name", row.label || row.providerID || "unknown"),
    element("span", "provider-id", row.providerID || "unknown"),
  )
  if (!((row.spendUSD ?? 0) > 0)) head.append(element("span", "provider-note", "no plan price configured"))

  // These four figures are only meaningful next to what they measure. The
  // subtitles are plain text rather than tooltips because a phone has no hover;
  // previously they were `title` attributes and silently unreadable there.
  const figures = element("div", "provider-figures")
  figures.append(
    providerFigure(
      "Plan cost",
      formatCost(row.spendUSD),
      null,
      `the plan fee for ${formatInt(row.paidDays)} days of this window`,
    ),
    providerFigure(
      "API list",
      formatCost(row.meteredUSD),
      null,
      "what these tokens would cost at DeepSeek list price",
    ),
  )
  if (typeof row.valueRatio === "number" && Number.isFinite(row.valueRatio)) {
    const ratio = row.valueRatio
    figures.append(
      providerFigure(
        "List ÷ plan",
        `${ratio.toFixed(2)}×`,
        ratio >= 1 ? "is-good" : "is-bad",
        ratio >= 1 ? "the plan is cheaper than list" : "the plan costs more than list",
      ),
    )
  }
  figures.append(
    providerFigure("Plan ÷ 1M", formatUnitRate(row.paid?.blended), null, "plan fee spread across every token"),
  )
  head.append(figures)
  section.append(head)

  const body = element("div", "provider-body")
  const status = providerStatus(row.providerID)
  if (status !== null) body.append(status)
  const rates = providerRates(row)
  if (rates !== null) body.append(rates)
  body.append(providerModels(row))
  section.append(body)
  return section
}

// Live upstream status. This is the provider's own accounting: the advertised
// allowance, the percentage it says is used, and the same spend measured from
// this machine's records. The two rarely agree, and that gap is the point --
// it is usage against the same key that this tracker never saw.
function providerStatus(providerID) {
  // A recorded provider id can differ from the integration that owns its
  // credential (OpenCode records `opencode-go` but bills under `opencode`).
  const integration = lastQuotas?.aliases?.[providerID] ?? providerID
  const status = lastQuotas?.results?.[integration]
  const advertised = lastQuotas?.advertised?.[integration]
  if (status === undefined && advertised === undefined) return null

  const node = element("div", "provider-status")
  node.append(element("div", "provider-bucket-title", "Live status"))

  if (status !== undefined) {
    if (status.state !== "ok") {
      // With published limits but no usage API, only the percentages are
      // missing; the allowance below is still real.
      const note =
        advertised === undefined
          ? status.reason
          : `${status.reason}. Live percentages are unavailable, so the caps below are published limits only.`
      node.append(element("p", "provider-status-note", note))
      if (advertised === undefined) return node
    } else {
      const facts = []
      if (status.plan !== null) facts.push(`Plan: ${status.plan}`)
      if (status.account !== null) facts.push(status.account)
      facts.push(...status.notes)
      if (facts.length > 0) node.append(element("p", "provider-status-note", facts.join(" · ")))
      for (const budget of status.budgets) node.append(budgetMeter(budget))
    }
  }

  if (advertised !== undefined) node.append(advertisedQuotas(advertised))
  return node
}

// The advertised allowance and the window percentages, each with the dollars it
// represents. Percentages are the provider's; the dollar caps are published.
function advertisedQuotas(quota) {
  const wrap = element("div", "allowance")
  const head = element("div", "allowance-head")
  const title = element("div", "allowance-title", "Advertised allowance")
  const price = element("span", "allowance-price", `$${formatNumber(quota.monthlyUSD)}/mo`)
  head.append(title, price)
  wrap.append(head)

  if (quota.allowanceUSD !== null) {
    const note = element("p", "provider-status-note")
    note.textContent =
      `$${formatNumber(quota.allowanceUSD)} of usage per month` +
      (quota.monthlyCreditsUSD !== null ? ` (${formatNumber(quota.monthlyCreditsUSD)} credits)` : "") +
      (quota.allowanceModel !== null ? ` · ${quota.allowanceModel}` : "")
    wrap.append(note)
    // Mixed-model windows have no single published allowance, so the figure is
    // the dominant model's and the label says so.
    if (quota.mixedModels)
      wrap.append(
        element(
          "p",
          "allowance-caveat",
          "Estimate: this window mixed models with different allowances, so the dollars use the model that spent the most.",
        ),
      )
  } else {
    wrap.append(element("p", "provider-status-note", "No published allowance for these models."))
  }

  for (const window of quota.windows) wrap.append(advertisedWindow(window))
  wrap.append(spendReconciliation(quota))
  wrap.append(element("p", "allowance-source", `Limits from ${quota.source}`))
  return wrap
}

function advertisedWindow(window) {
  const row = element("div", "quota")
  const head = element("div", "quota-head")
  head.append(element("span", "quota-label", window.label))

  const percent = window.upstreamPercent
  const exhausted = percent !== null && percent >= 100
  const near = percent !== null && percent >= 90
  head.append(
    element(
      "span",
      `quota-value${exhausted || near ? " is-bad" : percent !== null && percent >= 75 ? " is-warn" : ""}`,
      percent === null ? "—" : `${percent}%`,
    ),
  )
  row.append(head)

  if (percent !== null) {
    const bar = element("div", "quota-bar")
    const fill = element("div", "quota-fill")
    fill.style.width = `${Math.min(100, Math.max(0, percent))}%`
    if (exhausted || near) fill.classList.add("is-bad")
    else if (percent >= 75) fill.classList.add("is-warn")
    bar.append(fill)
    row.append(bar)
  }

  // The published cap, and what the percentage works out to in dollars.
  const parts = []
  if (window.capUSD !== null) parts.push(`cap $${formatNumber(window.capUSD)}`)
  if (window.upstreamUSD !== null) parts.push(`≈$${formatMoney(window.upstreamUSD)} used`)
  if (window.resetsAt !== null) parts.push(`resets ${relativeTime(window.resetsAt)}`)
  if (parts.length > 0) row.append(element("div", "quota-reset", parts.join(" · ")))
  return row
}

// This machine's meter reading next to the provider's own figure, so the
// difference is visible rather than implied.
function spendReconciliation(quota) {
  const wrap = element("div", "reconcile")
  const metered = quota.monthlyCreditsUSD !== null
  const recorded = element("div", "reconcile-row")
  recorded.append(
    element("span", "reconcile-label", "This machine"),
    element(
      "span",
      "reconcile-value",
      metered ? `$${formatMoney(quota.creditsUSD)} credits` : `$${formatMoney(quota.recordedUSD)} recorded`,
    ),
  )
  wrap.append(recorded)

  if (metered) {
    // The card is the meter. Spell out that the per-model multiplier is an
    // entitlement on the published monthly usage, not a per-call discount: a
    // lower multiplier means *more* usage against the same pool.
    const note = element("p", "allowance-caveat allowance-multiplier")
    note.textContent =
      quota.multiplier === null
        ? "Priced from tokens at the plan's own card. The per-model multiplier only changes how far the shared pool reaches."
        : `${quota.allowanceModel ?? quota.models.join(", ")} has a ${formatMultiplier(
            quota.multiplier,
          )} credit multiplier, so the pool buys ${formatMultiplier(
            1 / quota.multiplier,
          )} the usage of a 1× model. Calls are priced from tokens at the same card.`
    wrap.append(note)
  }

  if (quota.unmeteredUSD > 0) {
    const free = element("div", "reconcile-row")
    free.append(
      element("span", "reconcile-label", "Unmetered"),
      element("span", "reconcile-value", `$${formatMoney(quota.unmeteredUSD)}`),
    )
    wrap.append(free)
  }

  if (quota.unknownModels.length > 0) {
    const unknown = element("div", "reconcile-row")
    unknown.append(
      element("span", "reconcile-label", "No published rate"),
      element("span", "reconcile-value", quota.unknownModels.join(", ")),
    )
    wrap.append(unknown)
  }

  // The widest window is the account's whole picture; when it exceeds what this
  // machine recorded, the remainder was spent against the same key elsewhere.
  // Naming it is the difference between "my numbers are wrong" and "some of my
  // usage is not on the books".
  const widest = [...quota.windows].reverse().find((window) => window.upstreamUSD !== null)
  if (widest !== undefined && widest.upstreamUSD !== null) {
    const elsewhere = widest.upstreamUSD - quota.creditsUSD
    if (elsewhere > 0.01) {
      const row = element("div", "reconcile-row reconcile-gap")
      row.append(
        element("span", "reconcile-label", `Not recorded here (${widest.label.toLowerCase()})`),
        element("span", "reconcile-value", `$${formatMoney(elsewhere)}`),
      )
      row.title =
        "The provider counts this against the same allowance, but this tracker never saw the calls, so it is not in any of the figures above."
      wrap.append(row)
    }
  }
  return wrap
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

// Dollar amounts that are routinely fractions of a cent need more places than
// the main dashboard's cost formatter gives them.
function formatMoney(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (value === 0) return "0"
  if (Math.abs(value) < 0.01) return value.toFixed(4)
  return value.toFixed(2)
}

function formatMultiplier(value) {
  if (!Number.isFinite(value)) return ""
  return `${Number(value.toFixed(2))}×`
}

function budgetMeter(budget) {
  const percent = budget.limitUSD > 0 ? (budget.spentUSD / budget.limitUSD) * 100 : 0
  const row = element("div", "quota")
  const head = element("div", "quota-head")
  head.append(
    element("span", "quota-label", budget.label),
    element("span", "quota-value", `${formatCost(budget.spentUSD)} / ${formatCost(budget.limitUSD)}`),
  )
  row.append(head)
  const bar = element("div", "quota-bar")
  const fill = element("div", "quota-fill")
  fill.style.width = `${Math.min(100, percent)}%`
  if (percent >= 90) fill.classList.add("is-bad")
  else if (percent >= 75) fill.classList.add("is-warn")
  bar.append(fill)
  row.append(bar)
  if (budget.resetsAt !== null) row.append(element("div", "quota-reset", `resets ${relativeTime(budget.resetsAt)}`))
  return row
}

// Coarse on purpose: "in 3 days" is all a status panel needs, and it avoids a
// ticking clock that would re-render the page every second.
function relativeTime(at) {
  const delta = at - Date.now()
  if (delta <= 0) return "now"
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

function providerFigure(label, value, className, note) {
  const figure = element("div", "provider-figure")
  figure.append(element("div", "provider-figure-label", label))
  const valueNode = element("div", `provider-figure-value${className === null ? "" : ` ${className}`}`, value)
  figure.append(valueNode)
  if (note) {
    const noteNode = element("div", "provider-figure-note", note)
    // Keep the tooltip for pointer users who hover the label.
    figure.title = note
    figure.append(noteNode)
  }
  return figure
}

const RATE_ROWS = [
  ["Blended", "blended"],
  ["Input", "input"],
  ["Output", "output"],
  ["Cache read", "cacheRead"],
  ["Cache write", "cacheWrite"],
]

function rateGrid(paid, list, kinds) {
  const rows = []
  for (const [label, key] of RATE_ROWS) {
    if (!kinds && key !== "blended") continue
    const paidValue = paid?.[key] ?? null
    const listValue = list?.[key] ?? null
    if (paidValue === null && listValue === null) continue
    rows.push({ label, paidValue, listValue })
  }
  if (rows.length === 0) return null

  const grid = element("div", "provider-rates")
  grid.append(
    element("div", "provider-rates-head", "USD / 1M"),
    element("div", "provider-rates-head provider-rates-paid", "Paid"),
    element("div", "provider-rates-head provider-rates-list", "List"),
  )
  for (const row of rows)
    grid.append(
      element("div", "provider-rates-label", row.label),
      element("div", "provider-rates-paid", formatUnitRate(row.paidValue)),
      element("div", "provider-rates-list", formatUnitRate(row.listValue)),
    )
  return grid
}

function providerRates(row) {
  const peak = row.peak ?? {}
  const offPeak = row.offPeak ?? {}
  const buckets = [providerBucket("All calls", { calls: row.calls, paid: row.paid, metered: row.metered }, null, true)]
  if (peak.listUSD !== null || offPeak.listUSD !== null)
    buckets.push(
      providerBucket("Peak", peak, "published peak hours", false),
      providerBucket("Off-peak", offPeak, "standard rate", false),
    )
  const present = buckets.filter((bucket) => bucket !== null)
  if (present.length === 0) return null
  const container = element("div", "provider-split")
  container.append(...present)
  return container
}

function providerBucket(title, bucket, note, kinds) {
  const node = element("div", "provider-bucket")
  const heading = element("div", "provider-bucket-title", title)
  heading.append(
    element("span", "provider-bucket-note", `${formatInt(bucket.calls ?? 0)} calls${note === null ? "" : ` · ${note}`}`),
  )
  const grid = rateGrid(bucket.paid, bucket.metered, kinds)
  if (grid === null) return null
  node.append(heading, grid)
  return node
}

function providerModels(row) {
  const models = Array.isArray(row.models) ? row.models : []
  if (models.length === 0) return element("p", "provider-empty", "No models recorded in this window.")
  // Every call lands off-peak when the plan has no windows, so the column would
  // read "0 / N" for every row and carry no information.
  const split = models.some((model) => (model.peakCalls ?? 0) > 0)
  const wrap = element("div", "table-wrap provider-models")
  const table = element("table", "data-table")
  table.append(element("caption", "visually-hidden", "Models for this provider"))

  const head = document.createElement("thead")
  const headRow = document.createElement("tr")
  // Column classes let the narrow layout drop the least essential columns
  // instead of scrolling the table sideways.
  const columns = [
    ["Model", ""],
    ["Calls", "right"],
    ["Input", "right col-narrow"],
    ["Output", "right"],
    ["Cache read", "right col-optional"],
    ["List cost", "right"],
  ]
  if (split) columns.splice(2, 0, ["Peak / off", "right col-optional"])
  for (const [label, className] of columns) headRow.append(element("th", className, label))
  head.append(headRow)

  const tbody = document.createElement("tbody")
  for (const model of models) {
    const tr = document.createElement("tr")
    const cells = [
      element("td", "mono", model.modelID ?? "unknown"),
      element("td", "right", formatInt(model.calls)),
      element("td", "right col-narrow", formatInt(model.tokens?.input)),
      element("td", "right", formatInt((model.tokens?.output ?? 0) + (model.tokens?.reasoning ?? 0))),
      element("td", "right col-optional", formatInt(model.tokens?.cacheRead)),
      element("td", "right", formatCost(model.meteredUSD)),
    ]
    if (split)
      cells.splice(
        2,
        0,
        element("td", "right col-optional", `${formatInt(model.peakCalls)} / ${formatInt(model.offPeakCalls)}`),
      )
    tr.append(...cells)
    tbody.append(tr)
  }
  table.append(head, tbody)
  wrap.append(table)
  return wrap
}

function formatUnitRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (value === 0) return "$0"
  if (Math.abs(value) < 0.0001) return `$${value.toExponential(2)}`
  if (Math.abs(value) < 0.01) return `$${value.toFixed(5)}`
  if (Math.abs(value) < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function renderPivot(pivot) {
  lastPivot = pivot
  renderPivotChart(pivot)
  renderPivotTable(pivot)
}

function renderPivotChart(pivot) {
  const rows = Array.isArray(pivot.rows) ? pivot.rows : []
  const columns = pivotColumns(pivot)
  const metric = pivot.metric ?? state.metric
  const message = "No recorded calls in this window."
  pivotLegend.replaceChildren()
  if (rows.length === 0) {
    pivotLegend.hidden = true
    chartEmpty(pivotChart, message)
    return
  }

  const totals = rows.map((row) => finiteNumber(row.total))
  const max = Math.max(...totals, 0)
  if (max <= 0) {
    pivotLegend.hidden = true
    chartEmpty(pivotChart, `No ${metric} recorded in this window.`)
    return
  }

  const frame = chartFrame(pivotChart, rows, message, 18)
  if (frame === null) return
  const yMax = max * 1.15
  const { svg, width, left, right, top, plotHeight } = frame
  drawGrid(svg, frame, yMax, (value) => pivotAxisValue(metric, value))
  const band = (width - left - right) / rows.length
  const barWidth = Math.min(52, Math.max(1, band * 0.72))
  rows.forEach((row, index) => {
    const values = new Map(
      (Array.isArray(row.cells) ? row.cells : []).map((entry) => [entry.key, finiteNumber(entry.value)]),
    )
    let base = 0
    for (const column of columns) {
      const value = values.get(column.key) ?? 0
      if (value <= 0) continue
      const barHeight = (value / yMax) * plotHeight
      const x = left + band * index + (band - barWidth) / 2
      const rect = svgNode("rect", {
        x,
        y: top + plotHeight - base - barHeight,
        width: barWidth,
        height: Math.max(0.5, barHeight),
        class: "pivot-bar",
        fill: colourForPivotKey(column.key),
      })
      rect.append(
        svgNode(
          "title",
          {},
          `${pivotBucketLabel(row)} · ${pivotColumnLabel(column)} · ${formatPivotValue(metric, value)}`,
        ),
      )
      svg.append(rect)
      base += barHeight
    }
  })
  drawXAxis(svg, frame, rows, (index) => left + band * index + band / 2, pivotBucketLabel)
  renderPivotLegend(columns)
}

function renderPivotLegend(columns) {
  pivotLegend.replaceChildren()
  pivotLegend.hidden = false
  for (const column of columns) {
    const entry = element("span", "pivot-legend-entry")
    entry.append(colourSwatch(colourForPivotKey(column.key)))
    const label = element("span", "pivot-legend-label", pivotColumnLabel(column))
    label.title = pivotColumnLabel(column)
    entry.append(label)
    pivotLegend.append(entry)
  }
}

function renderPivotTable(pivot) {
  pivotContainer.replaceChildren()
  const rows = Array.isArray(pivot.rows) ? pivot.rows : []
  const columns = pivotColumns(pivot)
  const metric = pivot.metric ?? state.metric
  const message = "No recorded calls in this window."
  if (rows.length === 0) {
    pivotSummary.textContent = "no buckets"
    pivotContainer.append(element("p", "empty", message))
    return
  }

  const table = element("table", "data-table pivot-table")
  table.append(element("caption", "visually-hidden", "Pivot table"))

  const thead = document.createElement("thead")
  const headRow = document.createElement("tr")
  const bucketHead = element("th", "pivot-bucket-head", "Bucket")
  headRow.append(bucketHead)
  for (const column of columns) headRow.append(pivotHeaderCell(column, pivot.by ?? state.by))
  headRow.append(element("th", "right pivot-total", "Total"))
  thead.append(headRow)

  const tbody = document.createElement("tbody")
  for (const row of rows) {
    const tr = document.createElement("tr")
    const bucket = element("td", "pivot-bucket", pivotBucketLabel(row))
    bucket.title = String(row.bucket ?? pivotBucketLabel(row))
    tr.append(bucket)
    const values = new Map(
      (Array.isArray(row.cells) ? row.cells : []).map((entry) => [entry.key, finiteNumber(entry.value)]),
    )
    for (const column of columns) tr.append(pivotValueCell(values.get(column.key) ?? 0, metric))
    tr.append(pivotValueCell(finiteNumber(row.total), metric, "pivot-total"))
    tbody.append(tr)
  }

  const tfoot = document.createElement("tfoot")
  const footRow = document.createElement("tr")
  footRow.append(element("td", "pivot-bucket", "Total"))
  for (const column of columns) footRow.append(pivotValueCell(finiteNumber(column.total), metric))
  footRow.append(pivotValueCell(finiteNumber(pivot.total), metric, "pivot-total"))
  tfoot.append(footRow)

  table.append(thead, tbody, tfoot)
  pivotContainer.append(table)
  pivotSummary.textContent = `${formatInt(rows.length)} bucket${rows.length === 1 ? "" : "s"} · ${formatInt(columns.length)} column${columns.length === 1 ? "" : "s"} · total ${formatPivotValue(metric, finiteNumber(pivot.total))}`
}

function pivotColumns(pivot) {
  return Array.isArray(pivot.columns)
    ? pivot.columns.filter((column) => column !== null && typeof column === "object")
    : []
}

function pivotHeaderCell(column, by) {
  const th = document.createElement("th")
  th.className = "pivot-column-head"
  const label = element("span", "pivot-col-label", pivotColumnLabel(column))
  label.title = pivotColumnLabel(column)
  if (by === "session" && column.key !== "__other") {
    const button = element("button", "sort-button pivot-head-button")
    button.type = "button"
    button.title = `Open session ${label.title}`
    button.append(label)
    button.addEventListener("click", () => openSession(column.key))
    th.append(button)
  } else th.append(label)
  return th
}

function pivotColumnLabel(column) {
  const label = column.label ?? column.key
  return label === undefined || label === null ? "" : String(label)
}

function pivotValueCell(value, metric, className) {
  const td = element("td", `right mono${className === undefined ? "" : ` ${className}`}`, formatPivotValue(metric, value))
  td.dataset.value = String(value)
  return td
}

function pivotBucketLabel(row) {
  const label = row.label ?? row.bucket
  return label === undefined || label === null ? "" : String(label)
}

function formatPivotValue(metric, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (metric === "cost") return formatCost(value)
  return formatInt(value)
}

function pivotAxisValue(metric, value) {
  if (metric === "cost") return axisCost(value)
  if (metric === "tokens") return formatTokens(value)
  return String(Math.round(value))
}

// FNV-1a keeps each group key's colour stable across reloads. "Other" is folded
// data rather than a real group, so it gets the neutral swatch.
function colourForPivotKey(key) {
  if (key === "__other") return OTHER_COLOUR
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return PIVOT_PALETTE[(hash >>> 0) % PIVOT_PALETTE.length]
}

function colourSwatch(colour) {
  const svg = svgNode("svg", {
    width: 10,
    height: 10,
    viewBox: "0 0 10 10",
    class: "pivot-swatch",
    "aria-hidden": "true",
  })
  svg.append(svgNode("rect", { x: 0, y: 0, width: 10, height: 10, rx: 2, fill: colour }))
  return svg
}

function renderHeatmap(heatmap) {
  heatmapContainer.replaceChildren()
  heatmapLegend.replaceChildren()
  const metric = heatmap.metric ?? state.hmetric
  const cells = Array.isArray(heatmap.cells)
    ? heatmap.cells.filter(
        (cell) =>
          cell !== null &&
          typeof cell === "object" &&
          Number.isInteger(cell.weekday) &&
          Number.isInteger(cell.hour),
      )
    : []
  if (cells.length === 0) {
    heatmapLegend.hidden = true
    heatmapSummary.textContent = metric === "calls" ? "no recorded calls" : `no ${metric} recorded`
    heatmapContainer.append(
      element(
        "p",
        "chart-empty",
        metric === "calls" ? "No recorded calls in this window." : `No ${metric} recorded in this window.`,
      ),
    )
    return
  }

  const weekdays =
    Array.isArray(heatmap.weekdays) && heatmap.weekdays.length === 7
      ? heatmap.weekdays
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  const hours =
    Array.isArray(heatmap.hours) && heatmap.hours.length === 24
      ? heatmap.hours
      : Array.from({ length: 24 }, (_, hour) => hour)
  const total = finiteNumber(heatmap.total)
  const max = finiteNumber(heatmap.max)
  const cellWidth = 26
  const cellHeight = 22
  const left = 44
  const top = 22
  const gap = 2
  const width = left + hours.length * cellWidth
  const height = top + weekdays.length * cellHeight
  const svg = svgNode("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    class: "heatmap-svg",
    role: "img",
    "aria-label": "Activity by weekday and hour",
  })

  for (const hour of hours) {
    if (hour % 3 !== 0) continue
    svg.append(
      svgNode(
        "text",
        { x: left + hour * cellWidth + cellWidth / 2, y: top - 8, class: "chart-label", "text-anchor": "middle" },
        String(hour),
      ),
    )
  }
  weekdays.forEach((weekday, index) => {
    svg.append(
      svgNode(
        "text",
        {
          x: left - 8,
          y: top + index * cellHeight + cellHeight / 2 + 3.5,
          class: "chart-label heat-weekday",
          "text-anchor": "end",
        },
        String(weekday),
      ),
    )
  })

  const values = new Map(cells.map((cell) => [`${cell.weekday}:${cell.hour}`, finiteNumber(cell.value)]))
  for (let weekday = 1; weekday <= weekdays.length; weekday += 1) {
    for (const hour of hours) {
      const value = values.get(`${weekday}:${hour}`) ?? 0
      const ratio = max > 0 ? Math.min(1, value / max) : 0
      const cell = svgNode("rect", {
        x: left + hour * cellWidth + gap / 2,
        y: top + (weekday - 1) * cellHeight + gap / 2,
        width: cellWidth - gap,
        height: cellHeight - gap,
        rx: 2,
        class: value > 0 ? "heat-cell" : "heat-cell heat-empty",
      })
      cell.setAttribute("data-weekday", String(weekday))
      cell.setAttribute("data-hour", String(hour))
      cell.setAttribute("data-value", String(value))
      if (value > 0) {
        cell.setAttribute("fill", ACCENT_COLOUR)
        cell.setAttribute("fill-opacity", (0.18 + 0.82 * ratio).toFixed(3))
      }
      cell.append(
        svgNode(
          "title",
          {},
          `${weekdays[weekday - 1]} ${String(hour).padStart(2, "0")}:00 — ${formatPivotValue(metric, value)}`,
        ),
      )
      svg.append(cell)
    }
  }
  heatmapContainer.append(svg)

  heatmapLegend.hidden = false
  heatmapLegend.append(
    element("span", "heatmap-legend-label", "low"),
    heatmapScale(),
    element("span", "heatmap-legend-label", "high"),
  )
  heatmapSummary.textContent = `window total ${formatPivotValue(metric, total)}`
}

function heatmapScale() {
  const width = 96
  const height = 10
  const steps = 9
  const svg = svgNode("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    class: "heat-swatch",
    "aria-hidden": "true",
  })
  for (let step = 0; step < steps; step += 1) {
    svg.append(
      svgNode("rect", {
        x: (width / steps) * step,
        y: 0,
        width: width / steps,
        height,
        fill: ACCENT_COLOUR,
        "fill-opacity": (0.18 + 0.82 * (step / (steps - 1))).toFixed(3),
      }),
    )
  }
  return svg
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function errorSourceCell(source) {
  const td = document.createElement("td")
  td.append(element("span", `chip chip-source-${source}`, source))
  return td
}

function errorMessageCell(message) {
  const td = element("td", "message-cell", message ?? "—")
  if (message !== null && message !== undefined) td.title = message
  return td
}

function errorShareCell(count, maximum) {
  const td = document.createElement("td")
  td.className = "right"
  const progress = document.createElement("progress")
  progress.className = "error-bar"
  progress.max = maximum
  progress.value = count
  progress.setAttribute("aria-label", `${count} of ${maximum}`)
  td.append(progress)
  return td
}

function turnColumns(sortable, includeSession) {
  const columns = [sortable ? sortHeader("Started", "started", null, "turns") : header("Started")]
  if (includeSession) columns.push(header("Session"))
  columns.push(
    header("Status"),
    header("Queue", "right"),
    sortable ? sortHeader("Round", "round", "right", "turns") : header("Round", "right"),
    header("First token", "right"),
    sortable ? sortHeader("Calls", "calls", "right", "turns") : header("Calls", "right"),
    sortable ? sortHeader("Cost", "cost", "right", "turns") : header("Cost", "right"),
    header("Retries", "right"),
    header("Error"),
  )
  return columns
}

function turnRows(rows, includeSession, activate) {
  return rows.map((row) => {
    const cells = [cell(formatDateTime(row.startedAt))]
    if (includeSession) cells.push(turnSessionCell(row))
    cells.push(
      turnStatusCell(row),
      cell(formatDuration(row.queueMs), "right mono"),
      cell(formatDuration(row.roundMs), "right mono"),
      cell(formatDuration(row.firstTokenMs), "right mono"),
      cell(formatInt(row.calls), "right mono"),
      cell(formatCost(row.costUSD), "right mono"),
      cell(row.retries > 0 ? formatInt(row.retries) : "—", "right mono"),
      turnErrorCell(row),
    )
    const className =
      row.status === "failed"
        ? "row-failed"
        : row.status === "running"
          ? "row-live"
          : row.status === "stale"
            ? "row-stale"
            : undefined
    return {
      className,
      cells,
      activate: activate ? () => openTurn(row.turnID) : undefined,
      ariaLabel: activate ? `Open round ${row.turnID}` : undefined,
    }
  })
}

function turnStatusCell(row) {
  const td = document.createElement("td")
  td.append(element("span", `chip chip-${row.status}`, row.status))
  if (row.timeout) td.append(element("span", "badge badge-timeout", "timeout"))
  return td
}

function turnErrorCell(row) {
  const td = document.createElement("td")
  const type = row.errorType ?? (row.timeout ? "provider.timeout" : null)
  const text = type ?? (row.interruptReason !== null ? `interrupted (${row.interruptReason})` : "—")
  td.textContent = text
  if (row.errorMessage !== null) td.title = row.errorMessage
  else if (row.interruptReason !== null) td.title = `interrupt reason: ${row.interruptReason}`
  return td
}

function turnSessionCell(row) {
  const td = document.createElement("td")
  td.className = "mono"
  td.title = row.sessionID
  td.append(document.createTextNode(row.session))
  if (row.title !== null) td.append(element("span", "cell-sub", ` ${row.title}`))
  if (row.internal) td.append(badge("test"))
  return td
}

function renderDetail(response) {
  const session = response.session
  detail.hidden = false
  detailBackdrop.hidden = false
  detailTitle.replaceChildren()
  detailTitle.append(document.createTextNode(session.title ?? "Untitled session"))
  if (session.internal) detailTitle.append(badge("test"))
  detailId.textContent = session.sessionID

  detailBody.replaceChildren()
  const stats = element("div", "detail-stats")
  const entries = [
    ["Cost", formatCost(session.costUSD)],
    ["Recorded calls", formatInt(session.calls)],
    ["Rounds", formatInt(response.roundTotal)],
    ["Tokens in/out/think", `${formatTokens(session.tokens.input)} / ${formatTokens(session.tokens.output)} / ${formatTokens(session.tokens.reasoning)}`],
    ["Cache r/w", `${formatTokens(session.tokens.cacheRead)} / ${formatTokens(session.tokens.cacheWrite)}`],
    ["Avg TTFT", formatDuration(session.avgTTFT)],
    ["Avg TPS", formatTPS(session.avgTPS)],
    ["Updated", formatDateTime(session.updatedAt)],
  ]
  for (const [label, value] of entries) {
    const stat = element("div", "stat")
    stat.append(element("span", "stat-label", label), element("span", "stat-value", value))
    stats.append(stat)
  }
  detailBody.append(stats)

  detailBody.append(element("h3", "detail-subtitle", `Rounds (${formatInt(response.roundTotal)})`))
  if (response.rounds.length === 0) {
    detailBody.append(element("p", "empty", "No recorded rounds for this session in this window."))
  } else {
    const roundWrap = element("div", "table-wrap detail-rounds")
    roundWrap.append(buildTable(turnColumns(false, false), turnRows(response.rounds, false, true), "Session rounds"))
    detailBody.append(roundWrap)
  }

  detailBody.append(element("h3", "detail-subtitle", `Calls (${formatInt(response.callTotal)})`))
  if (response.calls.length === 0) {
    detailBody.append(element("p", "empty", "No recorded calls for this session in this window."))
    return
  }
  const wrap = element("div", "table-wrap")
  wrap.append(buildTable(callColumns(false), callRows(response.calls), "Session calls"))
  detailBody.append(wrap)
}

function renderTurnDetail(response) {
  const turn = response.turn
  detail.hidden = false
  detailBackdrop.hidden = false
  detailTitle.replaceChildren()
  detailTitle.append(document.createTextNode(turn.title ?? "Round"))
  if (turn.internal) detailTitle.append(badge("test"))
  detailId.textContent = turn.turnID

  detailBody.replaceChildren()
  const stats = element("div", "detail-stats")
  const entries = [
    ["Status", turn.status],
    ["Session", turn.session],
    ["Started", formatDateTime(turn.startedAt)],
    ["Queue", formatDuration(turn.queueMs)],
    ["Round", formatDuration(turn.roundMs)],
    ["First token", formatDuration(turn.firstTokenMs)],
    ["Calls", formatInt(turn.calls)],
    ["Cost", formatCost(turn.costUSD)],
    ["Tokens in/out/think", `${formatTokens(turn.tokens.input)} / ${formatTokens(turn.tokens.output)} / ${formatTokens(turn.tokens.reasoning)}`],
    ["Cache r/w", `${formatTokens(turn.tokens.cacheRead)} / ${formatTokens(turn.tokens.cacheWrite)}`],
    ["Prompts / steers", `${formatInt(turn.prompts)} / ${formatInt(turn.steers)}`],
    ["Compactions", formatInt(turn.compactions)],
    ["Retries", formatInt(turn.retries)],
    ["Error", turn.errorType ?? (turn.timeout ? "provider.timeout" : "—")],
  ]
  if (turn.interruptReason !== null) entries.push(["Interrupt reason", turn.interruptReason])
  if (turn.errorStatus !== null) entries.push(["Error status", String(turn.errorStatus)])
  for (const [label, value] of entries) {
    const stat = element("div", "stat")
    stat.append(element("span", "stat-label", label), element("span", "stat-value", value))
    stats.append(stat)
  }
  detailBody.append(stats)

  if (turn.errorMessage !== null) {
    const note = element("p", "detail-note", turn.errorMessage)
    detailBody.append(note)
  }

  detailBody.append(element("h3", "detail-subtitle", `Calls (${formatInt(response.callTotal)})`))
  if (response.calls.length === 0) {
    detailBody.append(element("p", "empty", "No recorded calls for this round in this window."))
    return
  }
  const wrap = element("div", "table-wrap")
  wrap.append(buildTable(callColumns(false), callRows(response.calls), "Round calls"))
  detailBody.append(wrap)
}

function renderTurnDetailError(error) {
  detail.hidden = false
  detailBackdrop.hidden = false
  detailTitle.textContent = "Round"
  detailId.textContent = state.turn ?? ""
  detailBody.replaceChildren()
  const message =
    error instanceof ApiError && error.status === 404
      ? "Round not found. It may be hidden as internal test data, or it no longer exists."
      : errorMessage(error)
  detailBody.append(element("p", "empty", message))
}

function renderDetailError(error) {
  detail.hidden = false
  detailBackdrop.hidden = false
  detailTitle.textContent = "Session"
  detailId.textContent = state.session ?? ""
  detailBody.replaceChildren()
  const message =
    error instanceof ApiError && error.status === 404
      ? "Session not found. It may be hidden as internal test data, or it no longer exists."
      : errorMessage(error)
  detailBody.append(element("p", "empty", message))
}

function closeDetailPanel() {
  detail.hidden = true
  detailBackdrop.hidden = true
  detailBody.replaceChildren()
}

function openSession(sessionID) {
  state.session = sessionID
  state.turn = null
  commit(true)
}

function openTurn(turnID) {
  state.turn = turnID
  state.session = null
  commit(true)
}

function sessionColumns() {
  return [
    header("Session"),
    header("Title"),
    header("Calls", "right"),
    sortHeader("Tokens in/out/think", "tokens", "right", "sessions"),
    header("Cache r/w", "right"),
    sortHeader("Cost", "cost", "right", "sessions"),
    sortHeader("TTFT", "ttft", "right", "sessions"),
    sortHeader("TPS", "tps", "right", "sessions"),
    sortHeader("Updated", "updated", null, "sessions"),
  ]
}

function callColumns(sortable) {
  return [
    sortable ? sortHeader("Started", "started", null, "calls") : header("Started"),
    header("Session"),
    header("Model"),
    header("Agent"),
    header("Tokens in/out/think", "right"),
    header("Cache r/w", "right"),
    sortable ? sortHeader("Cost", "cost", "right", "calls") : header("Cost", "right"),
    sortable ? sortHeader("TTFT", "ttft", "right", "calls") : header("TTFT", "right"),
    header("TTFA", "right"),
    sortable ? sortHeader("TPS", "tps", "right", "calls") : header("TPS", "right"),
    header("E2E", "right"),
    header("Status"),
    header("Retry", "right"),
    header("Error"),
  ]
}

function header(label, align) {
  return { label, align }
}

function sortHeader(label, sort, align, table) {
  const config =
    table === "sessions"
      ? { sort: "sessionsSort", dir: "sessionsDir", offset: null }
      : table === "turns"
        ? { sort: "turnsSort", dir: "turnsDir", offset: "turnsOffset" }
        : { sort: "callsSort", dir: "callsDir", offset: "offset" }
  const active = state[config.sort] === sort
  const direction = state[config.dir]
  return {
    label,
    align,
    sort,
    active,
    direction,
    onSort: () => {
      state[config.dir] = state[config.sort] === sort ? (state[config.dir] === "desc" ? "asc" : "desc") : "desc"
      state[config.sort] = sort
      if (config.offset !== null) state[config.offset] = 0
      commit(true)
    },
  }
}

function callRows(rows) {
  return rows.map((row) => {
    const statusLabel = row.kind === "compaction"
      ? row.status === "completed" ? "compaction" : `${row.status} (compaction)`
      : row.status
    const chipClass = row.kind === "compaction" ? "compaction" : row.status
    const status = element("span", `chip chip-${chipClass}`, statusLabel)
    if (row.error) status.title = row.error
    const statusCell = document.createElement("td")
    statusCell.append(status)

    return {
      className:
        row.kind === "compaction" ? "row-compaction" : row.status === "failed" ? "row-failed" : undefined,
      cells: [
        cell(formatDateTime(row.startedAt)),
        callSessionCell(row),
        cell(row.model ?? "—", "mono"),
        cell(row.agent ?? "—"),
        cell(`${formatTokens(row.tokens.input)} / ${formatTokens(row.tokens.output)} / ${formatTokens(row.tokens.reasoning)}`, "right mono"),
        cell(`${formatTokens(row.tokens.cacheRead)} / ${formatTokens(row.tokens.cacheWrite)}`, "right mono"),
        cell(formatCost(row.costUSD), "right mono"),
        cell(formatDuration(row.ttft), "right mono"),
        cell(formatDuration(row.ttfa), "right mono"),
        cell(formatTPS(row.tps), "right mono"),
        cell(formatDuration(row.e2e), "right mono"),
        statusCell,
        cell(row.retries > 0 ? formatInt(row.retries) : "—", "right mono"),
        callErrorCell(row),
      ],
    }
  })
}

function callErrorCell(row) {
  const td = document.createElement("td")
  td.textContent = row.errorType ?? "—"
  if (row.errorMessage !== null && row.errorMessage !== undefined) td.title = row.errorMessage
  else if (row.error !== null && row.error !== undefined) td.title = row.error
  return td
}

function callSessionCell(row) {
  const td = document.createElement("td")
  td.className = "mono"
  td.title = row.sessionID
  td.append(document.createTextNode(row.sessionID === null ? "—" : row.session))
  if (row.internal) td.append(badge("test"))
  return td
}

function sessionIDCell(sessionID, short) {
  const td = document.createElement("td")
  td.className = "mono"
  td.title = sessionID
  td.textContent = short
  return td
}

function titleCell(title, internal) {
  const td = document.createElement("td")
  td.append(document.createTextNode(title ?? "Untitled session"))
  if (internal) td.append(badge("test"))
  return td
}

function badge(text) {
  return element("span", "badge", text)
}

function cell(content, className) {
  const td = document.createElement("td")
  if (className) td.className = className
  td.textContent = content
  return td
}

function buildTable(columns, rows, caption) {
  const table = element("table", "data-table")
  const captionNode = element("caption", "visually-hidden", caption)
  const thead = document.createElement("thead")
  const headRow = document.createElement("tr")
  for (const column of columns) {
    const th = document.createElement("th")
    if (column.align) th.className = column.align
    if (column.sort) {
      th.setAttribute("aria-sort", column.active ? (column.direction === "asc" ? "ascending" : "descending") : "none")
      const button = element("button", "sort-button", column.label)
      button.type = "button"
      if (column.active) button.append(element("span", "sort-arrow", column.direction === "asc" ? "▲" : "▼"))
      button.addEventListener("click", column.onSort)
      th.append(button)
    } else {
      th.textContent = column.label
    }
    headRow.append(th)
  }
  thead.append(headRow)

  const tbody = document.createElement("tbody")
  for (const row of rows) {
    const tr = document.createElement("tr")
    if (row.className) tr.className = row.className
    for (const value of row.cells) tr.append(value)
    if (row.activate) {
      tr.tabIndex = 0
      tr.classList.add("clickable")
      if (row.ariaLabel) tr.setAttribute("aria-label", row.ariaLabel)
      tr.addEventListener("click", row.activate)
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          row.activate()
        }
      })
    }
    tbody.append(tr)
  }
  table.append(captionNode, thead, tbody)
  return table
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}

async function copySummary() {
  if (lastOverview === null) return
  const totals = lastOverview.totals
  const rounds = lastOverview.rounds ?? {}
  const roundMs = rounds.roundMs ?? {}
  const text = summarize({
    since: lastOverview.range.label,
    model: lastOverview.model,
    calls: totals.calls,
    costUSD: totals.costUSD,
    tokens: totals.tokens.total,
    ttftAvg: lastOverview.sidecar.avgTTFT,
    ttftP95: lastOverview.sidecar.p95TTFT,
    tps: lastOverview.sidecar.avgTPS,
    cacheHitRate: totals.cacheHitRate,
    rounds: rounds.total,
    roundP50: roundMs.p50,
    callErrorRate: lastOverview.callErrors?.rate ?? null,
    failedCalls: lastOverview.callErrors?.failed ?? null,
    interruptedCalls: lastOverview.callErrors?.interrupted ?? null,
    timeouts: rounds.timeouts,
    retries: rounds.retries,
  })
  copySummaryStatus.textContent = ""
  const copied = await writeClipboard(text)
  copySummaryButton.focus()
  if (!copied) {
    showError("Could not copy the summary to the clipboard.")
    return
  }
  copySummaryStatus.textContent = "Summary copied to clipboard."
  copySummaryButton.textContent = "Copied"
  if (copyLabelTimer !== null) clearTimeout(copyLabelTimer)
  copyLabelTimer = setTimeout(() => {
    copyLabelTimer = null
    copySummaryButton.textContent = "Copy summary"
  }, 1500)
}

async function writeClipboard(text) {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the textarea path below.
  }
  return copyWithTextarea(text)
}

function copyWithTextarea(text) {
  if (typeof document.execCommand !== "function") return false
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.top = "0"
  area.style.left = "0"
  area.style.opacity = "0"
  document.body.append(area)
  area.select()
  try {
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    area.remove()
  }
}

function showError(message) {
  errorBox.hidden = false
  errorBox.textContent = message
}

function hideError() {
  errorBox.hidden = true
  errorBox.textContent = ""
}

function errorMessage(error) {
  if (error instanceof Error && error.message.length > 0) return error.message
  return "Request failed"
}

function renderCharts(overview) {
  const series = overview.series ?? []
  renderCostChart(chartCost, series)
  renderTokenChart(chartTokens, series)
  renderLineChart(
    chartTtft,
    series,
    [
      { key: "avgTTFT", className: "line-avg", label: "avg", format: formatDuration },
      { key: "p50TTFT", className: "line-p50", label: "p50", format: formatDuration },
      { key: "p95TTFT", className: "line-p95", label: "p95", format: formatDuration },
    ],
    formatDuration,
    "No latency recorded in this window.",
  )
  renderLineChart(
    chartTps,
    series,
    [
      { key: "avgTPS", className: "line-avg", label: "avg", format: formatTPS },
      { key: "p50TPS", className: "line-p50", label: "p50", format: formatTPS },
      { key: "p95TPS", className: "line-p95", label: "p95", format: formatTPS },
    ],
    (value) => String(Math.round(value)),
    "No TPS recorded in this window.",
  )
  const roundSeries = (overview.roundSeries ?? []).map((point) => ({ ...point, day: point.date }))
  renderLineChart(
    chartRounds,
    roundSeries,
    [
      { key: "roundMsAvg", className: "line-avg", label: "avg", format: exactDuration },
      { key: "roundMsP50", className: "line-p50", label: "p50", format: exactDuration },
      { key: "roundMsP95", className: "line-p95", label: "p95", format: exactDuration },
    ],
    formatDuration,
    "No completed rounds in this window.",
  )
  const errorSeries = (overview.errorSeries ?? []).map((point) => ({ ...point, day: point.date }))
  const errorTotal = errorSeries.reduce((total, point) => total + point.call + point.turn, 0)
  if (errorTotal <= 0) chartEmpty(chartErrors, "No errors recorded in this window.")
  else
    renderLineChart(
      chartErrors,
      errorSeries,
      [
        { key: "call", className: "line-call-error", label: "calls", format: formatInt },
        { key: "turn", className: "line-turn-error", label: "rounds", format: formatInt },
      ],
      (value) => String(Math.round(value)),
      "No errors recorded in this window.",
    )
}

function renderCostChart(container, series) {
  const frame = chartFrame(container, series, "No cost recorded in this window.", 18)
  if (frame === null) return
  const values = series.map((point) => point.costUSD)
  const max = Math.max(...values, 0)
  if (max <= 0) {
    chartEmpty(container, "No cost recorded in this window.")
    return
  }
  const yMax = max * 1.15
  const { svg, width, height, left, right, top, plotHeight } = frame
  drawGrid(svg, frame, yMax, (value) => axisCost(value))
  const band = (width - left - right) / series.length
  const barWidth = Math.min(52, Math.max(1, band * 0.72))
  series.forEach((point, index) => {
    if (point.costUSD <= 0) return
    const barHeight = (point.costUSD / yMax) * plotHeight
    const x = left + band * index + (band - barWidth) / 2
    const rect = svgNode("rect", {
      x,
      y: top + plotHeight - barHeight,
      width: barWidth,
      height: Math.max(0.5, barHeight),
      rx: 2,
      class: "bar-cost",
    })
    rect.append(svgNode("title", {}, `${point.day} · ${formatCost(point.costUSD)}`))
    svg.append(rect)
  })
  drawXAxis(svg, frame, series, (index) => left + band * index + band / 2)
}

function renderTokenChart(container, series) {
  const frame = chartFrame(container, series, "No tokens recorded in this window.", 30)
  if (frame === null) return
  const keys = [
    { key: "input", className: "bar-input", label: "input" },
    { key: "output", className: "bar-output", label: "output" },
    { key: "reasoning", className: "bar-think", label: "think" },
  ]
  const totals = series.map((point) => keyTotal(point, keys))
  const max = Math.max(...totals, 0)
  if (max <= 0) {
    chartEmpty(container, "No tokens recorded in this window.")
    return
  }
  const yMax = max * 1.15
  const { svg, width, left, right, top, plotHeight } = frame
  drawGrid(svg, frame, yMax, formatTokens)
  drawLegend(svg, left, 12, keys.map((key) => ({ className: key.className, label: key.label })))
  const band = (width - left - right) / series.length
  const barWidth = Math.min(52, Math.max(1, band * 0.72))
  series.forEach((point, index) => {
    let base = 0
    for (const key of keys) {
      const value = point.tokens[key.key]
      if (!(value > 0)) continue
      const barHeight = (value / yMax) * plotHeight
      const x = left + band * index + (band - barWidth) / 2
      const rect = svgNode("rect", {
        x,
        y: top + plotHeight - base - barHeight,
        width: barWidth,
        height: Math.max(0.5, barHeight),
        class: key.className,
      })
      rect.append(svgNode("title", {}, `${point.day} · ${key.label} ${formatTokens(value)} · total ${formatTokens(totals[index])}`))
      svg.append(rect)
      base += barHeight
    }
  })
  drawXAxis(svg, frame, series, (index) => left + band * index + band / 2)
}

function renderLineChart(container, series, lines, formatY, emptyMessage) {
  const frame = chartFrame(container, series, emptyMessage, 30)
  if (frame === null) return
  const hidden = hiddenLinesFor(container)
  const visibleLines = lines.filter((line) => !hidden.has(line.key))
  const values = []
  for (const point of series)
    for (const line of visibleLines) {
      const value = point[line.key]
      if (typeof value === "number" && Number.isFinite(value)) values.push(value)
    }
  const hasData = values.length > 0
  if (!hasData && hidden.size === 0) {
    chartEmpty(container, emptyMessage)
    return
  }
  const max = Math.max(...values, 0)
  const yMax = max > 0 ? max * 1.15 : 1
  const { svg, left, right, top, plotWidth, plotHeight } = frame
  const xAxis = (index) => (series.length === 1 ? left + plotWidth / 2 : left + (plotWidth * index) / (series.length - 1))
  drawGrid(svg, frame, yMax, formatY)
  drawLegend(
    svg,
    left,
    12,
    lines.map((line) => ({
      className: line.className,
      label: line.label,
      hidden: hidden.has(line.key),
      onToggle: () => {
        if (hidden.has(line.key)) hidden.delete(line.key)
        else hidden.add(line.key)
        renderLineChart(container, series, lines, formatY, emptyMessage)
      },
    })),
  )
  if (!hasData) {
    svg.append(
      svgNode(
        "text",
        { x: left + plotWidth / 2, y: top + plotHeight / 2, class: "chart-label", "text-anchor": "middle" },
        visibleLines.length === 0
          ? "All series hidden. Click a legend to show one."
          : "No data for the visible series. Click a legend to change it.",
      ),
    )
    drawXAxis(svg, frame, series, xAxis)
    return
  }
  for (const line of visibleLines) {
    let path = ""
    let penDown = false
    const points = []
    series.forEach((point, index) => {
      const value = point[line.key]
      if (typeof value !== "number" || !Number.isFinite(value)) {
        penDown = false
        return
      }
      const x = xAxis(index)
      const y = top + plotHeight - (value / yMax) * plotHeight
      path += `${penDown ? "L" : "M"}${x} ${y} `
      penDown = true
      const circle = svgNode("circle", { cx: x, cy: y, r: 2.5, class: line.className })
      circle.append(svgNode("title", {}, `${point.day} · ${line.label} ${line.format(value)}`))
      points.push(circle)
    })
    if (path.length > 0) svg.append(svgNode("path", { d: path.trim(), class: `${line.className} line-path` }))
    for (const circle of points) svg.append(circle)
  }
  drawXAxis(svg, frame, series, xAxis)
}

function hiddenLinesFor(container) {
  const existing = hiddenChartLines.get(container)
  if (existing !== undefined) return existing
  const created = new Set()
  hiddenChartLines.set(container, created)
  return created
}

function keyTotal(point, keys) {
  return keys.reduce((total, key) => total + point.tokens[key.key], 0)
}

function chartFrame(container, series, emptyMessage, top) {
  container.replaceChildren()
  if (series.length === 0) {
    chartEmpty(container, emptyMessage)
    return null
  }
  const width = Math.max(320, Math.round(container.clientWidth || container.parentElement?.clientWidth || 640))
  const height = 220
  const left = 62
  const right = 12
  const bottom = 30
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const svg = svgNode("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "chart",
  })
  container.append(svg)
  return { svg, width, height, left, right, top, bottom, plotWidth, plotHeight }
}

function drawGrid(svg, frame, yMax, formatY, tickCount = 4) {
  const { left, right, top, plotWidth, plotHeight } = frame
  for (let tick = 0; tick <= tickCount; tick += 1) {
    const value = (yMax * tick) / tickCount
    const y = top + plotHeight - (value / yMax) * plotHeight
    svg.append(
      svgNode("line", {
        x1: left,
        x2: left + plotWidth,
        y1: y,
        y2: y,
        class: tick === 0 ? "chart-axis" : "chart-grid",
      }),
    )
    svg.append(
      svgNode(
        "text",
        { x: left - 8, y: y + 4, class: "chart-label", "text-anchor": "end" },
        formatY(value),
      ),
    )
  }
}

function drawXAxis(svg, frame, series, xForIndex, labelOf = axisLabel) {
  const { top, plotHeight, plotWidth } = frame
  const step = axisLabelStep(series, labelOf, plotWidth)
  const lastIndex = series.length - 1
  const candidates = []
  for (let index = 0; index < series.length; index += step) candidates.push(index)
  if (candidates.at(-1) !== lastIndex) candidates.push(lastIndex)

  // Keep the final bucket labelled and drop any candidate whose estimated text
  // box would touch the previous one. The estimate is deliberately a little
  // wider than the rendered 10.5px sans text, so labels cannot overlap.
  const extent = (index) => {
    const x = xForIndex(index)
    const width = Math.max(1, labelOf(series[index]).length * 6.4)
    const left =
      series.length === 1 || (index !== 0 && index !== lastIndex) ? x - width / 2 : index === 0 ? x : x - width
    return { left, right: left + width }
  }
  const kept = []
  for (const index of candidates) {
    const current = extent(index)
    if (index === lastIndex) {
      while (kept.length > 0 && current.left < extent(kept.at(-1)).right + 6) kept.pop()
    } else if (kept.length > 0 && current.left < extent(kept.at(-1)).right + 6) continue
    kept.push(index)
  }

  for (const index of kept) {
    const point = series[index]
    if (point === undefined) continue
    const anchor = series.length === 1 ? "middle" : index === 0 ? "start" : index === lastIndex ? "end" : "middle"
    svg.append(
      svgNode(
        "text",
        { x: xForIndex(index), y: top + plotHeight + 18, class: "chart-label chart-x-label", "text-anchor": anchor },
        labelOf(point),
      ),
    )
  }
}

// Axis labels come from the API's bucket label so hourly, weekly, and monthly
// views stay meaningful. The step widens with label width so buckets past 40
// cannot collide, even when the window is narrow.
function axisLabelStep(series, labelOf, plotWidth) {
  const band = plotWidth / Math.max(1, series.length)
  let widest = 0
  for (const point of series) widest = Math.max(widest, labelOf(point).length)
  const needed = (widest * 6.4 + 10) / Math.max(band, 1)
  return Math.max(1, Math.ceil(series.length / 6), Math.ceil(needed))
}

function axisLabel(point) {
  return typeof point.label === "string" && point.label.length > 0 ? point.label : String(point.day ?? "")
}


function drawLegend(svg, x, y, entries) {
  let offset = x
  for (const entry of entries) {
    const group = svgNode("g", {
      class: entry.onToggle ? "chart-legend-entry chart-legend-toggle" : "chart-legend-entry",
      role: entry.onToggle ? "button" : undefined,
      tabindex: entry.onToggle ? "0" : undefined,
      "aria-pressed": entry.onToggle ? String(!entry.hidden) : undefined,
    })
    if (entry.onToggle) {
      group.append(svgNode("title", {}, `Click to ${entry.hidden ? "show" : "hide"} ${entry.label}`))
      group.addEventListener("click", entry.onToggle)
      group.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        entry.onToggle()
      })
    }
    const swatch = svgNode("rect", { x: offset, y: y - 6, width: 8, height: 8, rx: 1, class: entry.className })
    group.append(swatch, svgNode("text", { x: offset + 12, y: y + 3, class: "chart-legend" }, entry.label))
    if (entry.hidden) group.classList.add("is-hidden")
    svg.append(group)
    offset += 16 + entry.label.length * 6.2
  }
}

function chartEmpty(container, message) {
  container.replaceChildren()
  container.append(element("p", "chart-empty", message))
}

function svgNode(tag, attributes, text) {
  const node = document.createElementNS(SVG_NAMESPACE, tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue
    node.setAttribute(key, String(value))
  }
  if (text !== undefined) node.textContent = text
  return node
}

function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
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

function formatCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (value === 0) return "$0"
  if (Math.abs(value) < 0.001) return "<$0.001"
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
}

function axisCost(value) {
  if (value === 0) return "$0"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  if (Math.abs(value) < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function formatDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  const milliseconds = Math.max(0, value)
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`
  if (milliseconds < 3_600_000) return `${(milliseconds / 60_000).toFixed(1)}m`
  return `${(milliseconds / 3_600_000).toFixed(1)}h`
}

function exactDuration(value) {
  return `${formatDuration(value)} [${value.toFixed(1)} ms]`
}

function formatTPS(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return value.toFixed(1)
}

function formatInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return Math.round(value).toLocaleString("en-US")
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  const percentage = value * 100
  return `${percentage >= 10 ? percentage.toFixed(1) : percentage.toFixed(2)}%`
}

function formatDateTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  const date = new Date(value)
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  return `${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
