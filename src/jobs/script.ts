/**
 * A script job's definition, digest and approval, and the rules its run session is built from.
 *
 * A script is the one action that runs without a model. Its confinement is the manifest: the run session is a blanket
 * deny followed by one allow for each tool the manifest names that the agent's own rules resolve to `allow` or `ask`,
 * and the runtime refuses any call the manifest does not name. A method that resolves to `deny` is never granted — a
 * session `allow` beats an agent `deny` in OpenCode, so writing one would widen the agent (V3, S2).
 *
 * The approval is bound to the source and the manifest (D-A): `sha256("script\0" + sourceHash + "\0" + manifestDigest)`.
 * A changed byte or a changed tool produces a new digest, and the host's saved approval is per exact digest, so it can
 * only ever re-approve the script a person read.
 */
import { createHash } from "node:crypto"

/** The worst branch a tool can reach, as the family's method tables name it (v2). An unknown tool is unclassified. */
export type MethodClass = "read" | "write" | "send" | "export" | "destructive" | "unclassified"

/** The limits one run gets, all resolved. */
export interface ScriptLimits {
  readonly memoryMb: number
  readonly maxCalls: number
  readonly maxOutputBytes: number
}

/** The script an action carries. The limits are optional in the definition and resolved by `limitsOf`. */
export interface Script {
  /** The exact source the person approved. */
  readonly code: string
  /** Exact methods: `<plugin id>.<method>` or `host:<exact tool id>`. */
  readonly uses: readonly string[]
  /** A per-run wall clock, capped by the job's own `policy.timeout`. */
  readonly timeoutMs?: number
  readonly limits?: Partial<ScriptLimits>
}

/** The defaults D-E records: 100 calls, 64 MB and 64 KB. */
export const SCRIPT_DEFAULTS: ScriptLimits = { memoryMb: 64, maxCalls: 100, maxOutputBytes: 64 * 1024 }

/** The hard caps: 1,000 calls as D-E says, and bounds that keep one run from exhausting the host. */
export const SCRIPT_MAX: ScriptLimits = { memoryMb: 512, maxCalls: 1_000, maxOutputBytes: 1024 * 1024 }

/** A script is source code, not a document: past this it is refused rather than stored. */
export const SCRIPT_SOURCE_MAX = 64 * 1024

/** One manifest entry, resolved against the host and the agent's rules. */
export interface ResolvedTool {
  /** The canonical manifest entry: `<plugin id>.<method>` or `host:<tool id>`. */
  readonly method: string
  /** The permission action the host or the tool asserts. */
  readonly action: string
  readonly class: MethodClass
  readonly kind: "family" | "host"
  /** What the tool does, for the approval request and status; host text, cut by the caller. */
  readonly description?: string
  /** The agent's own resolution at the moment this was read: allow, ask or deny. */
  readonly effect: "allow" | "ask" | "deny"
}

/** One call the script made: no input and no output, only what the record needs (D-C). */
export interface ScriptCall {
  readonly method: string
  /** When the call started, as an instant. */
  readonly at: number
  readonly ms: number
  readonly outcome: "ok" | "refused" | "error"
  /** The size of the result the guest received, in bytes. */
  readonly bytes: number
}

/** Which limit, if any, ended a run. */
export interface ScriptLimitFlags {
  readonly timedOut: boolean
  readonly memoryExceeded: boolean
  readonly callLimit: boolean
  readonly outputTruncated: boolean
}

/** The approval a job's script carries in its runtime state, never in its authored definition. */
export interface ScriptApproval {
  readonly sourceHash: string
  readonly manifestDigest: string
  readonly digest: string
  readonly at: number
  /** The host permission request id, when the assert answered one. */
  readonly requestID?: string
  readonly resolved: readonly ResolvedTool[]
}

/** One narrowed rule, as the run session takes it. */
export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/** The digest of the source alone. */
export const sourceHash = (code: string): string => sha256(code)

