/**
 * The scheduling loop. It runs only in the leader, and it is the only thing that starts runs.
 *
 * Every pass reads the jobs and their state from storage, works out each job's due slots from its own `nextDueAt`, and
 * sleeps until the earliest of them, capped at 30 seconds, so a clock jump or a changed job is noticed quickly. Any
 * change rings a doorbell that cuts the sleep short. The clock is injected, so the whole loop is a unit test.
 *
 * A slot is advanced in storage *before* its run starts: a crash between the two loses a slot instead of replaying it,
 * and the run record is the second guard against a replay (`execute.ts`). Catch-up, overlap and ends are the pure
 * decisions of `policy.ts`; this file only applies them.
 */
import type { Clock } from "./clock.js"
import { doorbell } from "./clock.js"
import { nextRun, slotsBetween } from "./cron.js"
import type { Executor, RunHandle } from "./execute.js"
import type { Job } from "./model.js"
import { catchUp, isLate, overlapOf, retryAfter, shouldPause, startAt, stopReason } from "./policy.js"
import { putRun, putRunner, readPauseAll, readState, slotISO, updateState, type JobState, type RunStatus, type Storage } from "./store.js"

/** The longest the loop sleeps: a clock jump, a changed job or a new file is noticed within this. */
export const SLEEP_CAP = 30_000
/** How many due slots one pass considers for a job; the rest collapse into the same `missed` record. */
export const MAX_SLOTS = 100

export interface RunnerInput {
  readonly storage: Storage
  readonly clock: Clock
  /** Every job this leader knows: the store's tool jobs plus the job files of its location. */
  readonly jobs: () => Promise<readonly Job[]>
  readonly execute: Executor
  /** False once this instance stops leading. Nothing new starts, and no record is written by a stale run. */
  readonly active: () => boolean
  /** The global cap on runs that are in flight at once (the `concurrency` option, two by default). */
  readonly concurrency: number
  /** Where this leader runs; it is written in the `runner` record for the status row. */
  readonly location: string
  /** Called after a state change, so a surface can refresh without polling. */
  readonly onChange?: () => void
  /** Retention and its sessions, run on start and (throttled by the caller) once a pass. */
  readonly maintain?: (now: number) => Promise<void>
}

export interface Tick {
  /** How many runs this pass started. */
  readonly started: number
  /** The earliest slot a job is waiting for, or null when there is nothing to wake for. */
  readonly nextDueAt: number | null
}

interface Tracked {
  readonly slot: number
  sessionID?: string
  interrupt: () => Promise<void>
  /** True once the kill switch or a `replace` has interrupted this run, so it is asked only once. */
  halted?: boolean
  promise?: Promise<void>
}

export class Runner {
  readonly concurrency: number
  private readonly input: RunnerInput
  private readonly clock: Clock
  private readonly storage: Storage
  private readonly door: ReturnType<typeof doorbell>
  private readonly runs = new Map<string, Set<Tracked>>()
  private inflight = 0
  private looping = false
  private ticking = false

  constructor(input: RunnerInput) {
    this.input = input
    this.clock = input.clock
    this.storage = input.storage
    this.concurrency = Math.max(1, Math.floor(input.concurrency))
    this.door = doorbell(input.clock)
  }

  /** Runs that are in flight now, across every job. */
  get running(): number {
    return this.inflight
  }

  /** Starts the loop. It runs until `stop`. */
  start(): void {
    if (this.looping) return
    this.looping = true
    void this.run()
  }

  /** Wakes the loop now: a job changed, a run finished, or the leader wants a tick at once. */
  wake(): void {
    this.door.ring()
  }

  /** Stops starting anything new. In-flight runs keep their sessions; they write nothing once `active` is false. */
  stop(): void {
    this.looping = false
    this.wake()
  }

  /** Waits for every in-flight run to finish, so a test can read the settled state. */
  async settle(): Promise<void> {
    while (this.inflight > 0) {
      const promises = [...this.runs.values()].flatMap((set) => [...set].map((handle) => handle.promise))
      await Promise.allSettled(promises.filter((promise): promise is Promise<void> => promise !== undefined))
    }
  }

