/**
 * Authentication.
 *
 * One rule shapes this file: **the client checks passwords with the exact same
 * function the server uses.** `validatePasswordStrength` lives in
 * `supabase/functions/_shared/core/security.ts` and is imported here rather than
 * reimplemented, so the meter a learner sees and the rule the backend enforces
 * cannot drift apart. (There is a test that would fail the moment they do.)
 *
 * What this module deliberately does not do:
 *   - it never stores a password anywhere except in React state, for the length
 *     of one submit, and clears it immediately after;
 *   - it never logs an email address or a password, not even on failure;
 *   - it never tells the user whether an address has an account (that is an
 *     enumeration oracle). Sign-in failures are one generic message;
 *   - it never invents a success. If Supabase is not configured, the functions
 *     say so and the UI stays in guest mode.
 *
 * Session handling is delegated to supabase-js, which keeps the access token in
 * `gm.auth` in localStorage. That token is a bearer credential, so this file
 * exposes `signOutEverywhere()` (server-side revocation of all refresh tokens)
 * and the Settings screen documents how to clear it.
 */
import type { Session } from '@supabase/supabase-js'

import { supabase } from './supabase.ts'
import { config, hasBackend } from './env.ts'
import {
  validatePasswordStrength,
  utf8ByteLength,
  passwordExceedsInputCeiling,
  PASSWORD_INPUT_CEILING_BYTES,
  type PasswordCheck,
} from '@core/security.ts'

/* ==========================================================================
 * Password policy — mirrored, not re-invented
 * ========================================================================== */

export type { PasswordCheck }

/** The same function the Edge Functions call before hashing anything. */
export function checkPassword(password: string): PasswordCheck {
  return validatePasswordStrength(password)
}

/** Byte length matters for long-password DoS, and users type characters. */
export function passwordByteLength(password: string): number {
  return utf8ByteLength(password)
}

