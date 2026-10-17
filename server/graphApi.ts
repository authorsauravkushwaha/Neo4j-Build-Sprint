/**
 * Repo-owned Graph API server.
 *
 * Graph backend selection is explicit and ordered: configured Neo4j via the
 * official driver, then an explicitly configured PostgreSQL graph store, then
 * no graph reader. Each API response carries the reader's actual provenance;
 * browser-bundled demo data is never returned as a live backend response.
 * Neo4j-backed results use the native Bolt driver and parameterised Cypher.
 */
import './denoShim.ts'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'

import {
  buildApiRequest,
  corsHeaders,
  finish,
  json,
  logError,
  methodNotAllowed,
  notFound,
  toErrorResponse,
  type ApiRequest,
  type HttpResponse,
} from '../supabase/functions/_shared/core/http.ts'
import { MemoryFixedWindowStore, MemoryNonceStore } from '../supabase/functions/_shared/core/rateLimit.ts'
import { assembleRuntime, readRuntimeConfig, type Runtime } from '../supabase/functions/_shared/runtime.ts'
import { healthCheckHandler } from '../supabase/functions/_shared/handlers/health.ts'
import { getCareerDetailsHandler, getCareerPathHandler, getCareersHandler } from '../supabase/functions/_shared/handlers/careers.ts'
import { getGraphHandler, getProjectsHandler, getResourcesHandler } from '../supabase/functions/_shared/handlers/graph.ts'
import { getSkillDetailsHandler } from '../supabase/functions/_shared/handlers/skills.ts'
import { getSkillsHandler } from '../supabase/functions/_shared/handlers/skillIndex.ts'
import { analyzeSkillGapsHandler, generateLearningRoadmapHandler } from '../supabase/functions/_shared/handlers/analysis.ts'
import { mentorChatHandler } from '../supabase/functions/_shared/handlers/mentor.ts'
import {
  manageAccountHandler,
  manageBookmarksHandler,
  saveRoadmapHandler,
  submitFeedbackHandler,
  updateProgressHandler,
} from '../supabase/functions/_shared/handlers/user.ts'
import { AppError } from '../supabase/functions/_shared/core/errors.ts'
import { createNeo4jDriverReader, resolveNeo4jUri, type DriverReader, type LedgerEvent } from './neo4jDriverReader.ts'
import { openGraphDatabase, seedGraphDatabase, type TransactionalGraphDatabase } from './graphStore.ts'
import { createPostgresGraphReader } from './graphReader.ts'

export async function describeGraphStore(db: TransactionalGraphDatabase | null): Promise<string> {
  if (!db) return 'no embedded postgres graph store'
  try {
    const r = await db.query('select value from graph.meta where key = $1', ['dataset_version'])
    const version = (r.rows[0]?.value as string) ?? 'unknown'
    return `postgres graph store (dataset v${version})`
  } catch {
    return 'postgres graph store'
  }
}

type RuntimeHandler = (runtime: Runtime, request: ApiRequest) => Promise<HttpResponse>

const ROUTES: Record<string, { handler: RuntimeHandler; methods: string[] }> = {
  'health-check': { handler: healthCheckHandler, methods: ['GET'] },
  'get-careers': { handler: getCareersHandler, methods: ['GET'] },
  'get-career-details': { handler: getCareerDetailsHandler, methods: ['GET'] },
  'get-career-path': { handler: getCareerPathHandler, methods: ['GET', 'POST'] },
  'get-graph': { handler: getGraphHandler, methods: ['GET', 'POST'] },
  'get-skill-details': { handler: getSkillDetailsHandler, methods: ['GET'] },
  'get-skills': { handler: getSkillsHandler, methods: ['GET'] },
  'get-projects': { handler: getProjectsHandler, methods: ['GET', 'POST'] },
  'get-resources': { handler: getResourcesHandler, methods: ['GET', 'POST'] },
  'analyze-skill-gaps': { handler: analyzeSkillGapsHandler, methods: ['POST'] },
  'generate-learning-roadmap': { handler: generateLearningRoadmapHandler, methods: ['POST'] },
  'mentor-chat': { handler: mentorChatHandler, methods: ['POST'] },
  'save-roadmap': { handler: saveRoadmapHandler, methods: ['POST'] },
  'update-progress': { handler: updateProgressHandler, methods: ['GET', 'POST'] },
  'manage-bookmarks': { handler: manageBookmarksHandler, methods: ['GET', 'POST'] },
  'submit-feedback': { handler: submitFeedbackHandler, methods: ['POST'] },
  'manage-account': { handler: manageAccountHandler, methods: ['POST'] },
}

