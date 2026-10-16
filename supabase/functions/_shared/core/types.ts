/**
 * GraphMentor AI — shared domain types.
 *
 * This module is runtime-agnostic (no Node, Deno, DOM or browser APIs) so it can
 * be imported by:
 *   - Supabase Edge Functions (Deno)          -> supabase/functions/**
 *   - the React frontend (Vite/TS)            -> via the `@core` alias
 *   - plain Node scripts (tsx)                -> scripts/**
 *
 * Rule: business logic lives here ONCE. Nothing in this folder may import a UI
 * framework, `window`, `document`, `Deno`, or `process`.
 */

/* ==========================================================================
 * Graph vocabulary
 * ========================================================================== */

export const NODE_LABELS = [
  'Career',
  'EngineeringBranch',
  'Subject',
  'Concept',
  'Skill',
  'ProgrammingLanguage',
  'Tool',
  'Project',
  'Resource',
  'Assessment',
  'LearningModule',
] as const

export type NodeLabel = (typeof NODE_LABELS)[number]

export const RELATION_TYPES = [
  'REQUIRES_SKILL',
  'RELATED_TO',
  'BELONGS_TO',
  'REQUIRES',
  'HAS_CONCEPT',
  'BUILDS_ON',
  'USES',
  'PRACTICED_BY',
  'BUILDS_SKILL',
  'TAUGHT_BY',
  'COVERS',
  'ASSUMES',
  'SUGGESTS_PROJECT',
  'TEACHES',
  'ASSESSES',
  'PART_OF',
] as const

export type RelationType = (typeof RELATION_TYPES)[number]

export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

export const DIFFICULTY_RANK: Record<Difficulty, number> = {
  beginner: 1,
  intermediate: 2,
  advanced: 3,
}

/** How confident the knowledge graph is in an entity or relationship. */
/**
 * Upper bound for catalogue queries (the resource library, the project list and
 * the career list).
 *
 * It exists so a stale or hostile caller cannot ask for an unbounded payload —
 * it is not a product limit, and it must never hide shipped data. The dataset
 * self-check and the resource tests fail if the shipped catalogue ever grows
 * past this number, which is the only way it could silently truncate results.
 */
export const MAX_CATALOG_LIMIT = 600
export const VERIFICATION_STATES = ['verified', 'community', 'unverified'] as const
export type VerificationState = (typeof VERIFICATION_STATES)[number]

/**
 * Access conditions for a learning resource. We never call something "free"
 * without recording what "free" actually means for that provider.
 */
export const ACCESS_MODELS = [
  'free-open', // CC/openly licensed or public domain, no account needed
  'free-account', // free of charge, free account required
  'free-audit', // course material free to read/audit, certificate or graded work paid
  'free-with-limits', // free tier with documented quotas
  'mixed', // partly free, partly paid
  'unknown', // not verified yet — surfaced with a warning in the UI
] as const
export type AccessModel = (typeof ACCESS_MODELS)[number]

export type ResourceFormat = 'docs' | 'video' | 'course' | 'book' | 'tutorial' | 'practice' | 'repository' | 'reference'

/* ==========================================================================
 * Graph entities
 * ========================================================================== */

export interface GraphEntity {
  /** Stable, explicit identifier, e.g. `career:robotics-engineer`, `skill:python`. */
  id: string
  label: NodeLabel
  name: string
  summary?: string
  slug?: string
}

export interface GraphNode extends GraphEntity {
  difficulty?: Difficulty
  /** Free-form attributes carried by the node in Neo4j. Validated on read. */
  props: Record<string, string | number | boolean | string[] | null>
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  type: RelationType
  /** 0..1 optional weight from the graph (never invented client-side). */
  weight?: number
  note?: string
}

export interface GraphNeighborhood {
  seedId: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** True when the result was cut off by a depth/row limit. */
  truncated: boolean
  /** Human-readable description of how the subgraph was selected. */
  selectionNote: string
}

export interface Career extends GraphEntity {
  label: 'Career'
  description: string
  branches: string[]
  responsibilities: string[]
  portfolioIdeas: string[]
  assumptions: string[]
  verification: VerificationState
  relatedCareers: Array<{ id: string; name: string; note?: string }>
}

export interface Skill extends GraphEntity {
  label: 'Skill'
  description: string
  difficulty: Difficulty
  prerequisiteIds: string[]
  toolIds: string[]
  resourceCount?: number
  projectCount?: number
}

export interface Project extends GraphEntity {
  label: 'Project'
  description: string
  difficulty: Difficulty
  objectives: string[]
  deliverables: string[]
  milestones: string[]
  testingIdeas: string[]
  tools: string[]
  extensions: string[]
  safetyNotes: string[]
  skillIds: string[]
  estimatedHours: [number, number]
}