  /**
   * One pass: work out every job's due slots and start what the policies allow. It never waits for a run, so a test can
   * tick once and a loop can tick itself.
   */
  async tick(now: number): Promise<Tick> {
    if (!this.input.active() || this.ticking) return { started: 0, nextDueAt: null }
    this.ticking = true
    try {
      return await this.pass(now)
    } finally {
      this.ticking = false
    }
  }

  /** One pass, which `tick` runs once at a time: two passes would see the same slot as due. */
  private async pass(now: number): Promise<Tick> {
    if (!this.input.active()) return { started: 0, nextDueAt: null }
    // The kill switch: nothing starts, and what is in flight is interrupted now. The schedule does not move, so
    // clearing the pause resumes it with the usual catch-up for the slots that fell due meanwhile.
    const paused = await readPauseAll(this.storage).catch(() => undefined)
    if (paused !== undefined) {
      await this.halt()
      return { started: 0, nextDueAt: null }
    }
    let jobs: readonly Job[]
    try {
      jobs = await this.input.jobs()
    } catch {
      return { started: 0, nextDueAt: null }
    }

    let next: number | null = null
    let started = 0
    const consider = (at: number | undefined) => {
      if (at === undefined || !Number.isFinite(at)) return
      next = next === null ? at : Math.min(next, at)
    }

    for (const job of jobs) {
      if (!this.input.active()) break
      let state = await readState(this.storage, job.id)
      if (state.done === true || state.paused !== undefined) continue

      // A `queue-one` slot is remembered while its job runs, so it is picked up before anything newer. The schedule's
      // position does not move back: the slots after it were decided while it waited, one skip each.
      const queued = state.queuedSlot
      if (queued !== undefined && queued <= now && this.inflightFor(job.id) === 0) {
        if ((await this.decide(job, queued, state, now)) === "run") {
          state = await this.writeState(job.id, (current) => ({ ...current, queuedSlot: undefined }))
          this.launch(job, queued, now, 1)
          started += 1
        }
      }

      // A manual run from `jobs_run_now`: its own slot, launched once, with the schedule left exactly as it was (DR-3).
      const manual = state.manual
      if (manual !== undefined && manual.at <= now && this.inflightFor(job.id) === 0) {
        state = await this.writeState(job.id, (current) => ({ ...current, manual: undefined }))
        this.launch(job, manual.at, now, 1)
        started += 1
      }

      // A failed run's retry, for the same slot, once its backoff has passed (JR-1). The slot record says which attempt
      // it is, so a retry can never be confused with the first run.
      const retry = state.retry
      if (retry !== undefined && retry.at <= now && this.inflightFor(job.id) === 0) {
        state = await this.writeState(job.id, (current) => ({ ...current, retry: undefined }))
        this.launch(job, retry.slot, now, retry.attempt)
        started += 1
      }

      if (state.nextDueAt === undefined) {
        const first = nextRun(job.schedule, now)
        if (first === null) {
          await this.finishJob(state)
          continue
        }
        state = await this.writeState(job.id, (current) => ({ ...current, nextDueAt: first }))
      }

      const stop = stopReason(job, state, now)
      if (stop !== null) {
        if (state.nextDueAt !== undefined && state.nextDueAt <= now) await this.recordSkipped(job, state.nextDueAt, stop, now)
        await this.finishJob(state)
        continue
      }

      const due = state.nextDueAt
      if (due === undefined) continue
      if (due > now) {
        consider(due)
        continue
      }

      // The slots this pass handles: the oldest unhandled one up to now, at most MAX_SLOTS. Catch-up keeps at most one
      // and collapses the rest of *this pass* into one record; a gap longer than MAX_SLOTS takes another pass, and
      // therefore another record.
      const slots = slotsBetween(job.schedule, due - 1, now, MAX_SLOTS)
      if (slots.length === 0) {
        consider(due)
        continue
      }
      const plan = catchUp(job, slots, now)
      if (plan.gap !== null) await this.recordMissed(job, plan.gap)

      if (plan.run === null) {
        state = await this.advance(job, slots[slots.length - 1]!)
        consider(state.nextDueAt)
      } else if (startAt(job, plan.run) > now) {
        // Jitter delays the start but never moves the slot.
        consider(startAt(job, plan.run))
      } else {
        const decision = await this.decide(job, plan.run, state, now)
        if (decision !== "full") {
          state = await this.advance(job, plan.run, decision === "queue" ? { queuedSlot: plan.run } : {})
          consider(state.nextDueAt)
          if (decision === "run") {
            this.launch(job, plan.run, now)
            started += 1
          }
        }
      }

    }
    return { started, nextDueAt: next }
  }

