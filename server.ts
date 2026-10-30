import { Plugin } from "@opencode/plugin"
import { apply, createState } from "./src/reducer"
import { openStore, resolveDatabasePath, type UsageStore } from "./src/store"
import { parseUsageEvent } from "./src/types"

/**
 * Out-of-tree OpenCode V2 usage logger. It records one row per finalized LLM
 * call into a sidecar SQLite database and never writes to the OpenCode database.
 */
export default Plugin.define({
  id: "opencode2-usage",
  setup: (ctx) => {
    const store = openStore(resolveDatabasePath(ctx.options))
    const controller = new AbortController()
    void consume(ctx, store, controller.signal).catch((error: unknown) => {
      // The subscription is live-only; a dropped stream only loses in-flight calls.
      console.error("[opencode2-usage] event stream stopped:", error)
    })
    return () => {
      controller.abort()
      store.close()
    }
  },
})

async function consume(ctx: Plugin.Context, store: UsageStore, signal: AbortSignal) {
  let state = createState()
  for await (const envelope of ctx.event.subscribe({ signal })) {
    const event = parseUsageEvent(envelope)
    if (!event) continue
    const reduction = apply(state, event, {
      now: Date.now(),
      directory: event.location?.directory ?? ctx.location.directory,
    })
    state = reduction.state
    for (const row of reduction.rows) store.insert(row)
    for (const write of reduction.turns)
      if (write.kind === "insert") store.insertTurn(write.row)
      else store.updateTurn(write.turnID, write.progress)
  }
}
