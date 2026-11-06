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

/** The period's range: the option is in minutes, and a beat is never closer than a minute or further than an hour. */
export const MIN_PERIOD = MINUTE
export const MAX_PERIOD = 60 * MINUTE

/**
 * The period the `keepAliveMinutes` option asks for, in milliseconds (D2). It must stay below the user's
 * `experimental.location_idle_timeout`: the status row says so, and nothing here can read that timeout.
 */
export function keepAlivePeriod(minutes: number): number {
  const wanted = Number.isFinite(minutes) ? Math.round(minutes * MINUTE) : MAX_PERIOD
  return Math.max(MIN_PERIOD, Math.min(MAX_PERIOD, wanted))
}

export interface KeepAliveInput {
  readonly session: Pick<Session, "create" | "remove">
  readonly clock: Clock
  /** The leader's directory: the location the beat touches. */
  readonly location: string
  /** How often to beat, from the `keepAliveMinutes` option. */
  readonly periodMs: number
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
  const periodMs = Math.max(MIN_PERIOD, input.periodMs)
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