export const GRAPH_API_PREFIX = '/functions/v1/'
export const REST_API_PREFIX = '/api/'

export function graphFunctionName(path: string): string | null {
  const match = /^\/functions\/v1\/([a-z0-9-]+)\/?$/.exec(path)
  return match ? (match[1] ?? null) : null
}
export function restRouteName(path: string): string | null {
  const match = /^\/api\/((?:graph|health|query|evidence|ledger)(?:\/[a-zA-Z0-9:_-]+)*)\/?$/.exec(path)
  return match ? (match[1] ?? null) : null
}
export function isGraphApiPath(path: string): boolean {
  return path === '/functions/v1' || path.startsWith(GRAPH_API_PREFIX) || path === '/api' || path.startsWith(REST_API_PREFIX)
}

/** In-memory ring buffer of the most recent ledger entries (read ledger). */
const LEDGER_LIMIT = 200
type LedgerEntry = {
  requestId: string
  timestamp: string
  queryId: string
  status: 'ok' | 'error' | 'connect'
  rowsReturned?: number
  executionMs?: number
  dbAvailableMs?: number
  dbConsumedMs?: number
  entities?: string[]
  servedBy: 'neo4j-live' | 'postgres-live' | 'unavailable'
  message?: string
}
const ledger: LedgerEntry[] = []
function recordLedger(entry: LedgerEntry) {
  ledger.unshift(entry)
  if (ledger.length > LEDGER_LIMIT) ledger.length = LEDGER_LIMIT
}

