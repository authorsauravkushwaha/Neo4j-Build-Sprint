// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEmbeddedDatabase, type Database } from '../../server/database.ts'
import { createAuthServer } from '../../server/server.ts'

// Real HTTP requests and a real disk-backed Postgres engine, not a mocked pool.
describe('database-backed website', () => {
  let directory: string
  let db: Database
  let server: ReturnType<typeof createAuthServer>
  let base: string
  let aliceCookie = ''
  let bobCookie = ''
  const password = 'a long test passphrase'
  const state = {
    bookmarks: [{ targetType: 'skill', targetId: 'python', note: 'Keep this', createdAt: '2026-10-16T00:00:00.000Z' }],
    ratings: [{ skillId: 'python', state: 'learning', quizScore: 0.75 }],
    profile: { educationLevel: 'undergraduate', branch: 'CSE', interests: ['backend'], weeklyHours: 8, preferredPace: 'steady', learningStyle: 'mixed', goalNote: 'Build websites', theme: 'dark', reducedMotion: false, careerGoalId: null },
    progress: { 'career:backend': { tasks: { first: { skillId: 'python', status: 'completed', actualHours: 4.5, notes: 'Done', updatedAt: '2026-10-16T00:00:00.000Z' } }, updatedAt: '2026-10-16T00:00:00.000Z' } },
  }
  const call = (path: string, method = 'GET', body?: unknown, cookie = '') => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-gm-csrf': '1', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  async function start() {
    db = await openEmbeddedDatabase(directory)
    server = createAuthServer(db)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    base = `http://127.0.0.1:${address.port}`
  }
  async function stop() {
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
    await db.end()
  }
  async function login(email: string) {
    const response = await call('/api/auth/login', 'POST', { email, password })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    return cookie.split(';')[0]!
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gm-database-test-'))
    await start()
  })
  afterAll(async () => { if (server) await stop(); if (directory) await rm(directory, { recursive: true, force: true }) })

  it('automatically migrates, reports health, and runs without superuser privileges', async () => {
    expect(await (await call('/api/health')).json()).toMatchObject({ ok: true, database: 'connected' })
    expect(await (await call('/api/auth/me')).json()).toEqual({ available: true, user: null })
    expect((await db.query('select current_user')).rows[0]).toEqual({ current_user: 'gm_auth' })
    await expect(db.query('select * from auth.gm_local_shim_marker')).rejects.toMatchObject({ code: '42501' })
    // A second process must never silently open the same data directory.
    await expect(openEmbeddedDatabase(directory)).rejects.toMatchObject({ code: 'ELOCKED' })
  })

  it('registers accounts and persists profile, bookmarks, ratings and task progress', async () => {
    for (const email of ['alice@example.com', 'bob@example.com']) {
      const response = await call('/api/auth/register', 'POST', { email, password })
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    aliceCookie = await login('alice@example.com')
    bobCookie = await login('bob@example.com')
    expect((await call('/api/sync', 'PUT', state, aliceCookie)).status).toBe(200)
    const saved = await (await call('/api/sync', 'GET', undefined, aliceCookie)).json()
    expect(saved.bookmarks).toEqual(state.bookmarks)
    expect(saved.ratings).toMatchObject(state.ratings)
    expect(saved.profile).toEqual(state.profile)
    expect(saved.progress['career:backend'].tasks.first).toMatchObject(state.progress['career:backend'].tasks.first)
    const other = await (await call('/api/sync', 'GET', undefined, bobCookie)).json()
    expect(other.bookmarks).toEqual([])
    expect(other.ratings).toEqual([])
    expect(other.progress).toEqual({})
  })

  it('keeps data and sessions after the website and database restart', async () => {
    await stop()
    await start()
    const me = await (await call('/api/auth/me', 'GET', undefined, aliceCookie)).json()
    expect(me.user.email).toBe('alice@example.com')
    const saved = await (await call('/api/sync', 'GET', undefined, aliceCookie)).json()
    expect(saved.bookmarks).toEqual(state.bookmarks)
    expect(saved.profile.goalNote).toBe('Build websites')
  })

  it('serializes transactions and rolls back failed uploads without losing the saved copy', async () => {
    const [alice, bob] = await Promise.all([
      call('/api/sync', 'PUT', state, aliceCookie),
      call('/api/sync', 'PUT', { ...state, bookmarks: [] }, bobCookie),
    ])
    expect(alice.status).toBe(200)
    expect(bob.status).toBe(200)
    const bad = { ...state, bookmarks: [{ ...state.bookmarks[0], createdAt: 'not a timestamp' }] }
    expect((await call('/api/sync', 'PUT', bad, aliceCookie)).status).toBe(500)
    const saved = await (await call('/api/sync', 'GET', undefined, aliceCookie)).json()
    expect(saved.bookmarks).toEqual(state.bookmarks)
  })

  it('allows realistic uploads larger than the small authentication body limit', async () => {
    const bookmarks = Array.from({ length: 100 }, (_, i) => ({ ...state.bookmarks[0], targetId: `skill-${i}`, note: 'a'.repeat(250) }))
    expect((await call('/api/sync', 'PUT', { ...state, bookmarks }, aliceCookie)).status).toBe(200)
  })

  it('rejects unauthenticated and cross-origin writes, then deletes account data and sessions', async () => {
    expect((await call('/api/sync', 'PUT', state)).status).toBe(401)
    const rejected = await fetch(`${base}/api/sync`, { method: 'PUT', headers: { cookie: aliceCookie, 'x-gm-csrf': '1', origin: 'https://attacker.example' }, body: JSON.stringify(state) })
    expect(rejected.status).toBe(403)
    expect((await call('/api/auth/account', 'DELETE', { password }, aliceCookie)).status).toBe(200)
    expect((await call('/api/sync', 'GET', undefined, aliceCookie)).status).toBe(401)
    expect((await call('/api/sync', 'GET', undefined, bobCookie)).status).toBe(200)
  })
})