  /** Interrupts every run in flight, once each: the kill switch. A run whose session has not opened yet is caught as
   * soon as it opens, so a pause the moment a slot starts still stops that slot. */
  private async halt(): Promise<void> {
    for (const tracked of this.runs.values()) {
      for (const handle of tracked) {
        if (handle.halted === true) continue
        handle.halted = true
        if (handle.sessionID !== undefined) await handle.interrupt()
      }
    }
  }

  /**
   * What a due slot may do: run, be skipped, be remembered once, or wait for capacity. The overlap policies are the
   * table of DESIGN §6.4; `replace` interrupts the run in its way before the new one starts.
   */
  private async decide(job: Job, slot: number, state: JobState, now: number): Promise<"run" | "skip" | "queue" | "full"> {
    const running = [...(this.runs.get(job.id) ?? [])]
    let replacing = false
    if (running.length > 0) {
      const action = overlapOf(job, { slot: running[0]!.slot })
      if (action === "skip") {
        await this.recordSkipped(job, slot, "overlap", now)
        return "skip"
      }
      if (action === "queue") {
        // The caller writes the remembered slot together with the advanced schedule, so neither write loses the other.
        if (state.queuedSlot !== undefined) {
          await this.recordSkipped(job, slot, "overlap", now)
          return "skip"
        }
        return "queue"
      }
      if (action === "replace") {
        replacing = true
        for (const handle of running) {
          handle.halted = true
          await handle.interrupt()
        }
      }
    }
    // `replace` frees the slot it takes, so it may start even when the cap is reached.
    if (!replacing && this.inflight >= this.concurrency) return "full"
    return "run"
  }

  /** Starts one run in the background and tracks it until it finishes. `attempt` is 1, or a retry's count. */
  private launch(job: Job, slot: number, now: number, attempt = 1): void {
    const handle: Tracked = { slot, interrupt: async () => undefined }
    const tracked = this.runs.get(job.id) ?? new Set<Tracked>()
    tracked.add(handle)
    this.runs.set(job.id, tracked)
    this.inflight += 1

    handle.promise = this.input
      .execute({
        job,
        slot,
        attempt,
        late: isLate(slot, now),
        active: this.input.active,
        onSession: (session: RunHandle) => {
          handle.sessionID = session.sessionID
          handle.interrupt = session.interrupt
          // A pause, or a `replace`, that arrived before the session existed is honoured now.
          if (handle.halted === true) void session.interrupt()
        },
      })
      .then((result) => this.finished(job, slot, result.status, result.claimed, attempt))
      .catch(() => this.finished(job, slot, "failed", true, attempt))
      .finally(() => {
        tracked.delete(handle)
        if (tracked.size === 0) this.runs.delete(job.id)
        this.inflight -= 1
        this.wake()
        this.input.onChange?.()
      })
  }

