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
  /** The total bytes one run may buffer across its declared files; 8 MB by default, 32 MB at most. */
  readonly maxFileBytes: number
}

/** How a declared file may be used: read before the run, written after it, or both. */
export type ScriptFileMode = "read" | "write" | "readwrite"
/** A file's format: JSON (parsed/serialised) or plain text. */
export type ScriptFileFormat = "json" | "text"

/** One file the script may see or write, as authored: the path is relative to the job's directory or absolute. */
export interface ScriptFile {
  readonly path: string
  readonly mode: ScriptFileMode
  readonly format: ScriptFileFormat
  /** The per-run read and write cap; the default is 1 MB, the maximum 8 MB. */
  readonly maxBytes?: number
}

/** The script an action carries. The limits are optional in the definition and resolved by `limitsOf`. */
export interface Script {
  /** The exact source the person approved. */
  readonly code: string
  /** Exact methods: `<plugin id>.<method>` or `host:<exact tool id>`. */
  readonly uses: readonly string[]
  /** Declared files, by name: `files.<name>` in the guest, and `files.write(name, value)` for a writable one. */
  readonly files?: Readonly<Record<string, ScriptFile>>
  /** A per-run wall clock, capped by the job's own `policy.timeout`. */
  readonly timeoutMs?: number
  readonly limits?: Partial<ScriptLimits>
}

/** The defaults D-E records: 100 calls, 64 MB, 64 KB and 8 MB of buffered files. */
export const SCRIPT_DEFAULTS: ScriptLimits = { memoryMb: 64, maxCalls: 100, maxOutputBytes: 64 * 1024, maxFileBytes: 8 * 1024 * 1024 }

/** The hard caps: 1,000 calls as D-E says, and bounds that keep one run from exhausting the host. */
export const SCRIPT_MAX: ScriptLimits = { memoryMb: 512, maxCalls: 1_000, maxOutputBytes: 1024 * 1024, maxFileBytes: 32 * 1024 * 1024 }

/** A script is source code, not a document: past this it is refused rather than stored. */
export const SCRIPT_SOURCE_MAX = 64 * 1024

/** A file's cap: 1 MB by default, 8 MB at most, and at most this many files a job. */
export const SCRIPT_FILE_DEFAULT_MAX = 1024 * 1024
export const SCRIPT_FILE_MAX = 8 * 1024 * 1024
export const SCRIPT_MAX_FILES = 8

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
  /** The method's class from its `describe`, when the manifest resolved one. */
  readonly class?: string
  /** When the call started, as an instant. */
  readonly at: number
  readonly ms: number
  readonly outcome: "ok" | "refused" | "error" | "aborted"
  /** The size of the result the guest received, in bytes. */
  readonly bytes: number
  /** A coded failure's code, the first `CODE:` in the error, never its payload. */
  readonly code?: string
}

/** Which limit, if any, ended a run. */
export interface ScriptLimitFlags {
  readonly timedOut: boolean
  readonly memoryExceeded: boolean
  readonly callLimit: boolean
  readonly outputTruncated: boolean
  /** The run was aborted from outside (the kill switch, a cleanup, a host teardown), not by its deadline. */
  readonly interrupted: boolean
}

/** A declared file, resolved against the job's directory and the allowed roots, as the approval names it. */
export interface ResolvedFile {
  readonly name: string
  readonly path: string
  readonly mode: ScriptFileMode
  readonly format: ScriptFileFormat
  readonly maxBytes: number
}

/** The approval a job's script carries in its runtime state, never in its authored definition. */
export interface ScriptApproval {
  readonly sourceHash: string
  readonly manifestDigest: string
  /** The declared files fingerprint: names, paths, modes, formats and caps (D-A extended by §12). */
  readonly filesDigest: string
  readonly digest: string
  readonly at: number
  /** The host permission request id, when the assert answered one. */
  readonly requestID?: string
  readonly resolved: readonly ResolvedTool[]
  /** The files as resolved and shown at approval; a run re-resolves them and compares. */
  readonly files: readonly ResolvedFile[]
  /** `auto` when the access policy approved it without a prompt; `prompt` when a person answered the one assert. */
  readonly approved?: "auto" | "prompt"
}

/** The manifest's worst class: any method beyond `read`, or a declared file that writes, is a change (R18/GAP-21). */
export const worstClass = (resolved: readonly ResolvedTool[], files: readonly ResolvedFile[] = []): "read" | "change" =>
  resolved.some((tool) => tool.class !== "read") || files.some((file) => file.mode !== "read") ? "change" : "read"

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

