/**
 * The one API the UI talks to.
 *
 * Two implementations satisfy the same interface:
 *
 *   - `createDemoClient()` runs the *same* engine the Edge Functions run
 *     (localReader + recommend + mentorContext/fallbackMentor) against the
 *     bundled dataset, entirely in the browser. This is what makes the app
 *     useful with no database and no AI key — and it is why demo mode can never
 *     drift from live mode: both call the same modules.
 *   - `createLiveClient()` calls the deployed Edge Functions and expects the
 *     `{ ok, data, meta }` envelope defined in core/contracts.ts.
 *
 * Every response carries `meta.source`, so the UI can state plainly whether the
 * learner is looking at live Neo4j data, the bundled sample dataset, or nothing.
 */
import type {
  CareerPathResponse,
  CareerDetailsResponse,
  CareerSummaryResponse,
  GraphExploreResponse,
  MentorChatResponse,
  ProjectListResponse,
  ResourceListResponse,
  SkillIndexResponse,
  SkillDetailsResponse,
  SkillGapResponse,
  RoadmapGenerateResponse,
} from '@core/contracts.ts'
import { analyzeFrontier, analyzeSkillGaps, buildPathway, buildRoadmap, rankProjects, rankResources, CAVEATS, accessBadgeFor } from '@core/recommend.ts'
import { loadCareerSlice } from '@core/careerSlice.ts'
import { buildMentorContext, classifyIntent, DEFAULT_CONTEXT_LIMITS, type MentorVocabularyEntry } from '@core/mentorContext.ts'
import { answerWithRules } from '@core/fallbackMentor.ts'
import { legend, RELATION_META, graphBasisLine } from '@core/graphModel.ts'
import { createLocalReader } from '@core/localReader.ts'
import type { GraphReader, CareerDetail } from '@core/graphReader.ts'
import type { ApiMeta } from '@core/types.ts'
import { buildRequestSignature, randomToken } from '@core/security.ts'

import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import { config } from './env.ts'
import {
  exportAll,
  loadBookmarks,
  loadFeedbackOutbox,
  loadLocalRoadmaps,
  resetRoadmapProgress,
  saveBookmarks,
  saveFeedbackOutbox,
  saveLocalRoadmaps,
  setTaskStatus as persistTaskStatus,
  summarizeLocalProgress,
  type LocalFeedbackEntry,
  type LocalSavedRoadmap,
} from './persistence.ts'
import { taskKeyFor, taskKindFromName } from '@core/types.ts'

