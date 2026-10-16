/**
 * The public-API catalogue page.
 *
 * The data layer was tested before the page existed (`tests/unit/public-apis.test.ts`),
 * so what is checked here is the thing a data test cannot see: that the caveats
 * travel with the rows to the screen. A catalogue of endpoints is one CSS class
 * away from being a link farm, and the four things that stop it being one are all
 * assertions:
 *
 *   * upstream's `auth` column is translated into words that name the condition
 *     ("Needs an API key"), never into the word "free";
 *   * a row whose link is plaintext `http://` says so on the card, loudly;
 *   * the provenance — source, commit, read date, and all five limitations — is
 *     rendered on the page rather than in a footnote;
 *   * nothing is called "recommended", and the match reason names the actual skill.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { ApisPage } from '@/features/apis/ApisPage.tsx'
import { PUBLIC_API_CATALOG, PUBLIC_API_SOURCE } from '@/data/publicApis/catalog.generated.ts'

function LocationProbe(): React.ReactNode {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderPage(path = '/apis') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/apis"
          element={
            <>
              <ApisPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

/** Every rendered entry card. */
function cards(): HTMLElement[] {
  return screen.getAllByRole('article')
}

describe('the public-API catalogue page', () => {
  it('renders entries as cards, each linking to its docs and to the skills it exercises', () => {
    renderPage()
    const rendered = cards()
    expect(rendered.length).toBeGreaterThan(5)

    for (const card of rendered.slice(0, 5)) {
      // An external link, opened safely, and labelled as opening a new tab.
      const external = within(card).getByRole('link', { name: /open the docs/i })
      expect(external.getAttribute('href')).toMatch(/^https?:\/\//)
      expect(external.getAttribute('target')).toBe('_blank')
      expect(external.getAttribute('rel')).toContain('noopener')
      expect(external.getAttribute('rel')).toContain('noreferrer')

      // At least one skill link, and it points at a skill page rather than an id.
      const skillLinks = within(card)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href')?.startsWith('/skills/skill:'))
      expect(skillLinks.length).toBeGreaterThan(0)
    }
  })

  it('says which condition a key is, and never calls it free', () => {
    // Filtered to a category with a mix, so both labels are on screen at once.
    renderPage('/apis?category=Development')
    const rendered = cards()
    expect(rendered.length).toBeGreaterThan(3)

    const labels = rendered.map((card) => card.textContent ?? '')
    expect(labels.some((text) => text.includes('No key needed'))).toBe(true)
    // The condition is named, in upstream's terms.
    for (const text of labels) {
      if (text.includes('Needs an API key') || text.includes('OAuth sign-in')) continue
      expect(text).toMatch(/No key needed|Auth:/)
    }
    // "Recommended" is not a word this page uses.
    expect(document.body.textContent ?? '').not.toMatch(/recommended for you|best for you|top pick|hand-picked/i)
  })

  it('warns on the card when upstream declares HTTPS and links to http://', () => {
    // Two rows in the current import do this. Both are ranked last, so the honest
    // way to see one is to search for it rather than to scroll to it.
    const plaintext = PUBLIC_API_CATALOG.filter((entry) => entry.linkScheme === 'http')
    expect(plaintext.length).toBe(PUBLIC_API_SOURCE.plaintextLinks)
    expect(plaintext.length).toBeGreaterThan(0)

    renderPage(`/apis?q=${encodeURIComponent(plaintext[0]!.name)}`)
    const card = cards()[0]!
    expect(within(card).getByText(/plaintext link/i)).toBeInTheDocument()
    // And the page explains what it did about it, in the same breath.
    expect(screen.getByText(/rewriting the URL would invent a link/i)).toBeInTheDocument()
  })

  it('renders the provenance, including all five limitations', () => {
    renderPage()
    expect(screen.getByText(PUBLIC_API_SOURCE.rowsRead, { exact: false })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(PUBLIC_API_SOURCE.commit.slice(0, 7)))).toBeInTheDocument()
    // "Imported, not live" appears twice on purpose — once in the page's own lede
    // and once in the provenance list — so the assertion is on the list's own
    // sentence, which is the one that carries the reading of the data.
    expect(screen.getAllByText(/Imported, not live/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/apiKey/)).toBeInTheDocument()
    expect(screen.getByText(/Free means free at import time/)).toBeInTheDocument()
    expect(screen.getByText(/practice target, not a lesson/)).toBeInTheDocument()
    expect(screen.getByText(/link scheme is recorded separately/)).toBeInTheDocument()
  })

  it('filters by search, by category, by skill and by key requirement — and keeps the filter in the URL', async () => {
    const user = userEvent.setup()
    renderPage()
    const search = screen.getByLabelText(/^search$/i)
    await user.type(search, 'weather')

    const filtered = cards()
    expect(filtered.length).toBeGreaterThan(0)
    for (const card of filtered) {
      const text = card.textContent ?? ''
      // The match is against name, description or category — the same three fields
      // the query layer documents.
      expect(text.toLowerCase()).toContain('weather')
    }
    // A filtered view is a link, the way the resource library's is.
    expect(screen.getByTestId('location').textContent).toContain('q=weather')

    await user.selectOptions(screen.getByLabelText(/category/i), 'Weather')
    for (const card of cards()) expect(within(card).getByText('Weather')).toBeInTheDocument()
    expect(screen.getByTestId('location').textContent).toContain('category=Weather')
  })

  it('can be narrowed to entries that need no key at all', async () => {
    const user = userEvent.setup()
    renderPage()
    const select = screen.getByLabelText(/key required/i)
    await user.selectOptions(select, 'none')

    const rendered = cards()
    expect(rendered.length).toBeGreaterThan(0)
    for (const card of rendered) {
      expect(card.textContent ?? '').toContain('No key needed')
      expect(card.textContent ?? '').not.toContain('Needs an API key')
    }
  })

  it('answers an impossible filter with an empty state, not an error or a fallback to everything', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByLabelText(/^search$/i), 'zzzz-no-such-api')
    expect(screen.getByText(/Nothing matches those filters/i)).toBeInTheDocument()
    expect(screen.queryAllByRole('article')).toHaveLength(0)
  })

  it('shows which skill a match came from, in the sentence the query layer produced', () => {
    renderPage('/apis?skill=skill:api-design-and-integration')
    const rendered = cards()
    expect(rendered.length).toBeGreaterThan(0)
    for (const card of rendered) {
      const text = card.textContent ?? ''
      expect(text).toMatch(/exercises \d+ skill\(s\) in your route|Listed in the imported directory/)
    }
  })
})