  /**
   * What a finished run does to the job's state: a count, the failure streak, the pause after five failures, and the
   * retry the policy allows. A timeout counts toward the pause, because a job that cannot finish is spending every slot;
   * an interruption does not, because a `replace` or the kill switch produced it (JR-7).
   */
  private async finished(job: Job, slot: number, status: RunStatus, claimed: boolean, attempt: number): Promise<void> {
    // A slot refused before it ran (an agent that is not guarded) is recorded, but it is not a run: nothing counts.
    if (!claimed || !this.input.active() || status === "skipped") return
    const failed = status === "failed" || status === "timed_out"
    const outcome = status === "failed" || status === "timed_out" || status === "interrupted" ? status : "succeeded"
    const retry = status === "failed" ? retryAfter(job, { attempt, outcome }) : null
    await this.writeState(job.id, (state) => {
      const consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0
      const paused = shouldPause(consecutiveFailures) ? { at: this.clock.now(), reason: "Five runs in a row failed." } : state.paused
      return {
        ...state,
        runCount: state.runCount + 1,
        lastRun: slotISO(slot),
        consecutiveFailures,
        ...(paused === undefined ? {} : { paused }),
        ...(retry === null || paused !== undefined ? { retry: undefined } : { retry: { slot, attempt: retry.attempt, at: this.clock.now() + retry.delayMs } }),
      }
    })
    this.input.onChange?.()
  }

  /** Moves a job past a slot, with a patch such as `queue-one`'s remembered slot, or ends it when no slot is left. */
  private async advance(job: Job, after: number, patch: Partial<JobState> = {}): Promise<JobState> {
    const next = nextRun(job.schedule, after)
    if (next === null) return this.finishJob({ ...patch, job: job.id } as JobState)
    return this.writeState(job.id, (current) => ({ ...current, ...patch, nextDueAt: next }))
  }

  private async finishJob(state: JobState): Promise<JobState> {
    return this.writeState(state.job, (current) => ({ ...current, done: true, nextDueAt: undefined }))
  }

  private async recordSkipped(job: Job, slot: number, reason: "overlap" | "expired" | "ended", now: number): Promise<void> {
    await putRun(this.storage, { job: job.id, slot: slotISO(slot), status: "skipped", reason, late: isLate(slot, now), attempt: 1 })
  }

  /** One collapsed record per gap of missed slots, with a count, the design's `missed` shape (D9). */
  private async recordMissed(job: Job, gap: { from: number; to: number; count: number }): Promise<void> {
    await putRun(this.storage, { job: job.id, slot: slotISO(gap.to), status: "missed", late: true, attempt: 1, count: gap.count, from: slotISO(gap.from) })
  }

  /**
   * Every state change goes through this: the job's own chain, then a fresh read, the change, and one write. Two runs of
   * one job finishing together, or a finish racing a schedule advance, can no longer erase each other's counters or the
   * five-failure pause (JR-3).
   */
  private writeState(job: string, change: (state: JobState) => JobState): Promise<JobState> {
    return updateState(this.storage, job, change)
  }

  private inflightFor(job: string): number {
    return this.runs.get(job)?.size ?? 0
  }

  /** The loop: tick, then sleep until the next slot or the cap, waking early on any change. */
  private async run(): Promise<void> {
    const startedAt = this.clock.now()
    await this.recordRunner({ startedAt })
    await this.input.maintain?.(startedAt).catch(() => undefined)
    while (this.looping && this.input.active()) {
      let result: Tick
      try {
        result = await this.tick(this.clock.now())
      } catch {
        result = { started: 0, nextDueAt: null }
      }
      if (!this.looping || !this.input.active()) break
      await this.input.maintain?.(this.clock.now()).catch(() => undefined)
      // A computed wait of zero with nothing started would spin the loop: a slot due but held by the concurrency cap,
      // or a schedule that cannot produce it. Sleep the cap instead; a finished run rings the doorbell and wakes us.
      const due = result.nextDueAt
      const wait = due === null ? SLEEP_CAP : Math.min(SLEEP_CAP, Math.max(0, due - this.clock.now()))
      await this.door.wait(wait === 0 ? SLEEP_CAP : wait)
    }
    await this.recordRunner({ startedAt, stoppedAt: this.clock.now() })
  }

  private async recordRunner(record: { startedAt: number; stoppedAt?: number }): Promise<void> {
    await putRunner(this.storage, { ...record, location: this.input.location, pid: process.pid }).catch(() => undefined)
  }
}
