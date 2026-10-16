/**
 * Client for the project's own sign-in server (`server/server.ts`).
 *
 * This is the account system that does not depend on a hosted provider: the
 * server runs against this project's own PostgreSQL (`db/`), and the browser
 * only ever talks to same-origin `/api` (Vite proxies it in dev and preview).
 * The session is an HttpOnly cookie — JavaScript here never sees a token, so
 * there is nothing for an XSS bug to steal from storage.
 *
 * When a Supabase project is configured, `auth.ts` handles accounts instead
 * and this module is never called. When neither is available, the page says
 * so and guest mode continues; this module's job is only to find out which
 * world we are in (`probeAccounts`) and to speak to ours when it answers.
 */
export interface LocalUser {
  id: string
  email: string
  createdAt: string
}

export interface AccountsProbe {
  available: boolean
  user: LocalUser | null
}

export interface LocalAuthResult {
  ok: boolean
  message: string
  user?: LocalUser | null
  retryAfterSeconds?: number
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', 'x-gm-csrf': '1', ...(init.headers ?? {}) },
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, body }
}

function toResult(_status: number, body: Record<string, unknown>, fallback: string): LocalAuthResult {
  return {
    ok: body['ok'] === true,
    message: typeof body['message'] === 'string' ? body['message'] : fallback,
    user: (body['user'] as LocalUser | null | undefined) ?? undefined,
    ...(typeof body['retryAfterSeconds'] === 'number' ? { retryAfterSeconds: body['retryAfterSeconds'] } : {}),
  }
}

/**
 * Is our own account server answering, and if so, who is signed in?
 * Any failure — server down, network gone — is "not available", never an error
 * worth showing a guest.
 */
export async function probeAccounts(): Promise<AccountsProbe> {
  try {
    const { body } = await call('/api/auth/me', { method: 'GET' })
    if (body['available'] !== true) return { available: false, user: null }
    return { available: true, user: (body['user'] as LocalUser | null) ?? null }
  } catch {
    return { available: false, user: null }
  }
}

export async function localSignIn(email: string, password: string): Promise<LocalAuthResult> {
  try {
    const { status, body } = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
    return toResult(status, body, 'Sign-in did not complete. Please try again.')
  } catch {
    return { ok: false, message: 'The account server could not be reached. You can keep working as a guest.' }
  }
}

export async function localSignUp(email: string, password: string): Promise<LocalAuthResult> {
  try {
    const { status, body } = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) })
    return toResult(status, body, 'Sign-up did not complete. Please try again.')
  } catch {
    return { ok: false, message: 'The account server could not be reached. You can keep working as a guest.' }
  }
}

/* ------------------------------------------------------------------ sync */

export interface SyncBookmark { targetType: string; targetId: string; note: string; createdAt: string }
export interface SyncRating { skillId: string; state: string; quizScore?: number; updatedAt?: string }
export interface SyncTask {
  skillId: string
  status: 'not-started' | 'in-progress' | 'completed' | 'needs-review'
  actualHours?: number
  notes?: string
  updatedAt: string
}
export interface SyncProfile {
  educationLevel: string | null; branch: string | null; careerGoalId: string | null
  interests: string[]; weeklyHours: number | null; preferredPace: string | null
  learningStyle: string | null; goalNote: string | null; theme: string | null; reducedMotion: boolean | null
}
export interface SyncState {
  bookmarks: SyncBookmark[]
  ratings: SyncRating[]
  profile: SyncProfile | null
  /** Nested by roadmap key, then task key — the same shape the store keeps. */
  progress: Record<string, { tasks: Record<string, SyncTask>; updatedAt: string }>
}

/** The account's server copy. Null when signed out or unreachable. */
export async function getSyncState(): Promise<SyncState | null> {
  try {
    const { body } = await call('/api/sync', { method: 'GET' })
    if (body['ok'] !== true) return null
    return {
      bookmarks: (body['bookmarks'] as SyncBookmark[]) ?? [],
      ratings: (body['ratings'] as SyncRating[]) ?? [],
      profile: (body['profile'] as SyncProfile | null) ?? null,
      progress: (body['progress'] as SyncState['progress']) ?? {},
    }
  } catch {
    return null
  }
}

/** Replace the account's server copy with this device's. Explicit, never silent. */
export async function putSyncState(state: SyncState): Promise<LocalAuthResult> {
  try {
    const { status, body } = await call('/api/sync', { method: 'PUT', body: JSON.stringify(state) })
    return toResult(status, body, 'Sync did not complete.')
  } catch {
    return { ok: false, message: 'The account server could not be reached.' }
  }
}

export async function localSignOut(): Promise<void> {
  try {
    await call('/api/auth/logout', { method: 'POST', body: '{}' })
  } catch {
    // The cookie expires on its own; a failed sign-out call must not strand
    // the user on this screen pretending they are still signed in locally —
    // the next probe tells the truth either way.
  }
}

export async function localChangePassword(currentPassword: string, newPassword: string): Promise<LocalAuthResult> {
  try {
    const { status, body } = await call('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    return toResult(status, body, 'The password was not changed.')
  } catch {
    return { ok: false, message: 'The account server could not be reached.' }
  }
}

export async function localDeleteAccount(password: string): Promise<LocalAuthResult> {
  try {
    const { status, body } = await call('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) })
    return toResult(status, body, 'The account was not deleted.')
  } catch {
    return { ok: false, message: 'The account server could not be reached.' }
  }
}


