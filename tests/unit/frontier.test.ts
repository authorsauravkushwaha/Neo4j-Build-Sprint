/**
 * §6 Frontier — the answer to the two questions the product is built around.
 *
 * For someone who knows nothing: "what can I actually start today?" For someone
 * who already knows a lot: "what exactly is left, what gates it, and what cannot
 * be parallelised?" Both answers are numbers a learner acts on, and the failure
 * mode of a graph walk is a plausible-looking wrong number — the kind nobody
 * notices. So these tests pin the semantics directly rather than the shape:
 *
 *  - the frontier is exactly what has nothing unmet in front of it,
 *  - the gates are a union, never a sum (two gates unlocking the same skills
 *    must not be counted twice),
 *  - the critical chain is a real prerequisite path, not just the deepest node,
 *  - more knowledge never *increases* the remaining set,
 *  - the tuning constants the Java oracle reads are pinned here, because the
 *    oracle deliberately does not restate them.
 */
import { describe, expect, it } from 'vitest'

import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import { createLocalReader } from '@core/localReader.ts'
import { loadCareerSlice, type CareerSlice } from '@core/careerSlice.ts'
import { analyzeFrontier, compareCodeUnits, ENGINE_LIMITS, type FrontierInput } from '@core/recommend.ts'
import type { CareerSkillRow, SkillMetaRow } from '@core/graphReader.ts'
import type { Difficulty, GraphEdge, SkillState } from '@core/types.ts'

/* --------------------------------------------------------------- builders */

type Spec = {
  /** [dependent, prerequisite] — "the first one requires the second". */
  edges: Array<[string, string]>
  /** Every skill in the closure, whether or not it is a career target. */
  skills?: Array<{ id: string; name?: string; hours?: [number, number]; difficulty?: Difficulty }>
  targets?: string[]
  ratings?: Array<{ id: string; state: SkillState; quizScore?: number }>
  weeklyHours?: number
}

/** A small hand-built graph, so the semantics can be asserted exactly. */
function frontierCase(spec: Spec): FrontierInput {
  const ids = new Set<string>([
    ...spec.edges.flat(),
    ...(spec.skills ?? []).map((skill) => skill.id),
    ...(spec.targets ?? []),
    ...(spec.ratings ?? []).map((rating) => rating.id),
  ])
  const named = new Map((spec.skills ?? []).map((skill) => [skill.id, skill]))
  const targets = spec.targets ?? [...ids]

  const skillMeta: SkillMetaRow[] = [...ids].map((id) => {
    const meta = named.get(id)
    return {
      id,
      name: meta?.name ?? id,
      difficulty: meta?.difficulty ?? 'beginner',
      estimatedHoursLow: meta?.hours?.[0] ?? 10,
      estimatedHoursHigh: meta?.hours?.[1] ?? 20,
      completionCriteria: [],
      practice: [],
    }
  })
  const careerSkills: CareerSkillRow[] = targets.map((id) => ({
    id,
    name: skillMeta.find((meta) => meta.id === id)?.name ?? id,
    difficulty: 'beginner',
    essential: true,
    weight: 1,
  }))
  const prereqEdges: GraphEdge[] = spec.edges.map(([from, to], index) => ({
    id: `edge-${index}`,
    from,
    to,
    type: 'REQUIRES',
  }))

  return {
    careerId: 'career:test',
    careerName: 'Test career',
    careerSkills,
    skillMeta,
    prereqEdges,
    ratings: spec.ratings?.map((rating) => ({
      skillId: rating.id,
      state: rating.state,
      ...(rating.quizScore !== undefined ? { quizScore: rating.quizScore } : {}),
    })) ?? [],
    interests: [],
    ...(spec.weeklyHours !== undefined ? { weeklyHours: spec.weeklyHours } : {}),
  }
}

const idsOf = (rows: Array<{ skillId: string }>) => rows.map((row) => row.skillId)
const confirmed = (ids: string[]) => ids.map((id) => ({ id, state: 'confident' as SkillState }))

/* ------------------------------------------------------------ the semantics */

