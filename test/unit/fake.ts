// Narrow fakes of the public plugin context: only the members a test touches, typed with Pick<> so they
// stay valid against later 2.2.x context shapes.
import type { Plugin } from "@opencode/plugin"
import type { Clock } from "../../src/jobs/clock.js"
import type { Session } from "../../src/jobs/execute.js"
import type { Storage } from "../../src/jobs/store.js"

type Transform<Editor> = (callback: (editor: Editor) => void) => Promise<{ dispose: () => Promise<void> }>

/** Collects transform callbacks; `run` replays them on a fresh editor value, as the host does on each rebuild. */
export function transforms<Editor>() {
  const callbacks: ((editor: Editor) => void)[] = []
  const transform: Transform<Editor> = (callback) => {
    callbacks.push(callback)
    return Promise.resolve({ dispose: async () => void callbacks.splice(callbacks.indexOf(callback), 1) })
  }
  return { transform, callbacks, run: (editor: Editor) => callbacks.forEach((callback) => callback(editor)) }
}

export type CommandEditor = Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]
export type CommandDefinition = Parameters<CommandEditor["add"]>[0]

/** The commands a command transform adds. */
export function commands() {
  const added: CommandDefinition[] = []
  const editor = { add: (definition: CommandDefinition) => void added.push(definition) } as CommandEditor
  return { editor, added }
}

export type Synthetic = Parameters<Plugin.Context["session"]["synthetic"]>[0]
export type CommandContext = { readonly command: Pick<Plugin.Context["command"], "transform">; readonly session: Pick<Plugin.Context["session"], "synthetic"> }

/** A session that records what a command posts into it. */
export function sessions() {
  const posted: Synthetic[] = []
  const session = { synthetic: async (input: Synthetic) => void posted.push(input) } as unknown as Pick<Plugin.Context["session"], "synthetic">
  return { session, posted }
}

/** A context for the status command: the command transform and the session it posts into. */
export function commandContext() {
  const editable = transforms<CommandEditor>()
  const { session, posted } = sessions()
  const ctx: CommandContext = { command: { transform: editable.transform }, session }
  return { ctx, editable, posted }
}

export type Rpc = Plugin.Context["rpc"]
type RpcDefinition = { readonly id: string; readonly methods: Readonly<Record<string, unknown>> }
export type RpcHandler = (input: unknown, context: { readonly signal: AbortSignal; readonly error: (...args: unknown[]) => unknown }) => Promise<unknown>

/** The definitions and handlers `ctx.rpc.register` received, in order. */
export function rpcRegistry() {
  const registered: { definition: RpcDefinition; handlers: Record<string, RpcHandler> }[] = []
  const register = ((definition: RpcDefinition, handlers: Record<string, RpcHandler>) => {
    registered.push({ definition, handlers })
    return Promise.resolve({ dispose: async () => undefined, events: { emit: async () => undefined } })
  }) as unknown as Rpc["register"]
  const rpc = { register } as Pick<Plugin.Context["rpc"], "register">
  return { rpc, registered }
}

/** A context for an RPC call's permission and session checks. */
export const rpcContext = (): { readonly signal: AbortSignal; readonly error: (...args: unknown[]) => unknown } => ({
  signal: new AbortController().signal,
  error: (...args: unknown[]) => ({ type: args[0], message: args[1], data: args[2] }),
})

/**
 * `ctx.storage` in memory, with the host's paged `scan`: a JSON value per key, at most `pageSize` entries a page, a
 * cursor that is the last key of the page, and no compare-and-set (F3, V-5).
 */
export function memoryStorage(pageSize = 2) {
  const values = new Map<string, string>()
  const calls = { set: 0, remove: 0 }
  const storage: Storage = {
    get: async (key) => {
      const raw = values.get(key)
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    set: async (key, value) => {
      calls.set += 1
      values.set(key, JSON.stringify(value))
    },
    remove: async (key) => {
      calls.remove += 1
      values.delete(key)
    },
    scan: async ({ prefix, after, limit }) => {
      const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = after === undefined ? 0 : keys.findIndex((key) => key > after)
      const from = start === -1 ? keys.length : start
      const size = Math.min(limit ?? 100, pageSize)
      const page = keys.slice(from, from + size)
      const more = from + size < keys.length
      return {
        entries: page.map((key) => ({ key, value: JSON.parse(values.get(key)!) })),
        ...(more && page.length > 0 ? { next: page[page.length - 1]! } : {}),
      }
    },
  }
  return { storage, calls, keys: () => [...values.keys()].sort() }
}

/**
 * A clock a test advances by hand. Sleeps at or below `instantBelow` resolve at once (a claim's settle delay), so only
 * the waits a test cares about are the ones it must release; every requested delay is recorded.
 */
export function testClock(start: number, options: { instantBelow?: number } = {}) {
  const instantBelow = options.instantBelow ?? 0
  const sleeps: number[] = []
  const pending: { at: number; done: () => void }[] = []
  let now = start
  const clock: Clock = {
    now: () => now,
    sleep: (ms, signal) => {
      sleeps.push(ms)
      if (signal?.aborted === true || ms <= instantBelow) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const entry = {
          at: now + ms,
          done: () => {
            signal?.removeEventListener("abort", entry.done)
            pending.splice(pending.indexOf(entry), 1)
            resolve()
          },
        }
        pending.push(entry)
        signal?.addEventListener("abort", entry.done, { once: true })
      })
    },
  }
  const fire = (all: boolean) => {
    for (const entry of [...pending]) {
      if (!all && entry.at > now) continue
      entry.done()
    }
  }
  return {
    clock,
    /** Every delay asked for, in order. */
    sleeps,
    now: () => now,
    advance(by: number) {
      now += by
      fire(false)
    },
    /** Releases every pending sleep regardless of its deadline. */
    flush() {
      fire(true)
    },
    pending: () => pending.length,
  }
}

