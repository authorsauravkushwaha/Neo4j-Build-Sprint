/**
 * Test-only factory for the pieces every handler needs: a `Runtime` backed by
 * the bundled sample dataset, and an `ApiRequest` built by hand.
 *
 * Deliberately does NOT import `platform/deno.ts` (that module calls Deno.env and
 * imports `npm:@supabase/...`). Handlers take everything through `Runtime`, so
 * these tests exercise the same code path the Edge Function runs, with the
 * runtime-specific edges faked at exactly one layer.
 */
import { createLocalReader } from '@core/localReader.ts'
import {
  MemoryFixedWindowStore,
  MemoryNonceStore,
  RATE_POLICIES,
} from '@core/rateLimit.ts'
import type { ApiRequest } from '@core/http.ts'
import { createLogger } from '@core/log.ts'
import {
  assembleRuntime,
  readRuntimeConfig,
  type Runtime,
  type RuntimeLimits,
  type StorageBackend,
} from '../../supabase/functions/_shared/runtime.ts'
import type { AuthCheck, UserRepositories } from '../../supabase/functions/_shared/platform/supabaseStore.ts'
import { knowledgeGraph } from '../../src/data/seed/knowledgeGraph.ts'
import { createInMemoryRepos } from './inMemoryRepos.ts'

export interface TestRuntimeOptions {
  /** Fake verifier: return a userId for a token, or 'invalid'. */
  auth?: (headers: Headers) => Promise<AuthCheck>
  withRepos?: boolean
  /** Omit the reader to simulate a deployment with no graph configured. */
  withoutReader?: boolean
  /** Model a reachable-but-empty Neo4j, which must stay distinct from "not configured". */
  graphEmpty?: boolean
  env?: (key: string) => string | undefined
  limits?: Partial<RuntimeLimits>
  ai?: Runtime['ai']
}

export interface TestRuntime extends Runtime {
  /** The in-memory store, including its test-only `snapshot()` inspector. */
  repos: UserRepositories & ReturnType<typeof createInMemoryRepos>
}

export function testConfig(env: (key: string) => string | undefined = () => undefined) {
  return readRuntimeConfig(env)
}

export function createTestRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const config = readRuntimeConfig(options.env ?? (() => undefined))
  if (options.limits) config.limits = { ...config.limits, ...options.limits }

  const reader = options.withoutReader ? null : createLocalReader(knowledgeGraph)
  const repos = createInMemoryRepos()
  const verifyAuth: (headers: Headers) => Promise<AuthCheck> =
    options.auth ??
    (async (headers: Headers) => {
      const token = headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      if (!token) return { status: 'none' }
      if (token === 'invalid-token') return { status: 'invalid', reason: 'expired' }
      return { status: 'valid', userId: `user-${token}` }
    })

  const runtime = assembleRuntime({
    config,
    reader,
    readerReason: options.withoutReader ? 'Neo4j is not configured in this test.' : null,
    repos: options.withRepos === false ? null : repos,
    rateLimit: new MemoryFixedWindowStore(),
    nonce: new MemoryNonceStore(),
    verifyAuth,
    ...(options.ai ? { ai: options.ai } : {}),
  })

  /*
   * The inspector is only attached when the runtime actually has repositories.
   * `Object.assign` used to attach the in-memory store unconditionally, which
   * silently gave `{ withRepos: false }` runtimes a working repository layer —
   * so a test that meant to model "no storage configured" was in fact talking to
   * a store. Callers that pass `withRepos: false` get `repos === null`.
   */
  if (options.withRepos === false) return runtime as TestRuntime
  return Object.assign(runtime, { repos }) as TestRuntime
}

export interface BackendRuntimeOptions {
  /** A repository set built against a real backend client, e.g. `createUserRepositories(createAppwriteClient(...))`. */
  repos: UserRepositories
  /** The verifier that belongs to that backend — sessions and JWTs are not interchangeable. */
  verifyAuth: (headers: Headers) => Promise<AuthCheck>
  /** Which backend the repositories talk to, so `health-check` describes it correctly. */
  storageBackend: StorageBackend
  env?: (key: string) => string | undefined
  limits?: Partial<RuntimeLimits>
  rateLimit?: Runtime['rateLimit']
  nonce?: Runtime['nonce']
  withoutReader?: boolean
}

/**
 * A runtime wired to an arbitrary backend.
 *
 * `createTestRuntime` is the fast path (in-memory repositories). This is for the
 * tests whose whole question is "does the API behave identically on a different
 * database?" — they inject the real repository layer over a real client and send
 * the same requests twice. It deliberately has no `snapshot()`: assertions on
 * this runtime must go through the API or the backend's own store, because a
 * convenience inspector here would be testing the inspector.
 */
export function createRuntimeWithBackend(options: BackendRuntimeOptions): Runtime {
  const config = readRuntimeConfig(options.env ?? (() => undefined))
  if (options.limits) config.limits = { ...config.limits, ...options.limits }
  return assembleRuntime({
    config,
    reader: options.withoutReader ? null : createLocalReader(knowledgeGraph),
    readerReason: options.withoutReader ? 'No graph is configured in this test.' : null,
    repos: options.repos,
    storageBackend: options.storageBackend,
    rateLimit: options.rateLimit ?? new MemoryFixedWindowStore(),
    nonce: options.nonce ?? new MemoryNonceStore(),
    verifyAuth: options.verifyAuth,
  })
}

export interface RequestOptions {
  method?: string
  /** Query string without the leading '?'. */
  query?: string
  path?: string
  body?: unknown
  /** Raw body text, for malformed-JSON and oversized-body cases. */
  rawBody?: string
  token?: string | null
  headers?: Record<string, string>
  ip?: string
  contentType?: string | null
}

export function makeRequest(options: RequestOptions = {}): ApiRequest {
  const method = (options.method ?? (options.body || options.rawBody ? 'POST' : 'GET')).toUpperCase()
  const path = options.path ?? '/test-endpoint'
  const url = new URL(`https://functions.example.test${path}${options.query ? `?${options.query}` : ''}`)

  const headers = new Headers(options.headers ?? {})
  if (options.token !== null && (options.token ?? 'anon-token')) {
    headers.set('authorization', `Bearer ${options.token ?? 'anon-token'}`)
  }
  const hasBody = options.body !== undefined || options.rawBody !== undefined
  if (hasBody) {
    headers.set('content-type', options.contentType ?? 'application/json')
  }

  const bodyText = options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : '')

  return {
    method,
    path,
    url,
    headers,
    bodyText,
    userId: null,
    clientIp: options.ip ?? '203.0.113.7',
    requestId: 'test-request-id',
    logger: createLogger({ requestId: 'test-request-id', fn: 'test', route: path }, 'error'),
    env: () => undefined,
  }
}

export { RATE_POLICIES }


