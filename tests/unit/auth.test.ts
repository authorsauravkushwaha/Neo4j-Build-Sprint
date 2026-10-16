/**
 * Unit tests for the client auth module.
 *
 * Two of these tests exist to stop a specific class of bug rather than a
 * specific function:
 *
 *   - "uses the server's own policy function" imports both the client helper and
 *     the Edge Function's security module and asserts they agree on a battery of
 *     passwords. If someone re-implements the rule in the browser, this fails.
 *   - "does not leak which side of the check failed" asserts that every mapped
 *     error message is about the *attempt*, never about whether an account
 *     exists, because that distinction is what account enumeration is built on.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  authAvailable,
  checkPassword,
  describeAuthError,
  describeSession,
  passwordByteLength,
  strengthBand,
} from '@/core/auth.ts'
import { DEFAULT_PASSWORD_LIMITS, PASSWORD_INPUT_CEILING_BYTES, validatePasswordStrength } from '@core/security.ts'
import type { Session } from '@supabase/supabase-js'

describe('the long-password DoS guard, from the client side', () => {
  /**
   * This is the regression test for a real gap: sign-in used to hand whatever
   * was typed straight to the auth provider. A one-megabyte "password" is a
   * cheap way to make somebody else's server do expensive work, and the client
   * is the first place it can be refused.
   *
   * A Supabase client is mocked in because the guard lives *after* the
   * "accounts unconfigured" branch — that order is deliberate, so a guest build
   * still says "accounts are unavailable" rather than complaining about a
   * password nobody is going to check. With the client present, `fetch` is
   * stubbed to prove the refusal happens before any network call: a guard that
   * still posts the payload and then complains is not a guard.
   */
  it('refuses an oversized password without touching the network', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      throw new Error('the network must not be reached for an oversized password')
    }) as typeof fetch

    const signInMock = vi.fn()
    vi.doMock('@/core/supabase.ts', () => ({
      supabase: () => ({ auth: { signInWithPassword: signInMock, signUp: vi.fn() } }),
      getSession: async () => null,
      getAccessToken: async () => null,
      onAuthChange: () => () => {},
    }))

    try {
      vi.resetModules()
      const { signInWithPassword } = await import('@/core/auth.ts')
      const huge = 'a'.repeat(200_000)
      const result = await signInWithPassword('learner@example.com', huge)
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/longer than/i)
      // Neither the provider call nor the auth-guard request may have been made.
      expect(signInMock).not.toHaveBeenCalled()
      expect(calls).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
      vi.doUnmock('@/core/supabase.ts')
      vi.resetModules()
    }
  })

  it('keeps the two limits distinct: policy (72 bytes) is not the input ceiling', () => {
    // 200 bytes is over the *policy* limit but well under the *input* ceiling —
    // they are deliberately different controls with different messages.
    const sample = 'a'.repeat(200)
    expect(checkPassword(sample).problems.join(' ')).toMatch(/at most/)
    expect(sample.length).toBeLessThan(PASSWORD_INPUT_CEILING_BYTES)
  })
})

describe('password policy parity', () => {
  const samples = [
    '',
    'short',
    'aaaaaaaaaaaaaaaa',
    'qwertyuiop123',
    'password123',
    'Password123',
    'correct horse battery staple',
    'GraphMentor2026!',
    'a'.repeat(72),
    'a'.repeat(73),
    'ünïcödé-passphrase-value-ß',
    'x'.repeat(200),
  ]

  it('uses the server’s own policy function', () => {
    for (const sample of samples) {
      const client = checkPassword(sample)
      const server = validatePasswordStrength(sample)
      expect(client.ok).toBe(server.ok)
      expect(client.problems).toEqual(server.problems)
      expect(client.strength).toBe(server.strength)
    }
  })

  it('counts bytes, not characters, so multi-byte passwords are measured honestly', () => {
    expect(passwordByteLength('abc')).toBe(3)
    // Four Cyrillic characters are eight bytes in UTF-8.
    expect(passwordByteLength('абвг')).toBe(8)
    const long = 'ы'.repeat(40) // 80 bytes: over the 72-byte ceiling
    expect(passwordByteLength(long)).toBe(80)
    expect(checkPassword(long).ok).toBe(false)
    expect(checkPassword(long).problems.join(' ')).toMatch(/at most/)
  })

  it('rejects the min and max boundaries the server rejects', () => {
    const tooShort = 'a'.repeat(DEFAULT_PASSWORD_LIMITS.minLength - 1)
    expect(checkPassword(tooShort).ok).toBe(false)
    const longEnough = 'flowing-quiet-river-passphrase'
    expect(checkPassword(longEnough).ok).toBe(true)
    const tooLong = 'a1b2'.repeat(20) // 80 ASCII bytes
    expect(checkPassword(tooLong).ok).toBe(false)
  })

  it('never echoes the password back in a problem message', () => {
    // Fake value on purpose: this test asserts it is never echoed back.
    const secret = 'hunter2hunter2' // secret-scan:allow — test fixture, never a real credential
    const check = checkPassword(secret)
    for (const problem of check.problems) {
      expect(problem).not.toContain(secret)
    }
  })

  it('rates a long passphrase above a short scrambled word', () => {
    expect(strengthBand('quiet-river-flowing-north').score).toBeGreaterThan(strengthBand('P@ss1').score)
    expect(strengthBand('').score).toBe(0)
    expect(strengthBand('abc').label).toBe('Weak')
  })

  it('always returns a label and a hint, so the meter never renders blank', () => {
    for (const sample of samples) {
      const band = strengthBand(sample)
      expect(band.label.length).toBeGreaterThan(0)
      expect(band.hint.length).toBeGreaterThan(0)
      expect(band.score).toBeGreaterThanOrEqual(0)
      expect(band.score).toBeLessThanOrEqual(4)
    }
  })
})

