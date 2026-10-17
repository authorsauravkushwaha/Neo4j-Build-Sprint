/**
 * Neo4j persistence for user-owned records.
 *
 * Supabase is used for sign-in only (token verification in `supabaseStore.ts`
 * `createAuthVerifier`). Everything a user creates or the server must remember
 * lives here: roadmaps and their tasks, skill ratings, bookmarks, feedback,
 * profile preferences, the rate-limit windows and the nonce replay ledger.
 * The schema is `neo4j/user-schema.cypher`; the design is `docs/neo4j-schema.md`.
 *
 * Security rules this module enforces:
 *  - every query that reads or writes user data starts from
 *    `(:AppUser {id: $userId})` or matches a node whose `userId` is `$userId`,
 *    so one account can never address another account's nodes by guessing ids,
 *  - all values travel as Query API parameters; Cypher text is a fixed constant
 *    (no string interpolation of user input anywhere),
 *  - an id supplied by a client is only reused when it already belongs to that
 *    account; otherwise the server generates a fresh id (no cross-account overwrite),
 *  - writes are retried only when Neo4j reports the transaction rolled back (see
 *    `neo4jQueryApi.ts`), so a retry cannot apply a write twice,
 *  - replay protection fails closed: a store error means the request is refused.
 *
 * Shapes returned to handlers use the same snake_case row types as the
 * previous storage contract (`UserRepositories` in `supabaseStore.ts`), so
 * handlers and the frontend API are unchanged.
 */
import type { FixedWindowStore } from '../core/rateLimit.ts'
import type { NonceStore } from '../core/security.ts'
import type { QueryApiClient } from '../core/neo4jQueryApi.ts'
import type { Roadmap, SkillState, TaskStatus } from '../core/types.ts'
import {
  PersistenceError,
  type BookmarkRow,
  type RoadmapRow,
  type RoadmapTaskRow,
  type SkillProgressRow,
  type UserRepositories,
} from './supabaseStore.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Profile preference fields: [contract name (snake_case), Neo4j property (camelCase)]. */
const PROFILE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['education_level', 'educationLevel'],
  ['branch', 'branch'],
  ['career_goal_id', 'careerGoalId'],
  ['interests', 'interests'],
  ['weekly_hours', 'weeklyHours'],
  ['preferred_pace', 'preferredPace'],
  ['learning_style', 'learningStyle'],
  ['goal_note', 'goalNote'],
  ['theme', 'theme'],
  ['reduced_motion', 'reducedMotion'],
]

/* -------------------------------------------------------------------------- */
/* Cypher (fixed text; every value is a $parameter)                           */
/* -------------------------------------------------------------------------- */

const ROADMAP_COLUMNS = `
  r.id AS id, r.userId AS userId, r.title AS title, r.careerId AS careerId,
  r.careerName AS careerName, r.weeklyHours AS weeklyHours, r.pace AS pace,
  r.estimateDisclaimer AS estimateDisclaimer, r.milestonesJson AS milestonesJson,
  r.createdAt AS createdAt, r.updatedAt AS updatedAt`

const TASK_COLUMNS = `
  t.id AS id, t.roadmapId AS roadmapId, t.userId AS userId, t.skillId AS skillId,
  t.name AS name, t.status AS status, t.difficulty AS difficulty, t.orderIndex AS orderIndex,
  t.scheduledWeek AS scheduledWeek, t.scheduledDay AS scheduledDay,
  t.estimatedHoursLow AS estimatedHoursLow, t.estimatedHoursHigh AS estimatedHoursHigh,
  t.essential AS essential, t.note AS note, t.actualHours AS actualHours, t.updatedAt AS updatedAt`

const BOOKMARK_COLUMNS = `
  b.id AS id, b.userId AS userId, b.targetType AS targetType, b.targetId AS targetId,
  b.note AS note, b.createdAt AS createdAt`

