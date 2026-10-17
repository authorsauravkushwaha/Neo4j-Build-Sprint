/**
 * Graph + catalogue endpoints.
 *
 *   GET|POST /get-graph?seedId=|careerId=&depth=&labels=&relations=&difficulty=&limit=
 *   GET|POST /get-resources?q=&skillId=&skillIds=&careerId=&format=&accessModel=&difficulty=&limit=
 *   GET|POST /get-projects?careerId=&skillIds=&difficulty=&limit=
 *
 * Input is read from the JSON body when one is present (the web client POSTs)
 * and from the query string otherwise (shareable GET links and curl). The
 * validation schema is the same in both cases.
 *
 * Bounded by design: depth ≤ 3, nodes ≤ 300 by default (`NEO4J_MAX_ROWS`), and
 * every edge returned has both endpoints present in the same payload, so the
 * visualisation can never render a dangling edge.
 */
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { parseJsonBody, publicJson } from '../core/http.ts'
import { AppError } from '../core/errors.ts'
import {
  coerceQuery,
  neighborhoodQuerySchema,
  parseOrThrow,
  projectsQuerySchema,
  resourcesQuerySchema,
} from '../core/validate.ts'
import type { GraphExploreResponse, ProjectListResponse, ResourceListResponse } from '../core/contracts.ts'
import { DEFAULT_VISIBLE_RELATIONS, legend, RELATION_META } from '../core/graphModel.ts'
import { accessBadgeFor, rankProjects, rankResources } from '../core/recommend.ts'
import type { NodeLabel, RelationType } from '../core/types.ts'
import type { Runtime } from '../runtime.ts'
import { enforceRateLimit, metaFor, requireReader } from './shared.ts'

/**
 * Where an endpoint's input comes from. The React client POSTs a small JSON
 * body; GET with query parameters stays supported so a filtered view can be a
 * link and so curl works without a body. A body must be a single JSON object —
 * anything else is a 400, never a silent fallthrough to defaults.
 */
function endpointInput(
  request: ApiRequest,
  options: { numbers?: string[]; booleans?: string[]; lists?: string[] } = {},
): Record<string, unknown> {
  if (request.bodyText.trim()) {
    const body = parseJsonBody(request)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AppError('bad_request', {
        requestId: request.requestId,
        publicMessage: 'The request body must be a single JSON object.',
      })
    }
    return body as Record<string, unknown>
  }
  return coerceQuery(Object.fromEntries(request.url.searchParams.entries()), options)
}

export async function getGraphHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.readPerMinute, 'graph-read')

  const input = parseOrThrow(
    neighborhoodQuerySchema,
    endpointInput(request, {
      numbers: ['depth', 'limit'],
      lists: ['labels', 'relations'],
    }),
  )

  if (!input.seedId && !input.careerId) {
    // No silent "load everything": the explorer must ask for a bounded subgraph.
    return publicJson(200, {
      ok: true,
      data: {
        graph: {
          seedId: null,
          nodes: [],
          edges: [],
          truncated: false,
          selectionNote:
            'Choose a career or search for a node to load a bounded subgraph. Loading the whole graph is intentionally not possible.',
        },
        legend: legend(),
        relationLegend: DEFAULT_VISIBLE_RELATIONS.map((type) => ({
          type,
          description: RELATION_META[type].description,
          optional: Boolean(RELATION_META[type].optional),
        })),
        focusId: null,
      } satisfies GraphExploreResponse,
      meta: metaFor(reader),
    })
  }

  const result = await reader.getNeighborhood({
    ...(input.seedId ? { seedId: input.seedId } : {}),
    ...(input.careerId ? { careerId: input.careerId } : {}),
    depth: input.depth ?? 1,
    ...(input.labels ? { labels: input.labels as NodeLabel[] } : {}),
    ...(input.relations ? { relations: input.relations as RelationType[] } : {}),
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    limit: input.limit ?? 120,
  })

  const payload: GraphExploreResponse = {
    graph: result.value,
    legend: legend(),
    relationLegend: DEFAULT_VISIBLE_RELATIONS.map((type) => ({
      type,
      description: RELATION_META[type].description,
      optional: Boolean(RELATION_META[type].optional),
    })),
    focusId: result.value.seedId,
  }

  return publicJson(
    200,
    { ok: true, data: payload, meta: metaFor(reader, { ms: result.ms, truncated: result.value.truncated, selectionNote: result.value.selectionNote }) },
    { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' },
  )
}

