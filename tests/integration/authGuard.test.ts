/**
 * Integration tests for POST /auth-guard — the pre-flight sign-in gate.
 *
 * The security properties under test, in the order they matter:
 *   1. an attacker cannot use this endpoint to learn whether an address has an
 *      account (the response is identical for a known and an unknown address);
 *   2. guessing runs out of attempts, per address and per host;
 *   3. it fails open — a broken counter store must not lock every user out,
 *      because that trade-off is what makes the endpoint safe to depend on;
 *   4. the request body is strictly validated, so it is not a smuggling route;
 *   5. nothing identifying ends up in a bucket key or in a response.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { authGuardHandler, authGuardPolicies } from '../../supabase/functions/_shared/handlers/authGuard.ts'
import type { HttpResponse } from '@core/http.ts'
import { toErrorResponse } from '@core/http.ts'
import type { FixedWindowStore } from '@core/rateLimit.ts'

import { createTestRuntime, makeRequest } from '../helpers/runtime.ts'

type Runtime = ReturnType<typeof createTestRuntime>

async function call(
  runtime: Runtime,
  request: ReturnType<typeof makeRequest>,
): Promise<HttpResponse> {
  try {
    return await authGuardHandler(runtime, request)
  } catch (error) {
    const response = toErrorResponse(error)
    return { status: response.status, body: await response.json(), headers: {} }
  }
}

interface GuardData {
  allowed: boolean
  attemptsLeft: number | null
  retryAfterSeconds?: number
  scope?: string
}

async function guard(runtime: Runtime, body: unknown, ip = '203.0.113.7'): Promise<{ status: number; data: GuardData; headers: Record<string, string> }> {
  const response = await call(runtime, makeRequest({ path: '/auth-guard', method: 'POST', body, ip }))
  const parsed = response.body as { ok: boolean; data: GuardData }
  return { status: response.status, data: parsed.data, headers: response.headers }
}

/**
 * A fingerprint shaped like the ones src/core/auth.ts sends: 32 lowercase hex
 * characters. Deterministic, so a test can talk about "the same address" twice.
 */
function hashOf(seed: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = (Math.imul(h2 ^ code, 0x85ebca6b) >>> 0) ^ (h2 >>> 13)
  }
  const parts = [h1, h2 >>> 0, (Math.imul(h1, h2) >>> 0), (h1 ^ h2) >>> 0]
  return parts.map((part) => part.toString(16).padStart(8, '0')).join('').slice(0, 32)
}

/** A store that always throws, to exercise the fail-open path deliberately. */
const brokenStore: FixedWindowStore = {
  async increment() {
    throw new Error('counter store unavailable')
  },
}