describe('frontier: what is startable now', () => {
  it('offers exactly the skills with nothing unmet in front of them', () => {
    // a -> b -> c, where "a requires b requires c".
    const input = frontierCase({ edges: [['a', 'b'], ['b', 'c']], targets: ['a'] })
    const report = analyzeFrontier(input)

    expect(report.remainingCount).toBe(3)
    // With nothing rated, the only startable skill is the deepest prerequisite.
    expect(idsOf(report.frontier)).toEqual(['c'])
    expect(idsOf(report.remaining)).toEqual(['c', 'b', 'a'])
    expect(report.remaining.map((row) => row.depth)).toEqual([1, 2, 3])
    // "a" needs "b" before it; that is what the reader is shown.
    expect(report.remaining.find((row) => row.skillId === 'a')?.needsNow).toEqual(['b'])
  })

  it('moves a skill onto the frontier only once its prerequisite is met', () => {
    const input = frontierCase({
      edges: [['a', 'b']],
      targets: ['a'],
      ratings: [{ id: 'b', state: 'practised' }],
    })
    const report = analyzeFrontier(input)
    expect(idsOf(report.frontier)).toEqual(['a'])
    expect(report.knownInClosure).toBe(1)
    expect(report.remainingCount).toBe(1)
  })

  it('treats the engine\'s own "met" threshold as the line: learning is not enough, practised is', () => {
    const learning = analyzeFrontier(
      frontierCase({ edges: [['a', 'b']], targets: ['a'], ratings: [{ id: 'b', state: 'learning' }] }),
    )
    expect(idsOf(learning.frontier)).toEqual(['b'])
    expect(learning.knownInClosure).toBe(0)

    const practised = analyzeFrontier(
      frontierCase({ edges: [['a', 'b']], targets: ['a'], ratings: [{ id: 'b', state: 'practised' }] }),
    )
    expect(idsOf(practised.frontier)).toEqual(['a'])
  })

  it('lets evidence move a borderline claim, but never promotes one the self-report did not support', () => {
    // The blended mastery is 0.7 * selfReport + 0.3 * quiz, so the threshold sits
    // in different places for different claims. Three consequences, all checked:
    //  - 0.4 (learning) blended with a perfect quiz peaks at 0.58: a quiz cannot
    //    promote a skill nobody claimed to have practised.
    const promoted = analyzeFrontier(
      frontierCase({ edges: [['a', 'b']], targets: ['a'], ratings: [{ id: 'b', state: 'learning', quizScore: 1 }] }),
    )
    expect(idsOf(promoted.frontier)).toEqual(['b'])

    //  - 0.7 (practised) with a failing quiz falls to 0.49: this is the soft claim
    //    that evidence can move, and it moves in the cautious direction.
    const demoted = analyzeFrontier(
      frontierCase({ edges: [['a', 'b']], targets: ['a'], ratings: [{ id: 'b', state: 'practised', quizScore: 0 }] }),
    )
    expect(idsOf(demoted.frontier)).toEqual(['b'])

    //  - 1.0 (confident) blended with a zero stays at 0.7: a confident claim is
    //    not overturned by a quiz the learner may simply have skipped.
    const held = analyzeFrontier(
      frontierCase({ edges: [['a', 'b']], targets: ['a'], ratings: [{ id: 'b', state: 'confident', quizScore: 0 }] }),
    )
    expect(idsOf(held.frontier)).toEqual(['a'])
  })

  it('reports a finished route as finished, with no invented work left over', () => {
    const report = analyzeFrontier(
      frontierCase({ edges: [['a', 'b'], ['b', 'c']], targets: ['a'], ratings: confirmed(['a', 'b', 'c']), weeklyHours: 10 }),
    )
    expect(report.remainingCount).toBe(0)
    expect(report.frontier).toHaveLength(0)
    expect(report.gates).toHaveLength(0)
    expect(report.criticalChain).toHaveLength(0)
    expect(report.hours.weeksAtWeeklyHours).toBeNull()
    expect(report.summaryLine).toContain('Nothing left in this route')
    // The caveats still stand: a finished route is not a certificate.
    expect(report.caveats.length).toBeGreaterThanOrEqual(2)
  })
})

