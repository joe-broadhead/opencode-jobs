// The three commands: the report, the kill switch, and a run on demand. Each posts its answer into the session it was
// run in, so nothing happens silently.
import { describe, expect, test } from "bun:test"
import { registerCommands, type CommandHooks } from "../../src/commands.js"
import { parseJob, type Job } from "../../src/jobs/model.js"
import { buildStatus } from "../../src/status.js"
import { rememberJobSession } from "../../src/jobs/safety.js"
import { commandContext, commands } from "./fake.js"

const NOW = Date.UTC(2026, 11, 6, 9, 0, 0)
const HOST = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }

const job = (id = "job_run"): Job =>
  parseJob(
    { name: "Review", schedule: { every: "1h" }, action: { type: "prompt", text: "Review." }, agent: "jobs" },
    { now: NOW, timezone: "UTC", id, source: "tool", createdBy: "user" },
  )

async function setup(overrides: Partial<CommandHooks> = {}) {
  const { ctx, editable, posted } = commandContext()
  const { editor, added } = commands()
  const hooks: CommandHooks = {
    status: async () => buildStatus({ host: HOST, enabled: true, keepAliveMinutes: 20 }),
    togglePause: async () => ({ at: NOW }),
    runNow: async () => job(),
    ids: async () => [{ id: "job_run", name: "Review" }],
    ...overrides,
  }
  await registerCommands(ctx, hooks)
  editable.run(editor)
  return { added, posted, run: (name: string, text = "") => added.find((command) => command.name === name)!.execute({ sessionID: "ses_1", prompt: { text } } as never) }
}

describe("the server commands", () => {
  test("are /jobs-status, /jobs-pause and /jobs-run, and no others", async () => {
    const { added } = await setup()
    expect(added.map((command) => command.name)).toEqual(["jobs-status", "jobs-pause", "jobs-run"])
    for (const command of added) expect(command.description).toBeString()
  })

  test("/jobs-status posts the report without its heading", async () => {
    const { run, posted } = await setup()
    await run("jobs-status")
    expect(posted[0]).toMatchObject({ sessionID: "ses_1", description: "Jobs status", resume: false })
    expect(posted[0]!.text).toStartWith("Jobs status\n- Runner: no leader yet")
    expect(posted[0]!.text).toContain("- Next step: Nothing to do.")
  })

  test("/jobs-pause pauses every job, then says how to resume it", async () => {
    const { run, posted } = await setup({ togglePause: async () => ({ at: NOW }) })
    await run("jobs-pause")
    expect(posted[0]!.text).toBe(`Every job is paused since ${new Date(NOW).toISOString()}. Nothing new starts until you run /jobs-pause again.`)
    const resumed = await setup({ togglePause: async () => undefined })
    await resumed.run("jobs-pause")
    expect(resumed.posted[0]!.text).toBe("Every job runs to its schedule again.")
  })

  test("/jobs-run with an id starts that job, and says so", async () => {
    const asked: string[] = []
    const { run, posted } = await setup({ runNow: async (id) => (asked.push(id), job(id)) })
    await run("jobs-run", "  job_run  ")
    expect(asked).toEqual(["job_run"])
    expect(posted[0]!.text).toContain("Queued Review (job_run) to run now.")
  })

  test("/jobs-run with no id lists the jobs and names one", async () => {
    const { run, posted } = await setup()
    await run("jobs-run")
    expect(posted[0]!.text).toContain("Name a job to run, for example /jobs-run job_run:")
    expect(posted[0]!.text).toContain("job_run Review")
  })

  test("a run session cannot use /jobs-run or /jobs-pause, because a run must not start or stop jobs", async () => {
    const asked: string[] = []
    const harness = await setup({ runNow: async (id: string) => (asked.push(id), job(id)), togglePause: async () => ({ at: NOW }) })
    rememberJobSession("ses_run")
    await harness.added.find((command) => command.name === "jobs-run")!.execute({ sessionID: "ses_run", prompt: { text: "job_run" } } as never)
    await harness.added.find((command) => command.name === "jobs-pause")!.execute({ sessionID: "ses_run", prompt: { text: "" } } as never)
    expect(harness.posted.every((entry) => String(entry.text).startsWith("JOBS_UNATTENDED: "))).toBe(true)
    expect(asked).toEqual([])
  })

  test("a coded refusal reaches the session as its message, not a stack", async () => {
    const { run, posted } = await setup({ runNow: async () => Promise.reject(new Error('JOBS_TARGET_MISSING: There is no job with the id "x". Next step: Run the jobs_list tool.')) })
    await run("jobs-run", "x")
    expect(posted[0]!.text).toBe('JOBS_TARGET_MISSING: There is no job with the id "x". Next step: Run the jobs_list tool.')
  })
})
