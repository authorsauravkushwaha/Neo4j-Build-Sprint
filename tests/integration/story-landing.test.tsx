/**
 * The story page, as a document.
 *
 * The landing page is now a scroll story, which introduces the failure mode this
 * file exists to prevent: content that only exists *after* an interaction. A
 * pinned scene lets you hide two thirds of your copy behind a scroll, and the
 * page still looks complete to the person who built it, because they scroll.
 *
 * So these tests treat the page as what it also is — a document — and require it
 * to be whole without a single scroll event:
 *
 *   * every chapter named in the chapter bar is a real section on the page,
 *   * every scene step's copy is in the DOM at first render,
 *   * under reduced motion the page renders the stacked form and the same words,
 *   * the numbers on the page are the engine's numbers, not literals.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { LandingPage } from '@/features/landing/LandingPage.tsx'
import { storyChapters } from '@/features/landing/storyChapters.ts'
import { knowledgeGraph, datasetCounts } from '@/data/seed/knowledgeGraph.ts'
import { problemSceneSteps } from '@/features/landing/storyScenes.tsx'

function renderStory(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  )
}

describe('the story page as a document', () => {
  it('has a real section for every chapter it advertises', () => {
    renderStory()
    for (const chapter of storyChapters) {
      const section = document.getElementById(chapter.id)
      expect(section, `chapter ${chapter.id} has no section`).not.toBeNull()
      // The anchor in the chapter bar must actually reach it. The accessible
      // name carries the index prefix ("01 Why a list fails"), so the check is
      // on the href rather than on a name pattern — a name that happens to
      // contain the label is not the same thing as a link that goes there.
      const link = Array.from(document.querySelectorAll('.gm-storynav-link')).find(
        (node) => node.getAttribute('href') === `#${chapter.id}`,
      )
      expect(link, `no chapter link points at #${chapter.id}`).not.toBeUndefined()
      expect(link?.textContent ?? '').toMatch(new RegExp(chapter.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    }
  })

  it('keeps every step of every scene in the document, without scrolling', () => {
    renderStory()
    for (const step of problemSceneSteps()) {
      expect(screen.getAllByText(step.kicker).length, step.id).toBeGreaterThan(0)
      expect(screen.getAllByText(step.title).length, step.id).toBeGreaterThan(0)
    }
    // The scene's own heading and its hint.
    expect(screen.getByRole('heading', { name: /why a course list cannot answer this/i })).toBeInTheDocument()
  })

  it('states its own limits rather than only its features', () => {
    renderStory()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/curated sample, not a global standard/i)
    expect(text).toMatch(/hours are estimates, not a schedule/i)
    expect(text).toMatch(/no guarantee of employment/i)
    expect(text).toMatch(/docs\/security\.md/)
  })

  it('renders the whole story under reduced motion, and pins nothing', () => {
    document.documentElement.dataset.motion = 'reduced'
    const { container } = renderStory()
    // No pinned branch at all — not a disabled one, not a hidden one.
    expect(container.querySelector('[data-testid="scene-pinned"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="scene-stacked"]').length).toBeGreaterThan(0)
    // And the copy is all still there.
    const text = document.body.textContent ?? ''
    for (const step of problemSceneSteps()) {
      expect(text, step.title).toContain(step.title)
    }
    expect(text).toMatch(/fixed composition/i)
    expect(text).toMatch(/not live data/i)
    document.documentElement.dataset.motion = 'full'
  })

  it('shows the engine its own numbers once the frontier resolves', async () => {
    renderStory()
    await waitFor(() => expect(screen.getByTestId('worked-example-from-zero-summary')).toBeInTheDocument(), { timeout: 8000 })
    const summary = screen.getByTestId('worked-example-from-zero-summary').textContent ?? ''
    expect(summary).toMatch(/^\d+ skill\(s\) to go: \d+ startable now/)
    /*
     * The scene copy and the worked-example summary must be the *same*
     * computation. Both are read out of the rendered page and compared here,
     * rather than each being checked against a literal — a literal would pass
     * even if the two blocks had drifted apart, which is the failure this
     * guards against.
     */
    const remaining = Number(summary.match(/^(\d+) skill/)?.[1] ?? -1)
    const chain = Number(summary.match(/longest chain (\d+) deep/)?.[1] ?? -1)
    expect(remaining).toBeGreaterThan(2)
    expect(chain).toBeGreaterThan(1)
    const text = document.body.textContent ?? ''
    expect(text).toContain(`${remaining} skills still to go`)
    expect(text).toContain(`${chain} skills deep`)
    expect(text).toMatch(/cannot be shortened/)
  })

  it('lists every career in the dataset, and links each one', () => {
    const { container } = renderStory()
    /*
     * Counted from the DOM rather than from the accessibility tree on purpose:
     * the card stack marks its off-screen slides `inert`, which is correct for a
     * screen reader and means a role query only ever sees the visible one. The
     * question here is whether every career has a link somewhere on the page —
     * a link you can reach by scrolling, by keyboard, or by turning motion off.
     */
    const careerLinks = Array.from(container.querySelectorAll('a[href^="/careers/"]'))
    expect(careerLinks.length).toBeGreaterThanOrEqual(datasetCounts.careers)
    for (const career of knowledgeGraph.careers) {
      const href = `/careers/${encodeURIComponent(career.id)}`
      expect(careerLinks.some((link) => link.getAttribute('href') === href), `${career.id} has no link`).toBe(true)
    }
    // And the marquee's accessible copy is the real list, not the echo.
    expect(screen.getByRole('list', { name: /careers in this curriculum/i })).toBeInTheDocument()
  })

  it('never counts a career card with a number the graph does not support', () => {
    renderStory()
    // Essential counts come from REQUIRES_SKILL edges, so the page cannot claim a
    // number the dataset validator would reject.
    const essential = new Map<string, number>()
    for (const edge of knowledgeGraph.edges) {
      if (edge.type !== 'REQUIRES_SKILL' || edge.essential === false) continue
      essential.set(edge.from, (essential.get(edge.from) ?? 0) + 1)
    }
    const text = document.body.textContent ?? ''
    for (const career of knowledgeGraph.careers) {
      const count = essential.get(career.id) ?? 0
      if (count === 0) continue
      expect(text).toContain(`${count} essential`)
    }
  })
})