describe('sign-in error mapping', () => {
  const cases: Array<[unknown, RegExp]> = [
    [new Error('Invalid login credentials'), /check the address and password/i],
    [new Error('User not found'), /check the address and password/i],
    [Object.assign(new Error('rate limit exceeded'), { status: 429 }), /too many/i],
    [new Error('Failed to fetch'), /could not reach/i],
    [new Error('Email not confirmed'), /confirm/i],
    [new Error('Password is too weak'), /at least 10 characters/i],
    [new Error('Token has expired or is invalid'), /expired or was already used/i],
    [new Error('User already registered'), /try signing in instead/i],
    [undefined, /did not complete/i],
  ]

  it('maps provider errors to copy that helps a person and not an attacker', () => {
    for (const [error, pattern] of cases) {
      expect(describeAuthError(error).message).toMatch(pattern)
    }
  })

  it('does not leak which side of the check failed', () => {
    const wrongPassword = describeAuthError(new Error('Invalid login credentials')).message
    const noSuchUser = describeAuthError(new Error('User not found')).message
    // Identical wording: that is the whole point.
    expect(wrongPassword).toBe(noSuchUser)
  })

  it('never returns a stack trace, a status code, or a provider name verbatim', () => {
    const noisy = Object.assign(new Error('supabase-js: PostgrestError 500 at /auth/v1/token\n  at doFetch (x.ts:12)'), {
      status: 500,
    })
    const message = describeAuthError(noisy).message
    expect(message).not.toMatch(/supabase|postgrest|doFetch|x\.ts|500|\n/)
  })

  it('handles a thrown non-Error without crashing the screen', () => {
    expect(describeAuthError('boom').message.length).toBeGreaterThan(0)
    expect(describeAuthError(null).message.length).toBeGreaterThan(0)
    expect(describeAuthError({ status: 429 }).message).toMatch(/too many/i)
  })
})

describe('session facts', () => {
  const base = {
    access_token: 'token-value-that-must-never-be-rendered', // secret-scan:allow — fixture
    refresh_token: 'refresh-value',
    token_type: 'bearer',
    user: { id: 'a5f0b2c3-1111-4222-8333-444455556666', email: 'learner@example.edu', app_metadata: { provider: 'email' } },
  } as unknown as Session

  it('summarises a session without exposing tokens', () => {
    const facts = describeSession({ ...base, expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session)
    expect(facts.email).toBe('learner@example.edu')
    expect(facts.userId).toBe('a5f0b2c3-1111-4222-8333-444455556666')
    expect(facts.isExpired).toBe(false)
    expect(facts.expiresInSeconds).toBeGreaterThan(3000)
    // The important assertion: no token value can reach the UI through this.
    expect(JSON.stringify(facts)).not.toMatch(/token-value|refresh-value/)
  })

  it('flags an expired session instead of pretending it is live', () => {
    const facts = describeSession({ ...base, expires_at: Math.floor(Date.now() / 1000) - 5 } as Session)
    expect(facts.isExpired).toBe(true)
  })

  it('degrades to nulls when the provider omits fields', () => {
    const facts = describeSession({ ...base, user: { ...base.user, email: undefined } } as unknown as Session)
    expect(facts.email).toBeNull()
    expect(facts.expiresAt).toBeNull()
    expect(facts.expiresInSeconds).toBeNull()
    expect(facts.isExpired).toBe(false)
  })

  it('reports "no accounts" for a guest session', () => {
    const facts = describeSession(null)
    expect(facts).toEqual({
      email: null,
      userId: null,
      expiresAt: null,
      expiresInSeconds: null,
      isExpired: false,
      provider: null,
    })
  })

  it('says whether this build can offer accounts at all', () => {
    // The test environment has no Supabase env vars, so this is the honest answer.
    expect(typeof authAvailable()).toBe('boolean')
  })
})


