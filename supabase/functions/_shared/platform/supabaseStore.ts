/**
 * Supabase (PostgreSQL) persistence for user-owned records.
 *
 * Why this file has no imports: the Edge Functions runtime supplies
 * `@supabase/supabase-js`, but keeping this module dependency-free means it can
 * be type-checked by the normal project `tsc` run and tested with a fake client.
 * The Deno entrypoints create the real client and inject it here.
 *
 * Security model (defence in depth):
 *  1. Row Level Security policies in `supabase/migrations` are the primary
 *     control — an authenticated user can only see rows where auth.uid() = user_id.
 *  2. Every query here ALSO filters by the server-verified `userId`, so a bug in
 *     a policy cannot silently expose another user's data.
 *  3. Ownership is never taken from the request body: `roadmapId`, `taskId` are
 *     validated as UUIDs and then matched against rows already owned by the
 *     caller. A valid-looking UUID from another account simply returns no rows.
 *  4. The service-role key is used only where a policy cannot help (rate-limit
 *     buckets, nonces) and is never returned to a client.
 */
import type { FixedWindowStore } from '../core/rateLimit.ts'
import type { NonceStore } from '../core/security.ts'
import { taskKindFromName, type Roadmap, type RoadmapTask, type SkillState, type TaskStatus } from '../core/types.ts'

/* ==========================================================================
 * Minimal client contracts
 * ========================================================================== */

export interface PostgrestError {
  message?: string
  code?: string
  details?: string
}

export interface QueryResult<T> {
  data: T | null
  error: PostgrestError | null
  count?: number | null
}

/**
 * `Row` is the *row* type. Awaiting the builder yields rows; `single()` and
 * `maybeSingle()` yield one row. Keeping both in one generic means a call site
 * can never confuse a list result with a single result.
 */
export interface FilterBuilder<Row> extends PromiseLike<QueryResult<Row[]>> {
  select(columns?: string, options?: { count?: 'exact' | 'planned' | 'estimated' }): FilterBuilder<Row>
  insert(values: unknown): FilterBuilder<Row>
  update(values: unknown): FilterBuilder<Row>
  upsert(values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }): FilterBuilder<Row>
  delete(): FilterBuilder<Row>
  eq(column: string, value: unknown): FilterBuilder<Row>
  in(column: string, values: readonly unknown[]): FilterBuilder<Row>
  is(column: string, value: null | boolean): FilterBuilder<Row>
  order(column: string, options?: { ascending?: boolean }): FilterBuilder<Row>
  limit(count: number): FilterBuilder<Row>
  single(): Promise<QueryResult<Row>>
  maybeSingle(): Promise<QueryResult<Row>>
}

export interface AuthUser {
  id: string
  email?: string | null
}

export interface SupabaseLikeClient {
  from<Row = Record<string, unknown>>(table: string): FilterBuilder<Row>
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<QueryResult<T>>
  auth: {
    getUser(jwt: string): Promise<{ data: { user: AuthUser | null }; error: PostgrestError | null }>
  }
}

/* ==========================================================================
 * Auth verification
 * ========================================================================== */

export type AuthCheck =
  | { status: 'none' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; userId: string }

/**
 * Verifies a Supabase access token by asking the Auth server who it belongs to.
 * We deliberately do not decode the JWT locally: signature verification against
 * the project's keys is the Auth server's job, and trusting an unverified
 * `sub` claim would be an authentication bypass.
 */
