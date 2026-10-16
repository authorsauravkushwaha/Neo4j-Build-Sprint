/**
 * Appwrite as the persistence backend, behind the same seam as Postgres.
 *
 * `supabaseStore.ts` defines what the API layer is allowed to ask of storage:
 * a filtered document client (`FilterBuilder`), a session lookup (`auth.getUser`),
 * and three server primitives behind `rpc`. This file implements that seam over
 * Appwrite's REST API, so `createUserRepositories`, `createAuthVerifier`,
 * `createPostgresFixedWindowStore` and `createPostgresNonceStore` all run
 * unchanged. That was the point of the seam: the swap is one module and one
 * environment variable, not a rewrite of the handlers.
 *
 * What genuinely differs, and how each difference is handled:
 *
 *  1. **There is no Row Level Security to fall back on.** On Postgres, a missing
 *     `user_id` filter is caught by a policy. Appwrite's document API honours the
 *     API key unconditionally, so the adapter refuses to *build* an unscoped
 *     read, update or delete on a user-scoped collection (`assertScoped`), and it
 *     refuses to PATCH a document that another account owns (`assertOwned`).
 *     Both are checked before the request leaves the process.
 *  2. **Sessions are opaque secrets, not JWTs.** `createAppwriteAuthVerifier`
 *     keeps the `AuthCheck` contract but drops the three-dot JWT pre-check, which
 *     would have rejected every real Appwrite secret as `not-a-jwt`.
 *  3. **No `INSERT … ON CONFLICT`.** `upsert` resolves the conflict target with a
 *     read, then PATCHes or creates, and re-reads once if a concurrent create
 *     loses the race against the unique index.
 *  4. **No jsonb and no `text[]`.** Columns listed in `JSON_TEXT_COLUMNS` are
 *     serialised to text on write and parsed back on read, so row shapes reaching
 *     the handlers are identical across backends.
 *  5. **No stored procedures.** `rpc` maps the three functions the API calls to
 *     document operations: a fixed window becomes one document per hit (the count
 *     *is* the number of rows, which is exact and needs no read-modify-write
 *     race), and a nonce becomes a document whose id is the nonce hash, because a
 *     primary-key insert is what makes a replay impossible.
 *  6. **Writes are per document, so a filtered update is N requests.** That is
 *     bounded by `maxWriteTargets`, and going over it fails loudly rather than
 *     writing half the batch.
 *
 * The transport is injectable (`AppwriteTransport`) purely so the adapter is
 * testable without network access: `tests/helpers/fakeAppwrite.ts` emulates the
 * document API, and `tests/integration/appwrite-adapter.test.ts` runs the real
 * repository layer against it.
 */
import {
  PersistenceError,
  createPostgresFixedWindowStore,
  createPostgresNonceStore,
  type AuthCheck,
  type FilterBuilder,
  type PostgrestError,
  type QueryResult,
  type SupabaseLikeClient,
} from './supabaseStore.ts'
import { APPWRITE_DATABASE_ID, JSON_TEXT_COLUMNS, TIMESTAMPED_TABLES, collectionFor, ownerColumnFor } from './appwriteSchema.ts'

/* ==========================================================================
 * Configuration and transport
 * ========================================================================== */

export interface AppwriteConfig {
  /** e.g. `https://cloud.appwrite.io/v1` or `https://appwrite.example.com/v1`. */
  endpoint: string
  projectId: string
  /** Server API key. Never sent to a browser, and never included in an error. */
  apiKey: string
  databaseId?: string
  /** Per-request timeout. A stuck request must not hold a rate-limit bucket open. */
  timeoutMs?: number
  /** Ceiling for a query with no explicit `.limit()`. Exceeding it throws. */
  maxRows?: number
  /** Ceiling for a filtered update/delete, which costs one request per document. */
  maxWriteTargets?: number
}

export interface AppwriteRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  /** Appwrite `queries[]` strings, e.g. `equal("user_id", ["abc"])`. */
  query?: string[]
  body?: unknown
  /** A user session secret. When present, the API key is omitted — see `send`. */
  session?: string
}

export interface AppwriteResponse {
  status: number
  body: unknown
  /** Lower-cased header names. `x-total-count` is the one that matters here. */
  headers: Record<string, string>
}

export type AppwriteTransport = (request: AppwriteRequest) => Promise<AppwriteResponse>

/** A response that never happened: DNS failure, timeout, TLS error, socket reset. */
const TRANSPORT_FAILURE: AppwriteResponse = { status: 0, body: { message: 'the Appwrite request could not be sent' }, headers: {} }

