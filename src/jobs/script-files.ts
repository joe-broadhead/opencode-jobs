/**
 * Declared job files: the path policy, the pre-run snapshot and the after-run commit.
 *
 * The guest has no filesystem. A job may declare files by name; the runner reads the readable ones into a frozen
 * `files.<name>` before the run, and buffers writes made with `files.write(name, value)`. A write is committed only when
 * the run succeeds, atomically (a temp file in the same directory, then a rename), and only if the file on disk is still
 * the one the run read. Nothing here is reachable from an undeclared path.
 */
import { createHash, randomBytes } from "node:crypto"
import { lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
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

/** One file's record: what was read and written, never the content. */
export interface FileRecord {
  readonly name: string
  readonly path: string
  readonly mode: ScriptFileMode
  readonly bytesRead: number
  readonly bytesWritten: number
  readonly sha256Before?: string
  readonly sha256After?: string
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

const inside = (child: string, parent: string): boolean => {
  const path = relative(parent, child)
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)
}

const rootsOf = (directory: string, roots: readonly string[]): readonly string[] => [directory, ...roots.map((root) => resolve(root))]

/** OpenCode's own configuration and data folders, and the project's `.opencode`, which no job file may touch. */
function reserved(directory: string): readonly string[] {
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config")
  const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
  return [join(configHome, "opencode"), join(dataHome, "opencode"), join(directory, ".opencode")]
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
  if (!rootsOf(directory, roots).some((root) => inside(absolute, root))) refuse("the path is outside the job's directory and scriptFilesRoots")
  for (const owned of reserved(directory)) {
    if (absolute === owned || inside(absolute, owned)) refuse("the path is inside OpenCode's own configuration or data")
  }
  if (absolute.split(sep).includes(".git")) refuse("the path is inside a .git directory")

  // Refuse a symlink at any component, from the allowed root down. A missing leaf is allowed (a write may create it),
  // but its parent must exist and be a real directory.
  const root = rootsOf(directory, roots).find((candidate) => inside(absolute, candidate)) ?? directory
  const parts = relative(root, absolute).split(sep).filter((part) => part !== "")
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    const leaf = index === parts.length - 1
    let info: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse(`it could not be inspected (${(error as Error).message.split("\n")[0]})`)
      // A missing leaf is allowed for every mode (a read sees null; a write may create it); a missing parent is not.
      if (leaf) return canonical(absolute, file, roots)
      refuse("a parent directory does not exist", `Create the directory, or point the file at an existing folder.`)
    }
    if (info === undefined) refuse("it could not be inspected")
    const found = info!
    if (found.isSymbolicLink()) refuse("a symlink is on its path")
    if (leaf) {
      if (!found.isFile()) refuse("it is not a regular file")
      return canonical(await realpath(absolute), file, roots)
    }
    if (!found.isDirectory()) refuse("a parent is not a directory")
  }
  return canonical(absolute, file, roots)
}

function canonical(absolute: string, file: { readonly name: string; readonly path: string; readonly mode: ScriptFileMode; readonly format: string; readonly maxBytes?: number }, roots: readonly string[]): ResolvedFile {
  const resolvedRoot = roots.find((root) => inside(absolute, resolve(root)))
  const shown = resolvedRoot === undefined ? absolute : absolute
  void resolvedRoot
  return {
    name: file.name,
    path: shown,
    mode: file.mode,
    format: file.format as ResolvedFile["format"],
    maxBytes: Math.min(SCRIPT_FILE_MAX, Math.max(1, file.maxBytes ?? SCRIPT_FILE_DEFAULT_MAX)),
  }
}

/** Resolves every declared file, in name order, or refuses with `JOBS_SCRIPT_FILE_PATH`. */
export async function resolveScriptFiles(files: Script["files"] = {}, directory: string, roots: readonly string[] = []): Promise<readonly ResolvedFile[]> {
  const resolved: ResolvedFile[] = []
  for (const [name, file] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) resolved.push(await resolveOne({ name, ...file }, directory, roots))
  return resolved
}

