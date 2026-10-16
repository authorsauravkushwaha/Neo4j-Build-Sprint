/**
 * GraphMentor sign-in server — accounts on the project's own database.
 *
 * This is the whole backend behind the sign-in form. It exists because the app
 * previously only knew how to talk to a hosted Supabase project: with none
 * configured, the form was (honestly) hidden. This server is the alternative
 * the project owns: plain Node HTTP over the PostgreSQL cluster in `db/`,
 * reached by the browser only through the Vite proxy at `/api`, so the
 * database port is never exposed to a browser at all.
 *
 * Security posture, briefly (the long version is docs/database.md):
 *  - Connects as `gm_auth`, a role whose entire privilege set is three tables
 *    in the `auth` schema. It cannot read a roadmap, bookmark or progress row.
 *  - Passwords are scrypt hashes (per-user salt, cost parameters stored with
 *    the hash); the 10-character / 72-byte policy matches the client checklist.
 *  - Sessions are server-side rows holding only the SHA-256 of the token; the
 *    browser carries the token in an HttpOnly, SameSite=Lax cookie.
 *  - Sign-in failures are one generic message, and a dummy hash is verified
 *    when the account does not exist, so neither the wording nor the timing
 *    says whether an address is registered.
 *  - Attempts are rate-limited per address and per network; state-changing
 *    requests need the `x-gm-csrf` header and a same-host Origin when one is
 *    sent, on top of SameSite=Lax.
 *  - Bodies are capped at 16 kB, passwords at 72 bytes (rejected, never
 *    truncated), and no password or token is ever logged.
 */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Pool } from 'pg'

/* ========================================================================
 * Passwords (exported for tests)
 * ====================================================================== */

const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 64, saltLength: 16 } as const

function scryptAsync(password: string, salt: Buffer, keyLength: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    scrypt(password, salt, keyLength, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? rejectPromise(error) : resolvePromise(key),
    )
  })
}

/** `scrypt$N$r$p$<salt b64>$<hash b64>` — parameters travel with the hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength)
  const key = await scryptAsync(password, salt, SCRYPT.keyLength, SCRYPT.N, SCRYPT.r, SCRYPT.p)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  const salt = Buffer.from(parts[4] ?? '', 'base64')
  const expected = Buffer.from(parts[5] ?? '', 'base64')
  if (expected.length === 0) return false
  try {
    const actual = await scryptAsync(password, salt, expected.length, N, r, p)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** A real hash of a random password, verified against when no account exists. */
const DUMMY_HASH = (() => {
  // Computed lazily on first use; module-level async is not available here.
  let cached: Promise<string> | null = null
  return (): Promise<string> => {
    cached ??= hashPassword(randomBytes(18).toString('base64'))
    return cached
  }
})()

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function emailLooksValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
}

/** The same rules the sign-up checklist shows: length floor, byte ceiling. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = []
  if (typeof password !== 'string' || password.length < 10) problems.push('Use at least 10 characters.')
  if (typeof password === 'string' && Buffer.byteLength(password, 'utf8') > 72) {
    problems.push('Use at most 72 bytes — longer passwords are rejected, never silently shortened.')
  }
  return problems
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}


/* ========================================================================
 * Account sync payload (exported for tests)
 *
 * The shape that crosses the wire in both directions. Validation lives here,
 * on the server, because the database constraints are the last line, not the
 * first: an invalid enum should be a 400 with a sentence, not a 500 from a
 * check constraint.
 * ====================================================================== */

export interface SyncBookmark { targetType: string; targetId: string; note: string; createdAt: string }
export interface SyncRating { skillId: string; state: string; quizScore?: number }
export interface SyncProfile {
  educationLevel: string | null; branch: string | null; careerGoalId: string | null
  interests: string[]; weeklyHours: number | null; preferredPace: string | null
  learningStyle: string | null; goalNote: string | null; theme: string | null; reducedMotion: boolean | null
}
export interface SyncTask { skillId: string; status: string; actualHours?: number; notes?: string; updatedAt: string }
export interface SyncProgress { [roadmapKey: string]: { tasks: Record<string, SyncTask>; updatedAt: string } }
export interface SyncPayload { bookmarks: SyncBookmark[]; ratings: SyncRating[]; profile: SyncProfile | null; progress: SyncProgress }

