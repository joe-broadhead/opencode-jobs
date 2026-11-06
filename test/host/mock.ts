// A scriptable OpenAI-compatible model on loopback, for the host tests: the answer is chosen by a directive in the last
// user message, so a run can be a short answer, a slow one, or a tool call. It never leaves 127.0.0.1.
//   [[mock:text:SOME TEXT]]   a plain answer
//   [[mock:slow:N]]           N one-second chunks, then "slow done"
//   [[mock:tool:NAME:JSON]]   one tool call, then a short answer after the tool result
export interface MockRequest {
  readonly at: number
  readonly tools: readonly string[]
  readonly text: string
}

export interface MockModel {
  readonly baseURL: string
  readonly requests: readonly MockRequest[]
  /** The number of model calls made so far, which a keep-alive must never raise. */
  readonly calls: () => number
  stop(): void
}

type Message = { role: string; content?: unknown }
const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : ""

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

const usage = (send: (chunk: string) => void) =>
  send(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)

function stream(write: (send: (chunk: string) => void, signal: AbortSignal) => Promise<void>, signal: AbortSignal) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (value: string) => {
          try {
            controller.enqueue(encoder.encode(value))
          } catch {
            // The response was aborted.
          }
        }
        try {
          await write(send, signal)
        } catch {
          // A cancelled request is a cancelled test, not a failure.
        }
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  )
}

const answer = (value: string, signal: AbortSignal) =>
  stream(async (send) => {
    send(chunk({ role: "assistant", content: "" }))
    send(chunk({ content: value }))
    send(chunk({}, "stop"))
    usage(send)
    send("data: [DONE]\n\n")
  }, signal)

export function startMockModel(): MockModel {
  const requests: MockRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1", object: "model", owned_by: "mock" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as { messages?: Message[]; tools?: { function: { name: string } }[] }
      const messages = body.messages ?? []
      const tools = (body.tools ?? []).map((tool) => tool.function.name)
      const last = messages[messages.length - 1]
      const user = [...messages].reverse().find((message) => message.role === "user")
      const prompt = text(user?.content)
      requests.push({ at: Date.now(), tools, text: prompt })
      const signal = request.signal
      if (tools.length === 0) return answer("Mock title", signal)
      if (last?.role === "tool") return answer(`after-tool: ${text(last.content).slice(0, 300)}`, signal)
      const directive = /\[\[mock:(\w+)(?::([^\]]*))?\]\]/.exec(prompt)
      const kind = directive?.[1] ?? "text"
      const argument = directive?.[2] ?? "ok"
      if (kind === "slow") {
        const seconds = Number(argument) || 30
        return stream(async (send, cancelled) => {
          send(chunk({ role: "assistant", content: "" }))
          for (let index = 0; index < seconds; index += 1) {
            if (cancelled.aborted) return
            send(chunk({ content: `tick${index} ` }))
            await Bun.sleep(1_000)
          }
          send(chunk({ content: "slow done" }))
          send(chunk({}, "stop"))
          usage(send)
          send("data: [DONE]\n\n")
        }, signal)
      }
      if (kind === "tool") {
        const [name, ...rest] = argument.split(":")
        return stream(async (send) => {
          send(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: "" } }] }))
          send(chunk({ tool_calls: [{ index: 0, function: { arguments: rest.join(":") || "{}" } }] }))
          send(chunk({}, "tool_calls"))
          usage(send)
          send("data: [DONE]\n\n")
        }, signal)
      }
      return answer(argument, signal)
    },
  })
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    calls: () => requests.length,
    stop: () => void server.stop(true),
  }
}
