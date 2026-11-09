// Declared job files: the path policy, the caps, the snapshot, and the commit (conflict and atomicity). The guest has no
// filesystem; these are the only paths a script can see, and every refusal names the code.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { commitFiles, FileCommitError, resolveScriptFiles, snapshotFiles } from "../../src/jobs/script-files.js"
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

describe("the path policy on a case-insensitive file system", () => {
  test("refuses .GIT, .Git and .OPENCODE, which are the real .git and .opencode on APFS (DF-1)", async () => {
    for (const name of [".git", ".GIT", ".Git", "sub/.GIT", ".opencode", ".OPENCODE", ".OpenCode"]) {
      const declared = name.endsWith("config") ? name : name.includes(".") && !name.includes("/") ? `${name}/config` : `${name}/jobs/x.md`
      await expect(resolveScriptFiles(one(declared), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
    }
    // A forbidden name reached through a canonical path after realpath is refused too.
    mkdirSync(join(root, ".GIT"), { recursive: true })
    await expect(resolveScriptFiles(one(join(root, ".GIT", "config")), root)).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
  })

  test("handles a decomposed parent name without letting it stand in for another (DF-1)", async () => {
    const composed = "café"
    const decomposed = composed.normalize("NFD")
    mkdirSync(join(root, decomposed), { recursive: true })
    writeFileSync(join(root, decomposed, "state.json"), "{}")
    // The same folder, written decomposed and composed, resolves to the path on disk; neither is a reserved name.
    const files = await resolveScriptFiles(one(join(composed, "state.json")), root)
    expect(files[0]!.path.normalize("NFD")).toBe(join(root, decomposed, "state.json").normalize("NFD"))
  })
})

describe("the commit's bounds and atomicity", () => {
  test("the last write to a name wins, with no conflict against its own earlier write (DF-3)", async () => {
    writeFileSync(join(root, "twice.json"), JSON.stringify({ n: 1 }))
    const snapshots = await snapshotFiles(await resolveScriptFiles(one("twice.json"), root))
    const records = await commitFiles(snapshots, [
      { name: "state", json: JSON.stringify({ n: 2 }) },
      { name: "state", json: JSON.stringify({ n: 3 }) },
    ])
    expect(JSON.parse(readFileSync(join(root, "twice.json"), "utf8"))).toEqual({ n: 3 })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: "written" })
    expect(records[0]!.bytesWritten).toBeGreaterThan(0)
  })

  test("rolls every file back when the second of three renames fails, and records each real outcome (DF-4)", async () => {
    const names = ["a", "b", "c"] as const
    const files: Script["files"] = Object.fromEntries(names.map((name) => [name, { path: `${name}.json`, mode: "readwrite" as const, format: "json" as const }]))
    for (const name of names) writeFileSync(join(root, `${name}.json`), JSON.stringify({ v: "old" }))
    const snapshots = await snapshotFiles(await resolveScriptFiles(files, root))
    let calls = 0
    const failure = await commitFiles(
      snapshots,
      names.map((name) => ({ name, json: JSON.stringify({ v: "new" }) })),
      {
        rename: async (from, to) => {
          calls += 1
          if (calls === 2) throw new Error("injected rename failure")
          await (await import("node:fs/promises")).rename(from, to)
        },
      },
    ).catch((error) => error)
    expect(failure).toBeInstanceOf(FileCommitError)
    const records = (failure as FileCommitError).records
    const byName = new Map(records.map((record) => [record.name, record]))
    expect(byName.get("a")?.outcome).toBe("rolled_back")
    expect(byName.get("b")?.outcome).toBe("not_attempted")
    expect(byName.get("c")?.outcome).toBe("not_attempted")
    // Nothing landed: every file is its old self.
    for (const name of names) expect(JSON.parse(readFileSync(join(root, `${name}.json`), "utf8"))).toEqual({ v: "old" })
  })

  test("refuses a leaf swapped for a symlink between the check and the open (DF-6)", async () => {
    writeFileSync(join(root, "swap-leaf.json"), JSON.stringify({ where: "inside" }))
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ where: "OUTSIDE" }))
    const files = await resolveScriptFiles(one("swap-leaf.json"), root)
    await expect(
      snapshotFiles(files, {
        policy: { directory: root, roots: [] },
        hooks: {
          beforeOpen: () => {
            rmSync(join(root, "swap-leaf.json"))
            symlinkSync(join(outside, "secret.json"), join(root, "swap-leaf.json"))
          },
        },
      }),
    ).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
  })

  test("refuses a parent swapped for a symlink between the check and the open (DF-6)", async () => {
    mkdirSync(join(root, "swap-dir"), { recursive: true })
    mkdirSync(join(outside, "swap-dir"), { recursive: true })
    writeFileSync(join(root, "swap-dir", "state.json"), JSON.stringify({ where: "inside" }))
    writeFileSync(join(outside, "swap-dir", "state.json"), JSON.stringify({ where: "OUTSIDE" }))
    const files = await resolveScriptFiles(one("swap-dir/state.json"), root)
    await expect(
      snapshotFiles(files, {
        policy: { directory: root, roots: [] },
        hooks: {
          beforeOpen: () => {
            rmSync(join(root, "swap-dir"), { recursive: true, force: true })
            symlinkSync(join(outside, "swap-dir"), join(root, "swap-dir"))
          },
        },
      }),
    ).rejects.toThrow("JOBS_SCRIPT_FILE_PATH")
  })

  test("refuses a parent swapped before a rename, and leaves both files alone (DF-6)", async () => {
    mkdirSync(join(root, "commit-dir"), { recursive: true })
    mkdirSync(join(outside, "commit-dir"), { recursive: true })
    writeFileSync(join(root, "commit-dir", "state.json"), JSON.stringify({ n: 1 }))
    writeFileSync(join(outside, "commit-dir", "state.json"), JSON.stringify({ n: "outside" }))
    const snapshots = await snapshotFiles(await resolveScriptFiles({ state: { path: "commit-dir/state.json", mode: "readwrite", format: "json" } }, root))
    const failure = await commitFiles(snapshots, [{ name: "state", json: JSON.stringify({ n: 2 }) }], {
      policy: { directory: root, roots: [] },
      hooks: {
        beforeRename: () => {
          // Keep the real folder, and put a symlink in its place after the check.
          renameSync(join(root, "commit-dir"), join(root, "commit-dir-real"))
          symlinkSync(join(outside, "commit-dir"), join(root, "commit-dir"))
        },
      },
    }).catch((error) => error)
    expect(failure).toBeInstanceOf(FileCommitError)
    expect(JSON.parse(readFileSync(join(outside, "commit-dir", "state.json"), "utf8"))).toEqual({ n: "outside" })
    expect(JSON.parse(readFileSync(join(root, "commit-dir-real", "state.json"), "utf8"))).toEqual({ n: 1 })
  })

  test("a write-only file's existing size is hashed, not capped, and its mode is taken at commit (DF-16)", async () => {
    writeFileSync(join(root, "write-only.json"), JSON.stringify({ pad: "x".repeat(2000) }))
    const files = await resolveScriptFiles(one("write-only.json", "write", "json", 100), root)
    const snapshots = await snapshotFiles(files)
    expect(snapshots[0]!.bytes).toBeGreaterThan(100)
    chmodSync(join(root, "write-only.json"), 0o604)
    await commitFiles(snapshots, [{ name: "state", json: JSON.stringify({ n: 1 }) }])
    expect((await stat(join(root, "write-only.json"))).mode & 0o777).toBe(0o604)
  })

  test("refuses a non-finite JSON number rather than writing null (DF-18)", async () => {
    writeFileSync(join(root, "infinite.json"), '{"big":1e999}')
    await expect(snapshotFiles(await resolveScriptFiles(one("infinite.json"), root))).rejects.toThrow("JOBS_SCRIPT_FILE_INVALID")
  })

  test("reads the conflict hash under a bound, and refuses a file grown past the bound (DF-13)", async () => {
    writeFileSync(join(root, "grown.json"), JSON.stringify({ n: 1 }))
    const snapshots = await snapshotFiles(await resolveScriptFiles(one("grown.json"), root))
    writeFileSync(join(root, "grown.json"), JSON.stringify({ pad: "x".repeat(8 * 1024 * 1024 + 1) }))
    await expect(commitFiles(snapshots, [{ name: "state", json: JSON.stringify({ n: 2 }) }])).rejects.toThrow("JOBS_SCRIPT_FILE_TOO_LARGE")
  })

  test("removes a stale temp file left by a killed process (DF-12)", async () => {
    writeFileSync(join(root, "stale.json"), JSON.stringify({ n: 1 }))
    const stale = join(root, ".stale.json.abcdef123456.tmp")
    writeFileSync(stale, "half")
    const old = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(stale, old, old)
    const snapshots = await snapshotFiles(await resolveScriptFiles(one("stale.json"), root))
    await commitFiles(snapshots, [{ name: "state", json: JSON.stringify({ n: 2 }) }], { now: () => Date.now() })
    expect(existsSync(stale)).toBe(false)
  })

  test("cleans only this target's stale crash artifacts, and keeps young and unrelated files (RR-1)", async () => {
    writeFileSync(join(root, "crash.json"), '{"n":1}')
    const old = new Date(Date.now() - 24 * 3_600_000)
    const staleTemp = join(root, ".crash.json.0123456789ab.tmp")
    const staleBackup = join(root, ".crash.json.0123456789ab.bak")
    const youngTemp = join(root, ".crash.json.abcdef123456.tmp")
    const youngBackup = join(root, ".crash.json.abcdef123456.bak")
    const other = join(root, ".other.json.0123456789ab.bak")
    const user = join(root, "notes.bak")
    for (const path of [staleTemp, staleBackup, other, user]) {
      writeFileSync(path, "old")
      utimesSync(path, old, old)
    }
    writeFileSync(youngTemp, "in flight")
    writeFileSync(youngBackup, "in flight")
    const snapshots = await snapshotFiles(await resolveScriptFiles(one("crash.json"), root))
    await commitFiles(snapshots, [{ name: "state", json: '{"n":2}' }], { now: () => Date.now() })
    expect(existsSync(staleTemp)).toBe(false)
    expect(existsSync(staleBackup)).toBe(false)
    for (const path of [youngTemp, youngBackup, other, user]) expect(existsSync(path)).toBe(true)
  })

  test("cleans a declared file's stale artifacts when another file in the folder is committed (RR-1)", async () => {
    writeFileSync(join(root, "folder-a.json"), '{}')
    writeFileSync(join(root, "folder-b.json"), '{}')
    const backup = join(root, ".folder-a.json.0123456789ab.bak")
    const temp = join(root, ".folder-a.json.abcdef123456.tmp")
    const old = new Date(Date.now() - 24 * 3_600_000)
    for (const path of [backup, temp]) {
      writeFileSync(path, "old")
      utimesSync(path, old, old)
    }
    const files = await resolveScriptFiles({ a: { path: "folder-a.json", mode: "read", format: "json" }, b: { path: "folder-b.json", mode: "readwrite", format: "json" } }, root)
    const snapshots = await snapshotFiles(files)
    await commitFiles(snapshots, [{ name: "b", json: '{"ok":true}' }], { now: () => Date.now() })
    expect(existsSync(backup)).toBe(false)
    expect(existsSync(temp)).toBe(false)
  })

  test("keeps stale backups for missing or invalid targets instead of guessing a restore (RR-1)", async () => {
    for (const name of ["missing-recovery.json", "invalid-recovery.json"]) {
      const target = join(root, name)
      const backup = join(root, `.${name}.0123456789ab.bak`)
      writeFileSync(backup, '{"original":true}')
      const old = new Date(Date.now() - 24 * 3_600_000)
      utimesSync(backup, old, old)
      if (name.startsWith("invalid")) writeFileSync(target, "invalid JSON")
      const snapshots = await snapshotFiles(await resolveScriptFiles(one(name, "write"), root))
      await expect(commitFiles(snapshots, [{ name: "state", json: '{"new":true}' }], { now: () => Date.now() })).rejects.toThrow("JOBS_SCRIPT_FILE_CONFLICT")
      expect(readFileSync(backup, "utf8")).toBe('{"original":true}')
      expect(existsSync(target)).toBe(name.startsWith("invalid"))
    }
  })
})
