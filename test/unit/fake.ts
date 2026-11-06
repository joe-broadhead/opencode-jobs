// Narrow fakes of the public plugin context: only the members a test touches, typed with Pick<> so they
// stay valid against later 2.2.x context shapes.
import type { Plugin } from "@opencode/plugin"

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
