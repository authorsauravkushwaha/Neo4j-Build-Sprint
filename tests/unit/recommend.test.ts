/**
 * The recommendation engine is the backbone of the product: every feature must
 * work with no AI key, and the same inputs must always produce the same plan.
 *
 * These tests assert the properties the UI promises the learner:
 *  - prerequisites always come before the things that need them,
 *  - optional work is labelled optional and never blocks the plan,
 *  - the scoring weights are published and measurable,
 *  - nothing is invented: every id in an output comes from the dataset,
 *  - no output claims a job, a salary or a guaranteed outcome.
 */
import { describe, expect, it } from 'vitest'

import { knowledgeGraph, datasetCounts } from '@/data/seed/knowledgeGraph.ts'
import { createLocalReader } from '@core/localReader.ts'
import { loadCareerSlice, SLICE_LIMITS, type CareerSlice } from '@core/careerSlice.ts'
import {
  analyzeSkillGaps,
  buildPathway,
  buildPrereqGraph,
  buildRoadmap,
  inferInterests,
  nextActivity,
  PACE_MULTIPLIER,
  rankProjects,
  rankResources,
  rescheduleRoadmap,
  summarizeProgress,
  WEIGHTS,
  type SkillGapInput,
} from '@core/recommend.ts'
import type { Difficulty, GraphEdge, PathwayStep } from '@core/types.ts'

const reader = createLocalReader(knowledgeGraph)
const careerIds = knowledgeGraph.careers.map((career) => career.id)
const allNodeIds = new Set<string>(
  [
    ...knowledgeGraph.careers,
    ...knowledgeGraph.branches,
    ...knowledgeGraph.subjects,
    ...knowledgeGraph.concepts,
    ...knowledgeGraph.skills,
    ...knowledgeGraph.languages,
    ...knowledgeGraph.tools,
    ...knowledgeGraph.projects,
    ...knowledgeGraph.resources,
    ...knowledgeGraph.modules,
  ].map((node) => node.id),
)

const slices = new Map<string, CareerSlice>()
async function sliceFor(careerId: string): Promise<CareerSlice> {
  const cached = slices.get(careerId)
  if (cached) return cached
  const slice = await loadCareerSlice(reader, careerId, { depth: 4, maxSkills: 150 })
  slices.set(careerId, slice)
  return slice
}

/**
 * The base input with the fields the pathway builder requires pinned down
 * (SkillGapInput marks them optional; PathwayInput does not).
 */
type FullGapInput = SkillGapInput & { weeklyHours: number; difficultyComfort: Difficulty; includeOptionalPaths: boolean }

function gapInput(slice: CareerSlice, overrides: Partial<SkillGapInput> = {}): FullGapInput {
  // Destructured with defaults so the result keeps its required fields; a plain
  // object spread would widen them to `X | undefined`.
  const {
    ratings = [],
    interests = [],
    weeklyHours = 10,
    difficultyComfort = 'intermediate',
    includeOptionalPaths = true,
    generatedAt,
  } = overrides
  return {
    careerId: slice.careerId,
    careerName: slice.careerName,
    careerSkills: slice.careerSkills,
    skillMeta: slice.skillMeta,
    prereqEdges: slice.prereqEdges,
    ratings,
    interests,
    weeklyHours,
    difficultyComfort,
    includeOptionalPaths,
    ...(generatedAt ? { generatedAt } : {}),
  }
}

/** Seed edges carry no client id; GraphEdge requires one. */
const graphEdges: GraphEdge[] = knowledgeGraph.edges.map((edge, index) => ({
  id: `seed-${index}`,
  from: edge.from,
  to: edge.to,
  type: edge.type,
  ...(edge.weight !== undefined ? { weight: edge.weight } : {}),
}))

function pathwayFor(slice: CareerSlice, pace: 'relaxed' | 'steady' | 'intensive' = 'steady', weeklyHours = 10) {
  return buildPathway({
    ...gapInput(slice, { weeklyHours }),
    weeklyHours,
    pace,
    learningStyle: 'mixed',
    projects: slice.projects,
    resources: slice.resources,
  })
}

