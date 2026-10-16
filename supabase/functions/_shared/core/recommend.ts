/**
 * The recommendation engine.
 *
 * Everything here is deterministic and runs without any AI provider, which is
 * what makes the product usable on a free tier with no API key. The AI layer
 * *explains* these results; it never produces them.
 *
 * Pipeline:
 *   1. gather the target career's skills (essential + optional) from the graph,
 *   2. expand transitive prerequisites and the REQUIRES edges among them,
 *   3. compute mastery from the user's self-reported states,
 *   4. score every skill with an explicit, documented blend (see SCORING below),
 *   5. categorise gaps (familiar / ready / next / missing prerequisite / optional),
 *   6. topologically order the unmet skills into a pathway that never schedules a
 *      skill before its prerequisites,
 *   7. attach practice items, projects, resources and completion criteria,
 *   8. convert the pathway into a week-by-week roadmap with review sessions.
 *
 * SCORING (documented as heuristic, not validated science):
 *   score = 100 × (0.35·goalRelevance + 0.25·prerequisiteCentrality
 *                  + 0.20·gap + 0.10·interestFit − 0.20·effortPenalty)
 * Every component is in 0..1 and is returned in `scoreParts` so the UI can show
 * the learner *why* a skill is ranked where it is. Weights are constants in
 * WEIGHTS below and are covered by tests.
 *
 * Guards: all traversals are bounded (depth, node count, iteration count) and
 * cycle-safe, so a malformed graph degrades into a warning instead of a hang.
 */
import type {
  AlternativeRoute,
  Difficulty,
  GraphEdge,
  Pathway,
  PathwayStep,
  ProgressSummary,
  Roadmap,
  RoadmapTask,
  GapCategory,
  ScoredSkill,
  ScoreParts,
  SkillGapReport,
  SkillState,
  TaskStatus,
  UserProfileInput,
  UserSkillRating,
} from './types.ts'
import { DIFFICULTY_RANK, taskKeyFor } from './types.ts'
import type { CareerSkillRow, ProjectView, ResourceView, SkillMetaRow } from './graphReader.ts'
import { STATE_TO_MASTERY, difficultyRank } from './graphReader.ts'
import { clamp, round, tokenize, unique } from './normalize.ts'

/* ==========================================================================
 * Tunables
 * ========================================================================== */

export const WEIGHTS = {
  goalRelevance: 0.35,
  prerequisiteCentrality: 0.25,
  gap: 0.2,
  interestFit: 0.1,
  effortPenalty: 0.2,
} as const

export const PACE_MULTIPLIER: Record<NonNullable<UserProfileInput['preferredPace']>, number> = {
  relaxed: 0.75,
  steady: 1,
  intensive: 1.35,
}

/** Mastery at or above this counts as "already familiar" (never as verified). */
const FAMILIAR_THRESHOLD = 0.7
/** Mastery below this means a prerequisite is not yet met. */
const PREREQ_MET_THRESHOLD = 0.6
const MAX_TRAVERSAL = 4000
const MAX_STEPS = 60

const DEFAULT_SKILL_HOURS: [number, number] = [4, 10]

/**
 * The engine's tuning constants, exposed on purpose.
 *
 * `scripts/export-frontier-fixture.ts` writes these into the cross-language
 * fixture so that `tools/oracle/FrontierOracle.java` *declares* the policy it is
 * checking against instead of restating it. That keeps the division of labour
 * honest: the oracle re-implements the traversal, ordering and aggregation
 * algorithms, while the numeric policy below stays pinned by the unit tests in
 * `tests/unit/recommend.test.ts`. If a threshold changes here, the fixture
 * changes with it and the Java is still comparing like with like.
 */
export const ENGINE_LIMITS = {
  prereqMetThreshold: PREREQ_MET_THRESHOLD,
  maxTraversal: MAX_TRAVERSAL,
  maxSteps: MAX_STEPS,
  defaultSkillHours: DEFAULT_SKILL_HOURS,
} as const

export const CAVEATS = {
  selfReport: 'Skill levels are what you told us. Self-assessment is a planning aid, not verified proof of ability.',
  estimates: 'Time estimates are planning ranges based on typical learners, not promises. Adjust them to your own pace.',
  outcomes: 'Nothing here guarantees a job, an admission, a salary or any other outcome. Markets and requirements vary.',
  coverage: 'The knowledge graph covers common routes; it is not a complete model of any profession.',
}

/* ==========================================================================
 * 1. Prerequisite graph utilities
 * ========================================================================== */

export interface PrereqGraph {
  /** skillId -> direct prerequisite ids (the ids that must come first). */
  prerequisites: Map<string, string[]>
  /** skillId -> skills that directly depend on it. */
  dependents: Map<string, string[]>
  cyclic: string[]
}

/**
 * Builds the prerequisite adjacency from REQUIRES edges.
 * `(A)-[:REQUIRES]->(B)` reads as "A requires B", so B must be learned first.
 */
export function buildPrereqGraph(skillIds: string[], edges: GraphEdge[]): PrereqGraph {
  const allowed = new Set(skillIds)
  const prerequisites = new Map<string, string[]>()
  const dependents = new Map<string, string[]>()

  for (const id of skillIds) {
    prerequisites.set(id, [])
    dependents.set(id, [])
  }

  for (const edge of edges) {
    if (edge.type !== 'REQUIRES') continue
    if (!allowed.has(edge.from) || !allowed.has(edge.to)) continue
    if (edge.from === edge.to) continue

    const prereqList = prerequisites.get(edge.from) ?? []
    if (!prereqList.includes(edge.to)) prereqList.push(edge.to)
    prerequisites.set(edge.from, prereqList)

    const dependentList = dependents.get(edge.to) ?? []
    if (!dependentList.includes(edge.from)) dependentList.push(edge.from)
    dependents.set(edge.to, dependentList)
  }

  for (const list of prerequisites.values()) list.sort()
  for (const list of dependents.values()) list.sort()

  return { prerequisites, dependents, cyclic: findCycles(prerequisites) }
}

/**
 * Iterative DFS that reports the nodes participating in a cycle.
 * Iterative so a long chain cannot overflow the stack; the visit budget makes a
 * malformed graph terminate instead of looping.
 */