export interface StrengthBand {
  /** 0 (empty) .. 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4
  label: string
  hint: string
}

/**
 * Turns the server's relative cost indicator into something a person can read.
 * The label is deliberately about *effort to guess*, not about "this is secure":
 * nothing here can promise a password is safe.
 */
export function strengthBand(password: string): StrengthBand {
  if (password.length === 0) {
    return { score: 0, label: 'Empty', hint: 'Pick something long — a phrase works better than a word.' }
  }
  const check = checkPassword(password)
  const raw = check.strength
  const score: StrengthBand['score'] = raw < 0.3 ? 1 : raw < 0.5 ? 2 : raw < 0.72 ? 3 : 4
  const labels: Record<StrengthBand['score'], string> = {
    0: 'Empty',
    1: 'Weak',
    2: 'Fair',
    3: 'Good',
    4: 'Strong',
  }
  const hints: Record<StrengthBand['score'], string> = {
    0: 'Pick something long — a phrase works better than a word.',
    1: 'Too easy to guess. Add length before adding symbols.',
    2: check.ok ? 'Acceptable. Longer is better than more punctuation.' : 'Not yet meeting the minimums below.',
    3: 'Good. A longer phrase would still be stronger.',
    4: 'Strong for a study-planning account.',
  }
  return { score, label: labels[score], hint: hints[score] }
}

/* ==========================================================================
 * Errors
 * ========================================================================== */

/**
 * Maps a provider error to copy that is useful to a real user and useless to an
 * attacker. The provider's own message is never returned verbatim: it contains
 * hints ("user not found", "invalid login credentials" vs "rate limit") that
 * should not reach a stranger guessing at addresses.
 */
export function describeAuthError(error: unknown): { message: string; retryAfterSeconds?: number } {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const status = (error as { status?: number } | null)?.status

  if (/rate|too many|429/i.test(raw) || status === 429) {
    return {
      message: 'Too many attempts from this network. Wait a minute and try again — the limit exists to slow down password guessing.',
    }
  }
  if (/fetch|network|failed to fetch|timeout/i.test(raw)) {
    return { message: 'Could not reach the sign-in service. Check your connection — the rest of the app still works as a guest.' }
  }
  if (/already registered|already exists|user_already_exists/i.test(raw)) {
    // Deliberately vague: this is the one message where a provider leaks that an
    // address is in use. Try signing in instead, or use a different address.
    return { message: 'That address cannot be registered. Try signing in instead, or use a different address.' }
  }
  if (/email.*(invalid|not confirmed)|invalid.*email/i.test(raw)) {
    return { message: 'That address does not look valid, or it has not been confirmed yet. Check the link we sent you.' }
  }
  if (/weak|leaked|pwned|password.*(short|common|guess)/i.test(raw)) {
    return { message: 'That password was rejected. Use at least 10 characters and avoid well-known passwords.' }
  }
  if (/expired|invalid.*token|otp/i.test(raw)) {
    return { message: 'That link has expired or was already used. Request a new one — they are single-use.' }
  }
  return { message: 'Sign-in did not complete. Check the address and password, then try again.' }
}

/* ==========================================================================
 * Sign-in attempts are rate limited before they reach the provider
 * ========================================================================== */

export interface AttemptGuard {
  allowed: boolean
  attemptsLeft: number | null
  retryAfterSeconds: number | null
  /** True when the guard itself could not be reached (fails open, see below). */
  degraded: boolean
}

/**
 * Asks the backend whether this address may attempt a sign-in right now.
 *
 * Fails **open**: if the guard cannot be reached, the attempt proceeds and
 * Supabase Auth's own rate limiting is the backstop. Locking every user out of
 * sign-in because a rate-limit table is unavailable would be a worse failure
 * than the one being defended against — and that trade-off is documented in
 * docs/security.md rather than left implicit.
 *
 * The email is hashed before it leaves the browser: the guard needs to count
 * attempts per address without learning the address.
 */
export async function requestSignInSlot(email: string, passwordBytes?: number): Promise<AttemptGuard> {
  const fallback: AttemptGuard = { allowed: true, attemptsLeft: null, retryAfterSeconds: null, degraded: true }
  if (!hasBackend) return fallback

  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()))
    const hash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch(`${config.apiBaseUrl}/auth-guard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailHash: hash, ...(passwordBytes !== undefined ? { passwordBytes } : {}) }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))

    if (!response.ok) return fallback
    const body = (await response.json()) as {
      ok?: boolean
      data?: { allowed?: boolean; attemptsLeft?: number; retryAfterSeconds?: number }
    }
    if (!body.ok || !body.data) return fallback
    return {
      allowed: body.data.allowed !== false,
      attemptsLeft: typeof body.data.attemptsLeft === 'number' ? body.data.attemptsLeft : null,
      retryAfterSeconds: typeof body.data.retryAfterSeconds === 'number' ? body.data.retryAfterSeconds : null,
      degraded: false,
    }
  } catch {
    return fallback
  }
}

/* ==========================================================================
 * Operations
 * ========================================================================== */

export interface AuthResult {
  ok: boolean
  /** Safe to render. Never contains the provider's raw wording. */
  message: string
  /** True when the user must confirm via an emailed link before they have a session. */
  needsEmailConfirmation?: boolean
}

/**
 * The local half of the long-password DoS guard.
 *
 * The ceiling is enforced here *before* any network call, on every path that
 * takes a password — including sign-in, which is the one an attacker actually
 * drives. Without this, a sign-in form happily posts a megabyte to the auth
 * provider and lets *their* CPU pay for it. The provider's own limits are a
 * backstop, not the plan.
 */
function refuseOversizedPassword(password: string): AuthResult | null {
  if (!passwordExceedsInputCeiling(password)) return null
  return {
    ok: false,
    message: `That password is longer than ${PASSWORD_INPUT_CEILING_BYTES} bytes, which no real passphrase needs. Check for a paste accident — a password manager's export, or a stray file — and enter it again.`,
  }
}

const unconfigured: AuthResult = {
  ok: false,
  message:
    'This build has no Supabase project configured, so accounts are unavailable. Everything works as a guest — your plan and progress stay on this device.',
}

/** Returns the site origin a confirmation link should come back to. */
function redirectTo(): string {
  if (typeof window === 'undefined') return 'http://localhost:5173/'
  return `${window.location.origin}${window.location.pathname.replace(/\/login\/?$/, '/')}`
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const sb = supabase()
  if (!sb) return unconfigured

  const oversized = refuseOversizedPassword(password)
  if (oversized) return oversized

  const guard = await requestSignInSlot(email, passwordByteLength(password))
  if (!guard.allowed) {
    return {
      ok: false,
      message: `Too many sign-in attempts for this address. Try again in about ${guard.retryAfterSeconds ?? 60} seconds.`,
    }
  }

  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password })
  if (error) return { ok: false, message: describeAuthError(error).message }
  return { ok: true, message: 'Signed in.' }
}

