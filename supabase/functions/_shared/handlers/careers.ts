/**
 * Career endpoints.
 *
 *   GET  /get-careers?q=&branch=&difficulty=&limit=&offset=
 *   GET  /get-career-details?id=          (the alias careerId= is accepted)
 *   POST /get-career-path  { careerId, fromSkillId?, mode?, maxDepth? }
 *
 * All three are public: a visitor must be able to explore careers without an
 * account (acceptance criterion 2). They are read-only, rate limited, and cached
 * briefly so repeated identical reads do not consume the free Neo4j tier.
 */
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { parseJsonBody, publicJson } from '../core/http.ts'
import { AppError } from '../core/errors.ts'
import {
  careerDetailsQuerySchema,
  careerPathQuerySchema,
  careerSearchQuerySchema,
  coerceQuery,
  parseOrThrow,
} from '../core/validate.ts'
import type { CareerDetailsResponse, CareerPathResponse, CareerSummaryResponse } from '../core/contracts.ts'
import type { ResourceView } from '../core/graphReader.ts'
import { accessBadgeFor, buildPathway, rankResources, CAVEATS } from '../core/recommend.ts'
import { graphBasisLine } from '../core/graphModel.ts'
import type { Runtime } from '../runtime.ts'
import { enforceRateLimit, metaFor, notFoundFor, requireReader } from './shared.ts'

/* -------------------------------------------------------------------------- */
/* GET /get-careers                                                            */
/* -------------------------------------------------------------------------- */

export async function getCareersHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.readPerMinute, 'careers-read')

  const input = parseOrThrow(
    careerSearchQuerySchema,
    coerceQuery(Object.fromEntries(request.url.searchParams.entries()), { numbers: ['limit', 'offset'] }),
  )

  const started = Date.now()
  const [branches, careers] = await Promise.all([
    reader.listBranches(40),
    // Any filter — not only free text — goes through search, or a branch-only
    // filter would silently return the whole catalogue.
    input.q || input.branch || input.difficulty
      ? reader.searchCareers({
          ...(input.q ? { q: input.q } : {}),
          ...(input.branch ? { branchId: input.branch } : {}),
          ...(input.difficulty ? { difficulty: input.difficulty } : {}),
          limit: input.limit ?? 60,
          offset: input.offset ?? 0,
        })
      : reader.listCareers(input.limit ?? 60),
  ])

  const payload: CareerSummaryResponse = {
    careers: careers.value.map((career) => ({
      id: career.id,
      name: career.name,
      summary: career.summary,
      ...(career.difficulty ? { difficulty: career.difficulty } : {}),
      ...(career.verification ? { verification: career.verification } : {}),
      branchIds: career.branchIds,
      skillCount: career.skillIds?.length ?? 0,
    })),
    branches: branches.value,
    filters: { query: input.q ?? '', branch: input.branch ?? null, difficulty: input.difficulty ?? null },
    total: careers.value.length,
  }

  return publicJson(
    200,
    {
      ok: true,
      data: payload,
      meta: metaFor(reader, { ms: Date.now() - started, truncated: careers.value.length >= (input.limit ?? 60) }),
    },
    { 'cache-control': 'public, max-age=120, stale-while-revalidate=600' },
  )
}

/* -------------------------------------------------------------------------- */
/* GET /get-career-details                                                     */
/* -------------------------------------------------------------------------- */