function toFetchRequest(request: IncomingMessage): Request {
  const host = request.headers.host ?? 'localhost'
  const url = `http://${host}${request.url ?? '/'}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  const method = (request.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers })
  const body = Readable.toWeb(request) as unknown as ReadableStream
  return new Request(url, { method, headers, body, duplex: 'half' } as RequestInit & { duplex: 'half' })
}

async function sendFetchResponse(response: ServerResponse, result: Response): Promise<void> {
  const headers: Record<string, string> = {}
  result.headers.forEach((value, key) => { headers[key] = value })
  const text = await result.text()
  response.writeHead(result.status, headers)
  response.end(text)
}

export interface GraphApiOptions {
  env?: NodeJS.ProcessEnv
  /** For tests. */
  neo4jReader?: DriverReader
  pgDb?: TransactionalGraphDatabase
  seed?: boolean
  reloadIntervalMs?: number
}

export interface GraphApi {
  readonly db: TransactionalGraphDatabase | null
  readonly driver: DriverReader | null
  matches(path: string): boolean
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  close(): Promise<void>
}

/**
 * Opens the graph reader in priority order:
 *   1) Neo4j (official driver) if NEO4J_URI or NEO4J_QUERY_URL credentials exist,
 *   2) PostgreSQL (PGlite / external) if explicitly configured,
 *   3) null reader (endpoints return not_configured, UI falls back to demo data).
 */
async function openReader(env: NodeJS.ProcessEnv, opts: GraphApiOptions): Promise<{
  reader: import('../supabase/functions/_shared/core/graphReader.ts').GraphReader | null
  reason: string | null
  setupHint?: string
  driver: DriverReader | null
  pgDb: TransactionalGraphDatabase | null
  kind: 'neo4j' | 'postgres' | 'none'
}> {
  // 1) Neo4j
  try {
    const resolved = resolveNeo4jUri(env)
    if (resolved) {
      const driver = opts.neo4jReader ?? await createNeo4jDriverReader({
        uri: resolved.uri,
        username: resolved.username,
        password: resolved.password,
        database: resolved.database,
        timeoutMs: Number(env.NEO4J_TIMEOUT_MS) || 8000,
        maxRows: Number(env.NEO4J_MAX_ROWS) || 400,
        onEvent: (event: LedgerEvent) => {
          if (event.type === 'query') {
            recordLedger({
              requestId: 'driver',
              timestamp: new Date().toISOString(),
              queryId: event.cypherTag ?? 'UNKNOWN',
              status: 'ok',
              rowsReturned: event.rows,
              executionMs: event.ms,
              dbAvailableMs: event.dbAvailableMs,
              dbConsumedMs: event.dbConsumedMs,
              servedBy: 'neo4j-live',
            })
          } else if (event.type === 'error') {
            recordLedger({
              requestId: 'driver',
              timestamp: new Date().toISOString(),
              queryId: event.cypherTag ?? 'UNKNOWN',
              status: 'error',
              executionMs: event.ms,
              servedBy: 'neo4j-live',
              message: event.message,
            })
          }
        },
      })
      return { reader: driver, reason: null, driver, pgDb: null, kind: 'neo4j' }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      reader: null,
      driver: null,
      pgDb: null,
      kind: 'none',
      reason: `Neo4j is configured but could not be reached: ${msg}. Graph endpoints will report unavailable.`,
      setupHint:
        'Set NEO4J_URI (neo4j+s://...), NEO4J_USERNAME and NEO4J_PASSWORD. ' +
        'The bundled demo dataset stays available in the browser, clearly labelled.',
    }
  }

  // 2) Postgres only when explicitly requested
  const pgEnv = env.GRAPH_DATABASE_URL || env.GM_GRAPH_DATABASE_DIR
  if (opts.pgDb || pgEnv) {
    try {
      const db = opts.pgDb ?? ((await openGraphDatabase(env)) as TransactionalGraphDatabase)
      if (opts.seed !== false) {
        const seed = await seedGraphDatabase(db)
        if (seed.seeded) console.log(`GraphMentor graph database ${seed.reason}.`)
      }
      const reader = createPostgresGraphReader(db, { reloadIntervalMs: opts.reloadIntervalMs })
      return { reader, reason: null, driver: null, pgDb: db, kind: 'postgres' }
    } catch (error) {
      return {
        reader: null, driver: null, pgDb: null, kind: 'none',
        reason: `Postgres graph store unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
      }
    }
  }

  return {
    reader: null, driver: null, pgDb: null, kind: 'none',
    reason: 'No NEO4J_* credentials are set and no Postgres graph store is configured. The UI runs on demo data.',
    setupHint:
      'Set NEO4J_URI (neo4j+s://<id>.databases.neo4j.io), NEO4J_USERNAME, NEO4J_PASSWORD (server-side only). ' +
      'Or see .env.example for the optional Postgres fallback.',
  }
}

