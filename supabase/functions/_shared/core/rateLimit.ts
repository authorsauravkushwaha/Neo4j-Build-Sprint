/**
 * Rate limiting and replay protection.
 *
 * The store is an interface, not an in-memory map, because Edge Functions scale
 * horizontally: two requests from the same user can land on different instances.
 * Production uses a Postgres-backed fixed-window counter (atomic upsert, see
 * supabase/migrations/0004_rate_limits.sql). `MemoryFixedWindowStore` exists for
 * tests and for local single-process development, and it is explicitly labelled
 * as *not* suitable for a multi-instance deployment.
 */
import type { NonceStore } from './security.ts'

export interface FixedWindowStore {
  /**
   * Atomically increments the counter for `key` in the current window and
   * returns the new count. Must be safe under concurrency.
   */
  increment(key: string, windowSeconds: number, nowMs: number): Promise<number>
  /** Optional housekeeping; implementations may no-op. */
  cleanup?(nowMs: number): Promise<void>
}

export interface RateLimitPolicy {
  limit: number
  windowSeconds: number
}

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Seconds until the current window resets (used for the Retry-After header). */
  resetSeconds: number
  /** Which policy bucket was consumed, for logs (never contains user input). */
  bucket: string
}

export function windowStartedAt(nowMs: number, windowSeconds: number): number {
  const windowMs = windowSeconds * 1000
  return Math.floor(nowMs / windowMs) * windowMs
}

export function secondsUntilReset(nowMs: number, windowSeconds: number): number {
  const windowMs = windowSeconds * 1000
  const reset = windowStartedAt(nowMs, windowSeconds) + windowMs
  return Math.max(1, Math.ceil((reset - nowMs) / 1000))
}

/**
 * `keyParts` must already be non-identifying (a salted hash of a user id, an
 * IP prefix) — see `bucketKey` below. Nothing raw is stored.
 */
export async function checkRateLimit(
  store: FixedWindowStore,
  bucket: string,
  policy: RateLimitPolicy,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  const key = `${bucket}:${windowStartedAt(nowMs, policy.windowSeconds)}`
  let count: number
  try {
    count = await store.increment(key, policy.windowSeconds, nowMs)
  } catch {
    // Fail-open vs fail-closed: a broken limiter must not take the whole product
    // down, so we allow the request and let per-request cost caps protect us.
    // This is logged by the caller and documented in docs/security.md.
    return {
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit,
      resetSeconds: secondsUntilReset(nowMs, policy.windowSeconds),
      bucket,
    }
  }
  const remaining = Math.max(0, policy.limit - count)
  return {
    allowed: count <= policy.limit,
    limit: policy.limit,
    remaining,
    resetSeconds: secondsUntilReset(nowMs, policy.windowSeconds),
    bucket,
  }
}

/** Stable, non-reversible bucket key. Never contains a raw user id or IP. */
export async function bucketKey(scope: string, identifier: string): Promise<string> {
  const digest = await (globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`graphmentor-rate:${identifier}`),
  ))
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${scope}.${hex}`
}

export class MemoryFixedWindowStore implements FixedWindowStore {
  private counters = new Map<string, number>()

  async increment(key: string, _windowSeconds: number): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    // Bounded memory: drop old windows rather than growing forever.
    if (this.counters.size > 5000) {
      const keep = [...this.counters.entries()].slice(-1000)
      this.counters = new Map(keep)
    }
    return next
  }

  async cleanup(): Promise<void> {
    this.counters.clear()
  }
}

export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>()

  async claim(nonce: string, expiresInMs: number): Promise<boolean> {
    const now = Date.now()
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key)
    }
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, now + expiresInMs)
    return true
  }
}

export const RATE_POLICIES = {
  /** AI calls are the most expensive operation; keep them tight. */
  mentorChatPerMinute: { limit: 6, windowSeconds: 60 },
  mentorChatPerHour: { limit: 30, windowSeconds: 3600 },
  /** Analysis is cheap but still protected against accidental loops in clients. */
  analysisPerMinute: { limit: 20, windowSeconds: 60 },
  /** Generic read endpoints. */
  readPerMinute: { limit: 90, windowSeconds: 60 },
  /** Writes (roadmap save, progress, bookmarks, feedback). */
  writePerMinute: { limit: 30, windowSeconds: 60 },
  /**
   * Sign-in attempts, per address (hashed) and per IP.
   *
   * Password guessing is slow by design, but "slow" only means something if the
   * attempt rate is bounded. 10 per minute per address lets a person with a typo
   * retry several times; the accompanying per-IP ceiling stops one host walking
   * a list of addresses.
   */
  authAttemptPerMinute: { limit: 10, windowSeconds: 60 },
  authAttemptPerHour: { limit: 40, windowSeconds: 3600 },
  authAttemptPerIpPerMinute: { limit: 30, windowSeconds: 60 },
} satisfies Record<string, RateLimitPolicy>


