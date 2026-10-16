/**
 * smoke:http — the auth path over a real socket.
 *
 * What this proves, and what it deliberately does not.
 *
 * PROVES: the Edge Function's request pipeline is a real HTTP surface, not just a
 * function the tests happen to call in-process. A Node server binds a real port,
 * requests arrive over the wire, and the responses are asserted on status, headers
 * (CORS, `vary`, `retry-after`, `cache-control`) and body shape. The pipeline it
 * runs is the same one `platform/deno.ts` runs in production — `buildApiRequest`,
 * `corsHeaders`, `finish`, `methodNotAllowed`, `toErrorResponse` from
 * `_shared/core/http.ts`, with `authGuardHandler` behind it — re-stated here for
 * Node because the Deno wrapper imports `npm:@supabase/supabase-js`.
 *
 * DOES NOT PROVE: anything about Supabase's hosted gateway (its own timeouts,
 * CDN, JWT verification) or about GoTrue password sign-in and its email delivery.
 * Those need a deployed project. This is the function's HTTP surface with an
 * in-memory limiter, and it is reported as exactly that.
 *
 * Run: `npm run smoke:http` — the server binds 127.0.0.1 on an ephemeral port and
 * is closed before the process exits. No network access is required.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'

import {
  buildApiRequest,
  corsHeaders,
  finish,
  logError,
  methodNotAllowed,
  toErrorResponse,
} from '../supabase/functions/_shared/core/http.ts'
import type { ApiRequest, ApiHandler, HttpResponse } from '../supabase/functions/_shared/core/http.ts'
import { MemoryFixedWindowStore, MemoryNonceStore } from '../supabase/functions/_shared/core/rateLimit.ts'
import {
  createPostgresFixedWindowStore,
  createPostgresNonceStore,
  type SupabaseLikeClient,
} from '../supabase/functions/_shared/platform/supabaseStore.ts'
import { authGuardHandler } from '../supabase/functions/_shared/handlers/authGuard.ts'
import { healthCheckHandler } from '../supabase/functions/_shared/handlers/health.ts'
import { assembleRuntime, readRuntimeConfig, type Runtime } from '../supabase/functions/_shared/runtime.ts'

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* -------------------------------------------------------------------------- */
/* The server                                                                  */
/* -------------------------------------------------------------------------- */

const ALLOWED_ORIGIN = 'http://localhost:5173'

/**
 * The environment a deployment would have, minus anything secret. No Neo4j, no AI
 * key, no Supabase URL: those endpoints must still answer honestly rather than
 * crash, which is part of what this smoke test checks.
 */
const env: Record<string, string> = {
  ALLOWED_ORIGINS: `${ALLOWED_ORIGIN},http://localhost:4173`,
  AUTH_ATTEMPTS_PER_MINUTE: '3',
  AUTH_ATTEMPTS_PER_HOUR: '25',
  AUTH_ATTEMPTS_PER_IP_PER_MINUTE: '10',
  LOG_LEVEL: 'silent',
  ENVIRONMENT: 'smoke-test',
}

const readEnv = (key: string): string | undefined => env[key]

function createRuntime(stores?: { rateLimit: ReturnType<typeof createPostgresFixedWindowStore>; nonce: ReturnType<typeof createPostgresNonceStore> }): Runtime {
  const config = readRuntimeConfig(readEnv)
  return assembleRuntime({
    config,
    reader: null,
    readerReason: 'Neo4j is not configured for the local smoke test.',
    // No Supabase client here on purpose: the smoke test covers the paths that
    // must work without one (the guard, the health check, the error mapping).
    repos: null,
    rateLimit: stores?.rateLimit ?? new MemoryFixedWindowStore(),
    nonce: stores?.nonce ?? new MemoryNonceStore(),
  })
}

const runtime = createRuntime()