export function createAuthVerifier(client: SupabaseLikeClient) {
  return async function verifyAuth(headers: Headers): Promise<AuthCheck> {
    const header = headers.get('authorization') ?? headers.get('Authorization')
    if (!header) return { status: 'none' }
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) return { status: 'invalid', reason: 'malformed-authorization-header' }
    const token = match[1].trim()
    // Supabase access tokens are JWTs; reject anything that is obviously not one
    // before spending a network round trip on it.
    if (token.length < 20 || token.length > 4096 || token.split('.').length !== 3) {
      return { status: 'invalid', reason: 'not-a-jwt' }
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
 * Rate limiting + nonce stores (Postgres, shared across instances)
 * ========================================================================== */

export function createPostgresFixedWindowStore(client: SupabaseLikeClient): FixedWindowStore {
  return {
    async increment(key: string, windowSeconds: number): Promise<number> {
      const { data, error } = await client.rpc<number>('gm_consume_rate_limit', {
        p_key: key,
        p_window_seconds: windowSeconds,
        p_limit: 1_000_000,
      })
      if (error) throw new Error(`rate limit store unavailable: ${error.code ?? 'unknown'}`)
      const value = typeof data === 'number' ? data : Number(data ?? 0)
      return Number.isFinite(value) ? value : 0
    },
    async cleanup(): Promise<void> {
      await client.rpc('gm_cleanup_rate_limit', { p_days: 1 })
    },
  }
}

export function createPostgresNonceStore(client: SupabaseLikeClient): NonceStore {
  return {
    async claim(nonce: string, expiresInMs: number): Promise<boolean> {
      const { data, error } = await client.rpc<boolean>('gm_claim_nonce', {
        p_nonce: nonce,
        p_ttl_seconds: Math.max(30, Math.ceil(expiresInMs / 1000)),
      })
      if (error) {
        // Fail closed for replay protection: if we cannot prove the nonce is
        // fresh, we must not accept the request as signed.
        throw new Error(`nonce store unavailable: ${error.code ?? 'unknown'}`)
      }
      return data === true
    },
  }
}

/* ==========================================================================
 * User data repositories
 * ========================================================================== */

export interface RoadmapRow {
  id: string
  user_id: string
  title: string
  career_id: string
  career_name: string
  weekly_hours: number
  pace: string
  estimate_disclaimer: string
  milestones: unknown
  created_at: string
  updated_at: string
}

export interface RoadmapTaskRow {
  id: string
  roadmap_id: string
  user_id: string
  skill_id: string
  name: string
  status: TaskStatus
  difficulty: string
  order_index: number
  scheduled_week: number
  scheduled_day: number | null
  estimated_hours_low: number
  estimated_hours_high: number
  essential: boolean
  note: string | null
  actual_hours: number | null
  updated_at: string
}

export interface BookmarkRow {
  id: string
  user_id: string
  target_type: string
  target_id: string
  note: string | null
  created_at: string
}

export interface SkillProgressRow {
  id: string
  user_id: string
  skill_id: string
  state: SkillState
  quiz_score: number | null
  updated_at: string
}

export class PersistenceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'PersistenceError'
  }
}

function fail(message: string, error: PostgrestError | null): never {
  throw new PersistenceError(message, error?.code)
}

export interface UserRepositories {
  roadmaps: {
    list(userId: string): Promise<{ roadmap: RoadmapRow; tasks: RoadmapTaskRow[] }[]>
    get(userId: string, roadmapId: string): Promise<{ roadmap: RoadmapRow; tasks: RoadmapTaskRow[] } | null>
    save(userId: string, roadmap: Roadmap): Promise<{ roadmapId: string; taskCount: number }>
    remove(userId: string, roadmapId: string): Promise<boolean>
  }
  progress: {
    updateTask(
      userId: string,
      input: { roadmapId: string; taskId: string; status: TaskStatus; note?: string; actualHours?: number },
    ): Promise<RoadmapTaskRow>
    reset(userId: string, roadmapId?: string): Promise<number>
  }
  skills: {
    upsert(userId: string, ratings: Array<{ skillId: string; state: SkillState; quizScore?: number }>): Promise<number>
    list(userId: string): Promise<SkillProgressRow[]>
    clear(userId: string): Promise<number>
  }
  bookmarks: {
    add(userId: string, targetType: string, targetId: string, note?: string): Promise<BookmarkRow>
    remove(userId: string, targetId: string): Promise<boolean>
    list(userId: string): Promise<BookmarkRow[]>
  }
  feedback: {
    submit(userId: string | null, input: { kind: string; message: string; contact?: string; targetId?: string; pageUrl?: string }): Promise<string>
  }
  profiles: {
    get(userId: string): Promise<Record<string, unknown> | null>
    upsert(userId: string, patch: Record<string, unknown>): Promise<void>
  }
  dataRights: {
    export(userId: string): Promise<Record<string, unknown>>
    deleteAll(userId: string): Promise<{ deleted: number }>
  }
}