export function createFetchTransport(config: AppwriteConfig): AppwriteTransport {
  const base = config.endpoint.replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? 8_000
  return async (request: AppwriteRequest): Promise<AppwriteResponse> => {
    const url = new URL(`${base}${request.path}`)
    for (const query of request.query ?? []) url.searchParams.append('queries[]', query)

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-appwrite-project': config.projectId,
      // Pinning the response format keeps error shapes stable across server upgrades.
      'x-appwrite-response-format': '1.6.0',
    }
    if (request.session) {
      /*
       * Session requests authenticate as *the user*, not as the project. Sending
       * the API key alongside a session would make the call an admin call and
       * defeat the point of asking who a token belongs to.
       */
      headers['x-appwrite-session'] = request.session
      headers.cookie = `a_session_${config.projectId}=${request.session}`
    } else {
      headers['x-appwrite-key'] = config.apiKey
    }
    if (request.body !== undefined) headers['content-type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url.toString(), {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      })
      const text = await response.text()
      const received: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        received[key.toLowerCase()] = value
      })
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = { message: 'the Appwrite response was not JSON' }
        }
      }
      return { status: response.status, body, headers: received }
    } catch {
      return TRANSPORT_FAILURE
    } finally {
      clearTimeout(timer)
    }
  }
}

/* ==========================================================================
 * Error mapping
 * ========================================================================== */

/**
 * Appwrite's HTTP codes translated into the PostgREST codes the store already
 * understands. `fail()` in `supabaseStore.ts` records `error.code`, so the
 * distinction between "not found" and "unique violation" survives the swap and
 * the handler responses are byte-identical between backends.
 */
export const POSTGREST_CODE_FOR_STATUS: Readonly<Record<number, string>> = {
  0: '08006', // connection_failure
  400: '22P02', // invalid_text_representation
  401: '401',
  403: '42501', // insufficient_privilege
  404: 'PGRST116', // no rows for a single-row request
  409: '23505', // unique_violation
  429: '429',
  500: 'XX000',
  503: '57P03', // cannot_connect_now
}

interface AppwriteErrorBody {
  message?: string
  type?: string
  code?: number
}

function errorFrom(response: AppwriteResponse): PostgrestError | null {
  if (response.status >= 200 && response.status < 300) return null
  const body = (response.body ?? {}) as AppwriteErrorBody
  return {
    code: POSTGREST_CODE_FOR_STATUS[response.status] ?? 'XX000',
    message: typeof body.message === 'string' ? body.message : `Appwrite responded ${response.status}`,
    ...(typeof body.type === 'string' ? { details: body.type } : {}),
  }
}

/** A single-row request that matched nothing, or matched more than one. */
function cardinalityError(table: string, rows: number): PostgrestError {
  return {
    code: 'PGRST116',
    message: `JSON object requested, ${rows === 0 ? 'no rows' : 'multiple rows'} returned from ${table}`,
  }
}

/* ==========================================================================
 * Query DSL, row encoding
 * ========================================================================== */

type FilterOperator = 'eq' | 'in' | 'is'
interface Filter {
  operator: FilterOperator
  column: string
  value: unknown
}

type Operation = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

interface Pending {
  table: string
  operation: Operation
  values: unknown
  onConflict?: string
  ignoreDuplicates?: boolean
  filters: Filter[]
  orders: Array<{ column: string; ascending: boolean }>
  limit?: number
  columns?: string
  count?: 'exact' | 'planned' | 'estimated'
}

const query = (name: string, ...args: unknown[]): string =>
  `${name}(${args.map((argument) => JSON.stringify(argument)).join(',')})`

function filterQueries(filters: readonly Filter[]): string[] {
  const out: string[] = []
  for (const filter of filters) {
    if (filter.operator === 'is') {
      if (filter.value === null) out.push(query('isNull', filter.column))
      else out.push(query('equal', filter.column, [filter.value]))
      continue
    }
    if (filter.operator === 'in') {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value]
      // Appwrite caps a single `equal` at 100 values; a longer list is a bug in
      // the caller, not something to silently truncate.
      if (values.length > 100) throw new PersistenceError(`Refusing to send ${values.length} values for ${filter.column}`)
      out.push(query('equal', filter.column, values))
      continue
    }
    out.push(query('equal', filter.column, [filter.value]))
  }
  return out
}

function selectQueries(columns: string | undefined): string[] {
  if (!columns || columns.includes('*')) return []
  const attributes = columns
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0)
  if (attributes.length === 0) return []
  return [query('select', attributes)]
}

/**
 * Appwrite's `unique()` ids are 20 characters; Postgres defaults to `gen_random_uuid()`.
 * Generating the id here keeps ids uuid-shaped and therefore interchangeable
 * between the two backends — including in the URLs a client already holds.
 */