export interface LearningResource extends GraphEntity {
  label: 'Resource'
  provider: string
  url: string
  format: ResourceFormat
  difficulty: Difficulty
  language: string
  accessModel: AccessModel
  accessNote: string
  /** Set when the link was last checked. `null` = never checked. */
  lastVerified: string | null
  verification: VerificationState
}

export interface LearningModule extends GraphEntity {
  label: 'LearningModule'
  description: string
  skillIds: string[]
  estimatedHours: [number, number]
}

/* ==========================================================================
 * Recommendation engine
 * ========================================================================== */

export const SKILL_STATES = ['unknown', 'new', 'learning', 'practised', 'confident'] as const
export type SkillState = (typeof SKILL_STATES)[number]

export interface UserSkillRating {
  skillId: string
  state: SkillState
  /** Optional short quiz result (0..1). Self-assessment is never "verification". */
  quizScore?: number
  updatedAt?: string
}

export interface UserProfileInput {
  educationLevel?: string
  branch?: string
  careerGoalId?: string | null
  interests?: string[]
  skillRatings?: UserSkillRating[]
  weeklyHours?: number
  preferredPace?: 'relaxed' | 'steady' | 'intensive'
  learningStyle?: 'video' | 'reading' | 'hands-on' | 'mixed'
  goalNote?: string
  difficultyComfort?: Difficulty
}

export const GAP_CATEGORIES = [
  'already-familiar',
  'ready-to-practice',
  'recommended-next',
  'missing-prerequisite',
  'optional-specialization',
] as const
export type GapCategory = (typeof GAP_CATEGORIES)[number]

export interface ScoredSkill {
  skillId: string
  name: string
  difficulty: Difficulty
  category: GapCategory
  /** 0..100 transparent blend — see docs/recommendation-engine.md */
  score: number
  scoreParts: ScoreParts
  isEssential: boolean
  reason: string
  /** Skill ids that must be learned before this one (unmet ones only). */
  blockedBy: string[]
  unlocks: string[]
}

export interface ScoreParts {
  /** How often this skill is required by the target career (0..1). */
  goalRelevance: number
  /** Prerequisite centrality: how many other needed skills depend on it (0..1). */
  prerequisiteCentrality: number
  /** How far the user is from it: 1 = not started, 0 = confident (0..1). */
  gap: number
  /** Overlap with the user's declared interests (0..1). */
  interestFit: number
  /** Penalty when the skill is above the user's comfort level or time budget (0..1). */
  effortPenalty: number
}

export interface SkillGapReport {
  careerId: string
  careerName: string
  generatedAt: string
  ratingsUsed: UserSkillRating[]
  counts: Record<GapCategory, number>
  items: ScoredSkill[]
  /** Paths that are not required for the career, for users who want breadth. */
  optionalPaths: Array<{ skillId: string; name: string; reason: string }>
  /** Honest statement of what this analysis cannot know. */
  caveats: string[]
}

export type TaskStatus = 'not-started' | 'in-progress' | 'completed' | 'needs-review'

export interface PathwayStep {
  order: number
  skillId: string
  name: string
  difficulty: Difficulty
  reason: string
  essential: boolean
  estimatedHours: [number, number]
  dependsOn: string[]
  unlocks: string[]
  practice: string[]
  completionCriteria: string[]
  resourceIds: string[]
  projectIds: string[]
  milestoneProject?: { id: string; name: string; why: string }
}

export interface AlternativeRoute {
  id: string
  title: string
  description: string
  steps: string[]
  tradeoff: string
  estimatedHours: [number, number]
}

export interface Pathway {
  careerId: string
  careerName: string
  generatedAt: string
  inputs: {
    weeklyHours: number
    pace: UserProfileInput['preferredPace']
    learningStyle: UserProfileInput['learningStyle']
    difficultyComfort: Difficulty
    ratingsUsed: number
  }
  steps: PathwayStep[]
  alternatives: AlternativeRoute[]
  /** Cumulative estimated hours as [low, high]. Always labelled as an estimate. */
  estimatedHours: [number, number]
  caveats: string[]
}

export interface RoadmapTask extends PathwayStep {
  /**
   * Identity of this row, unique inside its roadmap and stable across
   * rescheduling. Spaced-review rows deliberately reuse the skill they rehearse,
   * so `skillId` alone is not a key: progress is stored against `taskKey`.
   * When the roadmap came from the server this is the database row id, which is
   * what the progress endpoint expects.
   */
  taskKey: string
  /** Learning row, or a spaced-review row for an earlier skill. */
  kind: 'learn' | 'review'
  status: TaskStatus
  scheduledWeek: number
  scheduledDay?: number
  notes?: string
  actualHours?: number
}

/** Key for a task that has not been persisted yet: unique by construction. */
export function taskKeyFor(kind: 'learn' | 'review', order: number): string {
  return `${kind}-${order}`
}

/**
 * Server rows do not carry an explicit kind, so it is derived from the name the
 * roadmap builder writes ("Review: …"). Reviews are the only renamed rows.
 */
