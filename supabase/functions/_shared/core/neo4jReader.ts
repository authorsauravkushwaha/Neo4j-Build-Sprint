/**
 * Live Neo4j reader.
 *
 * Talks to the Neo4j AuraDB HTTP **Query API** over HTTPS with Basic auth. This
 * module must only ever run server-side (Supabase Edge Function): the reader is
 * constructed from secrets and is never imported by browser code. The frontend
 * reaches it exclusively through the Edge Function API (see src/core/api).
 *
 * Reliability decisions:
 *  - one POST per query, JSON body `{ statement, parameters }`,
 *  - hard timeout via AbortController (NEO4J_TIMEOUT_MS),
 *  - bounded retries with jitter for 429/503 (safe: every query here is a read),
 *  - row arrays clamped to NEO4J_MAX_ROWS,
 *  - both Query API v1 (`results[0].data[].row`) and v2 (`data.values`) response
 *    shapes are decoded, because the shape depends on the Aura instance version,
 *  - errors are mapped to AppError codes; the upstream body never reaches a user.
 */
import { createQueryApiClient, type QueryApiEvent } from './neo4jQueryApi.ts'
import type {
  Difficulty,
  GraphEdge,
  GraphNeighborhood,
  GraphNode,
  NodeLabel,
  VerificationState,
} from './types.ts'
import type {
  AssessmentView,
  CareerDetail,
  CareerSearchInput,
  CareerSkillRow,
  CareerSummary,
  GraphReader,
  GraphTotals,
  ModuleView,
  NeighborhoodInput,
  ProjectQuery,
  ProjectView,
  ReadOptions,
  ReadResult,
  ResourceQuery,
  ResourceView,
  RouteView,
  SkillDetail,
  SkillIndexRow,
  SkillMetaRow,
} from './graphReader.ts'
import { clampLimit } from './graphReader.ts'
import { MAX_CATALOG_LIMIT } from './types.ts'
import {
  CAREER_BRANCHES,
  CAREER_CATALOG,
  CAREER_DETAILS,
  CAREER_OVERVIEW_SUBGRAPH,
  CAREER_REQUIRED_SKILLS,
  CAREER_SEARCH,
  HEALTH_COUNTS,
  SKILL_INDEX,
  HEALTH_TOTAL,
  HEALTH_TOTAL_RELS,
  PROJECTS_FOR_CAREER,
  PROJECTS_FOR_SKILLS,
  RESOURCES_FOR_SKILLS,
  RESOURCE_CATALOG,
  ROUTES_SKILL_TO_CAREER,
  SKILL_DETAILS,
  SKILL_EDGES_BY_IDS,
  ASSESSMENTS_FOR_SKILLS,
  MODULES_FOR_CAREER,
  careerPrereqClosure,
  downstreamClosure,
  edgesAmongIds,
  labelForNodeId,
  neighbourhoodQuery,
  skillPrereqClosure,
} from './graphQuery.ts'
import { buildNeighborhood, isDifficulty, toGraphEdge, toGraphNode, type RawRow } from './graphModel.ts'
import { asBoolean, asHourRange, asNumber, asObjectArray, asString, asStringArray } from './rowParsers.ts'
import { decodeAssessmentQuestions } from './assessmentCodec.ts'
import { clamp, isHttpsUrl, normalizeText } from './normalize.ts'

export interface Neo4jConfig {
  queryUrl: string
  database: string
  username: string
  password: string
  timeoutMs: number
  maxRows: number
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Optional logger sink (already redacted by the caller). */
  onEvent?: (event: QueryApiEvent) => void
}

interface QueryResult {
  rows: RawRow[]
  ms: number
}

/**
 * Builds the read-only graph reader on top of the shared Query API client
 * (`neo4jQueryApi.ts`). The client owns transport, auth, timeouts, retries and
 * response decoding; this function owns the row-to-domain mapping.
 */
