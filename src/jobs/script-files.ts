/**
 * Declared job files: the path policy, the pre-run snapshot and the after-run commit.
 *
 * The guest has no filesystem. A job may declare files by name; the runner reads the readable ones into a frozen
 * `files.<name>` before the run, and buffers writes made with `files.write(name, value)`. A write is committed only when
 * the run succeeds, in one multi-file commit (validate, temp, keep each original aside, rename all, roll back on a
 * failure), and only if the file on disk is still the one the run read. The policy is re-checked immediately before
 * every open and every rename, and every open is `O_NOFOLLOW` with an `fstat` identity check, so a component swapped
 * after resolution is refused. Nothing here is reachable from an undeclared path.
 */
import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { copyFile, lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { jobsError } from "../constants.js"
import {
  SCRIPT_FILE_DEFAULT_MAX,
  SCRIPT_FILE_MAX,
  type ResolvedFile,
  type Script,
  type ScriptFileMode,
} from "./script.js"

/** The roots a declared file may live in: the job's directory, and the `scriptFilesRoots` option. */
export interface FilePolicy {
  readonly directory: string
  readonly roots: readonly string[]
}

/** Test seams for the checks: a swap between a check and the use it guards (DF-6). */
export interface FileHooks {
  readonly beforeOpen?: (path: string) => void | Promise<void>
  readonly beforeRename?: (from: string, to: string) => void | Promise<void>
}

/** What a run read: the value the guest sees, and the bytes and hash the commit compares against. */
export interface FileSnapshot {
  readonly file: ResolvedFile
  /** The parsed JSON, the text, or null when the file did not exist. */
  readonly value: unknown
  /** The file's sha256, or null when it did not exist. */
  readonly sha256: string | null
  readonly bytes: number
  /** The existing file's mode, or undefined for a new file. */
  readonly mode: number | undefined
}

/** One buffered write: the guest's value as a JSON string, serialised at commit. */
export interface FileWrite {
  readonly name: string
  readonly json: string
}

/** What happened to one file in a commit. */
export type FileOutcome = "written" | "rolled_back" | "not_attempted"

/** One file's record: what was read and written, never the content. */
export interface FileRecord {
  readonly name: string
  readonly path: string
  readonly mode: ScriptFileMode
  readonly bytesRead: number
  readonly bytesWritten: number
  readonly outcome?: FileOutcome
  readonly sha256Before?: string
  readonly sha256After?: string
}

/** A commit that refused or rolled back, with the true per-file outcome for the record. */
export class FileCommitError extends Error {
  readonly records: readonly FileRecord[]
  constructor(error: unknown, records: readonly FileRecord[]) {
    super(error instanceof Error ? error.message : String(error))
    this.name = "FileCommitError"
    this.records = records
  }
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

/** Case-folded and canonically decomposed, so `.GIT` and a decomposed spelling compare as the same name (DF-1). */
const fold = (name: string): string => name.normalize("NFD").toLowerCase()

const foldPath = (path: string): string => path.split(sep).map(fold).join(sep)

const inside = (child: string, parent: string): boolean => {
  const path = relative(parent, child)
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)
}

/** True when `child` is inside `parent`, comparing case-folded components on every platform. */
const insideFolded = (child: string, parent: string): boolean => inside(foldPath(child), foldPath(parent))

const samePath = (left: string, right: string): boolean => foldPath(left) === foldPath(right)

const rootsOf = (directory: string, roots: readonly string[]): readonly string[] => [directory, ...roots]

/** OpenCode's own configuration and data folders, and the project's `.opencode`, which no job file may touch. */
function reserved(directory: string): readonly string[] {
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config")
  const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
  return [join(configHome, "opencode"), join(dataHome, "opencode"), join(directory, ".opencode")]
}

/** True when any component of `path`, or the path itself, is a forbidden directory, compared folded (DF-1). */
const forbiddenComponent = (path: string, roots: readonly string[], directory: string): string | undefined => {
  for (const part of path.split(sep)) {
    if (part === "") continue
    const folded = fold(part)
    if (folded === ".git" || folded === ".opencode") return part
  }
  for (const owned of reserved(directory)) {
    if (samePath(path, owned) || insideFolded(path, owned)) return owned
  }
  for (const root of roots) {
    for (const owned of reserved(directory)) {
      if (samePath(root, owned) || insideFolded(root, owned)) return owned
    }
  }
  return undefined
}

/** A resolved path, and the leaf's identity when it existed, so a later open can prove it is the same file. */
interface Checked {
  readonly path: string
  readonly info: Awaited<ReturnType<typeof lstat>> | undefined
}

/**
 * Walks the full component chain from the allowed root: refuses a symlink at any component, a non-directory parent, a
 * non-regular leaf, a path outside the roots, and any forbidden name. A missing leaf is allowed for every mode.
 */
async function checkChain(absolute: string, policy: FilePolicy): Promise<Checked> {
  const refuse = (what: string, next = `Use a path inside the job's directory${policy.roots.length === 0 ? "" : " or one of scriptFilesRoots"}.`): never => {
    throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file at ${JSON.stringify(absolute)} ${what}.`, next)
  }
  const owned = forbiddenComponent(absolute, policy.roots, policy.directory)
  if (owned !== undefined) refuse(`is inside ${JSON.stringify(owned)}, which a script may not touch`)
  const foundRoot = rootsOf(policy.directory, policy.roots).find((candidate) => insideFolded(absolute, candidate))
  if (foundRoot === undefined) refuse("is outside the job's directory and scriptFilesRoots")
  const root = foundRoot as string
  if (samePath(absolute, root)) refuse("names the allowed root itself, not a file")
  const parts = relative(root, absolute).split(sep).filter((part) => part !== "")
  let current = root
  let leaf: Awaited<ReturnType<typeof lstat>> | undefined
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    const isLeaf = index === parts.length - 1
    let info: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse(`could not be inspected (${(error as Error).message.split("\n")[0]})`)
      if (isLeaf) return { path: absolute, info: undefined }
      refuse("has a parent directory that does not exist", `Create the directory, or point the file at an existing folder.`)
    }
    if (info === undefined) refuse("could not be inspected")
    if (info!.isSymbolicLink()) refuse(`has a symlink on its path (${JSON.stringify(parts[index]!)})`)
    if (isLeaf) {
      if (!info!.isFile()) refuse("is not a regular file")
      leaf = info
      break
    }
    if (!info!.isDirectory()) refuse("has a parent that is not a directory")
  }
  // Resolve the real path and prove it is still inside the same root: a case-folded compare on every platform.
  const real = await realpath(absolute).catch(() => absolute)
  if (!insideFolded(real, root) && !samePath(real, root)) refuse("resolves outside the allowed root")
  const ownedReal = forbiddenComponent(real, policy.roots, policy.directory)
  if (ownedReal !== undefined) refuse(`resolves inside ${JSON.stringify(ownedReal)}, which a script may not touch`)
  return { path: real, info: leaf }
}

/** Opens with `O_NOFOLLOW` and proves the descriptor is the leaf the chain just inspected (DF-6). */
async function openChecked(path: string, flags: number, pre: Awaited<ReturnType<typeof lstat>> | undefined, create = false) {
  let handle
  try {
    handle = await open(path, flags | constants.O_NOFOLLOW | (create ? constants.O_CREAT | constants.O_EXCL : 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP" || (error as NodeJS.ErrnoException).code === "EMLINK") {
      throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file at ${JSON.stringify(path)} was replaced with a symlink while it was used.`, `Remove the link, then run the job again.`)
    }
    throw error
  }
  try {
    const found = await handle.stat()
    if (!found.isFile()) throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file at ${JSON.stringify(path)} is not a regular file.`, `Point it at a regular file.`)
    if (pre !== undefined && (found.dev !== pre.dev || found.ino !== pre.ino)) {
      throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file at ${JSON.stringify(path)} changed identity while it was used.`, `Let the next run read the current file.`)
    }
    return { handle, found }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/** The declared path, canonicalised and checked against the policy; one refusal code for every shape. */