export function taskKindFromName(name: string): 'learn' | 'review' {
  return name.startsWith('Review: ') ? 'review' : 'learn'
}

export interface Roadmap {
  id: string
  userId?: string | null
  title: string
  careerId: string
  careerName: string
  createdAt: string
  updatedAt: string
  weeklyHours: number
  pace: NonNullable<UserProfileInput['preferredPace']>
  tasks: RoadmapTask[]
  milestones: Array<{ id: string; title: string; afterTaskId: string; description: string }>
  /** Honest framing: these are planning estimates, not promises. */
  estimateDisclaimer: string
}

export interface ProgressSummary {
  totalTasks: number
  completed: number
  inProgress: number
  needsReview: number
  notStarted: number
  /** completed / total, computed only from real task statuses. */
  percentComplete: number
  estimatedHoursRemaining: [number, number]
  streakWeeks?: number
}

/* ==========================================================================
 * AI mentor
 * ========================================================================== */

export interface EvidenceRef {
  kind: 'node' | 'relationship' | 'resource'
  id: string
  label: NodeLabel | RelationType
  title: string
  /** Where the claim comes from: graph data, or the model's own reasoning. */
  basis: 'graph' | 'model-reasoning' | 'model-general-knowledge'
  url?: string
}

export const MENTOR_INTENTS = [
  'why-prerequisite',
  'skill-gap',
  'project-idea',
  'explain-connection',
  'study-plan',
  'what-next',
  'career-overview',
  'resource-help',
  'general',
] as const
export type MentorIntent = (typeof MENTOR_INTENTS)[number]

export interface MentorRequest {
  message: string
  mode: 'concise' | 'detailed'
  careerId?: string | null
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  skillIds?: string[]
}

/**
 * One line of the read ledger: what the answer was allowed to look at.
 *
 * The mentor may only say what it read, so every graph read behind an answer is
 * counted here and shipped with the answer. Calls are grouped by reader method —
 * a question that resolves five skills reports `getSkill × 5` with one row count
 * and one duration, not five near-identical lines — and the targets are the first
 * three distinct ids, so the ledger stays readable instead of becoming a log.
 *
 * This is the honest half of "citation only": the answer's citations say which
 * graph *edges* it used, and the ledger says which *queries* produced them. A
 * reader who wants to check the work can see that an answer about a named career
 * cost 7 reads and 412 ms, and that an answer about nothing in the graph cost 1.
 */
export interface MentorRead {
  /** The `GraphReader` method, verbatim, so it can be grepped in the source. */
  call: string
  /** How many times that method ran for this one answer. */
  calls: number
  /** First three distinct targets, then `+N more`. Empty for whole-graph reads. */
  target: string
  /** Total rows returned across those calls. */
  rows: number
  /** Total time inside those calls. */
  ms: number
  /** True when any call hit its row limit, which caps what the answer could know. */
  truncated: boolean
}

export interface MentorAnswer {
  id: string
  createdAt: string
  intent: MentorIntent
  answer: string
  /** Bullet list of concrete next actions, always present. */
  nextActions: string[]
  evidence: EvidenceRef[]
  /** Graph relationships the answer leans on, in "A -[REL]-> B" form. */
  graphBasis: string[]
  /** Non-empty whenever the graph did not contain enough information. */
  unknowns: string[]
  provider: 'ai' | 'rules'
  providerName: string
  /** Present when the AI call failed and the deterministic engine answered. */
  degraded?: { reason: string; retryable: boolean }
  disclaimer: string
}

/* ==========================================================================
 * API envelopes
 * ========================================================================== */

export interface ApiMeta {
  /** Where the data came from. Never claim 'live' for local sample data. */
  source: 'neo4j-live' | 'local-sample' | 'cache' | 'unavailable'
  truncated?: boolean
  selectionNote?: string
  queryMs?: number
  generatedAt?: string
}

export interface ApiEnvelope<T> {
  ok: true
  data: T
  meta: ApiMeta
}

export interface ApiFailure {
  ok: false
  error: {
    code: ApiErrorCode
    message: string
    /** Field-level detail for 422 responses; never contains internal state. */
    fields?: Record<string, string>
    retryAfterSeconds?: number
    requestId?: string
  }
}

export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'timeout'
  | 'not_configured'
  | 'internal'

export type ApiResponse<T> = ApiEnvelope<T> | ApiFailure

/* ==========================================================================
 * Graph statistics / status
 * ========================================================================== */

export interface GraphHealth {
  configured: boolean
  reachable: boolean
  source: ApiMeta['source']
  nodeCount: number
  relationshipCount: number
  labels: Array<{ label: NodeLabel; count: number }>
  message: string
  /** Exact command a student should run when the graph is empty. */
  setupHint?: string
  checkedAt: string
}

export function isSuccess<T>(r: ApiResponse<T>): r is ApiEnvelope<T> {
  return r.ok === true
}


