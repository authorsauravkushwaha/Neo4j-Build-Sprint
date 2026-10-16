/**
 * The constellation has to be the graph, not a picture of a graph.
 *
 * `features/landing/storyGraph.ts` is the only place where a data structure turns
 * into coordinates, which makes it the only place where the landing page could
 * quietly start lying: a node placed by taste, an edge drawn between two skills
 * that are not related, a caption claiming a total the sample does not support.
 *
 * So these tests assert the *provenance* of every drawn thing:
 *
 *   * each node traces back to a skill in the report,
 *   * each edge traces back to a `needsNow` entry — the engine's own list,
 *   * depth is used as the horizontal axis, so order is visible and correct,
 *   * the caption states the total whenever it draws a sample,
 *   * the whole thing is deterministic: same report in, same coordinates out.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import { analyzeFrontier } from '@core/recommend.ts'
import type { FrontierReport } from '@core/recommend.ts'
import type { UserSkillRating } from '@core/types.ts'
import { createLocalReader } from '@core/localReader.ts'
import { loadCareerSlice } from '@core/careerSlice.ts'
import { constellationFromFrontier, gateLeverage, gateSetLeverage } from '@/features/landing/storyGraph.ts'

/**
 * Build the report exactly the way the app builds it.
 *
 * The first draft of this file assembled the engine input by hand from
 * `knowledgeGraph`. It type-checked loosely enough to compile, and it was
 * *wrong*: the edges it passed had no `type` field, so `buildPrereqGraph` skipped
 * every one of them and the frontier came back saying every skill was startable
 * immediately and no chain was deeper than one. Those numbers were plausible, and
 * the page would have printed them.
 *
 * So the harness now goes through `createLocalReader` + `loadCareerSlice` +
 * `analyzeFrontier` — the same three production calls demo mode makes — and the
 * compiler enforces the row shapes for it. If this file's report and the app's
 * report can diverge, they cannot do it here.
 */
const reader = createLocalReader(knowledgeGraph)

async function report(ratings: UserSkillRating[] = []): Promise<FrontierReport> {
  const slice = await loadCareerSlice(reader, 'career:software-engineer', { depth: 6, maxSkills: 400 })
  return analyzeFrontier({
    careerId: slice.careerId,
    careerName: slice.careerName,
    careerSkills: slice.careerSkills,
    skillMeta: slice.skillMeta,
    prereqEdges: slice.prereqEdges,
    ratings,
    weeklyHours: 8,
  })
}

