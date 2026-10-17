/**
 * GraphReader backed by the official Neo4j JavaScript driver (Bolt / Bolt+S).
 *
 * This is the *server-side* reader used by the Node backend (`npm start`). It
 * exists alongside the HTTPS Query API reader
 * (`supabase/functions/_shared/core/neo4jReader.ts`), which is what runs on
 * Deno/Supabase Edge Functions where the native driver cannot be loaded. Both
 * readers execute the same parameterised Cypher catalogue in
 * `supabase/functions/_shared/core/graphQuery.ts`, so answers do not depend on
 * how the backend is hosted.
 *
 * Security / reliability decisions:
 *   - Only constant Cypher strings from the catalogue are executed. User-supplied
 *     values reach queries only as bound parameters.
 *   - The driver is created with max connection pool size and per-transaction
 *     timeouts; every session is closed in a `finally` block.
 *   - Read-only access mode is requested on every session so an accidentally
 *     mutating statement is rejected server-side.
 *   - Errors are mapped to AppError codes; upstream messages and stack traces
 *     never reach the browser.
 *   - Every executed query is reported to `onEvent` with its Cypher tag, duration
 *     and row count — the source of the read ledger.
 */
import neo4j, { Driver, Session } from 'neo4j-driver'
import type { Integer, Record as NeoRecord, ResultSummary, SessionConfig } from 'neo4j-driver'

import { AppError } from '../supabase/functions/_shared/core/errors.ts'
import type { GraphReader, ReadOptions, ReadResult } from '../supabase/functions/_shared/core/graphReader.ts'
import {
  CAREER_BRANCHES,
  CAREER_CATALOG,
  CAREER_DETAILS,
  CAREER_OVERVIEW_SUBGRAPH,
  CAREER_REQUIRED_SKILLS,
  CAREER_SEARCH,
  SKILL_INDEX,
  HEALTH_COUNTS,
  HEALTH_TOTAL,
  HEALTH_TOTAL_RELS,
  PROJECT_CATALOG,
  PROJECTS_FOR_CAREER,
  PROJECTS_FOR_SKILLS,
  RESOURCES_FOR_SKILLS,
  RESOURCES_FOR_SUBJECT,
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
} from '../supabase/functions/_shared/core/graphQuery.ts'
import { buildNeighborhood, isDifficulty, toGraphEdge, toGraphNode, type RawRow } from '../supabase/functions/_shared/core/graphModel.ts'
import { asBoolean, asHourRange, asNumber, asObjectArray, asString, asStringArray } from '../supabase/functions/_shared/core/rowParsers.ts'
import { decodeAssessmentQuestions } from '../supabase/functions/_shared/core/assessmentCodec.ts'
import { clamp, isHttpsUrl, normalizeText } from '../supabase/functions/_shared/core/normalize.ts'
import { clampLimit } from '../supabase/functions/_shared/core/graphReader.ts'
import { MAX_CATALOG_LIMIT } from '../supabase/functions/_shared/core/types.ts'
import type {
  AssessmentView,
  CareerSearchInput,
  CareerSkillRow,
  CareerSummary,
  GraphTotals,
  NeighborhoodInput,
  ProjectQuery,
  ProjectView,
  ResourceQuery,
  ResourceView,
  RouteView,
  SkillIndexRow,
  SkillMetaRow,
} from '../supabase/functions/_shared/core/graphReader.ts'
import type { Difficulty, GraphEdge, VerificationState } from '../supabase/functions/_shared/core/types.ts'

export interface Neo4jDriverConfig {
  /** Bolt URI, e.g. neo4j+s://xxxx.databases.neo4j.io (Aura) or bolt://localhost:7687. */
  uri: string
  username: string
  password: string
  database?: string
  /** Per-query transaction timeout, ms. */
  timeoutMs?: number
  maxRows?: number
  /** Per-session event listener, used to feed the read ledger. */
  onEvent?: (event: LedgerEvent) => void
}

export interface LedgerEvent {
  type: 'query' | 'connect' | 'error'
  /** Stable tag matching the constant name in graphQuery.ts (used as queryId). */
  cypherTag?: string
  ms?: number
  status?: number | string
  rows?: number
  /** Database-produced resultAvailableAfter / resultConsumedAfter when present. */
  dbAvailableMs?: number
  dbConsumedMs?: number
  message?: string
}