async function resolveOne(file: { readonly name: string; readonly path: string; readonly mode: ScriptFileMode; readonly format: string; readonly maxBytes?: number }, directory: string, roots: readonly string[]): Promise<ResolvedFile> {
  const declared = file.path
  const refuse = (what: string, next = `Use a path inside the job's directory${roots.length === 0 ? "" : " or one of scriptFilesRoots"}.`): never => {
    throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file ${JSON.stringify(file.name)} has the path ${JSON.stringify(declared)}, and ${what}.`, next)
  }
  if (declared.split(/[\\/]/).includes("..")) refuse("the path contains a .. segment")
  if (declared.includes("\u0000")) refuse("the path contains a null byte")
  const absolute = isAbsolute(declared) ? resolve(declared) : resolve(directory, declared)
  const policy: FilePolicy = { directory, roots }
  const checked = await checkChain(absolute, policy)
  return {
    name: file.name,
    path: checked.path,
    mode: file.mode,
    format: file.format as ResolvedFile["format"],
    maxBytes: Math.min(SCRIPT_FILE_MAX, Math.max(1, file.maxBytes ?? SCRIPT_FILE_DEFAULT_MAX)),
  }
}

/** The canonical policy: the job's directory and the extra roots, resolved once, so `/var` and `/private/var` agree. */
export async function filePolicy(directory: string, roots: readonly string[] = []): Promise<FilePolicy> {
  const real = await realpath(directory).catch(() => resolve(directory))
  const realRoots: string[] = []
  for (const root of roots) realRoots.push(await realpath(root).catch(() => resolve(root)))
  return { directory: real, roots: realRoots }
}

/** Resolves every declared file, in name order, or refuses with `JOBS_SCRIPT_FILE_PATH`. */
export async function resolveScriptFiles(files: Script["files"] = {}, directory: string, roots: readonly string[] = []): Promise<readonly ResolvedFile[]> {
  const policy = await filePolicy(directory, roots)
  const resolved: ResolvedFile[] = []
  for (const [name, file] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) resolved.push(await resolveOne({ name, ...file }, policy.directory, policy.roots))
  return resolved
}

const policyOf = (file: ResolvedFile, policy?: FilePolicy): FilePolicy => policy ?? { directory: dirname(file.path), roots: [] }

/** Non-finite numbers are not JSON: refuse them rather than silently writing `null` (DF-18). */
function refuseNonFinite(value: unknown, file: ResolvedFile): void {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw jobsError("JOBS_SCRIPT_FILE_INVALID", `The file ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)} holds a number JSON cannot represent (it is out of range).`, `Store the value as a string, or keep it within the IEEE-754 range.`)
      continue
    }
    if (Array.isArray(entry)) stack.push(...entry)
    else if (entry !== null && typeof entry === "object") stack.push(...Object.values(entry as Record<string, unknown>))
  }
}

/** The pre-run snapshot: each readable file's value, bytes and hash; a missing file is null. */
export async function snapshotFiles(files: readonly ResolvedFile[], options: { readonly policy?: FilePolicy; readonly hooks?: FileHooks } = {}): Promise<readonly FileSnapshot[]> {
  const snapshots: FileSnapshot[] = []
  for (const file of files) {
    const policy = policyOf(file, options.policy)
    const checked = await checkChain(file.path, policy)
    await options.hooks?.beforeOpen?.(file.path)
    if (checked.info === undefined) {
      snapshots.push({ file, value: null, sha256: null, bytes: 0, mode: undefined })
      continue
    }
    const { handle, found } = await openChecked(file.path, constants.O_RDONLY, checked.info)
    let bytes: Buffer
    try {
      if (file.mode !== "write" && found.size > file.maxBytes) {
        throw jobsError("JOBS_SCRIPT_FILE_TOO_LARGE", `The file ${JSON.stringify(file.name)} is ${found.size} bytes, over its ${file.maxBytes} byte limit.`, `Raise the file's maxBytes, or keep it smaller.`)
      }
      // A write-only file's content is never given to the guest; a bounded hash is all the commit needs (DF-16).
      if (file.mode === "write" && found.size > SCRIPT_FILE_MAX) {
        throw jobsError("JOBS_SCRIPT_FILE_TOO_LARGE", `The file ${JSON.stringify(file.name)} is ${found.size} bytes; a write-only file's existing content is hashed, so it must stay under ${SCRIPT_FILE_MAX} bytes.`, `Replace it with a smaller file, or declare it readwrite and keep it under its maxBytes.`)
      }
      bytes = await handle.readFile()
    } finally {
      await handle.close().catch(() => undefined)
    }
    if (file.mode !== "write" && bytes.byteLength > file.maxBytes) {
      throw jobsError("JOBS_SCRIPT_FILE_TOO_LARGE", `The file ${JSON.stringify(file.name)} grew past its ${file.maxBytes} byte limit while it was read.`, `Raise the file's maxBytes, or keep it smaller.`)
    }
    let value: unknown
    if (file.mode === "write") value = undefined
    else if (file.format === "json") {
      try {
        value = JSON.parse(bytes.toString("utf8"))
      } catch (error) {
        throw jobsError("JOBS_SCRIPT_FILE_INVALID", `The file ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)} is not valid JSON (${(error as Error).message.split("\n")[0]}).`, `Fix the file, or declare it with "format": "text".`)
      }
      refuseNonFinite(value, file)
    } else value = bytes.toString("utf8")
    snapshots.push({ file, value, sha256: sha256(bytes), bytes: bytes.byteLength, mode: found.mode & 0o777 })
  }
  return snapshots
}