/*
 * ---------------------------------------------------------------------------
 * The Postgres phase.
 *
 * `DATABASE_URL` is read directly rather than through `readRuntimeConfig`,
 * because it is the one value the Edge Function never sees: in production the
 * Supabase client carries it. When it is set, the limiter is the real one from
 * `supabaseStore.ts` — the same code path a deployment uses — talking to a real
 * Postgres over `pg` instead of the service-role client's `rpc()`. That is the
 * closest thing to "the auth path against a real database" this sandbox can
 * honestly offer: PostgreSQL with the project's own migrations applied.
 * ---------------------------------------------------------------------------
 */
async function connectPostgres(): Promise<
  { kind: 'ok'; client: SupabaseLikeClient; query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; inspect: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; close: () => Promise<void> } | { kind: 'error'; message: string }
> {
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) return { kind: 'error', message: 'DATABASE_URL is not set' }
  try {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 })
    await pool.query('select 1')
    const query = async (text: string, values?: unknown[]) => {
      const result = await pool.query(text, values as never[])
      return { rows: result.rows as Array<Record<string, unknown>> }
    }
    const client: SupabaseLikeClient = {
      // Only `rpc` is needed for the limiter and the nonce store; the repository
      // half of the client is exercised by the RLS harness, which talks SQL.
      from: () => {
        throw new Error('this smoke test only uses the rpc surface')
      },
      rpc: async <T,>(fn: string, args?: Record<string, unknown>) => {
        const entries = Object.entries(args ?? {})
        const params = entries.map(([name], index) => `${name} := $${index + 1}`).join(', ')
        try {
          const result = await query(`select public.${fn}(${params}) as value`, entries.map(([, value]) => value))
          return { data: (result.rows[0]?.['value'] ?? null) as T, error: null }
        } catch (error) {
          const code = (error as { code?: string }).code ?? 'unknown'
          return { data: null, error: { code, message: String((error as Error).message ?? 'rpc failed') } }
        }
      },
      auth: {
        getUser: async () => ({ data: { user: null }, error: { code: 'not_configured', message: 'auth server is not part of this smoke test' } }),
      },
    }
    // Direct table inspection in this phase (truncate / select the counters) is
    // test-harness work, not application work. When DATABASE_ADMIN_URL is set it
    // carries those statements, so DATABASE_URL can be the least-privileged
    // application role — which is exactly how the project's own database is
    // meant to be driven (db/bin/app-env.sh prints both). Without it, the one
    // connection does both, as before.
    const adminConnectionString = process.env['DATABASE_ADMIN_URL']
    const inspectPool = adminConnectionString ? new pg.Pool({ connectionString: adminConnectionString, max: 2, connectionTimeoutMillis: 5_000 }) : pool
    const inspect = async (text: string, values?: unknown[]) => {
      const result = await inspectPool.query(text, values as never[])
      return { rows: result.rows as Array<Record<string, unknown>> }
    }
    return { kind: 'ok', client, query, inspect, close: async () => { await pool.end(); if (inspectPool !== pool) await inspectPool.end() } }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

function routesFor(boundRuntime: Runtime): Record<string, { methods: string[]; handler: ApiHandler }> {
  return {
    '/auth-guard': { methods: ['POST'], handler: (request: ApiRequest) => authGuardHandler(boundRuntime, request) },
    '/health-check': { methods: ['GET'], handler: (request: ApiRequest) => healthCheckHandler(boundRuntime, request) },
  }
}

