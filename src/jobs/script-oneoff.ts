/**
 * `jobs_run_script`: one approved script, one fresh session, one run, nothing kept.
 *
 * It is the "run this once now" path (D-H). It uses the same gate, manifest checks and approval as a scheduled script,
 * and it returns the script's result to the session that asked, once. No job is created and no run record is written;
 * the session is removed when the run ends, so nothing outlives the call.
 */
import type { Plugin } from "@opencode/plugin"
import { jobsError } from "../constants.js"
import { reasonOf } from "../redact.js"
import { parseScriptDefinition, type Job } from "./model.js"
import { forgetJobSession, rememberJobSession, SELF_DENIES } from "./safety.js"
import { denied, limitsOf, scriptSessionRules, worstClass, type Script, type ScriptApproval, type ScriptCall, type ScriptLimitFlags } from "./script.js"
import type { Access } from "../options.js"
import { createBridge } from "./script-bridge.js"
import { commitFiles, filePolicy, resolveScriptFiles, snapshotFiles, FileCommitError, type FileRecord } from "./script-files.js"
import { scriptDecision, type ScriptGate } from "./script-gate.js"
import { runScript } from "./script-runtime.js"

export interface OneOffInput {
  /** The script definition from the tool, validated exactly as a job's action is. */
  readonly definition: unknown
  /** The agent whose rules resolve the manifest; `build` when none is named (D-B). */
  readonly agent?: string
  /** The calling session, which the approval is asked in and which receives the result. */
  readonly sessionID: string
  /** The calling session's agent, for the approval's own rule. */
  readonly callerAgent: string
  readonly source?: { readonly messageID: string; readonly id: string }
  readonly gate: ScriptGate
  readonly rpc: Plugin.Context["rpc"]
  readonly tool: Pick<Plugin.Context["tool"], "list">
  readonly agentDomain: Pick<Plugin.Context["agent"], "get">
  readonly session: Pick<Plugin.Context["session"], "create" | "remove" | "get">
  readonly clock: { now: () => number }
  readonly location: string
  /** Extra roots a declared file may live in. */
  readonly roots?: readonly string[]
  /** The family access policy (R18). */
  readonly access?: Access
  readonly job: Pick<Job, "id" | "name">
  /** The tool call's stop signal: aborting it ends the script as interrupted, and no declared file is written. */
  readonly signal?: AbortSignal
}

export interface OneOffResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
  readonly calls: readonly ScriptCall[]
  readonly limits: ScriptLimitFlags
  readonly digest: string
  readonly approval: ScriptApproval
  /** The declared files this run read and wrote, never the content. */
  readonly files: readonly { readonly name: string; readonly path: string; readonly mode: string; readonly bytesRead: number; readonly bytesWritten: number; readonly outcome?: string; readonly sha256Before?: string; readonly sha256After?: string }[]
}

const SCRIPT_SESSION_TITLE = "Script · one-off"

/** The result of a script the person stopped: the runtime's own wording for an interrupted run. */
const STOPPED = "JOBS_SCRIPT_INTERRUPTED: the run was interrupted. Next step: Run it again with jobs_run_script."

