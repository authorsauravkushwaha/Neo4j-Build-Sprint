/**
 * GET /get-skill-details?skillId=skill:mechanics
 *
 * One skill with its prerequisites, what it unlocks, the tools it uses, the
 * projects that practise it, verified learning resources and (optionally) a
 * short self-check. Public and cacheable.
 */
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { publicJson } from '../core/http.ts'
import { coerceQuery, parseOrThrow, skillDetailsQuerySchema } from '../core/validate.ts'
import type { SkillDetailsResponse } from '../core/contracts.ts'
import { accessBadgeFor, CAVEATS } from '../core/recommend.ts'
import { graphBasisLine } from '../core/graphModel.ts'
import type { Runtime } from '../runtime.ts'
import { enforceRateLimit, metaFor, notFoundFor, requireReader } from './shared.ts'

export async function getSkillDetailsHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.readPerMinute, 'skill-details')

  const input = parseOrThrow(
    skillDetailsQuerySchema,
    coerceQuery(Object.fromEntries(request.url.searchParams.entries())),
  )

  const started = Date.now()
  const { value: skill } = await reader.getSkill(input.skillId)
  if (!skill) throw notFoundFor('skill', input.skillId, request)

  const [assessments, resources] = await Promise.all([
    reader.getAssessments([skill.id], 4),
    skill.resources.length > 0
      ? reader.findResources({ skillIds: [skill.id], limit: 6 })
      : Promise.resolve({ value: [], ms: 0 }),
  ])

  // Prefer resource records when available; fall back to the skill's own links.
  const resourceList =
    resources.value.length > 0
      ? resources.value.map((resource) => ({
          id: resource.id,
          name: resource.name,
          provider: resource.provider,
          url: resource.url,
          accessBadge: accessBadgeFor(resource.accessModel),
          verification: resource.verification,
        }))
      : skill.resources.map((resource) => ({
          id: resource.id,
          name: resource.name,
          provider: resource.provider ?? 'provider not recorded',
          url: resource.url ?? '',
          accessBadge: 'access not verified',
          verification: 'unverified' as const,
        }))

  const payload: SkillDetailsResponse = {
    skill: {
      id: skill.id,
      name: skill.name,
      summary: skill.summary ?? '',
      description: skill.description,
      difficulty: skill.difficulty,
      estimatedHours: [skill.estimatedHoursLow, skill.estimatedHoursHigh],
      practice: skill.practice,
      completionCriteria: skill.completionCriteria,
      prerequisites: skill.prerequisites,
      unlocks: skill.unlocks,
      tools: skill.tools,
      languages: skill.languages,
      projects: skill.projects,
    },
    resources: resourceList,
    assessments: assessments.value.map((assessment) => ({
      id: assessment.id,
      name: assessment.name,
      skillId: assessment.skillId,
      questions: assessment.questions,
    })),
    caveats: [
      CAVEATS.estimates,
      CAVEATS.selfReport,
      `Graph basis: ${[
        ...skill.prerequisites.slice(0, 3).map((prereq) => graphBasisLine('REQUIRES', skill.id, prereq.id)),
        ...skill.projects.slice(0, 2).map((project) => graphBasisLine('PRACTICED_BY', skill.id, project.id)),
      ].join(' ')}`,
    ],
  }

  return publicJson(
    200,
    { ok: true, data: payload, meta: metaFor(reader, { ms: Date.now() - started }) },
    { 'cache-control': 'public, max-age=300, stale-while-revalidate=900' },
  )
}