/** The pre-run snapshot: each readable file's value, bytes and hash; a missing file is null. */
export async function snapshotFiles(files: readonly ResolvedFile[]): Promise<readonly FileSnapshot[]> {
  const snapshots: FileSnapshot[] = []
  for (const file of files) {
    let bytes: Buffer
    let mode: number | undefined
    try {
      const info = await stat(file.path)
      if (!info.isFile()) throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)} is not a regular file.`, `Point it at a regular file.`)
      if (info.size > file.maxBytes) {
        throw jobsError("JOBS_SCRIPT_FILE_TOO_LARGE", `The file ${JSON.stringify(file.name)} is ${info.size} bytes, over its ${file.maxBytes} byte limit.`, `Raise the file's maxBytes, or keep it smaller.`)
      }
      bytes = await readFile(file.path)
      mode = info.mode & 0o777
      if (bytes.byteLength > file.maxBytes) {
        throw jobsError("JOBS_SCRIPT_FILE_TOO_LARGE", `The file ${JSON.stringify(file.name)} grew past its ${file.maxBytes} byte limit while it was read.`, `Raise the file's maxBytes, or keep it smaller.`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        snapshots.push({ file, value: null, sha256: null, bytes: 0, mode: undefined })
        continue
      }
      throw error
    }
    let value: unknown
    if (file.mode === "write") value = undefined
    else if (file.format === "json") {
      try {
        value = JSON.parse(bytes.toString("utf8"))
      } catch (error) {
        throw jobsError("JOBS_SCRIPT_FILE_INVALID", `The file ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)} is not valid JSON (${(error as Error).message.split("\n")[0]}).`, `Fix the file, or declare it with "format": "text".`)
      }
    } else value = bytes.toString("utf8")
    snapshots.push({ file, value, sha256: sha256(bytes), bytes: bytes.byteLength, mode })
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

/**
 * Commits the buffered writes after a successful run. Each is checked against its snapshot, written to a temp file in
 * the same directory and renamed; a conflict, a cap or a mode refusal leaves the old file untouched.
 */
export async function commitFiles(
  snapshots: readonly FileSnapshot[],
  writes: readonly FileWrite[],
  options: { readonly rename?: (from: string, to: string) => Promise<void> } = {},
): Promise<readonly FileRecord[]> {
  const byName = new Map(snapshots.map((snapshot) => [snapshot.file.name, snapshot] as const))
  const records: FileRecord[] = []
  const move = options.rename ?? ((from: string, to: string) => rename(from, to))
  for (const write of writes) {
    const snapshot = byName.get(write.name)
    if (snapshot === undefined) throw jobsError("JOBS_SCRIPT_FILE_PATH", `The file ${JSON.stringify(write.name)} was not declared.`, `Declare it, then approve the script again.`)
    const file = snapshot.file
    if (file.mode === "read") throw jobsError("JOBS_SCRIPT_FILE_MODE", `The file ${JSON.stringify(file.name)} is declared "read", so it cannot be written.`, `Declare it "write" or "readwrite", then approve the script again.`)
    const text = serialise(file, write.json)
    const bytes = Buffer.from(text, "utf8")
    if (bytes.byteLength > file.maxBytes) {
      throw jobsError("JOBS_SCRIPT_FILE_TOO_LARGE", `The write to ${JSON.stringify(file.name)} is ${bytes.byteLength} bytes, over its ${file.maxBytes} byte limit.`, `Raise the file's maxBytes, or write less.`)
    }
    let current: Buffer | undefined
    try {
      current = await readFile(file.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const before = current === undefined ? null : sha256(current)
    if (before !== snapshot.sha256) {
      throw jobsError("JOBS_SCRIPT_FILE_CONFLICT", `The file ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)} changed on disk after the run read it.`, `Let the next run read the new file, or remove the other writer.`)
    }
    const mode = snapshot.mode ?? 0o600
    const temp = join(dirname(file.path), `.${basename(file.path)}.${randomBytes(6).toString("hex")}.tmp`)
    try {
      await writeFile(temp, bytes, { mode })
      await move(temp, file.path)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
    records.push({ name: file.name, path: file.path, mode: file.mode, bytesRead: snapshot.bytes, bytesWritten: bytes.byteLength, ...(snapshot.sha256 === null ? {} : { sha256Before: snapshot.sha256 }), sha256After: sha256(bytes) })
  }
  return records
}