export function createUserRepositories(client: SupabaseLikeClient): UserRepositories {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const assertUuid = (value: string, field: string): string => {
    if (!uuidPattern.test(value)) throw new PersistenceError(`${field} must be a UUID`)
    return value
  }

  const mapTaskRow = (row: Record<string, unknown>): RoadmapTaskRow => ({
    id: String(row.id),
    roadmap_id: String(row.roadmap_id),
    user_id: String(row.user_id),
    skill_id: String(row.skill_id),
    name: String(row.name),
    status: row.status as TaskStatus,
    difficulty: String(row.difficulty),
    order_index: Number(row.order_index),
    scheduled_week: Number(row.scheduled_week),
    scheduled_day: row.scheduled_day === null || row.scheduled_day === undefined ? null : Number(row.scheduled_day),
    estimated_hours_low: Number(row.estimated_hours_low),
    estimated_hours_high: Number(row.estimated_hours_high),
    essential: Boolean(row.essential),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    actual_hours: row.actual_hours === null || row.actual_hours === undefined ? null : Number(row.actual_hours),
    updated_at: String(row.updated_at),
  })

  const loadTasks = async (userId: string, roadmapId: string): Promise<RoadmapTaskRow[]> => {
    const { data, error } = await client
      .from<Record<string, unknown>>('roadmap_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('roadmap_id', roadmapId)
      .order('order_index', { ascending: true })
      .limit(500)
    if (error) fail('Could not read roadmap tasks', error)
    return (data ?? []).map(mapTaskRow)
  }

  return {
    roadmaps: {
      async list(userId) {
        const { data, error } = await client
          .from<Record<string, unknown>>('saved_roadmaps')
          .select('*')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .limit(20)
        if (error) fail('Could not list roadmaps', error)
        const rows = (data ?? []) as unknown as RoadmapRow[]
        const out: Array<{ roadmap: RoadmapRow; tasks: RoadmapTaskRow[] }> = []
        for (const row of rows) {
          out.push({ roadmap: row, tasks: await loadTasks(userId, row.id) })
        }
        return out
      },

      async get(userId, roadmapId) {
        assertUuid(roadmapId, 'roadmapId')
        const { data, error } = await client
          .from<Record<string, unknown>>('saved_roadmaps')
          .select('*')
          .eq('user_id', userId)
          .eq('id', roadmapId)
          .maybeSingle()
        if (error) fail('Could not read roadmap', error)
        if (!data) return null
        const roadmap = data as unknown as RoadmapRow
        return { roadmap, tasks: await loadTasks(userId, roadmap.id) }
      },

      async save(userId, roadmap) {
        /*
         * A client may send any UUID it likes as `roadmap.id`, and that id is the
         * conflict target of the upsert below. Ownership is therefore proved
         * *before* the id is used, not afterwards: an id that is not already this
         * user's row is discarded and the save becomes a create.
         *
         * Two reasons this is worth one extra indexed lookup on the save path:
         *
         *  - the guarantee stops depending on how Postgres resolves
         *    `INSERT … ON CONFLICT DO UPDATE` against a row the caller cannot see
         *    under Row Level Security, which is subtle and changes with the
         *    policy. Here the id provably belongs to the caller by the time it
         *    reaches the write.
         *  - a stranger's id can no longer produce a *different* response from an
         *    id that does not exist, so the endpoint stops being an existence
         *    oracle for other people's roadmaps.
         *
         * A transient read failure fails the request rather than guessing at
         * "new row", so a blip cannot silently duplicate a roadmap.
         */
        let ownedId: string | null = null
        if (roadmap.id && uuidPattern.test(roadmap.id)) {
          const { data, error } = await client
            .from<Record<string, unknown>>('saved_roadmaps')
            .select('id')
            .eq('id', roadmap.id)
            .eq('user_id', userId)
            .maybeSingle()
          if (error) fail('Could not verify roadmap ownership', error)
          ownedId = data ? String((data as Record<string, unknown>).id) : null
        }

        const payload = {
          ...(ownedId ? { id: ownedId } : {}),
          user_id: userId,
          title: roadmap.title.slice(0, 120),
          career_id: roadmap.careerId,
          career_name: roadmap.careerName.slice(0, 160),
          weekly_hours: roadmap.weeklyHours,
          pace: roadmap.pace,
          estimate_disclaimer: roadmap.estimateDisclaimer.slice(0, 600),
          milestones: roadmap.milestones.slice(0, 40),
          updated_at: new Date().toISOString(),
        }

        const { data, error } = await client
          .from<Record<string, unknown>>('saved_roadmaps')
          .upsert(payload, { onConflict: 'id' })
          .select('id')
          .single()
        if (error || !data) fail('Could not save roadmap', error)
        const roadmapId = String((data as Record<string, unknown>).id)

        const taskRows = roadmap.tasks.slice(0, 120).map((task) => ({
          roadmap_id: roadmapId,
          user_id: userId,
          skill_id: task.skillId,
          name: task.name.slice(0, 160),
          status: task.status,
          difficulty: task.difficulty,
          order_index: Math.max(0, Math.trunc(task.order)),
          scheduled_week: Math.max(1, Math.trunc(task.scheduledWeek)),
          scheduled_day: typeof task.scheduledDay === 'number' ? task.scheduledDay : null,
          estimated_hours_low: clampNumber(task.estimatedHours[0], 0, 400),
          estimated_hours_high: clampNumber(task.estimatedHours[1], 0, 600),
          essential: task.essential,
          note: task.notes ? task.notes.slice(0, 600) : null,
          actual_hours: typeof task.actualHours === 'number' ? clampNumber(task.actualHours, 0, 200) : null,
          updated_at: new Date().toISOString(),
        }))

        if (taskRows.length > 0) {
          const { error: taskError } = await client
            .from('roadmap_tasks')
            .upsert(taskRows, { onConflict: 'roadmap_id,skill_id,order_index,status' })
          if (taskError) fail('Could not save roadmap tasks', taskError)
        }
        return { roadmapId, taskCount: taskRows.length }
      },

      async remove(userId, roadmapId) {
        assertUuid(roadmapId, 'roadmapId')
        const { error } = await client.from('saved_roadmaps').delete().eq('user_id', userId).eq('id', roadmapId)
        if (error) fail('Could not delete roadmap', error)
        return true
      },
    },

    progress: {
      async updateTask(userId, input) {
        assertUuid(input.roadmapId, 'roadmapId')
        assertUuid(input.taskId, 'taskId')
        const { data, error } = await client
          .from<Record<string, unknown>>('roadmap_tasks')
          .update({
            status: input.status,
            note: input.note ? input.note.slice(0, 600) : null,
            actual_hours: typeof input.actualHours === 'number' ? clampNumber(input.actualHours, 0, 200) : null,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('id', input.taskId)
          .eq('roadmap_id', input.roadmapId)
          .select('*')
          .maybeSingle()
        if (error) fail('Could not update task', error)
        if (!data) {
          // Either it does not exist or it belongs to somebody else — both are
          // reported identically so the API cannot be used to probe for ids.
          throw new PersistenceError('Task not found for this account')
        }
        return mapTaskRow(data)
      },

      async reset(userId, roadmapId) {
        const query = client
          .from<Record<string, unknown>>('roadmap_tasks')
          .update({ status: 'not-started', actual_hours: null, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
        const { data, error } = roadmapId
          ? await query.eq('roadmap_id', assertUuid(roadmapId, 'roadmapId')).select('id')
          : await query.select('id')
        if (error) fail('Could not reset progress', error)
        return (data ?? []).length
      },
    },

    skills: {
      async upsert(userId, ratings) {
        if (ratings.length === 0) return 0
        const rows = ratings.slice(0, 150).map((rating) => ({
          user_id: userId,
          skill_id: rating.skillId,
          state: rating.state,
          quiz_score: typeof rating.quizScore === 'number' ? Math.min(1, Math.max(0, rating.quizScore)) : null,
          updated_at: new Date().toISOString(),
        }))
        const { data, error } = await client
          .from<Record<string, unknown>>('user_skill_progress')
          .upsert(rows, { onConflict: 'user_id,skill_id' })
          .select('id')
        if (error) fail('Could not save skill ratings', error)
        return (data ?? []).length
      },

      async list(userId) {
        const { data, error } = await client
          .from<Record<string, unknown>>('user_skill_progress')
          .select('*')
          .eq('user_id', userId)
          .limit(300)
        if (error) fail('Could not read skill ratings', error)
        return (data ?? []).map((row) => ({
          id: String(row.id),
          user_id: String(row.user_id),
          skill_id: String(row.skill_id),
          state: row.state as SkillState,
          quiz_score: row.quiz_score === null || row.quiz_score === undefined ? null : Number(row.quiz_score),
          updated_at: String(row.updated_at),
        }))
      },

      async clear(userId) {
        const { data, error } = await client.from<Record<string, unknown>>('user_skill_progress').delete().eq('user_id', userId).select('id')
        if (error) fail('Could not clear skill ratings', error)
        return (data ?? []).length
      },
    },

    bookmarks: {
      async add(userId, targetType, targetId, note) {
        const { data, error } = await client
          .from<Record<string, unknown>>('bookmarks')
          .upsert(
            { user_id: userId, target_type: targetType, target_id: targetId, note: note ? note.slice(0, 400) : null },
            { onConflict: 'user_id,target_id' },
          )
          .select('*')
          .single()
        if (error || !data) fail('Could not save bookmark', error)
        const row = data as Record<string, unknown>
        return {
          id: String(row.id),
          user_id: String(row.user_id),
          target_type: String(row.target_type),
          target_id: String(row.target_id),
          note: row.note === null || row.note === undefined ? null : String(row.note),
          created_at: String(row.created_at),
        }
      },

      async remove(userId, targetId) {
        const { error } = await client.from('bookmarks').delete().eq('user_id', userId).eq('target_id', targetId)
        if (error) fail('Could not remove bookmark', error)
        return true
      },

      async list(userId) {
        const { data, error } = await client
          .from<Record<string, unknown>>('bookmarks')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(200)
        if (error) fail('Could not list bookmarks', error)
        return (data ?? []).map((row) => ({
          id: String(row.id),
          user_id: String(row.user_id),
          target_type: String(row.target_type),
          target_id: String(row.target_id),
          note: row.note === null || row.note === undefined ? null : String(row.note),
          created_at: String(row.created_at),
        }))
      },
    },

    feedback: {
      async submit(userId, input) {
        const { data, error } = await client
          .from<Record<string, unknown>>('feedback')
          .insert({
            // Guests may submit feedback; the row is anonymous (user_id null).
            user_id: userId,
            kind: input.kind,
            message: input.message.slice(0, 1500),
            contact: input.contact ? input.contact.slice(0, 160) : null,
            target_id: input.targetId ?? null,
            page_url: input.pageUrl ? input.pageUrl.slice(0, 300) : null,
          })
          .select('id')
          .single()
        if (error || !data) fail('Could not record feedback', error)
        return String((data as Record<string, unknown>).id)
      },
    },

    profiles: {
      async get(userId) {
        const { data, error } = await client.from<Record<string, unknown>>('profiles').select('*').eq('id', userId).maybeSingle()
        if (error) fail('Could not read profile', error)
        return data ?? null
      },
      async upsert(userId, patch) {
        const { error } = await client
          .from('profiles')
          .upsert({ id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' })
        if (error) fail('Could not save profile', error)
      },
    },

    dataRights: {
      async export(userId) {
        // `profiles` is keyed by `id`; everything else is keyed by `user_id`.
        // Preferences live in `profiles` (see migrations/001_graphmentor_core.sql).
        const tables = ['profiles', 'saved_roadmaps', 'roadmap_tasks', 'user_skill_progress', 'bookmarks', 'feedback']
        const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), userId }
        for (const table of tables) {
          const { data, error } = await client.from<Record<string, unknown>>(table).select('*').eq(table === 'profiles' ? 'id' : 'user_id', userId).limit(1000)
          if (error) {
            out[table] = { error: 'not-available' }
            continue
          }
          out[table] = data ?? []
        }
        return out
      },

      async deleteAll(userId) {
        let deleted = 0
        for (const table of ['roadmap_tasks', 'saved_roadmaps', 'user_skill_progress', 'bookmarks', 'profiles']) {
          const { data, error } = await client
            .from<Record<string, unknown>>(table)
            .delete()
            .eq(table === 'profiles' ? 'id' : 'user_id', userId)
            .select('id')
          if (!error) deleted += (data ?? []).length
        }
        return { deleted }
      },
    },
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/* ==========================================================================
 * Row → shared type adapters
 * ========================================================================== */

export function roadmapRowToRoadmap(roadmap: RoadmapRow, tasks: RoadmapTaskRow[]): Roadmap {
  const mapped: RoadmapTask[] = tasks.map((task) => ({
    order: task.order_index,
    // The row id *is* the stable identity: the progress endpoint keys on it.
    taskKey: task.id,
    kind: taskKindFromName(task.name),
    skillId: task.skill_id,
    name: task.name,
    difficulty: (task.difficulty as RoadmapTask['difficulty']) ?? 'beginner',
    reason: '',
    essential: task.essential,
    estimatedHours: [task.estimated_hours_low, task.estimated_hours_high],
    dependsOn: [],
    unlocks: [],
    practice: [],
    completionCriteria: [],
    resourceIds: [],
    projectIds: [],
    status: task.status,
    scheduledWeek: task.scheduled_week,
    ...(task.scheduled_day !== null ? { scheduledDay: task.scheduled_day } : {}),
    ...(task.note ? { notes: task.note } : {}),
    ...(task.actual_hours !== null ? { actualHours: task.actual_hours } : {}),
  }))

  return {
    id: roadmap.id,
    userId: roadmap.user_id,
    title: roadmap.title,
    careerId: roadmap.career_id,
    careerName: roadmap.career_name,
    createdAt: roadmap.created_at,
    updatedAt: roadmap.updated_at,
    weeklyHours: roadmap.weekly_hours,
    pace: (roadmap.pace as Roadmap['pace']) ?? 'steady',
    tasks: mapped,
    milestones: Array.isArray(roadmap.milestones) ? (roadmap.milestones as Roadmap['milestones']) : [],
    estimateDisclaimer: roadmap.estimate_disclaimer,
  }
}