describe('the constellation is derived from the report', () => {
  // One real report, reused: it is the input every assertion below describes.
  let fromZero: FrontierReport
  beforeAll(async () => {
    fromZero = await report()
  })

  it('places every drawn node inside the viewBox', () => {
    const constellation = constellationFromFrontier(fromZero)
    expect(constellation.nodes.length).toBeGreaterThan(5)
    for (const node of constellation.nodes) {
      expect(node.x, `${node.id} x`).toBeGreaterThanOrEqual(0)
      expect(node.x, `${node.id} x`).toBeLessThanOrEqual(100)
      expect(node.y, `${node.id} y`).toBeGreaterThanOrEqual(0)
      expect(node.y, `${node.id} y`).toBeLessThanOrEqual(100)
    }
  })

  it('uses dependency depth as the horizontal axis', () => {
    const constellation = constellationFromFrontier(fromZero)
    const depthOf = new Map(fromZero.remaining.map((skill) => [skill.skillId, skill.depth]))
    const xOf = new Map(constellation.nodes.map((node) => [node.id, node.x]))
    for (const skill of fromZero.remaining) {
      const deeper = fromZero.remaining.filter((other) => other.needsNow.includes(skill.skillId))
      for (const dependent of deeper) {
        // A skill always sits to the left of everything that needs it.
        const left = xOf.get(skill.skillId)
        const right = xOf.get(dependent.skillId)
        if (left === undefined || right === undefined) continue
        expect(left, `${skill.skillId} vs ${dependent.skillId}`).toBeLessThan(right)
        expect(depthOf.get(dependent.skillId)).toBeGreaterThan(depthOf.get(skill.skillId) ?? 0)
      }
    }
  })

  it('only draws edges the graph actually contains, with both ends on the canvas', () => {
    const constellation = constellationFromFrontier(fromZero)
    const drawn = new Set(constellation.nodes.map((node) => node.id))
    const realEdges = new Set(
      fromZero.remaining.flatMap((skill) => skill.needsNow.map((need) => `${need}->${skill.skillId}`)),
    )
    expect(constellation.edges.length).toBeGreaterThan(3)
    for (const edge of constellation.edges) {
      expect(drawn.has(edge.from), `${edge.from} is not on the canvas`).toBe(true)
      expect(drawn.has(edge.to), `${edge.to} is not on the canvas`).toBe(true)
      if (edge.to === fromZero.careerId) continue
      expect(realEdges.has(`${edge.from}->${edge.to}`), `${edge.from}->${edge.to} is not a prerequisite`).toBe(true)
    }
  })

  it('writes the chain, the frontier and the rest differently, from the engine s own sets', () => {
    const constellation = constellationFromFrontier(fromZero)
    const chain = new Set(fromZero.criticalChain.map((step) => step.skillId))
    const frontier = new Set(fromZero.frontier.map((skill) => skill.skillId))
    for (const node of constellation.nodes) {
      if (node.kind !== 'skill') continue
      const expected = chain.has(node.id) ? 'chain' : frontier.has(node.id) ? 'frontier' : 'later'
      expect(node.state, `${node.id}`).toBe(expected)
      expect(node.label).toBe(fromZero.remaining.find((skill) => skill.skillId === node.id)?.name)
    }
    // The target is the career itself, drawn at the right-hand edge.
    const target = constellation.nodes.find((node) => node.id === fromZero.careerId)
    expect(target?.kind).toBe('career')
    expect(target?.label).toBe(fromZero.careerName)
  })

  it('is deterministic, so a visual diff means the data changed', () => {
    const a = constellationFromFrontier(fromZero)
    const b = constellationFromFrontier(fromZero)
    expect(a.nodes).toEqual(b.nodes)
    expect(a.edges).toEqual(b.edges)
  })

  it('says what it sampled from when it cannot draw everything', () => {
    const constellation = constellationFromFrontier(fromZero, { maxNodes: 6 })
    expect(constellation.drawn).toBeLessThanOrEqual(6)
    expect(constellation.drawn).toBe(6)
    expect(constellation.total).toBe(fromZero.remainingCount)
    expect(constellation.caption).toMatch(/bundled curriculum/i)
    // The full count must be stated, not silently dropped.
    expect(constellation.caption).toContain(String(fromZero.remainingCount))
  })

  it('draws the whole set, and says so, when it fits', () => {
    const constellation = constellationFromFrontier(fromZero, { maxNodes: 500 })
    expect(constellation.drawn).toBe(fromZero.remainingCount)
    expect(constellation.caption).toMatch(/All \d+ are drawn here/)
  })

  it('changes when the input profile changes', async () => {
    const inField = await report([{ skillId: 'skill:programming-fundamentals', state: 'confident' }])
    expect(inField.remainingCount).toBeLessThan(fromZero.remainingCount)
    const constellation = constellationFromFrontier(inField)
    expect(constellation.total).toBe(inField.remainingCount)
    // A skill the person already has must not be drawn as a remaining node.
    expect(constellation.nodes.some((node) => node.id === 'skill:programming-fundamentals')).toBe(false)
  })
})

describe('gate leverage', () => {
  it("quotes the engine's transitive count, not a count of direct neighbours", async () => {
    const fromZero = await report()
    const gate = fromZero.gates[0]
    expect(gate).toBeDefined()
    const leverage = gateLeverage(fromZero, gate!.skillId)
    // Exactly the engine's number, so the page and the gap screen cannot
    // disagree about what the same skill is worth.
    expect(leverage.unlocked).toBe(gate!.unlocks)
    expect(leverage.share).toBeCloseTo(gate!.unlocks / fromZero.remainingCount, 6)
    expect(leverage.share).toBeGreaterThan(0)
    expect(leverage.share).toBeLessThanOrEqual(1)
  })

  it('never lets the gate set exceed the sum of its members', async () => {
    const fromZero = await report()
    const sum = fromZero.gates.reduce((total, gate) => total + gate.unlocks, 0)
    expect(fromZero.gatesUnlock).toBeLessThanOrEqual(sum)
    /*
     * The naive invariant — "the union is at least the largest single member" —
     * is *false* here, and the reason is worth keeping rather than deleting the
     * assertion: a gate's own `unlocks` counts every remaining skill that depends
     * on it, *including the other gates*, while `gatesUnlock` deliberately
     * excludes the gates themselves ("the gates are work to do, not work they
     * unlock"). So the two numbers answer different questions and must not be
     * compared as if one contained the other. The page quotes each in its own
     * sentence for exactly this reason.
     */
    expect(fromZero.gatesUnlock).toBeLessThanOrEqual(fromZero.remainingCount - fromZero.gates.length)
    expect(gateSetLeverage(fromZero)).toBeCloseTo(fromZero.gatesUnlock / fromZero.remainingCount, 6)
  })

  it('is zero for a skill that is not in the report, and for a career with nothing left', async () => {
    const fromZero = await report()
    expect(gateLeverage(fromZero, 'skill:not-in-this-graph')).toEqual({ unlocked: 0, share: 0 })
    const done = await report(knowledgeGraph.skills.map((skill) => ({ skillId: skill.id, state: 'confident' as const })))
    expect(done.remainingCount).toBe(0)
    expect(gateSetLeverage(done)).toBe(0)
  })
})
