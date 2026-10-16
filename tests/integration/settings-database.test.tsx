import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from '@/features/settings/SettingsPage.tsx'

function renderSettings() { render(<MemoryRouter><SettingsPage /></MemoryRouter>) }
function reply(available: boolean, user: unknown = null) {
  return new Response(JSON.stringify({ available, user }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('Settings detects the website database without Supabase', () => {
  it('shows the real account service instead of claiming no backend is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(true))
    renderSettings()
    expect(await screen.findByText('Account database connected')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in or create account' })).toHaveAttribute('href', '/login')
    expect(screen.queryByText('No backend configured')).not.toBeInTheDocument()
    expect(screen.getByText(/Device data stays separate/)).toBeInTheDocument()
  })

  it('links a signed-in account to database sync', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(true, { id: 'user', email: 'learner@example.com', createdAt: '2026-10-16T00:00:00Z' }))
    renderSettings()
    expect(await screen.findByText(/Signed in as learner@example.com/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Account and database sync' })).toHaveAttribute('href', '/account')
  })

  it('reports a real outage and supports retry without losing device data', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(reply(true))
    renderSettings()
    expect(await screen.findByText('Account database unreachable')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(await screen.findByText('Account database connected')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