/** The digest of the manifest alone: sorted and canonical, so order and duplicates do not change it. */
export const manifestDigest = (uses: readonly string[]): string => sha256([...new Set(uses)].sort().join("\n"))

/** The approval's resource: both parts, as D-A binds it. */
export const scriptDigest = (source: string, manifest: string): string => sha256(`script\0${source}\0${manifest}`)

/** The digest of a script definition. */
export const digestOf = (script: Script): string => scriptDigest(sourceHash(script.code), manifestDigest(script.uses))

/** The approval resource the permission request names, and the saved rule is bound to. */
export const approvalResource = (digest: string): string => `script:sha256:${digest}`

/** The limits one run gets: the defaults, the job's own values, and the hard caps. */
export function limitsOf(script: Script): ScriptLimits {
  const asked = script.limits ?? {}
  return {
    memoryMb: Math.min(SCRIPT_MAX.memoryMb, Math.max(1, Math.floor(asked.memoryMb ?? SCRIPT_DEFAULTS.memoryMb))),
    maxCalls: Math.min(SCRIPT_MAX.maxCalls, Math.max(1, Math.floor(asked.maxCalls ?? SCRIPT_DEFAULTS.maxCalls))),
    maxOutputBytes: Math.min(SCRIPT_MAX.maxOutputBytes, Math.max(256, Math.floor(asked.maxOutputBytes ?? SCRIPT_DEFAULTS.maxOutputBytes))),
  }
}

/**
 * The run session's rules: the blanket deny, one allow per granted method, then the job-state denies. Only a method
 * that resolved to `allow` or `ask` is granted; a `deny` never is. Two methods that share an action are granted once.
 */
export function scriptSessionRules(resolved: readonly ResolvedTool[], selfDenies: readonly Rule[]): readonly Rule[] {
  const granted = new Set<string>()
  const allows: Rule[] = []
  for (const tool of resolved) {
    if (tool.effect === "deny" || granted.has(tool.action)) continue
    granted.add(tool.action)
    allows.push({ action: tool.action, resource: "*", effect: "allow" })
  }
  return [{ action: "*", resource: "*", effect: "deny" }, ...allows, ...selfDenies]
}

/** True when the approval names these exact hashes and the same tools, with the same actions and classes. */
export function approvalMatches(approval: ScriptApproval | undefined, script: Script, resolved: readonly ResolvedTool[]): boolean {
  if (approval === undefined) return false
  if (approval.sourceHash !== sourceHash(script.code) || approval.manifestDigest !== manifestDigest(script.uses)) return false
  const approved = new Map(approval.resolved.map((tool) => [tool.method, tool] as const))
  if (approved.size !== resolved.length) return false
  return resolved.every((tool) => {
    const before = approved.get(tool.method)
    return before !== undefined && before.action === tool.action && before.class === tool.class && before.kind === tool.kind && before.effect === tool.effect
  })
}

/** True when the approval names this script's exact source and manifest, without consulting the host again. */
export const approvalCurrent = (approval: ScriptApproval | undefined, script: Script): boolean =>
  approval !== undefined && approval.sourceHash === sourceHash(script.code) && approval.manifestDigest === manifestDigest(script.uses)

/** What a class means for a person reading the approval: the line the request carries for each write-ish tool. */
export function reachesOf(resolved: readonly ResolvedTool[]): readonly string[] {
  return resolved
    .filter((tool) => tool.class !== "read")
    .map((tool) => {
      const what = tool.class === "unclassified" ? "an unclassified tool" : `a ${tool.class}`
      return `${tool.method}: ${what}${tool.description === undefined ? "" : ` — ${tool.description}`}`
    })
}

/** The methods that resolved to deny, which refuse the approval and later the run. */
export const denied = (resolved: readonly ResolvedTool[]): readonly ResolvedTool[] => resolved.filter((tool) => tool.effect === "deny")
