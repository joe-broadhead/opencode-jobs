/**
 * Leader election: one runner per server process, and one process per data directory.
 *
 * Inside a process the claim is a synchronous check-and-set on
 * `globalThis[Symbol.for("@joe-broadhead/opencode-jobs")]`, so two instances starting in the same turn cannot both win
 * (F2, V4: 0 rounds with two winners in 50). Module-level state is per location, so nothing about the leader is kept in
 * a module variable. The entry survives a hot reload, so `release` clears it and hands over to the first live follower;
 * a follower that finds an owner which has been disposed does not trust it.
 *
 * Across processes the guard is the `lease/leader` record in `ctx.storage`: a token, a 60-second time to live and a
 * 20-second heartbeat. Storage has no compare-and-set, so a claim writes, waits for the write to be visible (V4 measured
 * at most 13 ms), reads back, and steps down when another token won. A step down is not a failure: the instance keeps
 * the in-process lock and tries the lease again while the in-process lock is its own.
 */
import { randomBytes } from "node:crypto"
import type { Clock } from "./clock.js"
import type { Storage } from "./store.js"

export const LEASE_KEY = "lease/leader"
/** A lease with no heartbeat for this long is free to take. */
export const LEASE_TTL = 60_000
/** How often a leader renews its lease. */
export const LEASE_HEARTBEAT = 20_000
/** How long a claim waits before reading its own write back. */
export const LEASE_SETTLE = 25
/** A standby leader reads the lease at this interval; an in-process follower re-checks the global lock this often. */
export const LEASE_RETRY = 5_000
export const FOLLOW_RETRY = 1_000

const GLOBAL_KEY = Symbol.for("@joe-broadhead/opencode-jobs")

/** The cross-process lease, as stored. */
export interface Lease {
  readonly token: string
  readonly pid: number
  readonly location: string
  /** When the holder last renewed, in epoch milliseconds. */
  readonly heartbeatAt: number
}

interface Slot {
  owner: Leader | null
  followers: Leader[]
}

const disposedOf = (leader: Leader) => (leader as unknown as { disposed?: boolean }).disposed === true

/** The one registry on `globalThis`; another plugin's value under our symbol is replaced, not trusted. */
function registry(): Slot {
  const holder = globalThis as unknown as Record<symbol, unknown>
  const value = holder[GLOBAL_KEY]
  if (typeof value === "object" && value !== null && Array.isArray((value as { followers?: unknown }).followers)) return value as Slot
  const created: Slot = { owner: null, followers: [] }
  holder[GLOBAL_KEY] = created
  return created
}

export interface LeaderInput {
  readonly storage: Storage
  readonly clock: Clock
  /** The directory this instance leads from; it is what status reports and what the keep-alive touches. */
  readonly location: string
  /** Called once per acquisition, after the lease is ours. */
  readonly onLead: () => void | Promise<void>
  /** Called when the lease is lost or released, so the runner stops before another process takes over. */
  readonly onStepDown: () => void | Promise<void>
  /** For tests: a fixed token instead of a random one. */
  readonly token?: string
  readonly pid?: number
}

export class Leader {
  readonly token: string
  readonly pid: number
  /** True once `release` has run; a disposed owner is never trusted by another instance. */
  disposed = false

  private readonly storage: Storage
  private readonly clock: Clock
  /** The directory this instance leads from: status reports it, and the keep-alive touches it. */
  readonly location: string
  private readonly onLead: () => void | Promise<void>
  private readonly onStepDown: () => void | Promise<void>
  private leading = false
  private leased = false
  private announced = false
  private stop = new AbortController()
  private loop: Promise<void> | undefined

  constructor(input: LeaderInput) {
    this.storage = input.storage
    this.clock = input.clock
    this.location = input.location
    this.onLead = input.onLead
    this.onStepDown = input.onStepDown
    this.token = input.token ?? `${process.pid}-${randomBytes(8).toString("hex")}`
    this.pid = input.pid ?? process.pid
  }

  /** True when this instance holds both the in-process lock and a live lease: the only state in which it runs jobs. */
  get isLeader(): boolean {
    return this.leading && this.leased && !this.disposed
  }