/** Every Cypher statement the account store sends. Exported for the schema-consistency test. */
const Q = {
  roadmapList: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(r:Roadmap)
    RETURN ${ROADMAP_COLUMNS}
    ORDER BY r.updatedAt DESC
    LIMIT $limit`,
  roadmapGet: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(r:Roadmap {id: $roadmapId})
    RETURN ${ROADMAP_COLUMNS}`,
  roadmapOwnedId: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(r:Roadmap {id: $roadmapId})
    RETURN r.id AS id`,
  tasksForRoadmap: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(:Roadmap {id: $roadmapId})-[:HAS_TASK]->(t:RoadmapTask)
    RETURN ${TASK_COLUMNS}
    ORDER BY t.orderIndex ASC
    LIMIT $limit`,
  roadmapUpsert: `
    MERGE (u:AppUser {id: $userId})
      ON CREATE SET u.createdAt = $now
    MERGE (r:Roadmap {id: $roadmapId})
      ON CREATE SET r.createdAt = $now
    SET r.userId = $userId,
        r.title = $title,
        r.careerId = $careerId,
        r.careerName = $careerName,
        r.weeklyHours = $weeklyHours,
        r.pace = $pace,
        r.estimateDisclaimer = $estimateDisclaimer,
        r.milestonesJson = $milestonesJson,
        r.updatedAt = $now
    MERGE (u)-[:OWNS]->(r)
    RETURN r.id AS id`,
  taskUpsert: `
    MATCH (r:Roadmap {id: $roadmapId, userId: $userId})
    UNWIND $tasks AS row
    MERGE (r)-[:HAS_TASK]->(t:RoadmapTask {key: row.key})
      ON CREATE SET t.id = row.id, t.createdAt = $now
    SET t.userId = $userId,
        t.roadmapId = $roadmapId,
        t.skillId = row.skillId,
        t.name = row.name,
        t.status = row.status,
        t.difficulty = row.difficulty,
        t.orderIndex = row.orderIndex,
        t.scheduledWeek = row.scheduledWeek,
        t.scheduledDay = row.scheduledDay,
        t.estimatedHoursLow = row.estimatedHoursLow,
        t.estimatedHoursHigh = row.estimatedHoursHigh,
        t.essential = row.essential,
        t.note = row.note,
        t.actualHours = row.actualHours,
        t.updatedAt = $now
    RETURN count(t) AS saved`,
  roadmapDelete: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(r:Roadmap {id: $roadmapId})
    OPTIONAL MATCH (r)-[:HAS_TASK]->(t:RoadmapTask)
    WITH r, collect(t) AS tasks
    FOREACH (x IN tasks | DETACH DELETE x)
    DETACH DELETE r
    RETURN 1 AS removed`,
  taskUpdate: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(:Roadmap {id: $roadmapId})-[:HAS_TASK]->(t:RoadmapTask {id: $taskId})
    SET t.status = $status, t.note = $note, t.actualHours = $actualHours, t.updatedAt = $now
    RETURN ${TASK_COLUMNS}`,
  progressReset: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(r:Roadmap)-[:HAS_TASK]->(t:RoadmapTask)
    WHERE $roadmapId = '' OR r.id = $roadmapId
    SET t.status = 'not-started', t.actualHours = null, t.updatedAt = $now
    RETURN count(t) AS updated`,
  skillsUpsert: `
    MERGE (u:AppUser {id: $userId})
      ON CREATE SET u.createdAt = $now
    WITH u
    UNWIND $ratings AS row
    MERGE (u)-[:HAS_RATING]->(rt:SkillRating {key: row.key})
      ON CREATE SET rt.id = row.id, rt.userId = $userId, rt.skillId = row.skillId, rt.createdAt = $now
    SET rt.state = row.state, rt.quizScore = row.quizScore, rt.updatedAt = $now
    WITH rt, row
    OPTIONAL MATCH (s:Skill {id: row.skillId})
    FOREACH (x IN CASE WHEN s IS NULL THEN [] ELSE [s] END | MERGE (rt)-[:RATES]->(x))
    RETURN count(rt) AS saved`,
  skillsList: `
    MATCH (:AppUser {id: $userId})-[:HAS_RATING]->(rt:SkillRating)
    RETURN rt.id AS id, rt.userId AS userId, rt.skillId AS skillId, rt.state AS state,
           rt.quizScore AS quizScore, rt.updatedAt AS updatedAt
    LIMIT $limit`,
  skillsClear: `
    MATCH (:AppUser {id: $userId})-[:HAS_RATING]->(rt:SkillRating)
    WITH collect(rt) AS ratings
    FOREACH (x IN ratings | DETACH DELETE x)
    RETURN size(ratings) AS cleared`,
  bookmarkAdd: `
    MERGE (u:AppUser {id: $userId})
      ON CREATE SET u.createdAt = $now
    MERGE (u)-[:SAVED]->(b:Bookmark {key: $key})
      ON CREATE SET b.id = $id, b.userId = $userId, b.createdAt = $now
    SET b.targetType = $targetType, b.targetId = $targetId, b.note = $note
    RETURN ${BOOKMARK_COLUMNS}`,
  bookmarkRemove: `
    MATCH (b:Bookmark {key: $key})
    WHERE b.userId = $userId
    DETACH DELETE b
    RETURN count(*) AS removed`,
  bookmarkList: `
    MATCH (:AppUser {id: $userId})-[:SAVED]->(b:Bookmark)
    RETURN ${BOOKMARK_COLUMNS}
    ORDER BY b.createdAt DESC
    LIMIT $limit`,
  feedbackCreate: `
    CREATE (f:Feedback {
      id: $id, userId: $userId, kind: $kind, message: $message, contact: $contact,
      targetId: $targetId, pageUrl: $pageUrl, createdAt: $now
    })
    RETURN f.id AS id`,
  feedbackList: `
    MATCH (f:Feedback {userId: $userId})
    RETURN f.id AS id, f.userId AS userId, f.kind AS kind, f.message AS message,
           f.contact AS contact, f.targetId AS targetId, f.pageUrl AS pageUrl, f.createdAt AS createdAt
    ORDER BY f.createdAt DESC
    LIMIT $limit`,
  profileGet: `
    MATCH (u:AppUser {id: $userId})
    RETURN properties(u) AS props`,
  profileUpsert: `
    MERGE (u:AppUser {id: $userId})
      ON CREATE SET u.createdAt = $now
    SET u += $profile, u.updatedAt = $now
    RETURN u.id AS id`,
  accountDeleteTasks: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(:Roadmap)-[:HAS_TASK]->(t:RoadmapTask)
    WITH collect(t) AS items
    FOREACH (x IN items | DETACH DELETE x)
    RETURN size(items) AS deleted`,
  accountDeleteRoadmaps: `
    MATCH (:AppUser {id: $userId})-[:OWNS]->(r:Roadmap)
    WITH collect(r) AS items
    FOREACH (x IN items | DETACH DELETE x)
    RETURN size(items) AS deleted`,
  accountDeleteBookmarks: `
    MATCH (:AppUser {id: $userId})-[:SAVED]->(b:Bookmark)
    WITH collect(b) AS items
    FOREACH (x IN items | DETACH DELETE x)
    RETURN size(items) AS deleted`,
  accountDeleteProfile: `
    MATCH (u:AppUser {id: $userId})
    WITH collect(u) AS items
    FOREACH (x IN items | DETACH DELETE x)
    RETURN size(items) AS deleted`,
  rateLimitIncrement: `
    MERGE (b:RateLimitBucket {id: $bucketId})
      ON CREATE SET b.expiresAt = $expiresAt, b.createdAt = $now
    SET b.count = coalesce(b.count, 0) + 1
    RETURN b.count AS count`,
  rateLimitPrune: `
    MATCH (b:RateLimitBucket)
    WHERE b.expiresAt < $nowMs
    WITH b LIMIT $batch
    DETACH DELETE b
    RETURN count(*) AS removed`,
  noncePrune: `
    MATCH (n:UsedNonce)
    WHERE n.expiresAt < $nowMs
    WITH n LIMIT $batch
    DETACH DELETE n
    RETURN count(*) AS removed`,
  nonceClaim: `
    MERGE (n:UsedNonce {nonce: $nonce})
      ON CREATE SET n.expiresAt = $expiresAt, n.replays = 0, n.createdAt = $now
      ON MATCH SET n.replays = coalesce(n.replays, 0) + 1
    RETURN n.replays = 0 AS fresh`,
} as const