export function findCycles(prerequisites: Map<string, string[]>): string[] {
  const state = new Map<string, 0 | 1 | 2>()
  const inCycle = new Set<string>()
  let budget = MAX_TRAVERSAL

  for (const start of prerequisites.keys()) {
    if ((state.get(start) ?? 0) !== 0) continue
    const stack: Array<{ node: string; index: number; path: string[] }> = [{ node: start, index: 0, path: [start] }]
    const onStack = new Set<string>([start])
    state.set(start, 1)

    while (stack.length > 0 && budget-- > 0) {
      const frame = stack[stack.length - 1]
      const neighbours = prerequisites.get(frame.node) ?? []
      if (frame.index >= neighbours.length) {
        state.set(frame.node, 2)
        onStack.delete(frame.node)
        stack.pop()
        continue
      }
      const next = neighbours[frame.index++]
      const nextState = state.get(next) ?? 0
      if (nextState === 1 && onStack.has(next)) {
        for (const node of frame.path.slice(frame.path.indexOf(next))) inCycle.add(node)
        inCycle.add(next)
        continue
      }
      if (nextState === 0) {
        state.set(next, 1)
        onStack.add(next)
        stack.push({ node: next, index: 0, path: [...frame.path, next] })
      }
    }
  }
  return [...inCycle].sort()
}

/**
 * Topological order via Kahn's algorithm with a deterministic tie-break.
 * Nodes inside a detected cycle are appended at the end (never dropped) and
 * reported, so the caller can warn instead of silently producing a wrong order.
 */
export function topologicalOrder(
  skillIds: string[],
  graph: PrereqGraph,
  rankOf: (id: string) => number = () => 0,
): { order: string[]; cyclic: string[] } {
  const indegree = new Map<string, number>()
  for (const id of skillIds) {
    const prereqs = (graph.prerequisites.get(id) ?? []).filter((p) => skillIds.includes(p))
    indegree.set(id, prereqs.length)
  }

  const ready = skillIds
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort((a, b) => (rankOf(a) !== rankOf(b) ? rankOf(a) - rankOf(b) : a.localeCompare(b)))

  const order: string[] = []
  const queue = [...ready]
  let guard = 0

  while (queue.length > 0 && guard++ < MAX_TRAVERSAL) {
    const current = queue.shift() as string
    order.push(current)
    const dependents = (graph.dependents.get(current) ?? []).filter((d) => skillIds.includes(d))
    const newlyReady: string[] = []
    for (const dependent of dependents) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining <= 0) newlyReady.push(dependent)
    }
    newlyReady
      .sort((a, b) => (rankOf(a) !== rankOf(b) ? rankOf(a) - rankOf(b) : a.localeCompare(b)))
      .forEach((id) => queue.push(id))
  }

  const placed = new Set(order)
  const cyclic = skillIds.filter((id) => !placed.has(id)).sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))
  return { order: [...order, ...cyclic], cyclic }
}

/** Transitive dependents count — how much of the goal depends on this skill. */
export function dependentCount(id: string, graph: PrereqGraph): number {
  const seen = new Set<string>()
  const queue = [...(graph.dependents.get(id) ?? [])]
  let guard = 0
  while (queue.length > 0 && guard++ < MAX_TRAVERSAL) {
    const current = queue.shift() as string
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of graph.dependents.get(current) ?? []) {
      if (!seen.has(next)) queue.push(next)
    }
  }
  return seen.size
}

/* ==========================================================================
 * 2. Scoring
 * ========================================================================== */

export interface ScoreContext {
  careerSkills: CareerSkillRow[]
  graph: PrereqGraph
  ratings: Map<string, UserSkillRating>
  interests: string[]
  weeklyHours?: number
  difficultyComfort?: Difficulty
  nameOf: (id: string) => string
  difficultyOf: (id: string) => Difficulty
  hoursOf: (id: string) => [number, number]
}

export function masteryOf(ratings: Map<string, UserSkillRating>, skillId: string): number {
  const rating = ratings.get(skillId)
  if (!rating) return 0
  const base = STATE_TO_MASTERY[rating.state] ?? 0
  // A quiz result can nudge the estimate but never turn self-report into proof.
  if (typeof rating.quizScore === 'number') {
    return clamp(base * 0.7 + clamp(rating.quizScore, 0, 1) * 0.3, 0, 1)
  }
  return base
}

export function scoreSkills(context: ScoreContext): ScoredSkill[] {
  const { careerSkills, graph, ratings, interests } = context
  const skillIds = careerSkills.map((s) => s.id)
  const idSet = new Set(skillIds)
  const maxDependents = Math.max(1, skillIds.length - 1)
  const interestTokens = new Set(interests.flatMap((interest) => tokenize(interest)))
  const weeklyHours = context.weeklyHours ?? 6
  const comfortRank = DIFFICULTY_RANK[context.difficultyComfort ?? 'beginner']

  return careerSkills.map((skill) => {
    const mastery = masteryOf(ratings, skill.id)
    const unmetPrereqs = (graph.prerequisites.get(skill.id) ?? []).filter((prereqId) =>
      idSet.has(prereqId) && masteryOf(ratings, prereqId) < PREREQ_MET_THRESHOLD,
    )
    const dependents = dependentCount(skill.id, graph)

    const goalRelevance = clamp(skill.essential ? Math.max(0.6, skill.weight) : 0.25 + skill.weight * 0.25, 0, 1)
    const prerequisiteCentrality = clamp(dependents / maxDependents, 0, 1)
    const gap = clamp(1 - mastery, 0, 1)

    const skillTokens = tokenize(`${skill.name} ${skill.summary ?? ''}`)
    const overlap = skillTokens.filter((token) => interestTokens.has(token)).length
    const interestFit = interestTokens.size === 0 ? 0.5 : clamp(overlap / Math.min(4, interestTokens.size), 0, 1)

    const [low, high] = context.hoursOf(skill.id)
    const expectedHours = (low + high) / 2
    const timePressure = clamp(expectedHours / Math.max(4, weeklyHours * 3), 0, 1)
    const aboveComfort = clamp((difficultyRank(context.difficultyOf(skill.id)) - comfortRank) / 2, 0, 1)
    const effortPenalty = clamp(timePressure * 0.5 + aboveComfort * 0.5, 0, 1)

    const parts: ScoreParts = {
      goalRelevance: round(goalRelevance, 3),
      prerequisiteCentrality: round(prerequisiteCentrality, 3),
      gap: round(gap, 3),
      interestFit: round(interestFit, 3),
      effortPenalty: round(effortPenalty, 3),
    }

    const raw =
      WEIGHTS.goalRelevance * goalRelevance +
      WEIGHTS.prerequisiteCentrality * prerequisiteCentrality +
      WEIGHTS.gap * gap +
      WEIGHTS.interestFit * interestFit -
      WEIGHTS.effortPenalty * effortPenalty

    const score = round(clamp(raw * 100, 0, 100), 1)
    const category = categorize({ mastery, unmetPrereqs: unmetPrereqs.length, essential: skill.essential })

    return {
      skillId: skill.id,
      name: skill.name,
      difficulty: skill.difficulty,
      category,
      score,
      scoreParts: parts,
      isEssential: skill.essential,
      reason: explainScore({
        name: skill.name,
        essential: skill.essential,
        dependents,
        mastery,
        unmetPrereqNames: unmetPrereqs.map(context.nameOf),
        score,
      }),
      blockedBy: unmetPrereqs,
      unlocks: (graph.dependents.get(skill.id) ?? []).filter((id) => idSet.has(id)),
    }
  })
}

