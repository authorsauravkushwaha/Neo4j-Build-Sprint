/**
 * Integration tests for the account screens.
 *
 * The things worth pinning here are honesty properties, not markup:
 *   - with no backend configured, the page says so and shows no password form
 *     (a form that cannot work is worse than no form);
 *   - even in the unconfigured state, guest mode is offered, because nothing in
 *     this app is allowed to be gated behind an account;
 *   - the security copy on the screen matches what the code does.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { AuthPage, ProtectionNotes, ResetLanding } from '@/features/auth/AuthPage.tsx'

function renderAt(ui: React.ReactElement): void {
  render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('account screens', () => {
  it('says accounts are unavailable rather than showing a form that cannot work', async () => {
    renderAt(<AuthPage />)
    // The test environment has no VITE_SUPABASE_URL and no account server
    // answering /api, so after the probe this is the honest state — and the
    // probe itself must not flash a form that cannot work in the meantime.
    expect(screen.queryByLabelText(/^Password$/i)).toBeNull()
    expect(await screen.findByText(/Accounts are not enabled on this deployment/i)).toBeTruthy()
    expect(screen.queryByLabelText(/^Password$/i)).toBeNull()
    expect(screen.queryByLabelText(/Choose a password/i)).toBeNull()
  })

  it('keeps guest mode available on the account screen', async () => {
    renderAt(<AuthPage />)
    expect(await screen.findByRole('link', { name: /Continue as a guest/i })).toBeTruthy()
  })

  it('makes no security promises at all on an unconfigured build', () => {
    renderAt(<AuthPage />)
    const text = document.body.textContent ?? ''
    // Rate limiting is a claim about a sign-in service that does not exist here,
    // so it must not appear.
    expect(text).not.toMatch(/rate limited|hashing|token/i)
    expect(text).not.toMatch(/military|bank-level|unhackable|100% secure|guarantee/i)
  })

  it('states the protections it really has when accounts are configured', () => {
    renderAt(<ProtectionNotes />)
    const text = document.body.textContent ?? ''
    // Each of these lines maps to code: checkPassword in @core/security.ts,
    // the auth-guard handler, the SHA-256 fingerprint, describeAuthError's
    // single wording, and signOut({ scope: 'global' }).
    expect(text).toMatch(/same code on both sides/i)
    expect(text).toMatch(/rate limited per address and per network/i)
    expect(text).toMatch(/hashed before an attempt counter/i)
    expect(text).toMatch(/do not reveal whether an address has an account/i)
    expect(text).toMatch(/revoked on every device at once/i)
    // And the limits are named, not hidden.
    expect(text).toMatch(/docs\/security\.md/i)
    expect(text).not.toMatch(/military|bank-level|unhackable|100% secure|guarantee/i)
  })

  it('does not render a password value anywhere in the document', () => {
    renderAt(<AuthPage />)
    // No input on the page may be a password field in the unconfigured state.
    const inputs = Array.from(document.querySelectorAll('input'))
    expect(inputs.filter((input) => input.type === 'password')).toHaveLength(0)
  })

  it('offers a way out of an expired reset link instead of a dead end', () => {
    renderAt(<ResetLanding />)
    expect(screen.getByText(/no longer valid/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Back to sign in/i })).toBeTruthy()
    expect(screen.getByText(/nothing has changed on your account/i)).toBeTruthy()
  })

  it('does not accept a password on the reset screen until a link session exists', () => {
    renderAt(<ResetLanding />)
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
  })
})


