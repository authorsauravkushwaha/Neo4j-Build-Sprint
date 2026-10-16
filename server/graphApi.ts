/**
 * The repo-owned graph API — the third way to run GraphMentor with a database,
 * next to "Supabase Edge Functions + Neo4j" and "no backend (sample mode)".
 *
 * It serves the SAME endpoints the Supabase Edge Functions serve, at the SAME
 * paths (`/functions/v1/<name>`), through the SAME shared handlers
 * (`supabase/functions/_shared/handlers/*`). What differs is only the graph
 * reader: instead of a Neo4j HTTPS Query API it uses the deployment's own
 * PostgreSQL database (`server/graphStore.ts` + `server/graphReader.ts`) —
 * embedded on disk by default, so a free Node host with one persistent disk
 * runs the whole app against a real database with zero third-party accounts.
 *
 * Mount it next to the static site (see `server/website.ts`), build the
 * frontend with `VITE_API_BASE_URL=/functions/v1` (same-origin) or with the
 * absolute URL of this service (cross-origin; set ALLOWED_ORIGINS to your
 * site's origin), and the app runs in live mode — banner included, honestly
 * labelled `postgres-live`.
 *
 * Security posture, briefly:
 *   - everything is exactly the Edge Function request pipeline (`buildApiRequest`
 *     body caps/content-type, CORS allow-list, security headers, error mapping);
 *   - read endpoints are public and rate-limited in-memory (single instance —
 *     the same ceiling the Deno isolate map provides);
 *   - write endpoints answer honestly with `not_configured`/`unauthorized`
 *     here, because accounts on this deployment are the project's own
 *     `/api/auth` system, which the website server mounts separately;
 *   - the graph content is the public curriculum; the role behind
 *     GRAPH_DATABASE_URL needs no other grants than the `graph` schema.
 */
import './denoShim.ts'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import {
  buildApiRequest,
  corsHeaders,
  finish,
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
import { graphCounts, openGraphDatabase, seedGraphDatabase, type TransactionalGraphDatabase } from './graphStore.ts'
import { createPostgresGraphReader } from './graphReader.ts'

/** Same handler shape the Deno shims use: assembled runtime first, request second. */
type RuntimeHandler = (runtime: Runtime, request: ApiRequest) => Promise<HttpResponse>

/**
 * The full Edge Function surface. Read/analysis endpoints work against this
 * deployment's database; write endpoints are mounted on purpose too — they
 * answer the same honest auth/not-configured errors as a Supabase deployment
 * without storage secrets, rather than a 404 that would look like a bug.
 */
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
  // `auth-guard` is deliberately absent: it fronts Supabase-auth attempts, and
  // this deployment's accounts are the project's own `/api/auth` server, which
  // rate-limits itself (see server/server.ts).
}

export const GRAPH_API_PREFIX = '/functions/v1/'

/** The function name a path addresses, or null when the path is not ours. */
export function graphFunctionName(path: string): string | null {
  const match = /^\/functions\/v1\/([a-z0-9-]+)\/?$/.exec(path)
  return match ? (match[1] ?? null) : null
}

export function isGraphApiPath(path: string): boolean {
  return path === '/functions/v1' || path.startsWith(GRAPH_API_PREFIX)
}

/** IncomingMessage -> Fetch Request (Node 20+: WHATWG streams + duplex). */
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
  // `duplex: half` is required by undici when a stream body is supplied; the
  // Fetch type used by tsc predates it.
  return new Request(url, { method, headers, body, duplex: 'half' } as RequestInit & { duplex: 'half' })
}

async function sendFetchResponse(response: ServerResponse, result: Response): Promise<void> {
  const headers: Record<string, string> = {}
  result.headers.forEach((value, key) => {
    headers[key] = value
  })
  const text = await result.text()
  response.writeHead(result.status, headers)
  response.end(text)
}

export interface GraphApiOptions {
  env?: NodeJS.ProcessEnv
  /** Inject a store (tests, embedded in-memory). Default: openGraphDatabase(env). */
  db?: TransactionalGraphDatabase
  /** Auto-seed when empty/stale. Default true; false only makes sense in tests. */
  seed?: boolean
  /** Reader reload hint, forwarded to createPostgresGraphReader. */
  reloadIntervalMs?: number
}

export interface GraphApi {
  readonly db: TransactionalGraphDatabase
  /** True when the request path belongs to the graph API. */
  matches(path: string): boolean
  /** Serve one request. Never rejects for request-level failures. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  close(): Promise<void>
}

/**
 * Builds the API: opens (or accepts) the database, seeds it when needed and
 * assembles one long-lived Runtime — exactly like a warm Deno isolate.
 */
export async function createGraphApi(options: GraphApiOptions = {}): Promise<GraphApi> {
  const env = options.env ?? process.env
  const db = options.db ?? (await openGraphDatabase(env))

  if (options.seed !== false) {
    const seed = await seedGraphDatabase(db)
    if (seed.seeded) console.log(`GraphMentor graph database ${seed.reason}.`)
  }

  const reader = createPostgresGraphReader(db, { ...(options.reloadIntervalMs !== undefined ? { reloadIntervalMs: options.reloadIntervalMs } : {}) })
  const config = readRuntimeConfig((key) => env[key])

  const runtime = assembleRuntime({
    config,
    reader,
    readerReason: null,
    repos: null,
    rateLimit: new MemoryFixedWindowStore(),
    nonce: new MemoryNonceStore(),
  })

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
      cors = corsHeaders(apiRequest.headers.get('origin'), { allowedOrigins: config.allowedOrigins })
      if (cors === null) {
        // Unlisted origins get answered without CORS headers — the browser
        // blocks the read — rather than being refused outright (same rule as
        // the Deno platform layer).
        apiRequest.logger.warn('request from a non-allowlisted origin was answered without CORS headers')
        cors = {}
      }

      if (apiRequest.method === 'OPTIONS') {
        await sendFetchResponse(response, finish({ status: 204, body: null, headers: {} }, { cors }))
        return
      }
      if (!route) {
        await sendFetchResponse(response, finish(notFound(`No endpoint named "${fn ?? '(missing)'}".`), { cors }))
        return
      }
      if (!route.methods.includes(apiRequest.method)) {
        await sendFetchResponse(response, finish(methodNotAllowed(route.methods), { cors }))
        return
      }
      const result = await route.handler(runtime, apiRequest)
      await sendFetchResponse(response, finish(result, { cors }))
    } catch (error) {
      if (apiRequest) logError(error, apiRequest)
      else console.error(JSON.stringify({ level: 'error', msg: 'graph api request failed before parsing', error: error instanceof Error ? error.name : 'unknown' }))
      await sendFetchResponse(response, toErrorResponse(error, { cors }))
    }
  }

  return {
    db,
    matches: isGraphApiPath,
    handle,
    close: () => db.end(),
  }
}

/** Startup log line with the live table counts — the "is it really the database" check. */
export async function describeGraphStore(db: TransactionalGraphDatabase): Promise<string> {
  const counts = await graphCounts(db)
  return `${counts.nodes} nodes, ${counts.relationships} relationships (PostgreSQL)`
}
