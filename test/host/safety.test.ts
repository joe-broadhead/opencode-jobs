// Safety inside an embedded OpenCode host of one tested release: a run never waits for a prompt, the hook that makes
// that true touches no other session and never widens a rule, an unguarded agent is refused before anything runs, a
// per-job allow is refused, and the kill switch stops what is running and the next slot.
import { afterAll, describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode/client"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Clock } from "../../src/jobs/clock.js"
import { MINUTE, parseJob, type Job } from "../../src/jobs/model.js"
import { scanRuns, setPauseAll } from "../../src/jobs/store.js"
import { formatStatus, type Status } from "../../src/status.js"
import { Jobs } from "../../src/rpc.js"
import { cleanup, HOST_VERSION, startHost, until, type Host } from "./harness.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

afterAll(cleanup)

/** The read-only profile: a blanket deny, then the reads. Nothing a run does is left to ask about. */
const GUARDED = {
  jobs: {
    description: "Runs scheduled jobs with read-only access",
    mode: "primary",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
    ],
  },
  // A tool its agent asks about: offered to the model, and refused at the call because nobody is there to answer.
  asking: {
    description: "Asks before it runs a command",
    mode: "primary",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "ask" },
    ],
  },
  // The same tool, denied outright: a deny is never touched by the hook, so the model never sees the tool.
  strict: {
    description: "Never runs a command",
    mode: "primary",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
    ],
  },
}

const SHELL = `[[mock:tool:shell:{"command":"echo ran > __DIR__/ran.txt"}]]`

function manualClock(start: number) {
  let now = start
  const clock: Clock = {
    now: () => now,
    sleep: (ms, signal) =>
      ms <= 100
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve()
            else signal?.addEventListener("abort", () => resolve(), { once: true })
          }),
  }
  return {
    clock,
    set(at: number) {
      now = at
    },
    now: () => now,
  }
}

const jobOf = (overrides: Record<string, unknown> = {}): Job =>
  parseJob(
    { name: "Guarded", schedule: { every: "5 minutes" }, action: { type: "prompt", text: "Say ok." }, agent: "jobs", ...overrides },
    { now: START, timezone: "UTC", id: "job_safety", source: "tool", createdBy: "user" },
  )

/** A job file in the host's own project, as a person commits one. */
function jobFile(host: Host, name: string, fields: readonly string[], prompt = "Say ok."): string {
  const folder = join(host.location.directory, ".opencode", "jobs")
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `${name}.md`)
  writeFileSync(path, `---\n${fields.join("\n")}\n---\n${prompt}\n`)
  return path
}

const records = async (host: Host) => scanRuns(host.worker().storage)

const statusOf = (host: Host) => host.client.rpc(Jobs).status({}, { location: host.location }) as Promise<Status>

/** The session's messages, flattened to text, for what the model was told. */
async function transcript(host: Host, sessionID: string): Promise<string> {
  const context = (await host.probe().session.context({ sessionID })) as { content?: { text?: string }[] }[]
  return context.flatMap((message) => message.content ?? []).map((part) => part.text ?? "").join("\n")
}