/**
 * The declared files fingerprint: each name, path, mode, format and cap, sorted. A path, mode, format or cap change
 * therefore changes the approval digest and makes the job unapproved, without consulting the host (§12).
 */
export const filesDigest = (files: Script["files"] = {}): string =>
  sha256(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, file]) => `${name}\0${file.path}\0${file.mode}\0${file.format}\0${file.maxBytes ?? SCRIPT_FILE_DEFAULT_MAX}`)
      .join("\n"),
  )

/**
 * The resolved paths fingerprint: each name and its canonical path, sorted. It is part of the approval digest, so a
 * saved "Always allow" names the exact files it grants and cannot cross into another directory (DF-8).
 */
export const pathsDigest = (files: readonly ResolvedFile[] = []): string =>
  sha256(
    [...files]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((file) => `${file.name}\0${file.path}`)
      .join("\n"),
  )

/** The approval's resource: the source, the manifest, the declared files and their resolved paths. */
export const scriptDigest = (source: string, manifest: string, files = "", paths = ""): string => sha256(`script\0${source}\0${manifest}\0${files}\0${paths}`)

/** The digest of a script definition, with the resolved files when a run or an approval has them. */
export const digestOf = (script: Script, resolvedFiles: readonly ResolvedFile[] = []): string =>
  scriptDigest(sourceHash(script.code), manifestDigest(script.uses), filesDigest(script.files), pathsDigest(resolvedFiles))

/** The approval resource the permission request names, and the saved rule is bound to. */
export const approvalResource = (digest: string): string => `script:sha256:${digest}`

/** The limits one run gets: the defaults, the job's own values, and the hard caps. */
export function limitsOf(script: Script): ScriptLimits {
  const asked = script.limits ?? {}
  return {
    memoryMb: Math.min(SCRIPT_MAX.memoryMb, Math.max(1, Math.floor(asked.memoryMb ?? SCRIPT_DEFAULTS.memoryMb))),
    maxCalls: Math.min(SCRIPT_MAX.maxCalls, Math.max(1, Math.floor(asked.maxCalls ?? SCRIPT_DEFAULTS.maxCalls))),
    maxOutputBytes: Math.min(SCRIPT_MAX.maxOutputBytes, Math.max(256, Math.floor(asked.maxOutputBytes ?? SCRIPT_DEFAULTS.maxOutputBytes))),
    maxFileBytes: Math.min(SCRIPT_MAX.maxFileBytes, Math.max(1024, Math.floor(asked.maxFileBytes ?? SCRIPT_DEFAULTS.maxFileBytes))),
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

/**
 * True when the approval names these exact hashes and the same tools, with the same actions and classes. The current
 * **effect** is deliberately not compared: the approval binds the source, the manifest and each tool's class, so a rule
 * that later denies a method still matches here and the run reports `revoked` (with the method and rule), while a source
 * edit is `unapproved`. Restoring the rule resumes without a new approval.
 */
export function approvalMatches(approval: ScriptApproval | undefined, script: Script, resolved: readonly ResolvedTool[], resolvedFiles?: readonly ResolvedFile[]): boolean {
  if (approval === undefined) return false
  if (approval.sourceHash !== sourceHash(script.code) || approval.manifestDigest !== manifestDigest(script.uses)) return false
  if (approval.filesDigest !== filesDigest(script.files)) return false
  if (resolvedFiles !== undefined) {
    if (approval.digest !== digestOf(script, resolvedFiles)) return false
    if (approval.files.length !== resolvedFiles.length) return false
    const before = new Map(approval.files.map((file) => [file.name, file] as const))
    if (!resolvedFiles.every((file) => {
      const previous = before.get(file.name)
      return previous !== undefined && previous.path === file.path && previous.mode === file.mode && previous.format === file.format && previous.maxBytes === file.maxBytes
    })) return false
  }
  const approved = new Map(approval.resolved.map((tool) => [tool.method, tool] as const))
  if (approved.size !== resolved.length) return false
  return resolved.every((tool) => {
    const before = approved.get(tool.method)
    return before !== undefined && before.action === tool.action && before.class === tool.class && before.kind === tool.kind
  })
}

/**
 * True when the approval names this script's exact source, manifest and declared files, and — when a run or status
 * supplies them — its exact resolved paths, without consulting the host.
 */
export const approvalCurrent = (approval: ScriptApproval | undefined, script: Script, resolvedFiles?: readonly ResolvedFile[]): boolean =>
  approval !== undefined &&
  approval.sourceHash === sourceHash(script.code) &&
  approval.manifestDigest === manifestDigest(script.uses) &&
  approval.filesDigest === filesDigest(script.files) &&
  (resolvedFiles === undefined || approval.digest === digestOf(script, resolvedFiles))

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