export type ClientMode = 'demo' | 'live'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds?: number

  constructor(code: string, message: string, status = 400, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface ClientResult<T> {
  data: T
  meta: ApiMeta
}

export interface CareerQuery {
  q?: string
  branchId?: string
  difficulty?: string
}

export interface GraphQueryInput {
  seedId?: string
  careerId?: string
  depth?: number
  labels?: string[]
  relations?: string[]
  difficulty?: string
  limit?: number
}

export interface GapAnalysisInput {
  careerId: string
  ratings: Array<{ skillId: string; state: string; quizScore?: number }>
  interests?: string[]
  weeklyHours?: number
  difficultyComfort?: string
  includeOptionalPaths?: boolean
}

export interface RoadmapInput extends GapAnalysisInput {
  pace: 'relaxed' | 'steady' | 'intensive'
  learningStyle: 'video' | 'reading' | 'hands-on' | 'mixed'
  title?: string
  startDate?: string
}

/**
 * Write inputs. These mirror the server schemas in
 * `supabase/functions/_shared/core/validate.ts` field for field: a body this
 * client accepts but the server rejects would be a contract bug.
 */
export interface RoadmapSaveInput {
  roadmapId?: string
  title?: string
  careerId: string
  weeklyHours: number
  pace: 'relaxed' | 'steady' | 'intensive'
  tasks: Array<{
    skillId: string
    name: string
    /** Position in the dependency order (0-based). */
    order: number
    scheduledWeek: number
    estimatedHoursLow: number
    estimatedHoursHigh: number
    taskKey?: string
    kind?: 'learn' | 'review'
    essential?: boolean
    status?: 'not-started' | 'in-progress' | 'completed' | 'needs-review'
    difficulty?: 'beginner' | 'intermediate' | 'advanced'
  }>
}

export interface RoadmapSaveResult {
  roadmapId: string
  taskCount: number
  updatedAt: string
  /**
   * Maps the caller's local task key (e.g. `learn-3`) to the id this row is
   * addressed by when updating progress. Live mode fills this from the stored
   * rows; demo mode uses the local key itself.
   */
  taskIds: Record<string, string>
}

export interface ProgressUpdateInput {
  /** The roadmap id returned by `saveRoadmap`. */
  roadmapId: string
  /** Row id from `RoadmapSaveResult.taskIds` (or the local key in demo mode). */
  taskId: string
  /** Kept so the local store can record which skill the row belongs to. */
  taskKey?: string
  skillId?: string
  status: 'not-started' | 'in-progress' | 'completed' | 'needs-review'
  actualHours?: number
  note?: string
}

export interface ProgressUpdateResult {
  taskId: string
  status: ProgressUpdateInput['status']
  updatedAt: string
  /** Recomputed server-side from the stored rows, never from the client count. */
  progress: { totalTasks: number; completed: number; percentComplete: number } | null
}

export interface BookmarksInput {
  action: 'add' | 'remove' | 'list'
  /** Same vocabulary as `bookmarks.target_type` in the database. */
  targetType?: 'skill' | 'career' | 'project' | 'resource' | 'module'
  targetId?: string
  note?: string
}

export interface BookmarksResult {
  bookmarks: Array<{ id: string; targetType: string; targetId: string; note: string | null; createdAt: string }>
  changed?: { action: 'add' | 'remove'; targetId: string }
}

export interface FeedbackInput {
  kind: 'bug' | 'content' | 'resource-link' | 'accessibility' | 'other'
  message: string
  contact?: string
  targetId?: string
  pageUrl?: string
}

export interface FeedbackResult {
  id: string
  receivedAt: string
  /** Says where the report actually went — a device-only outbox in demo mode. */
  note: string
}

export interface MentorInput {
  message: string
  mode: 'concise' | 'detailed'
  careerId?: string | null
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface ResourceQueryInput {
  q?: string
  skillIds?: string[]
  format?: string
  accessModel?: string
  difficulty?: string
  limit?: number
}

export interface ProjectQueryInput {
  careerId?: string
  skillIds?: string[]
  difficulty?: string
  limit?: number
}

export interface HealthReport {
  mode: ClientMode
  /**
   * What the backend says serves the graph:
   *   - `neo4j-live`    -> a Neo4j database,
   *   - `postgres-live` -> the deployment's own PostgreSQL (self-hosted backend),
   *   - `local-sample`  -> the backend itself serves the bundled sample dataset,
   *   - `unreachable`   -> the API answered but its graph is down.
   */
  graph: 'neo4j-live' | 'postgres-live' | 'local-sample' | 'unreachable'
  graphDetail: string
  aiConfigured: boolean
  aiProvider: string
  storageConfigured: boolean
  requestSigningRequired: boolean
  environment: string
  version: string
}

/**
 * Account-level actions. `delete-account-data` removes stored data but not the
 * login itself: deleting an auth user needs the service-role key, which never
 * goes anywhere near a browser. The UI says so plainly instead of implying that
 * one click erases the account.
 */
export type ManageAccountAction = 'export' | 'reset-progress' | 'delete-account-data' | 'update-profile'

export interface ManageAccountInput {
  action: ManageAccountAction
  /** Required by the server for destructive actions — a typed confirmation. */
  confirm?: string
}

export interface ManageAccountResult {
  action: ManageAccountAction
  detail: string
  /** Present for `export`: the learner's own records, as a JSON-ready object. */
  payload?: Record<string, unknown>
}

export interface GraphMentorClient {
  readonly mode: ClientMode
  /** Shown in the UI banner; never claims live data for sample data. */
  readonly provenance: string
  health(): Promise<HealthReport>
  listCareers(query?: CareerQuery): Promise<ClientResult<CareerSummaryResponse>>
  getCareer(careerId: string): Promise<ClientResult<CareerDetailsResponse>>
  getGraph(input: GraphQueryInput): Promise<ClientResult<GraphExploreResponse>>
  getSkill(skillId: string): Promise<ClientResult<SkillDetailsResponse>>
  analyzeGaps(input: GapAnalysisInput): Promise<ClientResult<SkillGapResponse>>
  getCareerPath(input: RoadmapInput): Promise<ClientResult<CareerPathResponse>>
  generateRoadmap(input: RoadmapInput): Promise<ClientResult<RoadmapGenerateResponse>>
  listProjects(query?: ProjectQueryInput): Promise<ClientResult<ProjectListResponse>>
  listResources(query?: ResourceQueryInput): Promise<ClientResult<ResourceListResponse>>
  /** The searchable index of every skill and concept (used by the palette). */
  listSkills(query?: { q?: string; limit?: number }): Promise<ClientResult<SkillIndexResponse>>
  mentorChat(input: MentorInput): Promise<ClientResult<MentorChatResponse>>

  /* Writes. In demo mode these act on this device only and say so in the
   * result; in live mode they require a signed-in session (RLS enforces it). */
  saveRoadmap(input: RoadmapSaveInput): Promise<ClientResult<RoadmapSaveResult>>
  updateProgress(input: ProgressUpdateInput): Promise<ClientResult<ProgressUpdateResult>>
  resetProgress(input: { roadmapId?: string; confirm: 'RESET' }): Promise<ClientResult<{ resetTasks: number }>>
  manageBookmarks(input: BookmarksInput): Promise<ClientResult<BookmarksResult>>
  submitFeedback(input: FeedbackInput): Promise<ClientResult<FeedbackResult>>
  /**
   * Export or delete the data held in the learner's account.
   *
   * Demo mode can export (there is local data to export) but cannot delete
   * account data, because no account exists — it says so rather than reporting
   * a deletion that never happened.
   */
  manageAccount(input: ManageAccountInput): Promise<ClientResult<ManageAccountResult>>
}

/* ==========================================================================
 * Demo client — the same engine, running in the browser
 * ========================================================================== */

const LOCAL_SOURCE: ApiMeta['source'] = 'local-sample'

function localMeta(ms: number, extra: Partial<ApiMeta> = {}): ApiMeta {
  return {
    source: LOCAL_SOURCE,
    queryMs: Math.max(0, Math.round(ms)),
    generatedAt: new Date().toISOString(),
    ...extra,
  }
}

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const
type DifficultyValue = (typeof DIFFICULTIES)[number]

function asDifficulty(value: unknown): DifficultyValue | undefined {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value) ? (value as DifficultyValue) : undefined
}

function asSkillState(value: string): 'unknown' | 'new' | 'learning' | 'practised' | 'confident' {
  return value === 'new' || value === 'learning' || value === 'practised' || value === 'confident' ? value : 'unknown'
}

function asPace(value: string): 'relaxed' | 'steady' | 'intensive' {
  return value === 'relaxed' || value === 'intensive' ? value : 'steady'
}

function asLearningStyle(value: string): 'video' | 'reading' | 'hands-on' | 'mixed' {
  return value === 'video' || value === 'reading' || value === 'hands-on' ? value : 'mixed'
}

function careerGraphBasis(career: CareerDetail, max = 10): string[] {
  return career.skills.slice(0, max).map((skill) => graphBasisLine('REQUIRES_SKILL', career.id, skill.id))
}

export function createDemoClient(): GraphMentorClient {
  const reader: GraphReader = createLocalReader(knowledgeGraph)

  const resourceBadge = (accessModel: string, verification: string): string =>
    verification === 'verified' ? `${accessBadgeFor(accessModel)} · link checked` : `${accessBadgeFor(accessModel)} · not re-checked`

  return {
    mode: 'demo',
    provenance: knowledgeGraph.provenance,

    async health() {
      return {
        mode: 'demo',
        graph: 'local-sample',
        graphDetail: 'Bundled sample curriculum is being used in the browser. No Neo4j connection is involved.',
        aiConfigured: false,
        aiProvider: 'none',
        storageConfigured: false,
        requestSigningRequired: false,
        environment: 'browser-demo',
        version: knowledgeGraph.version,
      }
    },

    async listCareers(query = {}) {
      const started = Date.now()
      const [careers, branches] = await Promise.all([
        query.q || query.branchId || query.difficulty
          ? reader.searchCareers({
              ...(query.q ? { q: query.q } : {}),
              ...(query.branchId ? { branchId: query.branchId } : {}),
              ...(asDifficulty(query.difficulty) ? { difficulty: asDifficulty(query.difficulty) as DifficultyValue } : {}),
              limit: 60,
            })
          : reader.listCareers(60),
        reader.listBranches(40),
      ])
      return {
        data: {
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
          filters: { query: query.q ?? '', branch: query.branchId ?? null, difficulty: asDifficulty(query.difficulty) ?? null },
          total: careers.value.length,
        },
        meta: localMeta(Date.now() - started, { truncated: Boolean(careers.truncated) }),
      }
    },

    async getCareer(careerId) {
      const started = Date.now()
      const [careerResult, slice] = await Promise.all([
        reader.getCareer(careerId),
        loadCareerSlice(reader, careerId, { depth: 4, maxSkills: 120, projectLimit: 6, resourceLimit: 8 }),
      ])
      const career = careerResult.value
      if (!career) {
        throw new ApiError('not_found', `The graph has no career with identifier "${careerId}".`, 404)
      }
      // Keywords are authored in the dataset and are not part of CareerDetail,
      // so read them from the same bundled source rather than inventing any.
      const keywords = knowledgeGraph.careers.find((entry) => entry.id === career.id)?.keywords ?? []
      const data: CareerDetailsResponse = {
        career: {
          id: career.id,
          label: 'Career',
          name: career.name,
          slug: career.id.split(':')[1] ?? career.id,
          summary: career.summary,
          description: career.description,
          branches: career.branches.map((branch) => ({ id: branch.id, name: branch.name })),
          responsibilities: career.responsibilities,
          portfolioIdeas: career.portfolioIdeas,
          assumptions: career.assumptions,
          verification: career.verification ?? 'community',
          relatedCareers: career.related.map((related) => ({ id: related.id, name: related.name })),
          difficulty: career.difficulty ?? 'intermediate',
          keywords,
          typicalRoles: career.typicalRoles,
          skills: career.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            ...(skill.summary ? { summary: skill.summary } : {}),
            difficulty: skill.difficulty,
            essential: skill.essential,
            weight: skill.weight,
          })),
        },
        projects: slice.projects.slice(0, 6).map((project) => ({
          id: project.id,
          name: project.name,
          difficulty: project.difficulty,
          summary: project.summary,
          deliverables: project.deliverables,
          safetyNotes: project.safetyNotes,
        })),
        resources: slice.resources.slice(0, 8).map((resource) => ({
          id: resource.id,
          name: resource.name,
          provider: resource.provider,
          url: resource.url,
          accessBadge: resourceBadge(resource.accessModel, resource.verification),
        })),
        graphBasis: careerGraphBasis(career),
        caveats: [CAVEATS.estimates, CAVEATS.selfReport, CAVEATS.outcomes, knowledgeGraph.provenance],
      }
      return { data, meta: localMeta(Date.now() - started, { truncated: slice.truncated }) }
    },

    async getGraph(input) {
      const started = Date.now()
      const result = await reader.getNeighborhood({
        ...(input.seedId ? { seedId: input.seedId } : {}),
        ...(input.careerId ? { careerId: input.careerId } : {}),
        depth: Math.max(1, Math.min(input.depth ?? 1, 3)),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels as never[] } : {}),
        ...(input.relations && input.relations.length > 0 ? { relations: input.relations as never[] } : {}),
        ...(asDifficulty(input.difficulty) ? { difficulty: asDifficulty(input.difficulty) as DifficultyValue } : {}),
        limit: Math.max(10, Math.min(input.limit ?? 60, 200)),
      })
      return {
        data: {
          graph: result.value,
          legend: legend().map((entry) => ({ ...entry, label: entry.label as string })),
          relationLegend: Object.entries(RELATION_META).map(([type, meta]) => ({
            type,
            description: meta.description,
            optional: Boolean(meta.defaultHidden),
          })),
          focusId: input.seedId ?? input.careerId ?? null,
        },
        meta: localMeta(Date.now() - started, { truncated: Boolean(result.truncated), selectionNote: result.value.selectionNote }),
      }
    },

    async getSkill(skillId) {
      const started = Date.now()
      const [skillResult, assessments] = await Promise.all([reader.getSkill(skillId), reader.getAssessments([skillId], 6)])
      const skill = skillResult.value
      if (!skill) throw new ApiError('not_found', `The graph has no skill with identifier "${skillId}".`, 404)
      const resources = await reader.findResources({ skillIds: [skillId], limit: 8 })
      const data: SkillDetailsResponse = {
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
        resources: resources.value.map((resource) => ({
          id: resource.id,
          name: resource.name,
          provider: resource.provider,
          url: resource.url,
          accessBadge: resourceBadge(resource.accessModel, resource.verification),
          verification: resource.verification,
        })),
        assessments: assessments.value.map((assessment) => ({
          id: assessment.id,
          name: assessment.name,
          skillId: assessment.skillId,
          questions: assessment.questions,
        })),
        caveats: [
          'Self-assessment checks show evidence of practice; they are not certifications and are not verified by anybody.',
          CAVEATS.estimates,
          knowledgeGraph.provenance,
        ],
      }
      return { data, meta: localMeta(Date.now() - started) }
    },

    async analyzeGaps(input) {
      const started = Date.now()
      const slice = await loadCareerSlice(reader, input.careerId, { depth: 6, maxSkills: 400 })
      const ratings = input.ratings.map((rating) => ({
        skillId: rating.skillId,
        state: asSkillState(rating.state),
        ...(rating.quizScore !== undefined ? { quizScore: rating.quizScore } : {}),
      }))
      const report = analyzeSkillGaps({
        careerId: slice.careerId,
        careerName: slice.careerName,
        careerSkills: slice.careerSkills,
        skillMeta: slice.skillMeta,
        prereqEdges: slice.prereqEdges,
        ratings,
        interests: input.interests ?? [],
        ...(input.weeklyHours !== undefined ? { weeklyHours: input.weeklyHours } : {}),
        ...(asDifficulty(input.difficultyComfort) ? { difficultyComfort: asDifficulty(input.difficultyComfort) as DifficultyValue } : {}),
        includeOptionalPaths: input.includeOptionalPaths ?? true,
      })
      const focus = report.items
        .filter((item) => item.category === 'missing-prerequisite' || item.category === 'recommended-next')
        .map((item) => item.skillId)
      const ranked = rankProjects(slice.projects, focus.slice(0, 20), 5)
      /*
       * The frontier is computed here too, from the same slice and ratings as
       * the report — offline, with no request. A guest without a backend must
       * get the same answers as a signed-in user with one, or "demo mode" would
       * be a different product rather than the same product without an account.
       */
      const frontier = analyzeFrontier({
        careerId: slice.careerId,
        careerName: slice.careerName,
        careerSkills: slice.careerSkills,
        skillMeta: slice.skillMeta,
        prereqEdges: slice.prereqEdges,
        ratings,
        interests: input.interests ?? [],
        ...(input.weeklyHours !== undefined ? { weeklyHours: input.weeklyHours } : {}),
        ...(asDifficulty(input.difficultyComfort) ? { difficultyComfort: asDifficulty(input.difficultyComfort) as DifficultyValue } : {}),
      })
      const data: SkillGapResponse = {
        report,
        frontier,
        categoryLabels: {
          'already-familiar': 'Already familiar',
          'ready-to-practice': 'Ready to practise',
          'recommended-next': 'Recommended next',
          'missing-prerequisite': 'Missing prerequisite',
          'optional-specialization': 'Optional specialisation',
        },
        projects: ranked.map((project) => ({
          id: project.id,
          name: project.name,
          difficulty: project.difficulty,
          coverage: project.coverage,
          matchReason: project.matchReason,
          summary: project.summary,
        })),
      }
      return { data, meta: localMeta(Date.now() - started, { truncated: slice.truncated }) }
    },

    async getCareerPath(input) {
      const started = Date.now()
      const slice = await loadCareerSlice(reader, input.careerId, { depth: 6, maxSkills: 400 })
      const ratings = input.ratings.map((rating) => ({
        skillId: rating.skillId,
        state: asSkillState(rating.state),
        ...(rating.quizScore !== undefined ? { quizScore: rating.quizScore } : {}),
      }))
      const pathway = buildPathway({
        careerId: slice.careerId,
        careerName: slice.careerName,
        careerSkills: slice.careerSkills,
        skillMeta: slice.skillMeta,
        prereqEdges: slice.prereqEdges,
        ratings,
        interests: input.interests ?? [],
        weeklyHours: input.weeklyHours ?? 8,
        pace: asPace(input.pace),
        learningStyle: asLearningStyle(input.learningStyle),
        difficultyComfort: asDifficulty(input.difficultyComfort) ?? 'beginner',
        projects: slice.projects,
        resources: slice.resources,
      })
      const essentials = pathway.steps.filter((step) => step.essential).length
      const data: CareerPathResponse = {
        pathway,
        career: { id: slice.careerId, name: slice.careerName, summary: slice.careerSummary },
        routes: [],
        essentialsCount: essentials,
        optionalCount: pathway.steps.length - essentials,
      }
      return { data, meta: localMeta(Date.now() - started, { truncated: slice.truncated }) }
    },

    async generateRoadmap(input) {
      const started = Date.now()
      const slice = await loadCareerSlice(reader, input.careerId, { depth: 6, maxSkills: 400 })
      const ratings = input.ratings.map((rating) => ({
        skillId: rating.skillId,
        state: asSkillState(rating.state),
        ...(rating.quizScore !== undefined ? { quizScore: rating.quizScore } : {}),
      }))
      const pathway = buildPathway({
        careerId: slice.careerId,
        careerName: slice.careerName,
        careerSkills: slice.careerSkills,
        skillMeta: slice.skillMeta,
        prereqEdges: slice.prereqEdges,
        ratings,
        interests: input.interests ?? [],
        weeklyHours: input.weeklyHours ?? 8,
        pace: asPace(input.pace),
        learningStyle: asLearningStyle(input.learningStyle),
        difficultyComfort: asDifficulty(input.difficultyComfort) ?? 'beginner',
        projects: slice.projects,
        resources: slice.resources,
      })
      const roadmap = buildRoadmap(pathway, {
        weeklyHours: input.weeklyHours ?? 8,
        pace: asPace(input.pace),
        ...(input.title ? { title: input.title } : {}),
        ...(input.startDate ? { startDate: input.startDate } : {}),
      })
      const data: RoadmapGenerateResponse = {
        roadmap,
        pathwayMeta: {
          stepsUsed: pathway.steps.length,
          alternativesConsidered: pathway.alternatives.length,
          caveats: pathway.caveats,
        },
      }
      return { data, meta: localMeta(Date.now() - started, { truncated: slice.truncated }) }
    },

    async listProjects(query = {}) {
      const started = Date.now()
      const result = await reader.findProjects({
        ...(query.careerId ? { careerId: query.careerId } : {}),
        ...(query.skillIds && query.skillIds.length > 0 ? { skillIds: query.skillIds.slice(0, 40) } : {}),
        ...(asDifficulty(query.difficulty) ? { difficulty: asDifficulty(query.difficulty) as DifficultyValue } : {}),
        limit: Math.max(1, Math.min(query.limit ?? 20, 40)),
      })
      const focus = query.skillIds ?? []
      const ranked = rankProjects(result.value, focus, result.value.length)
      const byId = new Map(ranked.map((project) => [project.id, project]))
      const data: ProjectListResponse = {
        projects: result.value.map((project) => {
          const rankedProject = byId.get(project.id)
          return {
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
            coverage: rankedProject?.coverage ?? 0,
            matchReason: rankedProject?.matchReason ?? 'Listed in the catalogue for this filter.',
          }
        }),
        filters: { career: query.careerId ?? null, difficulty: query.difficulty ?? null },
        total: result.value.length,
      }
      return { data, meta: localMeta(Date.now() - started, { truncated: Boolean(result.truncated) }) }
    },

    async listSkills(query = {}) {
      const started = Date.now()
      const result = await reader.listSkillIndex({
        ...(query.q ? { q: query.q } : {}),
        limit: Math.max(1, Math.min(query.limit ?? 200, 400)),
      })
      const data: SkillIndexResponse = {
        skills: result.value.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          difficulty: row.difficulty,
          ...(row.parentName ? { parentName: row.parentName } : {}),
        })),
        total: result.value.length,
      }
      return { data, meta: localMeta(Date.now() - started, { truncated: Boolean(result.truncated) }) }
    },

    async listResources(query = {}) {
      const started = Date.now()
      const result = await reader.findResources({
        ...(query.q ? { q: query.q } : {}),
        ...(query.skillIds && query.skillIds.length > 0 ? { skillIds: query.skillIds.slice(0, 40) } : {}),
        ...(query.format ? { format: query.format } : {}),
        ...(query.accessModel ? { accessModel: query.accessModel } : {}),
        ...(asDifficulty(query.difficulty) ? { difficulty: asDifficulty(query.difficulty) as DifficultyValue } : {}),
        limit: Math.max(1, Math.min(query.limit ?? 40, 200)),
      })
      const focus = query.skillIds ?? []
      const ranked = rankResources(result.value, focus, result.value.length)
      const byId = new Map(ranked.map((resource) => [resource.id, resource]))
      const data: ResourceListResponse = {
        resources: result.value.map((resource) => {
          const rankedResource = byId.get(resource.id)
          return {
            id: resource.id,
            name: resource.name,
            summary: resource.summary,
            url: resource.url,
            provider: resource.provider,
            format: resource.format,
            difficulty: resource.difficulty,
            language: resource.language,
            accessModel: resource.accessModel,
            accessBadge: accessBadgeFor(resource.accessModel),
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
            matchReason: rankedResource?.matchReason ?? 'Matches the current filters.',
          }
        }),
        filters: { q: query.q ?? null, format: query.format ?? null, accessModel: query.accessModel ?? null },
        total: result.value.length,
      }
      return { data, meta: localMeta(Date.now() - started, { truncated: Boolean(result.truncated) }) }
    },

    async mentorChat(input) {
      const started = Date.now()
      const intent = classifyIntent(input.message)
      const [careers, branches] = await Promise.all([reader.listCareers(60), reader.listBranches(40)])
      const vocabulary: MentorVocabularyEntry[] = [
        ...careers.value.map((career) => ({ id: career.id, name: career.name, label: 'Career' as const })),
        ...branches.value.map((branch) => ({ id: branch.id, name: branch.name, label: 'EngineeringBranch' as const })),
      ]
      const request = { message: input.message, mode: input.mode, careerId: input.careerId ?? null }
      const context = await buildMentorContext({
        reader,
        message: input.message,
        intent,
        careerId: input.careerId ?? null,
        vocabulary,
        limits: DEFAULT_CONTEXT_LIMITS,
      })
      const answer = answerWithRules({ request, context })
      const data: MentorChatResponse = {
        answer: {
          ...answer,
          disclaimer:
            'Answered by the deterministic rules engine inside your browser using the bundled sample dataset. No language model was called, and no message left this device.',
        },
        context: {
          intent: context.intent,
          skillsUsed: context.skills.length,
          projectsUsed: context.projects.length,
          resourcesUsed: context.resources.length,
          truncated: context.truncated,
          graphSource: 'local-sample',
          reads: context.reads,
          readMs: context.reads.reduce((sum, read) => sum + read.ms, 0),
        },
        limits: { requestsRemainingThisMinute: Number.POSITIVE_INFINITY, maxMessageChars: 1200 },
      }
      return { data, meta: localMeta(Date.now() - started) }
    },

    /* ---------------------------------------------------------------- writes
     * There is no backend in demo mode, so nothing is sent anywhere. These
     * writes are real local writes (the same storage the app reads), and the
     * copy that comes back says plainly that the data stayed on this device.
     * Keeping them here rather than in the UI means one code path runs in both
     * modes, so the browser and the deployment cannot drift apart.
     */
    async saveRoadmap(input) {
      const started = Date.now()
      const roadmapId = input.roadmapId ?? crypto.randomUUID()
      const taskIds: Record<string, string> = {}
      const tasks = input.tasks.map((task) => {
        const kind = task.kind ?? taskKindFromName(task.name)
        const taskKey = task.taskKey ?? taskKeyFor(kind, task.order)
        // In demo mode the local key *is* the addressable id.
        taskIds[taskKey] = taskKey
        return {
          skillId: task.skillId,
          name: task.name,
          order: task.order,
          scheduledWeek: task.scheduledWeek,
          estimatedHoursLow: task.estimatedHoursLow,
          estimatedHoursHigh: task.estimatedHoursHigh,
          taskKey,
          kind,
        }
      })

      const saved = loadLocalRoadmaps()
      const entry: LocalSavedRoadmap = {
        roadmapId,
        title: input.title?.trim() || 'My study plan',
        careerId: input.careerId,
        weeklyHours: input.weeklyHours,
        pace: input.pace,
        taskCount: tasks.length,
        taskIds,
        tasks,
        savedAt: new Date().toISOString(),
        storedOn: 'device',
      }
      const next = [entry, ...saved.filter((item) => item.roadmapId !== roadmapId)].slice(0, 20)
      saveLocalRoadmaps(next)

      return {
        data: {
          roadmapId,
          taskCount: tasks.length,
          updatedAt: new Date().toISOString(),
          taskIds,
        },
        meta: localMeta(Date.now() - started),
      }
    },

    async updateProgress(input) {
      const started = Date.now()
      // Local progress is keyed by the roadmap and by the row's task key, and in
      // demo mode `taskId` and `taskKey` are the same string.
      persistTaskStatus(input.roadmapId, input.taskKey ?? input.taskId, input.status, {
        ...(input.skillId ? { skillId: input.skillId } : {}),
        ...(typeof input.actualHours === 'number' ? { actualHours: input.actualHours } : {}),
        ...(input.note ? { notes: input.note } : {}),
      })
      return {
        data: {
          taskId: input.taskId,
          status: input.status,
          updatedAt: new Date().toISOString(),
          progress: summarizeLocalProgress(input.roadmapId),
        },
        meta: localMeta(Date.now() - started),
      }
    },

    async resetProgress(input) {
      const started = Date.now()
      const removed = resetRoadmapProgress(input.roadmapId)
      return { data: { resetTasks: removed }, meta: localMeta(Date.now() - started) }
    },

    async manageAccount(input) {
      const started = Date.now()
      if (input.action === 'export') {
        return {
          data: {
            action: 'export',
            detail: 'This device’s copy of your data (guest mode).',
            payload: exportAll(),
          },
          meta: localMeta(Date.now() - started),
        }
      }
      if (input.action === 'delete-account-data') {
        // There is no account here to delete. Pretending otherwise would be the
        // most reassuring possible lie, so this refuses instead.
        throw new ApiError(
          'not_configured',
          'No account data is stored on a server in this build. Use “Erase device data” to clear this device.',
          503,
          undefined,
        )
      }
      throw new ApiError(
        'not_configured',
        `${input.action} needs a signed-in account, which this build does not have. Your settings are already saved on this device.`,
        503,
        undefined,
      )
    },

    async manageBookmarks(input) {
      const started = Date.now()
      if (input.action === 'list') {
        return {
          data: {
            bookmarks: loadBookmarks().map((bookmark, index) => ({
              id: `local-${index + 1}`,
              targetType: bookmark.targetType,
              targetId: bookmark.targetId,
              note: bookmark.note || null,
              createdAt: bookmark.createdAt,
            })),
          },
          meta: localMeta(Date.now() - started),
        }
      }
      if (!input.targetType || !input.targetId) {
        throw new ApiError('validation_failed', 'A bookmark needs a target type and a target id.', 422, undefined)
      }
      const existing = loadBookmarks()
      const next =
        input.action === 'add'
          ? [
              { targetType: input.targetType, targetId: input.targetId, note: input.note ?? '', createdAt: new Date().toISOString() },
              ...existing.filter((bookmark) => bookmark.targetId !== input.targetId),
            ]
          : existing.filter((bookmark) => bookmark.targetId !== input.targetId)
      saveBookmarks(next)
      return {
        data: {
          bookmarks: next.map((bookmark, index) => ({
            id: `local-${index + 1}`,
            targetType: bookmark.targetType,
            targetId: bookmark.targetId,
            note: bookmark.note || null,
            createdAt: bookmark.createdAt,
          })),
          changed: { action: input.action, targetId: input.targetId },
        },
        meta: localMeta(Date.now() - started),
      }
    },

    async submitFeedback(input) {
      const started = Date.now()
      const entry: LocalFeedbackEntry = {
        id: crypto.randomUUID(),
        kind: input.kind,
        message: input.message.slice(0, 1500),
        ...(input.contact ? { contact: input.contact } : {}),
        ...(input.targetId ? { targetId: input.targetId } : {}),
        ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
        createdAt: new Date().toISOString(),
      }
      const next = [entry, ...loadFeedbackOutbox()].slice(0, 50)
      saveFeedbackOutbox(next)
      return {
        data: {
          id: entry.id,
          receivedAt: entry.createdAt,
          note:
            'Stored on this device only. There is no backend configured, so nothing was sent to the maintainers — your report is in Settings > Your data and will be included in exports.',
        },
        meta: localMeta(Date.now() - started),
      }
    },
  }
}

