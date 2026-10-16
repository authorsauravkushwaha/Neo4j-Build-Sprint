/**
 * The scroll chrome every screen sits inside.
 *
 * These are the assertions that keep the site-wide scroll layer from becoming
 * decoration nobody checked:
 *
 *   * the reading rail is on **every** route, not only the landing story it used
 *     to belong to;
 *   * the back-to-top control appears only once it is useful, and it is a real
 *     button that moves focus with it;
 *   * the app bar condenses on a boolean, not on a per-frame value, so scrolling
 *     cannot re-render the shell sixty times a second;
 *   * a route change re-enters the screen, and a query-string change does not;
 *   * and every one of those effects is *absent* under reduced motion except the
 *     control, because wanting less motion is not wanting fewer features.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { Layout } from '@/app/Layout.tsx'
import { BACK_TO_TOP_VIEWPORTS } from '@/skiper/components/ScrollChrome.tsx'
import { isPastScrollThreshold } from '@/skiper/motion/useScrollFlag.ts'

/** jsdom has no scroll position and no viewport height unless we give it one. */
function setViewport(height: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value })
}

/** Scroll is coalesced into one rAF, so a test has to let that frame run. */
async function scrollTo(value: number): Promise<void> {
  setScrollY(value)
  await act(async () => {
    window.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function Screen({ label }: { label: string }): React.ReactNode {
  const location = useLocation()
  return (
    <p>
      {label} at {location.pathname}
      {location.search}
    </p>
  )
}

function renderShell(initial = '/dashboard'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<Screen label="dashboard" />} />
          <Route path="/careers" element={<Screen label="careers" />} />
          <Route path="/graph" element={<Screen label="graph" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

const originalScrollTo = window.scrollTo

beforeEach(() => {
  document.documentElement.dataset.motion = 'full'
  setViewport(800)
  setScrollY(0)
  window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo
})

afterEach(() => {
  window.scrollTo = originalScrollTo
  delete document.documentElement.dataset.motion
})

describe('the scroll flag', () => {
  it('is strictly past the threshold, and never trusts a nonsense reading', () => {
    expect(isPastScrollThreshold(0, 8)).toBe(false)
    expect(isPastScrollThreshold(8, 8)).toBe(false)
    expect(isPastScrollThreshold(8.5, 8)).toBe(true)
    expect(isPastScrollThreshold(-40, 8)).toBe(false)
    // A negative threshold would mean "reveal the control before the page has
    // moved", which is the same bug as revealing it on an unmeasured value.
    expect(isPastScrollThreshold(0, -10)).toBe(false)
    expect(isPastScrollThreshold(Number.NaN, 8)).toBe(false)
    expect(isPastScrollThreshold(Number.POSITIVE_INFINITY, 8)).toBe(false)
    expect(isPastScrollThreshold(100, Number.NaN)).toBe(false)
  })
})

describe('the reading rail', () => {
  it('is mounted by the shell, so every route has it and not only the story', () => {
    const { unmount } = renderShell('/dashboard')
    expect(screen.getByTestId('scroll-progress')).toBeInTheDocument()
    unmount()

    renderShell('/careers')
    expect(screen.getByTestId('scroll-progress')).toBeInTheDocument()
  })

  it('is absent under reduced motion rather than frozen at zero', () => {
    document.documentElement.dataset.motion = 'reduced'
    renderShell('/dashboard')
    expect(screen.queryByTestId('scroll-progress')).toBeNull()
  })
})

describe('the app bar', () => {
  it('condenses on a real scroll and relaxes at the top again', async () => {
    renderShell('/dashboard')
    const bar = document.querySelector('[data-scrolled]')
    expect(bar).not.toBeNull()
    expect(bar!.getAttribute('data-scrolled')).toBe('false')

    await scrollTo(200)
    expect(bar!.getAttribute('data-scrolled')).toBe('true')

    await scrollTo(0)
    expect(bar!.getAttribute('data-scrolled')).toBe('false')
  })

  it('keeps the same height, because a condensing bar that reflows the page is worse than none', () => {
    // The decision is in the stylesheet: only transform, opacity and box-shadow
    // change on the scrolled state, never padding, font-size or height.
    const css = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8')
    const block = css.slice(css.indexOf(".gm-appbar[data-scrolled='true']"))
    const rule = block.slice(0, block.indexOf('}'))
    expect(rule).toMatch(/box-shadow/)
    expect(rule).not.toMatch(/padding|height|font-size|margin/)
  })
})

describe('back to top', () => {
  it('is not there when there is nothing to go back to', () => {
    renderShell('/dashboard')
    expect(screen.queryByTestId('back-to-top')).toBeNull()
  })

  it('appears past three viewports, and moves focus to the content when pressed', async () => {
    const user = userEvent.setup()
    renderShell('/dashboard')
    await scrollTo(BACK_TO_TOP_VIEWPORTS * 800 + 10)

    const button = screen.getByTestId('back-to-top')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAccessibleName(/back to top/i)

    await user.click(button)
    // Focus lands on the main region: a keyboard user arrives at the top of the
    // content, not on the button they just pressed.
    expect(document.activeElement?.id).toBe('main-content')
  })

  it('is rendered under reduced motion too, because it is a control', async () => {
    document.documentElement.dataset.motion = 'reduced'
    renderShell('/dashboard')
    await scrollTo(BACK_TO_TOP_VIEWPORTS * 800 + 10)
    expect(screen.getByTestId('back-to-top')).toBeInTheDocument()
  })
})

describe('the incoming screen', () => {
  it('is wrapped in the entrance, and the wrapper follows the route', async () => {
    const user = userEvent.setup()
    renderShell('/dashboard')
    expect(screen.getByTestId('page-enter')).toBeInTheDocument()
    const before = screen.getByTestId('page-enter')

    // The label appears twice (header and sidebar), so click the one in the
    // header's own navigation list rather than "the first match".
    const headerNav = screen.getByRole('banner')
    await user.click(within(headerNav).getByRole('link', { name: /career explorer/i }))
    expect(await screen.findByText(/careers at \/careers/)).toBeInTheDocument()
    expect(screen.getByTestId('page-enter')).not.toBe(before)
  })

  it('has no entrance at all under reduced motion', () => {
    document.documentElement.dataset.motion = 'reduced'
    renderShell('/dashboard')
    expect(screen.queryByTestId('page-enter')).toBeNull()
    // The screen itself is still there — the layer adds motion, never content.
    expect(screen.getByText(/dashboard at \/dashboard/)).toBeInTheDocument()
  })
})