/** The value a write's JSON serialises to, with the record's format rules: JSON is pretty-printed, text is a string. */
function serialise(file: ResolvedFile, json: string): string {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw jobsError("JOBS_SCRIPT_FILE_INVALID", `The value written to ${JSON.stringify(file.name)} is not JSON.`, `Pass a JSON value to files.write.`)
  }
  if (file.format === "json") return `${JSON.stringify(value, null, 2)}\n`
  if (typeof value !== "string") throw jobsError("JOBS_SCRIPT_FILE_INVALID", `The file ${JSON.stringify(file.name)} is text, so files.write must receive a string.`, `Pass a string, or declare the file with "format": "json".`)
  return value
}

/** One validated write, before any filesystem change. */
interface Planned {
  readonly snapshot: FileSnapshot
  readonly bytes: Buffer
  readonly hash: string
}

/** `stat` then read, never above the cap, so a grown conflict read cannot exhaust memory (DF-13). */
async function readBounded(file: ResolvedFile, policy: FilePolicy): Promise<Buffer | undefined> {
  const checked = await checkChain(file.path, policy)
  if (checked.info === undefined) return undefined
  const { handle, found } = await openChecked(file.path, constants.O_RDONLY, checked.info)
  try {
    if (found.size > SCRIPT_FILE_MAX) {
      throw jobsError("JOBS_SCRIPT_FILE_TOO_LARGE", `The file ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)} is ${found.size} bytes; it is over the ${SCRIPT_FILE_MAX} byte bound for a conflict check.`, `Keep the file smaller, then run the job again.`)
    }
    return await handle.readFile()
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** A kept original: a hard link beside it, or a copy when the filesystem refuses links. */
async function keep(original: string): Promise<string> {
  const backup = join(dirname(original), `.${basename(original)}.${randomBytes(6).toString("hex")}.bak`)
  try {
    await copyFile(original, backup)
  } catch (error) {
    throw jobsError("JOBS_SCRIPT_FILE_CONFLICT", `The original of ${JSON.stringify(original)} could not be kept aside (${(error as Error).message.split("\n")[0]}), so nothing was written.`, `Check the folder is writable, then run the job again.`)
  }
  return backup
}

/** Removes temp files a killed process left in a folder this commit writes, older than an hour (DF-12). */
async function cleanupTemps(directory: string, now: number): Promise<void> {
  const entries = await readdir(directory).catch(() => [] as string[])
  for (const entry of entries) {
    if (!/^\..+\.[0-9a-f]{12}\.tmp$/.test(entry) || !entry.endsWith(".tmp")) continue
    const path = join(directory, entry)
    const info = await lstat(path).catch(() => undefined)
    if (info === undefined || !info.isFile() || now - info.mtimeMs < 3_600_000) continue
    await unlink(path).catch(() => undefined)
  }
}

/** Flushes a directory entry after a rename; a platform that refuses is not fatal (DF-11). */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY).catch(() => undefined)
  if (handle === undefined) return
  await handle.sync().catch(() => undefined)
  await handle.close().catch(() => undefined)
}

