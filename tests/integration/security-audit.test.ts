import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { createAuthServer, hashPassword } from '../../server/server.ts'
import { buildApiRequest } from '../../supabase/functions/_shared/core/http.ts'
import { createFetchProbe } from '../../supabase/functions/_shared/core/workflow/services.ts'
import { hostAllowed } from '../../supabase/functions/_shared/core/workflow/registry.ts'
import { validateResourceUrl } from '../../supabase/functions/_shared/core/security.ts'

const servers: ReturnType<typeof createAuthServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

const identity = { id: '11111111-1111-4111-8111-111111111111', email: 'learner@example.com', created_at: new Date(), expires_at: new Date(Date.now() + 60_000) }

async function fixture(options: { registered?: boolean; authenticated?: boolean; passwordHash?: string; failCredentials?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from auth.sessions s join')) return { rows: options.authenticated ? [identity] : [] }
    if (sql.includes('from auth.users u join auth.credentials')) return { rows: options.passwordHash ? [{ ...identity, password_hash: options.passwordHash }] : [] }
    if (sql.startsWith('select password_hash')) return { rows: [{ password_hash: options.passwordHash ?? 'invalid' }] }
    if (sql.startsWith('insert into auth.users')) return { rows: options.registered ? [] : [{ id: identity.id }] }
    if (sql.startsWith('insert into auth.credentials') && options.failCredentials) throw new Error('database detail must not leak')
    return { rows: [] }
  })
  const release = vi.fn()
  const pool = { query, connect: vi.fn(async () => ({ query, release })) } as unknown as Pool
  const server = createAuthServer(pool)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  const base = `http://127.0.0.1:${address.port}`
  const call = (path: string, body: unknown = {}, extra: Record<string, string> = {}, method = 'POST') => fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-gm-csrf': '1', ...extra },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  })
  return { call, query, release }
}

describe('security audit: real local HTTP boundary', () => {
  it('cannot reset the email budget by rotating forged proxy addresses', async () => {
    const { call } = await fixture()
    for (let i = 0; i < 9; i++) {
      const response = await call('/api/auth/login', { email: identity.email, password: 'wrong password' }, { 'x-forwarded-for': `203.0.113.${i}` })
      expect(response.status).toBe(i < 8 ? 401 : 429)
    }
  })

  it('cannot bypass Origin checks using X-Forwarded-Host', async () => {
    const { call, query } = await fixture()
    const response = await call('/api/auth/logout', {}, { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example' })
    expect(response.status).toBe(403)
    expect(query).not.toHaveBeenCalled()
  })

  it('always marks session cookies Secure even if forwarded protocol says HTTP', async () => {
    const { call } = await fixture({ passwordHash: await hashPassword('correct horse battery') })
    const response = await call('/api/auth/login', { email: identity.email, password: 'correct horse battery' }, { 'x-forwarded-proto': 'http' })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toMatch(/; Secure(?:;|$)/)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('returns identical registration status, body and no cookie for existing and new accounts', async () => {
    const fresh = await fixture()
    const existing = await fixture({ registered: true })
    const body = { email: identity.email, password: 'correct horse battery' }
    const a = await fresh.call('/api/auth/register', body)
    const b = await existing.call('/api/auth/register', body)
    expect(a.status).toBe(200)
    expect(a.status).toBe(b.status)
    expect(await a.json()).toEqual(await b.json())
    expect(a.headers.get('set-cookie')).toBeNull()
    expect(b.headers.get('set-cookie')).toBeNull()
    expect(fresh.query.mock.calls.some(([sql]) => sql === 'commit')).toBe(true)
    expect(existing.query.mock.calls.some(([sql]) => sql.startsWith('insert into auth.credentials'))).toBe(false)
  })

  it('rolls back registration when storing credentials fails', async () => {
    const { call, query, release } = await fixture({ failCredentials: true })
    const response = await call('/api/auth/register', { email: identity.email, password: 'correct horse battery' })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('database detail')
    expect(query.mock.calls.some(([sql]) => sql === 'rollback')).toBe(true)
    expect(query.mock.calls.some(([sql]) => sql === 'commit')).toBe(false)
    expect(release).toHaveBeenCalled()
  })

  it('shares a reauthentication budget across change-password and deletion attempts', async () => {
    const { call, query } = await fixture({ authenticated: true })
    for (let i = 0; i < 9; i++) {
      const deleting = i % 2 === 0
      const response = await call(deleting ? '/api/auth/account' : '/api/auth/change-password',
        deleting ? { password: 'wrong' } : { currentPassword: 'wrong', newPassword: 'long enough new password' },
        { cookie: 'gm_session=opaque' }, deleting ? 'DELETE' : 'POST')
      expect(response.status).toBe(i < 8 ? 401 : 429)
    }
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('select password_hash'))).toHaveLength(8)
  })

  it('ignores malformed cookie encoding instead of failing the request', async () => {
    const { call } = await fixture()
    const response = await call('/api/auth/me', {}, { cookie: 'gm_session=%ZZ' }, 'GET')
    expect(response.status).toBe(200)
    expect((await response.json()).user).toBeNull()
  })
})

describe('security audit: streaming body boundary', () => {
  it('cancels a chunked stream as soon as the byte ceiling is exceeded', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(5)) },
      cancel,
    })
    const request = new Request('https://app.example/write', { method: 'POST', body, duplex: 'half' } as RequestInit)
    await expect(buildApiRequest(request, { maxBodyBytes: 8 })).rejects.toMatchObject({ code: 'payload_too_large' })
    expect(cancel).toHaveBeenCalled()
  })

  it('decodes multi-byte UTF-8 split across chunks without corrupting text', async () => {
    const bytes = new TextEncoder().encode('{"value":"é"}')
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } })
    const request = new Request('https://app.example/write', { method: 'POST', body, headers: { 'content-type': 'application/json' }, duplex: 'half' } as RequestInit)
    expect((await buildApiRequest(request)).bodyText).toBe('{"value":"é"}')
  })

  it('rejects malformed UTF-8 rather than replacing it silently', async () => {
    const request = new Request('https://app.example/write', { method: 'POST', body: new Uint8Array([0xff]), headers: { 'content-type': 'application/json' } })
    await expect(buildApiRequest(request)).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('security audit: outbound network policy', () => {
  it('never follows redirects or sends ambient browser credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    await createFetchProbe(fetchImpl)({ url: 'https://docs.python.org/', method: 'HEAD', timeoutMs: 1000 })
    expect(fetchImpl).toHaveBeenCalledWith('https://docs.python.org/', expect.objectContaining({ redirect: 'error', credentials: 'omit', method: 'HEAD' }))
  })

  it.each(['https://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fe80::1]/', 'https://localhost/', 'https://metadata.internal/', 'https://docs.python.org:8443/'])('refuses private/literal/nonstandard targets: %s', (url) => {
    expect(hostAllowed(url, [new URL(url).hostname]).allowed).toBe(false)
    expect(validateResourceUrl(url).ok).toBe(false)
  })
})
