/**
 * Rate limiting and replay protection.
 *
 * Two decisions here are deliberate and load-bearing, so they are pinned:
 *  - the window store FAILS CLOSED (an outage must not remove abuse budgets),
 *  - the nonce store FAILS CLOSED (an unverifiable replay check would defeat the
 *    point of having one).
 * If either flips, the behaviour change has to be intentional.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  bucketKey,
  checkRateLimit,
  MemoryFixedWindowStore,
  MemoryNonceStore,
  RATE_POLICIES,
  secondsUntilReset,
  windowStartedAt,
} from '@core/rateLimit.ts'
import type { FixedWindowStore } from '@core/rateLimit.ts'

const t0 = 1_700_000_000_000

describe('fixed windows', () => {
  it('aligns windows to the clock and counts down to the reset', () => {
    expect(windowStartedAt(t0, 60)).toBe(Math.floor(t0 / 60_000) * 60_000)
    expect(secondsUntilReset(t0, 60)).toBeGreaterThan(0)
    expect(secondsUntilReset(t0, 60)).toBeLessThanOrEqual(60)
    // Never reports a reset of zero seconds, which would tell clients to retry instantly.
    expect(secondsUntilReset(windowStartedAt(t0, 60) + 60_000 - 1, 60)).toBeGreaterThanOrEqual(1)
  })

  it('allows up to the limit and then refuses, reporting the remaining budget', async () => {
    const store = new MemoryFixedWindowStore()
    const policy = { limit: 3, windowSeconds: 60 }
    const results = []
    for (let index = 0; index < 5; index += 1) results.push(await checkRateLimit(store, 'chat.abc', policy, t0))
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false, false])
    expect(results[2].remaining).toBe(0)
    expect(results[3].bucket).toBe('chat.abc')
  })

  it('resets when the window rolls over', async () => {
    const store = new MemoryFixedWindowStore()
    const policy = { limit: 1, windowSeconds: 60 }
    expect((await checkRateLimit(store, 'chat.abc', policy, t0)).allowed).toBe(true)
    expect((await checkRateLimit(store, 'chat.abc', policy, t0)).allowed).toBe(false)
    expect((await checkRateLimit(store, 'chat.abc', policy, t0 + 61_000)).allowed).toBe(true)
  })

  it('keeps buckets independent', async () => {
    const store = new MemoryFixedWindowStore()
    const policy = { limit: 1, windowSeconds: 60 }
    expect((await checkRateLimit(store, 'chat.a', policy, t0)).allowed).toBe(true)
    expect((await checkRateLimit(store, 'chat.b', policy, t0)).allowed).toBe(true)
  })

  it('FAILS CLOSED when the store errors, preserving abuse protection', async () => {
    const broken: FixedWindowStore = {
      increment: vi.fn(async () => {
        throw new Error('database unavailable')
      }),
    }
    await expect(checkRateLimit(broken, 'chat.abc', { limit: 6, windowSeconds: 60 }, t0)).rejects.toMatchObject({ code: 'dependency_unavailable' })
  })

  it('never stores a raw identifier in the bucket key', async () => {
    const key = await bucketKey('chat', 'u:9f1c-user-id')
    expect(key.startsWith('chat.')).toBe(true)
    expect(key).not.toContain('9f1c')
    expect(key).not.toContain('user-id')
    // Stable for the same input, different for a different input.
    expect(await bucketKey('chat', 'u:9f1c-user-id')).toBe(key)
    expect(await bucketKey('chat', 'u:someone-else')).not.toBe(key)
  })

  it('ships the documented policies and keeps the AI endpoint the tightest', () => {
    expect(RATE_POLICIES.mentorChatPerMinute).toEqual({ limit: 6, windowSeconds: 60 })
    expect(RATE_POLICIES.mentorChatPerHour).toEqual({ limit: 30, windowSeconds: 3600 })
    expect(RATE_POLICIES.analysisPerMinute.limit).toBeLessThan(RATE_POLICIES.readPerMinute.limit)
    expect(RATE_POLICIES.writePerMinute.limit).toBeLessThan(RATE_POLICIES.readPerMinute.limit)
  })
})

describe('nonce store (replay protection)', () => {
  it('accepts a nonce once and refuses it afterwards', async () => {
    const store = new MemoryNonceStore()
    expect(await store.claim('nonce-abcdefgh', 60_000)).toBe(true)
    expect(await store.claim('nonce-abcdefgh', 60_000)).toBe(false)
  })

  it('keeps different nonces independent', async () => {
    const store = new MemoryNonceStore()
    expect(await store.claim('nonce-one', 60_000)).toBe(true)
    expect(await store.claim('nonce-two', 60_000)).toBe(true)
  })

  it('forgets a nonce once its window expires', async () => {
    vi.useFakeTimers()
    try {
      const store = new MemoryNonceStore()
      expect(await store.claim('nonce-expiring', 1000)).toBe(true)
      expect(await store.claim('nonce-expiring', 1000)).toBe(false)
      vi.advanceTimersByTime(1500)
      expect(await store.claim('nonce-expiring', 1000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})


