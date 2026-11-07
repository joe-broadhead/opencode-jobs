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
})();`

const result = (value: unknown): string => JSON.stringify(value === undefined ? null : value)

/** A row written at dispatch and amended when the call settles. */
interface MutableCall {
  readonly method: string
  readonly at: number
  ms: number
  outcome: "ok" | "refused" | "error"
  bytes: number
}

export async function runScript(input: ScriptRunInput): Promise<ScriptRunResult> {
  const wasm = quickjsWasm()
  const calls: MutableCall[] = []
  let dispatched = 0
  const flags = { timedOut: false, memoryExceeded: false, callLimit: false, outputTruncated: false }
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
      if (controller.signal.aborted || input.now() > deadline) {
        flags.timedOut = true
        interrupting = true
        controller.abort()
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
        calls.push({ method, at: started, ms: 0, outcome: "refused", bytes: 0 })
        deferred.reject(vm.newError("JOBS_SCRIPT_LIMIT: the script used more tool calls than the job allows."))
        vm.executePendingJobs()
        return deferred.handle
      }
      dispatched += 1
      const row: MutableCall = { method, at: started, ms: 0, outcome: "ok", bytes: 0 }
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
          row.outcome = controller.signal.aborted ? "refused" : "error"
          settle(new Error(short(error)))
        }
      })()
      return deferred.handle
    })
    vm.setProp(vm.global, "__call", call)

    const wrapped = `(async () => { ${PRELUDE}; const __value = await (async () => {\n${input.code}\n})(); return JSON.stringify(__value === undefined ? null : __value) })()`
    try {
      const handle = vm.evalCode(wrapped, "script.js", 0)
      vm.executePendingJobs()
      const settled = await vm.resolvePromise(handle)
      if ("error" in settled) {
        evalError = settled.error
        throw new Error(settled.error.toString())
      }
      const output = settled.value.toString()
      const size = Buffer.byteLength(output, "utf8")
      if (size > input.limits.maxOutputBytes) {
        flags.outputTruncated = true
        return { ok: true, value: { truncated: true, bytes: size, note: "output truncated at the job's limit" }, calls: [...calls], limits: flags, outputTruncated: true }
      }
      return { ok: true, value: JSON.parse(output) as unknown, calls: [...calls], limits: flags, outputTruncated: false }
    } catch (error) {
      const message = short(error)
      if (/out of memory/i.test(message) || /memory/i.test(String((evalError as { message?: string } | undefined)?.message))) flags.memoryExceeded = true
      if (controller.signal.aborted && !flags.timedOut && !flags.callLimit && !flags.outputTruncated) flags.timedOut = true
      return { ok: false, error: `${flags.memoryExceeded ? "JOBS_SCRIPT_LIMIT: the script ran out of memory" : flags.callLimit ? "JOBS_SCRIPT_LIMIT: the script used too many tool calls" : flags.outputTruncated ? "JOBS_SCRIPT_LIMIT: the script's output is over the limit" : flags.timedOut ? "JOBS_SCRIPT_LIMIT: the script ran longer than the job allows" : "JOBS_SCRIPT_FAILED: the script failed"}: ${message}`, calls: [...calls], limits: flags, outputTruncated: flags.outputTruncated }
    }
  } finally {
    closed = true
    input.signal?.removeEventListener("abort", abort)
    vm.dispose()
  }
}

/** A guest or host message, one line and bounded, so a record never carries a stack or a payload. */
function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split(/\r?\n/)[0]!.slice(0, 300)
}
