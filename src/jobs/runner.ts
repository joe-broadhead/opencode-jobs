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
import { catchUp, isLate, overlapOf, shouldPause, startAt, stopReason } from "./policy.js"
import { putRun, putRunner, readPauseAll, readState, slotISO, type JobState, type RunStatus, type Storage } from "./store.js"

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
          state = { ...state, queuedSlot: undefined }
          await this.write(state)
          this.launch(job, queued, now)
          started += 1
        }
      }

      if (state.nextDueAt === undefined) {
        const first = nextRun(job.schedule, now)
        if (first === null) {
          await this.finishJob(state)
          continue
        }
        state = { ...state, nextDueAt: first }
        await this.write(state)
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

      // The slots this pass handles: the oldest unhandled one up to now. Catch-up keeps at most one and collapses the rest.
      const slots = slotsBetween(job.schedule, due - 1, now, MAX_SLOTS)
      if (slots.length === 0) {
        consider(due)
        continue
      }
      const plan = catchUp(job, slots, now)
      if (plan.gap !== null) await this.recordMissed(job, plan.gap)

      if (plan.run === null) {
        state = await this.advance(job, state, slots[slots.length - 1]!)
        consider(state.nextDueAt)
      } else if (startAt(job, plan.run) > now) {
        // Jitter delays the start but never moves the slot.
        consider(startAt(job, plan.run))
      } else {
        const decision = await this.decide(job, plan.run, state, now)
        if (decision !== "full") {
          state = await this.advance(job, decision === "queue" ? { ...state, queuedSlot: plan.run } : state, plan.run)
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

  /** Starts one run in the background and tracks it until it finishes. */
  private launch(job: Job, slot: number, now: number): void {
    const handle: Tracked = { slot, interrupt: async () => undefined }
    const tracked = this.runs.get(job.id) ?? new Set<Tracked>()
    tracked.add(handle)
    this.runs.set(job.id, tracked)
    this.inflight += 1

    handle.promise = this.input
      .execute({
        job,
        slot,
        attempt: 1,
        late: isLate(slot, now),
        active: this.input.active,
        onSession: (session: RunHandle) => {
          handle.sessionID = session.sessionID
          handle.interrupt = session.interrupt
          // A pause, or a `replace`, that arrived before the session existed is honoured now.
          if (handle.halted === true) void session.interrupt()
        },
      })
      .then((result) => this.finished(job, slot, result.status, result.claimed))
      .catch(() => this.finished(job, slot, "failed", true))
      .finally(() => {
        tracked.delete(handle)
        if (tracked.size === 0) this.runs.delete(job.id)
        this.inflight -= 1
        this.wake()
        this.input.onChange?.()
      })
  }

  /** What a finished run does to the job's state: a count, the failure streak, and the pause after five failures. */
  private async finished(job: Job, slot: number, status: RunStatus, claimed: boolean): Promise<void> {
    // A slot refused before it ran (an agent that is not guarded) is recorded, but it is not a run: nothing counts.
    if (!claimed || !this.input.active() || status === "skipped") return
    const state = await readState(this.storage, job.id)
    const failed = status === "failed"
    const consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0
    const paused = shouldPause(consecutiveFailures) ? { at: this.clock.now(), reason: "Five runs in a row failed." } : state.paused
    await this.write({
      ...state,
      runCount: state.runCount + 1,
      lastRun: slotISO(slot),
      consecutiveFailures,
      ...(paused === undefined ? {} : { paused }),
    })
    this.input.onChange?.()
  }

  /** Moves a job past a slot, or ends it when the schedule has no slot left. */
  private async advance(job: Job, state: JobState, after: number): Promise<JobState> {
    const next = nextRun(job.schedule, after)
    if (next === null) return this.finishJob(state)
    const updated: JobState = { ...state, nextDueAt: next }
    await this.write(updated)
    return updated
  }

  private async finishJob(state: JobState): Promise<JobState> {
    const updated: JobState = { ...state, done: true, nextDueAt: undefined }
    await this.write(updated)
    return updated
  }

  private async recordSkipped(job: Job, slot: number, reason: "overlap" | "paused" | "expired" | "ended", now: number): Promise<void> {
    await putRun(this.storage, { job: job.id, slot: slotISO(slot), status: "skipped", reason, late: isLate(slot, now), attempt: 1 })
  }

  /** One collapsed record per gap of missed slots, with a count, the design's `missed` shape (D9). */
  private async recordMissed(job: Job, gap: { from: number; to: number; count: number }): Promise<void> {
    await putRun(this.storage, { job: job.id, slot: slotISO(gap.to), status: "missed", late: true, attempt: 1, count: gap.count, from: slotISO(gap.from) })
  }

  private async write(state: JobState): Promise<void> {
    await this.storage.set(`state/${state.job}`, state as unknown as Parameters<Storage["set"]>[1])
  }

  private inflightFor(job: string): number {
    return this.runs.get(job)?.size ?? 0
  }

  /** The loop: tick, then sleep until the next slot or the cap, waking early on any change. */
  private async run(): Promise<void> {
    const startedAt = this.clock.now()
    await this.recordRunner({ startedAt })
    while (this.looping && this.input.active()) {
      let result: Tick
      try {
        result = await this.tick(this.clock.now())
      } catch {
        result = { started: 0, nextDueAt: null }
      }
      if (!this.looping || !this.input.active()) break
      const wait = result.nextDueAt === null ? SLEEP_CAP : Math.min(SLEEP_CAP, Math.max(0, result.nextDueAt - this.clock.now()))
      await this.door.wait(wait)
    }
    await this.recordRunner({ startedAt, stoppedAt: this.clock.now() })
  }

  private async recordRunner(record: { startedAt: number; stoppedAt?: number }): Promise<void> {
    await putRunner(this.storage, { ...record, location: this.input.location, pid: process.pid }).catch(() => undefined)
  }
}
