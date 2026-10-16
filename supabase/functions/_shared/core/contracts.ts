/**
 * Typed API contracts shared by the Edge Functions and the frontend.
 *
 * The frontend imports these types through the `@core` alias, so a change to a
 * response shape breaks compilation in both places instead of silently shipping a
 * mismatch.
 *
 * Be precise about where the runtime checks are, because this comment used to point
 * at a `core/clientValidation.ts` that does not exist. Request bodies are validated
 * on the server, in `core/validate.ts`, against zod schemas — the schemas are the
 * gate, and these types describe what comes back through it. The client parses the
 * envelope in `src/core/api.ts` and checks the shape it needs at the call site
 * rather than re-validating the whole contract, because a re-validation that drifts
 * from the server is worse than no re-validation at all.
 */
import type {
  ApiMeta,
  Difficulty,
  GraphNeighborhood,
  MentorAnswer,
  MentorRead,
  Pathway,
  ProgressSummary,
  Roadmap,
  RoadmapTask,
  SkillGapReport,
  TaskStatus,
  VerificationState,
} from './types.ts'
// Type-only, so nothing is pulled in at runtime. The frontier report is defined
// next to the function that computes it, like every other engine output.
import type { FrontierReport } from './recommend.ts'

/* ==========================================================================
 * Careers
 * ========================================================================== */

export interface CareerSummaryDto {
  id: string
  name: string
  summary: string
  difficulty?: Difficulty
  verification?: VerificationState
  branchIds: string[]
  skillCount: number
}

export interface CareerSummaryResponse {
  careers: CareerSummaryDto[]
  branches: Array<{ id: string; name: string; summary: string; careerCount: number }>
  filters: { query: string; branch: string | null; difficulty: Difficulty | null }
  total: number
}

export interface CareerSkillDto {
  id: string
  name: string
  summary?: string
  difficulty: Difficulty
  essential: boolean
  weight: number
}

/**
 * Career page payload.
 *
 * Written out explicitly instead of intersecting the `Career` entity: the page
 * needs ids *and* names for branches/related careers, and the entity shape keeps
 * changing. `keywords` is optional because the Neo4j reader does not select it.
 */
export interface CareerDetailsDto {
  id: string
  label: 'Career'
  name: string
  slug?: string
  summary: string
  description: string
  difficulty: Difficulty
  verification: VerificationState
  branches: Array<{ id: string; name: string }>
  responsibilities: string[]
  portfolioIdeas: string[]
  assumptions: string[]
  typicalRoles: string[]
  relatedCareers: Array<{ id: string; name: string; note?: string }>
  skills: CareerSkillDto[]
  keywords?: string[]
}

export interface CareerDetailsResponse {
  career: CareerDetailsDto
  /** Suggested portfolio projects from the graph (bounded). */
  projects: Array<{
    id: string
    name: string
    difficulty: Difficulty
    summary: string
    deliverables: string[]
    safetyNotes: string[]
  }>
  /** A few free/verified starting points, so the page is never a dead end. */
  resources: Array<{ id: string; name: string; provider: string; url: string; accessBadge: string }>
  /** Graph relationships backing the page, in `(a)-[:REL]-> (b)` form. */
  graphBasis: string[]
  caveats: string[]
}

/* ==========================================================================
 * Graph
 * ========================================================================== */

export interface GraphExploreResponse {
  graph: GraphNeighborhood
  /** Legend so the UI can render node types with shape + colour + label. */
  legend: Array<{ label: string; display: string; shape: string; color: string; description: string }>
  relationLegend: Array<{ type: string; description: string; optional: boolean }>
  /** Nodes the requested id resolved to, for highlighting after a search. */
  focusId: string | null
}

export interface SkillDetailsResponse {
  skill: {
    id: string
    name: string
    summary: string
    description: string
    difficulty: Difficulty
    estimatedHours: [number, number]
    practice: string[]
    completionCriteria: string[]
    prerequisites: Array<{ id: string; name: string; strength?: number }>
    unlocks: Array<{ id: string; name: string }>
    tools: Array<{ id: string; name: string }>
    languages: Array<{ id: string; name: string }>
    projects: Array<{ id: string; name: string; difficulty?: Difficulty }>
  }
  resources: Array<{
    id: string
    name: string
    provider: string
    url: string
    accessBadge: string
    verification: VerificationState
  }>
  assessments: Array<{
    id: string
    name: string
    skillId: string
    questions: Array<{ prompt: string; options: string[]; answerIndex: number }>
  }>
  caveats: string[]
}

/* ==========================================================================
 * Skill gaps, pathway and roadmap
 * ========================================================================== */

