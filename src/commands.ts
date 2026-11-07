/**
 * The server commands: `/jobs-status` renders the report, `/jobs-pause` is the kill switch, and `/jobs-run <id>` starts
 * a job now. Each posts its answer into the session it was run in, so the change is never silent.
 *
 * A command is a person's own act: typing `/jobs-run <id>` is the approval for that run. The model's `jobs_run_now`
 * tool asks instead, because there the prompt is the yes.
 */
import type { Plugin } from "@opencode/plugin"
import { COMMAND_STEM, jobsError } from "./constants.js"
import { isJobSession } from "./jobs/safety.js"
import type { Job } from "./jobs/model.js"
import { formatStatus, unavailable, type Status } from "./status.js"
import type { PauseRecord } from "./jobs/store.js"

export interface CommandInput {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
}

export interface CommandHooks {
  readonly status: () => Promise<Status>
  /** Pauses every job, or resumes them, and returns what is stored afterwards. */
  readonly togglePause: () => Promise<PauseRecord | undefined>
  /** Runs a job now; `id` is whatever the person typed after the command. */
  readonly runNow: (id: string) => Promise<Job>
  /** The jobs there are, for a `/jobs-run` with no id. */
  readonly ids: () => Promise<readonly { readonly id: string; readonly name: string }[]>
  /** Approves a script job again; the person's own act, in the session they typed it in. */
  readonly approve: (id: string, sessionID: string) => Promise<{ readonly job: Job; readonly approval: { readonly digest: string; readonly resolved: readonly unknown[] } }>
}

export function registerCommands(ctx: CommandInput, hooks: CommandHooks): Promise<() => Promise<void>> {
  const post = (sessionID: string, text: string, description: string) => ctx.session.synthetic({ sessionID, text, description, resume: false })
  const registration = ctx.command.transform((editor) => {
    editor.add({
      name: `${COMMAND_STEM}-status`,
      description: "Show the job report: the runner, the jobs, the next runs and the next step",
      execute: async ({ sessionID }) => {
        const text = await hooks.status().then(formatStatus, (error: unknown) => unavailable(error).message)
        await post(sessionID, text, "Jobs status")
      },
    })
    editor.add({
      name: `${COMMAND_STEM}-pause`,
      description: "Pause every job at once, or resume them",
      execute: async ({ sessionID }) => {
        const text = isJobSession(sessionID)
          ? refusal("the pause command")
          : await hooks.togglePause().then(pausedText, (error: unknown) => unavailable(error).message)
        await post(sessionID, text, "Jobs paused")
      },
    })
    editor.add({
      name: `${COMMAND_STEM}-approve`,
      description: "Approve a script job again after its source, manifest or a tool's class changed",
      execute: async ({ sessionID, prompt }) => {
        const id = prompt.text.trim().split(/\s+/)[0] ?? ""
        const text = id === ""
          ? `Name the script job to approve, for example /${COMMAND_STEM}-approve morning.`
          : await hooks.approve(id, sessionID).then(
              ({ job, approval }) => `Approved ${job.name} (${job.id}): ${approval.resolved.length} tools, ${approval.digest.slice(0, 12)}…`,
              (error: unknown) => messageOf(error),
            )
        await post(sessionID, text, "Jobs approval")
      },
    })
    editor.add({
      name: `${COMMAND_STEM}-run`,
      description: "Run a job now, without waiting for its next slot",
      execute: async ({ sessionID, prompt }) => {
        const id = prompt.text.trim().split(/\s+/)[0] ?? ""
        const text = isJobSession(sessionID)
          ? refusal("the run command")
          : id === ""
            ? await listIds(hooks)
            : await hooks.runNow(id).then(ranText, (error: unknown) => messageOf(error))
        await post(sessionID, text, "Jobs run")
      },
    })
  })
  return registration.then((registration) => registration.dispose)
}

/** A run may not start or pause jobs through a command: the session's own rules deny the tools for the same reason. */
function refusal(what: string): string {
  return jobsError("JOBS_UNATTENDED", `${what} cannot be used from a job's own session, because a run must not start or stop jobs.`, `Create or run jobs from your own session, where you answer the approval.`).message
}

function pausedText(paused: PauseRecord | undefined): string {
  if (paused === undefined) return "Every job runs to its schedule again."
  return `Every job is paused since ${new Date(paused.at).toISOString()}. Nothing new starts until you run /${COMMAND_STEM}-pause again.`
}

function ranText(job: Job): string {
  return `Queued ${job.name} (${job.id}) to run now. Its next slot is this moment, and the runner picks it up within a tick.`
}

async function listIds(hooks: Pick<CommandHooks, "ids">): Promise<string> {
  const jobs = await hooks.ids()
  if (jobs.length === 0) return `There is no job to run. Create one with the jobs_create tool, or commit a job file.`
  return `Name a job to run, for example /${COMMAND_STEM}-run ${jobs[0]!.id}:\n${jobs.map((job) => `${job.id} ${job.name}`).join("\n")}`
}

/** A coded error's message, or the host's text: the command answers with what happened, never with a stack. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