const BOOKMARK_TYPES = new Set(['skill', 'project', 'resource', 'career', 'module'])
const SKILL_STATES = new Set(['unknown', 'new', 'learning', 'practised', 'confident'])
const PACES = new Set(['relaxed', 'steady', 'intensive'])
const STYLES = new Set(['video', 'reading', 'hands-on', 'mixed'])
const THEMES = new Set(['dark', 'light', 'system'])
const TASK_STATUSES = new Set(['not-started', 'in-progress', 'completed', 'needs-review'])
const SYNC_TASK_LIMIT = 2000
const SYNC_LIMIT = 500

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const shortString = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null

export function validateSyncPayload(body: Record<string, unknown>): { ok: true; value: SyncPayload } | { ok: false; message: string } {
  const bookmarksRaw = Array.isArray(body['bookmarks']) ? body['bookmarks'] : null
  const ratingsRaw = Array.isArray(body['ratings']) ? body['ratings'] : null
  if (!bookmarksRaw || !ratingsRaw) return { ok: false, message: 'The sync payload needs bookmarks and ratings lists.' }
  if (bookmarksRaw.length > SYNC_LIMIT || ratingsRaw.length > SYNC_LIMIT) {
    return { ok: false, message: `Too much to sync at once (the limit is ${SYNC_LIMIT} bookmarks and ${SYNC_LIMIT} ratings).` }
  }

  const bookmarks: SyncBookmark[] = []
  for (const entry of bookmarksRaw) {
    if (!isRecord(entry)) return { ok: false, message: 'A bookmark in the payload is malformed.' }
    const targetType = shortString(entry['targetType'], 20) ?? ''
    const targetId = shortString(entry['targetId'], 72) ?? ''
    if (!BOOKMARK_TYPES.has(targetType) || targetId.length === 0) return { ok: false, message: 'A bookmark in the payload is malformed.' }
    bookmarks.push({
      targetType,
      targetId,
      note: shortString(entry['note'], 400) ?? '',
      createdAt: typeof entry['createdAt'] === 'string' ? entry['createdAt'] : new Date().toISOString(),
    })
  }

  const ratings: SyncRating[] = []
  for (const entry of ratingsRaw) {
    if (!isRecord(entry)) return { ok: false, message: 'A skill rating in the payload is malformed.' }
    const skillId = shortString(entry['skillId'], 72) ?? ''
    const state = shortString(entry['state'], 20) ?? ''
    if (skillId.length === 0 || !SKILL_STATES.has(state)) return { ok: false, message: 'A skill rating in the payload is malformed.' }
    const quizScore = entry['quizScore']
    ratings.push({
      skillId,
      state,
      ...(typeof quizScore === 'number' && quizScore >= 0 && quizScore <= 1 ? { quizScore } : {}),
    })
  }

  let profile: SyncProfile | null = null
  if (body['profile'] !== null && body['profile'] !== undefined) {
    if (!isRecord(body['profile'])) return { ok: false, message: 'The profile in the payload is malformed.' }
    const raw = body['profile']
    const pace = shortString(raw['preferredPace'], 20)
    const style = shortString(raw['learningStyle'], 20)
    const theme = shortString(raw['theme'], 20)
    profile = {
      educationLevel: shortString(raw['educationLevel'], 200),
      branch: shortString(raw['branch'], 200),
      careerGoalId: shortString(raw['careerGoalId'], 72),
      interests: Array.isArray(raw['interests'])
        ? raw['interests'].filter((v): v is string => typeof v === 'string' && v.length <= 200).slice(0, 50)
        : [],
      weeklyHours: typeof raw['weeklyHours'] === 'number' && raw['weeklyHours'] >= 0 && raw['weeklyHours'] <= 1440 ? Math.round(raw['weeklyHours']) : null,
      preferredPace: pace && PACES.has(pace) ? pace : null,
      learningStyle: style && STYLES.has(style) ? style : null,
      goalNote: shortString(raw['goalNote'], 200),
      theme: theme && THEMES.has(theme) ? theme : null,
      reducedMotion: typeof raw['reducedMotion'] === 'boolean' ? raw['reducedMotion'] : null,
    }
  }

  // Roadmap task progress: nested by roadmap, then task, exactly as devices
  // store it. Absent means "nothing to sync", not an error — older clients
  // and fresh accounts both rely on that.
  const progress: SyncProgress = {}
  if (body['progress'] !== null && body['progress'] !== undefined) {
    if (!isRecord(body['progress'])) return { ok: false, message: 'The progress in the payload is malformed.' }
    let taskCount = 0
    for (const [roadmapKey, rawEntry] of Object.entries(body['progress'])) {
      if (roadmapKey.length === 0 || roadmapKey.length > 200 || !isRecord(rawEntry) || !isRecord(rawEntry['tasks'])) {
        return { ok: false, message: 'The progress in the payload is malformed.' }
      }
      const tasks: Record<string, SyncTask> = {}
      for (const [taskKey, rawTask] of Object.entries(rawEntry['tasks'])) {
        taskCount += 1
        if (taskCount > SYNC_TASK_LIMIT) return { ok: false, message: `Too much progress to sync at once (the limit is ${SYNC_TASK_LIMIT} tasks).` }
        if (taskKey.length === 0 || taskKey.length > 200 || !isRecord(rawTask)) {
          return { ok: false, message: 'A progress task in the payload is malformed.' }
        }
        const skillId = shortString(rawTask['skillId'], 72) ?? ''
        const status = shortString(rawTask['status'], 20) ?? ''
        if (skillId.length === 0 || !TASK_STATUSES.has(status)) {
          return { ok: false, message: 'A progress task in the payload is malformed.' }
        }
        const hours = rawTask['actualHours']
        tasks[taskKey] = {
          skillId,
          status,
          ...(typeof hours === 'number' && hours >= 0 && hours <= 10000 ? { actualHours: hours } : {}),
          ...(typeof rawTask['notes'] === 'string' && rawTask['notes'].length <= 1000 ? { notes: rawTask['notes'] } : {}),
          updatedAt: typeof rawTask['updatedAt'] === 'string' ? rawTask['updatedAt'] : new Date().toISOString(),
        }
      }
      progress[roadmapKey] = {
        tasks,
        updatedAt: typeof rawEntry['updatedAt'] === 'string' ? rawEntry['updatedAt'] : new Date().toISOString(),
      }
    }
  }

  return { ok: true, value: { bookmarks, ratings, profile, progress } }
}