export const USER_DATA_CYPHER: Readonly<Record<keyof typeof Q, string>> = Q

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value))
const nullableStr = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
const nullableNum = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

function parseMilestones(value: unknown): unknown[] {
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function assertUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new PersistenceError(`${field} must be a UUID`)
  return value
}

function mapRoadmapRow(row: Row): RoadmapRow {
  return {
    id: str(row.id),
    user_id: str(row.userId),
    title: str(row.title),
    career_id: str(row.careerId),
    career_name: str(row.careerName),
    weekly_hours: Number(row.weeklyHours),
    pace: str(row.pace),
    estimate_disclaimer: str(row.estimateDisclaimer),
    milestones: parseMilestones(row.milestonesJson),
    created_at: str(row.createdAt),
    updated_at: str(row.updatedAt),
  }
}

function mapTaskRow(row: Row): RoadmapTaskRow {
  return {
    id: str(row.id),
    roadmap_id: str(row.roadmapId),
    user_id: str(row.userId),
    skill_id: str(row.skillId),
    name: str(row.name),
    status: row.status as TaskStatus,
    difficulty: str(row.difficulty),
    order_index: Number(row.orderIndex),
    scheduled_week: Number(row.scheduledWeek),
    scheduled_day: nullableNum(row.scheduledDay),
    estimated_hours_low: Number(row.estimatedHoursLow),
    estimated_hours_high: Number(row.estimatedHoursHigh),
    essential: Boolean(row.essential),
    note: nullableStr(row.note),
    actual_hours: nullableNum(row.actualHours),
    updated_at: str(row.updatedAt),
  }
}