export function categorize(input: { mastery: number; unmetPrereqs: number; essential: boolean }): GapCategory {
  const { mastery, unmetPrereqs, essential } = input
  if (mastery >= FAMILIAR_THRESHOLD) return 'already-familiar'
  if (unmetPrereqs > 0) return 'missing-prerequisite'
  if (!essential) return 'optional-specialization'
  if (mastery > 0) return 'ready-to-practice'
  return 'recommended-next'
}

function explainScore(input: {
  name: string
  essential: boolean
  dependents: number
  mastery: number
  unmetPrereqNames: string[]
  score: number
}): string {
  const { name, essential, dependents, mastery, unmetPrereqNames, score } = input
  const parts: string[] = []
  parts.push(
    essential
      ? `${name} is listed as an essential skill for this career in the graph.`
      : `${name} is optional for this career — useful for breadth, not required for the core route.`,
  )
  if (dependents > 0) {
    parts.push(`${dependents} other skill${dependents === 1 ? '' : 's'} in this route depend on it, so it unlocks later work.`)
  }
  if (unmetPrereqNames.length > 0) {
    parts.push(`Learn ${unmetPrereqNames.slice(0, 3).join(', ')} first.`)
  }
  if (mastery >= FAMILIAR_THRESHOLD) {
    parts.push('You marked this as already familiar, so it is only a review candidate.')
  } else if (mastery > 0) {
    parts.push('You have started this — the plan schedules practice and a completion check rather than an introduction.')
  }
  parts.push(`Ranking score ${score}/100 from prerequisite importance, goal relevance, your gap and your time budget.`)
  return parts.join(' ')
}

/* ==========================================================================
 * 3. Skill-gap report
 * ========================================================================== */

export interface SkillGapInput {
  careerId: string
  careerName: string
  careerSkills: CareerSkillRow[]
  skillMeta: SkillMetaRow[]
  prereqEdges: GraphEdge[]
  ratings: UserSkillRating[]
  interests?: string[]
  weeklyHours?: number
  difficultyComfort?: Difficulty
  includeOptionalPaths?: boolean
  generatedAt?: string
}

export function analyzeSkillGaps(input: SkillGapInput): SkillGapReport {
  const metaById = new Map(input.skillMeta.map((meta) => [meta.id, meta]))
  const nameOf = (id: string) => metaById.get(id)?.name ?? id
  const difficultyOf = (id: string) => metaById.get(id)?.difficulty ?? 'beginner'
  const hoursOf = (id: string): [number, number] => {
    const meta = metaById.get(id)
    return meta ? [meta.estimatedHoursLow, meta.estimatedHoursHigh] : DEFAULT_SKILL_HOURS
  }
  const ratings = new Map(input.ratings.map((rating) => [rating.skillId, rating]))
  const ids = input.careerSkills.map((s) => s.id)
  const graph = buildPrereqGraph(ids, input.prereqEdges)

  const items = scoreSkills({
    careerSkills: input.careerSkills,
    graph,
    ratings,
    interests: input.interests ?? [],
    weeklyHours: input.weeklyHours,
    difficultyComfort: input.difficultyComfort,
    nameOf,
    difficultyOf,
    hoursOf,
  }).sort((a, b) => (b.score !== a.score ? b.score - a.score : a.name.localeCompare(b.name)))

  const counts: Record<GapCategory, number> = {
    'already-familiar': 0,
    'ready-to-practice': 0,
    'recommended-next': 0,
    'missing-prerequisite': 0,
    'optional-specialization': 0,
  }
  for (const item of items) counts[item.category] += 1

  const knownIds = new Set(items.map((i) => i.skillId))
  const prereqOnly = unique(
    input.prereqEdges
      .filter((edge) => knownIds.has(edge.from))
      .map((edge) => edge.to)
      .filter((id) => !knownIds.has(id)),
  )

  const optionalPaths = input.includeOptionalPaths === false
    ? []
    : items
        .filter((item) => item.category === 'optional-specialization')
        .slice(0, 8)
        .map((item) => ({
          skillId: item.skillId,
          name: item.name,
          reason: `${item.name} is not required by ${input.careerName}, but the graph connects it to ${item.unlocks.length || 'related'} skill(s) you are already on a route to.`,
        }))

  const caveats = [CAVEATS.selfReport, CAVEATS.coverage]
  if (graph.cyclic.length > 0) {
    caveats.push(
      `The graph contains a prerequisite cycle (${graph.cyclic.slice(0, 4).join(', ')}), so the learning order for those items is approximate.`,
    )
  }
  if (prereqOnly.length > 0) {
    caveats.push(
      `${prereqOnly.length} prerequisite skill(s) sit outside the career's direct skill list; they are required for the route but are not themselves career requirements.`,
    )
  }

  return {
    careerId: input.careerId,
    careerName: input.careerName,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ratingsUsed: input.ratings,
    counts,
    items,
    optionalPaths,
    caveats,
  }
}

/* ==========================================================================
 * 4. Pathway
 * ========================================================================== */

export interface PathwayInput extends SkillGapInput {
  weeklyHours: number
  pace: NonNullable<UserProfileInput['preferredPace']>
  learningStyle: NonNullable<UserProfileInput['learningStyle']>
  difficultyComfort: Difficulty
  projects?: ProjectView[]
  resources?: ResourceView[]
  /** Optional inspection of a specific starting skill, for alternative routes. */
  routes?: Array<{ ids: string[]; names: string[]; targetName: string; hops: number }>
}

