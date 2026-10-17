/**
 * Server-side client for the Neo4j AuraDB HTTPS Query API.
 *
 * One client serves both the graph reader (`neo4jReader.ts`, read-only Cypher)
 * and the account store (`platform/neo4jStore.ts`, parameterised writes), so
 * both share one set of guarantees:
 *
 *  - one POST per statement, body `{ statement, parameters, accessMode }`,
 *    with `accessMode` = "Read" for reads and "Write" for writes (the Query API
 *    defaults to Write when the field is absent),
 *  - Basic auth from server-side secrets only; the password is never placed in a
 *    URL, a log line or an error message,
 *  - a hard timeout per attempt (AbortController),
 *  - the Query API answers HTTP 202 even for failed statements, so the body's
 *    `errors` array is always checked; a body that is not a Query API response at
 *    all is an error, never an empty result,
 *  - bounded retries. Reads retry transient transport and HTTP failures. Writes
 *    retry only failures the database guarantees were rolled back (transient
 *    errors and MERGE constraint races), so a retry can never apply a write twice,
 *  - failures are classified (`context.neo4jFailure`) so the health check can say
 *    what to fix, without exposing the upstream body.
 *
 * This module must only run server-side. The browser reaches Neo4j exclusively
 * through the API.
 */
import { AppError } from './errors.ts'

export type Neo4jFailure = 'auth' | 'endpoint' | 'timeout' | 'unreachable' | 'upstream' | 'rejected' | 'malformed'

/** Operator-facing guidance for each failure class. Contains no secrets. */
export const NEO4J_FAILURE_HINTS: Record<Neo4jFailure, string> = {
  auth: 'Neo4j rejected the configured username or password. Check NEO4J_USERNAME and NEO4J_PASSWORD (Aura shows the generated password only once, when the instance is created).',
  endpoint: 'The Neo4j Query API endpoint was not found. NEO4J_QUERY_URL must be https://<instance-id>.databases.neo4j.io/db/<database>/query/v2 with the instance id copied from the Aura console.',
  timeout: 'Neo4j did not answer within NEO4J_TIMEOUT_MS. The instance may be paused or still starting; AuraDB Free instances pause when idle and must be resumed in the Aura console.',
  unreachable: 'The Neo4j endpoint could not be reached from the server. Check NEO4J_QUERY_URL, the network path, and that the instance is running.',
  upstream: 'Neo4j is temporarily busy or unavailable. Try again shortly.',
  rejected: 'Neo4j rejected a statement. The query may not match the database schema; run npm run seed:neo4j -- --check to compare the database with the generated manifest.',
  malformed: 'Neo4j answered, but not with a Query API response. Check that NEO4J_QUERY_URL is the HTTPS Query API endpoint, not the Browser or Bolt address.',
}

export interface QueryApiConfig {
  queryUrl: string
  username: string
  password: string
  timeoutMs: number
  maxRows: number
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Redacted event sink (tag, timing, row count). Never receives credentials. */
  onEvent?: (event: QueryApiEvent) => void
}

export interface QueryApiEvent {
  type: 'query' | 'error'
  cypherTag?: string
  ms?: number
  status?: number
  rows?: number
  failure?: Neo4jFailure
}

export interface RunOptions {
  /** Use accessMode "Write". Defaults to a read. */
  write?: boolean
  /** Stable name for logs and the read ledger. Never the Cypher text. */
  tag?: string
  signal?: AbortSignal
  /** Retry budget for reads (0-3). Writes only retry rolled-back transient errors. */
  retries?: number
}

export interface QueryApiResult {
  rows: Array<Record<string, unknown>>
  ms: number
}

export interface QueryApiClient {
  run(cypher: string, params: Record<string, unknown>, options?: RunOptions): Promise<QueryApiResult>
  readonly maxRows: number
}

/* -------------------------------------------------------------------------- */
/* URL validation                                                             */
/* -------------------------------------------------------------------------- */

export type QueryUrlCheck = { ok: true; database: string } | { ok: false; reason: string }

/**
 * Validates a Query API URL and extracts the database it addresses. The database
 * is part of the path, so the URL is the single source of truth for which
 * database every reader and writer uses.
 */
export function parseQueryApiUrl(raw: string, options: { allowHttp?: boolean } = {}): QueryUrlCheck {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: 'NEO4J_QUERY_URL is not a valid URL. Copy the Query API URL from the Aura console (Connect → Query API).' }
  }
  const httpAllowed = options.allowHttp === true && url.protocol === 'http:'
  if (url.protocol !== 'https:' && !httpAllowed) {
    return { ok: false, reason: 'NEO4J_QUERY_URL must be an https:// URL.' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'NEO4J_QUERY_URL must not contain a username or password. Put credentials in NEO4J_USERNAME and NEO4J_PASSWORD.' }
  }
  const match = /^\/db\/([^/]+)\/query\/v2\/?$/.exec(url.pathname)
  if (!match) {
    return { ok: false, reason: 'NEO4J_QUERY_URL must end in /db/<database>/query/v2, for example https://<instance-id>.databases.neo4j.io/db/neo4j/query/v2.' }
  }
  let database: string
  try {
    database = decodeURIComponent(match[1] ?? '')
  } catch {
    return { ok: false, reason: 'NEO4J_QUERY_URL contains an invalid database name.' }
  }
  if (!database) return { ok: false, reason: 'NEO4J_QUERY_URL does not name a database.' }
  return { ok: true, database }
}