function mapBookmarkRow(row: Row): BookmarkRow {
  return {
    id: str(row.id),
    user_id: str(row.userId),
    target_type: str(row.targetType),
    target_id: str(row.targetId),
    note: nullableStr(row.note),
    created_at: str(row.createdAt),
  }
}

function mapSkillRow(row: Row): SkillProgressRow {
  return {
    id: str(row.id),
    user_id: str(row.userId),
    skill_id: str(row.skillId),
    state: row.state as SkillState,
    quiz_score: nullableNum(row.quizScore),
    updated_at: str(row.updatedAt),
  }
}

/* -------------------------------------------------------------------------- */
/* User repositories                                                          */
/* -------------------------------------------------------------------------- */

export function createNeo4jUserRepositories(client: QueryApiClient): UserRepositories {
  /** Runs a statement; any store failure surfaces as PersistenceError (handlers map it to a safe response). */
  async function exec(cypher: string, params: Record<string, unknown>, options: { write?: boolean; tag: string; message: string }): Promise<Row[]> {
    try {
      const result = await client.run(cypher, params, { write: options.write === true, tag: options.tag })
      return result.rows as Row[]
    } catch (error) {
      throw new PersistenceError(options.message, error)
    }
  }

  const readRoadmapTasks = async (userId: string, roadmapId: string): Promise<RoadmapTaskRow[]> => {
    const rows = await exec(Q.tasksForRoadmap, { userId, roadmapId, limit: 500 }, { tag: 'ACCOUNT_TASKS', message: 'Could not read roadmap tasks' })
    return rows.map(mapTaskRow)
  }

  const exportRoadmaps = async (userId: string, limit: number) => {
    const rows = await exec(Q.roadmapList, { userId, limit }, { tag: 'ACCOUNT_ROADMAPS', message: 'Could not list roadmaps' })
    const out: Array<{ roadmap: RoadmapRow; tasks: RoadmapTaskRow[] }> = []
    for (const row of rows) {
      const roadmap = mapRoadmapRow(row)
      out.push({ roadmap, tasks: await readRoadmapTasks(userId, roadmap.id) })
    }
    return out
  }

  const repos: UserRepositories = {
    roadmaps: {
      async list(userId) {
        return exportRoadmaps(userId, 20)
      },

      async get(userId, roadmapId) {
        assertUuid(roadmapId, 'roadmapId')
        const rows = await exec(Q.roadmapGet, { userId, roadmapId }, { tag: 'ROADMAP_GET', message: 'Could not read roadmap' })
        if (rows.length === 0) return null
        const roadmap = mapRoadmapRow(rows[0])
        return { roadmap, tasks: await readRoadmapTasks(userId, roadmap.id) }
      },

      async save(userId, roadmap: Roadmap) {
        // Ownership is proved before the client-supplied id is used. An id that is
        // not already this account's roadmap is discarded and the save becomes a
        // create with a fresh server-generated id.
        let ownedId: string | null = null
        if (roadmap.id && UUID_PATTERN.test(roadmap.id)) {
          const rows = await exec(Q.roadmapOwnedId, { userId, roadmapId: roadmap.id }, { tag: 'ROADMAP_OWNED', message: 'Could not verify roadmap ownership' })
          ownedId = rows.length > 0 ? str(rows[0].id) : null
        }
        const now = new Date().toISOString()
        const roadmapId = ownedId ?? crypto.randomUUID()

        const written = await exec(
          Q.roadmapUpsert,
          {
            userId,
            roadmapId,
            now,
            title: roadmap.title.slice(0, 120),
            careerId: roadmap.careerId,
            careerName: roadmap.careerName.slice(0, 160),
            weeklyHours: roadmap.weeklyHours,
            pace: roadmap.pace,
            estimateDisclaimer: roadmap.estimateDisclaimer.slice(0, 600),
            milestonesJson: JSON.stringify(roadmap.milestones.slice(0, 40)),
          },
          { write: true, tag: 'ROADMAP_UPSERT', message: 'Could not save roadmap' },
        )
        if (written.length === 0) throw new PersistenceError('Could not save roadmap')

        const tasks = roadmap.tasks.slice(0, 120).map((task) => {
          const orderIndex = Math.max(0, Math.trunc(task.order))
          return {
            key: `${roadmapId}|${orderIndex}|${task.skillId}`,
            id: crypto.randomUUID(),
            skillId: task.skillId,
            name: task.name.slice(0, 160),
            status: task.status,
            difficulty: task.difficulty,
            orderIndex,
            scheduledWeek: Math.max(1, Math.trunc(task.scheduledWeek)),
            scheduledDay: typeof task.scheduledDay === 'number' ? task.scheduledDay : null,
            estimatedHoursLow: clampNumber(task.estimatedHours[0], 0, 400),
            estimatedHoursHigh: clampNumber(task.estimatedHours[1], 0, 600),
            essential: task.essential,
            note: task.notes ? task.notes.slice(0, 600) : null,
            actualHours: typeof task.actualHours === 'number' ? clampNumber(task.actualHours, 0, 200) : null,
          }
        })

        if (tasks.length > 0) {
          await exec(Q.taskUpsert, { userId, roadmapId, now: new Date().toISOString(), tasks }, {
            write: true,
            tag: 'TASK_UPSERT',
            message: 'Could not save roadmap tasks',
          })
        }
        return { roadmapId, taskCount: tasks.length }
      },

      async remove(userId, roadmapId) {
        assertUuid(roadmapId, 'roadmapId')
        await exec(Q.roadmapDelete, { userId, roadmapId }, { write: true, tag: 'ROADMAP_DELETE', message: 'Could not delete roadmap' })
        return true
      },
    },

    progress: {
      async updateTask(userId, input) {
        assertUuid(input.roadmapId, 'roadmapId')
        assertUuid(input.taskId, 'taskId')
        const rows = await exec(
          Q.taskUpdate,
          {
            userId,
            roadmapId: input.roadmapId,
            taskId: input.taskId,
            status: input.status,
            note: input.note ? input.note.slice(0, 600) : null,
            actualHours: typeof input.actualHours === 'number' ? clampNumber(input.actualHours, 0, 200) : null,
            now: new Date().toISOString(),
          },
          { write: true, tag: 'TASK_UPDATE', message: 'Could not update task' },
        )
        // Missing and foreign tasks are reported identically so ids cannot be probed.
        if (rows.length === 0) throw new PersistenceError('Task not found for this account')
        return mapTaskRow(rows[0])
      },

      async reset(userId, roadmapId) {
        const scope = roadmapId ? assertUuid(roadmapId, 'roadmapId') : ''
        const rows = await exec(Q.progressReset, { userId, roadmapId: scope, now: new Date().toISOString() }, {
          write: true,
          tag: 'PROGRESS_RESET',
          message: 'Could not reset progress',
        })
        return rows.length > 0 ? Number(rows[0].updated) || 0 : 0
      },
    },

    skills: {
      async upsert(userId, ratings) {
        if (ratings.length === 0) return 0
        const now = new Date().toISOString()
        const rows = ratings.slice(0, 150).map((rating) => ({
          key: `${userId}|${rating.skillId}`,
          id: crypto.randomUUID(),
          skillId: rating.skillId,
          state: rating.state,
          quizScore: typeof rating.quizScore === 'number' ? Math.min(1, Math.max(0, rating.quizScore)) : null,
        }))
        const result = await exec(Q.skillsUpsert, { userId, now, ratings: rows }, {
          write: true,
          tag: 'SKILLS_UPSERT',
          message: 'Could not save skill ratings',
        })
        return result.length > 0 ? Number(result[0].saved) || 0 : 0
      },

      async list(userId) {
        const rows = await exec(Q.skillsList, { userId, limit: 300 }, { tag: 'SKILLS_LIST', message: 'Could not read skill ratings' })
        return rows.map(mapSkillRow)
      },

      async clear(userId) {
        const rows = await exec(Q.skillsClear, { userId }, { write: true, tag: 'SKILLS_CLEAR', message: 'Could not clear skill ratings' })
        return rows.length > 0 ? Number(rows[0].cleared) || 0 : 0
      },
    },

    bookmarks: {
      async add(userId, targetType, targetId, note) {
        const rows = await exec(
          Q.bookmarkAdd,
          {
            userId,
            key: `${userId}|${targetId}`,
            id: crypto.randomUUID(),
            targetType,
            targetId,
            note: note ? note.slice(0, 400) : null,
            now: new Date().toISOString(),
          },
          { write: true, tag: 'BOOKMARK_ADD', message: 'Could not save bookmark' },
        )
        if (rows.length === 0) throw new PersistenceError('Could not save bookmark')
        return mapBookmarkRow(rows[0])
      },

      async remove(userId, targetId) {
        await exec(Q.bookmarkRemove, { userId, key: `${userId}|${targetId}` }, {
          write: true,
          tag: 'BOOKMARK_REMOVE',
          message: 'Could not remove bookmark',
        })
        return true
      },

      async list(userId) {
        const rows = await exec(Q.bookmarkList, { userId, limit: 200 }, { tag: 'BOOKMARK_LIST', message: 'Could not list bookmarks' })
        return rows.map(mapBookmarkRow)
      },
    },

    feedback: {
      async submit(userId, input) {
        const rows = await exec(
          Q.feedbackCreate,
          {
            id: crypto.randomUUID(),
            // Guests may submit feedback; the row is then anonymous (userId null).
            userId,
            kind: input.kind,
            message: input.message.slice(0, 1500),
            contact: input.contact ? input.contact.slice(0, 160) : null,
            targetId: input.targetId ?? null,
            pageUrl: input.pageUrl ? input.pageUrl.slice(0, 300) : null,
            now: new Date().toISOString(),
          },
          { write: true, tag: 'FEEDBACK_CREATE', message: 'Could not record feedback' },
        )
        if (rows.length === 0) throw new PersistenceError('Could not record feedback')
        return str(rows[0].id)
      },
    },

    profiles: {
      async get(userId) {
        const rows = await exec(Q.profileGet, { userId }, { tag: 'PROFILE_GET', message: 'Could not read profile' })
        if (rows.length === 0) return null
        const props = (rows[0].props ?? {}) as Row
        const out: Row = { id: userId }
        for (const [column, property] of PROFILE_FIELDS) {
          if (property in props) out[column] = props[property]
        }
        if ('createdAt' in props) out.created_at = str(props.createdAt)
        if ('updatedAt' in props) out.updated_at = str(props.updatedAt)
        return out
      },

      async upsert(userId, patch) {
        // Only whitelisted preference fields are written; the handler already
        // validates them, and this keeps the store safe if it is ever called directly.
        const profile: Row = {}
        for (const [column, property] of PROFILE_FIELDS) {
          if (patch[column] !== undefined) profile[property] = patch[column]
        }
        await exec(Q.profileUpsert, { userId, now: new Date().toISOString(), profile }, {
          write: true,
          tag: 'PROFILE_UPSERT',
          message: 'Could not save profile',
        })
      },
    },

    dataRights: {
      async export(userId) {
        const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), userId }
        const profile = await repos.profiles.get(userId)
        out.profiles = profile ? [profile] : []
        const roadmaps = await exportRoadmaps(userId, 1000)
        out.saved_roadmaps = roadmaps.map((entry) => entry.roadmap)
        out.roadmap_tasks = roadmaps.flatMap((entry) => entry.tasks)
        out.user_skill_progress = await repos.skills.list(userId)
        out.bookmarks = await repos.bookmarks.list(userId)
        const feedback = await exec(Q.feedbackList, { userId, limit: 1000 }, { tag: 'FEEDBACK_LIST', message: 'Could not read feedback' })
        out.feedback = feedback.map((row) => ({
          id: str(row.id),
          user_id: nullableStr(row.userId),
          kind: str(row.kind),
          message: str(row.message),
          contact: nullableStr(row.contact),
          target_id: nullableStr(row.targetId),
          page_url: nullableStr(row.pageUrl),
          created_at: str(row.createdAt),
        }))
        return out
      },

      async deleteAll(userId) {
        // Feedback is intentionally kept (it is anonymous product input); the sign-in
        // account itself is managed by Supabase Auth and is not deleted here.
        let deleted = 0
        for (const [tag, cypher] of [
          ['ACCOUNT_DELETE_TASKS', Q.accountDeleteTasks],
          ['ACCOUNT_DELETE_ROADMAPS', Q.accountDeleteRoadmaps],
          ['ACCOUNT_DELETE_BOOKMARKS', Q.accountDeleteBookmarks],
          ['SKILLS_CLEAR', Q.skillsClear],
          ['ACCOUNT_DELETE_PROFILE', Q.accountDeleteProfile],
        ] as const) {
          const rows = await exec(cypher, { userId }, { write: true, tag, message: 'Could not delete account data' })
          const counted = rows.length > 0 ? Number(rows[0].deleted ?? rows[0].cleared) || 0 : 0
          deleted += counted
        }
        return { deleted }
      },
    },
  }
  return repos
}