/* ==========================================================================
 * Live client — deployed Edge Functions
 * ========================================================================== */

export interface LiveClientOptions {
  apiBaseUrl: string
  /** Returns the current Supabase access token, or null for guests. */
  getToken: () => Promise<string | null>
  /**
   * Optional HMAC signer for deployments with REQUIRE_REQUEST_SIGNING=true.
   *
   * It receives the *complete* canonical parts — including the nonce this client
   * generated — and returns only the signature. That shape is deliberate: when
   * the signer owned nonce generation, the string handed to it could not contain
   * the nonce, so the nonce was necessarily outside the signed bytes and a
   * captured request could be replayed by swapping in a fresh one. Passing the
   * nonce in makes omitting it impossible rather than merely unlikely.
   *
   * Use `signClientRequest` for the implementation; it signs with the same
   * canonical string the Edge Function verifies.
   */
  sign?: (parts: ClientRequestParts) => Promise<{ signature: string }>
  /**
   * Optional fetch implementation. The default is the platform one; a shell
   * (Capacitor, a test, a proxy) may need to supply its own.
   */
  fetchImpl?: typeof fetch
}

/** The fields both sides of the request-signature contract must agree on. */
export interface ClientRequestParts {
  method: string
  /** Path only, no query string — the server signs `url.pathname`. */
  path: string
  body: string
  timestampMs: number
  nonce: string
}