/* ========================================================================
 * Configuration: our own database, through its least-privilege auth role
 * ====================================================================== */

const GM_ROOT = process.env['GM_DB_ROOT'] ?? '/srv/graphmentor-pg'
const PORT = Number(process.env['AUTH_PORT'] ?? 8787)

function databasePool(): Pool {
  const secrets = join(GM_ROOT, 'secrets')
  const certs = join(GM_ROOT, 'certs')
  const passwordPath = join(secrets, 'gm_auth.pass')
  if (!existsSync(passwordPath)) {
    throw new Error(`gm_auth password file missing at ${passwordPath} — run: npm run db:provision`)
  }
  return new Pool({
    host: '127.0.0.1',
    port: Number(process.env['GM_PORT'] ?? 5433),
    database: process.env['GM_DB_NAME'] ?? 'graphmentor',
    user: 'gm_auth',
    password: readFileSync(passwordPath, 'utf8').trim(),
    ssl: {
      ca: readFileSync(join(certs, 'ca.crt')),
      cert: readFileSync(join(certs, 'client-gm_auth.crt')),
      key: readFileSync(join(certs, 'client-gm_auth.key')),
      rejectUnauthorized: true,
    },
    max: 4,
    connectionTimeoutMillis: 5_000,
  })
}

/* ========================================================================
 * HTTP plumbing
 * ====================================================================== */

const SESSION_COOKIE = 'gm_session'
const SESSION_DAYS = 30
const MAX_BODY_BYTES = 16_384

interface ApiResult {
  status: number
  body: Record<string, unknown>
  setCookie?: string
}

function send(response: ServerResponse, result: ApiResult): void {
  const payload = JSON.stringify(result.body)
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    ...(result.setCookie ? { 'set-cookie': result.setCookie } : {}),
  })
  response.end(payload)
}

function fail(status: number, message: string, extra: Record<string, unknown> = {}): ApiResult {
  return { status, body: { ok: false, message, ...extra } }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie ?? ''
  const out: Record<string, string> = Object.create(null)
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name) {
      try { out[name] = decodeURIComponent(rest.join('=')) } catch { /* Ignore malformed cookies. */ }
    }
  }
  return out
}