export function buildPathway(input: PathwayInput): Pathway {
  const metaById = new Map(input.skillMeta.map((meta) => [meta.id, meta]))
  const careerSkillById = new Map(input.careerSkills.map((s) => [s.id, s]))
  const ratings = new Map(input.ratings.map((rating) => [rating.skillId, rating]))
  const nameOf = (id: string) => metaById.get(id)?.name ?? careerSkillById.get(id)?.name ?? id
  const difficultyOf = (id: string) => metaById.get(id)?.difficulty ?? careerSkillById.get(id)?.difficulty ?? 'beginner'
  const hoursOf = (id: string): [number, number] => {
    const meta = metaById.get(id)
    return meta ? [meta.estimatedHoursLow, meta.estimatedHoursHigh] : DEFAULT_SKILL_HOURS
  }

  const skillIds = unique([...input.careerSkills.map((s) => s.id), ...input.skillMeta.map((m) => m.id)])
  const graph = buildPrereqGraph(skillIds, input.prereqEdges)
  const scored = scoreSkills({
    careerSkills: input.careerSkills,
    graph,
    ratings,
    interests: input.interests ?? [],
    weeklyHours: input.weeklyHours,
    difficultyComfort: input.difficultyComfort,
    nameOf,
    difficultyOf,
    hoursOf,
  })
  const scoreOf = new Map(scored.map((s) => [s.skillId, s]))
  const identified = new Set(scored.map((s) => s.skillId))
  const extraPrereqIds = unique(
    input.prereqEdges.map((edge) => edge.to).filter((id) => !identified.has(id) && metaById.has(id)),
  )

  const allIds = unique([...scored.map((s) => s.skillId), ...extraPrereqIds])
  const rankOf = (id: string) => {
    const item = scoreOf.get(id)
    const mastery = masteryOf(ratings, id)
    // Lower rank = scheduled earlier. Unmet prerequisites first, then by score.
    return mastery >= FAMILIAR_THRESHOLD ? 1000 + (item?.score ?? 0) * -1 : -(item?.score ?? 0) + difficultyRank(difficultyOf(id)) * 0.5
  }

  const { order, cyclic } = topologicalOrder(allIds, graph, rankOf)

  const projectBySkill = new Map<string, ProjectView>()
  for (const project of input.projects ?? []) {
    for (const skillId of project.skillIds) {
      if (!projectBySkill.has(skillId)) projectBySkill.set(skillId, project)
    }
  }
  const resourcesBySkill = new Map<string, ResourceView[]>()
  for (const resource of input.resources ?? []) {
    for (const skillId of resource.matchedSkillIds.length > 0 ? resource.matchedSkillIds : resource.coversIds) {
      const list = resourcesBySkill.get(skillId) ?? []
      if (list.length < 3) list.push(resource)
      resourcesBySkill.set(skillId, list)
    }
  }

  const steps: PathwayStep[] = []
  let orderIndex = 0
  for (const id of order.slice(0, MAX_STEPS)) {
    const mastery = masteryOf(ratings, id)
    if (mastery >= FAMILIAR_THRESHOLD) continue // already familiar → review list only
    const meta = metaById.get(id)
    const careerSkill = careerSkillById.get(id)
    const item = scoreOf.get(id)
    const essential = careerSkill ? careerSkill.essential : true
    const dependencies = (graph.prerequisites.get(id) ?? []).filter((dep) => allIds.includes(dep))
    const project = projectBySkill.get(id)
    const resources = resourcesBySkill.get(id) ?? []
    const hours = hoursOf(id)

    steps.push({
      order: orderIndex++,
      skillId: id,
      name: nameOf(id),
      difficulty: difficultyOf(id),
      reason:
        item?.reason ??
        `${nameOf(id)} is a prerequisite for other skills in this route, so it is scheduled before them.`,
      essential,
      estimatedHours: hours,
      dependsOn: dependencies,
      unlocks: (graph.dependents.get(id) ?? []).filter((dep) => allIds.includes(dep)),
      practice: meta?.practice ?? [`Work through two short exercises that use ${nameOf(id)} in isolation.`],
      completionCriteria:
        meta?.completionCriteria ?? [
          `You can explain ${nameOf(id)} in your own words to another student.`,
          `You applied it once in a small exercise without following a tutorial step by step.`,
        ],
      resourceIds: resources.map((r) => r.id),
      projectIds: project ? [project.id] : [],
      ...(project
        ? {
            milestoneProject: {
              id: project.id,
              name: project.name,
              why: `This project builds ${nameOf(id)} and produces something you can show.`,
            },
          }
        : {}),
    })
  }

  // Milestone projects are scheduled after the last skill they depend on.
  //
  // Moving a step later is only a *preference*: it must never push a prerequisite
  // past something that needs it, or the roadmap would tell a learner to study
  // deep learning before the machine-learning fundamentals it is built on. The
  // cap below keeps a step before its earliest dependent, and the repair pass
  // that follows proves the invariant for the final list.
  const stepBySkill = new Map(steps.map((step) => [step.skillId, step]))
  const earliestDependentOrder = (skillId: string): number => {
    let earliest = Number.POSITIVE_INFINITY
    const seen = new Set<string>()
    const queue = [...(graph.dependents.get(skillId) ?? [])]
    let guard = 0
    while (queue.length > 0 && guard++ < MAX_TRAVERSAL) {
      const id = queue.shift() as string
      if (seen.has(id)) continue
      seen.add(id)
      const dependent = stepBySkill.get(id)
      if (dependent) earliest = Math.min(earliest, dependent.order)
      for (const next of graph.dependents.get(id) ?? []) {
        if (!seen.has(next)) queue.push(next)
      }
    }
    return earliest
  }

  for (const step of steps) {
    if (!step.milestoneProject) continue
    const project = (input.projects ?? []).find((p) => p.id === step.milestoneProject?.id)
    if (!project) continue
    const dependentSteps = steps.filter((s) => project.skillIds.includes(s.skillId))
    const lastOrder = dependentSteps.reduce((max, s) => Math.max(max, s.order), step.order)
    step.order = Math.min(lastOrder, earliestDependentOrder(step.skillId))
  }

  // Deterministic preference order, then a greedy dependency repair: repeatedly
  // take the first step (in preference order) whose prerequisites are already
  // placed. Anything left over is inside a cycle (already reported in `caveats`)
  // and is appended in preference order so nothing is dropped.
  const preferred = [...steps].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const placedSkills = new Set<string>()
  const repaired: PathwayStep[] = []
  const pending = [...preferred]
  while (pending.length > 0) {
    const index = pending.findIndex(
      (step) => step.dependsOn.every((dep) => placedSkills.has(dep) || !stepBySkill.has(dep)),
    )
    const next = index === -1 ? (pending.shift() as PathwayStep) : pending.splice(index, 1)[0]
    repaired.push(next)
    placedSkills.add(next.skillId)
  }

  steps.length = 0
  steps.push(...repaired)
  steps.forEach((step, index) => {
    step.order = index
  })

  const totalLow = steps.reduce((sum, step) => sum + step.estimatedHours[0], 0)
  const totalHigh = steps.reduce((sum, step) => sum + step.estimatedHours[1], 0)

  return {
    careerId: input.careerId,
    careerName: input.careerName,
    generatedAt: new Date().toISOString(),
    inputs: {
      weeklyHours: input.weeklyHours,
      pace: input.pace,
      learningStyle: input.learningStyle,
      difficultyComfort: input.difficultyComfort,
      ratingsUsed: input.ratings.length,
    },
    steps,
    alternatives: buildAlternatives(steps, input, totalLow, totalHigh),
    estimatedHours: [totalLow, totalHigh],
    caveats: [
      CAVEATS.estimates,
      CAVEATS.selfReport,
      CAVEATS.outcomes,
      ...(cyclic.length > 0
        ? [
            `The prerequisite graph contains a cycle involving ${cyclic.slice(0, 3).map(nameOf).join(', ')}, so their relative order is a best guess.`,
          ]
        : []),
    ],
  }
}