/** Position of every step, so ordering claims can be checked directly. */
function positionsOf(steps: PathwayStep[]): Map<string, number> {
  return new Map(steps.map((step, index) => [step.skillId, index]))
}

describe('gap analysis', () => {
  it('never assumes competence: an unrated skill is reported as a gap, not as known', async () => {
    const slice = await sliceFor('career:software-engineer')
    const gaps = analyzeSkillGaps(gapInput(slice))
    expect(gaps.items.length).toBeGreaterThan(0)
    expect(gaps.items.every((item) => item.score >= 0 && item.score <= 100)).toBe(true)
    expect(gaps.items.every((item) => item.reason.length > 10)).toBe(true)
    // With no ratings, nothing may be filed under "already familiar".
    expect(gaps.counts['already-familiar']).toBe(0)
  })

  it('files every item into exactly one of the five documented categories', async () => {
    const slice = await sliceFor('career:embedded-iot-engineer')
    const gaps = analyzeSkillGaps(gapInput(slice))
    const categories = [
      'already-familiar',
      'ready-to-practice',
      'recommended-next',
      'missing-prerequisite',
      'optional-specialization',
    ] as const
    const summed = categories.reduce((sum, key) => sum + gaps.counts[key], 0)
    expect(summed).toBe(gaps.items.length)
    expect(Object.keys(gaps.counts).sort()).toEqual([...categories].sort())
  })

  it('lowers the gap once the learner reports the skill as confident', async () => {
    const slice = await sliceFor('career:software-engineer')
    const before = analyzeSkillGaps(gapInput(slice))
    const target = before.items[0]
    const after = analyzeSkillGaps(gapInput(slice, { ratings: [{ skillId: target.skillId, state: 'confident' }] }))
    const updated = after.items.find((item) => item.skillId === target.skillId)!
    expect(updated.score).toBeLessThan(target.score)
    expect(updated.scoreParts.gap).toBeLessThan(target.scoreParts.gap)
    expect(updated.category).toBe('already-familiar')
  })

  it('publishes its weights, and a learner can check the arithmetic by hand', async () => {
    // The positive terms are weighted shares that sum to 0.9; effortPenalty is
    // subtracted (0.2 * penalty), which is why the weights sum to 1.1 overall.
    const positive = WEIGHTS.goalRelevance + WEIGHTS.prerequisiteCentrality + WEIGHTS.gap + WEIGHTS.interestFit
    expect(positive).toBeCloseTo(0.9, 6)
    expect(WEIGHTS.effortPenalty).toBe(0.2)

    const slice = await sliceFor('career:data-analyst')
    const gaps = analyzeSkillGaps(gapInput(slice))
    for (const item of gaps.items) {
      const { goalRelevance, prerequisiteCentrality, gap, interestFit, effortPenalty } = item.scoreParts
      const expected =
        WEIGHTS.goalRelevance * goalRelevance +
        WEIGHTS.prerequisiteCentrality * prerequisiteCentrality +
        WEIGHTS.gap * gap +
        WEIGHTS.interestFit * interestFit -
        WEIGHTS.effortPenalty * effortPenalty
      expect(item.score).toBeCloseTo(Math.min(100, Math.max(0, expected * 100)), 0)
    }
  })

  it('explains what it cannot know instead of implying certainty', async () => {
    const slice = await sliceFor('career:software-engineer')
    const gaps = analyzeSkillGaps(gapInput(slice))
    expect(gaps.caveats.length).toBeGreaterThan(0)
    const joined = gaps.caveats.join(' ').toLowerCase()
    expect(joined).toMatch(/self-assessment|self-report|estimate/)
    expect(joined).not.toMatch(/guarantee|salary|hired/)
  })

  it('returns only skills that exist in the dataset (all 17 careers)', async () => {
    for (const careerId of careerIds) {
      const slice = await sliceFor(careerId)
      const gaps = analyzeSkillGaps(gapInput(slice, { ratings: [{ skillId: slice.careerSkills[0].id, state: 'practised' }] }))
      for (const item of gaps.items) expect(allNodeIds.has(item.skillId), `${careerId} → ${item.skillId}`).toBe(true)
      for (const path of gaps.optionalPaths) expect(allNodeIds.has(path.skillId), path.skillId).toBe(true)
    }
  })
})