export interface AuthServerOptions {
  /** Enable ONLY behind a proxy that overwrites all X-Forwarded-* headers. */
  trustProxy?: boolean
  /** Local HTTP development only. Production cookies are Secure by default. */
  allowInsecureHttp?: boolean
}

function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? request.headers['x-forwarded-for'] : undefined
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return (first?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown').slice(0, 64)
}

/** Per-server, bounded state. Never evict a live budget to admit a new key. */
function createLimiter() {
  const attempts = new Map<string, { count: number; resetAt: number }>()
  return (key: string, limit: number, windowMs: number): { limited: boolean; retryAfterSeconds: number } => {
    const now = Date.now()
    for (const [oldKey, entry] of attempts) if (entry.resetAt <= now) attempts.delete(oldKey)
    const entry = attempts.get(key)
    if (!entry) {
      if (attempts.size >= 10_000) return { limited: true, retryAfterSeconds: 60 }
      attempts.set(key, { count: 1, resetAt: now + windowMs })
      return { limited: false, retryAfterSeconds: 0 }
    }
    entry.count = Math.min(entry.count + 1, limit + 1)
    return { limited: entry.count > limit, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
  }
}

function sessionCookie(token: string, allowInsecureHttp: boolean, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(!allowInsecureHttp ? ['Secure'] : []),
  ].join('; ')
}

/* ========================================================================
 * The service
 * ====================================================================== */