function buildAlternatives(
  steps: PathwayStep[],
  input: PathwayInput,
  totalLow: number,
  totalHigh: number,
): AlternativeRoute[] {
  const alternatives: AlternativeRoute[] = []

  const essentials = steps.filter((s) => s.essential)
  const optional = steps.filter((s) => !s.essential)
  if (optional.length > 0 && essentials.length > 0) {
    const essentialLow = essentials.reduce((sum, s) => sum + s.estimatedHours[0], 0)
    const essentialHigh = essentials.reduce((sum, s) => sum + s.estimatedHours[1], 0)
    alternatives.push({
      id: 'essentials-only',
      title: 'Essentials-only route (fastest path to the core skills)',
      description: `Skip the ${optional.length} optional skill(s) marked in the graph and cover only what ${input.careerName} lists as essential.`,
      steps: essentials.map((s) => s.name),
      tradeoff: `Roughly ${Math.max(0, totalLow - essentialLow)}–${Math.max(0, totalHigh - essentialHigh)} fewer hours, but a narrower portfolio and less breadth for interviews.`,
      estimatedHours: [essentialLow, essentialHigh],
    })
    alternatives.push({
      id: 'essentials-plus-optional',
      title: 'Broader route (essentials plus optional specialisations)',
      description:
        'Cover the essential route first, then add the optional skills. Optional skills are not universal requirements, and no single employer expects all of them.',
      steps: steps.map((s) => s.name),
      tradeoff: 'More hours, more breadth, and more options if you later change specialisation.',
      estimatedHours: [totalLow, totalHigh],
    })
  }

  for (const route of input.routes ?? []) {
    if (route.ids.length < 2) continue
    alternatives.push({
      id: `route-${route.targetName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      title: `Route through ${route.names.slice(0, 3).join(' → ')}`,
      description: `The graph connects your starting point to ${route.targetName} in ${route.hops} step(s) following REQUIRES relationships.`,
      steps: route.names,
      tradeoff: 'This is a shorter dependency chain; it assumes you already have the earlier skills in the chain.',
      estimatedHours: [route.ids.length * 4, route.ids.length * 12],
    })
  }

  return alternatives.slice(0, 5)
}

/* ==========================================================================
 * 5. Roadmap
 * ========================================================================== */

export interface RoadmapOptions {
  title?: string
  startDate?: string
  weeklyHours: number
  pace: NonNullable<UserProfileInput['preferredPace']>
  id?: string
  now?: string
}

const DAY_NAMES = ['day 1', 'day 2', 'day 3', 'day 4', 'day 5', 'day 6', 'day 7']

/**
 * Turns a pathway into a scheduled roadmap.
 *
 * Scheduling rules (deliberately simple and explainable):
 *  - capacity per week = weeklyHours × pace multiplier,
 *  - tasks are consumed in topological order, so nothing is scheduled before its
 *    prerequisites (a task never starts in an earlier week than its dependencies),
 *  - a task larger than one week's capacity is placed in the week it starts and
 *    flagged in its note instead of being split into fake sub-tasks,
 *  - a review task is inserted after every third learning task.
 */
export function buildRoadmap(pathway: Pathway, options: RoadmapOptions): Roadmap {
  const capacity = Math.max(1, options.weeklyHours * PACE_MULTIPLIER[options.pace])
  const tasks: RoadmapTask[] = []
  const milestones: Roadmap['milestones'] = []

  let week = 1
  let usedThisWeek = 0
  let learningCount = 0
  const weekOfSkill = new Map<string, number>()

  for (const step of pathway.steps) {
    const expected = (step.estimatedHours[0] + step.estimatedHours[1]) / 2

    // Dependencies may push the task later than the current week.
    const dependencyWeek = step.dependsOn.reduce((max, dep) => Math.max(max, weekOfSkill.get(dep) ?? 1), 1)
    if (dependencyWeek > week) {
      week = dependencyWeek
      usedThisWeek = 0
    } else if (usedThisWeek > 0 && usedThisWeek + expected > capacity) {
      week += 1
      usedThisWeek = 0
    }

    const scheduledDay = Math.min(6, Math.floor((usedThisWeek / capacity) * 7))
    const taskId = options.id ? `${options.id}-${step.skillId}` : step.skillId
    tasks.push({
      ...step,
      taskKey: taskKeyFor('learn', step.order),
      kind: 'learn',
      status: 'not-started',
      scheduledWeek: week,
      scheduledDay,
      notes:
        expected > capacity
          ? `Planned at about ${Math.round(capacity)} h/week, this needs roughly ${Math.round(expected)} h, so it will span more than one week.`
          : undefined,
    })
    weekOfSkill.set(step.skillId, week)
    usedThisWeek += expected
    learningCount += 1

    if (step.milestoneProject) {
      milestones.push({
        id: `milestone-${step.skillId}`,
        title: step.milestoneProject.name,
        afterTaskId: taskId,
        description: step.milestoneProject.why,
      })
    }

    if (learningCount % 3 === 0) {
      tasks.push({
        ...step,
        // Half-steps keep the review row next to what it rehearses while making
        // `order` (and therefore `taskKey`) unique inside the roadmap.
        order: step.order + 0.5,
        taskKey: taskKeyFor('review', step.order + 0.5),
        kind: 'review',
        skillId: step.skillId,
        name: `Review: ${step.name}`,
        reason: 'Spaced review keeps earlier skills usable. Rebuild one small exercise from memory.',
        estimatedHours: [0.5, 1.5],
        status: 'not-started',
        scheduledWeek: week,
        scheduledDay: Math.min(6, scheduledDay + 1),
        projectIds: [],
        milestoneProject: undefined,
        resourceIds: step.resourceIds.slice(0, 1),
        practice: ['Re-derive or re-implement the key idea without notes, then check what you forgot.'],
        completionCriteria: ['You recalled the main idea without looking it up.'],
      } as RoadmapTask)
    }
  }

  tasks.sort((a, b) => a.scheduledWeek - b.scheduledWeek || a.order - b.order)

  const now = options.now ?? new Date().toISOString()
  return {
    // Unique even if two plans are generated inside the same millisecond, because
    // the client keys local progress by this id. Pinned by tests via `options.id`.
    id: options.id ?? `roadmap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    userId: null,
    title: options.title ?? `Roadmap: ${pathway.careerName}`,
    careerId: pathway.careerId,
    careerName: pathway.careerName,
    createdAt: now,
    updatedAt: now,
    weeklyHours: options.weeklyHours,
    pace: options.pace,
    tasks,
    milestones,
    estimateDisclaimer:
      'Weeks and hours are planning estimates that assume the weekly study time you entered. Life happens — reschedule tasks instead of abandoning the plan.',
  }
}

/**
 * Re-schedules everything not yet completed from `fromWeek` onwards, keeping the
 * dependency order intact. Completed/in-progress work is never moved.
 */
export function rescheduleRoadmap(
  roadmap: Roadmap,
  fromWeek: number,
  options: { weeklyHours?: number; pace?: NonNullable<UserProfileInput['preferredPace']>; now?: string },
): Roadmap {
  const weeklyHours = options.weeklyHours ?? roadmap.weeklyHours
  const pace = options.pace ?? roadmap.pace
  const capacity = Math.max(1, weeklyHours * PACE_MULTIPLIER[pace])
  const fixed = roadmap.tasks.filter((task) => task.status === 'completed')
  const movable = roadmap.tasks.filter((task) => task.status !== 'completed').sort((a, b) => a.order - b.order)

  let week = Math.max(1, Math.trunc(fromWeek))
  let used = 0
  const weekOfSkill = new Map<string, number>()
  for (const task of fixed) weekOfSkill.set(task.skillId, task.scheduledWeek)

  const rescheduled: RoadmapTask[] = movable.map((task) => {
    const expected = (task.estimatedHours[0] + task.estimatedHours[1]) / 2
    const dependencyWeek = task.dependsOn.reduce((max, dep) => Math.max(max, weekOfSkill.get(dep) ?? week), week)
    if (dependencyWeek > week) {
      week = dependencyWeek
      used = 0
    } else if (used > 0 && used + expected > capacity) {
      week += 1
      used = 0
    }
    const updated: RoadmapTask = { ...task, scheduledWeek: week }
    weekOfSkill.set(task.skillId, week)
    used += expected
    return updated
  })

  return {
    ...roadmap,
    weeklyHours,
    pace,
    tasks: [...fixed, ...rescheduled].sort((a, b) => a.scheduledWeek - b.scheduledWeek || a.order - b.order),
    updatedAt: options.now ?? new Date().toISOString(),
  }
}

/* ==========================================================================
 * 6. Progress + next activity
 * ========================================================================== */

export function summarizeProgress(tasks: RoadmapTask[]): ProgressSummary {
  const counts = { 'not-started': 0, 'in-progress': 0, completed: 0, 'needs-review': 0 }
  let remainingLow = 0
  let remainingHigh = 0

  for (const task of tasks) {
    counts[task.status] += 1
    if (task.status !== 'completed') {
      remainingLow += task.estimatedHours[0]
      remainingHigh += task.estimatedHours[1]
    }
  }

  const total = tasks.length
  const percentComplete = total === 0 ? 0 : round((counts.completed / total) * 100, 1)

  return {
    totalTasks: total,
    completed: counts.completed,
    inProgress: counts['in-progress'],
    needsReview: counts['needs-review'],
    notStarted: counts['not-started'],
    percentComplete,
    estimatedHoursRemaining: [round(remainingLow, 1), round(remainingHigh, 1)],
  }
}

/**
 * The single next thing the student should do, chosen from real task state:
 * an in-progress task first, then overdue/needs-review, then the earliest
 * unstarted task whose dependencies are complete.
 */
export function nextActivity(roadmap: Roadmap, currentWeek?: number): RoadmapTask | null {
  const week = currentWeek ?? 1
  const done = new Set(roadmap.tasks.filter((t) => t.status === 'completed').map((t) => t.skillId))
  const inProgress = roadmap.tasks.find((t) => t.status === 'in-progress')
  if (inProgress) return inProgress

  const review = roadmap.tasks.find((t) => t.status === 'needs-review' && t.scheduledWeek <= week + 1)
  if (review) return review

  const candidates = roadmap.tasks
    .filter((t) => t.status === 'not-started')
    .filter((t) => t.dependsOn.every((dep) => done.has(dep) || !roadmap.tasks.some((x) => x.skillId === dep)))
    .sort((a, b) => a.scheduledWeek - b.scheduledWeek || a.order - b.order)

  return candidates[0] ?? roadmap.tasks.find((t) => t.status !== 'completed') ?? null
}

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'not-started':
      return 'Not started'
    case 'in-progress':
      return 'In progress'
    case 'completed':
      return 'Completed'
    case 'needs-review':
      return 'Needs review'
    default:
      return status
  }
}

