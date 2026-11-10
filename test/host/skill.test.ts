// The jobs skill as the stock OpenCode lists it. A question about scheduled jobs can load only a skill the host has, so this
// reads the host's own skill list after the installed plugin is loaded.
import { afterAll, expect, test } from "bun:test"
import { cleanup, startHost } from "./harness.js"

afterAll(cleanup)

test("the stock host lists the jobs skill from the installed plugin, with the description that names scheduled jobs", async () => {
  const host = await startHost()
  try {
    const { data: skills } = await host.client.skill.list({ location: host.location })
    const jobs = skills.find((skill) => skill.id === "jobs")
    expect(jobs).toBeDefined()
    expect(jobs?.description).toContain("what jobs do I have scheduled")
    expect(jobs?.autoinvoke).toBe(true)
  } finally {
    // Every host test closes its host before the file's cleanup; an open host would break the hosts that start after it.
    await host.close()
  }
}, 120_000)
