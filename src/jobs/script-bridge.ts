/**
 * The bridge a script calls: one function, two routes.
 *
 * - A family method (`<plugin id>.<method>`) goes to that plugin's tools RPC, in this process, with the run session's
 *   id and input. The RPC resolves the rule before dispatch and the plugin shapes input and output, so a script sees
 *   what a model would.
 * - A `host:<tool id>` entry calls the host-listed tool itself, after resolving the tool's action against the run
 *   session's rules *and* the agent's. This check is load-bearing: the host does not assert `ask` for a plugin tool,
 *   and a script has no other route to the tool.
 *
 * Neither route is a second permission system: both resolve rules the host already holds, and neither can widen one.
 */
import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { evaluate, type Rule } from "../host/permissions.js"
import type { ResolvedTool } from "./script.js"
import type { ScriptBridge } from "./script-runtime.js"

/** The session's permission check, as the host hands it to an evaluate hook. */
interface SessionInfo {
  readonly agent?: string
  readonly permissions?: readonly Rule[]
  readonly location?: { readonly directory?: string }
}

export interface BridgeInput {
  readonly rpc: Plugin.Context["rpc"]
  readonly tool: Pick<Plugin.Context["tool"], "list">
  readonly session: Pick<Plugin.Context["session"], "get">
  readonly agent: Pick<Plugin.Context["agent"], "get">
  readonly sessionID: string
  readonly agentID: string
  readonly manifest: readonly ResolvedTool[]
}

/** The coded error a refused host-tool call throws: the script sees the message, never a prompt. */
const refused = (action: string, effect: "ask" | "deny"): Error =>
  new Error(`PERMISSION_DENIED: ${action} ${effect === "ask" ? "would ask for this run's agent, and a script cannot answer" : "is denied for this run's agent"}.`)

export function createBridge(input: BridgeInput): ScriptBridge {
  let sessionRules: readonly Rule[] | undefined
  let calls = 0
  const session = async (): Promise<{ agentID: string; rules: readonly Rule[] }> => {
    if (sessionRules !== undefined) return { agentID: input.agentID, rules: sessionRules }
    const info = (await input.session.get({ sessionID: input.sessionID as never }).catch(() => ({}))) as SessionInfo
    sessionRules = (info.permissions ?? []) as readonly Rule[]
    return { agentID: info.agent ?? input.agentID, rules: sessionRules }
  }
  /**
   * The agent's rules, read on **every** call: a deny added while a run is in flight must stop the next call, even though
   * the run session's grant would beat it in the host's order (SR-14). The agent is read where the plugin is (v2.1: no
   * location), and the session's own rules are the grant.
   */
  const agentRules = async (): Promise<readonly Rule[]> => {
    const { agentID } = await session()
    const agent = await input.agent.get({ agentID } as never).catch(() => undefined)
    return (agent?.data.permissions ?? []) as readonly Rule[]
  }
  const agentDenies = async (action: string): Promise<boolean> => evaluate(await agentRules(), action) === "deny"

  const family = (plugin: string, method: string) => {
    const definition = Rpc.define({
      id: `${plugin}.tools`,
      methods: { [method]: { input: { type: "object" }, output: { type: "object" }, errors: { failed: { type: "object" } } } },
      events: {},
    } as never)
    const client = input.rpc(definition) as unknown as Record<string, (body: unknown, options?: unknown) => Promise<unknown>>
    return async (args: unknown, signal: AbortSignal) => {
      const answer = (await client[method]!({ sessionID: input.sessionID, input: args }, { signal })) as { output?: unknown; text?: unknown }
      return answer.output ?? answer.text ?? answer
    }
  }

  const hostTool = (id: string) => async (args: unknown, signal: AbortSignal) => {
    const tool = (await input.tool.list()).find((entry) => entry.id === id || entry.name === id)
    if (tool === undefined) throw new Error(`TOOL_UNAVAILABLE: OpenCode does not list ${id}.`)
    const action = tool.options?.permission ?? tool.id
    const rules = await session()
    // The host's order: the agent's rules, then the run session's grant.
    const effect = evaluate([...(await agentRules()), ...rules.rules], action)
    if (effect !== "allow") throw refused(action, effect)
    calls += 1
    const callID = `script:${calls}`
    const call = {
      sessionID: input.sessionID,
      agent: input.agentID,
      messageID: "msg_script",
      id: callID,
      signal,
      progress: async () => undefined,
      source: { type: "tool", messageID: "msg_script", id: callID },
    }
    const result = (await tool.execute(args as never, call as never)) as { output?: unknown; content?: unknown }
    return result.output ?? result.content ?? result
  }

  return async (method, args, signal) => {
    const tool = input.manifest.find((entry) => entry.method === method)
    if (tool === undefined) throw new Error(`JOBS_SCRIPT_UNKNOWN_TOOL: ${method} is not in the job's manifest.`)
    // The agent's rules are re-read per call: a deny added after the run's own resolve stops the next call.
    if (await agentDenies(tool.action)) throw new Error(`JOBS_SCRIPT_REVOKED: ${tool.action} is now denied for this run's agent.`)
    if (method.startsWith("host:")) return hostTool(method.slice("host:".length))(args, signal)
    const at = method.lastIndexOf(".")
    return family(method.slice(0, at), method.slice(at + 1))(args, signal)
  }
}