/* -------------------------------------------------------------------------- */
/* Response decoding                                                          */
/* -------------------------------------------------------------------------- */

export interface DecodedQueryResponse {
  rows: Array<Record<string, unknown>>
  errors: Array<{ code: string; message: string }>
  /** 'v2' and 'v1' are recognised Query API bodies; 'none' is not a Query API response. */
  shape: 'v1' | 'v2' | 'none'
}

/** Decodes both Query API response shapes (v2 `data.values`, v1 `results[].data[].row`). */
export function decodeQueryApiResponse(payload: unknown): DecodedQueryResponse {
  const errors: Array<{ code: string; message: string }> = []
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { rows: [], errors, shape: 'none' }
  }
  const body = payload as Record<string, unknown>

  if (Array.isArray(body.errors)) {
    for (const item of body.errors.slice(0, 10)) {
      if (item && typeof item === 'object') {
        const err = item as Record<string, unknown>
        errors.push({
          code: typeof err.code === 'string' && err.code ? err.code.slice(0, 120) : 'Neo.ClientError',
          message: typeof err.message === 'string' ? err.message.slice(0, 400) : 'Unknown graph error',
        })
      }
    }
  }

  // Query API v2: { data: { fields: [...], values: [[...]] } }
  const data = body.data
  if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as Record<string, unknown>).values)) {
    const v2 = data as Record<string, unknown>
    const fields = Array.isArray(v2.fields) ? v2.fields.map((f, i) => (typeof f === 'string' && f ? f : `col${i}`)) : []
    const rows: Array<Record<string, unknown>> = []
    for (const rowValues of (v2.values as unknown[]).slice(0, 5000)) {
      if (!Array.isArray(rowValues)) continue
      const row: Record<string, unknown> = {}
      fields.forEach((field, index) => {
        row[field] = rowValues[index]
      })
      rows.push(row)
    }
    return { rows, errors, shape: 'v2' }
  }

  // Query API v1: { results: [ { columns: [...], data: [ { row: [...] } ] } ] }
  const results = Array.isArray(body.results) ? body.results : []
  const first = results[0]
  if (first && typeof first === 'object' && Array.isArray((first as Record<string, unknown>).data)) {
    const v1 = first as Record<string, unknown>
    const columns = Array.isArray(v1.columns) ? v1.columns.map((c, i) => (typeof c === 'string' && c ? c : `col${i}`)) : []
    const rows: Array<Record<string, unknown>> = []
    for (const entry of (v1.data as unknown[]).slice(0, 5000)) {
      if (!entry || typeof entry !== 'object') continue
      const rowArray = (entry as Record<string, unknown>).row
      if (!Array.isArray(rowArray)) continue
      const row: Record<string, unknown> = {}
      columns.forEach((column, index) => {
        row[column] = rowArray[index]
      })
      rows.push(row)
    }
    return { rows, errors, shape: 'v1' }
  }

  // An error-only body is a recognised Query API answer (the caller maps it).
  if (errors.length > 0) return { rows: [], errors, shape: 'v2' }
  return { rows: [], errors, shape: 'none' }
}

/** Maps a Neo4j error code to a failure class. */
export function failureForCode(code: string): Neo4jFailure {
  if (/Security/i.test(code)) return 'auth'
  if (/TransientError/i.test(code)) return 'upstream'
  return 'rejected'
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function base64(input: string): string {
  const globalBtoa = (globalThis as { btoa?: (s: string) => string }).btoa
  if (globalBtoa) return globalBtoa(input)
  const bufferCtor = (globalThis as unknown as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } }).Buffer
  if (bufferCtor) return bufferCtor.from(input, 'utf8').toString('base64')
  throw new Error('No base64 implementation available')
}

/** An AppError carrying the failure class and whether the caller may retry it. */
function fail(
  code: 'dependency_unavailable' | 'timeout' | 'internal',
  failure: Neo4jFailure,
  internal: string,
  extra: { retryable?: boolean; transient?: boolean; retryAfterSeconds?: number } = {},
): AppError {
  return new AppError(code, {
    internal,
    ...(extra.retryAfterSeconds ? { retryAfterSeconds: extra.retryAfterSeconds } : {}),
    context: {
      neo4jFailure: failure,
      retryable: extra.retryable === true,
      transient: extra.transient === true,
    },
  })
}

