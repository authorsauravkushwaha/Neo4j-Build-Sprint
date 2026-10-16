/**
 * The Appwrite adapter, tested where it can actually be wrong.
 *
 * The repository layer above it is backend-agnostic by construction, so the risk
 * in this module is wire-level: a filter that never makes it into the request, a
 * query string Appwrite would reject, an id that is not a uuid, a scope guard
 * that does not fire, an error code that loses its meaning in translation, or a
 * retry that duplicates a write. Each of those has a test here.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  POSTGREST_CODE_FOR_STATUS,
  appwriteConfigFromEnv,
  createAppwriteAuthVerifier,
  createAppwriteClient,
  createFetchTransport,
  selectBackend,
} from '../../supabase/functions/_shared/platform/appwrite.ts'
import { PersistenceError } from '../../supabase/functions/_shared/platform/supabaseStore.ts'
import { APPWRITE_COLLECTIONS, provisioningCommands, tablesUsedByStore, conflictTargetsUsedByStore } from '../../supabase/functions/_shared/platform/appwriteSchema.ts'
import { createFakeAppwrite } from '../helpers/fakeAppwrite.ts'

const config = {
  endpoint: 'https://appwrite.example.test/v1',
  projectId: 'gm',
  apiKey: 'a-very-secret-key', // secret-scan:allow — a fixture; the fake transport never sends it anywhere
}

describe('the Appwrite client', () => {
  let backend: ReturnType<typeof createFakeAppwrite>
  let client: ReturnType<typeof createAppwriteClient>

  beforeEach(() => {
    backend = createFakeAppwrite()
    client = createAppwriteClient(config, backend.transport)
  })

  it('translates a filtered select into the query strings Appwrite accepts', async () => {
    backend.seed('saved_roadmaps', [
      { $id: 'r1', user_id: 'alice', title: 'A', updated_at: '2026-01-02T00:00:00.000Z' },
      { $id: 'r2', user_id: 'bob', title: 'B', updated_at: '2026-01-01T00:00:00.000Z' },
    ])
    const { data, error } = await client
      .from<Record<string, unknown>>('saved_roadmaps')
      .select('*')
      .eq('user_id', 'alice')
      .order('updated_at', { ascending: false })
      .limit(20)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data?.[0]?.title).toBe('A')
    // The wire format, pinned: this is the part that silently breaks on upgrade.
    expect(backend.requests[0]!.query).toEqual([
      'equal("user_id",["alice"])',
      'orderDesc("updated_at")',
      'limit(20)',
    ])
    // `select('*')` means "all attributes", and Appwrite has no `*` in a select
    // query — sending one is a 400.
    expect(backend.requests[0]!.query?.some((entry) => entry.startsWith('select('))).toBe(false)
  })

  it('keeps uuids as the document id, so a client URL survives a backend swap', async () => {
    const { data, error } = await client
      .from<Record<string, unknown>>('bookmarks')
      .insert({ user_id: 'alice', target_type: 'skill', target_id: 'skill:python-programming', note: null })
      .select('*')
      .single()
    expect(error).toBeNull()
    expect(String(data?.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(backend.documents('bookmarks')).toHaveLength(1)
  })

  it('returns the row shape the handlers expect, not the document shape', async () => {
    backend.seed('saved_roadmaps', [{ $id: 'r1', $createdAt: 'x', $updatedAt: 'y', user_id: 'alice', milestones: '[{"label":"a"}]' }])
    const { data } = await client.from<Record<string, unknown>>('saved_roadmaps').select('*').eq('user_id', 'alice').maybeSingle()
    expect(data).toMatchObject({ id: 'r1', user_id: 'alice', milestones: [{ label: 'a' }] })
    expect(Object.keys(data ?? {}).some((key) => key.startsWith('$'))).toBe(false)
  })

  it('serialises arrays on the way in, because Appwrite has no array type', async () => {
    await client.from('profiles').insert({ id: 'alice', interests: ['graphs', 'linux'], reduced_motion: true })
    const stored = backend.documents('profiles')[0]!
    expect(stored.interests).toBe('["graphs","linux"]')
    expect(stored.reduced_motion).toBe(true)
  })

  it('refuses an unscoped read on a collection whose rows belong to one account', async () => {
    await expect(client.from('roadmap_tasks').select('*')).rejects.toThrow(PersistenceError)
    await expect(client.from('roadmap_tasks').select('*').eq('roadmap_id', 'abc')).rejects.toThrow(/unscoped/)
    // Nothing was sent: the guard is not a post-hoc check.
    expect(backend.requests).toHaveLength(0)
  })

  it('refuses an unscoped delete, which is the mistake that erases an account', async () => {
    backend.seed('user_skill_progress', [{ $id: 's1', user_id: 'alice', skill_id: 'skill:x' }])
    await expect(client.from('user_skill_progress').delete().eq('skill_id', 'skill:x')).rejects.toThrow(/unscoped delete/)
    expect(backend.documents('user_skill_progress')).toHaveLength(1)
  })

  it('refuses to write a user-owned row with no owner', async () => {
    await expect(client.from('saved_roadmaps').insert({ title: 'mine' })).rejects.toThrow(/no user_id/)
    await expect(client.from('bookmarks').upsert({ target_id: 'skill:x' }, { onConflict: 'user_id,target_id' })).rejects.toThrow(PersistenceError)
  })

  it('allows the one anonymous write the API has: guest feedback', async () => {
    const { error } = await client.from('feedback').insert({ user_id: null, kind: 'bug', message: 'broken', contact: null })
    expect(error).toBeNull()
    expect(backend.documents('feedback')[0]!.user_id).toBeNull()
  })

  it('makes an upsert idempotent on the conflict target Postgres would use', async () => {
    const row = { user_id: 'alice', skill_id: 'skill:python-programming', state: 'learning', quiz_score: null, updated_at: 'ignored' }
    await client.from('user_skill_progress').upsert(row, { onConflict: 'user_id,skill_id' })
    await client.from('user_skill_progress').upsert({ ...row, state: 'confident' }, { onConflict: 'user_id,skill_id' })

    const documents = backend.documents('user_skill_progress')
    expect(documents).toHaveLength(1)
    expect(documents[0]!.state).toBe('confident')
    // The second write was a PATCH of the found document, not another create.
    expect(backend.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/documents'))).toHaveLength(1)
  })

  it('survives losing a race with a concurrent create on the unique index', async () => {
    const raced = createFakeAppwrite()
    raced.seed('bookmarks', [
      {
        $id: 'existing',
        id: 'existing',
        user_id: 'alice',
        target_type: 'skill',
        target_id: 'skill:neo4j',
        note: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ])
    // The pre-read misses, as it would if another request committed a moment later.
    raced.failNext({ status: 200, methods: ['GET'], pathIncludes: 'collections/bookmarks', times: 1 })
    const racedClient = createAppwriteClient(config, raced.transport)
    const { data, error } = await racedClient
      .from<Record<string, unknown>>('bookmarks')
      .upsert({ user_id: 'alice', target_type: 'skill', target_id: 'skill:neo4j', note: 'keep me' }, { onConflict: 'user_id,target_id' })
      .select('*')
      .single()

    expect(error).toBeNull()
    // The create collided with the unique index, so the adapter re-read and
    // patched the winner instead of reporting a failure the caller cannot act on.
    expect(data?.id).toBe('existing')
    expect(data?.note).toBe('keep me')
    expect(raced.documents('bookmarks')).toHaveLength(1)
    expect(raced.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(raced.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1)
  })

  it('never patches a document that belongs to another account', async () => {
    // Bob's row matches the upsert key only if the adapter forgot the user filter.
    backend.seed('user_skill_progress', [{ $id: 'bobs', user_id: 'bob', skill_id: 'skill:python-programming', state: 'new' }])
    const { error } = await client
      .from('user_skill_progress')
      .upsert({ user_id: 'alice', skill_id: 'skill:python-programming', state: 'confident' }, { onConflict: 'user_id,skill_id' })
    expect(error).toBeNull()
    // Alice's write created her own row; Bob's is untouched.
    const documents = backend.documents('user_skill_progress')
    expect(documents.find((document) => document.user_id === 'bob')?.state).toBe('new')
    expect(documents.find((document) => document.user_id === 'alice')?.state).toBe('confident')
  })

  it('reports a single-row request that matched nothing the way PostgREST does', async () => {
    const { data, error } = await client.from('profiles').select('*').eq('id', 'alice').maybeSingle()
    expect(data).toBeNull()
    expect(error).toBeNull()

    const single = await client.from('profiles').select('*').eq('id', 'alice').single()
    expect(single.data).toBeNull()
    expect(single.error?.code).toBe('PGRST116')
  })

  it('counts matching documents when the total header is withheld', async () => {
    // The count is paged in tens, so the clock is pinned: the window bucket is
    // derived from it, and a minute boundary mid-test would strand the seed.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-16T03:04:05.000Z'))
      const bucket = Math.floor(Date.parse('2026-10-16T03:04:05.000Z') / 1000 / 60)
      backend.setTotalCountHeader(false)
      for (let index = 0; index < 130; index += 1) {
        backend.seed('rate_limit_hits', [{ key: 'hashed-alice', bucket, expires_at: '2030-01-01T00:00:00.000Z' }])
      }
      const consumed = await client.rpc<number>('gm_consume_rate_limit', { p_key: 'hashed-alice', p_window_seconds: 60, p_limit: 1000 })
      expect(consumed.error).toBeNull()
      // 130 seeded hits plus this request's own.
      expect(consumed.data).toBe(131)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed when the rate-limit store cannot be written', async () => {
    backend.failNext({ status: 500, message: 'internal error', type: 'general_argument_invalid' })
    const consumed = await client.rpc<number>('gm_consume_rate_limit', { p_key: 'hashed-alice', p_window_seconds: 60, p_limit: 1000 })
    expect(consumed.data).toBeNull()
    expect(consumed.error?.code).toBe('XX000')
  })

  it('caps the rate-limit count at limit + 1, exactly like the SQL function', async () => {
    expect((await client.rpc<number>('gm_consume_rate_limit', { p_key: 'k'.repeat(8), p_window_seconds: 60, p_limit: 2 })).data).toBe(1)
    expect((await client.rpc<number>('gm_consume_rate_limit', { p_key: 'k'.repeat(8), p_window_seconds: 60, p_limit: 2 })).data).toBe(2)
    expect((await client.rpc<number>('gm_consume_rate_limit', { p_key: 'k'.repeat(8), p_window_seconds: 60, p_limit: 2 })).data).toBe(3)
    expect((await client.rpc<number>('gm_consume_rate_limit', { p_key: 'k'.repeat(8), p_window_seconds: 60, p_limit: 2 })).data).toBe(3)
  })

  it('rejects a malformed rate-limit key instead of counting it', async () => {
    const response = await client.rpc<number>('gm_consume_rate_limit', { p_key: 'ab', p_window_seconds: 60, p_limit: 10 })
    expect(response.data).toBeNull()
    expect(response.error?.message).toMatch(/invalid rate-limit key/)
  })

  it('claims a nonce once, and stores only its hash', async () => {
    const first = await client.rpc<boolean>('gm_claim_nonce', { p_nonce: 'nonce-value-123', p_ttl_seconds: 300 })
    const second = await client.rpc<boolean>('gm_claim_nonce', { p_nonce: 'nonce-value-123', p_ttl_seconds: 300 })
    expect(first.data).toBe(true)
    expect(second.data).toBe(false)
    const stored = backend.documents('used_nonces')
    expect(stored).toHaveLength(1)
    expect(String(stored[0]!.$id)).toMatch(/^[0-9a-f]{64}$/)
    // A leak of this collection must not hand anybody a usable signature.
    expect(JSON.stringify(stored)).not.toContain('nonce-value-123')
  })

  it('fails closed when the nonce store is unreachable', async () => {
    backend.failNext({ status: 503, message: 'unavailable', type: 'general_service_unavailable' })
    const response = await client.rpc<boolean>('gm_claim_nonce', { p_nonce: 'nonce-value-456', p_ttl_seconds: 300 })
    expect(response.error?.message).toMatch(/nonce store unavailable/)
  })

  it('says so when a stored procedure has no Appwrite equivalent, rather than allowing everything', async () => {
    const response = await client.rpc('gm_imaginary_function', {})
    expect(response.error?.code).toBe('42883')
  })

  it('translates Appwrite statuses into the codes the store already handles', async () => {
    backend.failNext({ status: 403, message: 'forbidden', type: 'user_unauthorized' })
    const forbidden = await client.from('saved_roadmaps').select('*').eq('user_id', 'alice')
    expect(forbidden.error?.code).toBe('42501')

    // A write, not a read: a retried 429 on a create would duplicate the row, so
    // the adapter reports it instead.
    backend.failNext({ status: 429, message: 'slow down', type: 'general_rate_limit_exceeded' })
    const limited = await client.from('bookmarks').insert({ user_id: 'alice', target_type: 'skill', target_id: 'skill:x' })
    expect(limited.error?.code).toBe('429')
    expect(POSTGREST_CODE_FOR_STATUS[0]).toBe('08006')
  })

  it('retries a read that failed, and does not retry a write', async () => {
    backend.seed('saved_roadmaps', [{ $id: 'r1', user_id: 'alice' }])
    backend.failNext({ status: 500, message: 'flaky', methods: ['GET'], times: 1 })
    const read = await client.from('saved_roadmaps').select('*').eq('user_id', 'alice')
    expect(read.error).toBeNull()
    expect(read.data).toHaveLength(1)

    backend.failNext({ status: 500, message: 'flaky', methods: ['POST'], times: 1 })
    const write = await client.from('bookmarks').insert({ user_id: 'alice', target_type: 'skill', target_id: 'skill:x' })
    expect(write.error?.code).toBe('XX000')
    // Exactly one create: a retried write is how duplicate rows appear.
    expect(backend.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('refuses a query builder that is executed twice', async () => {
    const builder = client.from('saved_roadmaps').select('*').eq('user_id', 'alice')
    await builder
    await expect(builder).rejects.toThrow(/executed twice/)
  })

  it('stops a filtered update rather than writing half a batch', async () => {
    const small = createAppwriteClient({ ...config, maxWriteTargets: 2 }, backend.transport)
    for (let index = 0; index < 5; index += 1) {
      backend.seed('roadmap_tasks', [{ $id: `t${index}`, user_id: 'alice', roadmap_id: 'r1', status: 'not-started' }])
    }
    await expect(
      small.from('roadmap_tasks').update({ status: 'not-started' }).eq('user_id', 'alice').eq('roadmap_id', 'r1'),
    ).rejects.toThrow(/over the 2-document limit/)
    expect(backend.documents('roadmap_tasks')).toHaveLength(5)
  })
})

describe('the Appwrite session verifier', () => {
  it('accepts a real session secret, which the JWT pre-check would have rejected', async () => {
    const backend = createFakeAppwrite()
    const session = backend.openSession('user-alice')
    const verify = createAppwriteAuthVerifier(config, backend.transport)

    expect(await verify(new Headers())).toEqual({ status: 'none' })
    expect(await verify(new Headers({ authorization: 'Token abcdefghijklmnopqrstuvwxyz' }))).toEqual({
      status: 'invalid',
      reason: 'malformed-authorization-header',
    })
    expect(await verify(new Headers({ authorization: 'Bearer short' }))).toEqual({ status: 'invalid', reason: 'not-a-session-secret' })
    expect(await verify(new Headers({ authorization: `Bearer ${session}` }))).toEqual({ status: 'valid', userId: 'user-alice' })
  })

  it('rejects a session the backend does not know', async () => {
    const backend = createFakeAppwrite()
    const verify = createAppwriteAuthVerifier(config, backend.transport)
    expect(await verify(new Headers({ authorization: `Bearer ${'x'.repeat(40)}` }))).toEqual({
      status: 'invalid',
      reason: 'token-rejected',
    })
  })

  it('fails closed when the auth server cannot be reached', async () => {
    const backend = createFakeAppwrite()
    const session = backend.openSession('user-alice')
    backend.failNext({ status: 500, methods: ['GET'], pathIncludes: '/account' })
    backend.failNext({ status: 500, methods: ['GET'], pathIncludes: '/account' })
    const verify = createAppwriteAuthVerifier(config, backend.transport)
    const check = await verify(new Headers({ authorization: `Bearer ${session}` }))
    expect(check.status).toBe('invalid')
  })
})

describe('the fetch transport', () => {
  const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds the URL, headers and body Appwrite expects', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse(201, { $id: 'doc-1' })
    })
    const transport = createFetchTransport(config)
    const response = await transport({
      method: 'POST',
      path: '/databases/graphmentor/collections/bookmarks/documents',
      query: ['equal("user_id",["alice"])', 'limit(1)'],
      body: { documentId: 'doc-1', data: { user_id: 'alice' } },
    })

    expect(response.status).toBe(201)
    const requested = new URL(calls[0]!.url)
    expect(`${requested.origin}${requested.pathname}`).toBe(
      'https://appwrite.example.test/v1/databases/graphmentor/collections/bookmarks/documents',
    )
    // Round trip: what Appwrite reads back out of `queries[]` is exactly what the
    // adapter built, including the quoting and the commas.
    expect(requested.searchParams.getAll('queries[]')).toEqual(['equal("user_id",["alice"])', 'limit(1)'])
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-appwrite-project']).toBe('gm')
    expect(headers['x-appwrite-key']).toBe('a-very-secret-key')
    expect(headers['content-type']).toBe('application/json')
    expect(calls[0]!.init.body).toBe(JSON.stringify({ documentId: 'doc-1', data: { user_id: 'alice' } }))
  })

  it('sends a session instead of the API key, so the call is attributed to the user', async () => {
    const calls: Array<RequestInit> = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init)
      return jsonResponse(200, { $id: 'user-alice' })
    })
    await createFetchTransport(config)({ method: 'GET', path: '/account', session: 'session-secret' })
    const headers = calls[0]!.headers as Record<string, string>
    expect(headers['x-appwrite-session']).toBe('session-secret')
    expect(headers['x-appwrite-key']).toBeUndefined()
  })

  it('turns a network failure into a response, not an exception', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const response = await createFetchTransport(config)({ method: 'GET', path: '/account' })
    expect(response.status).toBe(0)
    expect(await createAppwriteClient(config, createFetchTransport(config)).auth.getUser('x'.repeat(40))).toMatchObject({
      data: { user: null },
    })
  })

  it('gives up on a hung request instead of holding the caller open', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    )
    const response = await createFetchTransport({ ...config, timeoutMs: 20 })({ method: 'GET', path: '/account' })
    expect(response.status).toBe(0)
  })

  it('does not throw on a non-JSON body', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>gateway error</html>', { status: 502 }))
    const response = await createFetchTransport(config)({ method: 'GET', path: '/account' })
    expect(response.status).toBe(502)
    expect(response.status).toBeGreaterThan(0)
  })
})

describe('backend selection', () => {
  const env = (values: Record<string, string>) => (name: string) => values[name]

  it('prefers an Appwrite configuration, and says why', () => {
    const selection = selectBackend(env({ APPWRITE_ENDPOINT: 'https://a.test/v1', APPWRITE_PROJECT_ID: 'p', APPWRITE_API_KEY: 'k' }))
    expect(selection.kind).toBe('appwrite')
    expect(selection.reason).toMatch(/all set/)
  })

  it('reports a half-configured Appwrite rather than quietly using Supabase', () => {
    const selection = selectBackend(env({ APPWRITE_ENDPOINT: 'https://a.test/v1', SUPABASE_URL: 'https://s.test', SUPABASE_ANON_KEY: 'anon' }))
    expect(selection.kind).toBe('none')
    expect(selection.reason).toMatch(/missing APPWRITE_PROJECT_ID, APPWRITE_API_KEY/)
  })

  it('falls back to Supabase, and to a read-only sample graph with nothing set', () => {
    expect(selectBackend(env({ SUPABASE_URL: 'https://s.test', SUPABASE_ANON_KEY: 'anon' })).kind).toBe('supabase')
    expect(selectBackend(env({})).kind).toBe('none')
    expect(selectBackend(env({})).reason).toMatch(/read-only/)
  })

  it('names every missing credential when the config is built', () => {
    expect(() => appwriteConfigFromEnv(env({ APPWRITE_ENDPOINT: 'https://a.test/v1' }))).toThrow(/APPWRITE_PROJECT_ID and APPWRITE_API_KEY/)
    expect(appwriteConfigFromEnv(env({ APPWRITE_ENDPOINT: 'https://a.test/v1', APPWRITE_PROJECT_ID: 'p', APPWRITE_API_KEY: 'k' }))).toMatchObject({
      endpoint: 'https://a.test/v1',
      projectId: 'p',
    })
  })
})

describe('the collection schema', () => {
  it('declares a unique index for every conflict target the store upserts on', async () => {
    const source = readFileSync('supabase/functions/_shared/platform/supabaseStore.ts', 'utf8')
    const conflicts = conflictTargetsUsedByStore(source)
    expect(conflicts.length).toBeGreaterThanOrEqual(4)
    for (const { table, columns } of conflicts) {
      const collection = APPWRITE_COLLECTIONS.find((entry) => entry.id === table)
      expect(collection, `No collection for ${table}`).toBeDefined()
      // Order-insensitive: the conflict target and the index describe the same set.
      const index = collection!.indexes.find(
        (entry) =>
          entry.type === 'unique' &&
          entry.attributes.length === columns.length &&
          [...entry.attributes].sort().join(',') === [...columns].sort().join(','),
      )
      expect(index, `No unique index on ${table}(${columns.join(', ')}) — the upsert would duplicate rows`).toBeDefined()
    }
  })

  it('covers every table the store touches', async () => {
    const source = readFileSync('supabase/functions/_shared/platform/supabaseStore.ts', 'utf8')
    const used = tablesUsedByStore(source)
    expect(used.length).toBeGreaterThanOrEqual(6)
    for (const table of used) {
      expect(APPWRITE_COLLECTIONS.map((collection) => collection.id), `${table} has no Appwrite collection`).toContain(table)
    }
  })

  it('marks every user-owned collection as user-scoped, and nothing else', () => {
    const scopes = Object.fromEntries(APPWRITE_COLLECTIONS.map((collection) => [collection.id, collection.scope]))
    expect(scopes).toMatchObject({
      profiles: 'self',
      saved_roadmaps: 'user',
      roadmap_tasks: 'user',
      user_skill_progress: 'user',
      bookmarks: 'user',
      feedback: 'user',
      rate_limit_hits: 'server',
      used_nonces: 'server',
    })
  })

  it('gives every account-owned collection a way to be scoped and deleted by its owner', () => {
    for (const collection of APPWRITE_COLLECTIONS) {
      const keys = collection.attributes.map((attribute) => attribute.key)
      if (collection.scope === 'server') {
        // Infrastructure rows belong to nobody, and must expire: an unexpiring
        // table is a slow-motion disk-full incident.
        expect(keys, `${collection.id} has no expiry`).toContain('expires_at')
        expect(collection.indexes.some((index) => index.attributes.includes('expires_at'))).toBe(true)
        continue
      }
      const owner = collection.scope === 'self' ? 'id' : 'user_id'
      expect(keys, `${collection.id} cannot be scoped to an account`).toContain(owner)
      // Every query the adapter builds filters on this, and a filter on an
      // unindexed attribute is a full scan.
      expect(collection.indexes.some((index) => index.attributes.includes(owner))).toBe(true)
    }
  })

  it('prints provisioning commands that match the declared schema', () => {
    const commands = provisioningCommands('gm-test')
    const argv = commands.map((command) => command.argv.join(' '))
    // One command per collection, per attribute, per index, plus the database.
    const expected = 1 + APPWRITE_COLLECTIONS.reduce((total, collection) => total + 1 + collection.attributes.length + collection.indexes.length, 0)
    expect(commands).toHaveLength(expected)
    expect(argv[0]).toBe('appwrite databases create --database-id gm-test --name GraphMentor AI')
    expect(argv.some((line) => line.includes('create-collection --database-id gm-test --collection-id saved_roadmaps'))).toBe(true)
    expect(argv.some((line) => line.includes('create-float-attribute') && line.includes('--key estimated_hours_low'))).toBe(true)
    expect(argv.some((line) => line.includes('create-datetime-attribute') && line.includes('--key created_at'))).toBe(true)
    expect(argv.some((line) => line.includes('--type unique') && line.includes('--attributes user_id target_id'))).toBe(true)
    // The example database id is the default, so a copy-paste run provisions the
    // same database the adapter reads from.
    expect(provisioningCommands().some((command) => command.argv.includes('graphmentor'))).toBe(true)
    for (const command of commands) expect(command.why.length).toBeGreaterThan(8)
  })

  it('never creates a collection that any client role can read', () => {
    const commands = provisioningCommands()
    const collections = commands.filter((command) => command.argv.includes('create-collection'))
    expect(collections).toHaveLength(APPWRITE_COLLECTIONS.length)
    for (const command of collections) {
      expect(command.argv.join(' ')).not.toMatch(/--permissions (?!$)/)
    }
  })
})