export function createNeo4jReader(config: Neo4jConfig): GraphReader {
  const client = createQueryApiClient({
    queryUrl: config.queryUrl,
    username: config.username,
    password: config.password,
    timeoutMs: config.timeoutMs,
    maxRows: config.maxRows,
    fetchImpl: config.fetchImpl,
    onEvent: config.onEvent,
  })
  const maxRows = client.maxRows

  async function runQuery(cypher: string, params: Record<string, unknown>, options: { signal?: AbortSignal; tag?: string; retries?: number } = {}): Promise<QueryResult> {
    const safeParams: Record<string, unknown> = { ...params }
    if (!('limit' in safeParams)) safeParams.limit = maxRows
    safeParams.limit = Math.min(asNumber(safeParams.limit, maxRows) || maxRows, maxRows)
    // Reads only: accessMode "Read" is sent by the client for every call made here.
    return client.run(cypher, safeParams, { tag: options.tag, signal: options.signal, retries: options.retries })
  }

  /* ---------------------------------------------------------------------- */
  /* Row → domain converters (all values bounds-checked)                     */
  /* ---------------------------------------------------------------------- */

  const toCareerSummary = (row: RawRow): CareerSummary | null => {
    const id = asString(row.id, 72)
    const name = asString(row.name, 200)
    if (!id || !name) return null
    return {
      id,
      name,
      summary: asString(row.summary, 1200) ?? '',
      difficulty: isDifficulty(row.difficulty) ? row.difficulty : undefined,
      verification: (asString(row.verification, 24) ?? 'community') as VerificationState,
      branchIds: asStringArray(row.branchIds, 12),
      ...(row.skillIds !== undefined ? { skillIds: asStringArray(row.skillIds, 80) } : {}),
    }
  }

  const toSkillRow = (row: RawRow): CareerSkillRow | null => {
    const id = asString(row.id, 72)
    const name = asString(row.name, 200)
    if (!id || !name) return null
    return {
      id,
      name,
      summary: asString(row.summary, 800) ?? undefined,
      difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'beginner',
      essential: asBoolean(row.essential, true),
      weight: clamp(asNumber(row.weight, 0.5), 0, 1),
    }
  }

  const toSkillMeta = (row: RawRow): SkillMetaRow | null => {
    const id = asString(row.id, 72)
    const name = asString(row.name, 200)
    if (!id || !name) return null
    const hours = asHourRange(row.estimatedHoursLow ?? row.hoursLow, row.estimatedHoursHigh ?? row.hoursHigh)
    return {
      id,
      name,
      summary: asString(row.summary, 800) ?? undefined,
      difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'beginner',
      estimatedHoursLow: hours[0],
      estimatedHoursHigh: hours[1],
      completionCriteria: asStringArray(row.completionCriteria, 12),
      practice: asStringArray(row.practice, 12),
    }
  }

  const toProjectView = (row: RawRow): ProjectView | null => {
    const id = asString(row.id, 72)
    const name = asString(row.name, 200)
    if (!id || !name) return null
    return {
      id,
      name,
      summary: asString(row.summary, 800) ?? '',
      description: asString(row.description, 2000) ?? asString(row.summary, 800) ?? '',
      difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'beginner',
      objectives: asStringArray(row.objectives, 12),
      deliverables: asStringArray(row.deliverables, 12),
      milestones: asStringArray(row.milestones, 12),
      testingIdeas: asStringArray(row.testingIdeas, 10),
      extensions: asStringArray(row.extensions, 10),
      safetyNotes: asStringArray(row.safetyNotes, 10),
      tools: asStringArray(row.tools, 10),
      skillIds: asStringArray(row.skillIds, 60),
      matchedSkillIds: asStringArray(row.matchedSkills, 60),
      estimatedHours: asHourRange(row.estimatedHoursLow, row.estimatedHoursHigh),
    }
  }

  const toResourceView = (row: RawRow): ResourceView | null => {
    const id = asString(row.id, 72)
    const name = asString(row.name, 200)
    if (!id || !name) return null
    const url = asString(row.url, 2048) ?? ''
    return {
      id,
      name,
      summary: asString(row.summary, 800) ?? '',
      // A stored non-https URL is displayed as plain text, never as a link.
      url: isHttpsUrl(url) ? url : '',
      provider: asString(row.provider, 120) ?? 'Unknown provider',
      format: asString(row.format, 32) ?? 'reference',
      difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'beginner',
      language: asString(row.language, 16) ?? 'en',
      accessModel: asString(row.accessModel, 32) ?? 'unknown',
      accessNote: asString(row.accessNote, 400) ?? '',
      outcomes: asStringArray(row.outcomes, 6),
      assumes: asString(row.assumes, 400) ?? '',
      limits: asString(row.limits, 400) ?? '',
      commitment: asString(row.commitment, 200) ?? '',
      estimatedHours: [asNumber(row.estimatedHoursLow, 0), asNumber(row.estimatedHoursHigh, 0)],
      assumesIds: asStringArray(row.assumesIds, 20),
      assumesNames: asStringArray(row.assumesNames, 20),
      lastVerified: asString(row.lastVerified, 32) ?? null,
      verification: (asString(row.verification, 24) ?? 'unverified') as VerificationState,
      coversIds: asStringArray(row.coversIds ?? row.skillIds, 40),
      coversNames: asStringArray(row.coversNames, 40),
      matchedSkillIds: asStringArray(row.matchedSkills ?? row.skillIds, 40),
    }
  }

  const reader: GraphReader = {
    kind: 'neo4j',
    configured: true,
    provenance: `Neo4j query API (${redactHost(config.queryUrl)}), database "${config.database}"`,

    async totals(options?: ReadOptions): Promise<ReadResult<GraphTotals>> {
      const started = Date.now()
      const [labels, totals, rels] = await Promise.all([
        runQuery(HEALTH_COUNTS, {}, { signal: options?.signal, tag: 'HEALTH_COUNTS' }),
        runQuery(HEALTH_TOTAL, {}, { signal: options?.signal, tag: 'HEALTH_TOTAL' }),
        runQuery(HEALTH_TOTAL_RELS, {}, { signal: options?.signal, tag: 'HEALTH_TOTAL_RELS' }),
      ])
      const labelRows = labels.rows
        .map((row) => ({ label: asString(row.label, 64) ?? '', count: asNumber(row.total, 0) }))
        .filter((row) => row.label && row.count > 0)
        .sort((a, b) => a.label.localeCompare(b.label))
      return {
        value: {
          nodes: asNumber(totals.rows[0]?.nodes, 0),
          relationships: asNumber(rels.rows[0]?.relationships, 0),
          labels: labelRows,
        },
        ms: Date.now() - started,
      }
    },

    async listSkillIndex(input, options) {
      // The filter is applied in Node, never by building a Cypher predicate from
      // user input, so a search term cannot change the query plan.
      const limit = clampLimit(input.limit, 400, 120)
      const { rows, ms } = await runQuery(SKILL_INDEX, { limit }, { signal: options?.signal, tag: 'SKILL_INDEX' })
      const query = normalizeText(input.q ?? '')
      const parsed = rows
        .map((row) => {
          const id = asString(row.id)
          const name = asString(row.name)
          if (!id || !name) return null
          const parentName = asString(row.parentName)
          const label = asString(row.label)
          return {
            id,
            name,
            kind: (label === 'Concept' ? 'Concept' : 'Skill') as 'Skill' | 'Concept',
            difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'intermediate',
            ...(parentName ? { parentName } : {}),
          } satisfies SkillIndexRow
        })
        .filter((row): row is SkillIndexRow => row !== null)
      const filtered = query ? parsed.filter((row) => normalizeText(`${row.name} ${row.parentName ?? ''} ${row.id}`).includes(query)) : parsed
      return { value: filtered.slice(0, limit), ms }
    },

    async listCareers(limit, options) {
      const { rows, ms } = await runQuery(CAREER_CATALOG, { limit: clampLimit(limit, 200, 60) }, { signal: options?.signal, tag: 'CAREER_CATALOG' })
      return { value: rows.map(toCareerSummary).filter((c): c is CareerSummary => c !== null), ms }
    },

    async searchCareers(input: CareerSearchInput, options) {
      // CONTAINS is a literal substring match: no wildcards and no regex, so a
      // hostile search term cannot change the query plan (ReDoS-safe by design).
      const q = normalizeText(input.q ?? '').slice(0, 80)
      const { rows, ms } = await runQuery(
        CAREER_SEARCH,
        {
          q,
          branchId: input.branchId ?? '',
          difficulty: input.difficulty ?? '',
          limit: clampLimit(input.limit, 60, 24),
          offset: Math.max(0, Math.trunc(input.offset ?? 0)),
        },
        { signal: options?.signal, tag: 'CAREER_SEARCH' },
      )
      return { value: rows.map(toCareerSummary).filter((c): c is CareerSummary => c !== null), ms }
    },

    async listBranches(limit, options) {
      const { rows, ms } = await runQuery(CAREER_BRANCHES, { limit: clampLimit(limit, 80, 40) }, { signal: options?.signal, tag: 'CAREER_BRANCHES' })
      return {
        value: rows
          .map((row) => ({
            id: asString(row.id, 72) ?? '',
            name: asString(row.name, 160) ?? '',
            summary: asString(row.summary, 800) ?? '',
            careerCount: asNumber(row.careerCount, 0),
          }))
          .filter((row) => row.id && row.name),
        ms,
      }
    },

    async getCareer(careerId: string, options): Promise<ReadResult<CareerDetail | null>> {
      const { rows, ms } = await runQuery(CAREER_DETAILS, { careerId }, { signal: options?.signal, tag: 'CAREER_DETAILS' })
      const row = rows[0]
      if (!row) return { value: null, ms }
      const summary = toCareerSummary(row)
      if (!summary) return { value: null, ms }

      const skills = asObjectArray(row.skills, 120)
        .map((entry) =>
          toSkillRow({
            id: entry.id,
            name: entry.name,
            difficulty: entry.difficulty,
            essential: entry.essential,
            weight: entry.weight,
          }),
        )
        .filter((s): s is CareerSkillRow => s !== null)

      return {
        value: {
          ...summary,
          description: asString(row.description, 4000) ?? summary.summary,
          responsibilities: asStringArray(row.responsibilities, 12),
          portfolioIdeas: asStringArray(row.portfolioIdeas, 12),
          assumptions: asStringArray(row.assumptions, 12),
          typicalRoles: asStringArray(row.typicalRoles, 12),
          branches: asObjectArray(row.branches, 12)
            .map((b) => ({ id: asString(b.id, 72) ?? '', name: asString(b.name, 160) ?? '' }))
            .filter((b) => b.id && b.name),
          skills,
          related: asObjectArray(row.related, 12)
            .map((b) => ({ id: asString(b.id, 72) ?? '', name: asString(b.name, 160) ?? '' }))
            .filter((b) => b.id && b.name),
          projects: asObjectArray(row.projects, 24)
            .map((p) => ({
              id: asString(p.id, 72) ?? '',
              name: asString(p.name, 200) ?? '',
              difficulty: isDifficulty(p.difficulty) ? p.difficulty : undefined,
            }))
            .filter((p) => p.id && p.name),
        },
        ms,
      }
    },

    async getCareerSkills(careerId, options) {
      const { rows, ms } = await runQuery(CAREER_REQUIRED_SKILLS, { careerId, limit: maxRows }, { signal: options?.signal, tag: 'CAREER_REQUIRED_SKILLS' })
      return { value: rows.map(toSkillRow).filter((s): s is CareerSkillRow => s !== null), ms }
    },

    async getCareerClosure(careerId, depth, limit, options) {
      const variant = careerPrereqClosure(depth)
      const { rows, ms } = await runQuery(variant.cypher, { careerId, limit: clampLimit(limit, 400, 200) }, { signal: options?.signal, tag: 'CAREER_PREREQ_CLOSURE' })
      const value = rows.map(toSkillMeta).filter((s): s is SkillMetaRow => s !== null)
      return { value, ms, truncated: rows.length >= clampLimit(limit, 400, 200) }
    },

    async getSkillEdges(ids, limit, options) {
      if (ids.length === 0) return { value: [], ms: 0 }
      const { rows, ms } = await runQuery(SKILL_EDGES_BY_IDS, { ids: ids.slice(0, 400), limit: clampLimit(limit, 600, 400) }, { signal: options?.signal, tag: 'SKILL_EDGES_BY_IDS' })
      return {
        value: rows.map(toGraphEdge).filter((e): e is GraphEdge => e !== null),
        ms,
        truncated: rows.length >= clampLimit(limit, 600, 400),
      }
    },

    async getSkill(skillId: string, options): Promise<ReadResult<SkillDetail | null>> {
      const { rows, ms } = await runQuery(SKILL_DETAILS, { skillId }, { signal: options?.signal, tag: 'SKILL_DETAILS' })
      const row = rows[0]
      if (!row) return { value: null, ms }
      const meta = toSkillMeta(row)
      if (!meta) return { value: null, ms }
      const pair = (value: unknown) =>
        asObjectArray(value, 40)
          .map((entry) => ({ id: asString(entry.id, 72) ?? '', name: asString(entry.name, 200) ?? '' }))
          .filter((entry) => entry.id && entry.name)
      return {
        value: {
          ...meta,
          description: asString(row.description, 2000) ?? meta.summary ?? '',
          prerequisites: asObjectArray(row.prerequisites, 40)
            .map((entry) => ({
              id: asString(entry.id, 72) ?? '',
              name: asString(entry.name, 200) ?? '',
              ...(entry.strength !== undefined ? { strength: clamp(asNumber(entry.strength, 1), 0, 1) } : {}),
            }))
            .filter((entry) => entry.id && entry.name),
          unlocks: pair(row.unlocks),
          tools: pair(row.tools),
          languages: pair(row.languages),
          projects: pair(row.projects).map((p, index) => ({
            ...p,
            difficulty: isDifficulty(asObjectArray(row.projects, 40)[index]?.difficulty)
              ? (asObjectArray(row.projects, 40)[index]?.difficulty as Difficulty)
              : undefined,
          })),
          resources: asObjectArray(row.resources, 40)
            .map((entry) => ({
              id: asString(entry.id, 72) ?? '',
              name: asString(entry.name, 200) ?? '',
              provider: asString(entry.provider, 120) ?? undefined,
              url: (() => {
                const url = asString(entry.url, 2048) ?? ''
                return isHttpsUrl(url) ? url : undefined
              })(),
            }))
            .filter((entry) => entry.id && entry.name),
        },
        ms,
      }
    },

    async getSkillClosure(skillId, depth, limit, options) {
      const variant = skillPrereqClosure(depth)
      const { rows, ms } = await runQuery(variant.cypher, { skillId, limit: clampLimit(limit, 400, 200) }, { signal: options?.signal, tag: 'SKILL_PREREQ_CLOSURE' })
      return {
        value: rows.map(toSkillMeta).filter((s): s is SkillMetaRow => s !== null),
        ms,
        truncated: rows.length >= clampLimit(limit, 400, 200),
      }
    },

    async getDownstream(skillId, depth, options) {
      const variant = downstreamClosure(depth)
      const { rows, ms } = await runQuery(variant.cypher, { skillId }, { signal: options?.signal, tag: 'DOWNSTREAM_CLOSURE' })
      const row = rows[0] ?? {}
      return {
        value: {
          careers: asObjectArray(row.careers, 40)
            .map((c) => ({ id: asString(c.id, 72) ?? '', name: asString(c.name, 160) ?? '' }))
            .filter((c) => c.id && c.name),
          skills: asObjectArray(row.skills, 200)
            .map((s) => toSkillMeta({ id: s.id, name: s.name, difficulty: s.difficulty }))
            .filter((s): s is SkillMetaRow => s !== null),
        },
        ms,
      }
    },

    async getRoutes(careerId, fromSkillId, limit, options): Promise<ReadResult<RouteView[]>> {
      const capped = clampLimit(limit, 10, 5)
      const { rows, ms } = await runQuery(ROUTES_SKILL_TO_CAREER, { careerId, fromSkillId, limit: capped }, { signal: options?.signal, tag: 'ROUTES_SKILL_TO_CAREER' })
      const routes: RouteView[] = rows
        .map((row) => {
          const ids = asStringArray(row.ids, 12)
          const names = asStringArray(row.names, 12)
          if (ids.length === 0) return null
          return {
            ids,
            names: names.length === ids.length ? names : ids,
            difficulties: asStringArray(row.difficulties, 12).map((d) => (isDifficulty(d) ? d : undefined)),
            targetId: asString(row.targetId, 72) ?? ids[ids.length - 1],
            targetName: asString(row.targetName, 200) ?? '',
            hops: asNumber(row.hops, ids.length - 1),
          }
        })
        .filter((r): r is RouteView => r !== null)
      return { value: routes, ms }
    },

    async getNeighborhood(input: NeighborhoodInput, options): Promise<ReadResult<GraphNeighborhood>> {
      const started = Date.now()
      const limit = clampLimit(input.limit, 300, 120)
      const depth = Math.max(1, Math.min(input.depth ?? 1, 3))
      const labels = input.labels && input.labels.length > 0 ? input.labels : (['Career', 'EngineeringBranch', 'Subject', 'Concept', 'Skill', 'ProgrammingLanguage', 'Tool', 'Project', 'Resource'] as NodeLabel[])
      const relations = input.relations && input.relations.length > 0 ? input.relations : []

      let nodeRows: RawRow[] = []
      let selectionNote = ''

      if (input.seedId) {
        const seedLabel = labelForNodeId(input.seedId)
        if (!seedLabel) {
          return {
            value: { seedId: input.seedId, nodes: [], edges: [], truncated: false, selectionNote: 'That identifier does not match the graph id convention.' },
            ms: Date.now() - started,
          }
        }
        const variant = neighbourhoodQuery(seedLabel, depth)
        const result = await runQuery(
          variant.cypher,
          { seedId: input.seedId, labels, relations, difficulty: input.difficulty ?? '', limit },
          { signal: options?.signal, tag: 'NEIGHBOURHOOD' },
        )
        nodeRows = result.rows
        selectionNote = `${depth}-hop neighbourhood of ${input.seedId}, limited to ${limit} nodes.`
      } else if (input.careerId) {
        const result = await runQuery(CAREER_OVERVIEW_SUBGRAPH, { careerId: input.careerId, limit }, { signal: options?.signal, tag: 'CAREER_OVERVIEW_SUBGRAPH' })
        nodeRows = result.rows
        selectionNote = `Overview of ${input.careerId}: required skills with their tools, projects and resources, limited to ${limit} nodes.`
      } else {
        return {
          value: { seedId: null, nodes: [], edges: [], truncated: false, selectionNote: 'Provide a seed node or a career to load a subgraph.' },
          ms: Date.now() - started,
        }
      }

      const nodes = nodeRows.map((row) => toGraphNode(row)).filter((n): n is GraphNode => n !== null)
      const ids = nodes.map((n) => n.id).slice(0, limit)
      let edges: GraphEdge[] = []
      if (ids.length > 1) {
        const edgeVariant = edgesAmongIds(relations)
        const edgeResult = await runQuery(edgeVariant.cypher, { ids, relations: relations.length > 0 ? relations : [], limit: Math.min(limit * 2, 600) }, { signal: options?.signal, tag: 'EDGES_AMONG_IDS' })
        edges = edgeResult.rows.map(toGraphEdge).filter((e): e is GraphEdge => e !== null)
      }

      // Filter edges to the final node set (guarantees no dangling edge).
      const nodeIds = new Set(ids)
      const edgeRows = edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).map((edge) => ({
        from: edge.from,
        to: edge.to,
        type: edge.type,
        weight: edge.weight,
      }))
      const built = buildNeighborhood(
        nodeRows,
        edgeRows,
        { seedId: input.seedId ?? input.careerId ?? null, limit, selectionNote },
      )
      return {
        value: { seedId: input.seedId ?? input.careerId ?? null, ...built, selectionNote },
        ms: Date.now() - started,
        truncated: built.truncated || nodeRows.length >= limit,
      }
    },

    async getEdgesAmong(ids, relations, limit, options) {
      if (ids.length === 0) return { value: [], ms: 0 }
      const variant = edgesAmongIds(relations ?? [])
      const { rows, ms } = await runQuery(
        variant.cypher,
        { ids: ids.slice(0, 400), relations: (relations ?? []).slice(0, 16), limit: clampLimit(limit, 600, 300) },
        { signal: options?.signal, tag: 'EDGES_AMONG_IDS' },
      )
      return { value: rows.map(toGraphEdge).filter((e): e is GraphEdge => e !== null), ms }
    },

    async findProjects(query: ProjectQuery, options): Promise<ReadResult<ProjectView[]>> {
      const limit = clampLimit(query.limit, MAX_CATALOG_LIMIT, 8)
      if (query.skillIds && query.skillIds.length > 0) {
        const { rows, ms } = await runQuery(
          PROJECTS_FOR_SKILLS,
          { skillIds: query.skillIds.slice(0, 60), limit },
          { signal: options?.signal, tag: 'PROJECTS_FOR_SKILLS' },
        )
        const projects = rows.map(toProjectView).filter((p): p is ProjectView => p !== null)
        return { value: query.difficulty ? projects.filter((p) => p.difficulty === query.difficulty) : projects, ms }
      }
      if (query.careerId) {
        const { rows, ms } = await runQuery(PROJECTS_FOR_CAREER, { careerId: query.careerId, limit }, { signal: options?.signal, tag: 'PROJECTS_FOR_CAREER' })
        const projects = rows.map(toProjectView).filter((p): p is ProjectView => p !== null)
        return { value: query.difficulty ? projects.filter((p) => p.difficulty === query.difficulty) : projects, ms }
      }
      // No filter: return the catalogue (used by the Projects screen landing state).
      const { rows, ms } = await runQuery(PROJECTS_FOR_SKILLS, { skillIds: ['__none__'], limit }, { signal: options?.signal, tag: 'PROJECTS_FOR_SKILLS' })
      const projects = rows.map(toProjectView).filter((p): p is ProjectView => p !== null)
      return { value: query.difficulty ? projects.filter((p) => p.difficulty === query.difficulty) : projects, ms, truncated: true }
    },

    async findResources(query: ResourceQuery, options): Promise<ReadResult<ResourceView[]>> {
      const limit = clampLimit(query.limit, MAX_CATALOG_LIMIT, 20)
      if (query.skillIds && query.skillIds.length > 0) {
        const { rows, ms } = await runQuery(
          RESOURCES_FOR_SKILLS,
          { skillIds: query.skillIds.slice(0, 60), limit },
          { signal: options?.signal, tag: 'RESOURCES_FOR_SKILLS' },
        )
        return { value: rows.map(toResourceView).filter((r): r is ResourceView => r !== null), ms }
      }
      const { rows, ms } = await runQuery(
        RESOURCE_CATALOG,
        {
          q: normalizeText(query.q ?? '').slice(0, 80),
          format: query.format ?? '',
          accessModel: query.accessModel ?? '',
          difficulty: query.difficulty ?? '',
          limit,
          offset: 0,
        },
        { signal: options?.signal, tag: 'RESOURCE_CATALOG' },
      )
      return { value: rows.map(toResourceView).filter((r): r is ResourceView => r !== null), ms }
    },

    async getAssessments(skillIds, limit, options): Promise<ReadResult<AssessmentView[]>> {
      if (skillIds.length === 0) return { value: [], ms: 0 }
      const { rows, ms } = await runQuery(
        ASSESSMENTS_FOR_SKILLS,
        { ids: skillIds.slice(0, 60), limit: clampLimit(limit, 40, 12) },
        { signal: options?.signal, tag: 'ASSESSMENTS_FOR_SKILLS' },
      )
      const assessments: AssessmentView[] = []
      for (const row of rows) {
        const id = asString(row.id, 72)
        const name = asString(row.name, 200)
        const skillId = asString(row.skillId, 72)
        if (!id || !name || !skillId) continue
        const questions = decodeAssessmentQuestions(asStringArray(row.questions, 12))
        if (questions.length === 0) continue
        assessments.push({
          id,
          name,
          summary: asString(row.summary, 600) ?? '',
          skillId,
          difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'beginner',
          questions,
        })
      }
      return { value: assessments, ms }
    },

    async getModules(careerId, limit, options): Promise<ReadResult<ModuleView[]>> {
      const { rows, ms } = await runQuery(
        MODULES_FOR_CAREER,
        { careerId: careerId ?? '', limit: clampLimit(limit, 40, 12) },
        { signal: options?.signal, tag: 'MODULES_FOR_CAREER' },
      )
      return {
        value: rows
          .map((row) => ({
            id: asString(row.id, 72) ?? '',
            name: asString(row.name, 200) ?? '',
            summary: asString(row.summary, 800) ?? '',
            skillIds: asStringArray(row.skillIds, 40),
          }))
          .filter((m) => m.id && m.name),
        ms,
      }
    },
  }

  // Expose the raw query runner for the health check and the seed validator.
  return Object.assign(reader, { runQuery, config }) as GraphReader & { runQuery: typeof runQuery; config: Neo4jConfig }
}

/** Removes the password-free host for display; the URL may contain instance ids. */
export function redactHost(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host
  } catch {
    return 'configured-instance'
  }
}

/** Helper used by the health check to decide "graph empty" vs "graph missing". */
export function emptyGraphHint(): string {
  return [
    'The graph is reachable but contains no GraphMentor nodes.',
    'Load the curriculum with one of:',
    '  1) Neo4j Browser: paste the contents of neo4j/seed.cypher and run it.',
    '  2) Node script:  npm run seed:neo4j   (uses NEO4J_QUERY_URL + credentials)',
    'Both are idempotent: re-running them will not create duplicates.',
  ].join('\n')
}


