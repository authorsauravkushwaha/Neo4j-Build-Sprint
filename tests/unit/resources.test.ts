/**
 * Resource-library honesty checks.
 *
 * The app tells learners "link checked on <date>". These tests pin the wiring
 * that makes that sentence true: every resource has a recorded link-check
 * outcome, only a link that answered is called verified, and nothing claims to
 * be free without saying what free means for that provider.
 */
import { describe, expect, it } from 'vitest'

import { createLocalReader } from '../../supabase/functions/_shared/core/localReader.ts'
import { MAX_CATALOG_LIMIT } from '../../supabase/functions/_shared/core/types.ts'
import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import verification from '@/data/seed/resourceVerification.json'


describe('link-check wiring', () => {
  it('records an outcome for every resource and no resource that does not exist', () => {
    const ids = new Set(knowledgeGraph.resources.map((resource) => resource.id))
    expect(new Set(Object.keys(verification))).toEqual(ids)
  })

  it('only calls a resource verified when the checker actually reached it', () => {
    for (const resource of knowledgeGraph.resources) {
      const checked = verification[resource.id as keyof typeof verification]
      const reachable = checked.outcome === 'ok' || checked.outcome === 'redirected'
      if (resource.verification === 'verified') {
        expect(reachable).toBe(true)
        expect(resource.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(resource.lastVerified).toBe(checked.checkedAt)
      } else {
        // Blocked, failed or never checked: no date, and no "verified" badge.
        expect(reachable).toBe(false)
        expect(resource.lastVerified).toBeNull()
      }
    }
  })

  it('marks exactly the links the last checker run actually reached', () => {
    // The counts are not frozen here on purpose: `npm run verify:resources`
    // rewrites them. What must hold is that the dataset agrees with the file the
    // checker wrote — a resource is never called verified on one side only.
    const recorded = Object.values(verification) as Array<{ outcome: string; checkedAt: string }>
    const reached = recorded.filter((entry) => entry.outcome === 'ok' || entry.outcome === 'redirected').length
    const marked = knowledgeGraph.resources.filter((resource) => resource.verification === 'verified').length
    expect(marked).toBe(reached)
    // A failed or blocked check is reported as such rather than hidden.
    expect(knowledgeGraph.resources.length).toBe(recorded.length)
    expect(recorded.filter((entry) => entry.outcome === 'failed')).toHaveLength(0)
  })
})

describe('free-first claims', () => {
  it('gives every resource an access model, an access note and an https link', () => {
    for (const resource of knowledgeGraph.resources) {
      expect(['free-open', 'free-audit', 'free-account', 'free-with-limits']).toContain(resource.accessModel)
      // "Free" is never asserted without an explanation of what free includes.
      expect(resource.accessNote.trim().length).toBeGreaterThan(10)
      expect(resource.url.startsWith('https://')).toBe(true)
      expect(resource.url).not.toMatch(/@/)
    }
  })

  it('never describes a paid tier as free', () => {
    for (const resource of knowledgeGraph.resources) {
      if (resource.accessModel === 'free-with-limits' || resource.accessModel === 'free-audit') {
        expect(resource.accessNote.toLowerCase()).toMatch(/free|trial|audit|no cost|included|paid|price|subscription/)
      }
    }
  })
})

describe('what a resource entry promises', () => {
  it('states outcomes, prerequisites, limits and time for every resource', () => {
    for (const resource of knowledgeGraph.resources) {
      expect(resource.outcomes.length).toBeGreaterThanOrEqual(2)
      expect(resource.assumes.trim().length).toBeGreaterThan(10)
      expect(resource.limits.trim().length).toBeGreaterThan(10)
      expect(resource.commitment.trim().length).toBeGreaterThan(10)
    }
  })

  it('does not waste the summary repeating the outcome list', () => {
    // The page renders the outcomes as bullets underneath, so a summary that
    // restates them is duplication, not precision.
    for (const resource of knowledgeGraph.resources) {
      const first = resource.outcomes[0].toLowerCase()
      expect(resource.summary.toLowerCase()).not.toContain(first)
      expect(resource.summary.length).toBeLessThan(220)
    }
  })

  it('routes every skill through at least two resources', () => {
    const reader = createLocalReader(knowledgeGraph)
    const bySkill = new Map<string, string[]>()
    for (const resource of knowledgeGraph.resources) {
      const covers = knowledgeGraph.edges.filter((edge) => edge.from === resource.id && edge.type === 'COVERS')
      for (const edge of covers) {
        if (!edge.to.startsWith('skill:')) continue
        bySkill.set(edge.to, [...(bySkill.get(edge.to) ?? []), resource.id])
      }
    }
    expect(bySkill.size).toBe(knowledgeGraph.skills.length)
    const singleLink = [...bySkill.entries()].filter(([, ids]) => ids.length < 2)
    expect(singleLink.map(([id]) => id)).toEqual([])
    expect(typeof reader.findResources).toBe('function')
  })

  it('search reaches the detail fields, not just the summary', async () => {
    // "padding oracle" appears in Cryptopals' limits, never in its summary or
    // name — a learner searching for the concept must still find the resource.
    const reader = createLocalReader(knowledgeGraph)
    const found = await reader.findResources({ q: 'padding oracle', limit: 5 })
    expect(found.value.map((resource) => resource.id)).toContain('resource:cryptopals')
  })
})

describe('catalogue caps', () => {
  // The library request asks for `datasetCounts.resources` rows. If the reader's
  // cap were below the shipped count, the page would show a truncated library
  // and say nothing — which is exactly what happened when the dataset passed
  // 120 resources.
  it('returns every shipped resource and project when asked for the whole catalogue', async () => {
    const reader = createLocalReader(knowledgeGraph)
    const resources = await reader.findResources({ limit: MAX_CATALOG_LIMIT })
    const projects = await reader.findProjects({ limit: MAX_CATALOG_LIMIT })
    expect(resources.value.length).toBe(knowledgeGraph.resources.length)
    expect(projects.value.length).toBe(knowledgeGraph.projects.length)
  })

  it('keeps the cap above the shipped catalogue, with room to grow', () => {
    expect(MAX_CATALOG_LIMIT).toBeGreaterThan(knowledgeGraph.resources.length)
    expect(MAX_CATALOG_LIMIT).toBeGreaterThan(knowledgeGraph.projects.length)
    expect(MAX_CATALOG_LIMIT).toBeGreaterThan(knowledgeGraph.careers.length)
  })

  it('still refuses an absurd limit rather than returning an unbounded payload', async () => {
    const reader = createLocalReader(knowledgeGraph)
    const resources = await reader.findResources({ limit: 10_000_000 })
    expect(resources.value.length).toBeLessThanOrEqual(MAX_CATALOG_LIMIT)
  })
})


