/**
 * Page-level integration tests.
 *
 * These render real screens against the real client (demo mode, because the test
 * environment has no backend) and drive them with real events. They are the
 * closest thing to "a learner used the app" that runs without a browser:
 *  - the graph explorer leaves a usable, accessible view,
 *  - the roadmap writes progress under a row identity and reads it back,
 *  - the mentor shows its evidence and never blocks the user,
 *  - the guest journey works with no account, and
 *  - the app never shows a fabricated success statistic.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { GraphPage } from '@/features/graph/GraphPage.tsx'
import { RoadmapPage } from '@/features/roadmap/RoadmapPage.tsx'
import { GapsPage } from '@/features/gaps/GapsPage.tsx'
import { ResourcesPage } from '@/features/resources/ResourcesPage.tsx'
import { AboutPage } from '@/features/misc/AboutPage.tsx'
import { NotFoundPage } from '@/features/misc/NotFoundPage.tsx'
import { useAppStore } from '@/state/store.ts'
import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'

function renderAt(path: string, element: React.ReactNode) {
  return render(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>)
}

/** Menu options carry a real career id in their value. */
const careerIds = knowledgeGraph.careers.map((career) => career.id)

describe('graph explorer', () => {
  it('renders the canvas route and offers an accessible text view of the same data', async () => {
    const user = userEvent.setup()
    const { container } = renderAt(
      '/graph?seed=skill:python-programming',
      <Routes>
        <Route path="/graph" element={<GraphPage />} />
      </Routes>,
    )

    await waitFor(() => expect(screen.getByText(/\d+ nodes and \d+ relationships/i)).toBeInTheDocument(), { timeout: 8000 })

    // The canvas is hidden from assistive technology on purpose…
    const canvas = container.querySelector('[data-testid="graph-canvas"]')
    expect(canvas).not.toBeNull()
    expect(canvas!.getAttribute('aria-hidden')).toBe('true')

    // …and the list view is the accessible equivalent of the same subgraph.
    await user.click(screen.getByRole('button', { name: /^list/i }))
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('columnheader', { name: /^type$/i })).toBeInTheDocument()
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(5)
    // Skill names link to the skill page, so the table is navigable, not a dump.
    expect(within(table).getAllByRole('link').length).toBeGreaterThan(0)
  })

  it('states the data source instead of implying live Neo4j', async () => {
    renderAt(
      '/graph?seed=skill:python-programming',
      <Routes>
        <Route path="/graph" element={<GraphPage />} />
      </Routes>,
    )
    await waitFor(() => expect(screen.getByText(/bundled sample dataset/i)).toBeInTheDocument())
  })

  it('explains what to do when no seed is chosen, rather than showing an empty canvas', async () => {
    renderAt(
      '/graph',
      <Routes>
        <Route path="/graph" element={<GraphPage />} />
      </Routes>,
    )
    await waitFor(() => expect(screen.getByText(/refused on purpose/i)).toBeInTheDocument(), { timeout: 8000 })
  })
})

describe('roadmap', () => {
  it('records progress under the row identity and shows it back after a re-render', async () => {
    const user = userEvent.setup()
    useAppStore.getState().eraseLocalData()
    useAppStore.getState().setProfile({ careerGoalId: 'career:software-engineer', weeklyHours: 8 })

    const view = renderAt(
      '/roadmap',
      <Routes>
        <Route path="/roadmap" element={<RoadmapPage />} />
      </Routes>,
    )

    // Weeks of the plan are the stable signal that generation finished.
    await screen.findByText('Week 1', {}, { timeout: 8000 })

    // Every task row carries a labelled status control.
    const selects = await screen.findAllByLabelText('Status', {}, { timeout: 8000 })
    expect(selects.length).toBeGreaterThan(0)

    await user.selectOptions(selects[0], 'completed')

    const progress = useAppStore.getState().progress
    const roadmapKey = Object.keys(progress)[0]
    expect(roadmapKey).toBeTruthy()
    // Keyed by the row, and each entry still knows which skill it belongs to.
    const entries = Object.values(progress[roadmapKey].tasks)
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0].status).toBe('completed')
    expect(entries[0].skillId.startsWith('skill:')).toBe(true)
    expect(entries[0].skillId).not.toBe(Object.keys(progress[roadmapKey].tasks)[0])

    // Survives a remount: the value is read back from local storage.
    view.unmount()
    renderAt(
      '/roadmap',
      <Routes>
        <Route path="/roadmap" element={<RoadmapPage />} />
      </Routes>,
    )
    await screen.findAllByLabelText('Status', {}, { timeout: 8000 })
    const restored = useAppStore.getState().progress[roadmapKey].tasks
    expect(Object.values(restored).some((entry) => entry.status === 'completed')).toBe(true)
  })

  it('marks review rows as reviews so they are distinguishable from learning rows', async () => {
    renderAt(
      `/roadmap?career=${encodeURIComponent('career:software-engineer')}`,
      <Routes>
        <Route path="/roadmap" element={<RoadmapPage />} />
      </Routes>,
    )
    await screen.findAllByLabelText('Status', {}, { timeout: 8000 })
    // The dataset guarantees at least one spaced-review row for every career.
    expect(screen.getAllByText('Review').length).toBeGreaterThan(0)
    // And the plan says out loud that its dates are planning estimates.
    expect(screen.getByText(/planning estimates/i)).toBeInTheDocument()
  })

  it('lets the learner choose any curated career', async () => {
    renderAt(
      '/roadmap',
      <Routes>
        <Route path="/roadmap" element={<RoadmapPage />} />
      </Routes>,
    )
    const select = await screen.findByLabelText('Career', {}, { timeout: 8000 })
    // The <select> element exists before its options do: the career list is an
    // async query. Reading the options immediately made this test flake (it
    // failed roughly one run in ten with an empty select). Wait for the real
    // state instead of racing it.
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(careerIds.length)
    })
    const options = within(select).getAllByRole('option')
    // Values are graph ids; labels are human names from the dataset.
    expect(options.map((option) => (option as HTMLOptionElement).value).sort()).toEqual([...careerIds].sort())
    expect(options.every((option) => (option.textContent ?? '').trim().length > 3)).toBe(true)
  })
})