export async function runScriptOnce(input: OneOffInput): Promise<OneOffResult> {
  // The tool's input carries the agent beside the script; the script's own fields are the definition's.
  const asked = (typeof input.definition === "object" && input.definition !== null ? input.definition : {}) as Record<string, unknown>
  const script: Script = parseScriptDefinition({
    code: asked["code"],
    uses: asked["uses"],
    ...(asked["files"] === undefined ? {} : { files: asked["files"] }),
    ...(asked["timeoutMs"] === undefined ? {} : { timeoutMs: asked["timeoutMs"] }),
    ...(asked["limits"] === undefined ? {} : { limits: asked["limits"] }),
  })
  const agentID = input.agent ?? "build"
  const resolved = await input.gate.resolve(script.uses, agentID, input.location)
  const resolvedFiles = await resolveScriptFiles(script.files, input.location, input.roots ?? [])
  const bad = denied(resolved)
  if (bad.length > 0) {
    const names = bad.map((tool) => `${tool.method} (${tool.action})`).join(", ")
    throw jobsError("JOBS_SCRIPT_DENIED", `The script uses tools its agent denies: ${names}.`, `Remove the deny rule for those tools, or name an agent that allows them. A script cannot be granted a tool its agent denies.`)
  }
  const outside = await input.gate.external?.({ agent: agentID, project: input.location, files: resolvedFiles, location: input.location })
  if (outside !== undefined) {
    throw jobsError(
      "JOBS_SCRIPT_DENIED",
      `The file ${JSON.stringify(outside.name)} at ${JSON.stringify(outside.path)} is outside the project, and the script's agent does not allow external_directory for it.`,
      `Add this rule to that agent's permissions: ${JSON.stringify({ action: "external_directory", resource: outside.resource, effect: "allow" })}.`,
    )
  }
  // OD-29: the access option decides the one approval, as it does for a scheduled script (`scriptDecision`).
  const approved = scriptDecision(input.access ?? "all", worstClass(resolved, resolvedFiles))
  if (approved === "deny") {
    throw jobsError("JOBS_SCRIPT_DENIED", `The script changes something, and the plugin's access option is "read-only".`, `Set the plugin option "access" to "ask-changes" or "all".`)
  }
  let approval: ScriptApproval
  try {
    approval = await input.gate.approve({
      sessionID: input.sessionID,
      agent: input.callerAgent,
      script,
      resolved,
      files: resolvedFiles,
      approved,
      ...(input.source === undefined ? {} : { source: input.source }),
    })
  } catch (error) {
    if (approved === "auto") throw error
    throw jobsError("JOBS_UNCHECKED", `The script changes something and needs a person's approval, and no one answered (${reasonOf(error)}).`, `Approve it in the OpenCode TUI, or set the plugin option "access" to "all" for automatic approval.`)
  }
  const policy = await filePolicy(input.location, input.roots ?? [])
  const snapshots = await snapshotFiles(resolvedFiles, { policy })
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (input.signal?.aborted === true) stop()
  else input.signal?.addEventListener("abort", stop, { once: true })
  const created = await input.session.create({
    location: { directory: input.location },
    agent: agentID,
    title: SCRIPT_SESSION_TITLE,
    permissions: scriptSessionRules(resolved, SELF_DENIES),
    metadata: { jobs: { script: "one-off" } },
  })
  rememberJobSession(created.id)
  try {
    const bridge = createBridge({ rpc: input.rpc, tool: input.tool, session: input.session, agent: input.agentDomain, sessionID: created.id, agentID, manifest: resolved })
    const outcome = await runScript({
      code: script.code,
      allowed: new Set(resolved.map((tool) => tool.method)),
      limits: limitsOf(script),
      timeoutMs: script.timeoutMs ?? 30 * 60_000,
      bridge,
      signal: controller.signal,
      now: input.clock.now,
      files: {
        values: Object.fromEntries(snapshots.filter((snapshot) => snapshot.file.mode !== "write").map((snapshot) => [snapshot.file.name, snapshot.value] as const)),
        writable: new Map(resolvedFiles.filter((file) => file.mode !== "read").map((file) => [file.name, file.maxBytes] as const)),
      },
      classes: new Map(resolved.map((tool) => [tool.method, tool.class] as const)),
    })
    let committed: readonly FileRecord[] = []
    let commitError: unknown
    // A stop that arrived while the script ran ends it as interrupted, even if the VM finished first: nothing it
    // buffered is written.
    const stopped = input.signal?.aborted === true
    if (outcome.ok && !stopped) {
      try {
        committed = await commitFiles(snapshots, outcome.writes, { policy, now: input.clock.now })
      } catch (error) {
        commitError = error
        committed = error instanceof FileCommitError ? error.records : []
      }
    }
    const files = snapshots.map((snapshot) => {
      const written = committed.find((record) => record.name === snapshot.file.name)
      return {
        name: snapshot.file.name,
        path: snapshot.file.path,
        mode: snapshot.file.mode,
        bytesRead: snapshot.bytes,
        bytesWritten: written?.bytesWritten ?? 0,
        outcome: written?.outcome ?? "not_attempted",
        ...(snapshot.sha256 === null ? {} : { sha256Before: snapshot.sha256 }),
        ...(written?.sha256After === undefined ? {} : { sha256After: written.sha256After }),
      }
    })
    const ok = outcome.ok && !stopped && commitError === undefined
    const error = stopped ? (outcome.ok ? STOPPED : outcome.error) : commitError === undefined ? outcome.error : reasonOf(commitError)
    return {
      ok,
      ...(ok ? { value: outcome.value } : { error }),
      calls: outcome.calls,
      limits: stopped ? { ...outcome.limits, interrupted: true } : outcome.limits,
      digest: approval.digest,
      approval,
      files,
    }
  } finally {
    input.signal?.removeEventListener("abort", stop)
    forgetJobSession(created.id)
    await input.session.remove({ sessionID: created.id }).catch(() => undefined)
  }
}