export function createAuthServer(pool: Pool, options: AuthServerOptions = {}) {
  const rateLimited = createLimiter()
  const address = (request: IncomingMessage) => clientAddress(request, options.trustProxy === true)
  const cookie = (token: string, maxAge: number) => sessionCookie(token, options.allowInsecureHttp === true, maxAge)
  async function currentUser(request: IncomingMessage): Promise<{ id: string; email: string; createdAt: string } | null> {
    const token = parseCookies(request)[SESSION_COOKIE]
    if (!token) return null
    const result = await pool.query(
      `select u.id, u.email, u.created_at, s.expires_at
         from auth.sessions s join auth.users u on u.id = s.user_id
        where s.token_hash = $1`,
      [hashToken(token)],
    )
    const row = result.rows[0] as { id: string; email: string; created_at: Date; expires_at: Date } | undefined
    if (!row) return null
    if (row.expires_at.getTime() <= Date.now()) {
      await pool.query('delete from auth.sessions where token_hash = $1', [hashToken(token)])
      return null
    }
    await pool.query('update auth.sessions set last_seen_at = now() where token_hash = $1', [hashToken(token)])
    return { id: row.id, email: row.email, createdAt: row.created_at.toISOString() }
  }

  async function startSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000)
    await pool.query('insert into auth.sessions (user_id, token_hash, expires_at) values ($1, $2, $3)', [
      userId,
      hashToken(token),
      expires,
    ])
    return cookie(token, SESSION_DAYS * 86_400)
  }

  async function handle(request: IncomingMessage): Promise<ApiResult> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = request.method ?? 'GET'

    if (path === '/api/health' && method === 'GET') {
      try {
        await pool.query('select 1')
        return { status: 200, body: { ok: true, accounts: true, database: 'connected' } }
      } catch {
        return { status: 503, body: { ok: false, accounts: false, database: 'unavailable' } }
      }
    }

    const isAuthRoute = path.startsWith('/api/auth/') || path === '/api/sync'
    if (!isAuthRoute) return fail(404, 'Not found.')

    // CSRF posture: state-changing calls must carry our header (a cross-site
    // form cannot set it), and a cross-host Origin is refused outright.
    if (method !== 'GET') {
      if (request.headers['x-gm-csrf'] !== '1') return fail(403, 'This request did not come from the app.')
      const origin = request.headers.origin
      if (origin) {
        // Vite preserves Host. Forwarded headers are ignored unless an operator
        // explicitly enables trust for a sanitising reverse proxy.
        const forwarded = options.trustProxy ? request.headers['x-forwarded-host'] : undefined
        const expectedHost = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? request.headers.host
        try {
          if (new URL(origin).host !== expectedHost) return fail(403, 'This request did not come from the app.')
        } catch {
          return fail(403, 'This request did not come from the app.')
        }
      }
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const user = await currentUser(request)
      return { status: 200, body: { available: true, user } }
    }

    if (path === '/api/auth/register' && method === 'POST') {
      const body = await readJson(request)
      if (!body) return fail(400, 'The request body was not valid JSON, or was too large.')
      const email = normalizeEmail(body['email'])
      const password = typeof body['password'] === 'string' ? body['password'] : ''
      const limited = rateLimited(`register:${address(request)}`, 10, 10 * 60_000)
      if (limited.limited) return fail(429, 'Too many attempts. Try again in a few minutes.', { retryAfterSeconds: limited.retryAfterSeconds })
      if (!emailLooksValid(email)) return fail(400, 'That email address does not look complete.')
      const problems = passwordProblems(password)
      if (problems.length > 0) return fail(400, problems.join(' '))

      // Do equal hashing work and return the same status/body/cookie behaviour
      // for existing and new accounts. Never authenticate a registration request.
      const passwordHash = await hashPassword(password)
      const client = await pool.connect()
      try {
        await client.query('begin')
        const created = await client.query(
          'insert into auth.users (id, email) values ($1, $2) on conflict (email) do nothing returning id',
          [randomUUID(), email],
        )
        const userId = (created.rows[0] as { id: string } | undefined)?.id
        if (userId) await client.query('insert into auth.credentials (user_id, password_hash) values ($1, $2)', [userId, passwordHash])
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
      return { status: 200, body: { ok: true, user: null, message: 'If this address can be registered, the account now exists. Sign in to continue.' } }
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readJson(request)
      if (!body) return fail(400, 'The request body was not valid JSON, or was too large.')
      const email = normalizeEmail(body['email'])
      const password = typeof body['password'] === 'string' ? body['password'] : ''
      if (Buffer.byteLength(password, 'utf8') > 72) return fail(400, 'That password is too long to be correct.')
      const byAddress = rateLimited(`login-addr:${hashToken(email)}`, 8, 10 * 60_000)
      const byNetwork = rateLimited(`login-net:${address(request)}`, 40, 10 * 60_000)
      if (byAddress.limited || byNetwork.limited) {
        return fail(429, 'Too many sign-in attempts. Try again in a few minutes.', {
          retryAfterSeconds: Math.max(byAddress.retryAfterSeconds, byNetwork.retryAfterSeconds),
        })
      }
      const result = await pool.query(
        `select u.id, u.email, u.created_at, c.password_hash
           from auth.users u join auth.credentials c on c.user_id = u.id
          where u.email = $1`,
        [email],
      )
      const row = result.rows[0] as { id: string; email: string; created_at: Date; password_hash: string } | undefined
      // One generic failure, and the same hashing work either way.
      const passwordOk = await verifyPassword(password, row?.password_hash ?? (await DUMMY_HASH()))
      if (!row || !passwordOk) return fail(401, 'Email or password is incorrect.')
      const cookie = await startSession(row.id)
      const user = { id: row.id, email: row.email, createdAt: row.created_at.toISOString() }
      return { status: 200, body: { ok: true, user, message: 'Signed in.' }, setCookie: cookie }
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const token = parseCookies(request)[SESSION_COOKIE]
      if (token) await pool.query('delete from auth.sessions where token_hash = $1', [hashToken(token)])
      return { status: 200, body: { ok: true, message: 'Signed out.' }, setCookie: cookie('', 0) }
    }

    if (path === '/api/auth/change-password' && method === 'POST') {
      const user = await currentUser(request)
      if (!user) return fail(401, 'Sign in first.')
      const limited = rateLimited(`reauth:${user.id}`, 8, 10 * 60_000)
      if (limited.limited) return fail(429, 'Too many attempts. Try again later.', { retryAfterSeconds: limited.retryAfterSeconds })
      const body = await readJson(request)
      if (!body) return fail(400, 'The request body was not valid JSON, or was too large.')
      const current = typeof body['currentPassword'] === 'string' ? body['currentPassword'] : ''
      const next = typeof body['newPassword'] === 'string' ? body['newPassword'] : ''
      if (Buffer.byteLength(current, 'utf8') > 72) return fail(400, 'The current password is too long.')
      const problems = passwordProblems(next)
      if (problems.length > 0) return fail(400, problems.join(' '))
      const result = await pool.query('select password_hash from auth.credentials where user_id = $1', [user.id])
      const stored = (result.rows[0] as { password_hash: string } | undefined)?.password_hash ?? (await DUMMY_HASH())
      if (!(await verifyPassword(current, stored))) return fail(401, 'The current password is incorrect.')
      await pool.query('update auth.credentials set password_hash = $2, updated_at = now() where user_id = $1', [
        user.id,
        await hashPassword(next),
      ])
      // Every other session dies with the old password; this browser stays in.
      const token = parseCookies(request)[SESSION_COOKIE] ?? ''
      await pool.query('delete from auth.sessions where user_id = $1 and token_hash <> $2', [user.id, hashToken(token)])
      return { status: 200, body: { ok: true, message: 'Password changed. Other devices have been signed out.' } }
    }

    if (path === '/api/auth/account' && method === 'DELETE') {
      const user = await currentUser(request)
      if (!user) return fail(401, 'Sign in first.')
      const limited = rateLimited(`reauth:${user.id}`, 8, 10 * 60_000)
      if (limited.limited) return fail(429, 'Too many attempts. Try again later.', { retryAfterSeconds: limited.retryAfterSeconds })
      const body = await readJson(request)
      if (!body) return fail(400, 'The request body was not valid JSON, or was too large.')
      const password = typeof body['password'] === 'string' ? body['password'] : ''
      if (Buffer.byteLength(password, 'utf8') > 72) return fail(400, 'The password is too long.')
      const result = await pool.query('select password_hash from auth.credentials where user_id = $1', [user.id])
      const stored = (result.rows[0] as { password_hash: string } | undefined)?.password_hash ?? (await DUMMY_HASH())
      if (!(await verifyPassword(password, stored))) return fail(401, 'The password is incorrect.')
      // Cascades: profile, credentials and sessions go with the identity row.
      await pool.query('delete from auth.users where id = $1', [user.id])
      return { status: 200, body: { ok: true, message: 'Account deleted.' }, setCookie: cookie('', 0) }
    }


    if (path === '/api/sync' && method === 'GET') {
      const user = await currentUser(request)
      if (!user) return fail(401, 'Sign in first.')
      const [bookmarkRows, ratingRows, profileRows, taskRows] = await Promise.all([
        pool.query('select target_type, target_id, note, created_at from public.bookmarks where user_id = $1 order by created_at', [user.id]),
        pool.query('select skill_id, state, quiz_score, updated_at from public.user_skill_progress where user_id = $1 order by skill_id', [user.id]),
        pool.query(`select education_level, branch, career_goal_id, interests, weekly_hours, preferred_pace,
                           learning_style, goal_note, theme, reduced_motion
                      from public.profiles where id = $1`, [user.id]),
        pool.query('select roadmap_key, task_key, skill_id, status, actual_hours, notes, updated_at from public.user_task_progress where user_id = $1 order by roadmap_key, task_key', [user.id]),
      ])
      const profileRow = profileRows.rows[0] as Record<string, unknown> | undefined
      const progress: SyncProgress = {}
      for (const row of taskRows.rows) {
        const r = row as { roadmap_key: string; task_key: string; skill_id: string; status: string; actual_hours: string | null; notes: string | null; updated_at: Date }
        const entry = (progress[r.roadmap_key] ??= { tasks: {}, updatedAt: r.updated_at.toISOString() })
        entry.tasks[r.task_key] = {
          skillId: r.skill_id, status: r.status,
          ...(r.actual_hours !== null ? { actualHours: Number(r.actual_hours) } : {}),
          ...(r.notes !== null ? { notes: r.notes } : {}),
          updatedAt: r.updated_at.toISOString(),
        }
        if (r.updated_at.toISOString() > entry.updatedAt) entry.updatedAt = r.updated_at.toISOString()
      }
      return {
        status: 200,
        body: {
          ok: true,
          bookmarks: bookmarkRows.rows.map((row) => {
            const r = row as { target_type: string; target_id: string; note: string | null; created_at: Date }
            return { targetType: r.target_type, targetId: r.target_id, note: r.note ?? '', createdAt: r.created_at.toISOString() }
          }),
          ratings: ratingRows.rows.map((row) => {
            const r = row as { skill_id: string; state: string; quiz_score: string | null; updated_at: Date }
            return { skillId: r.skill_id, state: r.state, ...(r.quiz_score !== null ? { quizScore: Number(r.quiz_score) } : {}), updatedAt: r.updated_at.toISOString() }
          }),
          profile: profileRow
            ? {
                educationLevel: profileRow['education_level'], branch: profileRow['branch'], careerGoalId: profileRow['career_goal_id'],
                interests: profileRow['interests'], weeklyHours: profileRow['weekly_hours'], preferredPace: profileRow['preferred_pace'],
                learningStyle: profileRow['learning_style'], goalNote: profileRow['goal_note'], theme: profileRow['theme'],
                reducedMotion: profileRow['reduced_motion'],
              }
            : null,
          progress,
        },
      }
    }

    if (path === '/api/sync' && method === 'PUT') {
      const user = await currentUser(request)
      if (!user) return fail(401, 'Sign in first.')
      const body = await readJson(request)
      if (!body) return fail(400, 'The request body was not valid JSON, or was too large.')
      const validated = validateSyncPayload(body)
      if (!validated.ok) return fail(400, validated.message)
      const { bookmarks, ratings, profile, progress } = validated.value
      const progressTaskCount = Object.values(progress).reduce((sum, entry) => sum + Object.keys(entry.tasks).length, 0)

      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('delete from public.bookmarks where user_id = $1', [user.id])
        for (const bookmark of bookmarks) {
          await client.query(
            'insert into public.bookmarks (user_id, target_type, target_id, note, created_at) values ($1, $2, $3, $4, $5)',
            [user.id, bookmark.targetType, bookmark.targetId, bookmark.note || null, bookmark.createdAt],
          )
        }
        await client.query('delete from public.user_skill_progress where user_id = $1', [user.id])
        for (const rating of ratings) {
          await client.query(
            'insert into public.user_skill_progress (user_id, skill_id, state, quiz_score) values ($1, $2, $3, $4)',
            [user.id, rating.skillId, rating.state, rating.quizScore ?? null],
          )
        }
        await client.query('delete from public.user_task_progress where user_id = $1', [user.id])
        for (const [roadmapKey, entry] of Object.entries(progress)) {
          for (const [taskKey, task] of Object.entries(entry.tasks)) {
            await client.query(
              'insert into public.user_task_progress (user_id, roadmap_key, task_key, skill_id, status, actual_hours, notes, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
              [user.id, roadmapKey, taskKey, task.skillId, task.status, task.actualHours ?? null, task.notes ?? null, task.updatedAt],
            )
          }
        }
        if (profile) {
          await client.query(
            `insert into public.profiles (id, education_level, branch, career_goal_id, interests, weekly_hours,
                                           preferred_pace, learning_style, goal_note, theme, reduced_motion)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             on conflict (id) do update set
               education_level = excluded.education_level, branch = excluded.branch,
               career_goal_id = excluded.career_goal_id, interests = excluded.interests,
               weekly_hours = excluded.weekly_hours, preferred_pace = excluded.preferred_pace,
               learning_style = excluded.learning_style, goal_note = excluded.goal_note,
               theme = excluded.theme, reduced_motion = excluded.reduced_motion`,
            [user.id, profile.educationLevel, profile.branch, profile.careerGoalId, profile.interests,
             profile.weeklyHours, profile.preferredPace, profile.learningStyle, profile.goalNote,
             profile.theme, profile.reducedMotion],
          )
        }
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
      return {
        status: 200,
        body: { ok: true, message: 'Synced to your account.', counts: { bookmarks: bookmarks.length, ratings: ratings.length, progressTasks: progressTaskCount } },
      }
    }

    return fail(404, 'Not found.')
  }

  return createServer((request, response) => {
    handle(request)
      .then((result) => send(response, result))
      .catch((error: unknown) => {
        // Never echo internals: log a name, answer with a sentence.
        console.error(JSON.stringify({ level: 'error', msg: 'auth request failed', error: error instanceof Error ? error.name : 'unknown' }))
        send(response, fail(500, 'Something went wrong on the server. Please try again.'))
      })
  })
}

/* ====================================================================== */

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  const pool = databasePool()
  const server = createAuthServer(pool, {
    trustProxy: process.env['AUTH_TRUST_PROXY'] === 'true',
    allowInsecureHttp: process.env['AUTH_ALLOW_INSECURE_HTTP'] === 'true',
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`graphmentor auth server on 127.0.0.1:${PORT} (database: our own PostgreSQL via gm_auth)`)
  })
}