function newId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Row → document. Adds id/timestamps the database used to provide, encodes json text. */
function encode(table: string, values: unknown): Record<string, unknown> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new PersistenceError(`Cannot write a non-object into ${table}`)
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (key.startsWith('$')) continue
    out[key] = value
  }
  const now = new Date().toISOString()
  /*
   * `id` is a real attribute on every collection that declares one, mirroring the
   * document's `$id`.
   *
   * Appwrite's `$id` is not a filterable attribute, so the store's `.eq('id', …)`
   * — which is how `profiles.get` and every ownership pre-check work — has to have
   * a column to filter on. Generating it here (rather than on the read side only)
   * means a row written by this adapter is identical to a row written by Postgres,
   * including its id.
   */
  if (!out.id && collectionFor(table)?.attributes.some((attribute) => attribute.key === 'id')) out.id = newId()
  for (const column of JSON_TEXT_COLUMNS[table] ?? []) {
    const value = out[column]
    if (value === undefined) continue
    out[column] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  if (TIMESTAMPED_TABLES.includes(table)) {
    if (!out.created_at) out.created_at = now
    out.updated_at = now
  }
  return out
}

/** Document → row. Strips Appwrite's `$` metadata, restores the row shape. */
function decode(table: string, document: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(document)) {
    if (key === '$id') continue
    if (key === '$createdAt' || key === '$updatedAt') continue
    if (key.startsWith('$')) continue
    out[key] = value ?? null
  }
  out.id = String(document.$id ?? out.id ?? '')
  for (const column of JSON_TEXT_COLUMNS[table] ?? []) {
    const value = out[column]
    if (typeof value !== 'string') continue
    try {
      out[column] = JSON.parse(value)
    } catch {
      // A truncated or hand-edited value must not become a string where the
      // caller expects an array; the row adapters already handle null.
      out[column] = null
    }
  }
  return out
}

function project(row: Record<string, unknown>, columns: string | undefined): Record<string, unknown> {
  if (!columns || columns.trim() === '' || columns.includes('*')) return row
  const out: Record<string, unknown> = {}
  for (const column of columns.split(',').map((value) => value.trim())) {
    if (column in row) out[column] = row[column]
  }
  return out
}

/* ==========================================================================
 * The client
 * ========================================================================== */