export async function createGraphApi(options: GraphApiOptions = {}): Promise<GraphApi> {
  const env = options.env ?? process.env
  const opened = await openReader(env, options)
  const config = readRuntimeConfig((key) => env[key])
  // Override the runtime-config neo4j so that the existing `runtime.reader`
  // machinery doesn't try to construct a *second* HTTPS reader: the native
  // driver reader is the authoritative one here.
  config.neo4j = null
  config.neo4jIssue = opened.reason

  let runtime: Runtime
  if (opened.reader) {
    runtime = assembleRuntime({
      config,
      reader: opened.reader,
      readerReason: null,
      repos: null,
      rateLimit: new MemoryFixedWindowStore(),
      nonce: new MemoryNonceStore(),
    })
  } else {
    runtime = assembleRuntime({
      config,
      reader: null,
      readerReason: opened.reason ?? 'No graph database configured.',
      readerSetupHint: opened.setupHint,
      repos: null,
      rateLimit: new MemoryFixedWindowStore(),
      nonce: new MemoryNonceStore(),
    })
  }

  // Simple named-query allow-list for /api/query — never arbitrary Cypher.
  const safeId = (value: unknown): string => {
    const text = typeof value === 'string' ? value : ''
    return /^[a-zA-Z0-9:_-]{1,96}$/.test(text) ? text : ''
  }
  const safeLimit = (value: unknown, fallback: number, ceiling: number): number => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n), ceiling)) : fallback
  }
  const NAMED_QUERIES: Record<string, { cypher: (p: Record<string, unknown>) => string; params?: (p: Record<string, unknown>) => Record<string, unknown>; description: string }> = {
    'graph.stats': {
      description: 'Count of nodes returned by Neo4j.',
      cypher: () => 'MATCH (n) RETURN count(n) AS nodes',
      params: () => ({}),
    },
    'career.skills': {
      description: 'Skills a given career requires, by traversing REQUIRES_SKILL edges.',
      cypher: (_p) => 'MATCH (c:Career {id: $careerId})-[rs:REQUIRES_SKILL]->(s:Skill) RETURN s.id AS id, s.name AS name, s.difficulty AS difficulty, rs.essential AS essential, rs.weight AS weight ORDER BY essential DESC, s.name ASC LIMIT $limit',
      params: (p) => ({ careerId: safeId(p.careerId), limit: safeLimit(p.limit, 40, 200) }),
    },
    'skill.routes-to-career': {
      description: 'Shortest prerequisite paths from a skill to a skill a target career requires.',
      cypher: () => 'MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(target:Skill) MATCH p = shortestPath((start:Skill {id: $fromSkillId})-[:REQUIRES*0..6]->(target)) WHERE length(p) >= 1 RETURN [n IN nodes(p) | n.id] AS ids, [n IN nodes(p) | n.name] AS names, length(p) AS hops, target.id AS targetId, target.name AS targetName ORDER BY hops ASC LIMIT $limit',
      params: (p) => ({ careerId: safeId(p.careerId), fromSkillId: safeId(p.fromSkillId), limit: safeLimit(p.limit, 5, 20) }),
    },
    'skill.prerequisite-chain': {
      description: 'Recursive prerequisite chain for a skill up to N hops deep.',
      cypher: () => 'MATCH p=(s:Skill {id: $skillId})-[:REQUIRES*1..6]->(base:Skill) WHERE NOT (base)-[:REQUIRES]->(:Skill) RETURN [n IN nodes(p) | n.id] AS ids, [n IN nodes(p) | n.name] AS names, length(p) AS depth ORDER BY depth DESC LIMIT $limit',
      params: (p) => ({ skillId: safeId(p.skillId), limit: safeLimit(p.limit, 10, 50) }),
    },
    'career.resources-covering-required-skills': {
      description: 'Free resources that cover required skills for a career (multi-hop: Career→Skill←Resource).',
      cypher: () => 'MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(s:Skill)<-[:COVERS]-(r:Resource) RETURN r.id AS resourceId, r.name AS resource, r.accessModel AS accessModel, collect(DISTINCT s.id) AS coveredSkillIds, count(DISTINCT s) AS covers ORDER BY covers DESC, r.name ASC LIMIT $limit',
      params: (p) => ({ careerId: safeId(p.careerId), limit: safeLimit(p.limit, 20, 100) }),
    },
    'career.longest-prereq-chain': {
      description: 'Multi-hop traversal: longest prerequisite chain feeding each required skill.',
      cypher: () => 'MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(s:Skill) MATCH path = (s)-[:REQUIRES*1..6]->(base:Skill) WHERE NOT (base)-[:REQUIRES]->(:Skill) RETURN c.name AS career, s.name AS skill, length(path) AS depth, [n IN nodes(path) | n.name] AS chain ORDER BY depth DESC LIMIT $limit',
      params: (p) => ({ careerId: safeId(p.careerId), limit: safeLimit(p.limit, 10, 50) }),
    },
  }

  async function handleRest(request: ApiRequest): Promise<HttpResponse> {
    const path = (request.url.pathname ?? '').replace(/\/+$/, '')
    const method = request.method.toUpperCase()

    // GET /health — liveness.
    if (path === '/api/health' && method === 'GET') {
      return json(200, {
        ok: true,
        service: 'graphmentor-neo4j-backend',
        version: '1.1.0',
        time: new Date().toISOString(),
        graphBackend: opened.kind,
      })
    }

    // GET /health/neo4j — real connectivity status (fails honestly).
    if (path === '/api/health/neo4j' && method === 'GET') {
      if (opened.kind !== 'neo4j' || !opened.driver) {
        return json(503, {
          ok: false,
          connected: false,
          backend: opened.kind,
          reason: opened.reason ?? 'Neo4j is not configured.',
          hint: opened.setupHint,
          time: new Date().toISOString(),
        })
      }
      try {
        const start = Date.now()
        await opened.driver.runQuery('RETURN 1 AS ok, $pid AS connectedFrom', { pid: 'graphmentor-backend' }, 'HEALTH_PING')
        const nodesR = await opened.driver.totals()
        return json(200, {
          ok: true,
          connected: true,
          backend: 'neo4j',
          uri: opened.driver.uri.replace(/:\/\/[^@]+@/, '://<redacted>@'),
          database: (env.NEO4J_DATABASE ?? 'neo4j'),
          pingMs: Date.now() - start,
          nodes: nodesR.value.nodes,
          relationships: nodesR.value.relationships,
          labels: nodesR.value.labels,
          time: new Date().toISOString(),
        })
      } catch (error) {
        return json(503, {
          ok: false,
          connected: false,
          backend: 'neo4j',
          reason: 'Neo4j connectivity check failed; verify server-side credentials, network access, database name, and query timeout.',
          time: new Date().toISOString(),
        })
      }
    }

    // GET /api/graph/stats — live counts from Neo4j.
    if (path === '/api/graph/stats' && method === 'GET') {
      if (opened.kind !== 'neo4j' || !opened.driver) {
        return json(503, { ok: false, error: 'Neo4j unavailable', reason: opened.reason })
      }
      try {
        const totals = await opened.driver.totals()
        return json(200, { ok: true, source: 'neo4j-live', ...totals.value, queryMs: totals.ms, checkedAt: new Date().toISOString() })
      } catch {
        return json(503, { ok: false, error: 'neo4j_unavailable', reason: 'Neo4j statistics query failed.' })
      }
    }

    // POST /api/query — execute a named, allow-listed Cypher query.
    if (path === '/api/query' && method === 'POST') {
      let body: { queryId?: string; params?: Record<string, unknown> } = {}
      try { body = request.bodyText ? JSON.parse(request.bodyText) : {} } catch { body = {} }
      const qid = typeof body.queryId === 'string' ? body.queryId : ''
      const def = NAMED_QUERIES[qid]
      // Validate the query id BEFORE touching Neo4j so unknown ids always 400
      // even when the database is down — never silently 503 a malformed request.
      if (!def) {
        return json(400, { ok: false, error: 'unknown_query', allowedQueryIds: Object.keys(NAMED_QUERIES) })
      }
      if (opened.kind !== 'neo4j' || !opened.driver) {
        return json(503, { ok: false, error: 'Neo4j unavailable', reason: opened.reason })
      }
      const params = def.params ? def.params(body.params ?? {}) : {}
      const requestId = randomUUID()
      const started = Date.now()
      try {
        const result = await opened.driver.runQuery(def.cypher(params), params, `NAMED:${qid}`)
        const entry: LedgerEntry = {
          requestId,
          timestamp: new Date().toISOString(),
          queryId: qid,
          status: 'ok',
          rowsReturned: result.rows.length,
          executionMs: Date.now() - started,
          servedBy: 'neo4j-live',
          entities: result.rows.slice(0, 5).map((r) => String(r.id ?? r.career ?? r.skillId ?? r.resourceId ?? '')).filter(Boolean),
        }
        recordLedger(entry)
        return json(200, {
          ok: true,
          requestId,
          queryId: qid,
          description: def.description,
          cypher: def.cypher(params),
          params,
          records: result.rows,
          rowCount: result.rows.length,
          executionMs: entry.executionMs,
          servedBy: 'neo4j-live',
          evidence: {
            queryId: qid,
            executedAt: entry.timestamp,
            driver: 'neo4j-javascript-driver',
            database: env.NEO4J_DATABASE ?? 'neo4j',
          },
        })
      } catch (error) {
        recordLedger({
          requestId, timestamp: new Date().toISOString(), queryId: qid, status: 'error',
          executionMs: Date.now() - started, servedBy: 'neo4j-live',
          message: error instanceof Error ? error.message : 'Query failed',
        })
        return json(502, { ok: false, error: 'query_failed', requestId, message: 'The Neo4j query did not complete.' })
      }
    }

    // GET /api/graph/explore — bounded subgraph for visualisation.
    if (path === '/api/graph/explore' && method === 'GET') {
      if (opened.kind !== 'neo4j' || !opened.driver) {
        return json(503, { ok: false, error: 'Neo4j unavailable', reason: opened.reason })
      }
      const url = request.url
      const seedId = url.searchParams.get('seedId')
      const careerId = url.searchParams.get('careerId')
      const depth = Math.max(1, Math.min(Number(url.searchParams.get('depth') ?? 1), 3))
      const limit = Math.max(10, Math.min(Number(url.searchParams.get('limit') ?? 60), 200))
      const started = Date.now()
      const result = await opened.driver.getNeighborhood({
        seedId: seedId ?? undefined, careerId: careerId ?? undefined, depth, limit,
      })
      return json(200, { ok: true, source: 'neo4j-live', ...result.value, queryMs: result.ms, executionMs: Date.now() - started })
    }

    // GET /api/evidence/:id — retrieve evidence/provenance for an answer.
    const evidenceMatch = /^\/api\/evidence\/([a-zA-Z0-9:_-]+)$/.exec(path)
    if (evidenceMatch && method === 'GET') {
      const id = decodeURIComponent(evidenceMatch[1] ?? '')
      if (opened.kind !== 'neo4j' || !opened.driver) {
        return json(503, { ok: false, error: 'Neo4j unavailable', reason: opened.reason })
      }
      // Fetch up to one node of each known label with this id.
      const labels = ['Career','Skill','Project','Resource','Concept','Tool','Subject','EngineeringBranch','LearningModule','Assessment','ProgrammingLanguage']
      const evidence: Array<{ label: string; node: Record<string, unknown> | null; supportingEdges: Array<{ type: string; target: string }> }> = []
      for (const label of labels) {
        const cypher = `MATCH (n:\`${label}\` {id: $id}) OPTIONAL MATCH (n)-[r]->(m) RETURN n, collect(DISTINCT {type: type(r), target: m.id, targetName: m.name}) AS edges LIMIT 1`
        try {
          const r = await opened.driver.runQuery(cypher, { id }, `EVIDENCE:${label}`)
          const row = r.rows[0]
          if (row && row.n) {
            evidence.push({ label, node: row.n as Record<string, unknown>, supportingEdges: (row.edges as Array<{type:string;target:string}> ?? []) })
          }
        } catch {
          // skip label on error
        }
      }
      return json(200, { ok: true, id, source: 'neo4j-live', matches: evidence, retrievedAt: new Date().toISOString() })
    }

    // GET /api/ledger/recent — honest read ledger.
    if (path === '/api/ledger/recent' && method === 'GET') {
      return json(200, { ok: true, entries: ledger.slice(0, 50), totalRecorded: ledger.length, backend: opened.kind })
    }

    return notFound()
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?')[0] ?? ''
    const fn = graphFunctionName(path)
    const route = fn ? ROUTES[fn] : undefined

    let apiRequest: ApiRequest | null = null
    let cors: Record<string, string> | null = {}
    try {
      apiRequest = await buildApiRequest(toFetchRequest(request), {
        logLevel: config.logLevel,
        maxBodyBytes: config.limits.maxJsonBodyBytes,
      })
      // Tag request with an id for ledger correlation.
      const requestId = apiRequest.requestId
      apiRequest.logger = new Proxy(apiRequest.logger, {
        get(target, prop) { return (target as any)[prop] },
      })

      cors = corsHeaders(apiRequest.headers.get('origin'), { allowedOrigins: config.allowedOrigins }) ?? {}

      // Preflight is answered purely from configuration; never touches the graph.
      if (apiRequest.method === 'OPTIONS') {
        await sendFetchResponse(response, finish({ status: 204, body: null, headers: {} }, { cors }))
        return
      }

      // REST routes (/api/...) have their own small stack.
      const restName = restRouteName(path)
      if (restName) {
        const started = Date.now()
        const result = await handleRest(apiRequest)
        recordLedger({
          requestId,
          timestamp: new Date().toISOString(),
          queryId: `REST:${restName}`,
          status: result.status >= 500 ? 'error' : 'ok',
          executionMs: Date.now() - started,
          servedBy: opened.kind === 'neo4j' ? 'neo4j-live' : opened.kind === 'postgres' ? 'postgres-live' : 'unavailable',
        })
        await sendFetchResponse(response, finish(result, { cors }))
        return
      }

      if (!route) { await sendFetchResponse(response, finish(notFound(), { cors })); return }
      const m = (request.method ?? 'GET').toUpperCase()
      if (!route.methods.includes(m)) { await sendFetchResponse(response, finish(methodNotAllowed(route.methods), { cors })); return }

      const started = Date.now()
      const result = await route.handler(runtime, apiRequest)
      recordLedger({
        requestId,
        timestamp: new Date().toISOString(),
        queryId: fn ?? 'unknown',
        status: result.status >= 500 ? 'error' : 'ok',
        executionMs: Date.now() - started,
        servedBy: opened.kind === 'neo4j' ? 'neo4j-live' : opened.kind === 'postgres' ? 'postgres-live' : 'unavailable',
      })
      await sendFetchResponse(response, finish(result, { cors }))
    } catch (error) {
      if (!apiRequest) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: { code: 'internal', message: 'Unable to serve this request.' } }))
        return
      }
      logError(error, apiRequest)
      const appErr = error instanceof AppError ? error : new AppError('internal', { publicMessage: 'Unable to serve this request.' })
      await sendFetchResponse(response, toErrorResponse(appErr, { cors }))
    }
  }

  return {
    db: opened.pgDb,
    driver: opened.driver,
    matches(path: string) {
      return isGraphApiPath(path)
    },
    handle,
    async close() {
      if (opened.driver) await opened.driver.close().catch(() => {})
      if (opened.pgDb) await opened.pgDb.end().catch(() => {})
    },
  }
}

/** Public list of fixed, supported query IDs; Cypher text stays in the allow-list above. */
export const NAMED_QUERY_IDS = [
  'graph.stats',
  'career.skills',
  'skill.routes-to-career',
  'skill.prerequisite-chain',
  'career.resources-covering-required-skills',
  'career.longest-prereq-chain',
] as const
