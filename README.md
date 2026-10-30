# opencode2-usage

An out-of-tree [OpenCode V2](https://opencode.ai) server plugin that records one row per LLM call and one row per execution round (`turn`) into a sidecar SQLite database. It subscribes to the live server event stream, keeps in-flight calls and rounds in memory, inserts a call row when that call finalizes, and inserts then updates the round it belongs to. It never patches OpenCode and never writes to OpenCode's own database.

The plugin is a directory with a `server.ts` entrypoint, matching the V2 plugin loader contract for local plugins.

## Install

Register the directory in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "/config/workspace/opencode2-usage",
      "options": { "dbPath": "/tmp/opencode-usage.db" }
    }
  ]
}
```

The plugin has no runtime dependencies: the host provides `@opencode/plugin` and `effect`, and `bun:sqlite` ships with Bun. Do not add those packages to this directory's `node_modules`; the host refuses to load them.

### Database path

Precedence:

1. plugin option `dbPath`
2. `OPENCODE_USAGE_DB`
3. `${XDG_DATA_HOME ?? ~/.local/share}/opencode/usage.db`

The database is opened with `PRAGMA journal_mode = WAL` and a 5 s busy timeout.

## Schema

```sql
CREATE TABLE IF NOT EXISTS call (
  call_id TEXT PRIMARY KEY,
  assistant_message_id TEXT,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  kind TEXT NOT NULL,               -- 'step' | 'compaction'
  agent TEXT,
  provider_id TEXT,
  model_id TEXT,
  model_variant TEXT,
  directory TEXT,
  started_at INTEGER,
  first_token_at INTEGER,
  first_text_at INTEGER,
  streamed_at INTEGER,
  ended_at INTEGER,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  cost_usd REAL,
  finish TEXT,
  raw_finish TEXT,
  status TEXT NOT NULL,             -- completed | failed | retried | interrupted
  error TEXT,                       -- combined 'type: message', kept for compatibility
  turn_id TEXT,                     -- session.execution.started event id; NULL when unknown
  error_type TEXT,                  -- structured SessionError.Error fields
  error_message TEXT,
  error_status INTEGER,
  error_retry_after_ms INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  last_retry_error_type TEXT,
  last_retry_at INTEGER,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_session ON call(session_id, started_at);
CREATE INDEX IF NOT EXISTS call_started ON call(started_at);
CREATE INDEX IF NOT EXISTS call_model ON call(provider_id, model_id);
CREATE INDEX IF NOT EXISTS call_turn ON call(turn_id);

CREATE TABLE IF NOT EXISTS turn (
  turn_id TEXT PRIMARY KEY,          -- session.execution.started event id
  session_id TEXT NOT NULL,
  directory TEXT,
  queued_at INTEGER,                 -- earliest inbox.enqueued in the round
  accepted_at INTEGER,               -- earliest inbox.delivered in the round
  started_at INTEGER NOT NULL,       -- execution.started event time
  ended_at INTEGER,
  status TEXT NOT NULL,              -- running | completed | failed | interrupted
  interrupt_reason TEXT,             -- user | shutdown | superseded | inactivity
  error_type TEXT,
  error_message TEXT,
  error_status INTEGER,
  prompts INTEGER NOT NULL DEFAULT 0,     -- user + synthetic deliveries
  compactions INTEGER NOT NULL DEFAULT 0, -- compaction deliveries
  steers INTEGER NOT NULL DEFAULT 0,      -- deliveries with mode "steer"
  retries INTEGER NOT NULL DEFAULT 0,     -- retry.scheduled events seen in the round
  first_token_at INTEGER,                 -- earliest first_token_at among the round's calls
  recorded_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_session ON turn(session_id, started_at);
CREATE INDEX IF NOT EXISTS turn_started ON turn(started_at);
```

All timestamps are epoch milliseconds. `started_at` is the request dispatch time from `session.step.started`; `first_token_at` is the first of text, reasoning, or tool-input start; `first_text_at` is the first `session.text.started`; `streamed_at` is the provider response-body boundary; `ended_at` is the terminal event time. `directory` is the event envelope location when present, otherwise the plugin instance's `ctx.location.directory`.

`error` keeps the historical combined `type: message` string. The `error_*` columns carry the structured `SessionError.Error`; a failure that has no status (for example `provider.transport`) leaves `error_status` NULL. `retries` counts `session.retry.scheduled` events for that attempt, so a retried attempt has `1` and the attempt after it starts again at `0`. `last_retry_at` is the retry event's scheduled `at` instant, not the time the retry was requested.

Token semantics follow OpenCode's `TokenUsage.Info`: `tokens_input` excludes cached input, `tokens_output` excludes reasoning, and `tokens_reasoning`, `tokens_cache_read`, and `tokens_cache_write` are separate.

### Errors

`session.step.failed` and `session.execution.failed` carry `SessionError.Error`, whose `type` is already classified by OpenCode. The plugin stores it verbatim, including `status` and `retryAfterMs` when the provider supplied them. The common types are `provider.rate-limit`, `provider.auth`, `provider.quota`, `provider.free-limit`, `provider.content-filter`, `provider.transport`, `provider.internal`, `provider.invalid-output`, `provider.invalid-request`, `provider.unsupported-operation`, `provider.no-route`, `provider.unknown`, and `provider.timeout`, plus `permission.rejected`, `tool.execution`, `aborted`, and `unknown`.

`provider.timeout` is the timeout signal. A timed-out step is an ordinary failed call with `error_type = 'provider.timeout'`; a round that hits its inactivity limit ends as `interrupted` with `interrupt_reason = 'inactivity'`, which is the closest round-level timeout. `user`, `shutdown`, and `superseded` interruptions are recorded the same way.

`session.compaction.failed` writes a `kind = 'compaction'` row with `status = 'failed'` and the same structured error columns, matching the `compaction.ended` shape.

### Rounds

A round is one `session.execution.started` … terminal event pair. The event id is the round identity, so every plugin instance computes the same `turn_id`. Definitions:

- `queued_at` → `started_at` is the queue wait: from the earliest inbox enqueue to execution start.
- `accepted_at` → `ended_at` is the round duration: from the first inbox delivery (falling back to execution start) to the terminal event.
- `prompts` counts `user` and `synthetic` deliveries, `compactions` counts compaction deliveries, and `steers` counts every delivery whose mode is `steer` (OpenCode steers prompts by default).
- `retries` counts retry events in the round, and `first_token_at` is the earliest first token across the round's calls.
- Calls link back through `call.turn_id`. `session.execution.started` carries no location, so a round initially falls back to the instance directory and then converges on its calls' event location as they finalize.

**A `running` round can be stale.** A plugin reload, server crash, or missed terminal event can leave a round `running` forever; there is no cleanup job. Reads must treat an old `running` turn as stale (for example, by ignoring rounds whose `started_at` is far in the past) rather than assuming it is live.

### Migration

Opening the sidecar migrates it in place. The plugin reads `PRAGMA table_info(call)` and runs `ALTER TABLE ADD COLUMN` only for missing columns, so existing rows keep their values and repeated opens are no-ops; the `turn` table and indexes use `CREATE ... IF NOT EXISTS`. Rows written before schema v2 keep their combined `error`; `error_type` is backfilled only when that string starts with a known structured type followed by `: `. Unknown prefixes stay NULL. A hot reload shares the process-wide connection registry with the generation it replaces, so the cached connection carries a schema version; when the running code expects a newer schema the store opens a fresh connection, migrates, and reprepares its statements.

## Event handling

| Event | Effect |
| --- | --- |
| `session.inbox.enqueued` | Remember the inbox item's type and delivery mode; the first enqueue outside a round supplies the next round's `queued_at`. |
| `session.inbox.delivered` | Attribute the delivery to the active round (`prompts`, `compactions`, `steers`), or collect it for the next round. |
| `session.execution.started` | Insert the round as `running`, consuming the queued/accepted times and delivery counters collected before it. |
| `session.execution.succeeded` | Mark the active round `completed` with `ended_at` and its earliest first token. |
| `session.execution.failed` | Mark the active round `failed` and store its structured error. |
| `session.execution.interrupted` | Mark the active round `interrupted` with `user`, `shutdown`, `superseded`, or `inactivity`, and finalize that session's pending call as `interrupted`. |
| `session.step.started` | Create a pending call keyed by the started event's id and linked to the active round. A retry publishes a new started event for the same assistant message, so it gets a new call id and row. |
| `session.text.started` | Set first-token and first-text timestamps once. |
| `session.reasoning.started` / `session.tool.input.started` | Set first-token once. |
| `session.step.streamed` | Set the streamed boundary. |
| `session.step.ended` | Finalize as `completed` with tokens, cost, finish, and raw finish. |
| `session.step.failed` | Finalize as `failed` with the combined `error` and the structured `error_*` fields; usage is recorded only when present. |
| `session.retry.scheduled` | Finalize the attempt as `retried` with `retries` and the retry error type/time, and increment the round's `retries`. |
| `session.compaction.ended` | Insert a `compaction` row keyed by the ended event's id, with no timings. |
| `session.compaction.failed` | Insert a failed `compaction` row with its structured error. |

Every event sweeps pending calls older than 30 minutes so dropped streams or restarts cannot leak memory. `src/reducer.ts` is a pure state machine (`state + event -> next state + rows + turn writes`), and `src/types.ts` validates every field before the reducer reads it; an event that fails validation is ignored instead of writing a partial row.

`metrics()` in `src/reducer.ts` derives TTFT/TPS with the same semantics as the app's live provider metrics: TTFT is the first token start minus dispatch, and TPS is output tokens divided by the first-text-to-streamed span in seconds, falling back to the first token when no text started. Its tests use the app's fixture and expect TTFT 300 ms and 50 TPS.

### Duplicate writers

A global plugin is instantiated once per Location, so several instances can subscribe to the same events. Call and round identity therefore comes from the event envelope: a step uses the `id` of its `session.step.started` event, a compaction uses the `id` of its terminal compaction event, and a round uses the `id` of its `session.execution.started` event. Every instance computes the same row, calls and rounds use `INSERT OR IGNORE`, so concurrent writers converge on one row per attempt and one row per round. Round progress uses `UPDATE ... WHERE turn_id = ?` with the highest counter, the earliest timestamp, and the linked call's directory, so a late or duplicated write cannot lower a peer's values. A retry publishes a new `session.step.started` event with a new id, so each attempt still gets its own row.

## CLI

The read path is a dependency-free Bun script at `cli.ts`. It opens both databases read-only, so it is safe to run while a server is writing.

```sh
bun run cli.ts <command> [flags]
```

| Command | Source | What it prints |
| --- | --- | --- |
| `calls` | Sidecar | One line per recorded call, newest first |
| `sessions` | Authoritative (plus sidecar enrichment) | Per-session totals, default last 30 days |
| `models` | Authoritative (plus sidecar enrichment) | Per-provider/model rollup, highest cost first |
| `turns` | Sidecar | One line per round, newest first |
| `errors` | Sidecar | Failed/interrupted calls and rounds grouped by error type |
| `total` | Authoritative (plus sidecar coverage) | Grand totals for the window |

```sh
bun run cli.ts calls --since 7d --limit 20
bun run cli.ts sessions --since 2026-10-01
bun run cli.ts sessions --summary --json
bun run cli.ts sessions --verbose
bun run cli.ts turns --errors
bun run cli.ts turns --status failed --limit 10
bun run cli.ts errors --turns
bun run cli.ts models --db ./usage.db --sessions-db ./opencode.db
bun run cli.ts total --since 24h --no-color
bun run cli.ts total --include-internal
```

### Databases

| Database | Default | Override |
| --- | --- | --- |
| Sidecar (`call`, `turn`) | `${XDG_DATA_HOME ?? ~/.local/share}/opencode/usage.db` | `--db`, then `OPENCODE_USAGE_DB` |
| Authoritative (`session_v2`, `session_message`) | `OPENCODE_DB` when set, otherwise the newest `opencode*.db` in `${XDG_DATA_HOME ?? ~/.local/share}/opencode/` | `--sessions-db` |

The authoritative path follows the server's own resolution order: `--sessions-db` wins, then `OPENCODE_DB` (absolute as-is; relative under the data directory), then the newest `opencode*.db` in the data directory. This matters for non-default channels, whose active database is named `opencode-<channel>.db`; the scan avoids silently reading a stale `opencode.db`. It ignores `usage.db` and `-wal`/`-shm` files.

Both are opened with `{ readonly: true }` and `PRAGMA busy_timeout = 5000`. A missing sidecar is treated as "no calls recorded yet", not an error. A missing authoritative database is an error; when the scan finds no candidate, the message names the data directory it scanned.

### Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--since <7d\|24h\|30m\|YYYY-MM-DD>` | all | Window start. Relative values use the current time; an absolute date is local midnight. |
| `--json` | all | Stable JSON envelope, no ANSI, missing values are `null`. |
| `--db <path>` | all | Sidecar path. |
| `--sessions-db <path>` | all | Authoritative path; overrides `OPENCODE_DB` and scanning. |
| `--no-color` | all | Accepted for scripts. Output is plain text anyway. |
| `--verbose` | all | Add `source: <path>` after table output. `total` always prints it. |
| `--include-internal` | all | Include sessions marked as internal test data. |
| `--session <id or prefix>` | `calls`, `turns` | Matches a full session id or any prefix, with or without `ses_`. |
| `--limit N` | `calls`, `sessions`, `turns` | Row limit. Defaults: 50 for `calls`, 20 for `sessions`, 25 for `turns`. |
| `--summary` | `sessions` | Print grand totals instead of the table; ignores `--limit`. |
| `--status <running\|stale\|completed\|failed\|interrupted>` | `turns` | Filter by the displayed round status. |
| `--errors` | `turns` | Keep rounds whose displayed status is not `completed`. |
| `--calls` | `errors` | Group call failures only. |
| `--turns` | `errors` | Group round failures only. |

Defaults: `calls`, `models`, and `total` cover all history. `sessions` defaults to the last 30 days and selects sessions by `session_v2.time_updated`; the per-session token and cost columns are that session's lifetime authoritative totals. `turns` defaults to the last 7 days and `errors` to the last 30 days. `models` and `total` apply `--since` to assistant message rows. `total` counts distinct message sessions and user prompts in the same message window.

The CLI makes the authoritative database visible. `total` always ends with `source: <path>`; `calls`, `sessions`, `models`, `turns`, and `errors` add the same line only with `--verbose`. Every JSON envelope carries `sessionsDB`.

`calls` shows `compaction` in the status column and `—` for its timings. Failed, retried, and interrupted attempts stay visible with their status. `sessions` shows `—` for average TTFT/TPS when the sidecar has no matching calls; a real zero latency remains `0ms`/`0.0`.

### Internal-test sessions

A session is internal when `session_v2.metadata` parses as a JSON object whose `oc2InternalTest` value is boolean `true`. Missing metadata, invalid JSON, and non-boolean values such as the string `"true"` are not internal. The verification harness writes `{"oc2InternalTest":true,"oc2InternalTestOrigin":"opencode2-usage verify/run.ts"}` when it creates sessions.

`calls`, `sessions`, `models`, `turns`, `errors`, and `total` hide internal-test sessions by default. Pass `--include-internal` to include them. In tables, an included session title is prefixed with `[test]`, and an included call appends `· test` to its session cell. `total` prints `excluding N internal-test sessions (use --include-internal)` only when it excluded something. A sidecar call whose session is missing from the authoritative database is not internal; deletion is not a test marker. The sidecar coverage block in `total` follows the same filter.

### Rounds and errors

A round is one `session.execution.started` … terminal event pair, keyed by its `turn_id`.

- `queue_ms = started_at - queued_at`, unavailable when the round had no enqueue before execution.
- `round_ms = ended_at - coalesce(accepted_at, started_at)`, unavailable while running.
- `first_token_ms = first_token_at - started_at`.
- Per-round `calls`, `cost_usd`, and token sums come from `call` rows with that `turn_id`.
- **timeout** means `error_type = 'provider.timeout'` or the round is `interrupted` with `interrupt_reason = 'inactivity'`.
- A round still `running` whose `updated_at` is more than one hour old is presented as `stale`, not `running`. The database is not rewritten.

`turns` lists rounds newest first with started time, session id and truncated title, status, queue, round duration, first token, prompts/steers, calls, cost, retries, and error type. Its window uses `started_at`. `--errors` keeps every round whose displayed status is not `completed`; `--status` filters the displayed status, including `stale`.

`errors` groups failed and interrupted calls and rounds by `error_type` and source. A NULL type prints as `(none)`; inactivity interruptions group as `provider.timeout`. Its window uses the call or round end time. Rows are sorted by count descending and show count, distinct sessions, first/last seen, and the latest message on one truncated line. The `SOURCE` column appears when both call and round errors are included.

`calls` ends with `RETRY` (retry count, `—` at zero) and `ERR` (effective error type, using the retry error for a retried attempt, `—` at none). `sessions` adds `ROUND` (p50 duration over completed rounds) and `ERRS` (failed plus interrupted rounds, `—` at zero). `total` adds `rounds`, `failed rounds` (status `failed` only), `timeouts`, `p95 round` over completed rounds, and `error rate` (failed plus interrupted rounds divided by all rounds).

### Formatting

- Tokens: `999`, `1.2k`, `3.4m`
- Cost: `$0` for exact zero, `<$0.001` below one tenth of a cent, otherwise four decimals
- Duration: `428ms`, `1.2s`
- TPS: one decimal, for example `50.0`
- Missing values: `—` in tables, `null` in JSON
- Tables are fixed-width, unicode-aware, and aligned with `Bun.stringWidth`

### JSON shapes

Every command emits `command`, `sessionsDB: string`, `range: { since: number | null, label: string }`, and either `rows` or `totals`.

- `calls`: `excludedInternal` plus `rows[]` with `callID`, `sessionID`, `session`, `internal`, `kind`, `status`, timestamps, `providerID`, `modelID`, `modelVariant`, `agent`, `tokens { input, output, reasoning, cacheRead, cacheWrite }`, `costUSD`, `ttft`, `ttfa`, `tps`, `e2e`, `retries`, `errorType`, `finish`, `error`.
- `sessions`: `excludedInternal` plus `rows[]` with `sessionID`, `session`, `title`, `internal`, `updatedAt`, `steps`, `tokens {...}`, `costUSD`, `recordedCalls`, `avgTTFT`, `avgTPS`, `roundP50Ms`, `failedRounds`. With `--summary`: `excludedInternal` plus `totals` with the same aggregate fields, including `excludedInternal`.
- `models`: `rows[]` with `providerID`, `modelID`, `model`, `internal`, `calls`, `sessions`, `tokens {...}`, `costUSD`, `avgTTFT`, `avgTPS`.
- `turns`: `excludedInternal` plus `rows[]` with `turnID`, `sessionID`, `session`, `title`, `status`, `internal`, `queuedAt`, `acceptedAt`, `startedAt`, `endedAt`, `queueMs`, `roundMs`, `firstTokenMs`, `prompts`, `steers`, `compactions`, `retries`, `calls`, `costUSD`, `tokens {...}`, `interruptReason`, `errorType`, `errorMessage`, `errorStatus`.
- `errors`: `rows[]` with `errorType`, `source` (`call`/`turn`), `count`, `sessions`, `firstAt`, `lastAt`, `lastMessage`.
- `total`: `totals` with `sessions`, `prompts`, `steps`, `rounds`, `failedRounds`, `timeouts`, `p95RoundMs`, `errorRate`, tokens, `costUSD`, `activeDays`, `excludedInternal`, and `sidecar { calls, firstAt, lastAt }`.

`excludedInternal` is the number of hidden internal sessions for `sessions`/`total`, or hidden internal calls for `calls`. It is `0` with `--include-internal`.

Round durations and queue/first-token values are milliseconds or `null`. `errorRate` is a 0–1 fraction. A metric that does not exist is `null`, never `0`, `NaN`, `Infinity`, or `undefined`.

### Limitation: latency coverage

**TTFT, TTFA, TPS, and E2E only exist for calls recorded while the usage plugin was running.** The plugin records live events, so it cannot reconstruct calls made before it subscribed, and the sidecar is never backfilled. `total` always prints the sidecar's recorded call count and date range so this coverage limit is explicit.

**Cost and token totals are complete for the authoritative database's history**, because they come from `session_v2` and `session_message`, not from the sidecar. `sessions` latency averages and `calls` by definition cover only sidecar-recorded calls.

**The web dashboard is recorded-call only.** Its cost, token, session, round, chart, pivot, heatmap, and latency figures all use the sidecar's `call` and `turn` rows. The authoritative database contributes only session titles, internal-test markers, and project names there, so the coverage limit applies to every number on the page.

## Web dashboard

`bun run web` serves a local, read-only dashboard on loopback. It has no build step, no third-party dependencies, and no external assets: the three files in `web/public/` render without network access beyond the local server.

```sh
bun run web
# opencode2-usage web dashboard: http://127.0.0.1:4599 (loopback only)

bun run web --port 4600 --host 127.0.0.1
bun run web --db ./usage.db --sessions-db ./opencode.db
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <number>` | `4599` | Port to listen on. `0` picks a free port. |
| `--host <address>` | `127.0.0.1` | Loopback only. `0.0.0.0` must be passed explicitly and exposes the dashboard to the network. |
| `--db <path>` | `OPENCODE_USAGE_DB`, then XDG default | Sidecar path. |
| `--sessions-db <path>` | `OPENCODE_DB`, then newest `opencode*.db` | Authoritative path. |
| `--plans <path>` | `OPENCODE_USAGE_PLANS`, then `usage-plans.json` beside the sidecar | Fixed-fee plan prices. |

Both databases are opened `{ readonly: true }` for each request and closed immediately, so new recorded calls show up on refresh without restarting the server.

The server runs the code it loaded at startup. After changing `web/` or `src/`, restart it — a long-running process keeps serving the old routes even though `web/public/` is read from disk on every request, which makes an upgrade look like a page bug. `GET /api/meta` returns a `capabilities` list of the routes the running build serves, and the page checks it **per view** before calling anything: `usage` needs the core series routes, `providers` needs `providers` and `quotas`, and `rates` needs `rates`. A server that predates this list, or one missing a route a view needs, shows that view an explicit "server is out of date" banner naming the restart command instead of a bare `unknown endpoint` — and the other views keep working. Gating the whole page on the union of every route meant adding a new tab could lock you out of pages the old server still served perfectly well. This is the actual failure mode behind that error: the dashboard runs as the `opencode2-usage` container on port 4599, so `docker restart opencode2-usage` after a change, not just `bun run web`.

### Endpoints

All responses are JSON. Every endpoint accepts `since` (`24h`, `7d`, `30d`, `90d`, `all`, or `YYYY-MM-DD`) and `includeInternal`. Unknown or malformed parameters return HTTP 400 with `{ "error": ..., "parameter": ... }`; an unknown session returns 404; unexpected failures return 500 with a short message.

| Endpoint | Filters | What it returns |
| --- | --- | --- |
| `GET /api/meta` | `since`, `includeInternal` | Resolved paths, sidecar existence, raw recorded-call count and first/last timestamps, plus the `capabilities` route list |
| `GET /api/overview` | `since`, `includeInternal`, `tz`, `granularity`, `model` | Recorded-call totals, round aggregates, sidecar aggregates, per-day series (cost, tokens, calls), per-model breakdown |
| `GET /api/sessions` | `since`, `includeInternal`, `tz`, `q`, `model`, `limit`, `sort`, `dir` | Per-session recorded-call totals: calls, tokens, cost, latency, latest call time |
| `GET /api/turns` | `since`, `includeInternal`, `session`, `model`, `status`, `onlyErrors`, `limit`, `offset`, `sort`, `dir` | Rounds plus paging `total` |
| `GET /api/errors` | `since`, `includeInternal`, `source` (`all\|call\|turn`), `model` | Errors grouped by type and source, count descending |
| `GET /api/calls` | `since`, `includeInternal`, `session`, `model`, `status`, `minTTFT`, `limit`, `offset`, `sort`, `dir` | Recorded calls plus paging `total` |
| `GET /api/session/:id` | `since`, `includeInternal`, `tz`, `model` | One session's recorded-call totals, its rounds, and its recorded calls |
| `GET /api/turn/:id` | `since`, `includeInternal` | One round's totals and its recorded calls |
| `GET /api/providers` | `since`, `includeInternal`, `tz`, `model` | Per-provider plan spend, effective USD per 1M tokens, clock split where the plan has one, per-model usage |
| `GET /api/rates` | `since`, `includeInternal`, `tz`, `model` | Tokens bought per real dollar of plan fee, split by the clock where the plan uses it, with one pooled token mix |
| `GET /api/quotas` | none | Live allowance and budget status per integration, cached for 60s; the only endpoint that calls out to the network |

Defaults mirror the CLI: `overview`, `calls`, and `turn` detail cover all history; `sessions` covers 30 days; `turns` covers 7 days; `errors` covers 30 days; `includeInternal` is off. A metric that does not exist is `null`, never `0`. Call `status` accepts the step outcomes plus `compaction`; round `status` accepts `running | stale | completed | failed | interrupted`. `onlyErrors` keeps every displayed status except `completed`.

Every number on the dashboard comes from the sidecar's recorded `call` and `turn` rows. The authoritative database only supplies display metadata: session titles, internal-test markers, and project names. `model` is always `providerID/modelID`; a value without `/` is a 400 naming `model`. It filters totals, rounds, sidecar aggregates, charts, pivot, heatmap, sessions, calls, turns, and errors.

Overview `totals` contains `calls`, `sessions` (distinct sessions with a matching recorded call), `tokens { input, output, reasoning, cache { read, write } }` plus the flat `tokensInput`… aliases, `costUSD`, `cacheHitRate`, and `excludedInternal`. The top-level `rounds` block contains `total`, `running`, `stale`, `completed`, `failed`, `interrupted`, `timeouts`, `errorRate`, `retries`, `roundMs { p50, p95, avg }`, and `firstTokenMs { p50 }`. `errorRate = (failed + interrupted) / total`, where `total` is every round that has at least one matching recorded call in the selected window and model. `interrupted` includes user aborts, shutdowns, supersessions, and inactivity timeouts; `running` and `stale` rounds are in the denominator. `sidecar` contains `calls`, `avgTTFT`, `p50TTFT`, `p95TTFT`, `avgTPS`, `firstAt`, and `lastAt`, all respecting the model filter. `models` is derived from recorded calls only, each `{ providerID, modelID, label, calls, sessions, tokens, costUSD }`, sorted by cost descending. It is computed for the selected window and internal-test setting but ignores `model`, so selecting a model never removes the other choices from the selector; a model that only appears in internal-test sessions is absent unless `includeInternal` is set.

**One round rule applies everywhere the page shows rounds:** a round is listed and counted only when at least one of its linked recorded calls is inside the window (and matches the model where the endpoint accepts one). This applies to `/api/turns`, the overview `rounds` block, `roundSeries`, session detail rounds, the turn drill-down, and the round source of `/api/errors` and `errorSeries`. A round whose calls all fall outside the window is excluded even when the round itself started inside it; a round that started before the window but has a call inside it is included.

Round durations, queue waits, and first-token times are milliseconds or `null`, computed by `src/query.ts` (`queueMs`, `roundMs`, `firstTokenMs`). A `running` round older than one hour is returned as `stale`. Round `calls`, `costUSD`, and tokens come from matching call rows sharing its `turn_id`. `series` uses recorded calls for cost, tokens, calls, sessions, and latency; `roundSeries` adds `{ date, rounds, roundMsP50, roundMsP95, errors, timeouts, retries, cost }`; `errorSeries` adds `{ date, call, turn }` for the stacked error chart. Errors group inactivity interruptions as `provider.timeout` and use the call/round end time for the window.

The page has three views, switched from the top bar and reflected in the URL as `view`: **Usage** (everything above), **Providers**, and **Rates**.

### Rates view

The Rates view answers a narrower question than Providers: given each plan's published allowance and the model it served most, how many tokens does the next real dollar of fee buy — and does the answer change with the hour?

It calls only `/api/rates`, which reads the plans file and the recorded calls and returns one row per provider. Two columns matter, and they disagree by design:

- **Off-peak** — the ordinary case: 17 hours of every weekday plus all weekend.
- **Peak** — DeepSeek's `01:00-04:00` and `06:00-10:00` UTC windows, Monday to Friday, where its list price doubles.

The winner of each column is marked rather than baked into the row order, because the same plan wins one and loses the other. A plan whose allowance is denominated in API dollars (Command Code, OpenCode Go) buys half the tokens at peak; a plan metered on one flat card (OpenDesign) does not move. That single distinction, `basis` in `src/allowances.ts`, is what makes the comparison time-dependent.

The table is computed by `src/rates.ts`, which `bun run rates` also calls, so the CLI and the page cannot drift apart.

### Providers view

The Providers view answers "what am I paying, and what do I have left". It reads the plans file described below plus a live status endpoint, and shows one tab per provider, defaulting to the first provider with usage in the selected window.

Four figures sit at the top of each provider. They are easy to confuse, so each carries a subtitle saying what it measures:

| Figure | Means | Formula |
| --- | --- | --- |
| **Plan cost** | What you actually paid for this window | plan fee × days covered / month |
| **API list** | What the same tokens would cost paying DeepSeek directly | tokens × DeepSeek list, peak-aware |
| **List ÷ plan** | Whether the subscription is cheaper than list | API list / plan cost |
| **Plan ÷ 1M** | Effective cost per million tokens under the plan | plan cost × 1e6 / tokens |

`API list` and `Plan ÷ 1M` are the two that get mixed up: the first is a total for the window, the second is a rate. `List ÷ plan` below `1.00×` is amber because the plan is then costing more than list price for the tokens actually used — normal for a light month, and the reason the plan is worth having on a heavy one.

- **Paid / list value / value** — the prorated plan fee for the window next to the list-price value of the same tokens, so a plan that beat pay-as-you-go shows a ratio above 1.
- **Effective rate per 1M tokens** — paid and list rate, blended and per token kind. Per-kind paid rates need explicit `rates` in the plans file; with only a recorded cost total, just the blended rate is shown.
- **Peak / off-peak** — only when the plans file defines peak windows. OpenDesign has none: its card is flat.
- **Live status** — scraped from the provider's own API, described below.

`GET /api/quotas` performs the network calls; it is the only endpoint that leaves the machine. Results are cached for 60 seconds and concurrent requests share one in-flight fetch, so reloading the page does not hammer rate-limited upstream APIs. Each provider is reported independently, so one failing upstream cannot blank the others.

| Integration | Endpoint | What it returns |
| --- | --- | --- |
| `opencode` | `GET {origin}/zen/go/v1/usage` | Rolling 5-hour, weekly, and monthly Go allowance as a percent, plus reset times |
| `opencode` | `GET {server}/api/policies/current-budgets` | Console spend caps as limit/spent dollars (usually none) |
| `openai` | `GET https://chatgpt.com/backend-api/wham/usage` | Primary/secondary rate-limit windows, plan name, credits, and reset credits |

### Advertised allowance

A percentage on its own is hard to act on, so each provider's published limits sit beside its live status. These are static reference tables in `src/allowances.ts`, with the source for each figure recorded on the plan so it can be re-checked.

**OpenCode Go** — $10/month. Windows are *shares* of a per-model monthly allowance: 20% per 5 hours, 50% per week, 100% per month. DeepSeek V4.1 Flash has an $80 monthly allowance, so the caps are $16 / $40 / $80. Source: `packages/console/app/src/component/go-models.ts` and `go.faq.a9` in the Console's `i18n/en.ts`.

**OpenDesign Go** — $10/month ($8 first month). Windows are *fixed dollar caps*: $10 per 5 hours, $30 per 7 days, $120 per month, against a $120 monthly credit pool. Source: <https://open-design.ai/model-credits/>.

Each window shows the published cap and the percentage converted to dollars, plus an optional reset time when the upstream reports one.

### Credits are the console's own per-token card

OpenDesign publishes a per-model credit multiplier: 0.5× for DeepSeek V4.1 Flash, 1× for most models, 2× for Claude Haiku 5.5 and GLM-5.3 Flash-X, 4× for GPT-6 Luna. That multiplier is an **entitlement**, not a per-call discount: a lower multiplier means the same pool buys *more* usage. Inverting the published figure (`credits = 2 × usage × multiplier`) reproduces the monthly usage column exactly — $120 at 0.5×, $60 at 1×, $30 at 2×, $15 at 4×.

The meter is separate. The console's "Credit usage breakdown" popup prices a call from its tokens at a flat card:

| Type | Price / 1M |
| --- | --- |
| Input (excluding cache) | $0.44 |
| Output | $1.32 |
| Cache read | $0.014 |
| Cache write | $0.44 |

Reasoning bills at the output rate, and credits used = the subtotal. A call of 563 uncached input, 149 output, and 188,032 cache reads costs `563 × 0.44 + 149 × 1.32 + 188,032 × 0.014 = $0.0031`, which is exactly the subtotal the popup shows.

**There is no peak/off-peak step on this meter.** DeepSeek publishes peak and off-peak tiers, and OpenCode's `cost_usd` records the off-peak half, but OpenDesign's card is the same at every hour. The console's own totals prove it: 354.64M prompt tokens (350.74M of them cache) and 2.28M completion tokens come to $9.64 at the card, which is the 31% the 7-day window displayed.

**No single multiplier can reconcile recorded dollars with the card.** The card differs from OpenCode's recorded table by a different factor per kind:

| Kind | Recorded | Card | Ratio |
| --- | --- | --- | --- |
| Input | $0.15 | $0.44 | 2.93× |
| Output | $0.60 | $1.32 | 2.20× |
| Cache read | $0.003 | $0.014 | 4.67× |

So the read path reprices tokens at the card (`web/impute.ts`), rather than multiplying a blended recorded total. On a cache-heavy workload the old blend understated the bill by roughly 3×.

### Where the spend goes

At the card, cache reads dominate tokens but not the bill:

| Bucket | Tokens | Cost | Share of bill |
| --- | --- | --- | --- |
| Cache read | 350.74M | $4.91 | 51% |
| Output | 2.28M | $3.01 | 31% |
| Uncached input | 3.90M | $1.72 | 18% |

That is why the Usage tab's recorded `$2` and the plan page's `31%` were never the same quantity: the Usage tab was model-filtered *and* on OpenCode's table, while the console meter is account-wide and on its own card.

### Recorded spend versus the account

The percentages are the *account's* whole usage. Recorded cost is only what this tracker saw. When the same key is used outside OpenCode the two disagree, and the difference is shown as an explicit **Not recorded here** row rather than being silently absorbed:

```txt
Monthly   90%  cap $80  ≈$72.00 used   resets in 7d
This machine                         $9.22 recorded
Not recorded here (monthly)         $62.78
```

That row is the honest reading of "some of my usage is not on the books": the provider counts it against the same allowance, but no local figure includes it. Nothing here attempts to reconstruct it.

### Calls the tracker recorded as free

OpenCode records `cost_usd` from its own catalog, which is not always the price the plan meters against. For OpenDesign the two tables differ by a *different* factor for each token kind, so no blended multiplier can reconcile them. The read boundary therefore reprices each call from its recorded tokens at the plan's card (`web/impute.ts`), so every endpoint and chart sees one consistent set of numbers.

The known zero-cost gap is covered by the same path. OpenCode sometimes reports `cost = 0` on a completed call that clearly used tokens:

| Provider | Calls | Span |
| --- | --- | --- |
| `opencode-go` | 345 | 6 h, mid-run on 2026-10-28 |
| `opendesign` | 50 | 41 min at the start of tracking, 2026-10-29 |
| `opencode` | 2 | one-off |

Three rules keep this honest:

- **A flat-card plan is always repriced.** Its card is the meter, so the recorded table is replaced even when it reported a positive number. Clock-rated plans (Go, Command Code) keep their recorded price, which is already the official price for the call's hour.
- **A zero is only filled when the call moved tokens.** A zero on a call with no tokens is a real zero — an aborted step — and stays zero. A `null` cost is "never priced" (failed calls) and also stays.
- **Only a model the plans file prices is repriced.** Anything else keeps its recorded value and is counted in `unpricedCalls`, so a total can say it is short rather than imply completeness.

`/api/meta` reports `imputedCostUSD` (the net change from repricing) and `unpricedCalls`, and the page shows a banner naming both, so an adjusted total is never mistaken for a raw one:

```txt
Totals include adjusted cost: $7.30 more than OpenCode recorded, from the
plan's own rates; 0 calls carrying tokens could not be priced.
```

Two smaller cases are labelled rather than guessed:

- **Mixed models.** Go publishes an allowance per model, not one pool. When a window mixed models with different allowances there is no single figure the percentage refers to, so the dollars use the model that spent the most and the panel says `Estimate:`.
- **No usage API.** OpenDesign publishes limits but no usage endpoint, so its caps are shown without percentages, with a note saying live percentages are unavailable.

A model the plan does not publish is counted at 1× so the total is never understated, and is named in the panel. A free model with no recorded cost is skipped instead of being reported as unknown, and promotional Go models (`beam-free`, `iceman-contributor-free`) are excluded from credits and shown separately as unmetered.

The other two providers expose no usage API and are reported as such rather than hidden: Command Code serves only `/provider/v1/models` and returns 404 on every account, usage, balance, and billing path tried; OpenDesign reports tokens per response but exposes no account or balance endpoint (its `/v1/*` inference API works, and every `amr-api.open-design.ai/api/v1/*` account path returns 401).

Credentials are read from the `credential` table of the authoritative database, which the dashboard already opens read-only, so status works without a running OpenCode server. Only the active credential per integration is used. Because OpenCode records Go traffic under the provider id `opencode-go` while the credential belongs to the `opencode` integration, `src/quota-source.ts` maps between them explicitly in `PROVIDER_ALIASES` rather than guessing by prefix.

A provider's status is one of `ok`, `unsupported` (no API to read), `missing` (no usable credential), or `error` (the call failed or the response did not parse). An expired or revoked token reports as `error` with a message asking you to reconnect it; the token itself never reaches the browser, and no response body from a failing call is echoed back.

The page writes its view to the URL (`since`, `q`, `model`, sorts, call/round paging offsets, round status, errors-only, error source, the `view`, the selected `provider` tab, and the open `session` or `turn` panel), so views are linkable and the back button works. Internal-test rows only appear when the checkbox is enabled, and are marked `test`. When the sidecar is missing or empty, a banner states that every metric comes from recorded calls.

The dashboard groups KPI cards into volume, latency, and rounds sections; adds round-duration (p50/p95) and errors-per-day (stacked call/round) charts; adds a sortable, status-filtered, paged Rounds table with a call drill panel; adds a grouped Errors table with relative-count bars; and shows each session's rounds above its calls in the session drill panel. Charts are hand-drawn inline SVG with exact values in `<title>` elements.

### Plan pricing

A subsidised plan (OpenCode Go, Command Code, OpenDesign Go) bills a monthly fee rather than per-token rates, so `cost_usd` — OpenCode's catalog estimate — is not what the account paid. The Providers section reads an optional `usage-plans.json` beside the sidecar and shows, per provider, the prorated fee for the window next to the list-price value of the same tokens, so you can see whether a plan beat paying as you go.

```json
{
  "providers": {
    "opendesign": {
      "label": "OpenDesign Go",
      "terms": [
        { "from": "2026-10-01", "monthlyUSD": 8 },
        { "from": "2026-11-01", "monthlyUSD": 10 }
      ],
      "peak": { "windows": ["01:00-04:00", "06:00-10:00"], "days": [1, 2, 3, 4, 5] },
      "rates": {
        "deepseek-v4.1-flash": { "input": 0.15, "output": 0.6, "cacheRead": 0.003 }
      }
    }
  }
}
```

- `terms` is a price history, not a single number, so a promotional first month followed by the standard fee stays correct for past windows. Each term is dated `YYYY-MM-DD` in UTC.
- The fee prorates by real UTC time: each day costs `monthlyUSD / daysInMonth`, and a day only bills for the part inside the window, so `7d` is exactly seven days of fee.
- `rates` are optional per-model list prices (USD per 1M tokens; `reasoning` bills at the `output` rate). Without them the list value falls back to recorded `cost_usd`, which is already a catalog estimate. Per-kind paid rates need explicit `rates`; with only a recorded total, just the blended rate is knowable and the kind rows are omitted.
- `peak.windows` are `HH:MM-HH:MM` UTC (a window may wrap past midnight) and `peak.days` are ISO weekdays, 1 = Monday. Windows classify usage only: a subscriber pays the same monthly fee regardless of hour, so `peakMultiplier` defaults to `1` and should stay there unless the upstream publishes a real surcharge.
- The plan fee is split across token kinds by their *list* cost share, so the effective per-kind rate reflects the plan's discount rather than a raw token share.
- Invalid entries are dropped with a message in `planErrors` instead of failing the request, so one typo cannot blank the section.

The file is optional. Providers without a plan show no spend and are labelled `no plan price configured`; `/api/providers` still reports their recorded usage and list value.

- **In-flight calls are lost on restart.** A server restart, plugin reload, or dropped stream loses any call still in flight. Calls are inserted only when they finalize; rounds are inserted when they start and advanced by updates.
- **The event stream is live-only, not replayed.** A call whose `session.step.started` happened before this plugin subscribed cannot be reconstructed; its later `ended` event is ignored because there is no pending call.
- **`parent_session_id` is always NULL.** `parentID` appears only on `session.created`, which the live stream does not replay, so subagent parents cannot be backfilled cheaply.
- **A `running` round can be stale.** A crash between `session.execution.started` and its terminal event leaves the round `running`; there is no cleanup job. Reads must treat old `running` turns as stale rather than active.
- **Recorded calls can outnumber authoritative steps.** Retries create a new sidecar attempt, while `sessions` counts assistant message rows. This is why the `CALLS` column is separate from `STEPS`.
- **Read latency coverage is partial by construction.** See "Limitation: latency coverage" above.

## Development

```sh
bun install
bun x tsc --noEmit
bun test
bun verify/run.ts
```

`bun verify/run.ts` starts the mock provider and an isolated OpenCode server with every XDG directory under `/tmp/oc2-usage-verify`, drives rounds with controllable failure modes, restarts the server, and asserts the sidecar rows. It never touches the live service or `/opencode2-state`.

The mock provider fails the first attempt of a prompt containing `[[fail:429]]` with a 429 and `Retry-After: 1`, then streams normally so the retry succeeds. A prompt containing `[[fail:500]]` returns 500 with `x-should-retry: false`, so OpenCode classifies it as `provider.internal` and does not spend its default retry budget on the harness.

Timeout classification cannot be forced reliably against a real provider, so it is covered in `test/reducer.test.ts` with a synthetic `session.step.failed` carrying `type: "provider.timeout"`.

Last verification (mock provider with a 400 ms first-content delay):

- normal round: `kind = step`, `status = completed`, TTFT `418 ms`, `tokens_output = 5`, `cost_usd = 0.000138`; one `turn` row `accepted_at = started_at`, `ended_at - accepted_at = 797 ms`, `prompts = 1`, `steers = 1` (prompts steer by default), call `turn_id` matches
- 429 round: first attempt `status = retried`, `retries = 1`, `last_retry_error_type = provider.rate-limit`, second attempt `status = completed`; one round with `retries = 1` and duration `3069 ms`
- 500 round: step `status = failed`, `error_type = provider.internal`, `error_status = 500`; round `status = failed`, same error fields
- after restart: a fifth step row and a fourth round row, each linked by `turn_id`, with the first rows unchanged
- concurrent-instance check: the same row inserted through two store handles on the same sidecar path (which reuse one connection) yields `count(*) = 1`
- totals: 5 step rows, 4 turn rows, every call has exactly one `turn_id`

Earlier runs measured the same latency fields with TTFT `416–428 ms`, so network and process scheduling account for the spread.

### What a dollar buys, per provider

The Rates view shows this live; `bun run rates` prints the same thing from the same code. Both use the token mix measured from recorded calls rather than a textbook split.

Two of the plans are denominated in the clock; one is not:

| Plan | Advertised | Denominated in | Meters |
| --- | --- | --- | --- |
| Command Code GOAT | $80/mo for $10 | dollars at official API prices | the clock rate |
| OpenCode Go | $80/mo for $10 | dollars at official API prices | the clock rate |
| OpenDesign Go | $120/mo for $10 | its own flat per-token card | one price, every hour |

Command Code and OpenCode Go track DeepSeek's time-of-day price: half price for 17 hours of every weekday and all weekend, double during `01:00-04:00` and `06:00-10:00` UTC Monday to Friday. OpenDesign does not. Its card is flat, so its column does not move with the hour.

That produces the same practical answer, but for a different reason than the old peak-list framing:

- **Off-peak, Command Code or OpenCode Go buy more tokens per fee dollar** because their allowance is spent at the half-price clock rate.
- **Peak, OpenDesign wins** because its meter does not double while theirs does.
- Command Code and OpenCode Go are identical in every column — same fee, same allowance, same metering.

**A caveat on the books.** OpenCode's recorded `cost` column applies a *static off-peak rate table at every hour*, so it understates CC and Go spend by whatever the peak surcharge should have been. The dashboard's `API list` figure applies the peak windows and is the one to trust for those two. OpenDesign is different: its Usage and Provider dollars are now repriced at the console card, so they match the meter directly.

### Reconciling OpenDesign

`bun run reconcile` prints the local reconciliation:

```sh
bun run reconcile --since=30d
bun run reconcile --since=7d --json   # machine-readable
```

It answers four things from the recorded books alone:

| Section | Question |
| --- | --- |
| Rate card | How far is the console card from OpenCode's recorded table, and is the gap uniform? |
| Peak / off-peak | Does the card differ inside DeepSeek's peak windows? (It should not.) |
| Design Plan credits | What do the 5-hour, 7-day and monthly windows come to at the card? |
| Blind spot | How much usage has tokens but no recorded cost? |

Run it after adding a provider or changing rates. A card/recorded ratio that *is* uniform would mean one blended multiplier is enough; a peak/off-peak split that differs would mean the console has started passing the clock through — either one invalidates the flat-card assumption.