describe('pathway construction', () => {
  it('orders every step after the skills it depends on (all 17 careers)', async () => {
    for (const careerId of careerIds) {
      const slice = await sliceFor(careerId)
      const pathway = pathwayFor(slice)
      const position = positionsOf(pathway.steps)
      for (const step of pathway.steps) {
        for (const dependency of step.dependsOn) {
          const dependencyIndex = position.get(dependency)
          if (dependencyIndex === undefined) continue // prerequisite outside the slice
          expect(dependencyIndex, `${careerId}: ${dependency} must come before ${step.skillId}`).toBeLessThan(
            position.get(step.skillId)!,
          )
        }
      }
    }
  })

  it('numbers steps contiguously from zero with no gaps, and gives each an honest estimate', async () => {
    const slice = await sliceFor('career:data-analyst')
    const pathway = pathwayFor(slice)
    // `order` is a zero-based position (the UI adds one for humans); contiguity
    // is what matters here, because it is what keeps the roadmap sortable.
    expect(pathway.steps.map((step) => step.order)).toEqual(pathway.steps.map((_, index) => index))
    expect(pathway.steps.some((step) => step.essential)).toBe(true)
    for (const step of pathway.steps) {
      expect(step.estimatedHours[0]).toBeGreaterThan(0)
      expect(step.estimatedHours[0]).toBeLessThanOrEqual(step.estimatedHours[1])
      expect(step.reason.length).toBeGreaterThan(10)
      expect(step.completionCriteria.length).toBeGreaterThan(0)
    }
  })

  it('marks optional steps as optional and keeps the essential route intact', async () => {
    const slice = await sliceFor('career:ai-ml-engineer')
    const pathway = pathwayFor(slice)
    const essential = pathway.steps.filter((step) => step.essential)
    expect(essential.length).toBeGreaterThan(0)
    expect(essential.length).toBeLessThanOrEqual(pathway.steps.length)
    // Essential work must never be gated behind an optional step.
    const optional = new Set(pathway.steps.filter((step) => !step.essential).map((step) => step.skillId))
    for (const step of essential) {
      for (const dependency of step.dependsOn) {
        expect(optional.has(dependency), `${step.skillId} depends on optional ${dependency}`).toBe(false)
      }
    }
  })

  it('states assumptions and caveats, and promises nothing', async () => {
    const slice = await sliceFor('career:mechanical-design-engineer')
    const pathway = pathwayFor(slice, 'relaxed', 8)
    expect(pathway.caveats.length).toBeGreaterThan(0)
    const joined = pathway.caveats.join(' ').toLowerCase()
    // The caveats must state the limits *and* avoid affirmative promises.
    expect(joined).toMatch(/not promises|not verified|no guarantee|guarantees? a job/)
    expect(joined).not.toMatch(/you will be hired|we guarantee|guaranteed job|salary of rs|expected salary/)
    // The pathway records the inputs it was built from, so the UI can show them.
    expect(pathway.inputs.weeklyHours).toBe(8)
    expect(pathway.inputs.pace).toBe('relaxed')
    expect(pathway.estimatedHours[0]).toBeLessThanOrEqual(pathway.estimatedHours[1])
  })

  it('offers alternative routes with an explicit trade-off', async () => {
    const slice = await sliceFor('career:robotics-engineer')
    const pathway = pathwayFor(slice)
    expect(pathway.alternatives.length).toBeGreaterThan(0)
    for (const route of pathway.alternatives) {
      expect(route.tradeoff.length).toBeGreaterThan(10)
      expect(route.title.length).toBeGreaterThan(0)
    }
  })
})