describe('frontier: what gates the rest', () => {
  it('counts what the gate set unblocks as a union, never as a sum', () => {
    // Two gates that both unblock the same two skills. Summing their individual
    // counts would claim 4; the honest number is 2. This is the exact bug the
    // "3 gate(s) unblock 18" headline would have shipped with.
    const input = frontierCase({
      edges: [
        ['x', 'gate-a'],
        ['x', 'gate-b'],
        ['y', 'gate-a'],
        ['y', 'gate-b'],
      ],
      targets: ['x', 'y'],
    })
    const report = analyzeFrontier(input)
    const gateIds = idsOf(report.gates).sort()

    expect(gateIds).toEqual(['gate-a', 'gate-b'])
    expect(report.gates.map((gate) => gate.unlocks)).toEqual([2, 2])
    expect(report.gatesUnlock).toBe(2)
    expect(report.summaryLine).toContain('unblock 2')
  })

  it('ranks gates by how much of the route they unlock', () => {
    // "hub" is required by three targets; "leaf" by one. Both are startable.
    const input = frontierCase({
      edges: [
        ['t1', 'hub'],
        ['t2', 'hub'],
        ['t3', 'hub'],
        ['t3', 'leaf'],
      ],
      targets: ['t1', 't2', 't3'],
    })
    const report = analyzeFrontier(input)
    expect(report.gates[0]?.skillId).toBe('hub')
    expect(report.gates[0]?.unlocks).toBe(3)
    expect(report.gates.map((gate) => gate.skillId)).toContain('leaf')
  })

  it('keeps at most three gates, so the advice stays a short list', () => {
    const edges: Array<[string, string]> = []
    for (let index = 0; index < 6; index += 1) edges.push([`target-${index}`, `hub-${index}`])
    const report = analyzeFrontier(frontierCase({ edges }))
    expect(report.gates).toHaveLength(3)
  })

  it('lists the skills the career never asked for, and says so out loud', () => {
    // The target requires a prerequisite the career's own list does not contain.
    const report = analyzeFrontier(
      frontierCase({
        edges: [['target', 'hidden-prereq']],
        targets: ['target'],
        skills: [{ id: 'hidden-prereq', name: 'Hidden prerequisite' }],
      }),
    )
    expect(idsOf(report.pulledIn)).toEqual(['hidden-prereq'])
    expect(report.pulledIn[0]?.name).toBe('Hidden prerequisite')
    expect(report.caveats.some((caveat) => caveat.includes('prerequisites of the career'))).toBe(true)
  })
})

describe('frontier: what cannot be parallelised', () => {
  it('returns a real prerequisite path, not just the deepest node', () => {
    // c <- b <- a, and a separate short branch that must not be spliced in.
    const input = frontierCase({
      edges: [['a', 'b'], ['b', 'c'], ['side', 'c']],
      targets: ['a', 'side'],
    })
    const report = analyzeFrontier(input)
    expect(report.criticalChain.map((node) => node.skillId)).toEqual(['c', 'b', 'a'])

    // The chain reads prerequisite-first: each step requires the one before it.
    const edges = new Set(input.prereqEdges.map((edge) => `${edge.from}->${edge.to}`))
    for (let index = 0; index < report.criticalChain.length - 1; index += 1) {
      const prereq = report.criticalChain[index]?.skillId ?? ''
      const dependent = report.criticalChain[index + 1]?.skillId ?? ''
      expect(edges.has(`${dependent}->${prereq}`), `${dependent} does not require ${prereq}`).toBe(true)
    }
    // Its length is the deepest depth in the report, by definition.
    expect(report.criticalChain).toHaveLength(Math.max(...report.remaining.map((row) => row.depth)))
  })

  it('names every chain step, so the reader is never shown a bare id', () => {
    const report = analyzeFrontier(
      frontierCase({
        edges: [['a', 'b']],
        targets: ['a'],
        skills: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
      }),
    )
    expect(report.criticalChain.map((node) => node.name)).toEqual(['Beta', 'Alpha'])
  })

  it('survives a prerequisite cycle without hanging, and flags the affected items', () => {
    const report = analyzeFrontier(frontierCase({ edges: [['a', 'b'], ['b', 'a'], ['c', 'a']], targets: ['c'] }))
    expect(report.cyclic).toContain('a')
    expect(report.cyclic).toContain('b')
    expect(report.caveats.some((caveat) => caveat.includes('cycle'))).toBe(true)
    // Every remaining skill still gets a depth, and the chain still terminates.
    expect(report.depths).toHaveLength(report.remainingCount)
    expect(report.criticalChain.length).toBeGreaterThan(0)
  })
})

