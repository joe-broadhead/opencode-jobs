/**
 * The keep-alive: an empty `session.create` and `session.remove` at the leader's location, so the location never idles
 * out and the runner keeps running (F8, V2: a 2-minute location stayed loaded for 6.5 minutes, 0 model calls).
 *
 * It is the one workaround the design cannot do without, so the period is a third of the effective
 * `experimental.location_idle_timeout`, capped at 20 minutes. Nothing else counted as activity: a title update, an
 * instruction entry, `session.list`, a storage write and an external `GET /api/plugin` all unloaded on schedule.
 *
 * It never prompts, so it costs no model call. Each beat emits `session.created` and `session.deleted`, which every
 * connected client sees; that is the accepted cost of D2.
 */
import type { Clock } from "./clock.js"
import type { Session } from "./execute.js"
import { MINUTE } from "./model.js"

/** The longest period, so a default 60-minute location is touched three times before it could unload. */
export const KEEPALIVE_CAP = 20 * MINUTE

/** The period for an effective idle timeout: a third of it, at least a minute, at most 20 minutes. */
export function keepAlivePeriod(idleTimeoutMs?: number | null): number {
  if (idleTimeoutMs === undefined || idleTimeoutMs === null || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return KEEPALIVE_CAP
  return Math.max(MINUTE, Math.min(KEEPALIVE_CAP, Math.floor(idleTimeoutMs / 3)))
}

export interface KeepAliveInput {
  readonly session: Pick<Session, "create" | "remove">
  readonly clock: Clock
  /** The leader's directory: the location the beat touches. */
  readonly location: string
  /** The effective idle timeout, when it is known; otherwise the 20-minute cap. */
  readonly idleTimeoutMs?: number | null
  /** False once this instance stops leading. */
  readonly active: () => boolean
  readonly onBeat?: (at: number, ok: boolean) => void
}

export interface KeepAlive {
  start(): void
  stop(): void
  /** One beat now: create an empty session and remove it at once. */
  beat(): Promise<boolean>
  readonly periodMs: number
  readonly beats: number
  readonly lastBeatAt?: number
}

export function startKeepAlive(input: KeepAliveInput): KeepAlive {
  const periodMs = keepAlivePeriod(input.idleTimeoutMs)
  let looping = true
  let beats = 0
  let lastBeatAt: number | undefined
  const stop = new AbortController()

  const beat = async (): Promise<boolean> => {
    try {
      const created = await input.session.create({
        location: { directory: input.location },
        metadata: { jobs: { keepalive: true } },
      })
      await input.session.remove({ sessionID: created.id })
      beats += 1
      lastBeatAt = input.clock.now()
      input.onBeat?.(lastBeatAt, true)
      return true
    } catch {
      input.onBeat?.(input.clock.now(), false)
      return false
    }
  }

  const loop = async () => {
    while (looping && input.active()) {
      await input.clock.sleep(periodMs, stop.signal)
      if (!looping || !input.active()) break
      await beat()
    }
  }

  return {
    start: () => {
      if (looping) void loop()
    },
    stop: () => {
      looping = false
      stop.abort()
    },
    beat,
    periodMs,
    get beats() {
      return beats
    },
    get lastBeatAt() {
      return lastBeatAt
    },
  }
}
