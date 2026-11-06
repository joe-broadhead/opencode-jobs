import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, errorText } from "./constants.js"
import { checkHost } from "./host-version.js"
import { registerToolsRpc } from "./host/tools-rpc.js"
import { adopt } from "./jobs/adopt.js"
import { systemClock, type Clock } from "./jobs/clock.js"
import { createExecutor } from "./jobs/execute.js"
import { readJobFiles } from "./jobs/files.js"
import { startKeepAlive, type KeepAlive } from "./jobs/keepalive.js"
import { Leader } from "./jobs/leader.js"
import { serverTimezone, type Job } from "./jobs/model.js"
import { Runner } from "./jobs/runner.js"
import { migrate, readJobs } from "./jobs/store.js"
import { parseOptions } from "./options.js"
import { registerStatusRpc } from "./rpc.js"
import { buildStatus, registerStatusCommand, type JobsCount } from "./status.js"

interface Facts {
  readonly jobs: JobsCount
  readonly problems: readonly string[]
}

/** Injected by tests: a clock, and whether the loop ticks itself. Production passes nothing. */
export interface JobsDeps {
  readonly clock?: Clock
  /** False leaves the loop to the caller, which ticks with `Runner.tick(now)` and beats the keep-alive by hand. */
  readonly loop?: boolean
  /** Called with every leader this setup creates, leading or following, so a test can see both instances. */
  readonly onLeader?: (leader: Leader) => void
  readonly onWorker?: (worker: Worker) => void
}

/**
 * Registers the status surfaces and both RPCs, reads what there is to report, and starts the worker: leader election,
 * then the runner, the keep-alive and adoption of anything the last leader left in flight. Nothing here touches a
 * session until this instance holds the lease.
 */
export function createJobsPlugin(deps: JobsDeps = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options)
      const host = checkHost(ctx.app.version, options.allowUntestedHost)
      const timezone = options.timezone ?? serverTimezone()
      const clock = deps.clock ?? systemClock
      const facts = await load(ctx, timezone, clock)
      const read = async () => buildStatus({ host, enabled: options.enabled, jobs: facts.jobs, problems: facts.problems })
      // Transforms replay on every rebuild, so each registration is disposed on cleanup in reverse order.
      const stops = [
        await registerStatusCommand(ctx, read),
        await registerStatusRpc(ctx.rpc, read),
        // Scripts call the known reads with no model, as a session and its agent.
        await registerToolsRpc(ctx, { owned: [] }),
      ]
      const worker = options.enabled ? startWorker(ctx, { clock, timezone, concurrency: options.concurrency, loop: deps.loop !== false, deps }) : undefined
      return async () => {
        for (const stop of stops.reverse()) await stop()
        await worker?.stop()
      }
    },
  })
}

interface WorkerInput {
  readonly clock: Clock
  readonly timezone: string
  readonly concurrency: number
  readonly loop: boolean
  readonly deps: JobsDeps
}

export interface Worker {
  readonly leader: Leader
  readonly runner: Runner
  readonly keepAlive: KeepAlive
  /** The plugin's own storage, which every job and run key lives in. */
  readonly storage: Plugin.Context["storage"]
  readonly stop: () => Promise<void>
}

/** One leader, and the runner it owns while it leads. A step down stops the runner and lets the next leader adopt. */
function startWorker(ctx: Plugin.Context, input: WorkerInput): Worker {
  let runner: Runner | undefined
  let keepAlive: KeepAlive | undefined
  let stopped = new AbortController()
  let leader: Leader

  const worker: Worker = {
    get leader() {
      return leader
    },
    get runner() {
      if (runner === undefined) throw new Error("jobs: the runner is not running in this instance")
      return runner
    },
    get keepAlive() {
      if (keepAlive === undefined) throw new Error("jobs: the keep-alive is not running in this instance")
      return keepAlive
    },
    storage: ctx.storage,
    stop: async () => {
      await leader.release()
      stopped.abort()
    },
  }

  // Every job this leader knows: the store's tool jobs, with a file job of the same id winning, because the file is the
  // definition a project commits.
  const jobs = async (): Promise<readonly Job[]> => {
    const stored = await readJobs(ctx.storage).catch(() => [])
    const files = await readJobFiles({ now: input.clock.now(), timezone: input.timezone, projects: [ctx.location.directory] }).catch(() => ({ jobs: [], invalid: [] }))
    const byId = new Map(files.jobs.map((job) => [job.id, job] as const))
    for (const job of stored) if (!byId.has(job.id)) byId.set(job.id, job)
    return [...byId.values()]
  }

  leader = new Leader({
    storage: ctx.storage,
    clock: input.clock,
    location: ctx.location.directory,
    onLead: () => {
      stopped = new AbortController()
      const execute = createExecutor({
        storage: ctx.storage,
        session: ctx.session,
        clock: input.clock,
        location: ctx.location.directory,
        token: leader.token,
        signal: stopped.signal,
      })
      runner = new Runner({
        storage: ctx.storage,
        clock: input.clock,
        jobs,
        execute,
        active: () => leader.isLeader,
        concurrency: input.concurrency,
        location: ctx.location.directory,
      })
      keepAlive = startKeepAlive({
        session: ctx.session,
        clock: input.clock,
        location: ctx.location.directory,
        active: () => leader.isLeader,
      })
      input.deps.onWorker?.(worker)
      // Adoption re-attaches to runs the last leader left busy; it must not block the loop.
      void jobs()
        .then((known) => adopt({ storage: ctx.storage, session: ctx.session, clock: input.clock, active: () => leader.isLeader, jobs: known, signal: stopped.signal }))
        .then(() => runner?.wake(), () => undefined)
      if (input.loop) {
        runner.start()
        keepAlive.start()
      }
    },
    onStepDown: () => {
      keepAlive?.stop()
      keepAlive = undefined
      runner?.stop()
      runner = undefined
      stopped.abort()
    },
  })
  input.deps.onLeader?.(leader)
  leader.start()
  return worker
}

/** The store's schema is brought up to date once per setup; a file that cannot be read is a status problem, not a throw. */
async function load(ctx: Pick<Plugin.Context, "storage" | "location">, timezone: string, clock: Clock): Promise<Facts> {
  const problems: string[] = []
  try {
    await migrate(ctx.storage)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  const files = await readJobFiles({ now: clock.now(), timezone, projects: [ctx.location.directory] }).catch((error: unknown) => ({
    jobs: [],
    invalid: [{ path: ctx.location.directory, message: errorText("JOBS_INVALID_FILE", `The job files could not be read (${reasonOf(error)}).`, `Check that the job folders are readable, then restart OpenCode.`) }],
  }))
  return {
    // Nothing can create or pause a job yet, so only the file counts are known here.
    jobs: { total: files.jobs.length, paused: 0, expiring: 0, invalidFiles: files.invalid.length },
    problems: [...problems, ...files.invalid.map((file) => file.message)],
  }
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
