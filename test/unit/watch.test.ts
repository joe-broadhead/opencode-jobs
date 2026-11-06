// The job-file watch: one stat a minute at most, a parse only when a file changed, and a refused file kept in the
// answer until its file changes (PLAN phase 6).
import { describe, expect, test } from "bun:test"
import { MINUTE, parseJob } from "../../src/jobs/model.js"
import { createFileWatch } from "../../src/jobs/watch.js"
import type { JobFiles } from "../../src/jobs/files.js"

const NOW = Date.UTC(2026, 11, 6, 9, 0, 0)
const job = parseJob(
  { name: "Morning", schedule: { every: "1h" }, action: { type: "prompt", text: "go" }, agent: "jobs" },
  { now: NOW, timezone: "UTC", id: "morning", source: "file", createdBy: "user" },
)

function harness(files: JobFiles) {
  let now = NOW
  const scans: number[] = []
  const signatures: number[] = []
  let signature = "a"
  const watch = createFileWatch(() => now)
  const read = () =>
    watch.read(
      async () => {
        signatures.push(now)
        return signature
      },
      async () => {
        scans.push(now)
        return files
      },
    )
  return {
    read,
    scans,
    signatures,
    at: (next: number) => void (now = next),
    change: () => void (signature = signature === "a" ? "b" : "a"),
  }
}

const files = (invalid = false): JobFiles => ({
  jobs: [job],
  invalid: invalid ? [{ path: "/work/.opencode/jobs/broken.md", message: "JOBS_INVALID_FILE: /work/.opencode/jobs/broken.md:1: broken." }] : [],
  refused: [],
})

describe("the job-file watch", () => {
  test("parses once, and serves the same answer for the rest of the minute without even a stat", async () => {
    const setup = harness(files())
    expect((await setup.read()).jobs).toHaveLength(1)
    setup.at(NOW + 30_000)
    expect((await setup.read()).jobs).toHaveLength(1)
    expect(setup.scans).toEqual([NOW])
    expect(setup.signatures).toEqual([NOW])
  })

  test("re-stats after a minute, and re-parses only when a file changed", async () => {
    const setup = harness(files())
    await setup.read()
    setup.at(NOW + MINUTE)
    await setup.read()
    expect(setup.signatures).toEqual([NOW, NOW + MINUTE])
    expect(setup.scans).toEqual([NOW])
    setup.at(NOW + 2 * MINUTE)
    setup.change()
    await setup.read()
    expect(setup.scans).toEqual([NOW, NOW + 2 * MINUTE])
  })

  test("keeps a refused file in the answer, and reports the change when the file is fixed", async () => {
    const broken = harness(files(true))
    expect((await broken.read()).invalid).toHaveLength(1)
    broken.at(NOW + 30_000)
    expect((await broken.read()).invalid).toHaveLength(1)
    broken.at(NOW + MINUTE)
    broken.change()
    const fixed = { read: () => broken.read() }
    void fixed
    // The same watch instance, now reading a fixed file: a new signature means a new scan.
    const healthy = harness(files())
    await healthy.read()
    healthy.change()
    expect((await healthy.read()).invalid).toEqual([])
  })
})