describe('frontier: determinism and ordering', () => {
  const sample = () =>
    frontierCase({
      edges: [
        ['zulu', 'alpha'],
        ['zulu', 'mike'],
        ['alpha', 'bravo'],
        ['mike', 'bravo'],
      ],
      targets: ['zulu'],
    })

  it('produces byte-identical output for identical input', () => {
    const first = analyzeFrontier({ ...sample(), generatedAt: 'fixed' })
    const second = analyzeFrontier({ ...sample(), generatedAt: 'fixed' })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.summaryLine).toBe(second.summaryLine)
  })

  it('orders the frontier by unlocks, then name, then id', () => {
    const report = analyzeFrontier(sample())
    const arrows = report.frontier.map((skill) => [skill.unlocks, skill.name, skill.skillId] as const)
    const expected = [...arrows].sort((a, b) => b[0] - a[0] || compareCodeUnits(a[1], b[1]) || compareCodeUnits(a[2], b[2]))
    expect(arrows).toEqual(expected)
  })

  it('sorts the depth index by id, so two runs can be diffed line by line', () => {
    const report = analyzeFrontier(sample())
    expect(idsOf(report.depths)).toEqual([...idsOf(report.depths)].sort(compareCodeUnits))
  })

  it('orders the work list by depth first, so the reader gets a sequence and not a soup', () => {
    const report = analyzeFrontier(sample())
    const depths = report.remaining.map((row) => row.depth)
    expect(depths).toEqual([...depths].sort((a, b) => a - b))
  })

  it('uses code-unit ordering rather than locale collation, so Java can reproduce it', () => {
    // Locale-aware collation often sorts 'Z' after 'a'; code-unit ordering does not.
    expect(compareCodeUnits('Z', 'a')).toBeLessThan(0)
    expect(compareCodeUnits('a', 'a')).toBe(0)
    expect(compareCodeUnits('skill:b', 'skill:a')).toBeGreaterThan(0)
  })
})

describe('frontier: effort, and the honesty of the numbers', () => {
  it('sums the hours of everything left and gives a range of weeks, not one number', () => {
    const report = analyzeFrontier(
      frontierCase({
        edges: [['a', 'b']],
        targets: ['a'],
        skills: [
          { id: 'a', hours: [10, 30] },
          { id: 'b', hours: [4, 9] },
        ],
        weeklyHours: 8,
      }),
    )
    expect(report.hours).toMatchObject({ low: 14, high: 39, weeklyHours: 8 })
    expect(report.hours.weeksAtWeeklyHours).toEqual({ low: Math.ceil(14 / 8), high: Math.ceil(39 / 8) })
  })

  it('omits the week estimate when no weekly hours are known, rather than inventing a pace', () => {
    const report = analyzeFrontier(frontierCase({ edges: [['a', 'b']], targets: ['a'] }))
    expect(report.hours.weeksAtWeeklyHours).toBeNull()
    expect(report.hours.weeklyHours).toBeNull()
    expect(report.hours.low).toBeGreaterThan(0)
  })

  it('keeps counts internally consistent', () => {
    const report = analyzeFrontier(frontierCase({ edges: [['a', 'b'], ['b', 'c']], targets: ['a'] }))
    expect(report.knownInClosure + report.remainingCount).toBe(report.closureCount)
    expect(report.closureCount).toBeGreaterThanOrEqual(report.targetCount)
    expect(report.remaining).toHaveLength(report.remainingCount)
  })

  it('narrows the closure when explicit targets are given', () => {
    const wide = analyzeFrontier(
      frontierCase({ edges: [['a', 'b'], ['c', 'd']], targets: ['a', 'c'] }),
    )
    const narrow = analyzeFrontier({
      ...frontierCase({ edges: [['a', 'b'], ['c', 'd']], targets: ['a', 'c'] }),
      targetIds: ['a'],
    })
    expect(wide.closureCount).toBe(4)
    expect(narrow.closureCount).toBe(2)
    expect(idsOf(narrow.pulledIn)).toEqual(['b'])
  })
})

describe('frontier: the constants the Java oracle trusts', () => {
  it('pins the tuning policy, because the oracle reads it from the fixture instead of restating it', () => {
    expect(ENGINE_LIMITS.prereqMetThreshold).toBe(0.6)
    expect(ENGINE_LIMITS.maxTraversal).toBe(4000)
    expect(ENGINE_LIMITS.maxSteps).toBe(60)
    expect(ENGINE_LIMITS.defaultSkillHours).toEqual([4, 10])
  })
})