/** Whether an error may be retried for this operation. */
function retryableFor(error: unknown, write: boolean): boolean {
  if (!(error instanceof AppError)) return false
  const context = error.context ?? {}
  if (context.retryable !== true) return false
  // A write may only be retried when the database proved the transaction was
  // rolled back; a timeout or dropped connection may have committed it.
  return !write || context.transient === true
}

export function createQueryApiClient(config: QueryApiConfig): QueryApiClient {
  const fetchImpl = config.fetchImpl ?? fetch
  const maxRows = Math.max(1, Math.min(config.maxRows, 2000))
  const timeoutMs = Math.max(1000, Math.min(config.timeoutMs, 30_000))
  const authHeader = `Basic ${base64(`${config.username}:${config.password}`)}`
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  async function attemptOnce(cypher: string, params: Record<string, unknown>, options: RunOptions): Promise<QueryApiResult> {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onOuterAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onOuterAbort)
    try {
      let response: Response
      try {
        response = await fetchImpl(config.queryUrl, {
          method: 'POST',
          headers: {
            authorization: authHeader,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': 'GraphMentorAI/1.0 (+edge-function)',
          },
          body: JSON.stringify({
            statement: cypher,
            parameters: params,
            accessMode: options.write ? 'Write' : 'Read',
          }),
          signal: controller.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw fail('dependency_unavailable', 'unreachable', 'neo4j request cancelled by caller')
        if (controller.signal.aborted) {
          config.onEvent?.({ type: 'error', cypherTag: options.tag, failure: 'timeout' })
          throw fail('timeout', 'timeout', `neo4j timeout after ${timeoutMs}ms`, { retryable: true })
        }
        const name = error instanceof Error ? error.name : 'unknown'
        config.onEvent?.({ type: 'error', cypherTag: options.tag, failure: 'unreachable' })
        throw fail('dependency_unavailable', 'unreachable', `neo4j request failed (${name})`, { retryable: true })
      }

      if (response.status === 401 || response.status === 403) {
        await response.text().catch(() => '')
        config.onEvent?.({ type: 'error', cypherTag: options.tag, status: response.status, failure: 'auth' })
        throw fail('dependency_unavailable', 'auth', `neo4j http ${response.status}`)
      }
      if (response.status === 404) {
        await response.text().catch(() => '')
        config.onEvent?.({ type: 'error', cypherTag: options.tag, status: 404, failure: 'endpoint' })
        throw fail('dependency_unavailable', 'endpoint', 'neo4j http 404')
      }
      if (!response.ok) {
        // Drain the body so the socket is released; never log it verbatim.
        await response.text().catch(() => '')
        const retryable = RETRYABLE_STATUS.has(response.status)
        config.onEvent?.({ type: 'error', cypherTag: options.tag, status: response.status, failure: retryable ? 'upstream' : 'rejected' })
        throw fail(retryable ? 'dependency_unavailable' : 'internal', retryable ? 'upstream' : 'rejected', `neo4j http ${response.status}`, {
          retryable,
          retryAfterSeconds: response.status === 429 ? 5 : undefined,
        })
      }

      const payload = await response.json().catch(() => undefined)
      const decoded = decodeQueryApiResponse(payload)
      if (decoded.errors.length > 0) {
        const code = decoded.errors[0].code
        const failure = failureForCode(code)
        config.onEvent?.({ type: 'error', cypherTag: options.tag, status: response.status, failure })
        const transient = failure === 'upstream' || /ConstraintValidationFailed/i.test(code)
        throw fail(failure === 'rejected' ? 'internal' : 'dependency_unavailable', failure, `neo4j query error: ${code}`, {
          retryable: transient,
          transient,
        })
      }
      if (decoded.shape === 'none') {
        config.onEvent?.({ type: 'error', cypherTag: options.tag, status: response.status, failure: 'malformed' })
        throw fail('dependency_unavailable', 'malformed', 'neo4j returned a body that is not a Query API response')
      }

      const rows = decoded.rows.slice(0, maxRows)
      const ms = Date.now() - started
      config.onEvent?.({ type: 'query', cypherTag: options.tag, ms, status: response.status, rows: rows.length })
      return { rows, ms }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  return {
    maxRows,
    async run(cypher, params, options = {}) {
      const write = options.write === true
      const attempts = Math.max(0, Math.min(options.retries ?? 2, 3))
      for (let attempt = 0; ; attempt++) {
        try {
          return await attemptOnce(cypher, params, options)
        } catch (error) {
          const budget = write ? 3 : attempts
          if (attempt < budget && retryableFor(error, write) && !options.signal?.aborted) {
            await sleep(150 * (attempt + 1) + Math.floor(Math.random() * 120))
            continue
          }
          throw error
        }
      }
    },
  }
}

/** Wraps the client so every failure reads as a deliberate, classified error. */
export function failureOf(error: unknown): Neo4jFailure | null {
  if (error instanceof AppError) {
    const value = error.context?.neo4jFailure
    if (typeof value === 'string') return value as Neo4jFailure
  }
  return null
}
