/**
 * The confined script runtime: QuickJS compiled to WebAssembly, one VM per run, disposed afterwards.
 *
 * The guest gets no filesystem, network, process, environment or timers. Its only outside access is the `tools` proxy,
 * which calls one host function, `__call(method, json)`, and the host refuses anything the manifest does not name.
 * Limits: the job's wall clock (a deadline compared inside the interpreter's interrupt handler, because a JavaScript
 * timer cannot fire during a synchronous loop), memory, tool calls and output.
 *
 * `Intrinsics.EVAL` stays on: with it off QuickJS refuses `evalCode` itself. The guest has no host capability to reach
 * through `eval`, and the only host function is the bridge.
 */
import { existsSync, readFileSync } from "node:fs"
import { QuickJS, Intrinsics } from "quickjs-wasi"
import { reasonOf } from "../redact.js"
import type { FileWrite } from "./script-files.js"
import type { ScriptCall, ScriptLimitFlags, ScriptLimits } from "./script.js"

/** One tool call the guest makes. The host resolves it against the manifest before anything is dispatched. */
export type ScriptBridge = (method: string, input: unknown, signal: AbortSignal) => Promise<unknown>

export interface ScriptRunInput {
  readonly code: string
  readonly allowed: ReadonlySet<string>
  readonly limits: ScriptLimits
  /** The job's wall clock for this run, already capped by its policy. */
  readonly timeoutMs: number
  readonly bridge: ScriptBridge
  /** The declared files: the readable values the guest sees, and the names it may write. */
  readonly files?: { readonly values: Readonly<Record<string, unknown>>; readonly writable: ReadonlyMap<string, number> }
  /** Each manifest method's class, for the per-call rows. */
  readonly classes?: ReadonlyMap<string, string>
  /** The cleanup signal: aborts the VM and any call in flight. */
  readonly signal?: AbortSignal
  /** The clock the deadline and call times read: injected, like every other time in the plugin. */
  readonly now: () => number
}

export interface ScriptRunResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
  readonly calls: readonly ScriptCall[]
  readonly limits: ScriptLimitFlags
  /** True when the result was cut at the output limit and a marker appended. */
  readonly outputTruncated: boolean
  /** The writes the guest buffered; committed only if the run succeeds. */
  readonly writes: readonly FileWrite[]
}

const WASM_CANDIDATES = [
  new URL("./quickjs.wasm", import.meta.url),
  new URL("../../dist/quickjs.wasm", import.meta.url),
  new URL("../../node_modules/quickjs-wasi/quickjs.wasm", import.meta.url),
]
let cached: Uint8Array | undefined

/** The wasm beside the bundle at run time, or beside the build output when the source runs under a test. */
export function quickjsWasm(): Uint8Array {
  if (cached !== undefined) return cached
  for (const candidate of WASM_CANDIDATES) {
    if (existsSync(candidate)) {
      cached = readFileSync(candidate)
      return cached
    }
  }
  throw new Error("jobs: the script runtime's quickjs.wasm is missing from the package")
}

/** The guest prelude: `tools.x.posts.method(input)` and `tools.host.tool_id(input)` both call the one bridge. */
const PRELUDE = `globalThis.tools = (() => {
  const node = (path) => {
    const call = (input) => Promise.resolve(__call(path, JSON.stringify(input === undefined ? {} : input))).then(JSON.parse)
    return new Proxy(call, { get: (_, key) => node(path === "" ? String(key) : path + "." + String(key)) })
  }
  return node("")
})();
globalThis.files = (() => {
  const freeze = (value) => { if (value && typeof value === "object") { for (const key of Object.keys(value)) freeze(value[key]); Object.freeze(value) } return value }
  const values = JSON.parse(__files);
  Object.defineProperty(values, "write", { value: (name, value) => new Promise((resolve) => resolve(__write(name, JSON.stringify(value === undefined ? null : value)))).then(() => undefined), enumerable: false, writable: false })
  return freeze(values)
})();`

const result = (value: unknown): string => JSON.stringify(value === undefined ? null : value)

/** A row written at dispatch and amended when the call settles. */
interface MutableCall {
  readonly method: string
  readonly class?: string
  readonly at: number
  ms: number
  outcome: "ok" | "refused" | "error" | "aborted"
  bytes: number
  code?: string
}

/** The first `CODE:` in an error, for the row: the code, never the message around it. */
const KNOWN_CODES = new Set([
  "TOOL_UNAVAILABLE", "SESSION_UNKNOWN", "SESSION_AGENT_REQUIRED", "PERMISSION_DENIED", "SERVER_CONFLICT", "AUTH_REQUIRED",
  "CONNECTING", "CONNECTION_FAILED", "DISABLED", "NOT_REGISTERED", "UPSTREAM_ERROR", "CANCELLED",
])
/** The first code the family itself raises. Any other upper-case token with a colon is not a code (DF-17). */
const codeOf = (message: string): string | undefined =>
  [...message.matchAll(/\b([A-Z][A-Z_]{2,}|[a-z]+\.[a-z_]+):/g)]
    .map((match) => match[1]!)
    .find((code) => code.startsWith("JOBS_") || code.startsWith("permission.") || KNOWN_CODES.has(code))

