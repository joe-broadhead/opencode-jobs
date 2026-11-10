// The skill's description decides whether the model loads the skill. A question about scheduled jobs must find it, so the
// description names the read and pause actions, not only scheduling.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const skill = readFileSync(new URL("../../skills/jobs/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n")
const description = skill.split("\n").find((line) => line.startsWith("description:")) ?? ""

describe("the jobs skill description", () => {
  test("names the actions a read question uses, so the skill loads for it", () => {
    for (const verb of ["Schedule", "list", "check", "pause", "resume", "run"]) expect(description).toContain(verb)
  })

  test("carries the two example questions that a user asks about scheduled jobs", () => {
    expect(description).toContain("what jobs do I have scheduled")
    expect(description).toContain("is the 9am job paused")
  })
})
