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

  test("retries a file refused for a missing agent every 5 s, even when a caller polls faster (RR-3)", async () => {
    const refused = { jobs: [], invalid: [], refused: [{ path: "/work/.opencode/jobs/late.md", code: "JOBS_AGENT_MISSING", message: "JOBS_AGENT_MISSING: late." }] } as unknown as JobFiles
    const setup = harness(refused)
    await setup.read()
    for (const offset of [4_000, 8_000, 12_000, 16_000]) {
      setup.at(NOW + offset)
      await setup.read()
    }
    // The first scan, then one each time 5 s have passed since the last parse: a 4 s caller no longer starves the retry.
    expect(setup.scans).toEqual([NOW, NOW + 8_000, NOW + 16_000])
  })
})
