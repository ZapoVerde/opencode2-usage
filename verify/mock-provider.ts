/**
 * Dev-only OpenAI-compatible streaming endpoint. It deliberately waits about
 * 400 ms before the first content delta, streams a few deltas over roughly
 * 300 ms, then reports usage on the final chunk.
 *
 * A prompt containing `[[fail:429]]` fails its first attempt with a 429 and a
 * `Retry-After` header, then streams normally so the retry can succeed. A prompt
 * containing `[[fail:500]]` always answers 500 with `x-should-retry: false`, so
 * OpenCode reports `provider.internal` instead of retrying for a minute.
 */

export type MockProvider = {
  readonly port: number
  readonly url: string
  stop(): void
}

const FIRST_CONTENT_DELAY_MS = 400
const DELTA_INTERVAL_MS = 75
const DELTAS = ["Hello", " from", " the", " mock", "."]
const FAILURE_MARKER = /\[\[fail:(429|500)\]\]/

export function startMockProvider(port = 0): MockProvider {
  const attempts = new Map<string, number>()
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions"))
        return completion(request, attempts)
      if (request.method === "GET" && url.pathname.endsWith("/models")) return models()
      return new Response("not found", { status: 404 })
    },
  })
  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

async function completion(request: Request, attempts: Map<string, number>) {
  const body = (await request.json().catch(() => ({}))) as { model?: unknown; messages?: unknown }
  const model = typeof body.model === "string" ? body.model : "mock-model"
  const marker = FAILURE_MARKER.exec(promptText(body.messages))?.[1]
  if (marker === "500") return failure(500, "mock provider internal error", { "x-should-retry": "false" })
  if (marker === "429") {
    const seen = attempts.get("429") ?? 0
    attempts.set("429", seen + 1)
    if (seen === 0) return failure(429, "mock rate limit", { "retry-after": "1" })
  }
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1_000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage === undefined ? {} : { usage }),
      })

      send(chunk({ role: "assistant" }))
      await Bun.sleep(FIRST_CONTENT_DELAY_MS)
      for (const [index, delta] of DELTAS.entries()) {
        if (index > 0) await Bun.sleep(DELTA_INTERVAL_MS)
        send(chunk({ content: delta }))
      }
      send(
        chunk({}, "stop", {
          prompt_tokens: 128,
          completion_tokens: DELTAS.length,
          total_tokens: 128 + DELTAS.length,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      )
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

function promptText(messages: unknown) {
  if (!Array.isArray(messages)) return ""
  return messages.map((message) => contentText(isRecord(message) ? message.content : undefined)).join("\n")
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("")
}

function failure(status: number, message: string, headers: Record<string, string>) {
  return Response.json(
    { error: { message, type: status === 429 ? "rate_limit_error" : "server_error", code: status } },
    { status, headers },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function models() {
  return Response.json({
    object: "list",
    data: [{ id: "mock-model", object: "model", owned_by: "opencode2-usage" }],
  })
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 0)
  const provider = startMockProvider(port)
  console.log(`mock provider listening on ${provider.url}`)
}