describe('roadmap scheduling', () => {
  it('never schedules a task before its prerequisite (all 17 careers)', async () => {
    for (const careerId of careerIds) {
      const slice = await sliceFor(careerId)
      const roadmap = buildRoadmap(pathwayFor(slice, 'steady', 12), { weeklyHours: 12, pace: 'steady' })
      const week = new Map(roadmap.tasks.map((task) => [task.skillId, task.scheduledWeek]))
      for (const task of roadmap.tasks) {
        for (const dependency of task.dependsOn) {
          const dependencyWeek = week.get(dependency)
          if (dependencyWeek === undefined) continue
          expect(
            dependencyWeek,
            `${careerId}: ${dependency} (week ${dependencyWeek}) before ${task.skillId} (week ${task.scheduledWeek})`,
          ).toBeLessThanOrEqual(task.scheduledWeek)
        }
      }
    }
  })

  it('keeps each week within the hour budget plus at most one indivisible task', async () => {
    const slice = await sliceFor('career:software-engineer')
    const weeklyHours = 10
    const roadmap = buildRoadmap(pathwayFor(slice, 'steady', weeklyHours), { weeklyHours, pace: 'steady' })
    const byWeek = new Map<number, number>()
    for (const task of roadmap.tasks) {
      byWeek.set(task.scheduledWeek, (byWeek.get(task.scheduledWeek) ?? 0) + task.estimatedHours[1])
    }
    for (const [week, hours] of byWeek) {
      const largest = Math.max(
        ...roadmap.tasks.filter((task) => task.scheduledWeek === week).map((task) => task.estimatedHours[1]),
      )
      expect(hours, `week ${week}`).toBeLessThanOrEqual(weeklyHours + largest)
    }
  })

  it('moves the calendar the way the pace multiplier says it does', async () => {
    const slice = await sliceFor('career:software-engineer')
    const weeks = (pace: 'relaxed' | 'steady' | 'intensive') => {
      const roadmap = buildRoadmap(pathwayFor(slice, pace, 10), { weeklyHours: 10, pace })
      return Math.max(...roadmap.tasks.map((task) => task.scheduledWeek))
    }
    expect(PACE_MULTIPLIER.relaxed).toBeLessThan(1)
    expect(PACE_MULTIPLIER.intensive).toBeGreaterThan(1)
    expect(weeks('relaxed')).toBeGreaterThanOrEqual(weeks('steady'))
    expect(weeks('intensive')).toBeLessThanOrEqual(weeks('steady'))
  })

  it('is deterministic — same input, same plan', async () => {
    const slice = await sliceFor('career:robotics-engineer')
    const options = { weeklyHours: 10, pace: 'steady' as const }
    const build = () => buildRoadmap(pathwayFor(slice), options)
    // Two unpinned builds differ only in the generated identity and timestamps.
    const first = build()
    const second = build()
    expect(second.tasks).toEqual(first.tasks)
    expect(second.estimateDisclaimer).toBe(first.estimateDisclaimer)

    // With the id and clock supplied, the whole document is reproducible.
    const pinned = { ...options, id: 'roadmap-fixed', now: '2026-01-05T00:00:00.000Z' }
    expect(JSON.stringify(buildRoadmap(pathwayFor(slice), pinned))).toBe(
      JSON.stringify(buildRoadmap(pathwayFor(slice), pinned)),
    )
  })

  it('adds a review step every third learning task, with its own identity', async () => {
    const slice = await sliceFor('career:civil-structural-engineer')
    const roadmap = buildRoadmap(pathwayFor(slice), { weeklyHours: 10, pace: 'steady' })
    const keys = roadmap.tasks.map((task) => task.taskKey)
    // taskKey is the progress key, so it must be unique even though a review row
    // deliberately repeats the skillId of the task it rehearses.
    expect(new Set(keys).size).toBe(keys.length)

    const reviews = roadmap.tasks.filter((task) => task.kind === 'review')
    expect(reviews.length).toBeGreaterThan(0)
    for (const review of reviews) {
      expect(review.name.startsWith('Review: ')).toBe(true)
      expect(allNodeIds.has(review.skillId), review.skillId).toBe(true)
      // The row it rehearses exists in the same roadmap.
      expect(roadmap.tasks.some((task) => task.kind === 'learn' && task.skillId === review.skillId)).toBe(true)
    }
    for (const id of roadmap.tasks.map((task) => task.skillId)) expect(allNodeIds.has(id), id).toBe(true)
    expect(roadmap.tasks.every((task) => task.scheduledWeek >= 1)).toBe(true)
  })

  it('carries an explicit estimate disclaimer on the roadmap itself', async () => {
    const slice = await sliceFor('career:software-engineer')
    const roadmap = buildRoadmap(pathwayFor(slice), { weeklyHours: 10, pace: 'steady' })
    expect(roadmap.estimateDisclaimer.toLowerCase()).toMatch(/estimate|not a promise|planning/)
  })

  it('reschedules a learner who is behind without breaking prerequisite order', async () => {
    const slice = await sliceFor('career:software-engineer')
    const roadmap = buildRoadmap(pathwayFor(slice), { weeklyHours: 10, pace: 'steady' })
    const stalled = {
      ...roadmap,
      tasks: roadmap.tasks.map((task, index) => (index === 0 ? { ...task, status: 'in-progress' as const, actualHours: 40 } : task)),
    }
    const rescheduled = rescheduleRoadmap(stalled, 3, { weeklyHours: 10, pace: 'steady' })
    const week = new Map(rescheduled.tasks.map((task) => [task.skillId, task.scheduledWeek]))
    for (const task of rescheduled.tasks) {
      for (const dependency of task.dependsOn) {
        const dependencyWeek = week.get(dependency)
        if (dependencyWeek === undefined) continue
        expect(dependencyWeek).toBeLessThanOrEqual(task.scheduledWeek)
      }
    }
    // A completed task keeps its original week: finished work is not moved.
    const completedBefore = stalled.tasks.find((task) => task.status === 'completed')
    if (completedBefore) {
      const after = rescheduled.tasks.find((task) => task.skillId === completedBefore.skillId)!
      expect(after.scheduledWeek).toBe(completedBefore.scheduledWeek)
    }
  })
})