/**
 * Signs a request the way the Edge Function verifies it.
 *
 * Both sides use `canonicalRequestString` from the shared core, so the field
 * order and membership are defined once. The browser previously built its own
 * four-field string (`method\npath\ntimestamp\nbody`) against the server's five
 * (`…\nnonce\nbody`): every signed request failed as a mismatch, so turning
 * replay protection on took the AI and save endpoints offline instead of
 * hardening them — and the field it dropped was the nonce, the one that makes a
 * request single-use. See tests/security/exploit-replay-nonce.test.ts.
 */
export async function signClientRequest(
  secret: string,
  parts: { method: string; path: string; body: string; timestampMs: number },
): Promise<{ signature: string; nonce: string; timestampMs: number }> {
  // 16 bytes of hex: inside the server's /^[0-9a-f]{16,64}$/i nonce shape and
  // its 8-character minimum, and large enough that a fresh one never collides
  // with a nonce still inside its replay window.
  const nonce = randomToken(16)
  const signature = await buildRequestSignature(secret, { ...parts, nonce })
  return { signature, nonce, timestampMs: parts.timestampMs }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code?: string; message?: string; retryAfterSeconds?: number }
  meta?: ApiMeta
}

export function createLiveClient(options: LiveClientOptions): GraphMentorClient {
  const base = options.apiBaseUrl.replace(/\/$/, '')
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args))

  /** Absolute bases are used as-is; a relative base ("/functions/v1") resolves
   * against the page origin, which is how one same-origin deployment serves
   * both the site and the API without the build knowing its own hostname. */
  const endpointUrl = (fn: string): URL => {
    const path = `${base}/${fn}`
    if (/^https?:\/\//i.test(path)) return new URL(path)
    if (typeof window !== 'undefined' && window.location?.origin) return new URL(path, window.location.origin)
    return new URL(path, 'http://localhost')
  }

  async function call<T>(fn: string, init: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string | undefined> }): Promise<ClientResult<T>> {
    const url = endpointUrl(fn)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value)
    }

    const headers: Record<string, string> = { accept: 'application/json' }
    const token = await options.getToken()
    if (token) headers.authorization = `Bearer ${token}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    let bodyText: string | undefined
    if (init.body !== undefined) {
      bodyText = JSON.stringify(init.body)
      if (options.sign) {
        // Replay protection. The nonce is generated here and handed to the
        // signer as part of the canonical parts, so it is inside the signed
        // bytes: a captured request cannot be replayed with a fresh nonce.
        const timestampMs = Date.now()
        const nonce = randomToken(16)
        const { signature } = await options.sign({
          method: init.method,
          path: url.pathname,
          body: bodyText,
          timestampMs,
          nonce,
        })
        headers['x-gm-signature'] = signature
        headers['x-gm-nonce'] = nonce
        headers['x-gm-timestamp'] = String(timestampMs)
      }
    }

    let response: Response
    try {
      response = await doFetch(url.toString(), {
        method: init.method,
        headers,
        ...(bodyText !== undefined ? { body: bodyText } : {}),
      })
    } catch (error) {
      throw new ApiError(
        'network_error',
        `Could not reach the backend (${error instanceof Error ? error.message : 'network failure'}). Check your connection, or keep working in demo mode.`,
        0,
      )
    }

    const text = await response.text()
    let parsed: Envelope<T> | null = null
    try {
      parsed = text ? (JSON.parse(text) as Envelope<T>) : null
    } catch {
      parsed = null
    }

    if (!parsed) {
      throw new ApiError('bad_response', `The backend returned a response that was not JSON (HTTP ${response.status}).`, response.status)
    }
    if (!parsed.ok || parsed.data === undefined) {
      const code = parsed.error?.code ?? (response.status === 429 ? 'rate_limited' : 'request_failed')
      const message = parsed.error?.message ?? `Request failed (HTTP ${response.status}).`
      throw new ApiError(code, message, response.status, parsed.error?.retryAfterSeconds)
    }
    return { data: parsed.data, meta: parsed.meta ?? { source: 'neo4j-live', generatedAt: new Date().toISOString() } }
  }

  return {
    mode: 'live',
    provenance: 'Live deployment: careers, skills, projects and resources are read from the configured Neo4j knowledge graph through Supabase Edge Functions.',

    async health() {
      /* The shape health-check actually returns (handlers/health.ts). A
       * previous draft of this mapper read `graph.status`/'environment'/'version'
       * fields the payload has never had, so live mode could never engage. */
      const { data } = await call<{
        graph: {
          configured: boolean
          reachable: boolean
          source: 'neo4j-live' | 'postgres-live' | 'local-sample' | 'cache' | 'unavailable'
          nodeCount?: number
          relationshipCount?: number
          message?: string
          setupHint?: string
        }
        ai: { configured: boolean; provider: string }
        storage: { configured: boolean }
        security: { requestSigningRequired: boolean }
        service: { version: string; environment: string }
      }>('health-check', { method: 'GET' })
      const graph: HealthReport['graph'] = !data.graph.reachable
        ? 'unreachable'
        : data.graph.source === 'neo4j-live'
          ? 'neo4j-live'
          : data.graph.source === 'postgres-live'
            ? 'postgres-live'
            : 'local-sample'
      return {
        mode: 'live',
        graph,
        graphDetail: [data.graph.message, data.graph.setupHint].filter(Boolean).join(' ') || 'Graph status reported by the backend.',
        aiConfigured: data.ai.configured,
        aiProvider: data.ai.provider,
        storageConfigured: data.storage.configured,
        requestSigningRequired: data.security.requestSigningRequired,
        environment: data.service.environment,
        version: data.service.version,
      }
    },

    listCareers: (query = {}) =>
      call<CareerSummaryResponse>('get-careers', {
        method: 'GET',
        query: { q: query.q, branch: query.branchId, difficulty: query.difficulty },
      }),

    getCareer: (careerId) => call<CareerDetailsResponse>('get-career-details', { method: 'GET', query: { id: careerId } }),

    getGraph: (input) =>
      call<GraphExploreResponse>('get-graph', {
        method: 'POST',
        body: {
          ...(input.seedId ? { seedId: input.seedId } : {}),
          ...(input.careerId ? { careerId: input.careerId } : {}),
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ...(input.labels ? { labels: input.labels } : {}),
          ...(input.relations ? { relations: input.relations } : {}),
          ...(input.difficulty ? { difficulty: input.difficulty } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        },
      }),

    getSkill: (skillId) => call<SkillDetailsResponse>('get-skill-details', { method: 'GET', query: { id: skillId } }),

    analyzeGaps: (input) => call<SkillGapResponse>('analyze-skill-gaps', { method: 'POST', body: input }),

    getCareerPath: (input) => call<CareerPathResponse>('get-career-path', { method: 'POST', body: input }),

    generateRoadmap: (input) => call<RoadmapGenerateResponse>('generate-learning-roadmap', { method: 'POST', body: input }),

    listProjects: (query = {}) =>
      call<ProjectListResponse>('get-projects', {
        method: 'POST',
        body: {
          ...(query.careerId ? { careerId: query.careerId } : {}),
          ...(query.skillIds ? { skillIds: query.skillIds } : {}),
          ...(query.difficulty ? { difficulty: query.difficulty } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
        },
      }),

    listSkills: (query = {}) =>
      call<SkillIndexResponse>('get-skills', {
        method: 'GET',
        query: { q: query.q, limit: query.limit === undefined ? undefined : String(query.limit) },
      }),

    listResources: (query = {}) =>
      call<ResourceListResponse>('get-resources', {
        method: 'POST',
        body: {
          ...(query.q ? { q: query.q } : {}),
          ...(query.skillIds ? { skillIds: query.skillIds } : {}),
          ...(query.format ? { format: query.format } : {}),
          ...(query.accessModel ? { accessModel: query.accessModel } : {}),
          ...(query.difficulty ? { difficulty: query.difficulty } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
        },
      }),

    mentorChat: (input) => call<MentorChatResponse>('mentor-chat', { method: 'POST', body: input }),

    /* ---------------------------------------------------------------- writes
     * Every one of these requires a signed-in session: the handler rejects
     * guests with 401 and RLS would refuse the row anyway. Nothing here trusts
     * a client-supplied count — the server recomputes summaries from its rows.
     */
    async saveRoadmap(input) {
      const body = {
        ...(input.roadmapId ? { roadmapId: input.roadmapId } : {}),
        title: input.title?.trim() || 'My study plan',
        careerId: input.careerId,
        weeklyHours: input.weeklyHours,
        pace: input.pace,
        tasks: input.tasks.map((task) => ({
          skillId: task.skillId,
          name: task.name,
          order: task.order,
          scheduledWeek: task.scheduledWeek,
          estimatedHoursLow: task.estimatedHoursLow,
          estimatedHoursHigh: task.estimatedHoursHigh,
          essential: task.essential ?? true,
          status: task.status ?? 'not-started',
          difficulty: task.difficulty ?? 'beginner',
          ...(task.taskKey ? { taskKey: task.taskKey } : {}),
          ...(task.kind ? { kind: task.kind } : {}),
        })),
      }
      const saved = await call<{ roadmapId: string; taskCount: number; updatedAt: string }>('save-roadmap', { method: 'POST', body })

      // The rows carry their own ids, and progress is updated by row id. Read
      // them back once and pair them with the client's task keys, so the UI can
      // keep talking about `learn-3` while the API talks about uuids.
      const taskIds: Record<string, string> = {}
      try {
        const listed = await call<{
          roadmaps: Array<{ roadmap: { id: string; tasks: Array<{ taskKey: string; order: number; kind: string }> } }>
        }>('update-progress', { method: 'GET', query: { roadmapId: saved.data.roadmapId } })
        const match = listed.data.roadmaps.find((entry) => entry.roadmap.id === saved.data.roadmapId)
        for (const task of match?.roadmap.tasks ?? []) taskIds[task.taskKey] = task.taskKey
      } catch {
        // A read-back failure must not fail the save: the roadmap is stored, and
        // the UI falls back to showing "saved, progress still device-only".
      }
      return {
        data: { ...saved.data, taskIds },
        meta: saved.meta,
      }
    },

    updateProgress: (input) =>
      call<ProgressUpdateResult>('update-progress', {
        method: 'POST',
        body: {
          roadmapId: input.roadmapId,
          taskId: input.taskId,
          status: input.status,
          ...(typeof input.actualHours === 'number' ? { actualHours: input.actualHours } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      }),

    resetProgress: (input) =>
      call<{ resetTasks: number }>('update-progress', {
        method: 'POST',
        body: { ...(input.roadmapId ? { roadmapId: input.roadmapId } : {}), confirm: input.confirm },
      }),

    manageBookmarks: (input) => call<BookmarksResult>('manage-bookmarks', { method: 'POST', body: input }),

    submitFeedback: (input) => call<FeedbackResult>('submit-feedback', { method: 'POST', body: input }),

    manageAccount: (input) =>
      call<ManageAccountResult>('manage-account', {
        method: 'POST',
        body: { action: input.action, ...(input.confirm ? { confirm: input.confirm } : {}) },
      }),
  }
}

/** Convenience: default demo client bound to the bundled dataset. */
let demoClient: GraphMentorClient | null = null
export function getDemoClient(): GraphMentorClient {
  demoClient ??= createDemoClient()
  return demoClient
}

export { config }