/** Lets queued promise callbacks run, so a started loop has taken its first steps. */
export const settle = async (turns = 8) => {
  for (let index = 0; index < turns; index += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * The agent API a run checks before it starts: every agent is guarded unless `unguarded` names it, an agent in
 * `missing` raises the host's not-found error, and any other lookup failure is `fail`.
 */
export function agentsFake(options: { readonly unguarded?: readonly string[]; readonly missing?: readonly string[]; readonly fail?: boolean } = {}) {
  const guarded = [
    { action: "*", resource: "*", effect: "deny" as const },
    { action: "read", resource: "*", effect: "allow" as const },
  ]
  const open = [{ action: "*", resource: "*", effect: "allow" as const }]
  const get = async ({ agentID }: { agentID: string }) => {
    if (options.fail === true) throw new Error("agent.list is not ready")
    if (options.missing?.includes(agentID) === true) throw Object.assign(new Error(`Agent not found: ${agentID}`), { _tag: "Agent.NotFoundError" })
    const permissions = options.unguarded?.includes(agentID) === true ? open : guarded
    return { location: { directory: "/work" }, data: { id: agentID, name: agentID, permissions } }
  }
  return { get } as unknown as Pick<Plugin.Context["agent"], "get">
}

export interface SessionFakeOptions {
  /** The outcome `get` reports once a turn has finished. */
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  /** `wait` resolves at once instead of waiting for `release()`. */
  readonly autoFinish?: boolean
  /** Text of the last assistant message, which becomes the run's summary. */
  readonly answer?: string
  /** `get` throws, as it does for a session that has been removed. */
  readonly gone?: boolean
  /** Arrears: `create` and `prompt` throw, as a failed run does. */
  readonly fail?: "create" | "prompt" | "command" | "synthetic"
  /** A session this fake did not create, such as an adopted one, reports no outcome until `release()`. */
  readonly startBusy?: boolean
}

/** The session API one run and one adoption pass use, recording what they asked for. */
export function sessionFake(options: SessionFakeOptions = {}) {
  const created: Record<string, unknown>[] = []
  const prompts: Record<string, unknown>[] = []
  const commands: Record<string, unknown>[] = []
  const synthetics: Record<string, unknown>[] = []
  const removed: string[] = []
  const interrupted: string[] = []
  const waiting: string[] = []
  const releases: (() => void)[] = []
  const busy = new Map<string, boolean>()

  const finish = (sessionID: string) => {
    busy.set(sessionID, false)
    for (const release of releases.splice(0)) release()
    void sessionID
  }

  const session: Session = {
    create: async (input) => {
      if (options.fail === "create") throw new Error("session.create failed")
      const id = `ses_${created.length + 1}`
      created.push(input as Record<string, unknown>)
      busy.set(id, true)
      return { id } as never
    },
    get: async ({ sessionID }) => {
      if (options.gone === true) throw new Error("Session.NotFoundError")
      const running = busy.get(sessionID) === true || (busy.get(sessionID) === undefined && options.startBusy === true)
      return { id: sessionID, ...(running || options.outcome === undefined ? {} : { outcome: options.outcome }), cost: 0 } as never
    },
    remove: async ({ sessionID }) => {
      removed.push(sessionID)
      busy.delete(sessionID)
    },
    prompt: async (input) => {
      if (options.fail === "prompt") throw new Error("session.prompt failed")
      prompts.push(input as Record<string, unknown>)
      if (options.autoFinish === true) finish(input.sessionID)
      return { id: "msg_1", sessionID: input.sessionID } as never
    },
    command: async (input) => {
      if (options.fail === "command") throw new Error("session.command failed")
      commands.push(input as Record<string, unknown>)
      if (options.autoFinish === true) finish(input.sessionID)
    },
    synthetic: async (input) => {
      if (options.fail === "synthetic") throw new Error("session.synthetic failed")
      synthetics.push(input as Record<string, unknown>)
      if (options.autoFinish === true) finish(input.sessionID)
      return { id: "msg_1" } as never
    },
    wait: ({ sessionID }) => {
      waiting.push(sessionID)
      if (busy.get(sessionID) === false) return Promise.resolve()
      if (busy.get(sessionID) === undefined && options.startBusy !== true) return Promise.resolve()
      busy.set(sessionID, true)
      return new Promise<void>((resolve) => {
        releases.push(() => {
          busy.set(sessionID, false)
          resolve()
        })
      })
    },
    interrupt: async ({ sessionID }) => {
      interrupted.push(sessionID)
      finish(sessionID)
      return { interrupted: true } as never
    },
    context: async () => (options.answer === undefined ? [] : [{ type: "assistant", content: [{ type: "text", text: options.answer }] }]) as never,
  }

  return {
    session,
    created,
    prompts,
    commands,
    synthetics,
    removed,
    interrupted,
    waiting,
    /** Finishes every busy session's current turn, as the model would. */
    release: () => {
      for (const id of [...busy.keys()]) finish(id)
    },
  }
}
