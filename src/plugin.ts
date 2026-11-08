import { Plugin } from "@opencode/plugin"
import { registerCommands } from "./commands.js"
import { PLUGIN_ID } from "./constants.js"
import { checkHost } from "./host-version.js"
import { insertDefaultRules } from "./host/permissions.js"
import { registerToolsRpc } from "./host/tools-rpc.js"
import { pauseEveryJob, runNow, type ActionInput } from "./jobs/actions.js"
import { adopt } from "./jobs/adopt.js"
import { systemClock, type Clock } from "./jobs/clock.js"
import { createExecutor } from "./jobs/execute.js"
import { keepAlivePeriod, startKeepAlive, type KeepAlive } from "./jobs/keepalive.js"
import { Leader } from "./jobs/leader.js"
import { HOUR, serverTimezone, type Job } from "./jobs/model.js"
import { createReport, readSource, type Report } from "./jobs/report.js"
import { approveJob } from "./jobs/actions.js"
import { createScriptGate, type ScriptGate } from "./jobs/script-gate.js"
import { runScriptOnce } from "./jobs/script-oneoff.js"
import { registerSafety } from "./jobs/safety.js"
import { Runner } from "./jobs/runner.js"
import { migrate, pruneWithSessions, putBeat, readPauseAll } from "./jobs/store.js"
import { ownedMethods, toolTransform, type ToolInput } from "./jobs/tools.js"
import { createFileWatch, type FileWatch } from "./jobs/watch.js"
import { parseOptions, type Access } from "./options.js"
import { registerStatusRpc } from "./rpc.js"

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
 * Registers every surface — the tools, the commands, both RPCs and the one evaluate hook — and starts the worker:
 * leader election, then the runner, the keep-alive and adoption of anything the last leader left in flight. Nothing
 * here touches a session until this instance holds the lease.
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
      // A store a newer build wrote is status-only: no worker, and every change refused.
      const ready = problems.length === 0
      // The job files are checked once a minute, and parsed again only when one changed.
      const watch = createFileWatch(() => clock.now())
      const report = createReport({
        storage: ctx.storage,
        location: ctx.location.directory,
        timezone,
        clock,
        agent: ctx.agent,
        host,
        enabled: options.enabled,
        keepAliveMinutes: options.keepAliveMinutes,
        problems,
        watch,
        scriptFilesRoots: options.scriptFilesRoots,
      })
      const scripts = createScriptGate({
        rpc: ctx.rpc,
        tool: ctx.tool,
        agent: ctx.agent,
        plugin: ctx.plugin,
        mcp: ctx.mcp,
        location: ctx.location.directory,
        permission: ctx.permission,
        now: () => clock.now(),
      })
      const actions: ActionInput = {
        storage: ctx.storage,
        agent: ctx.agent,
        clock,
        timezone,
        location: ctx.location.directory,
        source: () => report.source(),
        wake: () => worker?.wake(),
        ready,
        scripts,
        scriptFilesRoots: options.scriptFilesRoots,
        access: options.access,
      }
      const tools: ToolInput = {
        ...actions,
        report,
        assert: (check) => ctx.permission.assert(check),
        runScriptOnce: (definition, call) =>
          runScriptOnce({
            definition,
            ...(typeof (definition as { agent?: unknown }).agent === "string" ? { agent: (definition as { agent: string }).agent } : {}),
            sessionID: call.sessionID,
            callerAgent: call.agent,
            ...(call.messageID === undefined || call.id === undefined ? {} : { source: { messageID: call.messageID, id: call.id } }),
            gate: scripts,
            rpc: ctx.rpc,
            tool: ctx.tool,
            agentDomain: ctx.agent,
            session: ctx.session,
            clock,
            location: ctx.location.directory,
            roots: options.scriptFilesRoots,
            access: options.access,
            job: { id: "script", name: "Script" },
          }),
      }
      // Transforms replay on every rebuild, so each registration is disposed on cleanup in reverse order.
      const stops = [
        await registerCommands(ctx, {
          status: () => report.status(),
          togglePause: async () => pauseEveryJob(actions, (await readPauseAll(ctx.storage)) === undefined),
          runNow: (id) => runNow(actions, id),
          ids: async () => (await report.list()).map((job) => ({ id: job.id, name: job.name })),
          approve: async (id, sessionID) => {
            const info = await ctx.session.get({ sessionID }).catch(() => undefined)
            return approveJob(actions, id, { sessionID, agent: (info?.agent as string | undefined) ?? "build" })
          },
        }),
        await registerStatusRpc(ctx.rpc, report),
        // Every tool as a method with its class: a script calls them with no model, as a session and its agent.
        await registerToolsRpc(ctx, { methods: ownedMethods(tools) }),
        // The one evaluate hook: a run of ours never waits for an approval nobody can give.
        await registerSafety(ctx.permission),
        // Every agent gets the default rules after its base allow: the jobs tools ask, the reads and pauses are allowed.
        await ctx.agent.transform((editor) => {
          for (const { id } of editor.list()) editor.update(id, (info) => insertDefaultRules(info.permissions, options.access))
        }).then((registration) => registration.dispose),
        await ctx.tool.transform(toolTransform(tools)).then((registration) => registration.dispose),
      ]
      const worker = options.enabled && ready
        ? startWorker(ctx, {
            clock,
            timezone,
            concurrency: options.concurrency,
            keepAliveMs: keepAlivePeriod(options.keepAliveMinutes),
            watch,
            report,
            scripts,
            scriptFilesRoots: options.scriptFilesRoots,
            access: options.access,
            loop: deps.loop !== false,
            deps,
          })
        : undefined
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
  /** The keep-alive period, from the `keepAliveMinutes` option. */
  readonly keepAliveMs: number
  /** The job-file watch the status surfaces share. */
  readonly watch: FileWatch
  /** The report the surfaces share, so a host test can read what status says. */
  readonly report: Report
  /** The script gate a script run re-resolves its manifest through. */
  readonly scripts: ScriptGate
  /** Extra roots a script's declared files may live in. */
  readonly scriptFilesRoots: readonly string[]
  /** The family access policy, re-read at every scheduled run (DF-2). */
  readonly access: Access
  readonly loop: boolean
  readonly deps: JobsDeps
}

