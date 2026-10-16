/**
 * Shared data loading for the analysis features.
 *
 * `analyze-skill-gaps`, `generate-learning-roadmap`, the pathway builder and the
 * mentor all need the same slice: the career, its skills, the transitive
 * prerequisite closure, the REQUIRES edges among those skills, candidate
 * projects and candidate resources.
 *
 * This lives in `core` (not in a handler) so the browser can run the very same
 * loading path against the bundled sample dataset in demo mode. Loading it in one
 * place keeps every consumer consistent and keeps the number of Neo4j round trips
 * predictable (3–4 queries, regardless of career size).
 */
import type { GraphReader, ProjectView, ResourceView, SkillMetaRow, CareerSkillRow } from './graphReader.ts'
import type { GraphEdge } from './types.ts'

export interface CareerSlice {
  careerId: string
  careerName: string
  careerSummary: string
  careerSkills: CareerSkillRow[]
  skillMeta: SkillMetaRow[]
  prereqEdges: GraphEdge[]
  projects: ProjectView[]
  resources: ResourceView[]
  truncated: boolean
  ms: number
  /** Hard cap actually applied when expanding prerequisites (depth, rows). */
  limits: { depth: number; maxSkills: number }
}

export interface CareerSliceFailure {
  kind: 'career-missing' | 'career-has-no-skills'
  careerId: string
  careerName: string
}

export interface LoadCareerSliceOptions {
  depth?: number
  maxSkills?: number
  projectLimit?: number
  resourceLimit?: number
  signal?: AbortSignal
  /**
   * Turns a missing/empty career into the caller's own error type (handlers use
   * `AppError`, the browser throws a small local error). Must throw: if it
   * returns, `loadCareerSlice` throws a generic Error instead.
   */
  onFailure?: (failure: CareerSliceFailure) => never
}

export const SLICE_LIMITS = {
  depth: { min: 1, max: 6, fallback: 4 },
  maxSkills: { min: 10, max: 400, fallback: 150 },
  skillEdges: { cap: 800 },
  projectLimit: 8,
  resourceLimit: 12,
} as const

export async function loadCareerSlice(
  reader: GraphReader,
  careerId: string,
  options: LoadCareerSliceOptions = {},
): Promise<CareerSlice> {
  const depth = Math.max(SLICE_LIMITS.depth.min, Math.min(options.depth ?? SLICE_LIMITS.depth.fallback, SLICE_LIMITS.depth.max))
  const maxSkills = Math.max(
    SLICE_LIMITS.maxSkills.min,
    Math.min(options.maxSkills ?? SLICE_LIMITS.maxSkills.fallback, SLICE_LIMITS.maxSkills.max),
  )
  const started = Date.now()
  // The explicit annotation is what lets TypeScript treat a call as
  // non-returning, so `career` and `closure` narrow after the checks below.
  const fail: (failure: CareerSliceFailure) => never = (failure) => {
    if (options.onFailure) options.onFailure(failure)
    throw new Error(
      failure.kind === 'career-missing'
        ? `No career with identifier "${failure.careerId}" exists in this dataset.`
        : `"${failure.careerName}" has no skills recorded, so no analysis is possible.`,
    )
  }

  const { value: career } = await reader.getCareer(careerId, { signal: options.signal })
  if (!career) fail({ kind: 'career-missing', careerId, careerName: careerId })

  const closure = await reader.getCareerClosure(career.id, depth, maxSkills, { signal: options.signal })
  if (closure.value.length === 0) {
    fail({ kind: 'career-has-no-skills', careerId: career.id, careerName: career.name })
  }

  const skillIds = closure.value.map((skill) => skill.id)
  const [edges, projects, resources] = await Promise.all([
    reader.getSkillEdges(skillIds, Math.min(maxSkills * 3, SLICE_LIMITS.skillEdges.cap), { signal: options.signal }),
    reader.findProjects(
      { careerId: career.id, skillIds: skillIds.slice(0, 40), limit: options.projectLimit ?? SLICE_LIMITS.projectLimit },
      { signal: options.signal },
    ),
    reader.findResources(
      { skillIds: skillIds.slice(0, 40), limit: options.resourceLimit ?? SLICE_LIMITS.resourceLimit },
      { signal: options.signal },
    ),
  ])

  return {
    careerId: career.id,
    careerName: career.name,
    careerSummary: career.summary,
    careerSkills: career.skills,
    skillMeta: closure.value,
    prereqEdges: edges.value,
    projects: projects.value,
    resources: resources.value,
    truncated: Boolean(closure.truncated || edges.truncated),
    ms: Date.now() - started,
    limits: { depth, maxSkills },
  }
}


