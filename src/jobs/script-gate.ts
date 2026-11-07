/**
 * The script gate: it resolves a manifest against the host and the named agent's own rules, and it asks the one
 * approval a script gets.
 *
 * A family method is looked up through that plugin's tools RPC `describe` (the exact-name table); a `host:` entry is a
 * tool the host lists, by exact id. The effect is resolved from the agent's own `permissions` with the host's rule
 * order, and nothing else: the run session's rules *are* the grant, so resolving against them would make every grant
 * its own permission. A method the table does not know is refused with the nearest names, never guessed.
 */
import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { evaluate, type Rule } from "../host/permissions.js"
import { JobInputError } from "./model.js"
import {
  approvalResource,
  digestOf,
  manifestDigest,
  reachesOf,
  sourceHash,
  type MethodClass,
  type ResolvedTool,
  type Script,
  type ScriptApproval,
} from "./script.js"

/** What a tool does, before the agent's rules are applied. */
export interface MethodInfo {
  readonly method: string
  readonly action: string
  readonly class: MethodClass
  readonly kind: "family" | "host"
  readonly description?: string
}

/** The one permission assert a script approval makes. */
type Assert = Plugin.Context["permission"]["assert"]

export interface ScriptHost {
  readonly rpc: Plugin.Context["rpc"]
  readonly tool: Pick<Plugin.Context["tool"], "list">
  readonly agent: Pick<Plugin.Context["agent"], "get">
  readonly plugin: Pick<Plugin.Context["plugin"], "list">
  /** The leader's directory: the agent and the loaded plugins are that location's. */
  readonly location: string
  readonly permission: { readonly assert: Assert }
  readonly now: () => number
}

export interface ScriptGate {
  /** Resolves every entry for the agent; an unknown method throws `JOBS_SCRIPT_UNKNOWN_TOOL`. */
  resolve(entries: readonly string[], agentID: string, directory?: string): Promise<readonly ResolvedTool[]>
  /** Resolves, records the approval through the host's one prompt, and returns it. */
  approve(input: { sessionID: string; agent: string; script: Script; resolved: readonly ResolvedTool[]; source?: { readonly messageID: string; readonly id: string } }): Promise<ScriptApproval>
}

const CLASSES: readonly MethodClass[] = ["read", "write", "send", "export", "destructive", "unclassified"]
const classOf = (value: unknown): MethodClass => (typeof value === "string" && (CLASSES as readonly string[]).includes(value) ? (value as MethodClass) : "unclassified")

/** A plugin id and a method from a manifest entry, split at the last dot. */
function split(entry: string): { plugin: string; method: string } {
  const at = entry.lastIndexOf(".")
  return { plugin: entry.slice(0, at), method: entry.slice(at + 1) }
}

/** One contract for a plugin's tools RPC, with only the methods this lookup asks about defined. */
function contract(id: string, methods: readonly string[]) {
  return Rpc.define({
    id: `${id}.tools`,
    methods: {
      describe: { input: { type: "object" }, output: { type: "object" } },
      ...Object.fromEntries(methods.map((name) => [name, { input: { type: "object" }, output: { type: "object" }, errors: { failed: { type: "object" } } }])),
    },
    events: {},
  } as never)
}

/** The `describe` output, as the lookup reads it. */
interface Described {
  readonly methods?: readonly { readonly name?: unknown; readonly action?: unknown; readonly class?: unknown; readonly description?: unknown }[]
}