export interface Worker {
  readonly leader: Leader
  readonly runner: Runner
  readonly keepAlive: KeepAlive
  /** The plugin's own storage, which every job and run key lives in. */
  readonly storage: Plugin.Context["storage"]
  /** The report the status surfaces share: its `missingAgents` is the instance's own agent view. */
  readonly report: Report
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
    report: input.report,
    wake: () => runner?.wake(),
    stop: async () => {
      await leader.release()
      stopped.abort()
    },
  }

  // Every job this leader knows, read the same way status reads them, so a refused file never becomes a job.
  const jobs = async (): Promise<readonly Job[]> => (await readSource({ storage: ctx.storage, location: ctx.location.directory, timezone: input.timezone, clock: input.clock, agent: ctx.agent, watch: input.watch })).jobs

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
        scripts: input.scripts,
        tool: ctx.tool,
        rpc: ctx.rpc,
        scriptFilesRoots: input.scriptFilesRoots,
        access: input.access,
      })
      // Retention runs when the leader starts and once an hour after: the records it drops lose their sessions too.
      let prunedAt: number | undefined
      const maintain = async (now: number) => {
        if (prunedAt !== undefined && now - prunedAt < HOUR) return
        prunedAt = now
        await pruneWithSessions(ctx.storage, ctx.session, now)
      }
      runner = new Runner({
        storage: ctx.storage,
        clock: input.clock,
        jobs,
        execute,
        active: () => leader.isLeader,
        concurrency: input.concurrency,
        location: ctx.location.directory,
        maintain,
      })
      keepAlive = startKeepAlive({
        session: ctx.session,
        clock: input.clock,
        location: ctx.location.directory,
        periodMs: input.keepAliveMs,
        active: () => leader.isLeader,
        onBeat: (at, ok) => void putBeat(ctx.storage, { at, ok }).catch(() => undefined),
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