/** A faithful Node port of `handleRequest` in `platform/deno.ts`. */
async function handle(request: Request, boundRuntime: Runtime): Promise<Response> {
  let apiRequest: ApiRequest | null = null
  let cors: Record<string, string> = {}

  try {
    apiRequest = await buildApiRequest(request, {
      logLevel: readEnv('LOG_LEVEL') ?? 'info',
      maxBodyBytes: boundRuntime.config.limits.maxJsonBodyBytes,
    })

    const origin = apiRequest.headers.get('origin')
    const headers = corsHeaders(origin, { allowedOrigins: boundRuntime.config.allowedOrigins })
    // Unlisted origin: answer, but without CORS headers, so a browser cannot read it.
    cors = headers ?? {}

    if (apiRequest.method === 'OPTIONS') {
      return finish({ status: 204, body: null, headers: {} }, { cors })
    }

    const route = routesFor(boundRuntime)[apiRequest.path]
    if (!route) {
      return finish({ status: 404, body: { ok: false, error: { code: 'not_found', message: 'Unknown endpoint.' } }, headers: {} }, { cors })
    }
    if (!route.methods.includes(apiRequest.method)) {
      return finish(methodNotAllowed(route.methods), { cors })
    }

    const response: HttpResponse = await route.handler({ ...apiRequest }, {})
    return finish(response, { cors })
  } catch (error) {
    const response = toErrorResponse(error, { cors })
    // Expected refusals (422, 413, 400, 429) are the API working, not incidents;
    // only a 5xx is worth a log line here.
    if (apiRequest && response.status >= 500) logError(error, apiRequest)
    return response
  }
}

function nodeToFetchRequest(message: IncomingMessage, body: Buffer, url: string): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }
  const method = (message.method ?? 'GET').toUpperCase()
  return new Request(url, {
    method,
    headers,
    // Buffer is a Uint8Array, which fetch accepts; TypeScript's RequestInit in
    // this lib version does not list Uint8Array in BodyInit, hence the cast.
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: new Uint8Array(body) as unknown as BodyInit }),
  })
}

function startServer(boundRuntime: Runtime): Promise<{ server: Server; origin: string }> {
  const server = createServer((message: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of message) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      const url = `http://127.0.0.1${message.url ?? '/'}`

      const result = await handle(nodeToFetchRequest(message, body, url), boundRuntime)
      const text = result.body ? await result.text() : ''
      response.statusCode = result.status
      result.headers.forEach((value, key) => response.setHeader(key, value))
      response.end(text)
    })().catch((error: unknown) => {
      response.statusCode = 500
      response.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error) } }))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface Call {
  status: number
  headers: Headers
  body: Record<string, unknown>
  text: string
}

async function call(
  origin: string,
  path: string,
  options: { method?: string; body?: unknown; rawBody?: string; origin?: string | null; ip?: string } = {},
): Promise<Call> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.origin !== null) headers.origin = options.origin ?? ALLOWED_ORIGIN
  // Only a real proxy/gateway sets these; the handler reads the left-most entry.
  headers['x-forwarded-for'] = options.ip ?? '198.51.100.10'

  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'POST',
    headers,
    ...(options.method && options.method !== 'POST' ? {} : { body: options.rawBody ?? JSON.stringify(options.body ?? {}) }),
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = {}
  }
  return { status: response.status, headers: response.headers, body, text }
}

/**
 * A deterministic stand-in for the client-side SHA-256 of an address.
 *
 * Must be lowercase hex, like the real thing: the schema is strict (16–64 hex
 * characters), and the first version of this helper appended letters like `h7`,
 * which made every "host ceiling" request a 422 instead of an attempt — a green
 * looking loop that was never actually exercising the limiter.
 */