export function createAppwriteClient(config: AppwriteConfig, transport?: AppwriteTransport): SupabaseLikeClient {
  const send = transport ?? createFetchTransport(config)
  const databaseId = config.databaseId ?? APPWRITE_DATABASE_ID
  const maxRows = config.maxRows ?? 2_000
  const maxWriteTargets = config.maxWriteTargets ?? 1_000
  const documentsPath = (table: string): string => `/databases/${databaseId}/collections/${table}/documents`

  /**
   * Sends a request, retrying only what is safe to retry.
   *
   * A GET that hits a 429 or a 5xx is retried with backoff — reading twice costs
   * nothing. A POST is not retried: a duplicated feedback row or roadmap is worse
   * than a visible error, and the caller can decide. This is the same reasoning
   * as an idempotency key, minus the machinery.
   */
  const request = async (input: AppwriteRequest, retries = 0): Promise<AppwriteResponse> => {
    let response = await send(input)
    let attempt = 0
    while (input.method === 'GET' && attempt < retries && (response.status === 0 || response.status === 429 || response.status >= 500)) {
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt + Math.floor(Math.random() * 100)))
      response = await send(input)
    }
    return response
  }

  const listDocuments = async (
    table: string,
    queries: string[],
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ documents: Array<Record<string, unknown>>; total: number | null; response: AppwriteResponse }> => {
    const full = [...queries]
    if (options.limit !== undefined) full.push(query('limit', options.limit))
    if (options.offset) full.push(query('offset', options.offset))
    const response = await request({ method: 'GET', path: documentsPath(table), query: full }, 2)
    const body = (response.body ?? {}) as { documents?: unknown; total?: unknown }
    const documents = Array.isArray(body.documents) ? (body.documents as Array<Record<string, unknown>>) : []
    const headerTotal = Number(response.headers['x-total-count'])
    const total = Number.isFinite(headerTotal) ? headerTotal : typeof body.total === 'number' ? body.total : null
    return { documents, total, response }
  }

  /**
   * Every matching document id, in pages. Needs the exact count for rate-limit
   * arithmetic, and the `x-total-count` header is not guaranteed by every
   * Appwrite version, so the fallback counts by paging.
   */
  const collectAll = async (
    table: string,
    queries: string[],
    options: { limit: number; ceiling: number },
  ): Promise<{ documents: Array<Record<string, unknown>>; total: number; error: PostgrestError | null }> => {
    const pageSize = Math.min(options.limit, 100)
    const documents: Array<Record<string, unknown>> = []
    let offset = 0
    let total = 0
    for (;;) {
      const page = await listDocuments(table, queries, { limit: pageSize, offset })
      /*
       * A failed page must be returned as an error, never as fewer rows. The
       * difference matters: "the database said no" and "this account has no
       * roadmaps" produce opposite next actions, and a silent empty result would
       * let a permissions failure look like an empty account.
       */
      const error = errorFrom(page.response)
      if (error) return { documents, total: offset, error }
      total = page.total ?? offset + page.documents.length
      documents.push(...page.documents)
      if (page.documents.length < pageSize) break
      offset += page.documents.length
      if (documents.length >= options.ceiling) {
        throw new PersistenceError(`${table} matched more than ${options.ceiling} documents; add a narrower filter`)
      }
    }
    return { documents, total, error: null }
  }

  /** Refuses to build an unscoped query on a collection whose rows belong to one account. */
  const assertScoped = (pending: Pending): void => {
    const ownerColumn = ownerColumnFor(pending.table)
    if (!ownerColumn) return
    const scoped = pending.filters.some(
      (filter) => filter.column === ownerColumn && (filter.operator === 'eq' || filter.operator === 'in') && filter.value !== null,
    )
    if (pending.operation === 'insert' || pending.operation === 'upsert') {
      const rows = Array.isArray(pending.values) ? pending.values : [pending.values]
      const every = rows.every((row) => row && typeof row === 'object' && ownerColumn in (row as Record<string, unknown>))
      // Guests may file anonymous feedback; every other write must name an owner.
      const guestAllowed = pending.table === 'feedback' && every
      if (!every && !guestAllowed) {
        throw new PersistenceError(`Refusing to write a ${pending.table} row with no ${ownerColumn}`)
      }
      return
    }
    if (!scoped) {
      /*
       * On Postgres this line is RLS. There is no policy engine here, so the
       * adapter is the policy engine: no `user_id` filter, no query.
       */
      throw new PersistenceError(`Refusing an unscoped ${pending.operation} on ${pending.table}`)
    }
  }

  /** Never PATCH a row that belongs to somebody else, even with a server key. */
  const assertOwned = (table: string, ownerColumn: string, existing: Record<string, unknown>, row: Record<string, unknown>): void => {
    const existingOwner = existing[ownerColumn]
    const rowOwner = row[ownerColumn]
    if (existingOwner !== undefined && existingOwner !== null && rowOwner !== undefined && String(existingOwner) !== String(rowOwner)) {
      throw new PersistenceError(`Refusing to update a ${table} document owned by another account`)
    }
  }

  const identityFilters = (table: string, row: Record<string, unknown>, onConflict: string | undefined): Filter[] => {
    const ownerColumn = ownerColumnFor(table)
    const filters: Filter[] = []
    if (onConflict) {
      for (const column of onConflict.split(',').map((value) => value.trim())) {
        if (!(column in row)) throw new PersistenceError(`Upsert on ${table} needs ${column}, which the row does not have`)
        filters.push({ operator: 'eq', column, value: row[column] })
      }
      return filters
    }
    if (!row.id) throw new PersistenceError(`Upsert on ${table} needs a conflict target`)
    filters.push({ operator: 'eq', column: 'id', value: row.id })
    if (ownerColumn && ownerColumn !== 'id' && ownerColumn in row) {
      filters.push({ operator: 'eq', column: ownerColumn, value: row[ownerColumn] })
    }
    return filters
  }

  const findByIdentity = async (table: string, filters: Filter[]): Promise<Record<string, unknown> | null> => {
    const page = await listDocuments(table, filterQueries(filters), { limit: 2 })
    if (page.response.status >= 400) throw new PersistenceError(`Could not read ${table}`, errorFrom(page.response)?.code)
    const documents = page.documents.map((document) => decode(table, document))
    if (documents.length > 1) {
      // Two rows for one identity means the unique index is missing. Say so
      // instead of picking one — the schema script exists to prevent this.
      throw new PersistenceError(`${table} has more than one row for the same upsert key; check the unique index`)
    }
    return documents[0] ?? null
  }

  const patch = async (table: string, id: string, values: Record<string, unknown>): Promise<AppwriteResponse> =>
    request({ method: 'PATCH', path: `${documentsPath(table)}/${encodeURIComponent(id)}`, body: values })

  const create = async (table: string, row: Record<string, unknown>): Promise<AppwriteResponse> => {
    const { id, ...attributes } = row
    const documentId = id ?? newId()
    // The mirror of `$id` described in `encode`: without it, `equal("id", […])`
    // would match nothing and `profiles.get` would report every account as empty.
    const data = collectionFor(table)?.attributes.some((attribute) => attribute.key === 'id') ? { ...attributes, id: documentId } : attributes
    return request({ method: 'POST', path: documentsPath(table), body: { documentId: String(documentId), data } })
  }

  /** The documents a filtered update or delete would touch. */
  const resolveTargets = async (pending: Pending, ceiling: number): Promise<Array<Record<string, unknown>>> => {
    const queries = [...filterQueries(pending.filters)]
    queries.push(query('limit', Math.min(pending.limit ?? ceiling, ceiling)))
    const response = await request({ method: 'GET', path: documentsPath(pending.table), query: queries }, 2)
    const error = errorFrom(response)
    if (error) throw new PersistenceError(`Could not read ${pending.table}`, error.code)
    const body = (response.body ?? {}) as { documents?: unknown; total?: unknown }
    const documents = Array.isArray(body.documents) ? (body.documents as Array<Record<string, unknown>>) : []
    const total = Number(body.total ?? response.headers['x-total-count'] ?? documents.length)
    if (Number.isFinite(total) && total > documents.length && !pending.limit) {
      // A partial write would leave the account half-reset and say "ok".
      throw new PersistenceError(`${pending.table} matched ${total} documents, over the ${ceiling}-document limit for a filtered ${pending.operation}`)
    }
    if (documents.length > maxWriteTargets) {
      throw new PersistenceError(`${pending.table} matched ${documents.length} documents, over the ${maxWriteTargets}-document limit for a filtered ${pending.operation}`)
    }
    return documents
  }

  const execute = async (pending: Pending, terminal: 'single' | 'maybeSingle' | 'list'): Promise<QueryResult<Record<string, unknown>>> => {
    assertScoped(pending)

    if (pending.operation === 'select') {
      const base = [...filterQueries(pending.filters), ...selectQueries(pending.columns)]
      for (const order of pending.orders) base.push(query(order.ascending ? 'orderAsc' : 'orderDesc', order.column))
      if (pending.limit !== undefined) {
        const page = await listDocuments(pending.table, base, { limit: Math.min(pending.limit, 5_000) })
        const error = errorFrom(page.response)
        if (error) return { data: null, error }
        const rows = page.documents.map((document) => decode(pending.table, document))
        return settle(rows, terminal, pending, page.total ?? rows.length)
      }
      const page = await collectAll(pending.table, base, { limit: maxRows, ceiling: maxRows })
      if (page.error) return { data: null, error: page.error }
      return settle(page.documents.map((document) => decode(pending.table, document)), terminal, pending, page.total)
    }

    if (pending.operation === 'insert') {
      const rows = (Array.isArray(pending.values) ? pending.values : [pending.values]).map((row) => encode(pending.table, row))
      const written: Array<Record<string, unknown>> = []
      for (const row of rows) {
        const response = await create(pending.table, row)
        const error = errorFrom(response)
        if (error) return { data: null, error }
        const body = (response.body ?? {}) as Record<string, unknown>
        written.push(decode(pending.table, { ...row, ...body, $id: body.$id ?? row.id }))
      }
      return settle(written, terminal, pending, written.length)
    }

    if (pending.operation === 'update') {
      const targets = await resolveTargets(pending, pending.limit ?? maxWriteTargets)
      const values = encode(pending.table, pending.values)
      delete (values as Record<string, unknown>).id
      const updated: Array<Record<string, unknown>> = []
      for (const document of targets) {
        const response = await patch(pending.table, String(document.$id), values)
        const error = errorFrom(response)
        if (error) return { data: null, error }
        updated.push(decode(pending.table, { ...document, ...values, ...((response.body ?? {}) as Record<string, unknown>) }))
      }
      return settle(updated, terminal, pending, updated.length)
    }

    if (pending.operation === 'delete') {
      const targets = await resolveTargets(pending, pending.limit ?? maxWriteTargets)
      const removed: Array<Record<string, unknown>> = []
      for (const document of targets) {
        const response = await request({ method: 'DELETE', path: `${documentsPath(pending.table)}/${encodeURIComponent(String(document.$id))}` })
        const error = errorFrom(response)
        // 404 here means it was already gone, which is the outcome the caller wanted.
        if (error && error.code !== 'PGRST116') return { data: null, error }
        removed.push(decode(pending.table, document))
      }
      return settle(removed, terminal, pending, removed.length)
    }

    /* upsert */
    const rows = (Array.isArray(pending.values) ? pending.values : [pending.values]) as Array<Record<string, unknown>>
    const ownerColumn = ownerColumnFor(pending.table) ?? 'id'
    const written: Array<Record<string, unknown>> = []
    for (const raw of rows) {
      const row = encode(pending.table, raw)
      const identity = identityFilters(pending.table, row, pending.onConflict)
      const existing = await findByIdentity(pending.table, identity)
      if (existing) {
        assertOwned(pending.table, ownerColumn, existing, row)
        if (pending.ignoreDuplicates) {
          written.push(existing)
          continue
        }
        const { id, ...attributes } = row
        void id
        const response = await patch(pending.table, String(existing.id), attributes)
        const error = errorFrom(response)
        if (error) return { data: null, error }
        written.push(decode(pending.table, { ...existing, ...attributes, ...((response.body ?? {}) as Record<string, unknown>) }))
        continue
      }
      const response = await create(pending.table, row)
      if (response.status === 409) {
        // Lost a race with a concurrent create: the row exists now, so update it.
        const raced = await findByIdentity(pending.table, identity)
        if (!raced) return { data: null, error: errorFrom(response) }
        assertOwned(pending.table, ownerColumn, raced, row)
        const { id, ...attributes } = row
        void id
        const retried = await patch(pending.table, String(raced.id), attributes)
        const error = errorFrom(retried)
        if (error) return { data: null, error }
        written.push(decode(pending.table, { ...raced, ...attributes }))
        continue
      }
      const error = errorFrom(response)
      if (error) return { data: null, error }
      const body = (response.body ?? {}) as Record<string, unknown>
      written.push(decode(pending.table, { ...row, ...body, $id: body.$id ?? row.id }))
    }
    return settle(written, terminal, pending, written.length)
  }

  const settle = (
    rows: Array<Record<string, unknown>>,
    terminal: 'single' | 'maybeSingle' | 'list',
    pending: Pending,
    count: number,
  ): QueryResult<Record<string, unknown>> => {
    // PostgREST returns no body for a write that asked for nothing back.
    const visible =
      pending.operation === 'select' ? rows : pending.columns ? rows.map((row) => project(row, pending.columns)) : null
    if (terminal === 'list') {
      return { data: (visible ?? null) as never, error: null, count: pending.count ? count : null }
    }
    if (!visible || visible.length === 0) {
      return terminal === 'single' ? { data: null, error: cardinalityError(pending.table, 0) } : { data: null, error: null, count: 0 }
    }
    if (visible.length > 1) {
      return { data: null, error: cardinalityError(pending.table, visible.length) }
    }
    return { data: visible[0] as never, error: null, count: 1 }
  }

  const build = <Row>(table: string): FilterBuilder<Row> => {
    const pending: Pending = { table, operation: 'select', values: undefined, filters: [], orders: [] }
    let settled = false
    const chain = (): unknown => api

    const run = (terminal: 'single' | 'maybeSingle' | 'list'): Promise<QueryResult<Row>> => {
      if (settled) throw new PersistenceError(`A ${table} query builder was executed twice`)
      settled = true
      return execute(pending, terminal) as Promise<QueryResult<Row>>
    }

    const api: Record<string, unknown> = {}
    api.select = (columns?: string, options?: { count?: 'exact' | 'planned' | 'estimated' }) => {
      if (columns !== undefined) pending.columns = columns
      if (options?.count) pending.count = options.count
      return chain()
    }
    api.insert = (values: unknown) => {
      pending.operation = 'insert'
      pending.values = values
      return chain()
    }
    api.update = (values: unknown) => {
      pending.operation = 'update'
      pending.values = values
      return chain()
    }
    api.upsert = (values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      pending.operation = 'upsert'
      pending.values = values
      if (options?.onConflict) pending.onConflict = options.onConflict
      if (options?.ignoreDuplicates) pending.ignoreDuplicates = true
      return chain()
    }
    api.delete = () => {
      pending.operation = 'delete'
      return chain()
    }
    api.eq = (column: string, value: unknown) => {
      pending.filters.push({ operator: 'eq', column, value })
      return chain()
    }
    api.in = (column: string, values: readonly unknown[]) => {
      pending.filters.push({ operator: 'in', column, value: values })
      return chain()
    }
    api.is = (column: string, value: null | boolean) => {
      pending.filters.push({ operator: 'is', column, value })
      return chain()
    }
    api.order = (column: string, options?: { ascending?: boolean }) => {
      pending.orders.push({ column, ascending: options?.ascending ?? true })
      return chain()
    }
    api.limit = (count: number) => {
      pending.limit = count
      return chain()
    }
    api.single = () => run('single')
    api.maybeSingle = () => run('maybeSingle')
    api.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      run('list').then(onFulfilled, onRejected)
    return api as unknown as FilterBuilder<Row>
  }

  const rpc = async <T>(fn: string, args: Record<string, unknown> = {}): Promise<QueryResult<T>> => {
    try {
      switch (fn) {
        case 'gm_consume_rate_limit':
          return { data: (await consumeRateLimit(args)) as never, error: null }
        case 'gm_cleanup_rate_limit':
          return { data: (await cleanupRateLimit()) as never, error: null }
        case 'gm_claim_nonce':
          return { data: (await claimNonce(args)) as never, error: null }
        default:
          // An undefined function in Postgres is 42883. Silently returning null
          // would turn a wiring mistake into "no rate limit at all".
          return { data: null, error: { code: '42883', message: `function ${fn} does not exist on the Appwrite backend` } }
      }
    } catch (error) {
      if (error instanceof PersistenceError) {
        return { data: null, error: { code: 'XX000', message: error.message } }
      }
      throw error
    }
  }

  /* ---------------------------------------------------------------- server primitives */

  /**
   * Fixed-window counting, Appwrite-shaped.
   *
   * Postgres does this with one `INSERT … ON CONFLICT DO UPDATE` that returns the
   * new count. There is no equivalent here, so the counter is *stored* as rows:
   * one document per hit, and the count is how many documents share a
   * `(key, bucket)` pair. Nothing is read-modified-written, so concurrent
   * requests cannot lose an increment the way a naive read-then-PATCH would.
   *
   * The cost is one extra read per rate-limited request and a write per hit,
   * which for this API (a few dozen requests per user per minute at most) is
   * cheaper than the alternative. `bucket` is derived from the wall clock rather
   * than stored as a timestamp so every isolate in every region agrees on the
   * window boundary — the same anchoring the SQL function does with `epoch`.
   */
  const consumeRateLimit = async (args: Record<string, unknown>): Promise<number> => {
    const key = String(args.p_key ?? '')
    if (key.length < 4 || key.length > 200) throw new PersistenceError('invalid rate-limit key')
    const windowSeconds = Math.min(86_400, Math.max(1, Math.trunc(Number(args.p_window_seconds) || 60)))
    const limit = Math.min(1_000_000, Math.max(1, Math.trunc(Number(args.p_limit) || 60)))
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
    const expiresAt = new Date((bucket + 1) * windowSeconds * 1000 + 60_000).toISOString()
    const created = await create('rate_limit_hits', { key, bucket, expires_at: expiresAt })
    const error = errorFrom(created)
    // Fail closed: if the counter cannot be written, the request must not be
    // treated as the first one of a fresh window.
    if (error) throw new PersistenceError(`rate limit store unavailable: ${error.code}`, error.code)
    const filters = [
      { operator: 'eq', column: 'key', value: key },
      { operator: 'eq', column: 'bucket', value: bucket },
    ] as Filter[]
    const page = await listDocuments('rate_limit_hits', filterQueries(filters), { limit: 1 })
    const probeError = errorFrom(page.response)
    if (probeError) throw new PersistenceError(`rate limit store unavailable: ${probeError.code}`, probeError.code)
    let count = page.total
    if (count === null) {
      const counted = await collectAll('rate_limit_hits', filterQueries(filters), { limit: limit + 1, ceiling: limit + 1 })
      if (counted.error) throw new PersistenceError(`rate limit store unavailable: ${counted.error.code}`, counted.error.code)
      count = counted.total
    }
    return Math.min(count, limit + 1)
  }

  /**
   * Deletes counters whose window has closed and whose grace period has passed.
   *
   * The SQL function takes `p_days`; here the rows carry their own `expires_at`,
   * so the honest reading of "cleanup" is "delete what has expired" — a stricter
   * bound than one day, and one that cannot delete a live window's counters.
   */
  const cleanupRateLimit = async (): Promise<number> => {
    const cutoff = new Date(Date.now() - 60_000).toISOString()
    let removed = 0
    for (let batch = 0; batch < 20; batch += 1) {
      const page = await listDocuments('rate_limit_hits', [query('lessThan', 'expires_at', [cutoff])], { limit: 100 })
      const error = errorFrom(page.response)
      if (error) throw new PersistenceError('rate limit cleanup failed', error.code)
      if (page.documents.length === 0) break
      for (const document of page.documents) {
        await request({ method: 'DELETE', path: `/databases/${databaseId}/collections/rate_limit_hits/documents/${encodeURIComponent(String(document.$id))}` })
        removed += 1
      }
      if (page.documents.length < 100) break
    }
    return removed
  }

  const nonceHash = async (nonce: string): Promise<string> => {
    const bytes = new TextEncoder().encode(nonce)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Claiming a nonce is an insert whose id is the nonce hash: the second attempt
   * conflicts, and a conflict is the entire replay defence. The nonce itself is
   * never stored — only its hash — so a leak of this collection does not hand
   * anybody a usable signature.
   */
  const claimNonce = async (args: Record<string, unknown>): Promise<boolean> => {
    const nonce = String(args.p_nonce ?? '')
    if (nonce.length < 8 || nonce.length > 200) throw new PersistenceError('invalid nonce')
    const ttl = Math.min(86_400, Math.max(30, Math.trunc(Number(args.p_ttl_seconds) || 300)))
    const hash = await nonceHash(nonce)
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    const response = await create('used_nonces', { id: hash, nonce_hash: hash, expires_at: expiresAt })
    if (response.status === 409) return false
    const error = errorFrom(response)
    if (error) throw new PersistenceError(`nonce store unavailable: ${error.code}`, error.code)
    return true
  }

  return {
    from: build,
    rpc: rpc as SupabaseLikeClient['rpc'],
    auth: {
      async getUser(session: string) {
        const response = await request({ method: 'GET', path: '/account', session }, 1)
        const body = (response.body ?? {}) as { $id?: unknown; email?: unknown }
        if (response.status >= 200 && response.status < 300 && typeof body.$id === 'string') {
          return { data: { user: { id: body.$id, email: typeof body.email === 'string' ? body.email : null } }, error: null }
        }
        return { data: { user: null }, error: errorFrom(response) ?? { code: '401', message: 'session rejected' } }
      },
    },
  }
}

