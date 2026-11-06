import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID } from "./constants.js"
import { checkHost } from "./host-version.js"
import { refusalFor, unguardedAgents, type AgentInfo } from "./host/permissions.js"
import { registerToolsRpc } from "./host/tools-rpc.js"
import { adopt } from "./jobs/adopt.js"
import { systemClock, type Clock } from "./jobs/clock.js"
import { createExecutor } from "./jobs/execute.js"
import { readJobFiles, type AgentGuard } from "./jobs/files.js"
import { startKeepAlive, type KeepAlive } from "./jobs/keepalive.js"
import { Leader } from "./jobs/leader.js"
import { serverTimezone, type Job } from "./jobs/model.js"
import { registerSafety } from "./jobs/safety.js"
import { Runner } from "./jobs/runner.js"
import { migrate, readJobs, readPauseAll, setPauseAll } from "./jobs/store.js"
import { parseOptions } from "./options.js"
import { registerStatusRpc } from "./rpc.js"
import { buildStatus, registerPauseCommand, registerStatusCommand } from "./status.js"

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
      const problems = await openStore(ctx)
      const read = async () => {
        const check = await agentCheck(ctx)
        const jobs = await known(ctx, timezone, clock, check.guard)
        const paused = await readPauseAll(ctx.storage).catch(() => undefined)
        return buildStatus({
          host,
          enabled: options.enabled,
          jobs: { total: jobs.files.jobs.length, paused: 0, expiring: 0, invalidFiles: jobs.files.invalid.length },
          // An agent nobody's job names is not jobs' business: the agents a job targets, refused ones included.
          unguardedAgents: unguardedAgents(check.list, [...jobs.jobs.map((job) => job.agent), ...jobs.files.refused]),
          ...(paused === undefined ? {} : { paused }),
          problems: [...problems, ...jobs.files.invalid.map((file) => file.message)],
        })
      }
      // Transforms replay on every rebuild, so each registration is disposed on cleanup in reverse order.
      const stops = [
        await registerStatusCommand(ctx, read),
        await registerPauseCommand(ctx, async () => {
          const paused = await readPauseAll(ctx.storage)
          const next = await setPauseAll(ctx.storage, paused === undefined, clock.now())
          worker?.wake()
          return next
        }),
        await registerStatusRpc(ctx.rpc, read),
        // Scripts call the known reads with no model, as a session and its agent.
        await registerToolsRpc(ctx, { owned: [] }),
        // The one evaluate hook: a run of ours never waits for an approval nobody can give.
        await registerSafety(ctx.permission),
      ]
      const worker = options.enabled ? startWorker(ctx, { clock, timezone, concurrency: options.concurrency, loop: deps.loop !== false, deps }) : undefined
      return async () => {
        for (const stop of stops.reverse()) await stop()
        await worker?.stop()
      }
    },
  })
}

/** The guarded-agent check for the host's agents now: no list means no check, and the evaluate hook is the backstop. */
async function agentCheck(ctx: Pick<Plugin.Context, "agent">): Promise<{ readonly list: readonly AgentInfo[]; readonly guard?: AgentGuard }> {
  const list = await ctx.agent.list().then(
    (found) => found.data,
    () => [],
  )
  if (list.length === 0) return { list }
  return { list, guard: (agent: string) => refusalFor(list, agent) }
}

interface KnownJobs {
  readonly files: Awaited<ReturnType<typeof readJobFiles>>
  /** The store's tool jobs, with a file job of the same id winning, because the file is the definition a project commits. */
  readonly jobs: readonly Job[]
}

/** Every job this instance knows, read now: a refused file is reported, never thrown, and never becomes a job. */
async function known(ctx: Pick<Plugin.Context, "storage" | "location" | "agent">, timezone: string, clock: Clock, guard?: AgentGuard): Promise<KnownJobs> {
  const stored = await readJobs(ctx.storage).catch(() => [])
  const files = await readJobFiles({
    now: clock.now(),
    timezone,
    projects: [ctx.location.directory],
    ...(guard === undefined ? {} : { guard }),
  }).catch(() => ({ jobs: [], invalid: [], refused: [] }))
  const byId = new Map(files.jobs.map((job) => [job.id, job] as const))
  for (const job of stored) if (!byId.has(job.id)) byId.set(job.id, job)
  return { files, jobs: [...byId.values()] }
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
  /** Wakes the runner now, when this instance leads; safe when it does not. */
  readonly wake: () => void
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
    wake: () => runner?.wake(),
    stop: async () => {
      await leader.release()
      stopped.abort()
    },
  }

  // Every job this leader knows, read the same way status reads them, so a refused file never becomes a job.
  const jobs = async (): Promise<readonly Job[]> => {
    const check = await agentCheck(ctx)
    return (await known(ctx, input.timezone, input.clock, check.guard)).jobs
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
        agents: ctx.agent,
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

/**
 * The store's schema is brought up to date once per setup, and a schema a newer build wrote is a status problem: the
 * rest of the plugin still answers, and nothing runs on a store it does not understand.
 */
async function openStore(ctx: Pick<Plugin.Context, "storage">): Promise<string[]> {
  return migrate(ctx.storage).then(
    () => [],
    (error: unknown) => [error instanceof Error ? error.message : String(error)],
  )
}