export async function runScript(input: ScriptRunInput): Promise<ScriptRunResult> {
  const wasm = quickjsWasm()
  const calls: MutableCall[] = []
  const buffer = new Map<string, string>()
  let buffered = 0
  let dispatched = 0
  const flags = { timedOut: false, memoryExceeded: false, callLimit: false, outputTruncated: false, interrupted: false }
  let deadlineHit = false
  const deadline = input.now() + input.timeoutMs
  const controller = new AbortController()
  const abort = () => controller.abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  let interrupting = false
  let closed = false
  let bytes = 0
  let evalError: unknown

  const vm = await QuickJS.create({
    wasm,
    memoryLimit: input.limits.memoryMb * 1024 * 1024,
    intrinsics: Intrinsics.ALL,
    interruptHandler: () => {
      if (interrupting) return true
      // Only the deadline is a timeout. A kill switch, a cleanup or a host teardown aborts the controller and is
      // recorded as interrupted (D2), never as the script running too long.
      if (input.now() > deadline) {
        flags.timedOut = true
        deadlineHit = true
        interrupting = true
        controller.abort()
        return true
      }
      if (controller.signal.aborted) {
        interrupting = true
        return true
      }
      return false
    },
  })

  try {
    const call = vm.newFunction("__call", (methodHandle: { toString(): string }, jsonHandle: { toString(): string }) => {
      // The guest writes `tools.host.<tool id>`; the manifest and the bridge name it `host:<tool id>`.
      const raw = methodHandle.toString()
      const method = raw.startsWith("host.") ? `host:${raw.slice("host.".length)}` : raw
      const args = jsonHandle.toString()
      const deferred = vm.newPromise()
      const started = input.now()
      // The cap counts at dispatch, synchronously, before any await: a guest that fires calls without awaiting them
      // (Promise.all, fire-and-forget) cannot pass the check for every call at once (SR-1). The row is written at
      // dispatch and amended when the call settles, so the record cannot under-report.
      if (dispatched >= input.limits.maxCalls) {
        flags.callLimit = true
        interrupting = true
        calls.push({ method, at: started, ms: 0, outcome: "refused", bytes: 0, class: input.classes?.get(method), code: "JOBS_SCRIPT_LIMIT" })
        deferred.reject(vm.newError("JOBS_SCRIPT_LIMIT: the script used more tool calls than the job allows."))
        vm.executePendingJobs()
        return deferred.handle
      }
      dispatched += 1
      const row: MutableCall = { method, at: started, ms: 0, outcome: "ok", bytes: 0, ...(input.classes?.get(method) === undefined ? {} : { class: input.classes.get(method) }) }
      calls.push(row)
      void (async () => {
        const settle = (error?: Error) => {
          row.ms = input.now() - started
          // A burst past the cap can settle after the run has ended and the VM is disposed.
          if (closed) return
          if (error === undefined) vm.executePendingJobs()
          else {
            deferred.reject(vm.newError(error.message))
            vm.executePendingJobs()
          }
        }
        if (!input.allowed.has(method)) {
          row.outcome = "refused"
          row.code = "JOBS_SCRIPT_UNKNOWN_TOOL"
          settle(new Error(`JOBS_SCRIPT_UNKNOWN_TOOL: ${method} is not in the job's manifest.`))
          return
        }
        try {
          const value = await input.bridge(method, JSON.parse(args) as unknown, controller.signal)
          // The run can end (a later call hit the cap, or the deadline fired) while this dispatch is in flight: the
          // call happened, but its result is not delivered, and the VM is disposed.
          if (closed) {
            row.outcome = controller.signal.aborted ? "refused" : "error"
            return
          }
          const text = result(value)
          const size = Buffer.byteLength(text, "utf8")
          row.outcome = "ok"
          row.bytes = size
          bytes += size
          if (bytes > input.limits.maxOutputBytes) {
            flags.outputTruncated = true
            interrupting = true
            settle(new Error("JOBS_SCRIPT_LIMIT: the script's tool output is over the limit."))
            return
          }
          deferred.resolve(vm.newString(text))
          settle()
        } catch (error) {
          row.outcome = controller.signal.aborted ? "aborted" : "error"
          const message = short(error)
          row.code = codeOf(message)
          settle(new Error(message))
        }
      })()
      return deferred.handle
    })
    vm.setProp(vm.global, "__call", call)
    vm.setProp(vm.global, "__files", vm.newString(JSON.stringify(input.files?.values ?? {})))
    const write = vm.newFunction("__write", (nameHandle: { toString(): string }, jsonHandle: { toString(): string }) => {
      const name = nameHandle.toString()
      const cap = input.files?.writable.get(name)
      if (cap === undefined) throw new Error(`JOBS_SCRIPT_FILE_MODE: ${name} is not a writable file.`)
      const json = jsonHandle.toString()
      const size = Buffer.byteLength(json, "utf8")
      // Account for the buffer at write time: per file, and for the run, so a loop cannot exhaust the host (DF-5).
      if (size > cap) throw new Error(`JOBS_SCRIPT_FILE_TOO_LARGE: the value written to ${name} is ${size} bytes, over its ${cap} byte limit.`)
      const previous = buffer.get(name)
      const total = buffered - (previous === undefined ? 0 : Buffer.byteLength(previous, "utf8")) + size
      if (total > input.limits.maxFileBytes) {
        throw new Error(`JOBS_SCRIPT_FILE_TOO_LARGE: the run's buffered writes are ${total} bytes, over the ${input.limits.maxFileBytes} byte limit.`)
      }
      buffer.set(name, json)
      buffered = total
      return vm.undefined
    })
    vm.setProp(vm.global, "__write", write)

    const wrapped = `(async () => { "use strict"; ${PRELUDE}; const __value = await (async () => {\n${input.code}\n})(); return JSON.stringify(__value === undefined ? null : __value) })()`
    try {
      const handle = vm.evalCode(wrapped, "script.js", 0)
      vm.executePendingJobs()
      const settled = await vm.resolvePromise(handle)
      if ("error" in settled) {
        evalError = settled.error
        // A QuickJS failure can be a rejected object; read its message, never `[object Object]` (D3).
        const value = settled.error as unknown
        throw new Error(short(value))
      }
      const output = settled.value.toString()
      const size = Buffer.byteLength(output, "utf8")
      if (size > input.limits.maxOutputBytes) {
        flags.outputTruncated = true
        return { ok: true, value: { truncated: true, bytes: size, note: "output truncated at the job's limit" }, calls: [...calls], limits: flags, outputTruncated: true, writes: [...buffer].map(([name, json]) => ({ name, json })) }
      }
      return { ok: true, value: JSON.parse(output) as unknown, calls: [...calls], limits: flags, outputTruncated: false, writes: [...buffer].map(([name, json]) => ({ name, json })) }
    } catch (error) {
      const message = short(error)
      if (/out of memory/i.test(message) || /memory/i.test(String((evalError as { message?: string } | undefined)?.message))) flags.memoryExceeded = true
      // The host tearing a call down (a location reload) says "All fibers interrupted"; that is an abort, not a fault.
      if (/all fibers interrupted|aborted/i.test(message)) flags.interrupted = true
      if (controller.signal.aborted && !deadlineHit && !flags.callLimit && !flags.outputTruncated) flags.interrupted = true
      const external = /external_directory/.test(message)
      const coded = flags.memoryExceeded
        ? "JOBS_SCRIPT_LIMIT: the script ran out of memory. Next step: Raise the job's memory limit, or make the script smaller."
        : flags.callLimit
          ? "JOBS_SCRIPT_LIMIT: the script used too many tool calls. Next step: Raise the job's maxCalls, or make the script call fewer tools."
          : flags.outputTruncated
            ? "JOBS_SCRIPT_LIMIT: the script's output is over the limit. Next step: Raise the job's maxOutputBytes, or return less data."
            : flags.timedOut
              ? "JOBS_SCRIPT_LIMIT: the script ran longer than the job allows. Next step: Raise the job's policy timeout, or give the script a shorter timeoutMs."
              : flags.interrupted
                ? "JOBS_SCRIPT_INTERRUPTED: the run was interrupted. Next step: Run it again with jobs_run_now, or wait for its next slot."
                : external
                  ? "JOBS_SCRIPT_FAILED: a call was refused because its path is outside the agent's project. Next step: Add an `external_directory` allow for that path to the agent's permissions, and keep the declared file inside `scriptFilesRoots`."
                  : "JOBS_SCRIPT_FAILED: the script failed. Next step: Read the script's error, fix the script or its tools, then approve it again if it changed."
      return { ok: false, error: `${coded} (${message})`, calls: [...calls], limits: flags, outputTruncated: flags.outputTruncated, writes: [...buffer].map(([name, json]) => ({ name, json })) }
    }
  } finally {
    closed = true
    input.signal?.removeEventListener("abort", abort)
    vm.dispose()
  }
}

/** A guest or host message, `<name>: <first line>` and bounded, so a record never carries a stack or a payload. */
const short = (error: unknown): string => reasonOf(error, "no reason given")