/* -------------------------------------------------- against the real dataset */

const reader = createLocalReader(knowledgeGraph)
const slices = new Map<string, CareerSlice>()
async function sliceFor(careerId: string): Promise<CareerSlice> {
  const cached = slices.get(careerId)
  if (cached) return cached
  const slice = await loadCareerSlice(reader, careerId, { depth: 6, maxSkills: 400 })
  slices.set(careerId, slice)
  return slice
}

describe('frontier: against the shipped dataset', () => {
  it('gives every career at least one startable skill from a cold start', async () => {
    for (const career of knowledgeGraph.careers) {
      const slice = await sliceFor(career.id)
      const report = analyzeFrontier({
        careerId: slice.careerId,
        careerName: slice.careerName,
        careerSkills: slice.careerSkills,
        skillMeta: slice.skillMeta,
        prereqEdges: slice.prereqEdges,
        ratings: [],
        interests: [],
        weeklyHours: 10,
      })
      expect(report.frontier.length, `${career.name} has nothing startable`).toBeGreaterThan(0)
      expect(report.remainingCount).toBe(report.closureCount)
      // Nothing on the frontier may have an unmet prerequisite in front of it.
      const remaining = new Set(idsOf(report.remaining))
      const prereqsOf = new Map<string, string[]>()
      for (const edge of slice.prereqEdges) {
        if (edge.type !== 'REQUIRES') continue
        prereqsOf.set(edge.from, [...(prereqsOf.get(edge.from) ?? []), edge.to])
      }
      for (const skill of report.frontier) {
        const blockers = (prereqsOf.get(skill.skillId) ?? []).filter((id) => remaining.has(id))
        expect(blockers, `${skill.name} on the frontier still needs ${blockers.join(', ')}`).toEqual([])
      }
    }
  })

  it('never lets more knowledge increase the amount left to do', async () => {
    for (const career of knowledgeGraph.careers) {
      const slice = await sliceFor(career.id)
      const build = (states: SkillState[]) =>
        analyzeFrontier({
          careerId: slice.careerId,
          careerName: slice.careerName,
          careerSkills: slice.careerSkills,
          skillMeta: slice.skillMeta,
          prereqEdges: slice.prereqEdges,
          ratings: slice.careerSkills.map((skill, index) => ({ skillId: skill.id, state: states[index] ?? 'unknown' })),
          interests: [],
        })
      const cold = new Set(idsOf(build([]).remaining))
      const warm = new Set(idsOf(build(slice.careerSkills.map(() => 'practised')).remaining))
      const hot = new Set(idsOf(build(slice.careerSkills.map(() => 'confident')).remaining))

      for (const id of warm) expect(cold.has(id), `${id} appeared when more was known`).toBe(true)
      for (const id of hot) expect(warm.has(id), `${id} appeared when more was known`).toBe(true)

      // What is left after rating every *career skill* confident is exactly the
      // prerequisites the career never listed — the skills with nobody to have
      // rated them. That is the specialist's real remaining delta, and it is the
      // reason the delta has to be shown rather than assumed to be empty.
      const careerSkillIds = new Set(slice.careerSkills.map((skill) => skill.id))
      const unrated = build(slice.careerSkills.map(() => 'confident'))
      expect(idsOf(unrated.remaining).every((id) => !careerSkillIds.has(id))).toBe(true)
      expect(idsOf(unrated.remaining).sort()).toEqual(idsOf(unrated.pulledIn).sort())
    }
  })

  it('reports ids and names that exist in the dataset, with no invented rows', async () => {
    const slice = await sliceFor('career:software-engineer')
    const report = analyzeFrontier({
      careerId: slice.careerId,
      careerName: slice.careerName,
      careerSkills: slice.careerSkills,
      skillMeta: slice.skillMeta,
      prereqEdges: slice.prereqEdges,
      ratings: [],
      interests: [],
    })
    const known = new Set(slice.skillMeta.map((meta) => meta.id))
    for (const row of [...report.frontier, ...report.gates, ...report.remaining]) {
      expect(known.has(row.skillId)).toBe(true)
      expect(row.name.length).toBeGreaterThan(0)
      expect(row.name).not.toBe(row.skillId)
    }
    for (const node of report.criticalChain) expect(known.has(node.skillId)).toBe(true)
  })
})


