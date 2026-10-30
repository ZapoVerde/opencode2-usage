/**
 * Ambient declarations for the OpenCode V2 beta Promise plugin API.
 *
 * The host provides `@opencode/plugin` at runtime and refuses to load a copy
 * from a plugin's own `node_modules`. This file therefore mirrors only the
 * surface this plugin uses. It tracks the beta V2 plugin API and must be
 * updated when that API changes; it is not a published type package.
 */
declare module "@opencode/plugin" {
  /** One location reference carried by an event envelope. */
  export interface LocationRef {
    readonly directory: string
    readonly workspaceID?: string
  }

  /** Durable-log coordinates attached to durable events. */
  export interface DurableEnvelope {
    readonly aggregateID: string
    readonly seq: number
    readonly version: number
  }

  /**
   * One encoded event from the live server event stream. `data` is narrowed by
   * the event `type`; this plugin validates it before reading individual fields.
   */
  export interface EventEnvelope {
    readonly id: string
    readonly type: string
    readonly created: number
    readonly data: unknown
    readonly location?: LocationRef
    readonly metadata?: Record<string, unknown>
    readonly durable?: DurableEnvelope
  }

  export interface SubscribeOptions {
    readonly signal?: AbortSignal
  }

  export namespace Plugin {
    export type Cleanup = () => Promise<void> | void

    export interface Context {
      /** Configuration supplied next to the plugin entry in `plugins`. */
      readonly options: Readonly<Record<string, unknown>>
      /** Location this plugin instance was activated for. */
      readonly location: LocationRef
      readonly event: {
        /** Live events only; the stream does not replay durable history. */
        subscribe(options?: SubscribeOptions): AsyncIterable<EventEnvelope>
      }
    }

    export interface Plugin {
      readonly id: string
      readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
    }

    export function define(plugin: Plugin): Plugin
  }
}
