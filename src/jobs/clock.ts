/**
 * The clock the runner, the executor, the lease and the keep-alive read. It is injectable so that every timing rule
 * below the pack layer is a deterministic test: nothing in `src/jobs` calls `Date.now` or sets a timer directly except
 * through a clock.
 */
export interface Clock {
  /** The current instant, in epoch milliseconds. */
  now(): number
  /** Resolves after `ms`, or as soon as `signal` aborts. It never rejects, and a negative delay is zero. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve()
        return
      }
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, ms))
      signal?.addEventListener("abort", done, { once: true })
    }),
}

/**
 * A doorbell that wakes a sleeping loop early. `ring` resolves every waiting `wait` and starts afresh, so a change that
 * arrives between two sleeps is not lost: the loop re-reads the store on its next pass anyway, and the wait after the
 * change is the 30-second cap at most.
 */
export function doorbell(clock: Clock) {
  let controller = new AbortController()
  return {
    /** Resolves on the delay or on the next `ring`, whichever comes first. */
    wait: (ms: number) => clock.sleep(ms, controller.signal),
    ring: () => {
      const previous = controller
      controller = new AbortController()
      previous.abort()
    },
  }
}