export async function getCareerDetailsHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.readPerMinute, 'career-details')

  const input = parseOrThrow(
    careerDetailsQuerySchema,
    coerceQuery(Object.fromEntries(request.url.searchParams.entries()), { booleans: ['includeGraph'] }),
  )

  // The web client calls this endpoint with `id`; `careerId` stays supported.
  const careerId = input.careerId ?? input.id
  if (!careerId) {
    throw new AppError('validation_failed', {
      requestId: request.requestId,
      fields: { id: 'Pass the career id, e.g. ?id=career:robotics-engineer.' },
      publicMessage: 'Which career should be shown? Add its id to the request.',
    })
  }

  const started = Date.now()
  const { value: career } = await reader.getCareer(careerId)
  if (!career) throw notFoundFor('career', careerId, request)

  const skillIds = career.skills.map((skill) => skill.id)
  const [projects, resources] = await Promise.all([
    reader.findProjects({ careerId: career.id, limit: 6 }),
    reader.findResources({ skillIds: skillIds.slice(0, 20), limit: 8 }),
  ])

  const graphBasis = [
    ...career.branches.map((branch) => graphBasisLine('BELONGS_TO', career.id, branch.id)),
    ...career.skills.slice(0, 8).map((skill) => graphBasisLine('REQUIRES_SKILL', career.id, skill.id)),
    ...career.related.slice(0, 4).map((related) => graphBasisLine('RELATED_TO', career.id, related.id)),
  ]

  const caveats = [
    CAVEATS.outcomes,
    CAVEATS.coverage,
    career.assumptions[0] ??
      'Skill lists and routes reflect this curriculum graph, not a specific employer’s requirements.',
  ]

  const payload: CareerDetailsResponse = {
    career: {
      id: career.id,
      label: 'Career',
      name: career.name,
      slug: career.id.split(':')[1],
      summary: career.summary,
      description: career.description,
      // The entity keeps these optional; the DTO promises a value, and the graph
      // reader already applies these same defaults for missing properties.
      difficulty: career.difficulty ?? 'intermediate',
      verification: career.verification ?? 'unverified',
      branches: career.branches,
      responsibilities: career.responsibilities,
      portfolioIdeas: career.portfolioIdeas,
      assumptions: career.assumptions,
      typicalRoles: career.typicalRoles,
      relatedCareers: career.related,
      skills: career.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        ...(skill.summary ? { summary: skill.summary } : {}),
        difficulty: skill.difficulty,
        essential: skill.essential,
        weight: skill.weight,
      })),
    },
    projects: projects.value.map((project) => ({
      id: project.id,
      name: project.name,
      difficulty: project.difficulty,
      summary: project.summary,
      deliverables: project.deliverables.slice(0, 5),
      safetyNotes: project.safetyNotes.slice(0, 4),
    })),
    resources: resources.value.map((resource) => ({
      id: resource.id,
      name: resource.name,
      provider: resource.provider,
      url: resource.url,
      accessBadge: accessBadgeFor(resource.accessModel),
    })),
    graphBasis,
    caveats,
  }

  return publicJson(
    200,
    { ok: true, data: payload, meta: metaFor(reader, { ms: Date.now() - started }) },
    { 'cache-control': 'public, max-age=120, stale-while-revalidate=600' },
  )
}

/* -------------------------------------------------------------------------- */
/* POST /get-career-path                                                       */
/* -------------------------------------------------------------------------- */

export async function getCareerPathHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.analysisPerMinute, 'career-path')

  const body = parseJsonBody(request)
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const input = parseOrThrow(careerPathQuerySchema, {
    ...raw,
    // Allow the same schema to be driven by query string for simple calls.
    ...(typeof raw.careerId === 'undefined'
      ? coerceQuery(Object.fromEntries(request.url.searchParams.entries()), { numbers: ['maxDepth'] })
      : {}),
  })

  const started = Date.now()
  const [{ value: career }, skillMetaPromise] = await Promise.all([
    reader.getCareer(input.careerId),
    reader.getCareerClosure(input.careerId, input.maxDepth ?? 4, 200),
  ])
  if (!career) throw notFoundFor('career', input.careerId, request)

  const closure = await skillMetaPromise
  if (closure.value.length === 0) {
    throw new AppError('not_found', {
      requestId: request.requestId,
      publicMessage: `The graph has no skills recorded for "${career.name}" yet, so no pathway can be built. Try seeding the graph or choosing another career.`,
    })
  }

  const skillIds = closure.value.map((skill) => skill.id)
  const [{ value: prereqEdges }, projects, resources] = await Promise.all([
    reader.getSkillEdges(skillIds, 400),
    reader.findProjects({ careerId: career.id, limit: 6 }),
    reader.findResources({ skillIds: skillIds.slice(0, 20), limit: 10 }),
  ])

  const pathway = buildPathway({
    careerId: career.id,
    careerName: career.name,
    careerSkills: career.skills,
    skillMeta: closure.value,
    prereqEdges,
    ratings: [],
    interests: [],
    weeklyHours: 6,
    pace: 'steady',
    learningStyle: 'mixed',
    difficultyComfort: 'beginner',
    projects: projects.value,
    resources: resources.value,
  })

  const routes =
    input.fromSkillId && input.mode !== 'downstream'
      ? (await reader.getRoutes(career.id, input.fromSkillId, 5)).value.map((route) => ({
          names: route.names,
          targetName: route.targetName,
          hops: route.hops,
        }))
      : []

  const payload: CareerPathResponse = {
    pathway,
    career: { id: career.id, name: career.name, summary: career.summary },
    routes,
    essentialsCount: career.skills.filter((skill) => skill.essential).length,
    optionalCount: career.skills.filter((skill) => !skill.essential).length,
  }

  return publicJson(
    200,
    {
      ok: true,
      data: payload,
      meta: metaFor(reader, {
        ms: Date.now() - started,
        truncated: closure.truncated ?? false,
        selectionNote: `Prerequisites expanded up to ${input.maxDepth ?? 4} step(s) from the direct skills of ${career.name}.`,
      }),
    },
    { 'cache-control': 'public, max-age=300, stale-while-revalidate=900' },
  )
}

/* -------------------------------------------------------------------------- */
/* Shared helper: resource ranking for the resources screen                    */
/* -------------------------------------------------------------------------- */

export function rankResourceViews(resources: ResourceView[], skillIds: string[], limit: number) {
  return rankResources(resources, skillIds, limit)
}

export function rankProjectViews<T extends { id: string }>(projects: T[], _skillIds: string[], limit: number) {
  return projects.slice(0, limit)
}