export function dayLabel(index: number): string {
  return DAY_NAMES[index] ?? `day ${index + 1}`
}

/* ==========================================================================
 * 7. Resource / project ranking used by the UI screens
 * ========================================================================== */

export interface RankedProject extends ProjectView {
  /** 0..1: share of the given skills the project covers. */
  coverage: number
  matchReason: string
}

export function rankProjects(projects: ProjectView[], skillIds: string[], limit = 6): RankedProject[] {
  const wanted = unique(skillIds)
  const wantedSet = new Set(wanted)
  return projects
    .map((project) => {
      const covered = project.skillIds.filter((id) => wantedSet.has(id))
      const coverage = wanted.length === 0 ? 0 : clamp(covered.length / wanted.length, 0, 1)
      const matchReason =
        covered.length > 0
          ? `Builds ${covered.length} of the ${wanted.length} skills in this route.`
          : 'Included as a general portfolio project for this career.'
      return { ...project, coverage: round(coverage, 2), matchReason }
    })
    .sort((a, b) => (b.coverage !== a.coverage ? b.coverage - a.coverage : difficultyRank(a.difficulty) - difficultyRank(b.difficulty)))
    .slice(0, limit)
}

export interface RankedResource extends ResourceView {
  matchReason: string
  /** Access model surfaced as a badge; never presented as "free" without a note. */
  accessBadge: string
}

const ACCESS_BADGE: Record<string, string> = {
  'free-open': 'Free & open',
  'free-account': 'Free with an account',
  'free-audit': 'Free to audit',
  'free-with-limits': 'Free tier (limited)',
  mixed: 'Partly free',
  unknown: 'Access not verified',
}

export function accessBadgeFor(accessModel: string): string {
  return ACCESS_BADGE[accessModel] ?? ACCESS_BADGE.unknown
}

export function rankResources(resources: ResourceView[], skillIds: string[], limit = 8): RankedResource[] {
  const wantedSet = new Set(skillIds)
  return resources
    .map((resource) => {
      const covers = (resource.matchedSkillIds.length > 0 ? resource.matchedSkillIds : resource.coversIds).filter((id) =>
        wantedSet.has(id),
      )
      return {
        ...resource,
        matchReason:
          covers.length > 0
            ? `Covers ${covers.length} skill(s) in this route.`
            : 'General reference for the subject area.',
        accessBadge: accessBadgeFor(resource.accessModel),
      }
    })
    .sort((a, b) => {
      // Verified, openly licensed material first; unverified links last.
      const rank = (r: RankedResource) =>
        (r.verification === 'verified' ? 0 : r.verification === 'community' ? 1 : 2) +
        (r.accessModel === 'free-open' ? 0 : r.accessModel === 'unknown' ? 0.5 : 0.25)
      const byTrust = rank(a) - rank(b)
      if (byTrust !== 0) return byTrust
      return a.name.localeCompare(b.name)
    })
    .slice(0, limit)
}

