/**
 * In-memory implementation of `UserRepositories` for integration tests.
 *
 * It mirrors the ownership rule the real Postgres layer enforces with RLS: every
 * method takes a `userId` and only ever touches rows carrying that id, and an
 * attempt to act on another user's row behaves exactly like a missing row. That
 * makes "authentication is not authorisation" testable without a database.
 */
import type { Roadmap, SkillState, TaskStatus } from '@core/types.ts'
import { PersistenceError } from '../../supabase/functions/_shared/platform/supabaseStore.ts'
import type {
  BookmarkRow,
  RoadmapRow,
  RoadmapTaskRow,
  SkillProgressRow,
  UserRepositories,
} from '../../supabase/functions/_shared/platform/supabaseStore.ts'

let counter = 0
/**
 * The API schemas require uuid ids, so the fake store hands out uuid *shaped*
 * values (deterministic, so tests can assert on them) rather than `prefix-1`
 * strings that the validation layer would reject before reaching the repository.
 */
const nextId = (prefix: string): string => {
  counter += 1
  const suffix = `${prefix.charCodeAt(0).toString(16)}${counter.toString(16).padStart(7, '0')}`
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0').slice(0, 12)}`
}

export function createInMemoryRepos(): UserRepositories & {
  /** Test-only inspector: rows currently held, for assertions. */
  snapshot(): { roadmaps: RoadmapRow[]; tasks: RoadmapTaskRow[]; bookmarks: BookmarkRow[]; skills: SkillProgressRow[]; feedback: Array<Record<string, unknown>> }
} {
  const roadmaps = new Map<string, RoadmapRow>()
  // The row types describe what the API reads; the tables also carry a
  // `created_at` default, and the double has to store it or an export of the two
  // differs (see appwrite-backend.test.ts).
  type TaskRow = RoadmapTaskRow & { created_at: string }
  type SkillRow = SkillProgressRow & { created_at: string }
  const tasks = new Map<string, TaskRow>()
  const bookmarks = new Map<string, BookmarkRow>()
  const skills = new Map<string, SkillRow>()
  const feedback: Array<Record<string, unknown>> = []
  const profiles = new Map<string, Record<string, unknown>>()
  const now = (): string => new Date().toISOString()

  const tasksOf = (userId: string, roadmapId: string): RoadmapTaskRow[] =>
    [...tasks.values()].filter((task) => task.user_id === userId && task.roadmap_id === roadmapId).sort((a, b) => a.order_index - b.order_index)

  return {
    snapshot: () => ({
      roadmaps: [...roadmaps.values()],
      tasks: [...tasks.values()],
      bookmarks: [...bookmarks.values()],
      skills: [...skills.values()],
      feedback: [...feedback],
    }),

    roadmaps: {
      async list(userId) {
        return [...roadmaps.values()]
          .filter((roadmap) => roadmap.user_id === userId)
          .map((roadmap) => ({ roadmap, tasks: tasksOf(userId, roadmap.id) }))
      },
      async get(userId, roadmapId) {
        const roadmap = roadmaps.get(roadmapId)
        if (!roadmap || roadmap.user_id !== userId) return null
        return { roadmap, tasks: tasksOf(userId, roadmapId) }
      },
      async save(userId, roadmap: Roadmap) {
        const roadmapId = roadmap.id || nextId('roadmap')
        const stamp = now()
        roadmaps.set(roadmapId, {
          id: roadmapId,
          user_id: userId,
          title: roadmap.title,
          career_id: roadmap.careerId,
          career_name: roadmap.careerName,
          weekly_hours: roadmap.weeklyHours,
          pace: roadmap.pace,
          estimate_disclaimer: roadmap.estimateDisclaimer,
          milestones: roadmap.milestones,
          created_at: roadmaps.get(roadmapId)?.created_at ?? stamp,
          updated_at: stamp,
        })
        for (const task of tasks.values()) {
          if (task.roadmap_id === roadmapId && task.user_id === userId) tasks.delete(task.id)
        }
        roadmap.tasks.forEach((task, index) => {
          // Row ids are assigned here, never taken from the client's taskKey:
          // that key is a local progress key, and the two are reconciled when the
          // roadmap is read back (see roadmapRowToRoadmap).
          const id = nextId('task')
          tasks.set(id, {
            id,
            roadmap_id: roadmapId,
            user_id: userId,
            skill_id: task.skillId,
            name: task.name,
            status: (task.status ?? 'not-started') as TaskStatus,
            difficulty: task.difficulty,
            order_index: index,
            scheduled_week: task.scheduledWeek,
            scheduled_day: task.scheduledDay ?? null,
            estimated_hours_low: task.estimatedHours[0],
            estimated_hours_high: task.estimatedHours[1],
            essential: task.essential,
            note: task.notes ?? null,
            actual_hours: task.actualHours ?? null,
            // The Postgres table defaults both timestamps; the double used to
            // write only `updated_at`, so an export of the two rows differed.
            created_at: stamp,
            updated_at: stamp,
          })
        })
        return { roadmapId, taskCount: roadmap.tasks.length }
      },
      async remove(userId, roadmapId) {
        const roadmap = roadmaps.get(roadmapId)
        if (!roadmap || roadmap.user_id !== userId) return false
        roadmaps.delete(roadmapId)
        for (const task of [...tasks.values()]) {
          if (task.roadmap_id === roadmapId) tasks.delete(task.id)
        }
        return true
      },
    },

    progress: {
      async updateTask(userId, input) {
        const task = [...tasks.values()].find((candidate) => candidate.id === input.taskId)
        // Ownership check: another user's task is indistinguishable from a missing
        // one. The real store throws PersistenceError, which the handler maps to a
        // 404 without confirming that the row exists.
        if (!task || task.user_id !== userId) throw new PersistenceError('Task not found for this account')
        if (task.roadmap_id !== input.roadmapId) throw new PersistenceError('Task not found for this account')
        const updated: TaskRow = {
          ...task,
          status: input.status,
          note: input.note ?? task.note,
          actual_hours: input.actualHours ?? task.actual_hours,
          updated_at: now(),
        }
        tasks.set(updated.id, updated)
        return updated
      },
      async reset(userId, roadmapId) {
        let count = 0
        for (const task of [...tasks.values()]) {
          if (task.user_id !== userId) continue
          if (roadmapId && task.roadmap_id !== roadmapId) continue
          const reset: TaskRow = { ...task, status: 'not-started', actual_hours: null, updated_at: now() }
          tasks.set(reset.id, reset)
          count += 1
        }
        return count
      },
    },

    skills: {
      async upsert(userId, ratings) {
        let count = 0
        for (const rating of ratings) {
          const existing = [...skills.values()].find((row) => row.user_id === userId && row.skill_id === rating.skillId)
          const row: SkillRow = {
            id: existing?.id ?? nextId('skill'),
            user_id: userId,
            skill_id: rating.skillId,
            state: rating.state as SkillState,
            quiz_score: rating.quizScore ?? null,
            created_at: existing?.created_at ?? now(),
            updated_at: now(),
          }
          skills.set(row.id, row)
          count += 1
        }
        return count
      },
      async list(userId) {
        return [...skills.values()].filter((row) => row.user_id === userId)
      },
      async clear(userId) {
        let count = 0
        for (const row of [...skills.values()]) {
          if (row.user_id === userId) {
            skills.delete(row.id)
            count += 1
          }
        }
        return count
      },
    },

    bookmarks: {
      async add(userId, targetType, targetId, note) {
        /*
         * An omitted note clears the note, which is the behaviour of both other
         * implementations: the Postgres store writes `note ? slice : null`, and
         * the local client replaces the entry with `note ?? ''`. Preserving the
         * old note here (as this double used to) made the in-memory API disagree
         * with the API it stands in for — caught by appwrite-backend.test.ts,
         * which compares the two backends request by request.
         */
        const stored = note ? note.slice(0, 400) : null
        const existing = [...bookmarks.values()].find((row) => row.user_id === userId && row.target_id === targetId)
        if (existing) {
          const updated = { ...existing, target_type: targetType, note: stored }
          bookmarks.set(updated.id, updated)
          return updated
        }
        const row: BookmarkRow = {
          id: nextId('bookmark'),
          user_id: userId,
          target_type: targetType,
          target_id: targetId,
          note: stored,
          created_at: now(),
        }
        bookmarks.set(row.id, row)
        return row
      },
      async remove(userId, targetId) {
        const existing = [...bookmarks.values()].find((row) => row.user_id === userId && row.target_id === targetId)
        if (!existing) return false
        bookmarks.delete(existing.id)
        return true
      },
      async list(userId) {
        return [...bookmarks.values()].filter((row) => row.user_id === userId)
      },
    },

    feedback: {
      async submit(userId, input) {
        const id = nextId('feedback')
        feedback.push({ id, user_id: userId, ...input, created_at: now() })
        return id
      },
    },

    profiles: {
      async get(userId) {
        return profiles.get(userId) ?? null
      },
      async upsert(userId, patch) {
        profiles.set(userId, { ...(profiles.get(userId) ?? {}), ...patch, user_id: userId, updated_at: now() })
      },
    },

    dataRights: {
      async export(userId) {
        /*
         * The payload `createUserRepositories` produces, table by table — not a
         * friendlier redistribution of it.
         *
         * This used to return `{profile, roadmaps, roadmapsDetail, skillRatings,
         * bookmarks}`, which is a nicer document and tells a person less about
         * what is actually stored. It also meant the export a hosted user gets
         * (raw rows) was never the export under test. The double stands in for the
         * store, so it emits the store's shape; `appwrite-backend.test.ts` compares
         * the two request by request.
         */
        const profile = profiles.get(userId)
        return {
          exportedAt: now(),
          userId,
          profiles: profile ? [{ id: userId, ...profile, created_at: profile.created_at ?? now() }] : [],
          saved_roadmaps: [...roadmaps.values()].filter((row) => row.user_id === userId),
          roadmap_tasks: [...tasks.values()].filter((row) => row.user_id === userId),
          user_skill_progress: [...skills.values()].filter((row) => row.user_id === userId),
          bookmarks: [...bookmarks.values()].filter((row) => row.user_id === userId),
          feedback: feedback.filter((row) => row.user_id === userId),
        }
      },
      async deleteAll(userId) {
        let deleted = 0
        for (const [id, roadmap] of [...roadmaps.entries()]) {
          if (roadmap.user_id === userId) {
            roadmaps.delete(id)
            deleted += 1
          }
        }
        for (const [id, task] of [...tasks.entries()]) {
          if (task.user_id === userId) {
            tasks.delete(id)
            deleted += 1
          }
        }
        for (const [id, bookmark] of [...bookmarks.entries()]) {
          if (bookmark.user_id === userId) {
            bookmarks.delete(id)
            deleted += 1
          }
        }
        for (const [id, skill] of [...skills.entries()]) {
          if (skill.user_id === userId) {
            skills.delete(id)
            deleted += 1
          }
        }
        if (profiles.has(userId)) {
          profiles.delete(userId)
          deleted += 1
        }
        return { deleted }
      },
    },
  }
}


