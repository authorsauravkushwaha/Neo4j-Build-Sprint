/**
 * Command palette tests (jsdom).
 *
 * The browser suite proves the palette renders and reacts in a real engine; this
 * file pins the contract that is easy to break quietly: the shortcut, the
 * keyboard navigation, what Enter actually does, focus going back where it came
 * from, and the ARIA wiring that makes the whole thing usable with a screen
 * reader. It runs against the demo dataset through `api()`, exactly like the app.
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { CommandPalette, PaletteTrigger } from '@/components/CommandPalette.tsx'

function LocationProbe(): React.ReactNode {
  const location = useLocation()
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>
}

function renderPalette(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <PaletteTrigger />
      <CommandPalette />
      <Routes>
        <Route path="/" element={<LocationProbe />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

const openPalette = (): void => {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
}

describe('command palette', () => {
  it('opens on Ctrl+K, closes on Escape, and puts focus in the search field', async () => {
    renderPalette()
    expect(screen.queryByRole('dialog')).toBeNull()

    openPalette()
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    const field = screen.getByRole('combobox')
    expect(document.activeElement).toBe(field)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('is a real combobox/listbox with a live result count', async () => {
    renderPalette()
    openPalette()
    const field = await screen.findByRole('combobox')
    expect(field.getAttribute('aria-expanded')).toBe('true')
    expect(field.getAttribute('aria-controls')).toBe('gm-cmd-list')
    expect(screen.getByRole('listbox')).toBeTruthy()
    // The live region announces the build first, then the count — waiting for
    // the count also proves the index actually resolved in demo mode.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent ?? '').toMatch(/result/i)
    })
  })

  it('searches the dataset and shows a skill page for a typed skill', async () => {
    renderPalette()
    openPalette()
    const field = await screen.findByRole('combobox')
    fireEvent.change(field, { target: { value: 'PID' } })
    const options = await screen.findAllByRole('option')
    expect(options.length).toBeGreaterThan(0)
    // The index is built from the bundled curriculum, so a real skill is findable.
    await waitFor(() => {
      expect(options.some((option) => /pid/i.test(option.textContent ?? ''))).toBe(true)
    })
  })

  it('navigates on Enter to the highlighted entry', async () => {
    renderPalette()
    openPalette()
    const field = await screen.findByRole('combobox')
    fireEvent.change(field, { target: { value: 'Settings' } })
    await screen.findByRole('listbox')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/settings'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says so when nothing matches instead of showing filler', async () => {
    renderPalette()
    openPalette()
    const field = await screen.findByRole('combobox')
    fireEvent.change(field, { target: { value: 'qwertyuiop-no-such-thing' } })
    await waitFor(() => {
      expect(screen.getByText(/Nothing matches/i)).toBeTruthy()
    })
    expect(screen.queryAllByRole('option').length).toBe(0)
  })

  it('returns focus to whatever had it before the palette opened', async () => {
    renderPalette()
    const trigger = screen.getByRole('button', { name: /Search everything/i })
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    openPalette()
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('opens from the app-bar trigger as well as the shortcut', async () => {
    renderPalette()
    fireEvent.click(screen.getByRole('button', { name: /Search everything/i }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})