/* ==========================================================================
 * 8. Interest extraction (used to pre-fill the onboarding form)
 * ========================================================================== */

export function inferInterests(careerNames: string[], limit = 8): string[] {
  const tokens = new Map<string, number>()
  for (const name of careerNames) {
    for (const token of tokenize(name)) {
      if (token.length < 4) continue
      tokens.set(token, (tokens.get(token) ?? 0) + 1)
    }
  }
  return [...tokens.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, limit)
    .map(([token]) => token)
}

export function skillStateLabel(state: SkillState): string {
  switch (state) {
    case 'unknown':
      return 'I have never seen this'
    case 'new':
      return 'I know the term only'
    case 'learning':
      return 'I am learning it'
    case 'practised':
      return 'I have practised it'
    case 'confident':
      return 'I can explain and apply it'
    default:
      return state
  }
}

/* ==========================================================================
 * 6. Frontier — the honest delta between what you know and the target
 * ==========================================================================
 *
 * `analyzeSkillGaps` scores a career's *own* skill list. This answers a
 * different question, and it is the one both audiences actually arrive with:
 *
 *   "Given what I already know, what is left, what can I start today, and what
 *    is actually blocking me?"
 *
 * The difference matters. A career lists its requirements, but reaching them
 * means satisfying their prerequisites too — and a prerequisite may be nowhere
 * in the career's list. Those pulled-in skills are named here rather than
 * discovered later, because discovering them after three weeks of study is the
 * failure mode this whole project exists to prevent.
 *
 * Everything below is deterministic: same input, same output, on any machine.
 * That is not decoration — `tools/oracle` recomputes these numbers in Java and
 * the two are compared, so an unspecified ordering would show up as a diff.
 */

/**
 * Ordering for everything the frontier returns.
 *
 * Deliberately *not* `localeCompare`. Two reasons, and the second is the one that
 * matters: locale-aware collation differs between JavaScript engines and the JVM,
 * and `tools/oracle/FrontierOracle.java` recomputes these same lists in Java so
 * the two can be compared. A comparator that depends on the host's locale would
 * make that comparison meaningless — every diff would be a collation difference
 * rather than a disagreement about the graph.
 *
 * This is a plain UTF-16 code-unit comparison, which is what `String.compareTo`
 * does in Java. Ids are ASCII, so it is also simply "alphabetical" for anything a
 * reader will see.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export interface FrontierInput extends SkillGapInput {
  /** Defaults to the career's own skill list. */
  targetIds?: string[]
}

export interface FrontierSkill {
  skillId: string
  name: string
  difficulty: Difficulty
  estimatedHours: [number, number]
  /** Remaining skills that transitively depend on this one. */
  unlocks: number
  /** true = the career lists it as a requirement; false = pulled in by prerequisites. */
  meetsTarget: boolean
}

export interface FrontierReport {
  careerId: string
  careerName: string
  generatedAt: string
  /** Skills the career requires (the goal). */
  targetCount: number
  /** Targets plus every prerequisite they transitively need. */
  closureCount: number
  /** How many of that closure the person already meets. */
  knownInClosure: number
  remainingCount: number
  /** Remaining skills with nothing unmet in front of them — startable now. */
  frontier: FrontierSkill[]
  /** Remaining skills that block the most other remaining skills. */
  gates: FrontierSkill[]
  /** Longest chain of prerequisites inside what is left. Cannot be parallelised. */
  criticalChain: Array<{ skillId: string; name: string }>
  /** Every remaining skill, deepest-chain-last, each naming what it needs first. */
  remaining: Array<FrontierSkill & { depth: number; needsNow: string[] }>
  /** Required for the route, but not itself a career requirement. */
  pulledIn: Array<{ skillId: string; name: string }>
  hours: {
    low: number
    high: number
    /** A range, because a single number here would pretend to a precision this data does not have. */
    weeksAtWeeklyHours: { low: number; high: number } | null
    weeklyHours: number | null
  }
  /** Remaining skills the gate set unblocks between them (a union, never a sum). */
  gatesUnlock: number
  /**
   * How deep in the remaining chain each remaining skill sits (1 = nothing unmet
   * in front of it). Exposed because it is the number the critical chain is
   * derived from, and because a second implementation recomputes it in Java —
   * comparing the map catches a divergence the single winning chain would hide.
   */
  depths: Array<{ skillId: string; depth: number }>
  cyclic: string[]
  caveats: string[]
  /** One sentence, stable and diffable — the same string the Java oracle builds. */
  summaryLine: string
}

