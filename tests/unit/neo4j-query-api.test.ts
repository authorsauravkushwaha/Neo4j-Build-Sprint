/**
 * Unit tests for the shared Neo4j Query API client and its response decoder.
 *
 * These use a fake `fetch`. They prove the request shape, the classification of
 * failures and the retry rules. They do NOT prove that a real AuraDB instance
 * accepts the request; that needs a live run of `npm run seed:neo4j -- --check`.
 */
import { describe, expect, it } from 'vitest'
import {
  createQueryApiClient,
  decodeQueryApiResponse,
  failureForCode,
  failureOf,
  parseQueryApiUrl,
  type QueryApiEvent,
} from '../../supabase/functions/_shared/core/neo4jQueryApi.ts'
import { createNeo4jReader } from '../../supabase/functions/_shared/core/neo4jReader.ts'

const URL_OK = 'https://abc123.databases.neo4j.io/db/neo4j/query/v2'

type Responder = (init: RequestInit, call: number) => Response | Promise<Response>

function fakeFetch(responders: Responder[]) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = calls.length
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const responder = responders[Math.min(call, responders.length - 1)]
    return responder(init ?? {}, call)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const v2Ok = (values: unknown[][], fields: string[]) =>
  new Response(JSON.stringify({ data: { fields, values }, bookmarks: [], queryType: 'r' }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  })

const errorBody = (code: string) =>
  new Response(JSON.stringify({ errors: [{ code, message: 'redacted for test' }] }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  })

function baseConfig(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createQueryApiClient>[0]> = {}) {
  return {
    queryUrl: URL_OK,
    username: 'neo4j',
    password: 'test-password-not-real', // secret-scan:allow
    timeoutMs: 1000,
    maxRows: 50,
    fetchImpl,
    ...extra,
  }
}

describe('parseQueryApiUrl', () => {
  it('accepts the Aura Query API URL and extracts the database name', () => {
    expect(parseQueryApiUrl(URL_OK)).toEqual({ ok: true, database: 'neo4j' })
    expect(parseQueryApiUrl('https://x.databases.neo4j.io/db/graphmentor/query/v2/')).toEqual({ ok: true, database: 'graphmentor' })
  })

  it('refuses plain http unless explicitly allowed for a local instance', () => {
    const local = 'http://localhost:7474/db/neo4j/query/v2'
    expect(parseQueryApiUrl(local).ok).toBe(false)
    expect(parseQueryApiUrl(local, { allowHttp: true })).toEqual({ ok: true, database: 'neo4j' })
  })

  it('refuses credentials embedded in the URL', () => {
    const result = parseQueryApiUrl('https://neo4j:secret@x.databases.neo4j.io/db/neo4j/query/v2') // secret-scan:allow
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).not.toMatch(/secret/)
  })

  it('requires the /db/<name>/query/v2 path, so Bolt or Browser addresses are rejected', () => {
    expect(parseQueryApiUrl('https://x.databases.neo4j.io').ok).toBe(false)
    expect(parseQueryApiUrl('https://x.databases.neo4j.io/db/neo4j/query/v1').ok).toBe(false)
    expect(parseQueryApiUrl('neo4j+s://x.databases.neo4j.io').ok).toBe(false)
    expect(parseQueryApiUrl('not a url').ok).toBe(false)
  })
})

describe('decodeQueryApiResponse', () => {
  it('decodes the v2 shape (data.fields + data.values) into named rows', () => {
    const decoded = decodeQueryApiResponse({ data: { fields: ['id', 'name'], values: [['a', 'Alpha'], ['b', 'Beta']] } })
    expect(decoded.shape).toBe('v2')
    expect(decoded.rows).toEqual([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ])
  })

  it('decodes the v1 shape (results[0].data[].row)', () => {
    const decoded = decodeQueryApiResponse({ results: [{ columns: ['id'], data: [{ row: ['x'] }, { row: ['y'] }] }] })
    expect(decoded.shape).toBe('v1')
    expect(decoded.rows).toEqual([{ id: 'x' }, { id: 'y' }])
  })

  it('treats a non-object or unrecognised body as malformed, never as an empty result', () => {
    expect(decodeQueryApiResponse(undefined).shape).toBe('none')
    expect(decodeQueryApiResponse('<html>gateway</html>').shape).toBe('none')
    expect(decodeQueryApiResponse({ hello: 'world' }).shape).toBe('none')
  })

  it('reports errors from a 202 body alongside the shape', () => {
    const decoded = decodeQueryApiResponse({ errors: [{ code: 'Neo.ClientError.Statement.SyntaxError', message: 'bad' }] })
    expect(decoded.errors[0]?.code).toBe('Neo.ClientError.Statement.SyntaxError')
  })
})