export async function getResourcesHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.readPerMinute, 'resources-read')

  const input = parseOrThrow(
    resourcesQuerySchema,
    endpointInput(request, { numbers: ['limit'], lists: ['skillIds'] }),
  )

  // `skillIds` (array, what the client sends) wins over the single-id form.
  const skillIds = input.skillIds ?? (input.skillId ? [input.skillId] : undefined)
  const result = await reader.findResources({
    ...(skillIds ? { skillIds } : {}),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.q ? { q: input.q } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.accessModel ? { accessModel: input.accessModel } : {}),
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    limit: input.limit ?? 20,
  })

  const ranked = rankResources(result.value, skillIds ?? [], input.limit ?? 20)
  const payload: ResourceListResponse = {
    resources: ranked.map((resource) => ({
      id: resource.id,
      name: resource.name,
      summary: resource.summary,
      url: resource.url,
      provider: resource.provider,
      format: resource.format,
      difficulty: resource.difficulty,
      language: resource.language,
      accessModel: resource.accessModel,
      accessBadge: resource.accessBadge,
      accessNote: resource.accessNote,
      outcomes: resource.outcomes,
      assumes: resource.assumes,
      limits: resource.limits,
      commitment: resource.commitment,
      estimatedHours: resource.estimatedHours,
      assumesSkills: resource.assumesIds.map((id, index) => ({ id, name: resource.assumesNames[index] ?? id })),
      lastVerified: resource.lastVerified,
      verification: resource.verification,
      covers: resource.coversIds.map((id, index) => ({ id, name: resource.coversNames[index] ?? id })),
      matchReason: resource.matchReason,
    })),
    filters: {
      query: input.q ?? null,
      skillId: input.skillId ?? null,
      subjectId: input.subjectId ?? null,
      format: input.format ?? null,
      accessModel: input.accessModel ?? null,
      difficulty: input.difficulty ?? null,
    },
    total: ranked.length,
  }

  return publicJson(
    200,
    { ok: true, data: payload, meta: metaFor(reader, { ms: result.ms, truncated: result.truncated ?? false }) },
    { 'cache-control': 'public, max-age=300, stale-while-revalidate=900' },
  )
}

export async function getProjectsHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.readPerMinute, 'projects-read')

  const input = parseOrThrow(
    projectsQuerySchema,
    endpointInput(request, { numbers: ['limit'], lists: ['skillIds'] }),
  )

  const result = await reader.findProjects({
    ...(input.skillIds ? { skillIds: input.skillIds } : {}),
    ...(input.careerId ? { careerId: input.careerId } : {}),
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    limit: input.limit ?? 8,
  })

  const ranked = rankProjects(result.value, input.skillIds ?? [], input.limit ?? 8)

  const payload: ProjectListResponse = {
    projects: ranked.map((project) => ({
      id: project.id,
      name: project.name,
      summary: project.summary,
      difficulty: project.difficulty,
      objectives: project.objectives,
      deliverables: project.deliverables,
      milestones: project.milestones,
      testingIdeas: project.testingIdeas,
      extensions: project.extensions,
      safetyNotes: project.safetyNotes,
      tools: project.tools,
      skillIds: project.skillIds,
      estimatedHours: project.estimatedHours,
      coverage: project.coverage,
      matchReason: project.matchReason,
    })),
    filters: {
      careerId: input.careerId ?? null,
      difficulty: input.difficulty ?? null,
      skillIds: input.skillIds?.join(',') ?? null,
    },
    total: ranked.length,
  }

  return publicJson(
    200,
    { ok: true, data: payload, meta: metaFor(reader, { ms: result.ms, truncated: result.truncated ?? false }) },
    { 'cache-control': 'public, max-age=300, stale-while-revalidate=900' },
  )
}

export { accessBadgeFor }


