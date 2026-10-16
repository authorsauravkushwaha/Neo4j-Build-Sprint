/**
 * Rate limiting and replay protection.
 *
 * The store is an interface, not an in-memory map, because Edge Functions scale
 * horizontally: two requests from the same user can land on different instances.
 * Production uses a Postgres-backed fixed-window counter (atomic upsert, see
 * supabase/migrations/002_graphmentor_rate_limit.sql). `MemoryFixedWindowStore` exists for
 * tests and for local single-process development, and it is explicitly labelled
 * as *not* suitable for a multi-instance deployment.
 */
import { hmacSha256Hex, sha256Hex, type NonceStore } from './security.ts'
import { AppError } from './errors.ts'

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
  options: { failOpen?: boolean } = {},
): Promise<RateLimitResult> {
  const key = `${bucket}:${windowStartedAt(nowMs, policy.windowSeconds)}`
  let count: number
  try {
    count = await store.increment(key, policy.windowSeconds, nowMs)
  } catch {
    // Expensive reads/writes must not lose their budget during a store outage.
    // Only the advisory Supabase preflight opts out; Supabase Auth is its own
    // enforcement boundary and can be called without that preflight anyway.
    if (!options.failOpen) throw new AppError('dependency_unavailable', {
      publicMessage: 'Request limits are temporarily unavailable. Please retry later.',
    })
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

/**
 * Stable bucket key for `scope`, derived from `identifier`.
 *
 * **Keyed by `pepper` when one is supplied, and only then irreversible.**
 *
 * This used to be `sha256("graphmentor-rate:" + identifier)` with no secret. The
 * comment above it claimed the result was "non-reversible", and migration 002
 * claimed the counter table held "no personal data". Neither held: the salt is a
 * string literal in a public repository, `auth.host` buckets are keyed on IPv4
 * addresses (2^32 candidates — a full offline sweep is minutes), and `auth.addr`
 * buckets are keyed on an unkeyed digest of an email address, which falls to the
 * same wordlist attack as any leaked hash. Anyone who could read
 * `public.gm_rate_limit` could recover which addresses attempted sign-in and
 * when, from a table documented as containing nothing of the kind.
 *
 * With `pepper` the derivation is an HMAC under a secret that never leaves the
 * Edge Function environment, so the stored key is only reversible by a holder of
 * that secret — which is the property the comments were already asserting.
 *
 * The unpeppered path is kept deliberately: counters must not stop limiting
 * while an operator rolls the secret out, and a deployment that loses its pepper
 * must not silently reset every budget. It is reported through
 * `BUCKET_KEY_UNPEPPERED` so `health-check` can say out loud that the privacy
 * property is not in force, rather than implying it is.
 */
export async function bucketKey(scope: string, identifier: string, pepper?: string | null): Promise<string> {
  const message = `graphmentor-rate:${identifier}`
  // 8 bytes / 16 hex chars: enough to avoid collisions across the bucket
  // population, short enough to keep the primary key of gm_rate_limit small.
  const hex = pepper ? (await hmacSha256Hex(pepper, message)).slice(0, 16) : (await sha256Hex(message)).slice(0, 16)
  return `${scope}.${hex}`
}

/** Operator-facing note for a deployment running without `RATE_LIMIT_PEPPER`. */
export const BUCKET_KEY_UNPEPPERED =
  'RATE_LIMIT_PEPPER is not set, so rate-limit keys are derived with a constant that is public in this repository. ' +
  'They are stable and they limit correctly, but anyone who can read the counter table can recover the addresses and ' +
  'IPs behind them. Set RATE_LIMIT_PEPPER (openssl rand -hex 32) as an Edge Function secret to make them irreversible.'

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


