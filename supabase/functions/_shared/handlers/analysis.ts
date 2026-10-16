/**
 * Deterministic analysis endpoints (no AI required).
 *
 *   POST /analyze-skill-gaps        { careerId, ratings[], interests[], weeklyHours, difficultyComfort }
 *   POST /generate-learning-roadmap { careerId, ratings[], weeklyHours, pace, learningStyle, startDate }
 *
 * Both work for guests: nothing here reads or writes user records. Rate limited,
 * and the response always carries the caveats that make the numbers honest.
 */
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { json, parseJsonBody } from '../core/http.ts'
import { analyzeSkillGapsBodySchema, generateRoadmapBodySchema, parseOrThrow } from '../core/validate.ts'
import type { RoadmapGenerateResponse, SkillGapResponse } from '../core/contracts.ts'
import { analyzeFrontier, analyzeSkillGaps, buildPathway, buildRoadmap, rankProjects, CAVEATS } from '../core/recommend.ts'
import type { GapCategory } from '../core/types.ts'
import type { Runtime } from '../runtime.ts'
import { enforceRateLimit, metaFor, requireReader } from './shared.ts'
import { loadCareerSlice } from './graphData.ts'

const CATEGORY_LABELS: Record<GapCategory, string> = {
  'already-familiar': 'Already familiar',
  'ready-to-practice': 'Ready to practise',
  'recommended-next': 'Recommended next',
  'missing-prerequisite': 'Missing prerequisite',
  'optional-specialization': 'Optional specialisation',
}

export async function analyzeSkillGapsHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.analysisPerMinute, 'skill-gap')

  const input = parseOrThrow(analyzeSkillGapsBodySchema, parseJsonBody(request))
  const slice = await loadCareerSlice(reader, input.careerId, request)

  const report = analyzeSkillGaps({
    careerId: slice.careerId,
    careerName: slice.careerName,
    careerSkills: slice.careerSkills,
    skillMeta: slice.skillMeta,
    prereqEdges: slice.prereqEdges,
    ratings: input.ratings,
    interests: input.interests,
    ...(input.weeklyHours !== undefined ? { weeklyHours: input.weeklyHours } : {}),
    ...(input.difficultyComfort ? { difficultyComfort: input.difficultyComfort } : {}),
    includeOptionalPaths: input.includeOptionalPaths ?? true,
  })

  /*
   * The frontier is computed from the same slice and the same ratings as the
   * report. It is deliberately a second call into the engine rather than a
   * derivation of the first: `analyzeSkillGaps` scores a career's own list,
   * while the frontier needs the *closure* — the prerequisites those skills
   * drag in — which is a different walk over the same graph.
   */
  const frontier = analyzeFrontier({
    careerId: slice.careerId,
    careerName: slice.careerName,
    careerSkills: slice.careerSkills,
    skillMeta: slice.skillMeta,
    prereqEdges: slice.prereqEdges,
    ratings: input.ratings,
    interests: input.interests,
    ...(input.weeklyHours !== undefined ? { weeklyHours: input.weeklyHours } : {}),
    ...(input.difficultyComfort ? { difficultyComfort: input.difficultyComfort } : {}),
  })

  const missing = report.items
    .filter((item) => item.category === 'missing-prerequisite' || item.category === 'recommended-next')
    .map((item) => item.skillId)

  const rankedProjects = rankProjects(slice.projects, missing.slice(0, 20), 5)

  const payload: SkillGapResponse = {
    report,
    frontier,
    categoryLabels: CATEGORY_LABELS,
    projects: rankedProjects.map((project) => ({
      id: project.id,
      name: project.name,
      difficulty: project.difficulty,
      coverage: project.coverage,
      matchReason: project.matchReason,
      summary: project.summary,
    })),
  }

  return json(
    200,
    {
      ok: true,
      data: payload,
      meta: metaFor(reader, {
        ms: slice.ms,
        truncated: slice.truncated,
        selectionNote: `Prerequisites expanded up to ${slice.limits.depth} step(s); ${slice.skillMeta.length} skill(s) considered.`,
      }),
    },
    { 'cache-control': 'no-store' },
  )
}

export async function generateLearningRoadmapHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.analysisPerMinute, 'roadmap')

  const input = parseOrThrow(generateRoadmapBodySchema, parseJsonBody(request))
  const slice = await loadCareerSlice(reader, input.careerId, request)

  const pathway = buildPathway({
    careerId: slice.careerId,
    careerName: slice.careerName,
    careerSkills: slice.careerSkills,
    skillMeta: slice.skillMeta,
    prereqEdges: slice.prereqEdges,
    ratings: input.ratings,
    interests: input.interests,
    weeklyHours: input.weeklyHours,
    pace: input.pace,
    learningStyle: input.learningStyle,
    difficultyComfort: input.difficultyComfort,
    projects: slice.projects,
    resources: slice.resources,
  })

  const roadmap = buildRoadmap(pathway, {
    weeklyHours: input.weeklyHours,
    pace: input.pace,
    ...(input.title ? { title: input.title } : {}),
    ...(input.startDate ? { startDate: input.startDate } : {}),
  })

  const payload: RoadmapGenerateResponse = {
    roadmap,
    pathwayMeta: {
      stepsUsed: pathway.steps.length,
      alternativesConsidered: pathway.alternatives.length,
      caveats: [...pathway.caveats, CAVEATS.outcomes],
    },
  }

  // Roadmaps contain the learner's ratings, so this response is private.
  return json(
    200,
    {
      ok: true,
      data: payload,
      meta: metaFor(reader, {
        ms: slice.ms,
        truncated: slice.truncated,
        selectionNote: `${pathway.steps.length} step(s) scheduled at ${input.weeklyHours} h/week, ${input.pace} pace.`,
      }),
    },
    { 'cache-control': 'no-store' },
  )
}