/** Writes a temp file with `O_CREAT|O_EXCL|O_NOFOLLOW`, fsyncs it, and returns its path (DF-11, DF-12). */
async function writeTemp(target: string, bytes: Buffer, mode: number, policy: FilePolicy): Promise<string> {
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`)
  const checked = await checkChain(temp, policy)
  const { handle } = await openChecked(temp, constants.O_WRONLY, checked.info, true)
  try {
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  return temp
}

/** The path a rename must land on, re-checked after any test hook and immediately before the rename (DF-6). */
async function checkTarget(target: string, policy: FilePolicy): Promise<void> {
  // The whole chain again, immediately before the rename: a packed component must not reach the final syscall (DF-6).
  await checkChain(target, policy)
  const parent = dirname(target)
  const real = await realpath(parent).catch(() => parent)
  const root = rootsOf(policy.directory, policy.roots).find((candidate) => insideFolded(target, candidate) || samePath(target, candidate))
  if (root === undefined || (!insideFolded(real, root) && !samePath(real, root))) {
    throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file at ${JSON.stringify(target)} has a parent that now resolves outside the allowed root.`, `Move it back inside the job's directory, then run the job again.`)
  }
  const owned = forbiddenComponent(target, policy.roots, policy.directory)
  if (owned !== undefined) throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file at ${JSON.stringify(target)} is inside ${JSON.stringify(owned)}, which a script may not touch.`, `Use another path.`)
  const leaf = await lstat(target).catch(() => undefined)
  if (leaf?.isSymbolicLink() === true) throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file at ${JSON.stringify(target)} is now a symlink.`, `Remove the link, then run the job again.`)
}

