/**
 * A run's own background work. From OpenCode 2.3.0 the `subagent` tool always runs in the background, so a run's
 * session can go idle while a subagent it started is still working; when that subagent (or a background shell the
 * session started) finishes, its notice wakes the session for another turn. `session.wait` resolves at the first idle,
 * so a run that waited for it alone would be recorded as finished, with a partial summary, while its work went on.
 *
 * The host's `experimental.idle` hook lists the work still running each time a session goes idle. This module keeps,
 * for each run session, whether that session's own subagent or shell is still running, and `settle` waits through those
 * idles until the session goes idle with none left. Work a descendant owns wakes that descendant, not the run's
 * session, so only the session's own work counts. A person's session is never tracked.
 */
import type { Plugin } from "@opencode/plugin"
import { isJobSession } from "./safety.js"

/** One entry of the idle hook's `background` list: only the owner and the kind are read. */
export interface IdleWork {
  readonly kind: string
  readonly sessionID: string
}

/** What the idle hook hands over: the session going idle and the work still running. */
export interface Idle {
  readonly sessionID: string
  readonly background: ReadonlyArray<IdleWork>
}

/** The kinds whose finish wakes the session that owns them (the hook's own contract). */
const WAKES: ReadonlySet<string> = new Set(["subagent", "shell"])

interface Entry {
  pending: boolean
  waiters: Array<() => void>
}

const entries = new Map<string, Entry>()

const entryOf = (sessionID: string): Entry => {
  const found = entries.get(sessionID)
  if (found !== undefined) return found
  const created: Entry = { pending: false, waiters: [] }
  entries.set(sessionID, created)
  return created
}

/** Records one idle of a run session, and releases everyone waiting for it. */
export function noteIdle(idle: Idle): void {
  if (!isJobSession(idle.sessionID)) return
  const entry = entryOf(idle.sessionID)
  entry.pending = idle.background.some((work) => work.sessionID === idle.sessionID && WAKES.has(work.kind))
  const waiters = entry.waiters.splice(0)
  if (!entry.pending) entries.delete(idle.sessionID)
  for (const release of waiters) release()
}

/** True while the session's last idle listed a subagent or shell of its own that is still running. */
export const hasBackground = (sessionID: string): boolean => entries.get(sessionID)?.pending === true

/** Resolves at the session's next idle. */
function nextIdle(sessionID: string): Promise<void> {
  return new Promise((resolve) => entryOf(sessionID).waiters.push(resolve))
}

/** Drops what is kept for a session whose run has ended, and releases anyone still waiting. */
export function forgetBackground(sessionID: string): void {
  const entry = entries.get(sessionID)
  entries.delete(sessionID)
  for (const release of entry?.waiters ?? []) release()
}

/**
 * Waits until the session is idle with no subagent or shell of its own still running. `wait` errors count as idle,
 * as they always have: the outcome the host reports afterwards is the source of truth.
 */
export async function settle(session: Pick<Plugin.Context["session"], "wait">, sessionID: string): Promise<void> {
  for (;;) {
    await session.wait({ sessionID }).catch(() => undefined)
    if (!hasBackground(sessionID)) return
    await nextIdle(sessionID)
  }
}

/** Registers the idle hook; the returned function disposes it. */
export async function registerBackground(session: Pick<Plugin.Context["session"], "hook">): Promise<() => Promise<void>> {
  const hook = await session.hook("experimental.idle", (idle) => noteIdle(idle))
  return hook.dispose
}