export async function signUpWithPassword(email: string, password: string): Promise<AuthResult> {
  const sb = supabase()
  if (!sb) return unconfigured

  const oversized = refuseOversizedPassword(password)
  if (oversized) return oversized

  // Ask the same function the server will run, so the user is told before the
  // round trip instead of after it.
  const check = checkPassword(password)
  if (!check.ok) return { ok: false, message: check.problems.join(' ') }

  const guard = await requestSignInSlot(email)
  if (!guard.allowed) {
    return {
      ok: false,
      message: `Too many attempts from this address. Try again in about ${guard.retryAfterSeconds ?? 60} seconds.`,
    }
  }

  const { data, error } = await sb.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: redirectTo() },
  })
  if (error) return { ok: false, message: describeAuthError(error).message }

  if (data.session) return { ok: true, message: 'Account created and signed in.' }
  return {
    ok: true,
    needsEmailConfirmation: true,
    message: 'Account created. Check your inbox for the confirmation link before signing in — it is single-use and expires.',
  }
}

export async function sendMagicLink(email: string): Promise<AuthResult> {
  const sb = supabase()
  if (!sb) return unconfigured

  const guard = await requestSignInSlot(email)
  if (!guard.allowed) {
    return {
      ok: false,
      message: `Too many sign-in links requested for this address. Try again in about ${guard.retryAfterSeconds ?? 60} seconds.`,
    }
  }

  const { error } = await sb.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo() },
  })
  if (error) return { ok: false, message: describeAuthError(error).message }
  return {
    ok: true,
    message: 'If that address can receive mail, a single-use sign-in link is on its way. It expires shortly.',
  }
}

export async function sendPasswordReset(email: string): Promise<AuthResult> {
  const sb = supabase()
  if (!sb) return unconfigured

  const guard = await requestSignInSlot(email)
  if (!guard.allowed) {
    return {
      ok: false,
      message: `Too many reset requests for this address. Try again in about ${guard.retryAfterSeconds ?? 60} seconds.`,
    }
  }

  const { error } = await sb.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${redirectTo()}#/login?reset=1`,
  })
  if (error) return { ok: false, message: describeAuthError(error).message }
  // The same wording whether or not the address exists — no enumeration oracle.
  return { ok: true, message: 'If that address has an account, a password-reset link is on its way. It is single-use.' }
}

/** Used on the reset flow, after the emailed link has established a session. */
export async function updatePassword(password: string): Promise<AuthResult> {
  const sb = supabase()
  if (!sb) return unconfigured

  const oversized = refuseOversizedPassword(password)
  if (oversized) return oversized

  const check = checkPassword(password)
  if (!check.ok) return { ok: false, message: check.problems.join(' ') }

  const { error } = await sb.auth.updateUser({ password })
  if (error) return { ok: false, message: describeAuthError(error).message }
  return { ok: true, message: 'Password updated. Other devices keep their sessions until you sign them out.' }
}

export async function signOut(): Promise<void> {
  const sb = supabase()
  if (!sb) return
  await sb.auth.signOut()
}

/**
 * Revokes every refresh token for this account, on every device.
 *
 * This is the button to press after losing a laptop or signing in on a shared
 * machine: `local` scope would only end this tab's session.
 */
export async function signOutEverywhere(): Promise<AuthResult> {
  const sb = supabase()
  if (!sb) return unconfigured
  const { error } = await sb.auth.signOut({ scope: 'global' })
  if (error) return { ok: false, message: describeAuthError(error).message }
  return { ok: true, message: 'Signed out on every device. All refresh tokens for this account were revoked.' }
}

/* ==========================================================================
 * Session introspection (for the account screen)
 * ========================================================================== */

export interface SessionFacts {
  email: string | null
  userId: string | null
  /** ISO string, or null when the provider did not supply one. */
  expiresAt: string | null
  expiresInSeconds: number | null
  isExpired: boolean
  provider: string | null
}

export function describeSession(session: Session | null): SessionFacts {
  if (!session) {
    return { email: null, userId: null, expiresAt: null, expiresInSeconds: null, isExpired: false, provider: null }
  }
  const expiresAt = typeof session.expires_at === 'number' ? new Date(session.expires_at * 1000) : null
  const seconds = expiresAt ? Math.round((expiresAt.getTime() - Date.now()) / 1000) : null
  return {
    email: session.user.email ?? null,
    userId: session.user.id,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    expiresInSeconds: seconds,
    isExpired: seconds !== null && seconds <= 0,
    provider: session.user.app_metadata?.provider ?? null,
  }
}

/** True when this build can offer accounts at all. */
export function authAvailable(): boolean {
  return hasBackend
}


