/**
 * Palette ranking tests.
 *
 * The ranking is a product decision — what a learner sees first when they type
 * three letters — so it is pinned here rather than left to the browser suite.
 * These tests describe the order, not the implementation: exact before prefix
 * before word-start before substring, titles before bodies, and no match at all
 * when there genuinely is none.
 */
import { describe, expect, it } from 'vitest'

import { normalise, rankEntries, scoreEntry, type PaletteEntry } from '@/core/paletteSearch.ts'

const entry = (over: Partial<PaletteEntry> & { title: string }): PaletteEntry => ({
  id: over.id ?? over.title,
  kind: over.kind ?? 'Skill',
  title: over.title,
  ...(over.subtitle ? { subtitle: over.subtitle } : {}),
  to: over.to ?? '/skills/x',
  ...(over.keywords ? { keywords: over.keywords } : {}),
})

describe('scoreEntry', () => {
  it('ranks an exact title above a prefix, and a prefix above a substring', () => {
    const exact = scoreEntry('pid control', entry({ title: 'PID control' }))
    const prefix = scoreEntry('pid control', entry({ title: 'PID control with MATLAB' }))
    const substring = scoreEntry('pid control', entry({ title: 'Tuning a PID control loop' }))
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(substring)
  })

  it('prefers a title match over a body match even when the body is exact', () => {
    const titleMatch = scoreEntry('kicad', entry({ title: 'KiCad footprint libraries' }))
    const bodyMatch = scoreEntry('kicad', entry({ title: 'PCB layout primer', subtitle: 'kicad' }))
    expect(titleMatch).toBeGreaterThan(bodyMatch)
  })

  it('matches a word start inside a title, not just character offsets', () => {
    expect(scoreEntry('control', entry({ title: 'PID control' }))).toBeGreaterThan(0)
    expect(scoreEntry('ontrol', entry({ title: 'PID control' }))).toBeGreaterThan(0)
  })

  it('ignores accents and case, because search boxes should not be pedantic', () => {
    expect(scoreEntry('matlab', entry({ title: 'MATLAB' }))).toBeGreaterThan(0)
    expect(normalise('   Bézier  ')).toBe('bezier')
    expect(scoreEntry('bezier', entry({ title: 'Bézier curves' }))).toBeGreaterThan(0)
  })

  it('does not match out-of-order letters, because subsequence hits are noise', () => {
    // "pdc" is not "PID control" in any order a learner would type it, and the
    // subsequence class was removed after "pid" matched "Supervised learning".
    expect(scoreEntry('pdc', entry({ title: 'PID control' }))).toBe(-1)
    expect(scoreEntry('pid', entry({ title: 'Supervised learning' }))).toBe(-1)
    expect(scoreEntry('pid', entry({ title: 'Career pathway builder' }))).toBe(-1)
  })

  it('returns no match rather than a weak one', () => {
    expect(scoreEntry('quantum', entry({ title: 'PID control' }))).toBe(-1)
    expect(scoreEntry('zzz', entry({ title: 'PID control', keywords: ['control', 'tuning'] }))).toBe(-1)
  })

  it('finds an entry through its keywords — the ids, tools and providers it carries', () => {
    const project = entry({ title: 'Balance bot', kind: 'Project', keywords: ['pid-control', 'imu', 'stm32'] })
    expect(scoreEntry('stm32', project)).toBeGreaterThan(0)
  })
})

describe('rankEntries', () => {
  const entries: PaletteEntry[] = [
    entry({ id: 'page:roadmap', kind: 'Page', title: 'My roadmap', to: '/roadmap' }),
    entry({ id: 'career:aero', kind: 'Career', title: 'Aerospace engineer', to: '/careers/career:aero' }),
    entry({ id: 'skill:pid', kind: 'Skill', title: 'PID control', to: '/skills/skill:pid' }),
    entry({ id: 'skill:pid2', kind: 'Skill', title: 'PID control with MATLAB', to: '/skills/skill:pid2' }),
    entry({ id: 'project:bot', kind: 'Project', title: 'Balance bot', to: '/projects?q=Balance%20bot', keywords: ['pid'] }),
    entry({ id: 'resource:ctrl', kind: 'Resource', title: 'Control theory notes', to: '/resources?q=Control', keywords: ['pid'] }),
  ]

  it('orders groups by their best hit, so a strong match is never buried', () => {
    const groups = rankEntries(entries, 'pid')
    // "PID control" (a Skill) beats the weaker keyword hits on the project and
    // resource entries, so the Skill group comes first.
    expect(groups[0]?.kind).toBe('Skill')
    expect(groups.flatMap((group) => group.items).map((item) => item.id)).not.toContain('career:aero')
  })

  it('keeps the kind ladder as the tie-break when scores are equal', () => {
    const tied: PaletteEntry[] = [
      entry({ id: 'resource:x', kind: 'Resource', title: 'Control notes' }),
      entry({ id: 'page:gaps', kind: 'Page', title: 'Control gaps' }),
    ]
    const groups = rankEntries(tied, 'control')
    expect(groups[0]?.kind).toBe('Page')
  })

  it('returns an empty list for a query that matches nothing, rather than filler', () => {
    expect(rankEntries(entries, 'quantum mechanics')).toEqual([])
  })

  it('shows the entries in the order given when the query is empty', () => {
    const groups = rankEntries(entries, '')
    expect(groups[0]?.items[0]?.id).toBe('page:roadmap')
  })

  it('caps how much it shows so the list stays scannable', () => {
    const many = Array.from({ length: 40 }, (_, index) => entry({ id: `skill:${index}`, title: `PID variant ${index}`, kind: 'Skill' }))
    const groups = rankEntries(many, 'pid', { perGroup: 6, total: 10 })
    expect(groups.flatMap((group) => group.items).length).toBeLessThanOrEqual(10)
  })
})


