/**
 * Adoption: what a new leader does with the records an old one left in flight.
 *
 * A hot reload keeps running sessions alive (F7), so a record left `running` usually has a session that is still working.
 * Adoption re-attaches `wait` for the rest of the job's timeout, then finalises the record from `get().outcome`, which is
 * the source of truth (F5). A record whose session is gone is `interrupted`, and so is a `queued` record that never
 * started.
 *
 * Finalising exactly once is a check-then-write: the record is read again immediately before the write, and a record
 * that is no longer open is left alone. The old instance cooperates by writing nothing once it has stopped leading
 * (`execute.ts`), so the two leaders cannot both close the same record.
 */
import type { Clock } from "./clock.js"
import { DEFAULTS, type Job } from "./model.js"
import { getRun, putRun, scanRuns, type RunOutcome, type RunRecord, type RunStatus, type Storage } from "./store.js"
import { isTerminal, summaryOf, type Session } from "./execute.js"
import { rememberJobSession } from "./safety.js"

/** How long adoption waits for a busy run before its own interrupt, when the remaining timeout is spent. */
const MIN_WAIT = 1_000

export interface AdoptInput {
  readonly storage: Storage
  readonly session: Session
  readonly clock: Clock
  /** False once this instance stops leading: adoption stops with it and the next leader takes over. */
  readonly active: () => boolean
  /** The jobs as this leader sees them, for their timeouts; a record whose job is gone gets the default timeout. */
  readonly jobs: readonly Job[]
  readonly signal?: AbortSignal
}

export interface Adopted {
  /** The records this pass closed. */
  readonly finalised: readonly RunRecord[]
  /** The busy sessions it re-attached to before closing them. */
  readonly reattached: number
}

const GONE = "The run's session no longer exists, so the run cannot be finished."

interface Verdict {
  readonly status: RunStatus
  readonly summary?: string
  readonly error?: string
}

export async function adopt(input: AdoptInput): Promise<Adopted> {
  const { storage, clock } = input
  const open = (await scanRuns(storage)).filter((record) => record.status === "running" || record.status === "queued")
  const finalised: RunRecord[] = []
  let reattached = 0

  for (const record of open) {
    if (!input.active()) break
    const current = await getRun(storage, record.job, record.slot)
    if (current === undefined || isTerminal(current.status)) continue

    const verdict = await inspect({ ...input, record: current }, () => (reattached += 1))
    if (verdict === undefined) continue

    if (!input.active()) break
    // Read again just before the write: a record someone else has already closed is never closed twice.
    const before = await getRun(storage, current.job, current.slot)
    if (before === undefined || isTerminal(before.status)) continue
    const outcome = outcomeOf(verdict.status)
    finalised.push(
      await putRun(storage, {
        ...before,
        status: verdict.status,
        endedAt: clock.now(),
        ...(outcome === undefined ? {} : { outcome }),
        ...(verdict.summary === undefined ? {} : { summary: verdict.summary }),
        ...(verdict.error === undefined ? {} : { error: verdict.error }),
      }),
    )
  }

  return { finalised, reattached }
}

/** What a record's session says now: finished, still busy (wait for the rest of its timeout), or gone. */
async function inspect(input: AdoptInput & { record: RunRecord }, reattach: () => void): Promise<Verdict | undefined> {
  const { record, session, clock } = input
  if (record.sessionID === undefined) return { status: "interrupted", error: GONE }
  // An adopted run is still one of ours: after a restart the process-wide registry of run sessions is empty, so the
  // session is registered here, before its turn is continued, and the evaluate hook covers it for the rest.
  rememberJobSession(record.sessionID)
  const info = await session.get({ sessionID: record.sessionID }).catch(() => undefined)
  if (info === undefined) return { status: "interrupted", error: GONE }

  if (info.outcome === undefined) {
    reattach()
    const spent = record.startedAt === undefined ? 0 : clock.now() - record.startedAt
    const remaining = Math.max(MIN_WAIT, timeoutOf(input) - spent)
    const wait = session.wait({ sessionID: record.sessionID }).then(
      () => "done" as const,
      () => "done" as const,
    )
    const race = await Promise.race([wait, clock.sleep(remaining, input.signal).then(() => "timeout" as const)])
    if (race === "timeout" && input.signal?.aborted !== true) await session.interrupt({ sessionID: record.sessionID }).catch(() => undefined)
  }

  const after = await session.get({ sessionID: record.sessionID }).catch(() => undefined)
  if (after === undefined) return { status: "interrupted", error: GONE }
  const status: RunStatus = after.outcome === "succeeded" ? "succeeded" : after.outcome === "failed" ? "failed" : "interrupted"
  return { status, summary: await summaryOf(session, record.sessionID) }
}

const timeoutOf = (input: AdoptInput & { record: RunRecord }) =>
  input.jobs.find((job) => job.id === input.record.job)?.policy.timeoutMs ?? DEFAULTS.timeoutMs

/** The record's `outcome` is the host's word for the same three states. */
const outcomeOf = (status: RunStatus): RunOutcome | undefined =>
  status === "succeeded" || status === "failed" || status === "interrupted" ? status : undefined
