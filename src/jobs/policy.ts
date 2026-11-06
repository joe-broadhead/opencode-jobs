/**
 * The scheduling policies, as pure functions of a job, its state and the clock. Nothing here reads the time, starts a
 * timer or touches storage, so every rule is a unit test and the runner is only plumbing.
 *
 * - catch-up: at most one missed slot runs, the newest, within `maxLate`; the rest become one collapsed gap (D4).
 * - overlap: what a due slot does while the job's previous run is still going.
 * - retries: a failed run is retried up to `retries.max`, with exponential backoff; a timeout is not.
 * - ends and expiry: `ends.times`, `ends.at` and `expires`.
 * - five failed slots in a row pause the job.
 */
import { type Job, jitterFor } from "./model.js"
import type { JobState } from "./store.js"

/** A run that starts more than this after its slot is late. */
export const LATE_MS = 60_000

/** Five failed slots in a row pause the job, so a runaway job cannot keep spending. */
export const FAILURES_BEFORE_PAUSE = 5

export type RunOutcome = "succeeded" | "failed" | "timed_out" | "interrupted"

/** Slots missed while the runner was away, collapsed into one record. */
export interface Gap {
  /** The oldest missed slot. */
  readonly from: number
  /** The newest missed slot. */
  readonly to: number
  readonly count: number
}

export interface CatchUpPlan {
  /** The newest missed slot to run, when the policy and `maxLate` allow it. */
  readonly run: number | null
  /** The slots that will not run, as one record; null when there are none. */
  readonly gap: Gap | null
}

/**
 * What to do with the slots that fell due while nothing was running. `slots` is oldest first and is filtered to the
 * past here, so a slot in the future is never treated as missed.
 */
export function catchUp(job: Pick<Job, "policy">, slots: readonly number[], now: number): CatchUpPlan {
  const due = slots.filter((slot) => Number.isFinite(slot) && slot <= now).sort((left, right) => left - right)
  if (due.length === 0) return { run: null, gap: null }
  const newest = due[due.length - 1]!
  const older = due.slice(0, -1)
  const fresh = job.policy.catchup === "latest" && now - newest <= job.policy.maxLateMs
  if (!fresh) return { run: null, gap: gapOf(due) }
  return { run: newest, gap: gapOf(older) }
}

function gapOf(slots: readonly number[]): Gap | null {
  if (slots.length === 0) return null
  return { from: slots[0]!, to: slots[slots.length - 1]!, count: slots.length }
}

export type OverlapAction = "run" | "skip" | "queue" | "replace"

/**
 * What a due slot does while the job's previous run is still going: `skip` (the default), `queue-one` (one slot waits
 * for the current run), `replace` (interrupt it) or `allow` (run beside it, within the global concurrency cap).
 */
export function overlapOf(job: Pick<Job, "policy">, running: { readonly slot: number } | null): OverlapAction {
  if (running === null) return "run"
  switch (job.policy.overlap) {
    case "skip":
      return "skip"
    case "queue-one":
      return "queue"
    case "replace":
      return "replace"
    case "allow":
      return "run"
  }
}

export type StopReason = "expired" | "ended"

/** Why the job should not run this slot: it has expired or ended. A paused job is skipped before this is asked. */
export function stopReason(job: Pick<Job, "expires" | "ends">, state: Pick<JobState, "runCount">, now: number): StopReason | null {
  if (job.expires !== undefined && now >= job.expires) return "expired"
  if (job.ends.at !== undefined && now >= job.ends.at) return "ended"
  if (job.ends.times !== undefined && state.runCount >= job.ends.times) return "ended"
  return null
}

export interface RetryPlan {
  /** The attempt the retry will be, counting from 1. */
  readonly attempt: number
  readonly delayMs: number
}

/**
 * The retry after an attempt that has finished: exponential backoff from `retries.backoffMs`, up to `retries.max`
 * retries. Only a `failed` run is retried: a timeout, an interruption and a success are final. `attempt` is the
 * attempt that just finished, counting from 1.
 */
export function retryAfter(job: Pick<Job, "policy">, input: { readonly attempt: number; readonly outcome: RunOutcome }): RetryPlan | null {
  if (input.outcome !== "failed") return null
  if (input.attempt > job.policy.retries.max) return null
  return { attempt: input.attempt + 1, delayMs: job.policy.retries.backoffMs * 2 ** (input.attempt - 1) }
}

/** Five failed slots in a row pause the job. */
export function shouldPause(failures: number): boolean {
  return failures >= FAILURES_BEFORE_PAUSE
}

/** A run that starts more than a minute after its slot is recorded as late. */
export function isLate(slot: number, now: number): boolean {
  return now - slot > LATE_MS
}

/** When a slot's run starts: never before the slot, and by its deterministic jitter. */
export function startAt(job: Pick<Job, "id" | "jitterMs">, slot: number): number {
  return slot + jitterFor(job.id, job.jitterMs)
}