/* ==========================================================================
 * Auth
 * ========================================================================== */

/**
 * The same `AuthCheck` contract as `createAuthVerifier`, with one deliberate
 * difference: no JWT shape check.
 *
 * `createAuthVerifier` rejects anything that is not three dot-separated parts,
 * which is right for a Supabase access token and wrong for an Appwrite session
 * secret (a long opaque string). Keeping the check would make every request
 * unauthenticated, so it is replaced by a length and character-range check that
 * still keeps obvious junk away from the network, and the actual verdict still
 * comes from the backend, never from the token's contents.
 */
export function createAppwriteAuthVerifier(
  config: AppwriteConfig,
  transport?: AppwriteTransport,
): (headers: Headers) => Promise<AuthCheck> {
  const client = createAppwriteClient(config, transport)
  return async function verifyAuth(headers: Headers): Promise<AuthCheck> {
    const header = headers.get('authorization') ?? headers.get('Authorization')
    if (!header) return { status: 'none' }
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) return { status: 'invalid', reason: 'malformed-authorization-header' }
    const token = match[1]!.trim()
    if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
      return { status: 'invalid', reason: 'not-a-session-secret' }
    }
    try {
      const { data, error } = await client.auth.getUser(token)
      if (error || !data.user?.id) return { status: 'invalid', reason: 'token-rejected' }
      return { status: 'valid', userId: data.user.id }
    } catch {
      return { status: 'invalid', reason: 'auth-unreachable' }
    }
  }
}

