/**
 * The planner: the next slot of a schedule, and the slots between two instants. This is the only module that imports
 * croner, so the library can be swapped without touching the model, the policy or the runner.
 *
 * croner runs with `paused: true`: the leader's loop owns the clock, and nothing here starts a timer.
 *
 * The zone is always already resolved (the job's, else the plugin's `timezone` option, else the server's), so a schedule
 * here carries the zone it runs in.
 */
import { Cron } from "croner"
import { jobsError } from "../constants.js"
import type { JobSchedule } from "./model.js"

const CACHE_LIMIT = 64
const CACHE = new Map<string, Cron>()

/** A paused cron for one pattern and zone; the cache keeps a leader's next-slot calls off the parser. */
function cron(pattern: string, tz: string): Cron {
  const key = `${tz}\n${pattern}`
  const cached = CACHE.get(key)
  if (cached !== undefined) return cached
  const created = new Cron(pattern, { paused: true, timezone: tz })
  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next()
    if (!oldest.done) CACHE.delete(oldest.value)
  }
  CACHE.set(key, created)
  return created
}

/** Why a cron pattern cannot run here, or undefined: five fields, a real pattern, and at least one future slot. */
export function cronProblem(pattern: string, tz: string, fromMs: number): string | undefined {
  const fields = pattern.trim().split(/\s+/)
  if (fields.length !== 5) return `must have five fields (minute, hour, day of month, month, day of week), not ${fields.length}`
  try {
    if (cron(pattern, tz).nextRun(new Date(fromMs)) == null) return "never fires"
  } catch (error) {
    return `is not a cron expression (${error instanceof Error ? error.message : String(error)})`
  }
  return undefined
}

/**
 * The first slot after `afterMs`, or null when there is none: never early, possibly late. A `every` schedule is
 * anchored to its anchor, and a `at` schedule has exactly one slot.
 */
export function nextRun(schedule: JobSchedule, afterMs: number): number | null {
  if (schedule.kind === "at") return schedule.atMs > afterMs ? schedule.atMs : null
  if (schedule.kind === "every") {
    const { everyMs, anchorMs } = schedule
    if (afterMs < anchorMs) return anchorMs
    return anchorMs + (Math.floor((afterMs - anchorMs) / everyMs) + 1) * everyMs
  }
  try {
    const next = cron(schedule.cron, schedule.tz).nextRun(new Date(afterMs))
    return next == null ? null : next.getTime()
  } catch (error) {
    throw jobsError(
      "JOBS_INVALID_SCHEDULE",
      `The cron expression ${JSON.stringify(schedule.cron)} is not valid in ${schedule.tz}.`,
      `Use a five-field cron expression and an IANA time zone, then save the job again.`,
    )
  }
}

/** Every slot after `afterMs` up to and including `untilMs`, oldest first, at most `limit`. */
export function slotsBetween(schedule: JobSchedule, afterMs: number, untilMs: number, limit = 100): number[] {
  const slots: number[] = []
  let after = afterMs
  while (slots.length < limit) {
    const slot = nextRun(schedule, after)
    if (slot === null || slot > untilMs) break
    slots.push(slot)
    after = slot
  }
  return slots
}
