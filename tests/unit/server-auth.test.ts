/**
 * The sign-in server's credential helpers (`server/server.ts`).
 *
 * These are the functions a password's safety actually depends on, so they are
 * tested where they live rather than re-implemented in a test: scrypt hashes
 * verify and reject, malformed stored hashes fail closed instead of throwing,
 * the policy matches the checklist the sign-up form shows (10 characters,
 * 72 bytes, rejected — never truncated), and session tokens are stored only
 * as SHA-256.
 */
import { describe, expect, it } from 'vitest'

import { emailLooksValid, hashPassword, hashToken, normalizeEmail, passwordProblems, verifyPassword } from '../../server/server.ts'

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery')
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true)
    await expect(verifyPassword('correct horse battery', stored)).resolves.toBe(true)
    await expect(verifyPassword('correct horse batteries', stored)).resolves.toBe(false)
  })

  it('salts every hash, so the same password never hashes twice alike', async () => {
    const first = await hashPassword('same password twice')
    const second = await hashPassword('same password twice')
    expect(first).not.toBe(second)
  })

  it('fails closed on a malformed stored hash instead of throwing', async () => {
    await expect(verifyPassword('whatever password', 'not-a-hash')).resolves.toBe(false)
    await expect(verifyPassword('whatever password', 'scrypt$x$8$1$AA$AA')).resolves.toBe(false)
    await expect(verifyPassword('whatever password', '')).resolves.toBe(false)
  })
})

describe('policy, mirroring the sign-up checklist', () => {
  it('requires 10 characters', () => {
    expect(passwordProblems('short')).toContain('Use at least 10 characters.')
    expect(passwordProblems('long enough password')).toEqual([])
  })

  it('rejects over 72 bytes — multi-byte characters count as bytes', () => {
    expect(passwordProblems('a'.repeat(73)).join(' ')).toContain('72 bytes')
    expect(passwordProblems('é'.repeat(40)).join(' ')).toContain('72 bytes') // 80 bytes UTF-8
    expect(passwordProblems('é'.repeat(36))).toEqual([]) // exactly 72 bytes, 36 chars
  })

  it('normalises and validates email the way the server stores it', () => {
    expect(normalizeEmail('  TestUser@Example.COM ')).toBe('testuser@example.com')
    expect(emailLooksValid('testuser@example.com')).toBe(true)
    expect(emailLooksValid('not-an-email')).toBe(false)
    expect(emailLooksValid('a@b')).toBe(false)
  })

  it('stores session tokens only as SHA-256', () => {
    expect(hashToken('a-token')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('a-token')).not.toBe(hashToken('another-token'))
  })
})