/* ==========================================================================
 * Composition
 * ========================================================================== */

/**
 * The rate-limit and nonce stores, named for the backend they run on here.
 *
 * They are the *same factories* as the Postgres ones, because they do not speak
 * SQL at all — they call `rpc('gm_consume_rate_limit')`, `rpc('gm_cleanup_rate_limit')`
 * and `rpc('gm_claim_nonce')`, and this client answers those names (see `rpc`
 * above). Re-exporting them under Appwrite names keeps `deno.ts` readable without
 * forking a security primitive, which is the last place a fork belongs.
 */
export const createAppwriteFixedWindowStore = createPostgresFixedWindowStore
export const createAppwriteNonceStore = createPostgresNonceStore

/**
 * Reads the environment and returns the backend this deployment runs on.
 *
 * Order matters: an Appwrite configuration that is present but incomplete must
 * not fall through to Supabase, because "silently persisted somewhere else" is
 * how a data-residency promise is broken. An incomplete block is reported.
 */
export interface BackendSelection {
  kind: 'appwrite' | 'supabase' | 'none'
  reason: string
}

export function selectBackend(env: (name: string) => string | undefined): BackendSelection {
  const appwriteEndpoint = env('APPWRITE_ENDPOINT')?.trim()
  const appwriteProject = env('APPWRITE_PROJECT_ID')?.trim()
  const appwriteKey = env('APPWRITE_API_KEY')?.trim()
  const appwriteParts = [appwriteEndpoint, appwriteProject, appwriteKey].filter(Boolean).length
  if (appwriteParts === 3) return { kind: 'appwrite', reason: 'APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY are all set' }
  if (appwriteParts > 0) {
    const missing = [
      !appwriteEndpoint ? 'APPWRITE_ENDPOINT' : null,
      !appwriteProject ? 'APPWRITE_PROJECT_ID' : null,
      !appwriteKey ? 'APPWRITE_API_KEY' : null,
    ].filter((name): name is string => Boolean(name))
    return { kind: 'none', reason: `Appwrite is configured but incomplete; missing ${missing.join(', ')}` }
  }
  const supabaseUrl = env('SUPABASE_URL')?.trim()
  const supabaseAnonKey = env('SUPABASE_ANON_KEY')?.trim()
  if (supabaseUrl && supabaseAnonKey) return { kind: 'supabase', reason: 'SUPABASE_URL and SUPABASE_ANON_KEY are set' }
  return { kind: 'none', reason: 'no backend credentials are set; the API runs read-only on the bundled sample graph' }
}

export function appwriteConfigFromEnv(env: (name: string) => string | undefined): AppwriteConfig {
  const endpoint = env('APPWRITE_ENDPOINT')?.trim()
  const projectId = env('APPWRITE_PROJECT_ID')?.trim()
  const apiKey = env('APPWRITE_API_KEY')?.trim()
  if (!endpoint || !projectId || !apiKey) {
    throw new PersistenceError('Appwrite is not configured: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY are all required')
  }
  const databaseId = env('APPWRITE_DATABASE_ID')?.trim()
  return { endpoint, projectId, apiKey, ...(databaseId ? { databaseId } : {}) }
}