export interface SkillGapResponse {
  report: SkillGapReport
  /**
   * The same analysis read as a delta: the transitive prerequisite closure of
   * the target, what is startable today, which skills gate the rest, and the
   * longest chain that cannot be parallelised. Computed by `analyzeFrontier`
   * from exactly the same inputs as `report`, so the two always agree.
   */
  frontier: FrontierReport
  /** Human labels for the categories, so the UI and the API cannot drift apart. */
  categoryLabels: Record<string, string>
  projects: Array<{
    id: string
    name: string
    difficulty: Difficulty
    coverage: number
    matchReason: string
    summary: string
  }>
}

export interface CareerPathResponse {
  pathway: Pathway
  career: { id: string; name: string; summary: string }
  /** Alternative dependency routes found in the graph, if any. */
  routes: Array<{ names: string[]; targetName: string; hops: number }>
  essentialsCount: number
  optionalCount: number
}

export interface RoadmapGenerateResponse {
  roadmap: Roadmap
  pathwayMeta: {
    stepsUsed: number
    alternativesConsidered: number
    /** Always present: the honest framing of what the plan can and cannot promise. */
    caveats: string[]
  }
}

export interface RoadmapGetResponse {
  roadmaps: Array<{
    id: string
    title: string
    careerId: string
    careerName: string
    weeklyHours: number
    pace: string
    createdAt: string
    updatedAt: string
    progress: ProgressSummary
  }>
  active: Roadmap | null
}

export interface RoadmapSaveResponse {
  roadmapId: string
  taskCount: number
  updatedAt: string
}

export interface ProgressUpdateResponse {
  task: {
    id: string
    skillId: string
    name: string
    status: TaskStatus
    scheduledWeek: number
    actualHours: number | null
    note: string | null
    updatedAt: string
  }
  progress: ProgressSummary | null
}

export interface BookmarkResponse {
  bookmarks: Array<{ id: string; targetType: string; targetId: string; note: string | null; createdAt: string }>
  changed?: { action: 'add' | 'remove'; targetId: string }
}

export interface FeedbackResponse {
  id: string
  receivedAt: string
  note: string
}

/* ==========================================================================
 * Mentor
 * ========================================================================== */

export interface MentorChatResponse {
  answer: MentorAnswer
  /** What the answer was allowed to use, for transparency in the UI. */
  context: {
    intent: string
    skillsUsed: number
    projectsUsed: number
    resourcesUsed: number
    truncated: boolean
    graphSource: 'neo4j-live' | 'local-sample' | 'unavailable'
    /**
     * Every graph read that produced this answer, grouped by reader method.
     *
     * The mentor claims to answer only from the graph, so the claim is auditable:
     * a learner can see that an answer about a named career cost 7 reads and that
     * an answer the graph could not support cost 1. Empty would mean the answer
     * was written without touching the graph at all, which is a bug worth seeing.
     */
    reads: MentorRead[]
    /** Total time inside those reads, so "slow" can be attributed rather than guessed. */
    readMs: number
  }
  limits: {
    requestsRemainingThisMinute: number
    maxMessageChars: number
  }
}

/* ==========================================================================
 * Resources and projects
 * ========================================================================== */

export interface ResourceListResponse {
  resources: Array<{
    id: string
    name: string
    summary: string
    url: string
    provider: string
    format: string
    difficulty: Difficulty
    language: string
    accessModel: string
    accessBadge: string
    accessNote: string
    /** What you can do afterwards, prerequisites, limits and time shape. */
    outcomes: string[]
    assumes: string
    limits: string
    commitment: string
    /** Estimated effort in hours, in the same units as the skill estimates. */
    estimatedHours: [number, number]
    /** The skills it presumes you already have, usable as links. */
    assumesSkills: Array<{ id: string; name: string }>
    lastVerified: string | null
    verification: VerificationState
    covers: Array<{ id: string; name: string }>
    matchReason: string
  }>
  filters: Record<string, string | null>
  total: number
}

/**
 * The searchable index of the curriculum: every skill and concept, lightly
 * described. Deliberately not the graph: no prose, no edges, no counts that
 * would go stale — a palette needs names and links, and a picker needs the same.
 */
export interface SkillIndexResponse {
  skills: Array<{
    id: string
    name: string
    kind: 'Skill' | 'Concept'
    difficulty: Difficulty
    /** The subject a concept sits under; absent for skills in this model. */
    parentName?: string
  }>
  total: number
}

export interface ProjectListResponse {
  projects: Array<{
    id: string
    name: string
    summary: string
    difficulty: Difficulty
    objectives: string[]
    deliverables: string[]
    milestones: string[]
    testingIdeas: string[]
    extensions: string[]
    safetyNotes: string[]
    tools: string[]
    skillIds: string[]
    estimatedHours: [number, number]
    coverage: number
    matchReason: string
  }>
  filters: Record<string, string | null>
  total: number
}

/* ==========================================================================
 * Envelope helpers
 * ========================================================================== */

export type ApiSuccess<T> = { ok: true; data: T; meta: ApiMeta }
export type { RoadmapTask, ProgressSummary }


