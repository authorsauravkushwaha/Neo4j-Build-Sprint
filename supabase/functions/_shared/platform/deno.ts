/**
 * Deno / Supabase Edge Function glue.
 *
 * This is the ONLY place in the codebase that touches runtime-specific APIs
 * (`Deno.env`, `Deno.serve`, the `npm:` Supabase client). Everything below it is
 * plain TypeScript that also runs in Node and the browser.
 *
 * Two Supabase clients are used deliberately:
 *  - `userClient`: anon key + the caller's `Authorization` header, so Row Level
 *    Security is enforced by Postgres for all user-owned records (primary control),
 *  - `adminClient`: service-role key, used ONLY for the rate-limit and nonce
 *    functions, which must work for anonymous callers too (secondary control).
 * The service-role key is never returned, logged, or forwarded anywhere.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
import {
  assembleRuntime,
  createReaderFromConfig,
  readRuntimeConfig,
  type Runtime,
} from '../runtime.ts'
import type { ApiHandler, ApiRequest, HttpResponse } from '../core/http.ts'
import {
  buildApiRequest,
  corsHeaders,
  finish,
  logError,
  methodNotAllowed,
  toErrorResponse,
} from '../core/http.ts'
import { AppError } from '../core/errors.ts'
import {
  createAuthVerifier,
  createPostgresFixedWindowStore,
  createPostgresNonceStore,
  createUserRepositories,
  type SupabaseLikeClient,
} from './supabaseStore.ts'
import type { GraphReader } from '../core/graphReader.ts'

const env = (key: string) => Deno.env.get(key)

// A single reader per isolate: the Neo4j reader is stateless and safe to reuse.
let cachedReader: { key: string; reader: GraphReader | null; reason: string | null; hint?: string } | null = null

function getReader(config: ReturnType<typeof readRuntimeConfig>) {
  const key = config.neo4j ? `${config.neo4j.queryUrl}|${config.neo4j.database}|${config.neo4j.maxRows}` : 'none'
  if (cachedReader && cachedReader.key === key) return cachedReader
  const selection = createReaderFromConfig(config, {
    onEvent: (event) => {
      if (event.type === 'query') {
        console.log(
          JSON.stringify({ ts: new Date().toISOString(), level: 'debug', msg: 'neo4j query', tag: event.cypherTag, ms: event.ms, rows: event.rows }),
        )
      }
    },
  })
  cachedReader = {
    key,
    reader: selection.reader,
    reason: selection.reason,
    ...(selection.setupHint ? { hint: selection.setupHint } : {}),
  }
  return cachedReader
}

export function createRequestRuntime(request: Request, config = readRuntimeConfig(env)): Runtime {
  const supabaseUrl = env('SUPABASE_URL') ?? ''
  const anonKey = env('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const authorization = request.headers.get('authorization') ?? undefined

  let repos: Runtime['repos'] = null
  let rateLimit: Runtime['rateLimit'] | undefined
  let nonce: Runtime['nonce'] | undefined
  let verifyAuth: Runtime['verifyAuth'] | undefined

  if (supabaseUrl && anonKey) {
    // User-scoped client: RLS applies because we forward the caller's token.
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: authorization ? { Authorization: authorization } : {} },
    }) as unknown as SupabaseLikeClient

    repos = createUserRepositories(userClient)
    verifyAuth = async (headers: Headers) => createAuthVerifier(userClient)(headers)

    if (serviceKey) {
      // Admin client: only for cross-user primitives (rate limiting, nonces).
      const adminClient = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }) as unknown as SupabaseLikeClient
      rateLimit = createPostgresFixedWindowStore(adminClient)
      nonce = createPostgresNonceStore(adminClient)
    }
  }

  const selection = getReader(config)

  return assembleRuntime({
    config,
    reader: selection.reader,
    readerReason: selection.reason,
    ...(selection.hint ? { readerSetupHint: selection.hint } : {}),
    repos,
    ...(rateLimit ? { rateLimit } : {}),
    ...(nonce ? { nonce } : {}),
    ...(verifyAuth ? { verifyAuth } : {}),
  })
}

export interface ServeOptions {
  methods?: string[]
  handler: ApiHandler
  /** Extra headers to attach to every response (rarely needed). */
  extraHeaders?: Record<string, string>
}

function originOf(request: ApiRequest): string | null {
  return request.headers.get('origin')
}

/**
 * Shared request wrapper: CORS → method → handler → error mapping → logging.
 * A handler can be a pure function; it never constructs a Response itself.
 */
export async function handleRequest(rawRequest: Request, options: ServeOptions): Promise<Response> {
  const config = readRuntimeConfig(env)
  let request: ApiRequest | null = null
  let cors: Record<string, string> | null = {}

  try {
    request = await buildApiRequest(rawRequest, {
      logLevel: config.logLevel,
      maxBodyBytes: config.limits.maxJsonBodyBytes,
      verifyAuth: undefined,
    })

    cors = corsHeaders(originOf(request), { allowedOrigins: config.allowedOrigins })
    if (cors === null) {
      // Unlisted origin: no CORS headers, so browsers cannot read the response.
      request.logger.warn('request from a non-allowlisted origin was answered without CORS headers')
      cors = {}
    }

    // Preflight is answered from configuration only; it never touches the graph.
    if (request.method === 'OPTIONS') {
      return finish({ status: 204, body: null, headers: {} }, { cors, extraHeaders: options.extraHeaders })
    }

    const allowed = (options.methods ?? ['GET', 'POST']).map((method) => method.toUpperCase())
    if (!allowed.includes(request.method)) {
      return finish(methodNotAllowed(allowed), { cors, ...(options.extraHeaders ? { extraHeaders: options.extraHeaders } : {}) })
    }

    const response: HttpResponse = await options.handler({ ...request }, {})
    return finish(response, { cors, ...(options.extraHeaders ? { extraHeaders: options.extraHeaders } : {}) })
  } catch (error) {
    if (request) logError(error, request)
    else console.error(JSON.stringify({ level: 'error', msg: 'request failed before parsing', error: error instanceof Error ? error.name : 'unknown' }))
    return toErrorResponse(error, { cors, ...(options.extraHeaders ? { extraHeaders: options.extraHeaders } : {}) })
  }
}

/**
 * The handler shape every Edge Function entry point (`supabase/functions/<name>/index.ts`)
 * passes to `serve`: the assembled runtime first, then the parsed request —
 * the same order the handlers in `_shared/handlers/` declare and the same
 * order the Node test harnesses call them with.
 *
 * This type previously declared the opposite order — `(request, params,
 * runtime)` — and because no tsconfig included the entry points, nothing ever
 * checked it: in a real Deno deployment every handler would have received the
 * request where it expected the runtime. `tsconfig.functions.json` now covers
 * these files; do not remove them from it.
 */
export type RuntimeHandler = (runtime: Runtime, request: ApiRequest) => Promise<HttpResponse>

export function serve(handler: RuntimeHandler, options: { methods?: string[] } = {}): void {
  const methods = options.methods ?? ['GET', 'POST']
  Deno.serve((rawRequest) =>
    handleRequest(rawRequest, {
      methods,
      handler: (request) => handler(createRequestRuntime(rawRequest), request),
    }),
  )
}

export { AppError }