export function analyzeFrontier(input: FrontierInput): FrontierReport {
  const metaById = new Map(input.skillMeta.map((meta) => [meta.id, meta]))
  const nameOf = (id: string) => metaById.get(id)?.name ?? id
  const difficultyOf = (id: string): Difficulty => metaById.get(id)?.difficulty ?? 'beginner'
  const hoursOf = (id: string): [number, number] => {
    const meta = metaById.get(id)
    return meta ? [meta.estimatedHoursLow, meta.estimatedHoursHigh] : DEFAULT_SKILL_HOURS
  }

  const ratings = new Map(input.ratings.map((rating) => [rating.skillId, rating]))
  /** The engine's own definition of "met", reused so the two never disagree. */
  const met = (id: string) => masteryOf(ratings, id) >= PREREQ_MET_THRESHOLD

  const targetIds = unique(input.targetIds ?? input.careerSkills.map((skill) => skill.id))
  const allIds = unique([...input.skillMeta.map((meta) => meta.id), ...targetIds])
  const graph = buildPrereqGraph(allIds, input.prereqEdges)

  /* --- transitive prerequisite closure of the targets ------------------- */
  const closure = new Set<string>()
  const queue = [...targetIds]
  let guard = 0
  while (queue.length > 0 && guard++ < MAX_TRAVERSAL) {
    const current = queue.shift() as string
    if (closure.has(current)) continue
    closure.add(current)
    for (const prereq of graph.prerequisites.get(current) ?? []) {
      if (!closure.has(prereq)) queue.push(prereq)
    }
  }

  const closureIds = [...closure].sort(compareCodeUnits)
  const remainingIds = closureIds.filter((id) => !met(id))
  const remainingSet = new Set(remainingIds)
  const targetSet = new Set(targetIds)

  /* --- gates: how many remaining skills each remaining skill unblocks ---- */
  const unlocksCount = (id: string): number => {
    const seen = new Set<string>()
    const walk = [...(graph.dependents.get(id) ?? [])]
    let steps = 0
    while (walk.length > 0 && steps++ < MAX_TRAVERSAL) {
      const current = walk.shift() as string
      if (seen.has(current)) continue
      if (!remainingSet.has(current)) continue
      seen.add(current)
      for (const next of graph.dependents.get(current) ?? []) {
        if (!seen.has(next)) walk.push(next)
      }
    }
    return seen.size
  }

  const toFrontierSkill = (id: string): FrontierSkill => ({
    skillId: id,
    name: nameOf(id),
    difficulty: difficultyOf(id),
    estimatedHours: hoursOf(id),
    unlocks: unlocksCount(id),
    meetsTarget: targetSet.has(id),
  })

  /** Startable now: nothing unmet in front of it. */
  const frontier = remainingIds
    .filter((id) => (graph.prerequisites.get(id) ?? []).every((prereq) => !remainingSet.has(prereq)))
    .map(toFrontierSkill)
    .sort((a, b) => b.unlocks - a.unlocks || compareCodeUnits(a.name, b.name) || compareCodeUnits(a.skillId, b.skillId))

  const gates = remainingIds
    .map(toFrontierSkill)
    .filter((skill) => skill.unlocks > 0)
    .sort((a, b) => b.unlocks - a.unlocks || compareCodeUnits(a.name, b.name) || compareCodeUnits(a.skillId, b.skillId))
    .slice(0, 3)

  /**
   * How much of the route the gate set unblocks *between them*.
   *
   * Deliberately a union, not a sum: a skill sitting behind two gates would
   * otherwise be counted twice, which is how a "these unlock 18 skills" headline
   * becomes a number nobody can verify. Walking the gates together also counts
   * skills that only become reachable once both are met.
   */
  const unlockedByGates = (() => {
    const seen = new Set<string>()
    const walk = gates.flatMap((gate) => graph.dependents.get(gate.skillId) ?? [])
    let steps = 0
    while (walk.length > 0 && steps++ < MAX_TRAVERSAL) {
      const current = walk.shift() as string
      if (seen.has(current) || !remainingSet.has(current)) continue
      seen.add(current)
      for (const next of graph.dependents.get(current) ?? []) {
        if (!seen.has(next)) walk.push(next)
      }
    }
    // The gates themselves are work to do, not work they unlock.
    for (const gate of gates) seen.delete(gate.skillId)
    return seen.size
  })()

  /* --- critical chain: longest prerequisite path still ahead ------------ */
  const depthOf = new Map<string, number>()
  const parentOf = new Map<string, string | null>()
  const ordered = topologicalOrder(remainingIds, graph).order.filter((id) => remainingSet.has(id))
  for (const id of ordered) {
    const unmetPrereqs = (graph.prerequisites.get(id) ?? []).filter((prereq) => remainingSet.has(prereq))
    let depth = 1
    let parent: string | null = null
    for (const prereq of unmetPrereqs) {
      const candidate = (depthOf.get(prereq) ?? 1) + 1
      if (candidate > depth || (candidate === depth && parent !== null && compareCodeUnits(nameOf(prereq), nameOf(parent)) < 0)) {
        depth = candidate
        parent = prereq
      }
    }
    depthOf.set(id, depth)
    parentOf.set(id, parent)
  }

  let chainEnd: string | null = null
  for (const id of [...remainingIds].sort(compareCodeUnits)) {
    const depth = depthOf.get(id) ?? 1
    if (
      chainEnd === null ||
      depth > (depthOf.get(chainEnd) ?? 1) ||
      (depth === (depthOf.get(chainEnd) ?? 1) && compareCodeUnits(nameOf(id), nameOf(chainEnd)) < 0)
    ) {
      chainEnd = id
    }
  }
  const criticalChain: Array<{ skillId: string; name: string }> = []
  let cursor = chainEnd
  let chainGuard = 0
  while (cursor && chainGuard++ < MAX_TRAVERSAL) {
    criticalChain.unshift({ skillId: cursor, name: nameOf(cursor) })
    cursor = parentOf.get(cursor) ?? null
  }

  /* --- hours and the honest week estimate ------------------------------ */
  let low = 0
  let high = 0
  for (const id of remainingIds) {
    const [lo, hi] = hoursOf(id)
    low += lo
    high += hi
  }
  const weeklyHours = typeof input.weeklyHours === 'number' && input.weeklyHours > 0 ? input.weeklyHours : null

  const remaining = ordered
    .map((id) => ({
      ...toFrontierSkill(id),
      /** How many prerequisite steps deep this sits; the plan's step number. */
      depth: depthOf.get(id) ?? 1,
      needsNow: (graph.prerequisites.get(id) ?? [])
        .filter((prereq) => remainingSet.has(prereq))
        .map(nameOf)
        .sort(compareCodeUnits),
    }))
    .sort(
      (a, b) =>
        (depthOf.get(a.skillId) ?? 1) - (depthOf.get(b.skillId) ?? 1) ||
        b.unlocks - a.unlocks ||
        compareCodeUnits(a.skillId, b.skillId),
    )

  const pulledIn = closureIds
    .filter((id) => !targetSet.has(id))
    .map((id) => ({ skillId: id, name: nameOf(id) }))

  const cyclic = graph.cyclic.filter((id) => closure.has(id))
  const caveats = [CAVEATS.selfReport, CAVEATS.estimates]
  if (cyclic.length > 0) {
    caveats.push(
      `The graph contains a prerequisite cycle (${cyclic.slice(0, 4).join(', ')}), so the chain length and order for those items are approximate.`,
    )
  }
  if (pulledIn.length > 0) {
    caveats.push(
      `${pulledIn.length} skill(s) in this delta are prerequisites of the career's requirements rather than requirements themselves.`,
    )
  }

  const summaryLine =
    remainingIds.length === 0
      ? `Nothing left in this route: all ${targetIds.length} target skills and their ${closureIds.length - targetIds.length} prerequisites are already met.`
      : `${remainingIds.length} skill(s) to go: ${frontier.length} startable now, ${gates.length > 0 ? `${gates.length} gate(s) unblock ${unlockedByGates}` : 'no gates left'}, longest chain ${criticalChain.length} deep.`

  return {
    careerId: input.careerId,
    careerName: input.careerName,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    targetCount: targetIds.length,
    closureCount: closureIds.length,
    knownInClosure: closureIds.length - remainingIds.length,
    remainingCount: remainingIds.length,
    frontier,
    gates,
    criticalChain,
    remaining,
    pulledIn,
    hours: {
      low: round(low),
      high: round(high),
      weeksAtWeeklyHours:
        weeklyHours === null || remainingIds.length === 0
          ? null
          : { low: Math.ceil(low / weeklyHours), high: Math.ceil(high / weeklyHours) },
      weeklyHours,
    },
    gatesUnlock: unlockedByGates,
    depths: [...remainingIds].sort(compareCodeUnits).map((id) => ({ skillId: id, depth: depthOf.get(id) ?? 1 })),
    cyclic,
    caveats,
    summaryLine,
  }
}