describe('failureForCode', () => {
  it('classifies security, transient and other errors', () => {
    expect(failureForCode('Neo.ClientError.Security.Unauthorized')).toBe('auth')
    expect(failureForCode('Neo.TransientError.Transaction.DeadlockDetected')).toBe('upstream')
    expect(failureForCode('Neo.ClientError.Statement.SyntaxError')).toBe('rejected')
  })
})

describe('createQueryApiClient: request shape', () => {
  it('sends one POST with statement, parameters and accessMode, using Basic auth', async () => {
    const { fetchImpl, calls } = fakeFetch([() => v2Ok([[1]], ['n'])])
    const client = createQueryApiClient(baseConfig(fetchImpl))
    await client.run('RETURN $x AS n', { x: 1 }, { tag: 'T' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(URL_OK)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].body).toEqual({ statement: 'RETURN $x AS n', parameters: { x: 1 }, accessMode: 'Read' })
    const auth = (calls[0].init.headers as Record<string, string>).authorization
    expect(auth).toBe(`Basic ${Buffer.from('neo4j:test-password-not-real').toString('base64')}`)
    // The password is never in the URL.
    expect(calls[0].url).not.toContain('test-password-not-real')
  })

  it('uses accessMode Write for writes', async () => {
    const { fetchImpl, calls } = fakeFetch([() => v2Ok([], ['id'])])
    await createQueryApiClient(baseConfig(fetchImpl)).run('CREATE (n) RETURN 1', {}, { write: true })
    expect(calls[0].body.accessMode).toBe('Write')
  })

  it('clamps returned rows to maxRows', async () => {
    const values = Array.from({ length: 80 }, (_, i) => [i])
    const { fetchImpl } = fakeFetch([() => v2Ok(values, ['n'])])
    const result = await createQueryApiClient(baseConfig(fetchImpl, { maxRows: 50 })).run('MATCH (n) RETURN n', {})
    expect(result.rows).toHaveLength(50)
  })
})