function toJs(value: unknown): unknown {
  if (value === null || value === undefined) return value
  // neo4j Integer -> number when safe; big fallbacks kept as string to avoid lies.
  if (neo4j.isInt(value)) {
    const i = value as Integer
    return i.inSafeRange() ? i.toNumber() : i.toString()
  }
  if (Array.isArray(value)) return value.map(toJs)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJs(v)
    return out
  }
  return value
}

function recordToRaw(rec: NeoRecord): RawRow {
  const row: RawRow = {}
  const keys = rec.keys as unknown as string[]
  for (const key of keys) row[key] = toJs(rec.get(key))
  return row
}

function redactUri(uri: string): string {
  try {
    const u = new URL(uri.replace(/^neo4j\+s:\/\//, 'https://').replace(/^neo4j:\/\//, 'http://').replace(/^bolt\+s:\/\//, 'https://').replace(/^bolt:\/\//, 'http://'))
    return `${u.protocol.replace('http', 'bolt')}//${u.host}`
  } catch {
    return 'configured-instance'
  }
}

export interface DriverReader extends GraphReader {
  driver: Driver
  /** Close the underlying driver (called at shutdown). */
  close(): Promise<void>
  /** Exposed for tests and the verification endpoint. */
  runQuery: (cypher: string, params: Record<string, unknown>, tag: string, options?: ReadOptions) => Promise<{ rows: RawRow[]; ms: number; summary: ResultSummary }>
  /**
   * The identity of the database this reader is actually talking to.
   *
   * `SHOW DATABASES` needs administrative rights, which some Aura instances
   * withhold from the application user, so a failure here is not an error: the
   * configured database name is reported instead, with a null status. The
   * point is that an operator can tell *which* database answered.
   */
  identity: () => Promise<{ name: string; status: string | null; address: string | null }>
  uri: string
}

export async function createNeo4jDriverReader(config: Neo4jDriverConfig): Promise<DriverReader> {
  const maxRows = Math.max(1, Math.min(config.maxRows ?? 400, 2000))
  const timeoutMs = Math.max(1000, Math.min(config.timeoutMs ?? 8000, 30_000))
  const database = config.database ?? 'neo4j'

  const driver: Driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
    connectionTimeout: timeoutMs,
    connectionAcquisitionTimeout: timeoutMs,
    maxConnectionPoolSize: 20,
    userAgent: 'GraphMentorAI/1.0 (node-backend)',
    logging: {
      level: 'warn',
      logger: (_level, message) => {
        // Never forward credentials; driver logs contain no secrets but we cap length.
        config.onEvent?.({ type: 'error', message: String(message).slice(0, 400) })
      },
    },
  })

  // Eagerly verify connectivity so construction fails fast if credentials are bad.
  const verifyStart = Date.now()
  try {
    await driver.verifyConnectivity({ database })
  } catch (error) {
    await driver.close().catch(() => {})
    throw new AppError('dependency_unavailable', {
      internal: `neo4j connectivity check failed: ${error instanceof Error ? error.message : 'unknown'}`,
    })
  }
  config.onEvent?.({ type: 'connect', cypherTag: 'VERIFY_CONNECTIVITY', ms: Date.now() - verifyStart, message: redactUri(config.uri) })

  async function runQuery(
    cypher: string,
    params: Record<string, unknown>,
    tag: string,
    options: ReadOptions = {},
  ): Promise<{ rows: RawRow[]; ms: number; summary: ResultSummary }> {
    if (options.signal?.aborted) {
      throw new AppError('timeout', { internal: 'neo4j query aborted' })
    }
    const started = Date.now()
    const safeParams: Record<string, unknown> = { limit: maxRows, ...params }
    const boundedLimit = Math.max(1, Math.min(Math.trunc(asNumber(safeParams.limit, maxRows) || maxRows), maxRows))
    safeParams.limit = neo4j.int(boundedLimit)
    if (typeof safeParams.offset === 'number' && Number.isFinite(safeParams.offset)) {
      safeParams.offset = neo4j.int(Math.max(0, Math.trunc(safeParams.offset)))
    }

    const sessionCfg: SessionConfig = {
      database,
      defaultAccessMode: (neo4j as unknown as { session: { READ: symbol } }).session.READ as unknown as SessionConfig['defaultAccessMode'],
      // Bookmarks / database are default; fetch size keeps big results streaming.
      fetchSize: 1000,
    }
    const session: Session = driver.session(sessionCfg)
    const onAbort = () => {
      session.close().catch(() => {})
    }
    options.signal?.addEventListener?.('abort', onAbort)
    let summary: ResultSummary | null = null
    try {
      const txConfig = { timeout: timeoutMs }
      const result = await session.run(cypher, safeParams, txConfig)
      const recs = await result.records
      summary = result.summary
      const rows = recs.slice(0, maxRows).map(recordToRaw)
      const ms = Date.now() - started
      const availableMs = summary.resultAvailableAfter ? Number(summary.resultAvailableAfter) : undefined
      const consumedMs = summary.resultConsumedAfter ? Number(summary.resultConsumedAfter) : undefined
      config.onEvent?.({
        type: 'query',
        cypherTag: tag,
        ms,
        rows: rows.length,
        dbAvailableMs: availableMs,
        dbConsumedMs: consumedMs,
      })
      return { rows, ms, summary }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown neo4j error'
      config.onEvent?.({ type: 'error', cypherTag: tag, message: message.slice(0, 240) })
      if (options.signal?.aborted) {
        throw new AppError('timeout', { internal: 'neo4j query aborted' })
      }
      if (/authentication|unauthorized/i.test(message)) {
        throw new AppError('dependency_unavailable', { internal: 'neo4j authentication failed' })
      }
      if (/timeout|timed out/i.test(message)) {
        throw new AppError('timeout', { internal: 'neo4j query timeout' })
      }
      throw new AppError('dependency_unavailable', { internal: `neo4j query failed: ${tag}` })
    } finally {
      options.signal?.removeEventListener?.('abort', onAbort)
      await session.close().catch(() => {})
    }
  }

  /* -------- Row converters (duplicated from the HTTPS reader — both produce  --------
   * the same RawRow shape so we can reuse the same converters. The drivers have   *
   * different transport layers but identical Cypher, so duplicating the mapping  *
   * keeps the two deployments independent: a Bun/Node host does not have to      *
   * bundle the Deno fetch reader, and vice versa.                                */

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
      id, name,
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
    return {
      id, name,
      summary: asString(row.summary, 800) ?? undefined,
      difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'beginner',
      estimatedHoursLow: asHourRange(row.estimatedHoursLow, row.estimatedHoursHigh)[0],
      estimatedHoursHigh: asHourRange(row.estimatedHoursLow, row.estimatedHoursHigh)[1],
      completionCriteria: asStringArray(row.completionCriteria, 12),
      practice: asStringArray(row.practice, 12),
    }
  }
  const toProjectView = (row: RawRow): ProjectView | null => {
    const id = asString(row.id, 72), name = asString(row.name, 200)
    if (!id || !name) return null
    return {
      id, name,
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
    const id = asString(row.id, 72), name = asString(row.name, 200)
    if (!id || !name) return null
    const url = asString(row.url, 2048) ?? ''
    return {
      id, name,
      summary: asString(row.summary, 800) ?? '',
      url: isHttpsUrl(url) ? url : '',
      provider: asString(row.provider, 120) ?? 'Unknown provider',
      format: asString(row.format, 32) ?? 'reference',
      difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'beginner',
      language: asString(row.language, 16) ?? 'en',
      accessModel: asString(row.accessModel, 32) ?? 'unknown',
      accessNote: asString(row.accessNote, 400) ?? '',
      outcomes: asStringArray(row.outcomes, 12),
      assumes: asString(row.assumes, 600) ?? '',
      limits: asString(row.limits, 600) ?? '',
      commitment: asString(row.commitment, 240) ?? '',
      estimatedHours: asHourRange(row.estimatedHoursLow, row.estimatedHoursHigh),
      assumesIds: asStringArray(row.assumesIds, 24),
      assumesNames: asStringArray(row.assumesNames, 24),
      lastVerified: asString(row.lastVerified, 32) ?? null,
      verification: (asString(row.verification, 24) ?? 'unverified') as VerificationState,
      coversIds: asStringArray(row.coversIds ?? row.skillIds, 40),
      coversNames: asStringArray(row.coversNames, 40),
      matchedSkillIds: asStringArray(row.matchedSkills ?? row.skillIds, 40),
    }
  }

  const dedupeSkills = (skills: SkillMetaRow[]): SkillMetaRow[] => {
    const seen = new Set<string>()
    const out: SkillMetaRow[] = []
    for (const skill of skills) {
      if (seen.has(skill.id)) continue
      seen.add(skill.id)
      out.push(skill)
    }
    return out
  }

  const filterResource = (resource: ResourceView, query: ResourceQuery): boolean => {
    if (query.format && resource.format !== query.format) return false
    if (query.accessModel && resource.accessModel !== query.accessModel) return false
    if (query.difficulty && resource.difficulty !== query.difficulty) return false
    const q = normalizeText(query.q ?? '').slice(0, 80)
    if (q) {
      const hay = normalizeText(
        [resource.name, resource.summary, resource.provider, resource.assumes, resource.limits, ...resource.outcomes].join(' '),
      )
      if (!hay.includes(q)) return false
    }
    return true
  }

  const reader: GraphReader = {
    kind: 'neo4j',
    configured: true,
    provenance: `Neo4j (${redactUri(config.uri)}), database "${database}" — official driver, Cypher executed server-side.`,

    async totals(options?: ReadOptions): Promise<ReadResult<GraphTotals>> {
      const started = Date.now()
      const [labelsR, totalsR, relsR] = await Promise.all([
        runQuery(HEALTH_COUNTS, {}, 'HEALTH_COUNTS', options),
        runQuery(HEALTH_TOTAL, {}, 'HEALTH_TOTAL', options),
        runQuery(HEALTH_TOTAL_RELS, {}, 'HEALTH_TOTAL_RELS', options),
      ])
      const labels = labelsR.rows
        .map((r) => ({ label: asString(r.label, 64) ?? '', count: asNumber(r.total, 0) }))
        .filter((r) => r.label && r.count > 0)
        .sort((a, b) => a.label.localeCompare(b.label))
      return {
        value: {
          nodes: asNumber(totalsR.rows[0]?.nodes, 0),
          relationships: asNumber(relsR.rows[0]?.relationships, 0),
          labels,
        },
        ms: Date.now() - started,
      }
    },

    async listSkillIndex(input, options) {
      const limit = clampLimit(input.limit, 400, 120)
      const query = normalizeText(input.q ?? '')
      const { rows, ms } = await runQuery(SKILL_INDEX, { limit: query ? 400 : limit }, 'SKILL_INDEX', options)
      const parsed: SkillIndexRow[] = rows
        .map((row) => {
          const id = asString(row.id), name = asString(row.name)
          if (!id || !name) return null
          const label = asString(row.label)
          return {
            id, name,
            kind: (label === 'Concept' ? 'Concept' : 'Skill') as 'Skill' | 'Concept',
            difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'intermediate',
            ...(asString(row.parentName) ? { parentName: asString(row.parentName)! } : {}),
          }
        })
        .filter((r): r is SkillIndexRow => r !== null)
      const filtered = query ? parsed.filter((r) => normalizeText(`${r.name} ${r.parentName ?? ''} ${r.id}`).includes(query)) : parsed
      return { value: filtered.slice(0, limit), ms }
    },

    async listCareers(limit, options) {
      const { rows, ms } = await runQuery(CAREER_CATALOG, { limit: clampLimit(limit, 200, 60) }, 'CAREER_CATALOG', options)
      return { value: rows.map(toCareerSummary).filter((c): c is CareerSummary => c !== null), ms }
    },

    async searchCareers(input: CareerSearchInput, options) {
      const q = normalizeText(input.q ?? '').slice(0, 80)
      const { rows, ms } = await runQuery(CAREER_SEARCH, {
        q, branchId: input.branchId ?? '', difficulty: input.difficulty ?? '',
        limit: clampLimit(input.limit, 60, 24), offset: Math.max(0, Math.trunc(input.offset ?? 0)),
      }, 'CAREER_SEARCH', options)
      return { value: rows.map(toCareerSummary).filter((c): c is CareerSummary => c !== null), ms }
    },

    async listBranches(limit, options) {
      const { rows, ms } = await runQuery(CAREER_BRANCHES, { limit: clampLimit(limit, 80, 40) }, 'CAREER_BRANCHES', options)
      return {
        value: rows.map((r) => ({
          id: asString(r.id, 72) ?? '', name: asString(r.name, 160) ?? '',
          summary: asString(r.summary, 800) ?? '', careerCount: asNumber(r.careerCount, 0),
        })).filter((r) => r.id && r.name),
        ms,
      }
    },

    async getCareer(careerId, options) {
      const { rows, ms } = await runQuery(CAREER_DETAILS, { careerId }, 'CAREER_DETAILS', options)
      const row = rows[0]
      if (!row) return { value: null, ms }
      const summary = toCareerSummary(row)
      if (!summary) return { value: null, ms }
      const skills = asObjectArray(row.skills, 120)
        .map((e) => toSkillRow({ id: e.id, name: e.name, summary: e.summary, difficulty: e.difficulty, essential: e.essential, weight: e.weight }))
        .filter((s): s is CareerSkillRow => s !== null)
        .sort((a, b) => Number(b.essential) - Number(a.essential) || a.name.localeCompare(b.name))
      const pair = (v: unknown) => asObjectArray(v, 40).map((b) => ({ id: asString(b.id, 72) ?? '', name: asString(b.name, 160) ?? '' })).filter((b) => b.id && b.name)
      return {
        value: {
          ...summary,
          description: asString(row.description, 4000) ?? summary.summary,
          responsibilities: asStringArray(row.responsibilities, 12),
          portfolioIdeas: asStringArray(row.portfolioIdeas, 12),
          assumptions: asStringArray(row.assumptions, 12),
          typicalRoles: asStringArray(row.typicalRoles, 12),
          branches: pair(row.branches), skills, related: pair(row.related),
          projects: asObjectArray(row.projects, 24).map((p) => ({
            id: asString(p.id, 72) ?? '', name: asString(p.name, 200) ?? '',
            difficulty: isDifficulty(p.difficulty) ? (p.difficulty as Difficulty) : undefined,
          })).filter((p) => p.id && p.name),
        },
        ms,
      }
    },

    async getCareerSkills(careerId, options) {
      const { rows, ms } = await runQuery(CAREER_REQUIRED_SKILLS, { careerId, limit: maxRows }, 'CAREER_REQUIRED_SKILLS', options)
      return { value: rows.map(toSkillRow).filter((s): s is CareerSkillRow => s !== null), ms }
    },

    async getCareerClosure(careerId, depth, limit, options) {
      const capped = clampLimit(limit, 400, 200)
      const v = careerPrereqClosure(depth)
      const { rows, ms } = await runQuery(v.cypher, { careerId, limit: capped }, 'CAREER_PREREQ_CLOSURE', options)
      return {
        value: dedupeSkills(rows.map(toSkillMeta).filter((s): s is SkillMetaRow => s !== null)),
        ms,
        truncated: rows.length >= capped,
      }
    },

    async getSkillEdges(ids, limit, options) {
      if (ids.length === 0) return { value: [], ms: 0 }
      const { rows, ms } = await runQuery(SKILL_EDGES_BY_IDS, { ids: ids.slice(0, 400), limit: clampLimit(limit, 600, 400) }, 'SKILL_EDGES_BY_IDS', options)
      return { value: rows.map(toGraphEdge).filter((e): e is GraphEdge => e !== null), ms, truncated: rows.length >= clampLimit(limit, 600, 400) }
    },

    async getSkill(skillId, options) {
      const { rows, ms } = await runQuery(SKILL_DETAILS, { skillId }, 'SKILL_DETAILS', options)
      const row = rows[0]
      if (!row) return { value: null, ms }
      const meta = toSkillMeta(row)
      if (!meta) return { value: null, ms }
      const pair = (v: unknown) => asObjectArray(v, 40).map((e) => ({ id: asString(e.id, 72) ?? '', name: asString(e.name, 200) ?? '' })).filter((e) => e.id && e.name)
      const projectsArr = asObjectArray(row.projects, 40)
      return {
        value: {
          ...meta,
          description: asString(row.description, 2000) ?? meta.summary ?? '',
          prerequisites: asObjectArray(row.prerequisites, 40).map((e) => ({
            id: asString(e.id, 72) ?? '', name: asString(e.name, 200) ?? '',
            ...(e.strength !== undefined && e.strength !== null ? { strength: clamp(asNumber(e.strength, 1), 0, 1) } : {}),
          })).filter((e) => e.id && e.name),
          unlocks: pair(row.unlocks), tools: pair(row.tools), languages: pair(row.languages),
          projects: projectsArr.map((p) => ({
            id: asString(p.id, 72) ?? '', name: asString(p.name, 200) ?? '',
            ...(isDifficulty(p.difficulty) ? { difficulty: p.difficulty as Difficulty } : {}),
          })).filter((p) => p.id && p.name),
          resources: asObjectArray(row.resources, 40).map((e) => ({
            id: asString(e.id, 72) ?? '', name: asString(e.name, 200) ?? '',
            provider: asString(e.provider, 120) ?? undefined,
            url: (() => { const u = asString(e.url, 2048) ?? ''; return isHttpsUrl(u) ? u : undefined })(),
          })).filter((e) => e.id && e.name),
        },
        ms,
      }
    },

    async getSkillClosure(skillId, depth, limit, options) {
      const capped = clampLimit(limit, 400, 200)
      const v = skillPrereqClosure(depth)
      const { rows, ms } = await runQuery(v.cypher, { skillId, limit: capped }, 'SKILL_PREREQ_CLOSURE', options)
      return {
        value: dedupeSkills(rows.map(toSkillMeta).filter((s): s is SkillMetaRow => s !== null)),
        ms,
        truncated: rows.length >= capped,
      }
    },

    async getDownstream(skillId, depth, options) {
      const v = downstreamClosure(depth)
      const { rows, ms } = await runQuery(v.cypher, { skillId }, 'DOWNSTREAM_CLOSURE', options)
      const row = rows[0] ?? {}
      return {
        value: {
          careers: asObjectArray(row.careers, 40).map((c) => ({ id: asString(c.id, 72) ?? '', name: asString(c.name, 160) ?? '' })).filter((c) => c.id && c.name),
          skills: dedupeSkills(asObjectArray(row.skills, 200).map((s) => toSkillMeta(s)).filter((s): s is SkillMetaRow => s !== null)),
        },
        ms,
      }
    },

    async getRoutes(careerId, fromSkillId, limit, options) {
      const capped = clampLimit(limit, 10, 5)
      const { rows, ms } = await runQuery(ROUTES_SKILL_TO_CAREER, { careerId, fromSkillId, limit: capped }, 'ROUTES_SKILL_TO_CAREER', options)
      const routes: RouteView[] = rows.map((r) => {
        const ids = asStringArray(r.ids, 12), names = asStringArray(r.names, 12)
        if (ids.length === 0) return null
        return {
          ids, names: names.length === ids.length ? names : ids,
          difficulties: asStringArray(r.difficulties, 12).map((d) => (isDifficulty(d) ? d : undefined)),
          targetId: asString(r.targetId, 72) ?? ids[ids.length - 1],
          targetName: asString(r.targetName, 200) ?? '',
          hops: asNumber(r.hops, ids.length - 1),
        }
      }).filter((r): r is RouteView => r !== null)
      return { value: routes, ms }
    },

    async getNeighborhood(input: NeighborhoodInput, options) {
      const started = Date.now()
      const limit = clampLimit(input.limit, 300, 120)
      const depth = Math.max(1, Math.min(input.depth ?? 1, 3))
      const labels = (input.labels && input.labels.length > 0 ? input.labels : ['Career','EngineeringBranch','Subject','Concept','Skill','ProgrammingLanguage','Tool','Project','Resource']) as string[]
      const relations = (input.relations && input.relations.length > 0 ? input.relations : []) as string[]
      let nodeRows: RawRow[] = []
      let selectionNote = ''
      if (input.seedId) {
        const seedLabel = labelForNodeId(input.seedId)
        if (!seedLabel) {
          return { value: { seedId: input.seedId, nodes: [], edges: [], truncated: false, selectionNote: 'That identifier does not match the graph id convention.' }, ms: Date.now() - started }
        }
        const variant = neighbourhoodQuery(seedLabel, depth)
        const r = await runQuery(variant.cypher, { seedId: input.seedId, labels, relations, difficulty: input.difficulty ?? '', limit: limit + 1 }, 'NEIGHBOURHOOD', options)
        nodeRows = r.rows
        selectionNote = `${depth}-hop neighbourhood of ${input.seedId}, limited to ${limit} nodes.`
      } else if (input.careerId) {
        const r = await runQuery(CAREER_OVERVIEW_SUBGRAPH, { careerId: input.careerId, limit: limit + 1 }, 'CAREER_OVERVIEW_SUBGRAPH', options)
        nodeRows = r.rows
        selectionNote = `Overview of ${input.careerId}: required skills with their tools, projects and resources, limited to ${limit} nodes.`
      } else {
        return { value: { seedId: null, nodes: [], edges: [], truncated: false, selectionNote: 'Provide a seed node or a career to load a subgraph.' }, ms: Date.now() - started }
      }
      const nodes = nodeRows.map((r) => toGraphNode(r)).filter((n): n is import('../supabase/functions/_shared/core/types.ts').GraphNode => n !== null)
      const ids = nodes.map((n) => n.id).slice(0, limit)
      let edges: GraphEdge[] = []
      if (ids.length > 1) {
        const variant = edgesAmongIds(relations)
        const er = await runQuery(variant.cypher, { ids, relations: relations.length > 0 ? relations : [], limit: Math.min(limit * 2, 600) }, 'EDGES_AMONG_IDS', options)
        edges = er.rows.map(toGraphEdge).filter((e): e is GraphEdge => e !== null)
      }
      const nodeIds = new Set(ids)
      const edgeRows = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)).map((e) => ({ from: e.from, to: e.to, type: e.type, weight: e.weight }))
      const built = buildNeighborhood(nodeRows, edgeRows, { seedId: input.seedId ?? input.careerId ?? null, limit, selectionNote })
      return { value: { seedId: input.seedId ?? input.careerId ?? null, ...built, selectionNote }, ms: Date.now() - started, truncated: (built as any).truncated || nodeRows.length > limit }
    },

    async getEdgesAmong(ids, relations, limit, options) {
      if (ids.length === 0) return { value: [], ms: 0 }
      const variant = edgesAmongIds(relations ?? [])
      const { rows, ms } = await runQuery(variant.cypher, { ids: ids.slice(0, 400), relations: (relations ?? []).slice(0, 16), limit: clampLimit(limit, 600, 300) }, 'EDGES_AMONG_IDS', options)
      return { value: rows.map(toGraphEdge).filter((e): e is GraphEdge => e !== null), ms }
    },

    async findProjects(query: ProjectQuery, options) {
      const limit = clampLimit(query.limit, MAX_CATALOG_LIMIT, 8)
      const fetchLimit = query.difficulty ? MAX_CATALOG_LIMIT : limit
      if (query.skillIds && query.skillIds.length > 0) {
        const { rows, ms } = await runQuery(PROJECTS_FOR_SKILLS, { skillIds: query.skillIds.slice(0, 60), limit: fetchLimit }, 'PROJECTS_FOR_SKILLS', options)
        const projects = rows.map(toProjectView).filter((p): p is ProjectView => p !== null)
        const filtered = query.difficulty ? projects.filter((p) => p.difficulty === query.difficulty) : projects
        return { value: filtered.slice(0, limit), ms }
      }
      if (query.careerId) {
        const { rows, ms } = await runQuery(PROJECTS_FOR_CAREER, { careerId: query.careerId, limit: fetchLimit }, 'PROJECTS_FOR_CAREER', options)
        const projects = rows.map(toProjectView).filter((p): p is ProjectView => p !== null)
        const filtered = query.difficulty ? projects.filter((p) => p.difficulty === query.difficulty) : projects
        return { value: filtered.slice(0, limit), ms }
      }
      const { rows, ms } = await runQuery(PROJECT_CATALOG, { difficulty: query.difficulty ?? '', limit }, 'PROJECT_CATALOG', options)
      return { value: rows.map(toProjectView).filter((p): p is ProjectView => p !== null), ms }
    },

    async findResources(query: ResourceQuery, options) {
      const limit = clampLimit(query.limit, MAX_CATALOG_LIMIT, 20)
      const hasExtraFilters = Boolean(query.q || query.format || query.accessModel || query.difficulty)
      if (query.skillIds && query.skillIds.length > 0) {
        const { rows, ms } = await runQuery(RESOURCES_FOR_SKILLS, { skillIds: query.skillIds.slice(0, 60), limit: hasExtraFilters ? MAX_CATALOG_LIMIT : limit }, 'RESOURCES_FOR_SKILLS', options)
        const parsed = rows.map(toResourceView).filter((r): r is ResourceView => r !== null)
        const filtered = hasExtraFilters ? parsed.filter((r) => filterResource(r, query)) : parsed
        return { value: filtered.slice(0, limit), ms }
      }
      if (query.subjectId) {
        const { rows, ms } = await runQuery(RESOURCES_FOR_SUBJECT, { subjectId: query.subjectId, limit: hasExtraFilters ? MAX_CATALOG_LIMIT : limit }, 'RESOURCES_FOR_SUBJECT', options)
        const parsed = rows.map(toResourceView).filter((r): r is ResourceView => r !== null)
        const filtered = hasExtraFilters ? parsed.filter((r) => filterResource(r, query)) : parsed
        return { value: filtered.slice(0, limit), ms }
      }
      const { rows, ms } = await runQuery(RESOURCE_CATALOG, {
        q: normalizeText(query.q ?? '').slice(0, 80),
        format: query.format ?? '', accessModel: query.accessModel ?? '', difficulty: query.difficulty ?? '',
        limit, offset: 0,
      }, 'RESOURCE_CATALOG', options)
      return { value: rows.map(toResourceView).filter((r): r is ResourceView => r !== null), ms }
    },

    async getAssessments(skillIds, limit, options) {
      if (skillIds.length === 0) return { value: [], ms: 0 }
      const { rows, ms } = await runQuery(ASSESSMENTS_FOR_SKILLS, { ids: skillIds.slice(0, 60), limit: clampLimit(limit, 40, 12) }, 'ASSESSMENTS_FOR_SKILLS', options)
      const out: AssessmentView[] = []
      for (const row of rows) {
        const id = asString(row.id, 72), name = asString(row.name, 200), skillId = asString(row.skillId, 72)
        if (!id || !name || !skillId) continue
        const questions = decodeAssessmentQuestions(asStringArray(row.questions, 12))
        if (questions.length === 0) continue
        out.push({ id, name, summary: asString(row.summary, 600) ?? '', skillId, difficulty: isDifficulty(row.difficulty) ? row.difficulty : 'beginner', questions })
      }
      return { value: out, ms }
    },

    async getModules(careerId, limit, options) {
      const { rows, ms } = await runQuery(MODULES_FOR_CAREER, { careerId: careerId ?? '', limit: clampLimit(limit, 40, 12) }, 'MODULES_FOR_CAREER', options)
      return {
        value: rows.map((r) => ({
          id: asString(r.id, 72) ?? '', name: asString(r.name, 200) ?? '',
          summary: asString(r.summary, 800) ?? '', skillIds: asStringArray(r.skillIds, 40),
        })).filter((m) => m.id && m.name),
        ms,
      }
    },
  }

  return Object.assign(reader, {
    driver,
    close: async () => driver.close(),
    runQuery,
    uri: config.uri,
    /**
     * Which database answered. `SHOW DATABASES` is attempted first because it
     * proves the identity from the server rather than from our configuration;
     * when the account may not list databases, the configured name is reported
     * with a null status rather than a guess.
     */
    async identity() {
      try {
        const result = await runQuery(
          'SHOW DATABASES YIELD name, currentStatus, address WHERE name = $name RETURN name AS name, currentStatus AS status, address AS address',
          { name: database },
          'SHOW_DATABASES',
        )
        const row = result.rows[0]
        if (row?.name) {
          return {
            name: asString(row.name, 72) ?? database,
            status: asString(row.status, 32) ?? null,
            address: asString(row.address, 200) ?? null,
          }
        }
      } catch {
        // Fall through to the configured identity below.
      }
      return { name: database, status: null, address: null }
    },
  }) as DriverReader
}

