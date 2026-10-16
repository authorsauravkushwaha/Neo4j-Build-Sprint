/**
 * The scroll layer is used across the site, and switched off in one place.
 *
 * Two failure modes this file exists to catch, both of which happened while this
 * layer was being built:
 *
 *   1. **The layer lived on one page.** The motion components were real, tested
 *      and documented — and used by the landing page alone, so every screen a
 *      learner actually spends time on (a twelve-week roadmap, a 154-item
 *      resource library, the gap report) was a static document with a scrollbar.
 *      The list below is the fix, and a regression on it is a page silently
 *      losing its entrance.
 *   2. **An effect with no kill switch.** Adding `transition: transform` without
 *      the matching `[data-motion='reduced']` rule leaves one element moving for
 *      a user who asked everything to stop, which is exactly the bug
 *      `motion-preference.test.ts` was written for. Every class this layer adds is
 *      checked for a kill switch here.
 *
 * The second half of the file is the opposite claim: filter bars, form fields and
 * chat transcripts are *not* animated, on purpose. A control layout that arrives
 * in sequence makes the user wait to use it, and a transcript that re-animates
 * re-animates history.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const css = readFileSync(resolve(root, 'src/styles/index.css'), 'utf8')

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

/** Pages that render a list of independent content items and give it an entrance. */
const CHOREOGRAPHED_PAGES = [
  'src/features/dashboard/DashboardPage.tsx',
  'src/features/careers/CareersPage.tsx',
  'src/features/careers/CareerDetailPage.tsx',
  'src/features/skills/SkillsIndexPage.tsx',
  'src/features/projects/ProjectsPage.tsx',
  'src/features/resources/ResourcesPage.tsx',
  'src/features/progress/ProgressPage.tsx',
  'src/features/roadmap/RoadmapPage.tsx',
  'src/features/roadmap/PathwayPage.tsx',
  'src/features/gaps/GapsPage.tsx',
  'src/features/workflows/WorkflowsPage.tsx',
  'src/features/misc/AboutPage.tsx',
  'src/features/apis/ApisPage.tsx',
]

/** Classes this layer introduces, each of which needs a reduced-motion rule. */
const ANIMATED_CLASSES = ['gm-stagger', 'gm-section-body', 'gm-page-enter', 'gm-appbar-identity', 'gm-appbar-tagline']

describe('every screen is part of the scroll experience', () => {
  it('gives each content page an entrance from the motion layer', () => {
    for (const page of CHOREOGRAPHED_PAGES) {
      const text = source(page)
      expect(text, `${page} no longer imports the motion layer`).toMatch(/from '@\/skiper\//)
      expect(text, `${page} stages nothing: no Stagger or Reveal`).toMatch(/<Stagger\b|<Reveal\b|<RevealCss\b|<CountUpStat\b/)
    }
  })

  it('mounts the shell chrome once, for every route, in the layout', () => {
    const layout = source('src/app/Layout.tsx')
    expect(layout).toMatch(/<AppScrollRail \/>/)
    expect(layout).toMatch(/<BackToTop \/>/)
    expect(layout).toMatch(/<PageTransition routeKey=\{location\.pathname\}>/)
    expect(layout).toMatch(/useScrollFlag/)
    // Keyed by pathname, not by the whole location: a query-string change must
    // not remount the screen and throw away its scroll position.
    expect(layout).not.toMatch(/routeKey=\{location\.(key|search|hash)\}/)
  })

  it('stages ordered lists in order, and states that the order is the graph`s', () => {
    // The pathway's steps are the one place where arriving in sequence is not
    // decoration: the sequence *is* the dependency order the engine computed.
    const pathway = source('src/features/roadmap/PathwayPage.tsx')
    expect(pathway).toMatch(/<Stagger as="ol" className="space-y-3">/)
    const roadmap = source('src/features/roadmap/RoadmapPage.tsx')
    // The week heading pins while its own week scrolls past.
    expect(roadmap).toMatch(/<SectionTitle sticky hint=/)
  })

  it('leaves the filter bars alone', () => {
    // Every filter card in the app is `<Card className="mb-5">` wrapping a plain
    // `Grid`. It is asserted rather than assumed because it is the rule most
    // likely to be broken by a well-meaning sweep: "add Stagger to every list"
    // would animate the controls the reader is trying to reach.
    const pages = [
      'src/features/gaps/GapsPage.tsx',
      'src/features/projects/ProjectsPage.tsx',
      'src/features/roadmap/RoadmapPage.tsx',
      'src/features/skills/SkillsIndexPage.tsx',
      'src/features/resources/ResourcesPage.tsx',
      'src/features/careers/CareersPage.tsx',
    ]
    let checked = 0
    for (const page of pages) {
      const text = source(page)
      const filterCard = /<Card className="mb-5">\s*\n\s*<Grid cols=\{\d\}>/.exec(text)
      if (!filterCard) continue
      checked += 1
      expect(filterCard[0], `${page} staggers its controls`).not.toMatch(/Stagger/)
    }
    expect(checked).toBeGreaterThanOrEqual(3)

    // And no page hand-rolls a transition; every one comes from the shared layer.
    for (const page of CHOREOGRAPHED_PAGES) {
      expect(source(page), `${page} hand-rolled a transition`).not.toMatch(/transition-all/)
    }
  })
})

describe('the reduced-motion kill switches', () => {
  it('neutralise every class the layer animates', () => {
    const killSwitch = css.slice(css.indexOf('[data-motion=\'reduced\'] .gm-appbar-identity'))
    for (const className of ANIMATED_CLASSES) {
      expect(killSwitch, `${className} has no reduced-motion rule`).toContain(`.${className}`)
    }
    // Neutralised, not shortened: opacity and transform are forced to their
    // finished values, and the animation is removed rather than sped up.
    expect(killSwitch).toMatch(/animation: none !important/)
    expect(killSwitch).toMatch(/opacity: 1 !important/)
    expect(killSwitch).toMatch(/transform: none !important/)
  })

  it('also honours the operating system preference, not only the in-app switch', () => {
    // `data-motion` covers the in-app switch; the media query covers the OS. A
    // rule that only exists for one of them is half a switch.
    const mediaBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(mediaBlock).toContain('.gm-scene-visual-layer')
    expect(css).toMatch(/\[data-motion='reduced'\] \.gm-stagger > \*/)
  })

  it('does not switch off the sticky heading, because pinning is not movement', () => {
    const stickyRule = css.slice(css.indexOf('.gm-sticky-title'))
    expect(stickyRule.slice(0, stickyRule.indexOf('}'))).toMatch(/position: sticky/)
    const killSwitch = css.slice(css.indexOf('[data-motion=\'reduced\'] .gm-appbar-identity'))
    expect(killSwitch).not.toContain('.gm-sticky-title')
  })
})

describe('the barrel file', () => {
  it('exports every component and hook in the layer', () => {
    const barrel = source('src/skiper/index.ts')
    for (const directory of ['components', 'motion']) {
      const files = readdirSync(resolve(root, 'src/skiper', directory))
      for (const file of files) {
        expect(barrel, `src/skiper/${directory}/${file} is not exported`).toContain(`./${directory}/${file}`)
      }
    }
  })
})