describe(`safety in OpenCode ${HOST_VERSION}`, () => {
  test("denies a tool the agent asks about, records it, and leaves no request pending", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const job = jobOf({ agent: "asking", action: { type: "prompt", text: SHELL.replace("__DIR__", host.location.directory) } })
      await worker.storage.set(`job/${job.id}`, job as never)
      // The first pass fixes the next slot; the second runs the one that falls due.
      await worker.runner.tick(START)
      await worker.runner.tick(START + 5 * MINUTE)
      const began = Date.now()
      await worker.runner.settle()

      const record = (await records(host)).find((entry) => entry.job === job.id)
      expect(record?.status).toBe("succeeded")
      expect(Date.now() - began).toBeLessThan(60_000)
      // No permission request is left waiting: the run finished instead of hanging.
      expect(await host.probe().permission.list({ sessionID: record!.sessionID! })).toEqual([])
      // The model was told why, in the hook's own words, and answered after the refusal.
      const text = await transcript(host, record!.sessionID!)
      expect(text).toContain("permission.rejected")
      expect(text).toContain("JOBS_UNATTENDED")
      expect(text).toContain("needs approval, and job runs are unattended")
      expect(text).not.toContain("No tool named")
      expect(record!.summary).toContain("after-tool")
      // Nothing was run.
      expect(await Bun.file(join(host.location.directory, "ran.txt")).exists()).toBe(false)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("leaves an ordinary session's ask alone: it stays pending until a person answers it", async () => {
    const host = await startHost({ config: { agents: GUARDED } })
    try {
      const created = await host.client.session.create({ location: { directory: host.location.directory }, agent: "asking", title: "A person's session" })
      const sessionID = created.id
      await host.client.session.prompt({ sessionID, text: SHELL.replace("__DIR__", host.location.directory) })
      const request = await until("the ask is pending", async () => {
        const list = (await host.probe().permission.list({ sessionID })) as PermissionRequest[]
        return list.find((entry) => entry.action === "shell")
      }, 30_000)
      expect(request.sessionID).toBe(sessionID)
      // It really was waiting: the command has not run while the ask is pending.
      expect(await Bun.file(join(host.location.directory, "ran.txt")).exists()).toBe(false)
      // Answer it as a person would: the prompt was really waiting, so the tool ran under the person's yes.
      await host.probe().permission.reply({ sessionID, requestID: request.id, decision: "reject", message: "not now" })
      await host.client.session.remove({ sessionID }).catch(() => undefined)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("never widens: an agent's deny stays a deny, so the model is never offered the tool", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const job = jobOf({ agent: "strict", action: { type: "prompt", text: SHELL.replace("__DIR__", host.location.directory) } })
      await worker.storage.set(`job/${job.id}`, job as never)
      await worker.runner.tick(START)
      await worker.runner.tick(START + 5 * MINUTE)
      await worker.runner.settle()
      const record = (await records(host)).find((entry) => entry.job === job.id)
      expect(record?.status).toBe("succeeded")
      const text = await transcript(host, record!.sessionID!)
      expect(text).toContain("No tool named")
      expect(text).not.toContain("JOBS_UNATTENDED")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("refuses a job pointed at an agent that does not deny by default, before it runs", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const refused = jobFile(host, "nightly", ["name: Nightly", "every: 5 minutes", "agent: build"], "Summarise the day.")
      const widens = jobFile(host, "widens", ["name: Widens", "every: 5 minutes", "agent: jobs", "allow:", '  - action: edit', "    effect: allow"], "Edit the file.")
      // The job folders are checked once a minute: move the clock past the watch's window.
      manual.set(manual.now() + 61_000)

      // Create time: neither file becomes a job, and status names each with its code and path.
      const status = await statusOf(host)
      expect(status.problems.map((problem) => problem.split(":")[0])).toEqual(["JOBS_AGENT_UNGUARDED", "JOBS_ALLOW_WIDENS"])
      expect(status.problems[0]).toContain(refused)
      expect(status.problems[0]).toContain("does not deny by default")
      expect(status.problems[0]).toContain("Next step: Give the agent \"build\" the read-only block")
      expect(status.problems[1]).toContain(widens)
      expect(status.jobs.invalidFiles).toBe(2)
      expect(status.jobs.total).toBe(0)
      // The status text carries the block to paste, for the agent that needs it.
      const text = formatStatus(status)
      expect(text).toContain("- Agents without default rules: build")
      expect(text).toContain('Paste this for "build" into opencode.json:')
      expect(text).toContain('"effect": "deny"')

      // Run time: the slots come and go without a session or a run record.
      await worker.runner.tick(START)
      await worker.runner.tick(START + 5 * MINUTE)
      await worker.runner.tick(START + 10 * MINUTE)
      await worker.runner.settle()
      expect(await records(host)).toEqual([])
      expect(host.mock().calls()).toBe(0)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("the kill switch interrupts the run in flight and prevents the next slot", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const job = jobOf({ action: { type: "prompt", text: "[[mock:slow:30]]" }, policy: { timeout: "2m" } })
      await worker.storage.set(`job/${job.id}`, job as never)
      await worker.runner.tick(START)
      await worker.runner.tick(START + 5 * MINUTE)

      const running = await until("the run is in flight", async () => (await records(host)).find((entry) => entry.job === job.id && entry.status === "running"), 20_000)
      expect(running.sessionID).toBeString()

      const pausedAt = manual.now() + 30_000
      expect(running.slot).toBe(new Date(START + 5 * MINUTE).toISOString())
      manual.set(pausedAt)
      await setPauseAll(worker.storage, true, pausedAt)
      await worker.runner.tick(pausedAt)
      await worker.runner.settle()

      // The run that was in flight is interrupted, and it was interrupted by the switch, not by its timeout.
      const interrupted = await until("the run is final", async () => {
        const found = (await records(host)).find((entry) => entry.job === job.id && entry.status !== "running" && entry.status !== "queued")
        return found
      }, 20_000)
      expect(interrupted.status).toBe("interrupted")
      expect(interrupted.endedAt! - interrupted.startedAt!).toBeLessThan(60_000)

      // The next slots start nothing at all.
      manual.set(pausedAt + 5 * MINUTE)
      await worker.runner.tick(pausedAt + 5 * MINUTE)
      manual.set(pausedAt + 10 * MINUTE)
      await worker.runner.tick(pausedAt + 10 * MINUTE)
      await worker.runner.settle()
      expect((await records(host)).filter((entry) => entry.job === job.id)).toHaveLength(1)

      // Status says so, and the next step is how to resume.
      const status = await statusOf(host)
      expect(status.paused).toEqual({ at: pausedAt })
      expect(status.nextStep).toBe("Run /jobs-pause again to resume every job.")
      expect(formatStatus(status)).toContain(`- Runner: paused since ${new Date(pausedAt).toISOString()}`)
    } finally {
      await host.close()
    }
  }, 120_000)
})

describe("the guarded-agent check in the run's own directory", () => {
  test("resolves the agent where the run happens, so an agent the target directory does not have is refused", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const sibling = host.sibling("sibling")
      await host.open(sibling)
      // The leader's project has a guarded "jobs"; the sibling resolves no agent of that name, so a run there would be
      // created under whatever the target location has, not the leader's profile.
      const job = parseJob(
        { name: "Elsewhere", schedule: { every: "5 minutes" }, action: { type: "prompt", text: "Say ok." }, agent: "jobs", target: { directory: sibling } },
        { now: START, timezone: "UTC", id: "job_elsewhere", source: "tool", createdBy: "user" },
      )
      await host.worker().storage.set(`job/${job.id}`, job as never)
      await host.worker().storage.set(`state/${job.id}`, { job: job.id, nextDueAt: START, runCount: 0, consecutiveFailures: 0 })
      await host.worker().runner.tick(START)
      await host.worker().runner.settle()
      const record = (await scanRuns(host.worker().storage)).find((entry) => entry.job === job.id)
      expect(record?.status).toBe("skipped")
      expect(record?.error).toMatch(/JOBS_AGENT_UNGUARDED|JOBS_AGENTS_UNKNOWN/)
      expect(host.mock().calls()).toBe(0)
    } finally {
      await host.close()
    }
  }, 120_000)
})