/**
 * Resolve which Neo4j URI to use, given the process environment. Accepts the
 * Bolt URI preferred by the native driver, and falls back to synthesising one
 * from the HTTPS Query API URL used by the Deno/Supabase deployment, so the
 * same environment variables work in both places.
 */
export function resolveNeo4jUri(env: Record<string, string | undefined>): { uri: string; username: string; password: string; database: string } | null {
  const username = (env.NEO4J_USERNAME ?? env.NEO4J_USER ?? 'neo4j').trim() || 'neo4j'
  const password = env.NEO4J_PASSWORD ?? ''
  const database = (env.NEO4J_DATABASE ?? 'neo4j').trim() || 'neo4j'
  const boltUri = (env.NEO4J_URI ?? env.NEO4J_BOLT_URI ?? '').trim()
  const queryUrl = (env.NEO4J_QUERY_URL ?? '').trim()

  if (!boltUri && !queryUrl && !password) {
    return null
  }
  if (!boltUri && !queryUrl) {
    throw new AppError('dependency_unavailable', { internal: 'NEO4J_PASSWORD is set, but neither NEO4J_URI nor NEO4J_QUERY_URL is configured.' })
  }
  if (!password) {
    throw new AppError('dependency_unavailable', { internal: 'NEO4J_URI or NEO4J_QUERY_URL is set, but NEO4J_PASSWORD is missing.' })
  }

  if (boltUri) {
    if (!/^(neo4j(\+s|\+ssc)?|bolt(\+s|\+ssc)?):\/\//i.test(boltUri)) {
      throw new AppError('internal', { internal: 'NEO4J_URI must start with neo4j://, neo4j+s://, neo4j+ssc://, bolt://, bolt+s://, or bolt+ssc://' })
    }
    if (/\/\/[^/@]+@/.test(boltUri)) {
      throw new AppError('internal', { internal: 'NEO4J_URI must not embed credentials; pass NEO4J_USERNAME and NEO4J_PASSWORD separately.' })
    }
    return { uri: boltUri, username, password, database }
  }

  // Fall back: synthesise a neo4j+s:// URI from the Query API host.
  try {
    const u = new URL(queryUrl)
    if (u.protocol === 'https:' && u.host && !u.username && !u.password) {
      return { uri: `neo4j+s://${u.host}`, username, password, database }
    }
  } catch {
    /* handled below */
  }
  throw new AppError('internal', { internal: 'NEO4J_QUERY_URL must be a valid https:// URL without embedded credentials.' })
}