  /**
   * Takes the in-process lock if it is free. It is synchronous, so two instances cannot both read a free entry and
   * write themselves into it within one process. A disposed owner has released nothing and must not be trusted.
   */
  claim(): boolean {
    const slot = registry()
    if (slot.owner === this) {
      this.leading = true
      return true
    }
    if (slot.owner === null || disposedOf(slot.owner)) {
      slot.owner = this
      const index = slot.followers.indexOf(this)
      if (index !== -1) slot.followers.splice(index, 1)
      this.leading = true
      return true
    }
    if (!slot.followers.includes(this)) slot.followers.push(this)
    this.leading = false
    return false
  }

  /** Starts the election loop. It runs until `release`; the returned promise is only for tests that await a settle. */
  start(): void {
    if (this.loop !== undefined) return
    this.loop = this.run()
  }

  /** Wakes the loop now, so a hand-over or a fresh start does not wait for the retry interval. */
  kick(): void {
    const previous = this.stop
    this.stop = new AbortController()
    previous.abort()
  }

  /**
   * `cleanup`: stop the loop, release the lease while it is still ours, free the in-process lock and hand it to the
   * first live follower. Releasing only when the stored token is ours leaves another process's lease alone.
   */
  async release(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.kick()
    if (this.leased) {
      this.leased = false
      const current = await this.readLease()
      if (current?.token === this.token) await this.storage.remove(LEASE_KEY)
    }
    const slot = registry()
    if (slot.owner === this) {
      slot.owner = null
      const next = slot.followers.find((follower) => !disposedOf(follower))
      if (next !== undefined) next.kick()
    } else {
      const index = slot.followers.indexOf(this)
      if (index !== -1) slot.followers.splice(index, 1)
    }
    this.leading = false
    if (this.announced) {
      this.announced = false
      await this.onStepDown()
    }
  }

  /** The loop: claim, lease, then heartbeat until the lease is lost or the instance is disposed. */
  private async run(): Promise<void> {
    while (!this.disposed) {
      try {
        if (!this.leading) this.claim()
        if (!this.leading) {
          await this.sleep(FOLLOW_RETRY)
          continue
        }
        if (!this.leased) {
          this.leased = await this.acquire(this.clock.now())
          if (!this.leased) {
            await this.sleep(LEASE_RETRY)
            continue
          }
          await this.becomeLeader()
        }
        await this.sleep(LEASE_HEARTBEAT)
        if (this.disposed || !this.leased) continue
        if (!(await this.acquire(this.clock.now()))) {
          this.leased = false
          await this.becomeFollower()
        }
      } catch {
        // The loop is the one thing that must not die: a storage or session failure is retried on the next pass.
        await this.sleep(LEASE_RETRY)
      }
    }
  }

  /** Writes our lease, waits for the write to be visible and reads it back; a different token means we step down. */
  private async acquire(now: number): Promise<boolean> {
    const current = await this.readLease()
    if (current !== undefined && current.token !== this.token && now < current.heartbeatAt + LEASE_TTL) return false
    await this.writeLease(now)
    await this.clock.sleep(LEASE_SETTLE, this.stop.signal)
    const back = await this.readLease()
    return back?.token === this.token
  }

  private async becomeLeader(): Promise<void> {
    if (this.announced) return
    this.announced = true
    await this.onLead()
  }

  private async becomeFollower(): Promise<void> {
    if (!this.announced) return
    this.announced = false
    await this.onStepDown()
  }

  private async readLease(): Promise<Lease | undefined> {
    const value = await this.storage.get(LEASE_KEY)
    if (typeof value !== "object" || value === null) return undefined
    const lease = value as Partial<Lease>
    if (typeof lease.token !== "string" || typeof lease.heartbeatAt !== "number") return undefined
    return { token: lease.token, pid: typeof lease.pid === "number" ? lease.pid : 0, location: typeof lease.location === "string" ? lease.location : "", heartbeatAt: lease.heartbeatAt }
  }

  private async writeLease(now: number): Promise<void> {
    const lease: Lease = { token: this.token, pid: this.pid, location: this.location, heartbeatAt: now }
    await this.storage.set(LEASE_KEY, lease as unknown as Parameters<Storage["set"]>[1])
  }

  private sleep(ms: number): Promise<void> {
    return this.clock.sleep(ms, this.stop.signal)
  }
}