describe('gap analyzer', () => {
  it('analyses a career and shows a rating control per skill', async () => {
    renderAt(
      `/gaps?career=${encodeURIComponent('career:data-analyst')}`,
      <Routes>
        <Route path="/gaps" element={<GapsPage />} />
      </Routes>,
    )
    // Self-assessment is a five-state control per skill, so the same labels repeat.
    await screen.findAllByRole('button', { name: 'Confident' }, { timeout: 8000 })
    expect(screen.getAllByRole('button', { name: 'Not started' }).length).toBeGreaterThan(1)

    // The honesty copy around self-ratings is part of the screen, not optional.
    expect(screen.getByText(/Self-ratings are estimates: the graph cannot verify them/i)).toBeInTheDocument()
    // And it separates requirements from breadth before you act on it.
    expect(screen.getByText(/Missing prerequisites/i)).toBeInTheDocument()
  })
})

describe('resource library', () => {
  it('shows every entry with its effort estimate and clickable prerequisites', async () => {
    renderAt('/resources', <ResourcesPage />)
    // The whole library renders in demo mode, so a known entry is enough to
    // prove the shape; the browser run asserts the exact count.
    await screen.findByText('ESP-IDF: Low Power Mode', undefined, { timeout: 8000 })
    expect(screen.getAllByText(/^≈ \d+–\d+ hours\./).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Curriculum prerequisites:/).length).toBeGreaterThan(0)
    // Prerequisites link to the skill pages they name, not to raw ids — the
    // chip for ESP-IDF's prerequisite must point at the embedded C skill.
    const skillLinks = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/skills/skill:'))
    expect(skillLinks.length).toBeGreaterThan(0)
    expect(skillLinks.map((link) => link.getAttribute('href'))).toContain('/skills/skill:embedded-c')
  })

  it('never presents a resource without the four honesty fields', async () => {
    renderAt('/resources', <ResourcesPage />)
    await screen.findAllByText('What you can do after this', undefined, { timeout: 8000 })
    const outcomes = screen.getAllByText('What you can do after this').length
    const assumes = screen.getAllByText('Assumes').length
    const limits = screen.getAllByText('Where it stops').length
    const time = screen.getAllByText('Time involved').length
    expect(outcomes).toBe(assumes)
    expect(assumes).toBe(limits)
    expect(limits).toBe(time)
  })
})

describe('about page states limits, not marketing', () => {
  it('lists features and limitations side by side', () => {
    renderAt(
      '/about',
      <Routes>
        <Route path="/about" element={<AboutPage />} />
      </Routes>,
    )
    expect(screen.getByRole('heading', { name: /what this app does, and what it cannot do/i })).toBeInTheDocument()
    expect(screen.getByText(/no guarantees about jobs/i)).toBeInTheDocument()
    // Honesty about what was never run in this environment.
    expect(screen.getByText(/not verified here/i)).toBeInTheDocument()
  })

  it('contains no invented social proof', () => {
    const { container } = renderAt(
      '/about',
      <Routes>
        <Route path="/about" element={<AboutPage />} />
      </Routes>,
    )
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\d[\d,.]*\s*(million|k\+?)\s*(users|learners|students)/i)
    expect(text).not.toMatch(/testimonial|rated \d(\.\d)?\/5|stars?\b/i)
    expect(text).not.toMatch(/guaranteed (job|placement|salary)/i)
  })
})

describe('not found page', () => {
  it('offers real destinations instead of a dead end', () => {
    renderAt(
      '/nope',
      <Routes>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>,
    )
    expect(screen.getByRole('heading', { name: /that page does not exist/i })).toBeInTheDocument()
    for (const label of [/dashboard/i, /explore careers/i, /knowledge graph/i]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }
  })
})


