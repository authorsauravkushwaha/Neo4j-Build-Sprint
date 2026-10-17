/**
 * The read contract every knowledge-graph backend must satisfy.
 *
 * Three implementations exist and are used interchangeably:
 *   - neo4jReader.ts        -> live Neo4j AuraDB over the HTTPS Query API (server only)
 *   - localReader.ts        -> the bundled sample dataset (browser demo mode, tests,
 *                              and the graceful fallback when Neo4j is not configured)
 *   - server/graphReader.ts -> the deployment's own PostgreSQL database (the
 *                              repo-owned backend; hydrates the same local
 *                              engine from real `graph.*` tables so every read
 *                              is answered from database content, not a bundle)
 *
 * Everything above this layer (career explorer, graph explorer, skill-gap
 * analysis, roadmap engine, mentor context builder) is backend-agnostic, which is
 * what makes "the app still works without a database or an AI key" true rather
 * than aspirational.
 */
import type {
  Difficulty,
  GraphEdge,
  GraphNeighborhood,
  GraphNode,
  NodeLabel,
  RelationType,
  SkillState,
  VerificationState,
} from './types.ts'

export interface ReadOptions {
  signal?: AbortSignal
}

export interface ReadResult<T> {
  value: T
  /** Duration of the underlying query/work, surfaced as ApiMeta.queryMs. */
  ms: number
  truncated?: boolean
}

export interface CareerSummary {
  id: string
  name: string
  summary: string
  difficulty?: Difficulty
  verification?: VerificationState
  branchIds: string[]
  skillIds?: string[]
}

export interface CareerDetail extends CareerSummary {
  description: string
  responsibilities: string[]
  portfolioIdeas: string[]
  assumptions: string[]
  typicalRoles: string[]
  branches: Array<{ id: string; name: string }>
  skills: CareerSkillRow[]
  related: Array<{ id: string; name: string }>
  projects: Array<{ id: string; name: string; difficulty?: Difficulty }>
}

export interface CareerSkillRow {
  id: string
  name: string
  summary?: string
  difficulty: Difficulty
  /** true = the career needs it in practice; false = useful but optional. */
  essential: boolean
  /** 0..1 curriculum weight, used by the transparent scorer. */
  weight: number
}

export interface SkillMetaRow {
  id: string
  name: string
  summary?: string
  difficulty: Difficulty
  estimatedHoursLow: number
  estimatedHoursHigh: number
  completionCriteria: string[]
  practice: string[]
}

/**
 * A light row for the search index: everything a palette or a picker needs to
 * name a skill and link to it, and nothing that would make the index heavy
 * (no prose, no completion criteria). Skills and concepts share this shape
 * because, for someone searching, "PID control" is "PID control" regardless of
 * which label the graph gives it.
 */
export interface SkillIndexRow {
  id: string
  name: string
  kind: 'Skill' | 'Concept'
  difficulty: Difficulty
  /** The subject or parent it sits under, for context in a result list. */
  parentName?: string
}

export interface SkillDetail extends SkillMetaRow {
  description: string
  prerequisites: Array<{ id: string; name: string; strength?: number }>
  unlocks: Array<{ id: string; name: string }>
  tools: Array<{ id: string; name: string }>
  languages: Array<{ id: string; name: string }>
  projects: Array<{ id: string; name: string; difficulty?: Difficulty }>
  resources: Array<{ id: string; name: string; provider?: string; url?: string }>
}

export interface ProjectView {
  id: string
  name: string
  summary: string
  description: string
  difficulty: Difficulty
  objectives: string[]
  deliverables: string[]
  milestones: string[]
  testingIdeas: string[]
  extensions: string[]
  safetyNotes: string[]
  tools: string[]
  skillIds: string[]
  matchedSkillIds: string[]
  estimatedHours: [number, number]
}

export interface ResourceView {
  id: string
  name: string
  summary: string
  url: string
  provider: string
  format: string
  difficulty: Difficulty
  language: string
  accessModel: string
  accessNote: string
  outcomes: string[]
  assumes: string
  limits: string
  commitment: string
  /** Estimated effort in hours, in the same units as the skill estimates. */
  estimatedHours: [number, number]
  /** Skills this resource presumes you already have (ASSUMES edges). */
  assumesIds: string[]
  assumesNames: string[]
  lastVerified: string | null
  verification: VerificationState
  coversIds: string[]
  coversNames: string[]
  matchedSkillIds: string[]
}

export interface RouteView {
  ids: string[]
  names: string[]
  difficulties: Array<Difficulty | undefined>
  targetId: string
  targetName: string
  hops: number
}

export interface AssessmentView {
  id: string
  name: string
  summary: string
  skillId: string
  difficulty: Difficulty
  questions: Array<{ prompt: string; options: string[]; answerIndex: number }>
}

export interface ModuleView {
  id: string
  name: string
  summary: string
  skillIds: string[]
}

export interface GraphTotals {
  nodes: number
  relationships: number
  labels: Array<{ label: string; count: number }>
}

export interface NeighborhoodInput {
  /** When omitted, `careerId` must be present and a curated overview is returned. */
  seedId?: string
  careerId?: string
  depth?: number
  labels?: NodeLabel[]
  relations?: RelationType[]
  difficulty?: Difficulty
  limit?: number
}

export interface ProjectQuery {
  skillIds?: string[]
  careerId?: string
  difficulty?: Difficulty
  limit?: number
}

export interface ResourceQuery {
  skillIds?: string[]
  subjectId?: string
  q?: string
  format?: string
  accessModel?: string
  difficulty?: Difficulty
  limit?: number
}