describe('auth-guard', () => {
  let runtime: Runtime

  beforeEach(() => {
    runtime = createTestRuntime()
  })

  it('allows an attempt and reports how many are left', async () => {
    const { status, data, headers } = await guard(runtime, { emailHash: hashOf('a1') })
    expect(status).toBe(200)
    expect(data.allowed).toBe(true)
    expect(data.attemptsLeft).toBeGreaterThan(0)
    // Nothing about this endpoint may be cached by an intermediary.
    expect(headers['cache-control']).toBe('no-store')
  })

  it('answers identically for a registered and an unregistered address', async () => {
    // The guard cannot tell the two apart, because it never sees the address —
    // only a hash. Two different hashes must produce indistinguishable answers
    // apart from the counter, which is derived from the hash, not the account.
    const known = await guard(runtime, { emailHash: hashOf('known-address') })
    const unknown = await guard(runtime, { emailHash: hashOf('unknown-add') }, '198.51.100.4')
    expect(known.status).toBe(unknown.status)
    expect(known.data.allowed).toBe(unknown.data.allowed)
    expect(known.data.attemptsLeft).toBe(unknown.data.attemptsLeft)
    // The response body carries no echo of the input.
    expect(JSON.stringify(known.data)).not.toContain('known-address')
  })

  it('runs out of attempts for one address and says when to come back', async () => {
    const limits = runtime.config.limits.authAttemptPerMinute.limit
    const body = { emailHash: hashOf('target') }

    for (let attempt = 0; attempt < limits; attempt += 1) {
      const allowed = await guard(runtime, body)
      expect(allowed.data.allowed).toBe(true)
    }

    const blocked = await guard(runtime, body)
    expect(blocked.status).toBe(429)
    expect(blocked.data.allowed).toBe(false)
    expect(blocked.data.scope).toBe('address')
    expect(blocked.data.retryAfterSeconds).toBeGreaterThan(0)
    // A `Retry-After` header is what a client (and a proxy) understands.
    expect(blocked.headers['retry-after']).toBe(String(blocked.data.retryAfterSeconds))
  })

  it('keeps addresses independent, so one exhausted address does not lock another', async () => {
    const limits = runtime.config.limits.authAttemptPerMinute.limit
    for (let attempt = 0; attempt <= limits; attempt += 1) {
      await guard(runtime, { emailHash: hashOf('first') })
    }
    const other = await guard(runtime, { emailHash: hashOf('second') })
    expect(other.data.allowed).toBe(true)
  })

  it('applies a host ceiling, so one machine cannot walk a list of addresses', async () => {
    const hostLimit = runtime.config.limits.authAttemptPerIpPerMinute.limit
    let blockedAt = -1
    for (let attempt = 0; attempt < hostLimit + 3; attempt += 1) {
      // A different address every time: only the host counter can stop this.
      const response = await guard(runtime, { emailHash: hashOf(`sweep-${attempt}`) })
      if (!response.data.allowed) {
        blockedAt = attempt
        expect(response.data.scope).toBe('host')
        break
      }
    }
    expect(blockedAt).toBeGreaterThan(0)
    expect(blockedAt).toBeLessThanOrEqual(hostLimit)
  })

  it('counts repeated attempts against the same fingerprint, with no way to reset it', async () => {
    // The client lowercases and trims before hashing, so only one fingerprint
    // exists per address and there is no case/whitespace variant to spend a
    // fresh budget on.
    const limits = runtime.config.limits.authAttemptPerMinute.limit
    for (let attempt = 0; attempt <= limits; attempt += 1) {
      await guard(runtime, { emailHash: hashOf('victim') })
    }
    const sameHash = await guard(runtime, { emailHash: hashOf('victim') })
    expect(sameHash.data.allowed).toBe(false)
  })

  it('rejects malformed fingerprints instead of counting them', async () => {
    const upper = await call(runtime, makeRequest({ path: '/auth-guard', method: 'POST', body: { emailHash: 'ABCDEF0123456789ABCDEF0123456789' } }))
    expect(upper.status).toBe(422)

    const short = await call(runtime, makeRequest({ path: '/auth-guard', method: 'POST', body: { emailHash: 'abc' } }))
    expect(short.status).toBe(422)

    const missing = await call(runtime, makeRequest({ path: '/auth-guard', method: 'POST', body: {} }))
    expect(missing.status).toBe(422)
  })

  it('rejects a raw email address smuggled into the body', async () => {
    // If someone sends the address itself, the strict schema refuses it: the
    // endpoint must never be a place where a plaintext address is accepted.
    const response = await call(
      runtime,
      makeRequest({ path: '/auth-guard', method: 'POST', body: { emailHash: hashOf('x'), email: 'student@example.edu' } }),
    )
    expect(response.status).toBe(422)
    expect(JSON.stringify(response.body)).not.toContain('student@example.edu')
  })

  it('fails open when the counter store is broken, and does not leak the reason', async () => {
    // A limit of 1 makes the fail-open behaviour unmistakable: if the limiter
    // were consulted successfully the second call would be refused.
    const broken = createTestRuntime({ limits: { authAttemptPerMinute: { limit: 1, windowSeconds: 60 } } })
    ;(broken as unknown as { rateLimit: FixedWindowStore }).rateLimit = brokenStore

    const first = await guard(broken, { emailHash: hashOf('fail-open') })
    const second = await guard(broken, { emailHash: hashOf('fail-open') })
    expect(first.data.allowed).toBe(true)
    expect(second.data.allowed).toBe(true)
    expect(JSON.stringify(second.data)).not.toMatch(/unavailable|error|stack|throw/i)
  })

  it('rejects the wrong HTTP method before doing any work', async () => {
    const response = await call(runtime, makeRequest({ path: '/auth-guard', method: 'GET' }))
    // The shim declares POST; a GET therefore arrives with no body and fails
    // validation rather than being treated as an anonymous check.
    expect([405, 422]).toContain(response.status)
  })

  it('never returns the hash it was given back to the caller', async () => {
    const hash = hashOf('echo-check')
    const { data } = await guard(runtime, { emailHash: hash })
    expect(JSON.stringify(data)).not.toContain(hash)
  })

  it('reports its policies for the health check and the docs', () => {
    const policies = authGuardPolicies(runtime)
    expect(policies.perAddress).toMatch(/^\d+\/\d+s$/)
    expect(policies.perHost).toMatch(/^\d+\/\d+s$/)
    expect(policies.perAddressHourly).toMatch(/^\d+\/\d+s$/)
  })

  it('works for a caller with no token, because that is who needs it', async () => {
    // The guard must not require a session: someone asking to sign in has none.
    const response = await call(runtime, makeRequest({ path: '/auth-guard', method: 'POST', body: { emailHash: hashOf('anon') }, token: null }))
    expect(response.status).toBe(200)
  })
})