describe('createQueryApiClient: failures and classification', () => {
  it('maps 401 and 403 to auth, without retrying', async () => {
    const { fetchImpl, calls } = fakeFetch([() => new Response('denied', { status: 401 })])
    const error = await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN 1', {}).catch((e: unknown) => e)
    expect(failureOf(error)).toBe('auth')
    expect(calls).toHaveLength(1)
  })

  it('maps 404 to endpoint', async () => {
    const { fetchImpl } = fakeFetch([() => new Response('', { status: 404 })])
    const error = await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN 1', {}).catch((e: unknown) => e)
    expect(failureOf(error)).toBe('endpoint')
  })

  it('maps a body that is not a Query API response to malformed, not to zero rows', async () => {
    const { fetchImpl } = fakeFetch([() => new Response('<html>proxy error</html>', { status: 200 })])
    const error = await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN 1', {}).catch((e: unknown) => e)
    expect(failureOf(error)).toBe('malformed')
  })

  it('surfaces a Cypher error from a 202 body as rejected, with the code only', async () => {
    const { fetchImpl } = fakeFetch([() => errorBody('Neo.ClientError.Statement.SyntaxError')])
    const error = await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN', {}).catch((e: unknown) => e)
    expect(failureOf(error)).toBe('rejected')
    expect((error as Error).message).not.toMatch(/redacted for test/)
  })

  it('classifies a 202 Security error as auth', async () => {
    const { fetchImpl } = fakeFetch([() => errorBody('Neo.ClientError.Security.Unauthorized')])
    const error = await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN 1', {}).catch((e: unknown) => e)
    expect(failureOf(error)).toBe('auth')
  })

  it('maps a network failure to unreachable', async () => {
    const { fetchImpl } = fakeFetch([() => Promise.reject(new TypeError('fetch failed'))])
    const error = await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN 1', {}, { retries: 0 }).catch((e: unknown) => e)
    expect(failureOf(error)).toBe('unreachable')
  })

  it('maps a request that exceeds the timeout to timeout', async () => {
    const hang: Responder = (init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const { fetchImpl } = fakeFetch([hang])
    const error = await createQueryApiClient(baseConfig(fetchImpl, { timeoutMs: 1000 }))
      .run('RETURN 1', {}, { retries: 0 })
      .catch((e: unknown) => e)
    expect(failureOf(error)).toBe('timeout')
  }, 10_000)

  it('does not include the password in any error', async () => {
    const { fetchImpl } = fakeFetch([() => new Response('denied', { status: 401 })])
    const error = await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN 1', {}).catch((e: unknown) => e)
    expect(JSON.stringify(error)).not.toContain('test-password-not-real')
    expect((error as Error).message).not.toContain('test-password-not-real')
  })
})

describe('createQueryApiClient: retries', () => {
  it('retries a read on 503 and returns the later success', async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => new Response('busy', { status: 503 }),
      () => v2Ok([[7]], ['n']),
    ])
    const result = await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN 7 AS n', {}, { retries: 2 })
    expect(result.rows).toEqual([{ n: 7 }])
    expect(calls).toHaveLength(2)
  })

  it('does not retry a write on a timeout, because the write may have committed', async () => {
    const hang: Responder = (init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const { fetchImpl, calls } = fakeFetch([hang, () => v2Ok([], ['id'])])
    const error = await createQueryApiClient(baseConfig(fetchImpl, { timeoutMs: 1000 }))
      .run('CREATE (n) RETURN 1', {}, { write: true })
      .catch((e: unknown) => e)
    expect(failureOf(error)).toBe('timeout')
    expect(calls).toHaveLength(1)
  }, 10_000)

  it('retries a write that Neo4j reports as a transient (rolled-back) error', async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => errorBody('Neo.TransientError.Transaction.DeadlockDetected'),
      () => v2Ok([[1]], ['saved']),
    ])
    const result = await createQueryApiClient(baseConfig(fetchImpl)).run('MERGE (n:X {id: $id}) RETURN 1 AS saved', { id: 'a' }, { write: true })
    expect(result.rows).toEqual([{ saved: 1 }])
    expect(calls).toHaveLength(2)
  })

  it('does not retry a write rejected by a syntax error', async () => {
    const { fetchImpl, calls } = fakeFetch([() => errorBody('Neo.ClientError.Statement.SyntaxError')])
    await createQueryApiClient(baseConfig(fetchImpl)).run('bad', {}, { write: true }).catch(() => undefined)
    expect(calls).toHaveLength(1)
  })

  it('never retries a 401, even for reads', async () => {
    const { fetchImpl, calls } = fakeFetch([() => new Response('', { status: 401 })])
    await createQueryApiClient(baseConfig(fetchImpl)).run('RETURN 1', {}, { retries: 3 }).catch(() => undefined)
    expect(calls).toHaveLength(1)
  })
})

describe('createQueryApiClient: events are redacted', () => {
  it('emits tag, timing and counts, never the statement or the password', async () => {
    const events: QueryApiEvent[] = []
    const { fetchImpl } = fakeFetch([() => v2Ok([[1], [2]], ['n'])])
    await createQueryApiClient(baseConfig(fetchImpl, { onEvent: (event) => events.push(event) })).run('MATCH (n) RETURN n', {}, { tag: 'TEST_TAG' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'query', cypherTag: 'TEST_TAG', rows: 2 })
    expect(JSON.stringify(events)).not.toContain('MATCH')
    expect(JSON.stringify(events)).not.toContain('test-password-not-real')
  })
})

describe('reader on top of the shared client', () => {
  it('sends accessMode Read for graph reads and maps errors to a classified failure', async () => {
    const { fetchImpl, calls } = fakeFetch([() => new Response('', { status: 401 })])
    const reader = createNeo4jReader({
      queryUrl: URL_OK,
      database: 'neo4j',
      username: 'neo4j',
      password: 'test-password-not-real', // secret-scan:allow
      timeoutMs: 1000,
      maxRows: 50,
      fetchImpl,
    })
    const error = await reader.totals().catch((e: unknown) => e)
    expect(failureOf(error)).toBe('auth')
    expect(calls[0]?.body.accessMode).toBe('Read')
  })
})