export function createScriptGate(host: ScriptHost): ScriptGate {
  const described = async (plugin: string, method: string): Promise<MethodInfo | undefined> => {
    try {
      const client = host.rpc(contract(plugin, [method]) as never) as unknown as Record<string, (body: unknown, options?: unknown) => Promise<unknown>>
      const answer = (await client.describe!({})) as Described
      const found = answer.methods?.find((entry) => entry.name === method)
      if (found === undefined || typeof found.action !== "string") return undefined
      return {
        method: `${plugin}.${method}`,
        action: found.action,
        class: classOf(found.class),
        kind: "family",
        ...(typeof found.description === "string" ? { description: found.description } : {}),
      }
    } catch {
      return undefined
    }
  }

  /** A bare service label resolves to the one loaded plugin whose id starts with it and that exposes the method. */
  const family = async (plugin: string, method: string, directory: string): Promise<MethodInfo | undefined> => {
    const direct = await described(plugin, method)
    if (direct !== undefined) return direct
    if (plugin.includes(".")) return undefined
    const listed = (await host.plugin.list({ location: { directory } } as never).catch(() => ({ data: [] }))) as { data?: readonly { id?: string }[] }
    const candidates = (listed.data ?? []).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])).filter((id) => id === plugin || id.split(".")[0] === plugin).slice(0, 12)
    const found = (await Promise.all(candidates.map((id) => described(id, method)))).filter((entry): entry is MethodInfo => entry !== undefined)
    return found.length === 1 ? found[0] : undefined
  }

  const hostTool = async (id: string): Promise<MethodInfo | undefined> => {
    const tool = (await host.tool.list()).find((entry) => entry.id === id || entry.name === id)
    if (tool === undefined) return undefined
    return {
      method: `host:${tool.id}`,
      action: tool.options?.permission ?? tool.id,
      class: "unclassified",
      kind: "host",
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    }
  }

  const lookup = async (entry: string, directory: string): Promise<MethodInfo | undefined> =>
    entry.startsWith("host:") ? hostTool(entry.slice("host:".length)) : family(split(entry).plugin, split(entry).method, directory)

  /** Every name the lookup can see, for the nearest-names hint on an unknown entry. */
  const known = async (): Promise<string[]> => {
    const tools = await host.tool.list().then(
      (listed) => listed.map((entry) => `host:${entry.id}`),
      () => [],
    )
    return tools
  }

  const resolve = async (entries: readonly string[], agentID: string, directory = host.location): Promise<readonly ResolvedTool[]> => {
    // The host's agent view is this location's; passing a location back (especially a Location.Ref carrying a workspace)
    // fails for a project-level plugin on 2.2.4, so only a job that targets another directory names one explicitly.
    const info = await host.agent.get({ agentID, ...(directory === host.location ? {} : { location: { directory } }) }).then(
      (found) => found.data,
      () => undefined,
    )
    if (info === undefined) throw new JobInputError("JOBS_SCRIPT_UNKNOWN_TOOL", "agent", `The agent ${JSON.stringify(agentID)} could not be read, so its rules cannot resolve the script's tools.`, `Name an agent OpenCode lists, then give it its own "permissions".`)
    const rules = (info.permissions ?? []) as readonly Rule[]
    const resolved: ResolvedTool[] = []
    const unknown: string[] = []
    for (const entry of entries) {
      const found = await lookup(entry, directory)
      if (found === undefined) {
        unknown.push(entry)
        continue
      }
      resolved.push({ ...found, effect: evaluate(rules, found.action) })
    }
    if (unknown.length > 0) {
      const names = await known()
      const hint = unknown
        .map((entry) => {
          const tail = entry.startsWith("host:") ? entry.slice(5) : split(entry).method
          const near = names.filter((name) => name.includes(tail) || name.endsWith(tail)).slice(0, 5)
          return `${JSON.stringify(entry)}${near.length === 0 ? "" : ` (did you mean ${near.join(", ")}?)`}`
        })
        .join("; ")
      throw new JobInputError(
        "JOBS_SCRIPT_UNKNOWN_TOOL",
        "action.script.uses",
        `The manifest names ${unknown.length === 1 ? "a tool" : "tools"} the host does not list: ${hint}.`,
        `Use a method the plugin's tools RPC describe lists, as "<plugin id>.<method>", or a tool the host lists, as "host:<tool id>".`,
      )
    }
    return resolved
  }

  const approve: ScriptGate["approve"] = async (input) => {
    const source = sourceHash(input.script.code)
    const manifest = manifestDigest(input.script.uses)
    const digest = digestOf(input.script)
    await host.permission.assert({
      sessionID: input.sessionID,
      agent: input.agent,
      action: "jobs_script",
      resources: [approvalResource(digest)],
      save: [approvalResource(digest)],
      metadata: {
        sourceHash: source,
        manifestDigest: manifest,
        bytes: Buffer.byteLength(input.script.code, "utf8"),
        tools: input.resolved.map((tool) => ({ method: tool.method, class: tool.class, effect: tool.effect, ...(tool.description === undefined ? {} : { description: tool.description }) })),
        writes: reachesOf(input.resolved),
      },
      ...(input.source === undefined ? {} : { source: { type: "tool", messageID: input.source.messageID, id: input.source.id } }),
    })
    return {
      sourceHash: source,
      manifestDigest: manifest,
      digest,
      at: host.now(),
      decision: "once",
      resolved: input.resolved,
    }
  }

  return { resolve, approve }
}
