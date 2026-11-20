// jobs.runs.list's own rules: the screen and its order, the id screen, the 50-item cap, the order it is given, the whole
// answer inside the declared maxBytes, and the handler's account check. Each assertion fails when its rule is removed.
import { describe, expect, test } from "bun:test"
import { LIST_CAP, listRuns, runListItems } from "../../src/jobs/tools.js"

const run = (n: number, extra: Partial<{ job: string; name: string; status: string; slot: string; attempt: number }> = {}) => ({
  job: `job-${n}`,
  name: `Nightly ${n}`,
  slot: "2026-11-20T09:00:00Z",
  status: "succeeded",
  attempt: 1,
  ...extra,
})

describe("listRuns", () => {
  const input = (runs: unknown[]) => ({
    report: { history: async (query: { limit?: number; summaries?: boolean }) => {
      // The list asks for 50 and never for summaries; the model's path asks with summaries.
      expect(query).toEqual({ limit: LIST_CAP })
      return runs
    } },
    clock: { now: () => Date.UTC(2026, 10, 20, 9, 0, 0) },
  }) as never

  test("answers this machine's runs newest first, with the account it names or this machine's", async () => {
    const runs = [run(1), run(2, { status: "failed" })]
    const answer = await listRuns(input(runs), "studio-mac", "studio-mac")
    expect(answer).toMatchObject({
      account: "studio-mac",
      data: { editable: false, items: [{ id: "job-1/2026-11-20T09:00:00Z/1", text: "Nightly 1 succeeded", done: true }, { id: "job-2/2026-11-20T09:00:00Z/1", text: "Nightly 2 failed" }] },
      trust: "untrusted",
    })
    expect(answer.asOf).toBe("2026-11-20T09:00:00.000Z")
    expect((await listRuns(input(runs), undefined, "studio-mac")).account).toBe("studio-mac")
  })

  test("refuses another machine's account before anything is read", async () => {
    let read = false
    const refused = { report: { history: async () => ((read = true), []) }, clock: { now: () => 0 } } as never
    await expect(listRuns(refused, "another-machine", "studio-mac")).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" })
    expect(read).toBe(false)
  })
})

describe("runListItems", () => {
  test("screens the whole name before the cut, and the id", () => {
    expect(runListItems([run(1, { name: `${"a".repeat(196)}Password: Ku7pLm2QzR9w` })])).toEqual([])
    // A job id that is a token is left out through its id.
    expect(runListItems([run(2, { job: "ghp_A1b2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8" })])).toEqual([])
    expect(runListItems([run(3, { name: "b".repeat(300) })])).toEqual([{ id: "job-3/2026-11-20T09:00:00Z/1", text: "b".repeat(200), done: true }])
  })

  test("lists a repeated run once, at most 50 items, in the order it is given", () => {
    // The registry holds 50 items: the literal, not the constant, so raising the cap fails this test.
    expect(LIST_CAP).toBe(50)
    expect(runListItems([run(1), run(1)])).toHaveLength(1)
    const many = Array.from({ length: 60 }, (_, index) => run(index))
    const items = runListItems(many)
    expect(items).toHaveLength(50)
    expect(items.map((item) => item.id)).toEqual(many.slice(0, 50).map((entry) => `${entry.job}/${entry.slot}/${entry.attempt}`))
  })

  test("keeps the whole answer inside the declared maxBytes with maximal multi-byte names", () => {
    // A job's name is capped at 120 characters, and its id at 128; three-byte characters everywhere they are allowed.
    const maximal = Array.from({ length: 50 }, (_, index) => run(index, { job: `语${index}`.padEnd(128, "语"), name: "语".repeat(120) }))
    const answer = { account: "studio-mac", data: { items: runListItems(maximal), editable: false }, asOf: new Date().toISOString(), trust: "untrusted" }
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(65_536)
  })
})
