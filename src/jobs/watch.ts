/**
 * The job-file watch: the folders are checked at most once a minute, and a file is parsed again only when its
 * modification time (or a file appearing or going) has changed. A change is therefore picked up within a minute, and a
 * pass every 30 seconds costs one `stat` a minute rather than a parse of every file (PLAN phase 6).
 *
 * A refused file is part of the cached answer too, so status keeps naming it until the file changes. The watch never
 * throws: a scan that fails returns what the file reader returns, which is a report of what it could not read.
 */
import { MINUTE } from "./model.js"
import type { JobFiles } from "./files.js"

export interface FileWatch {
  /** The files as last read, or as read now when the minute has passed and their signature changed. */
  read(signature: () => Promise<string>, scan: () => Promise<JobFiles>): Promise<JobFiles>
}

export function createFileWatch(now: () => number, everyMs = MINUTE, retryMs = 5_000): FileWatch {
  let last: { readonly at: number; readonly signature: string; readonly files: JobFiles } | undefined
  return {
    async read(signature, scan) {
      const at = now()
      // A file refused because an agent is missing is retried at once, and then on a short cadence even when the host's
      // list has not changed: a restart's first scan can see a partial list, and the file must load when it fills in
      // (GAP-30). Healthy files keep the one-stat-a-minute cost.
      const missing = last?.files.refused.some((entry) => entry.code === "JOBS_AGENT_MISSING") === true
      if (last !== undefined && at - last.at < everyMs && !missing) return last.files
      const current = await signature()
      if (last !== undefined && current === last.signature && (!missing || at - last.at < retryMs)) {
        last = { at, signature: current, files: last.files }
        return last.files
      }
      const files = await scan()
      last = { at, signature: current, files }
      return files
    },
  }
}