/**
 * Commits the buffered writes after a successful run, all or nothing. Every write is validated first; then every temp
 * is written and fsynced, every existing original is kept aside, and every rename runs. If a rename fails, the ones
 * that landed are restored and the error carries each file's true outcome, never "nothing written" (DF-4).
 */
export async function commitFiles(
  snapshots: readonly FileSnapshot[],
  writes: readonly FileWrite[],
  options: { readonly rename?: (from: string, to: string) => Promise<void>; readonly policy?: FilePolicy; readonly hooks?: FileHooks; readonly now?: () => number } = {},
): Promise<readonly FileRecord[]> {
  const byName = new Map(snapshots.map((snapshot) => [snapshot.file.name, snapshot] as const))
  // Last write to a name wins, and only the run's start snapshot is compared (DF-3).
  const last = new Map<string, FileWrite>()
  for (const write of writes) last.set(write.name, write)
  const base = (snapshot: FileSnapshot): FileRecord => ({
    name: snapshot.file.name,
    path: snapshot.file.path,
    mode: snapshot.file.mode,
    bytesRead: snapshot.bytes,
    bytesWritten: 0,
    outcome: "not_attempted",
    ...(snapshot.sha256 === null ? {} : { sha256Before: snapshot.sha256 }),
  })
  const records = new Map(snapshots.map((snapshot) => [snapshot.file.name, base(snapshot)] as const))
  const fail = (error: unknown): never => {
    throw new FileCommitError(error, [...records.values()])
  }

  const planned: Planned[] = []
  for (const write of last.values()) {
    const snapshot = byName.get(write.name)
    if (snapshot === undefined) fail(jobsError("JOBS_SCRIPT_FILE_PATH", `The file ${JSON.stringify(write.name)} was not declared.`, `Declare it, then approve the script again.`))
    const file = snapshot!.file
    if (file.mode === "read") fail(jobsError("JOBS_SCRIPT_FILE_MODE", `The file ${JSON.stringify(file.name)} is declared "read", so it cannot be written.`, `Declare it "write" or "readwrite", then approve the script again.`))
    let bytes: Buffer = Buffer.alloc(0)
    try {
      bytes = Buffer.from(serialise(file, write.json), "utf8")
    } catch (error) {
      fail(error)
    }
    if (bytes!.byteLength > file.maxBytes) {
      fail(jobsError("JOBS_SCRIPT_FILE_TOO_LARGE", `The write to ${JSON.stringify(file.name)} is ${bytes.byteLength} bytes, over its ${file.maxBytes} byte limit.`, `Raise the file's maxBytes, or write less.`))
    }
    const current = await readBounded(file, policyOf(file, options.policy)).catch((error) => fail(error))
    const before = current === undefined ? null : sha256(current!)
    if (before !== snapshot!.sha256) {
      fail(jobsError("JOBS_SCRIPT_FILE_CONFLICT", `The file ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)} changed on disk after the run read it.`, `Let the next run read the new file, or remove the other writer.`))
    }
    planned.push({ snapshot: snapshot!, bytes: bytes!, hash: sha256(bytes!) })
  }

  // Every temp is written before any rename, and every original is kept aside before any rename (DF-4).
  const temps: { planned: Planned; temp: string; backup?: string }[] = []
  try {
    const directories = new Set(planned.map((entry) => dirname(entry.snapshot.file.path)))
    const now = options.now?.() ?? 0
    for (const directory of directories) await cleanupTemps(directory, now)
    for (const entry of planned) {
      const policy = policyOf(entry.snapshot.file, options.policy)
      await checkTarget(entry.snapshot.file.path, policy).catch((error) => fail(error))
      // The mode is read at commit time, so a chmod between the snapshot and the commit is kept (DF-16).
      const live = await lstat(entry.snapshot.file.path).catch(() => undefined)
      const mode = live === undefined ? 0o600 : live.mode & 0o777
      const temp = await writeTemp(entry.snapshot.file.path, entry.bytes, mode, policy).catch((error) => fail(error))
      let backup: string | undefined
      if (entry.snapshot.sha256 !== null) backup = await keep(entry.snapshot.file.path).catch((error) => fail(error))
      temps.push({ planned: entry, temp: temp!, ...(backup === undefined ? {} : { backup }) })
    }
  } catch (error) {
    for (const entry of temps) {
      await unlink(entry.temp).catch(() => undefined)
      if (entry.backup !== undefined) await unlink(entry.backup).catch(() => undefined)
    }
    throw new FileCommitError(error, [...records.values()])
  }

  const move = options.rename ?? ((from: string, to: string) => rename(from, to))
  const landed: typeof temps = []
  try {
    for (const entry of temps) {
      const target = entry.planned.snapshot.file.path
      const policy = policyOf(entry.planned.snapshot.file, options.policy)
      await options.hooks?.beforeRename?.(entry.temp, target)
      await checkTarget(target, policy).catch((error) => fail(error))
      await move(entry.temp, target).catch((error) => fail(error))
      landed.push(entry)
      records.set(entry.planned.snapshot.file.name, {
        ...records.get(entry.planned.snapshot.file.name)!,
        bytesWritten: entry.planned.bytes.byteLength,
        outcome: "written",
        sha256After: entry.planned.hash,
      })
    }
  } catch (error) {
    // Restore the ones that landed, newest first, from the kept originals; remove the rest.
    for (const entry of [...landed].reverse()) {
      const target = entry.planned.snapshot.file.path
      if (entry.backup !== undefined) await rename(entry.backup, target).catch(() => undefined)
      else await unlink(target).catch(() => undefined)
      records.set(entry.planned.snapshot.file.name, {
        ...records.get(entry.planned.snapshot.file.name)!,
        bytesWritten: 0,
        outcome: "rolled_back",
        sha256After: undefined,
      })
    }
    for (const entry of temps) {
      if (!landed.includes(entry)) await unlink(entry.temp).catch(() => undefined)
      if (entry.backup !== undefined && !landed.includes(entry)) await unlink(entry.backup).catch(() => undefined)
    }
    for (const directory of new Set(temps.map((entry) => dirname(entry.planned.snapshot.file.path)))) await syncDirectory(directory)
    throw new FileCommitError(error, [...records.values()])
  }
  for (const entry of temps) {
    await unlink(entry.temp).catch(() => undefined)
    if (entry.backup !== undefined) await unlink(entry.backup).catch(() => undefined)
  }
  for (const directory of new Set(temps.map((entry) => dirname(entry.planned.snapshot.file.path)))) await syncDirectory(directory)
  return [...records.values()]
}