function addressHash(seed: string): string {
  let suffix = ''
  for (const character of seed) suffix += (character.codePointAt(0) ?? 0).toString(16)
  return `a1b2c3d4${suffix}`.padEnd(32, '0').slice(0, 32)
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const { server, origin } = await startServer(runtime)
  console.log(`smoke:http — the auth pipeline on a real socket (${origin})`)
  console.log('Note: this is the Edge Function surface with an in-memory limiter. It is not a')
  console.log('deployment, and it does not touch GoTrue (password sign-in, email delivery).\n')

  try {
    /* 1. The endpoint answers a well-formed request, over HTTP, with the headers
          a browser and a cache both need to behave. */
    console.log('1. The endpoint answers')
    const first = await call(origin, '/auth-guard', { body: { emailHash: addressHash('01') } })
    const data = first.body.data as { allowed?: boolean; attemptsLeft?: number | null } | undefined
    check('POST /auth-guard returns 200 over the wire', first.status === 200, `status ${first.status}`)
    check(
      'the answer is a slot, not a verdict on the account',
      data?.allowed === true && typeof data.attemptsLeft === 'number',
      `allowed ${String(data?.allowed)}, attemptsLeft ${String(data?.attemptsLeft)}`,
    )
    check('the response is not cacheable', /no-store/.test(first.headers.get('cache-control') ?? ''), first.headers.get('cache-control') ?? 'no cache-control')
    check(
      'CORS names the calling origin and is marked as varying by it',
      first.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN && /origin/i.test(first.headers.get('vary') ?? ''),
      `allow-origin ${first.headers.get('access-control-allow-origin') ?? 'none'}, vary ${first.headers.get('vary') ?? 'none'}`,
    )

    /* 2. Attempts run out, and the refusal is actionable (429 + retry-after). */
    console.log('\n2. Guessing runs out of attempts')
    const remaining: Array<number | null> = []
    let refusal: Call | null = null
    for (let attempt = 0; attempt < 6 && !refusal; attempt += 1) {
      const response =
        attempt === 0
          ? first
          : await call(origin, '/auth-guard', { body: { emailHash: addressHash('01') } })
      const payload = response.body.data as { allowed?: boolean; attemptsLeft?: number | null }
      remaining.push(payload.attemptsLeft ?? null)
      if (response.status === 429) refusal = response
    }
    check(
      'attempts left decrease as the endpoint is called',
      remaining.length >= 2 && (remaining[0] ?? 0) > (remaining[remaining.length - 1] ?? 0),
      remaining.join(' → '),
    )
    check('a spent address is refused with 429', refusal !== null, `after ${remaining.length} attempt(s)`)
    if (refusal) {
      const payload = refusal.body.data as { allowed?: boolean; scope?: string }
      const retryAfter = Number(refusal.headers.get('retry-after'))
      check('the refusal carries a numeric retry-after', Number.isFinite(retryAfter) && retryAfter > 0, `${refusal.headers.get('retry-after')} s`)
      check('the refusal says which ceiling was hit', payload.allowed === false && typeof payload.scope === 'string', `scope ${String(payload.scope)}`)
      check('the refusal is still not cacheable', /no-store/.test(refusal.headers.get('cache-control') ?? ''))
    }

    /* 3. The property the whole endpoint exists to preserve: an attacker cannot
          use it to learn whether an address has an account. */
    console.log('\n3. No account-existence leak')
    const unknown = await call(origin, '/auth-guard', { body: { emailHash: addressHash('ff') }, ip: '198.51.100.200' })
    const known = await call(origin, '/auth-guard', { body: { emailHash: addressHash('02') }, ip: '198.51.100.201' })
    check(
      'two different addresses get byte-identical answer shapes',
      JSON.stringify(Object.keys(unknown.body).sort()) === JSON.stringify(Object.keys(known.body).sort()) &&
        JSON.stringify(Object.keys((unknown.body.data ?? {}) as object).sort()) ===
          JSON.stringify(Object.keys((known.body.data ?? {}) as object).sort()),
      `200 ${unknown.status} / ${known.status}`,
    )
    check(
      'the answer never contains the address or its hash',
      !unknown.text.includes(addressHash('ff')) && !unknown.text.includes(addressHash('02')) && !/@"|mailto:|\.com/.test(unknown.text),
      'no identifiers echoed',
    )
    // A fresh address gets the full allowance, one attempt of which it has just
    // spent — so the ceiling is visible in the answer, and it is per address.
    const ceiling = runtime.config.limits.authAttemptPerMinute.limit
    check(
      'attempts are counted per address, not shared between them',
      (unknown.body.data as { attemptsLeft?: number }).attemptsLeft === ceiling - 1,
      `fresh address starts at ${String((unknown.body.data as { attemptsLeft?: number }).attemptsLeft)} of ${ceiling}`,
    )

    /* 4. The host ceiling, so one machine cannot walk a dictionary of addresses. */
    console.log('\n4. The host ceiling')
    let hostRefused = false
    for (let attempt = 0; attempt < 14 && !hostRefused; attempt += 1) {
      const response = await call(origin, '/auth-guard', { body: { emailHash: addressHash(`h${attempt}`) }, ip: '198.51.100.77' })
      if (response.status === 429) hostRefused = true
    }
    check('one busy host runs out of attempts across many addresses', hostRefused, `${runtime.config.limits.authAttemptPerIpPerMinute.limit}/min per host`)

    /* 5. The surface behaves like an HTTP API: preflight, method rejection, and
          strict input validation with no internal detail in the error. */
    console.log('\n5. The HTTP surface itself')
    const preflight = await call(origin, '/auth-guard', { method: 'OPTIONS', body: undefined })
    check('OPTIONS is answered as a preflight (204, no body)', preflight.status === 204 && preflight.text === '', `status ${preflight.status}`)

    const wrongMethod = await call(origin, '/auth-guard', { method: 'GET', body: undefined })
    check(
      'GET on a POST-only endpoint is refused with 405 and an Allow header',
      wrongMethod.status === 405 && /POST/.test(wrongMethod.headers.get('allow') ?? ''),
      `status ${wrongMethod.status}, allow ${wrongMethod.headers.get('allow') ?? 'none'}`,
    )

    const unlistedOrigin = await call(origin, '/auth-guard', { body: { emailHash: addressHash('03') }, origin: 'https://not-allowlisted.example' })
    check(
      'an unlisted origin gets a response with no CORS headers',
      unlistedOrigin.headers.get('access-control-allow-origin') === null,
      'browser cannot read it',
    )

    const badBody = await call(origin, '/auth-guard', { body: { emailHash: 'nope' } })
    const errorBody = badBody.body.error as { code?: string; message?: string } | undefined
    check(
      'an invalid body is refused with 422 and a stable error code',
      badBody.status === 422 && errorBody?.code === 'validation_failed',
      `status ${badBody.status}, code ${String(errorBody?.code)}`,
    )
    check(
      'the error carries no stack, SQL, file path or internal module name',
      !/\.ts\b|at .*\(|node_modules|select |insert |stack/i.test(badBody.text),
      `error text: ${badBody.text.slice(0, 80)}`,
    )

    const extraKey = await call(origin, '/auth-guard', { body: { emailHash: addressHash('04'), admin: true } })
    check('unknown fields are rejected rather than ignored (strict schema)', extraKey.status === 422, `status ${extraKey.status}`)

    const oversized = await call(origin, '/auth-guard', { rawBody: JSON.stringify({ emailHash: 'a'.repeat(70_000) }) })
    check(
      'an oversized body is refused before it reaches the handler',
      oversized.status >= 400 && oversized.status < 500,
      `status ${oversized.status}, ${errorCode(oversized)}`,
    )

    const malformed = await call(origin, '/auth-guard', { rawBody: '{not json' })
    check('malformed JSON is a 4xx, not a 500', malformed.status >= 400 && malformed.status < 500, `status ${malformed.status}, ${errorCode(malformed)}`)

    /* 6. A second endpoint on the same pipeline, with no credentials configured:
          it must still answer honestly instead of failing. */
    console.log('\n6. The same pipeline, a different endpoint')
    const health = await call(origin, '/health-check', { method: 'GET', body: undefined })
    const healthData = (health.body.data ?? {}) as { graph?: { source?: string; configured?: boolean } }
    check('GET /health-check answers over the wire', health.status === 200, `status ${health.status}`)
    check(
      'it reports the graph as unconfigured rather than pretending to be live',
      healthData.graph?.configured === false,
      `graph.configured ${String(healthData.graph?.configured)}, source ${String(healthData.graph?.source)}`,
    )
    const unknownPath = await call(origin, '/nope', { body: {} })
    check('an unknown path is a 404 with an error envelope', unknownPath.status === 404 && (unknownPath.body.ok === false), `status ${unknownPath.status}`)

    /* 7. The same HTTP path, with the limiter backed by a real database. */
    console.log('\n7. The limiter on real Postgres (optional)')
    const database = await connectPostgres()
    if (database.kind === 'error') {
      console.log(`  skip no database: ${database.message}`)
      console.log('       run with DATABASE_URL=postgres://… npm run smoke:http to include this phase')
    } else {
      try {
        await database.inspect('truncate table public.gm_rate_limit')
        const stores = {
          rateLimit: createPostgresFixedWindowStore(database.client),
          nonce: createPostgresNonceStore(database.client),
        }
        const dbServer = await startServer(createRuntime(stores))
        const dbOrigin = dbServer.origin

        const address = addressHash('db1')
        const firstDb = await call(dbOrigin, '/auth-guard', { body: { emailHash: address }, ip: '203.0.113.9' })
        const rows = await database.inspect('select key, count from public.gm_rate_limit order by key')
        check('the first call goes through and 200 is returned', firstDb.status === 200, `status ${firstDb.status}`)
        check(
          'the counter is a row in public.gm_rate_limit, not memory',
          rows.rows.length >= 2,
          `${rows.rows.length} key(s) written`,
        )
        const storedKeys = rows.rows.map((row) => String(row['key']))
        check(
          'no stored key contains the address hash or the address',
          storedKeys.every((key) => !key.includes(address) && !key.includes('db1')) && storedKeys.every((key) => /^[a-z0-9._:-]+$/i.test(key)),
          storedKeys.map((key) => key.slice(0, 18) + '…').join(' '),
        )

        let dbRefusal: Call | null = null
        for (let attempt = 0; attempt < 8 && !dbRefusal; attempt += 1) {
          const response = await call(dbOrigin, '/auth-guard', { body: { emailHash: address }, ip: '203.0.113.9' })
          if (response.status === 429) dbRefusal = response
        }
        const after = await database.inspect('select max(count) as max from public.gm_rate_limit')
        check('the database-backed limiter refuses with 429', dbRefusal !== null, dbRefusal ? `retry-after ${dbRefusal.headers.get('retry-after')} s` : 'never refused')
        check(
          'the stored count is what drove the refusal',
          Number(after.rows[0]?.['max'] ?? 0) >= runtime.config.limits.authAttemptPerMinute.limit,
          `max count ${String(after.rows[0]?.['max'])} ≥ limit ${runtime.config.limits.authAttemptPerMinute.limit}`,
        )

        /* The nonce store is the other half of the same client, and replay
           protection must fail closed. Two claims of one nonce: one yes, one no. */
        const claims = await Promise.all([
          stores.nonce.claim('smoke-nonce-1', 60_000),
          stores.nonce.claim('smoke-nonce-2', 60_000),
        ])
        const replay = await stores.nonce.claim('smoke-nonce-1', 60_000)
        check('a nonce is claimed exactly once', claims[0] === true && claims[1] === true && replay === false, `first ${String(claims[0])}, replay ${String(replay)}`)

        await database.inspect('truncate table public.gm_rate_limit, public.gm_nonce')
        dbServer.server.close()
        await once(dbServer.server, 'close').catch(() => undefined)
        await database.close()
      } catch (error) {
        check('the database phase completed', false, error instanceof Error ? error.message : String(error))
        await database.close()
      }
    }
  } finally {
    server.close()
    await once(server, 'close').catch(() => undefined)
  }

  console.log(`\n${passed}/${passed + failed} checks passed`)
  if (failed > 0) {
    console.log('\nThis run is NOT a pass. Fix the failures above before quoting a result.')
    process.exitCode = 1
  } else {
    console.log('The auth pipeline behaves over HTTP: rate-limited, CORS-scoped, leaking nothing.')
  }
}

function errorCode(response: Call): string {
  const error = response.body.error as { code?: string } | undefined
  return `code ${String(error?.code ?? 'none')}`
}

await main()