/* -------------------------------------------------------------------------- */
/* Rate limiting and replay protection                                        */
/* -------------------------------------------------------------------------- */

const PRUNE_BATCH = 500
const PRUNE_MAX_BATCHES = 10

/**
 * Fixed-window counter, epoch-anchored so every instance agrees on the window.
 * Each window is a `RateLimitBucket` node; expired buckets are pruned by cleanup().
 */
export function createNeo4jFixedWindowStore(client: QueryApiClient): FixedWindowStore {
  return {
    async increment(key: string, windowSeconds: number, nowMs: number = Date.now()): Promise<number> {
      if (key.length < 4 || key.length > 200) throw new PersistenceError('invalid rate-limit key')
      const window = Math.max(1, Math.min(Math.trunc(windowSeconds), 86_400))
      const windowStart = Math.floor(nowMs / 1000 / window) * window
      const result = await client.run(
        Q.rateLimitIncrement,
        {
          bucketId: `${key}|${window}|${windowStart}`,
          expiresAt: (windowStart + 2 * window) * 1000,
          now: new Date(nowMs).toISOString(),
        },
        { write: true, tag: 'RATE_LIMIT_INCREMENT' },
      ).catch((error: unknown) => {
        throw new PersistenceError('rate limit store unavailable', error)
      })
      const count = result.rows.length > 0 ? Number(result.rows[0].count) : 0
      return Number.isFinite(count) ? count : 0
    },

    async cleanup(nowMs: number = Date.now()): Promise<void> {
      await pruneExpired(client, 'RateLimitBucket', Q.rateLimitPrune, 'RATE_LIMIT_PRUNE', 'rate limit cleanup failed', nowMs)
      await pruneExpired(client, 'UsedNonce', Q.noncePrune, 'NONCE_PRUNE', 'nonce cleanup failed', nowMs)
    },
  }
}

