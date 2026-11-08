// Declared job files: the path policy, the caps, the snapshot, and the commit (conflict and atomicity). The guest has no
// filesystem; these are the only paths a script can see, and every refusal names the code.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { commitFiles, resolveScriptFiles, snapshotFiles } from "../../src/jobs/script-files.js"
import type { Script } from "../../src/jobs/script.js"

const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-files-")))
const outside = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-files-out-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const one = (path: string, mode: "read" | "write" | "readwrite" = "readwrite", format: "json" | "text" = "json", maxBytes?: number): Script["files"] => ({
  state: { path, mode, format, ...(maxBytes === undefined ? {} : { maxBytes }) },
})

describe("the declared file path policy", () => {
  test("resolves a relative path against the job directory, and an absolute one inside it", async () => {
    const files = await resolveScriptFiles(one("bookmarks.json"), root)
    expect(files[0]!.path).toBe(join(root, "bookmarks.json"))
    mkdirSync(join(root, "nested"), { recursive: true })
    const absolute = await resolveScriptFiles(one(join(root, "nested", "book.json")), root)
    expect(absolute[0]!.path).toBe(join(root, "nested", "book.json"))
  })

  test("refuses outside the job directory, unless scriptFilesRoots names the root", async () => {
    await expect(resolveScriptFiles(one(join(outside, "state.json")), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
    const allowed = await resolveScriptFiles(one(join(outside, "state.json")), root, [outside])
    expect(allowed[0]!.path).toBe(join(outside, "state.json"))
  })

  test("refuses .., .git, the project's .opencode, a directory and a symlink at any component", async () => {
    const old = join(root, "old.json")
    writeFileSync(old, "{}")
    await expect(resolveScriptFiles(one("../escape.json"), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
    await expect(resolveScriptFiles(one(".git/config"), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
    await expect(resolveScriptFiles(one(".opencode/jobs/x.json"), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
    mkdirSync(join(root, "adir"), { recursive: true })
    await expect(resolveScriptFiles(one("adir"), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
    symlinkSync(old, join(root, "link.json"))
    await expect(resolveScriptFiles(one("link.json"), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
    mkdirSync(join(root, "real"), { recursive: true })
    symlinkSync(join(root, "real"), join(root, "linkdir"))
    await expect(resolveScriptFiles(one("linkdir/state.json"), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
  })
})

describe("the snapshot", () => {
  test("reads JSON and text, a missing file is null, and invalid JSON or an over-cap file is refused", async () => {
    writeFileSync(join(root, "state.json"), JSON.stringify({ ids: ["a"] }))
    writeFileSync(join(root, "note.txt"), "hello")
    const snapshots = await snapshotFiles(await resolveScriptFiles({ a: { path: "state.json", mode: "read", format: "json" }, b: { path: "note.txt", mode: "read", format: "text" }, c: { path: "missing.json", mode: "read", format: "json" } }, root))
    expect(snapshots.find((s) => s.file.name === "a")?.value).toEqual({ ids: ["a"] })
    expect(snapshots.find((s) => s.file.name === "b")?.value).toBe("hello")
    expect(snapshots.find((s) => s.file.name === "c")?.value).toBeNull()
    writeFileSync(join(root, "bad.json"), "{not json")
    await expect(snapshotFiles(await resolveScriptFiles({ a: { path: "bad.json", mode: "read", format: "json" } }, root))).rejects.toThrow("JOBS_SCRIPT_FILE_INVALID")
    writeFileSync(join(root, "big.json"), JSON.stringify({ x: "y".repeat(100) }))
    await expect(snapshotFiles(await resolveScriptFiles({ a: { path: "big.json", mode: "read", format: "json", maxBytes: 20 } }, root))).rejects.toThrow("JOBS_SCRIPT_FILE_TOO_LARGE")
  })
})

describe("the commit", () => {
  test("serialises JSON with two spaces, keeps an existing mode, and records bytes and hashes", async () => {
    writeFileSync(join(root, "state.json"), JSON.stringify({ n: 1 }))
    chmodSync(join(root, "state.json"), 0o640)
    const files = await resolveScriptFiles(one("state.json"), root)
    const snapshots = await snapshotFiles(files)
    const records = await commitFiles(snapshots, [{ name: "state", json: JSON.stringify({ n: 2, list: ["x"] }) }])
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8"))).toEqual({ n: 2, list: ["x"] })
    expect(readFileSync(join(root, "state.json"), "utf8")).toContain('\n  "n": 2')
    expect((await stat(join(root, "state.json"))).mode & 0o777).toBe(0o640)
    expect(records[0]).toMatchObject({ name: "state", bytesWritten: expect.any(Number), sha256Before: expect.any(String), sha256After: expect.any(String) })
  })

  test("refuses a write to a read file, a conflict, and an over-cap value", async () => {
    writeFileSync(join(root, "ro.json"), "{}")
    const readOnly = await snapshotFiles(await resolveScriptFiles(one("ro.json", "read"), root))
    await expect(commitFiles(readOnly, [{ name: "state", json: "{}" }])).rejects.toThrow("JOBS_SCRIPT_FILE_MODE")

    writeFileSync(join(root, "conflict.json"), JSON.stringify({ n: 1 }))
    const conflict = await snapshotFiles(await resolveScriptFiles(one("conflict.json"), root))
    writeFileSync(join(root, "conflict.json"), JSON.stringify({ n: 99 })) // another writer between the run and the commit
    await expect(commitFiles(conflict, [{ name: "state", json: JSON.stringify({ n: 2 }) }])).rejects.toThrow("JOBS_SCRIPT_FILE_CONFLICT")
    expect(JSON.parse(readFileSync(join(root, "conflict.json"), "utf8"))).toEqual({ n: 99 })

    const small = await snapshotFiles(await resolveScriptFiles(one("small.json", "readwrite", "json", 16), root))
    await expect(commitFiles(small, [{ name: "state", json: JSON.stringify({ long: "x".repeat(100) }) }])).rejects.toThrow("JOBS_SCRIPT_FILE_TOO_LARGE")
  })

  test("is atomic: a crash before the rename leaves the old file, and a new file is 0600", async () => {
    writeFileSync(join(root, "atomic.json"), JSON.stringify({ old: true }))
    const files = await resolveScriptFiles(one("atomic.json"), root)
    const snapshots = await snapshotFiles(files)
    await expect(
      commitFiles(snapshots, [{ name: "state", json: JSON.stringify({ new: true }) }], {
        rename: async () => {
          throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    expect(JSON.parse(readFileSync(join(root, "atomic.json"), "utf8"))).toEqual({ old: true })

    const fresh = await resolveScriptFiles(one("fresh.json", "write"), root)
    const records = await commitFiles(await snapshotFiles(fresh), [{ name: "state", json: JSON.stringify({ a: 1 }) }])
    expect(records[0]!.sha256Before).toBeUndefined()
    expect((await stat(join(root, "fresh.json"))).mode & 0o777).toBe(0o600)
  })
})