export interface CareerSearchInput {
  q?: string
  branchId?: string
  difficulty?: Difficulty
  limit?: number
  offset?: number
}

export interface SkillIndexInput {
  /** Optional substring filter; the client filters further for ranking. */
  q?: string
  limit: number
}

export interface GraphReader {
  /**
   * Identifies the data source so the UI can label it honestly.
   *   - `neo4j`    -> a Neo4j database over the HTTPS Query API,
   *   - `postgres` -> the deployment's own PostgreSQL (server/graphReader.ts),
   *   - `local`    -> the bundled sample dataset (demo mode, tests).
   */
  readonly kind: 'neo4j' | 'postgres' | 'local'
  /** Human-readable provenance string shown in the UI banner. */
  readonly provenance: string
  /** True when this reader could be built from the current configuration. */
  readonly configured: boolean

  totals(options?: ReadOptions): Promise<ReadResult<GraphTotals>>

  listCareers(limit: number, options?: ReadOptions): Promise<ReadResult<CareerSummary[]>>
  searchCareers(input: CareerSearchInput, options?: ReadOptions): Promise<ReadResult<CareerSummary[]>>
  listBranches(limit: number, options?: ReadOptions): Promise<ReadResult<Array<{ id: string; name: string; summary: string; careerCount: number }>>>

  getCareer(careerId: string, options?: ReadOptions): Promise<ReadResult<CareerDetail | null>>
  getCareerSkills(careerId: string, options?: ReadOptions): Promise<ReadResult<CareerSkillRow[]>>
  /** All skills a career needs plus transitive prerequisites, bounded by depth. */
  getCareerClosure(careerId: string, depth: number, limit: number, options?: ReadOptions): Promise<ReadResult<SkillMetaRow[]>>
  getSkillEdges(ids: string[], limit: number, options?: ReadOptions): Promise<ReadResult<GraphEdge[]>>

  /** The searchable index of every skill and concept the graph holds. */
  listSkillIndex(input: SkillIndexInput, options?: ReadOptions): Promise<ReadResult<SkillIndexRow[]>>
  getSkill(skillId: string, options?: ReadOptions): Promise<ReadResult<SkillDetail | null>>
  getSkillClosure(skillId: string, depth: number, limit: number, options?: ReadOptions): Promise<ReadResult<SkillMetaRow[]>>
  getDownstream(skillId: string, depth: number, options?: ReadOptions): Promise<ReadResult<{ careers: Array<{ id: string; name: string }>; skills: SkillMetaRow[] }>>

  getRoutes(careerId: string, fromSkillId: string, limit: number, options?: ReadOptions): Promise<ReadResult<RouteView[]>>

  getNeighborhood(input: NeighborhoodInput, options?: ReadOptions): Promise<ReadResult<GraphNeighborhood & { nodes: GraphNode[] }>>
  getEdgesAmong(ids: string[], relations: RelationType[] | undefined, limit: number, options?: ReadOptions): Promise<ReadResult<GraphEdge[]>>

  findProjects(query: ProjectQuery, options?: ReadOptions): Promise<ReadResult<ProjectView[]>>
  findResources(query: ResourceQuery, options?: ReadOptions): Promise<ReadResult<ResourceView[]>>

  getAssessments(skillIds: string[], limit: number, options?: ReadOptions): Promise<ReadResult<AssessmentView[]>>
  getModules(careerId: string | undefined, limit: number, options?: ReadOptions): Promise<ReadResult<ModuleView[]>>
}

/* --------------------------------------------------------------------------
 * Small helpers shared by both readers
 * -------------------------------------------------------------------------- */

export const DIFFICULTY_ORDER: Difficulty[] = ['beginner', 'intermediate', 'advanced']

export function difficultyRank(difficulty: Difficulty | undefined): number {
  return DIFFICULTY_ORDER.indexOf(difficulty ?? 'beginner')
}

/** Guards against a cached/stale reader being asked for an absurd limit. */
export function clampLimit(limit: number | undefined, max: number, fallback: number): number {
  if (!Number.isFinite(limit ?? NaN)) return Math.min(fallback, max)
  const value = Math.trunc(limit as number)
  if (value <= 0) return Math.min(fallback, max)
  return Math.min(value, max)
}

/**
 * Breadth-first, cycle-safe traversal helper used by both readers.
 * Returns node ids in BFS order with a hard cap, so a malformed graph cannot
 * make a request run forever or return an unbounded payload.
 */
export function bfsReachable(
  startIds: string[],
  neighboursOf: (id: string) => string[],
  maxDepth: number,
  maxNodes: number,
): { order: string[]; depthOf: Map<string, number>; truncated: boolean } {
  const depthOf = new Map<string, number>()
  const order: string[] = []
  const queue: string[] = []
  let truncated = false

  for (const id of startIds) {
    if (!depthOf.has(id)) {
      depthOf.set(id, 0)
      queue.push(id)
    }
  }

  let head = 0
  while (head < queue.length) {
    const current = queue[head++]
    const depth = depthOf.get(current) ?? 0
    order.push(current)
    if (order.length >= maxNodes) {
      truncated = true
      break
    }
    if (depth >= maxDepth) continue
    for (const next of neighboursOf(current)) {
      if (depthOf.has(next)) continue
      depthOf.set(next, depth + 1)
      queue.push(next)
      if (queue.length + order.length > maxNodes * 2) {
        truncated = true
        break
      }
    }
  }
  return { order, depthOf, truncated }
}

export const STATE_TO_MASTERY: Record<SkillState, number> = {
  unknown: 0,
  new: 0.1,
  learning: 0.4,
  practised: 0.7,
  confident: 1,
}