async function pruneExpired(client: QueryApiClient, label: string, cypher: string, tag: string, message: string, nowMs: number): Promise<number> {
  let total = 0
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    let removed = 0
    try {
      const result = await client.run(cypher, { nowMs, batch: PRUNE_BATCH }, { write: true, tag })
      removed = result.rows.length > 0 ? Number(result.rows[0].removed) || 0 : 0
    } catch (error) {
      throw new PersistenceError(`${message} (${label})`, error)
    }
    total += removed
    if (removed < PRUNE_BATCH) break
  }
  return total
}

/**
 * Replay ledger. `claim` returns true only the first time a nonce is seen within
 * its retention window. Any store failure throws, so the caller refuses the
 * request (fail closed).
 */
export function createNeo4jNonceStore(client: QueryApiClient): NonceStore {
  return {
    async claim(nonce: string, expiresInMs: number): Promise<boolean> {
      if (nonce.length < 8 || nonce.length > 200) throw new PersistenceError('invalid nonce')
      const ttlSeconds = Math.max(30, Math.ceil(expiresInMs / 1000))
      const now = Date.now()
      try {
        const result = await client.run(
          Q.nonceClaim,
          { nonce, expiresAt: now + ttlSeconds * 1000, now: new Date(now).toISOString() },
          { write: true, tag: 'NONCE_CLAIM' },
        )
        return result.rows.length > 0 && result.rows[0].fresh === true
      } catch (error) {
        throw new PersistenceError('nonce store unavailable', error)
      }
    },
  }
}