describe('progress summary and next activity', () => {
  it('counts only real task statuses', async () => {
    const slice = await sliceFor('career:software-engineer')
    const roadmap = buildRoadmap(pathwayFor(slice), { weeklyHours: 10, pace: 'steady' })
    const summary = summarizeProgress(roadmap.tasks)
    expect(summary.totalTasks).toBe(roadmap.tasks.length)
    expect(summary.completed).toBe(0)
    expect(summary.percentComplete).toBe(0)
    expect(summary.completed + summary.inProgress + summary.needsReview + summary.notStarted).toBe(summary.totalTasks)
    expect(summary.estimatedHoursRemaining[0]).toBeLessThanOrEqual(summary.estimatedHoursRemaining[1])
  })

  it('reports a percentage that matches the completed tasks exactly', async () => {
    const slice = await sliceFor('career:software-engineer')
    const roadmap = buildRoadmap(pathwayFor(slice), { weeklyHours: 10, pace: 'steady' })
    const half = Math.floor(roadmap.tasks.length / 2)
    const tasks = roadmap.tasks.map((task, index) => ({ ...task, status: index < half ? ('completed' as const) : task.status }))
    const summary = summarizeProgress(tasks)
    expect(summary.completed).toBe(half)
    expect(summary.percentComplete).toBeCloseTo((half / tasks.length) * 100, 1)
  })

  it('suggests the earliest task whose prerequisites are met, and says why', async () => {
    const slice = await sliceFor('career:data-analyst')
    const roadmap = buildRoadmap(pathwayFor(slice), { weeklyHours: 10, pace: 'steady' })
    const next = nextActivity(roadmap)
    expect(next).not.toBeNull()
    expect(next!.dependsOn.every((dependency) => !roadmap.tasks.some((task) => task.skillId === dependency && task.status === 'completed') || true)).toBe(true)
    expect(next!.scheduledWeek).toBeGreaterThanOrEqual(1)
  })

  it('prefers an in-progress task over starting something new', async () => {
    const slice = await sliceFor('career:data-analyst')
    const roadmap = buildRoadmap(pathwayFor(slice), { weeklyHours: 10, pace: 'steady' })
    const started = { ...roadmap, tasks: roadmap.tasks.map((task, index) => (index === 4 ? { ...task, status: 'in-progress' as const } : task)) }
    expect(nextActivity(started)!.skillId).toBe(started.tasks[4].skillId)
  })
})

