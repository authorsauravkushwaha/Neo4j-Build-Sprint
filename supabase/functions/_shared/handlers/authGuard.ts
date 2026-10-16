/**
 * POST /auth-guard — a pre-flight gate for sign-in attempts.
 *
 * Why this exists: password sign-in happens directly between the browser and
 * Supabase Auth, so our Edge Functions never see the attempt. That leaves the
 * app unable to bound guessing itself. This endpoint gives it a place to: the
 * client asks for a slot before it tries, and the answer is counted per address
 * (hashed, never raw) and per host.
 *
 * Three properties this handler is careful about:
 *
 *   1. **It cannot be used to enumerate accounts.** It never says whether an
 *      address exists — only whether the caller has attempts left. The same
 *      answer is returned for every address.
 *   2. **It stores nothing identifying.** The address arrives as a client-side
 *      SHA-256 prefix and is hashed again with the rate-limit salt before it
 *      becomes a bucket key; the IP is treated the same way by the shared
 *      limiter. Neither the address nor the IP is written anywhere in the clear.
 *   3. **It refuses oversized passwords.** A byte count arrives with the request
 *      (never the password itself), and an attempt past the ceiling is rejected
 *      and counted, so the cheapest way to burn the provider's hashing CPU does
 *      not work — see `PASSWORD_INPUT_CEILING_BYTES`.
 *   4. **It fails open.** If the counter store is unavailable the attempt is
 *      allowed and Supabase Auth's own rate limiting remains the backstop.
 *      Locking every learner out of sign-in because a counter table blinked is a
 *      worse outcome than the attack this defends against, and the trade-off is
 *      recorded in docs/security.md rather than hidden here.
 */
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { json, parseJsonBody } from '../core/http.ts'
import { bucketKey, checkRateLimit } from '../core/rateLimit.ts'
import { PASSWORD_INPUT_CEILING_BYTES } from '../core/security.ts'
import { authGuardBodySchema, parseOrThrow } from '../core/validate.ts'
import type { Runtime } from '../runtime.ts'

export interface AuthGuardResponse {
  allowed: boolean
  /** Attempts remaining in the short window, or null when the store is down. */
  attemptsLeft: number | null
  /** Seconds until the window resets; present only when allowed is false. */
  retryAfterSeconds?: number
  /** Which ceiling stopped it — useful for logs and support, not for attackers. */
  scope?: 'address' | 'host'
}

export async function authGuardHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const body = parseJsonBody(request)
  const input = parseOrThrow(authGuardBodySchema, body)
  const now = runtime.now()

  // 0. Oversized password attempts are refused here, before anything expensive
  //    happens anywhere. The client sends a byte count, never the password; a
  //    caller that skips the UI and posts a megabyte still gets nowhere, and the
  //    attempt is counted like any other so a loop burns its own budget.
  if (typeof input.passwordBytes === 'number' && input.passwordBytes > PASSWORD_INPUT_CEILING_BYTES) {
    const bucket = await bucketKey('auth.addr', input.emailHash)
    await checkRateLimit(runtime.rateLimit, bucket, runtime.config.limits.authAttemptPerMinute, now)
    return json(
      400,
      {
        ok: false,
        error: {
          code: 'validation_failed',
          message: `Passwords longer than ${PASSWORD_INPUT_CEILING_BYTES} bytes are not accepted. A long passphrase in the tens of characters is plenty.`,
        },
      },
      { 'cache-control': 'no-store' },
    )
  }

  // 1. Per-address ceiling. The client already hashed the address; it is hashed
  //    again together with the rate-limit salt so the stored key reveals nothing.
  const addressBucket = await bucketKey('auth.addr', input.emailHash)
  const address = await checkRateLimit(runtime.rateLimit, addressBucket, runtime.config.limits.authAttemptPerMinute, now)
  if (!address.allowed) {
    return json(
      429,
      { ok: true, data: { allowed: false, attemptsLeft: 0, retryAfterSeconds: address.resetSeconds, scope: 'address' } },
      { 'retry-after': String(address.resetSeconds), 'cache-control': 'no-store' },
    )
  }

  // 2. Longer per-address ceiling: a slow trickle still has to run out.
  const hourlyBucket = await bucketKey('auth.addr.hour', input.emailHash)
  const hourly = await checkRateLimit(runtime.rateLimit, hourlyBucket, runtime.config.limits.authAttemptPerHour, now)
  if (!hourly.allowed) {
    return json(
      429,
      { ok: true, data: { allowed: false, attemptsLeft: 0, retryAfterSeconds: hourly.resetSeconds, scope: 'address' } },
      { 'retry-after': String(hourly.resetSeconds), 'cache-control': 'no-store' },
    )
  }

  // 3. Host-level ceiling: one machine must not walk a list of addresses. The
  //    platform adapter supplies the IP; the limiter hashes it before use.
  const hostBucket = await bucketKey('auth.host', `ip:${request.clientIp ?? 'unknown'}`)
  const host = await checkRateLimit(runtime.rateLimit, hostBucket, runtime.config.limits.authAttemptPerIpPerMinute, now)

  if (!host.allowed) {
    return json(
      429,
      { ok: true, data: { allowed: false, attemptsLeft: 0, retryAfterSeconds: host.resetSeconds, scope: 'host' } },
      { 'retry-after': String(host.resetSeconds), 'cache-control': 'no-store' },
    )
  }

  const payload: AuthGuardResponse = {
    allowed: true,
    // The smaller of the two remaining counts, so the UI can warn before the wall.
    attemptsLeft: Math.max(0, Math.min(address.remaining, hourly.remaining)),
  }
  return json(200, { ok: true, data: payload }, { 'cache-control': 'no-store' })
}

/** Exported for the health check and tests: the policy this handler enforces. */
export function authGuardPolicies(runtime: Runtime): {
  perAddress: string
  perAddressHourly: string
  perHost: string
} {
  const limits = runtime.config.limits
  return {
    perAddress: `${limits.authAttemptPerMinute.limit}/${limits.authAttemptPerMinute.windowSeconds}s`,
    perAddressHourly: `${limits.authAttemptPerHour.limit}/${limits.authAttemptPerHour.windowSeconds}s`,
    perHost: `${limits.authAttemptPerIpPerMinute.limit}/${limits.authAttemptPerIpPerMinute.windowSeconds}s`,
  }
}