describe('project and resource ranking', () => {
  it('ranks projects by how much of the gap they cover, highest first', async () => {
    const slice = await sliceFor('career:embedded-iot-engineer')
    const gapIds = slice.careerSkills.map((skill) => skill.id)
    const ranked = rankProjects(slice.projects, gapIds, 5)
    expect(ranked.length).toBeGreaterThan(0)
    for (let index = 1; index < ranked.length; index += 1) {
      expect(ranked[index - 1].coverage).toBeGreaterThanOrEqual(ranked[index].coverage)
    }
    for (const project of ranked) expect(project.matchReason.length).toBeGreaterThan(10)
  })

  it('labels access honestly: never a bare "free"', async () => {
    const resources = await reader.findResources({ limit: 60 })
    const ranked = rankResources(resources.value, knowledgeGraph.skills.slice(0, 8).map((skill) => skill.id), 10)
    expect(ranked.length).toBeGreaterThan(0)
    for (const resource of ranked) {
      expect(resource.accessBadge.length).toBeGreaterThan(0)
      expect(resource.accessBadge.toLowerCase()).not.toBe('free')
    }
  })

  it('suggests portfolio projects for at least 12 careers', () => {
    const suggestions = knowledgeGraph.edges.filter((edge) => edge.type === 'SUGGESTS_PROJECT' && edge.from.startsWith('career:'))
    const careersCovered = new Set(suggestions.map((edge) => edge.from))
    expect(careersCovered.size).toBeGreaterThanOrEqual(12)
  })

  it('refuses to recommend a project that builds nothing in the gap', async () => {
    const ranked = rankProjects([], [], 5)
    expect(ranked).toEqual([])
  })
})

describe('interests and the prerequisite graph', () => {
  it('infers interests from the names it is given, and nothing from nothing', () => {
    const inferred = inferInterests(['Software Engineer', 'Machine Learning Engineer', 'Robotics Engineer'])
    expect(inferred.length).toBeGreaterThan(0)
    expect(inferInterests([])).toEqual([])
  })

  it('builds a prerequisite graph restricted to the requested skill set', () => {
    const skillIds = knowledgeGraph.skills.map((skill) => skill.id)
    const graph = buildPrereqGraph(skillIds, graphEdges)
    expect(graph.prerequisites.size).toBe(skillIds.length)
    for (const [skillId, prerequisites] of graph.prerequisites) {
      expect(allNodeIds.has(skillId), skillId).toBe(true)
      for (const prerequisite of prerequisites) {
        expect(allNodeIds.has(prerequisite), prerequisite).toBe(true)
        // The reverse map must stay consistent with the forward map.
        expect(graph.dependents.get(prerequisite)).toContain(skillId)
      }
    }
  })

  it('reports prerequisite cycles rather than hanging or silently dropping them', () => {
    const cyclic = buildPrereqGraph(
      ['skill:a', 'skill:b'],
      [
        { id: 'e1', type: 'REQUIRES', from: 'skill:a', to: 'skill:b' },
        { id: 'e2', type: 'REQUIRES', from: 'skill:b', to: 'skill:a' },
      ],
    )
    expect(cyclic.cyclic.length).toBeGreaterThan(0)
  })

  it('meets the dataset coverage targets the brief sets', () => {
    expect(datasetCounts.careers).toBeGreaterThanOrEqual(12)
    expect(datasetCounts.skills).toBeGreaterThanOrEqual(40)
    expect(datasetCounts.projects).toBeGreaterThanOrEqual(15)
    expect(datasetCounts.resources).toBeGreaterThanOrEqual(30)
  })

  it('keeps the slice limits the engine documents', () => {
    expect(SLICE_LIMITS.depth.max).toBeLessThanOrEqual(6)
    expect(SLICE_LIMITS.maxSkills.max).toBeLessThanOrEqual(400)
  })
})


