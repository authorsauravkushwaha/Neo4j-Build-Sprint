/**
 * Authenticated, user-owned endpoints.
 *
 *   POST /save-roadmap     { roadmapId?, title, careerId, weeklyHours, pace, tasks[] }
 *   POST /update-progress  { roadmapId, taskId, status, note?, actualHours? }  |  { confirm: "RESET" }
 *   GET  /update-progress  -> saved roadmaps + tasks + real progress summary
 *   POST /manage-bookmarks { action: add|remove|list, targetType?, targetId?, note? }
 *   POST /submit-feedback  { kind, message, contact?, targetId?, pageUrl? }
 *   POST /manage-account   { action: export|delete-progress|delete-account|update-profile }
 *
 * Every endpoint here:
 *   1. verifies the caller's identity (Supabase JWT — authentication),
 *   2. scopes every query to that user id (authorisation; RLS is the second layer),
 *   3. never accepts an owner id from the request body.
 */
import { AppError, toAppError } from '../core/errors.ts'
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { json, parseJsonBody } from '../core/http.ts'
import {
  bookmarkBodySchema,
  feedbackBodySchema,
  parseOrThrow,
  progressQuerySchema,
  resetProgressBodySchema,
  saveRoadmapBodySchema,
  updateProgressBodySchema,
} from '../core/validate.ts'
import type {
  BookmarkResponse,
  FeedbackResponse,
  ProgressUpdateResponse,
  RoadmapGetResponse,
  RoadmapSaveResponse,
} from '../core/contracts.ts'
import { summarizeProgress } from '../core/recommend.ts'
import { sanitizeUntrustedText } from '../core/security.ts'
import { taskKeyFor, type Roadmap, type RoadmapTask } from '../core/types.ts'
import { PersistenceError, roadmapRowToRoadmap, type UserRepositories } from '../platform/supabaseStore.ts'
import type { Runtime } from '../runtime.ts'
import { enforceRateLimit, enforceSignedRequest, metaFor, requireRepos, requireUser } from './shared.ts'

/** Maps persistence failures to safe, actionable API errors. */
function asApiError(error: unknown, request: ApiRequest): AppError {
  if (error instanceof AppError) return error
  if (error instanceof PersistenceError) {
    const message = error.message.toLowerCase()
    if (message.includes('not found')) {
      return new AppError('not_found', {
        requestId: request.requestId,
        publicMessage: 'That record does not exist in your account. Reload the page and try again.',
      })
    }
    return new AppError('dependency_unavailable', {
      requestId: request.requestId,
      publicMessage: 'Your saved data could not be reached just now. Nothing was changed — please retry.',
      internal: error.message,
    })
  }
  return toAppError(error)
}

/* -------------------------------------------------------------------------- */
/* POST /save-roadmap                                                          */
/* -------------------------------------------------------------------------- */

export async function saveRoadmapHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const userId = await requireUser(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.writePerMinute, 'save-roadmap')
  await enforceSignedRequest(runtime, request)
  const repos = requireRepos(runtime, request)

  const input = parseOrThrow(saveRoadmapBodySchema, parseJsonBody(request))

  // The payload is the learner's own plan: store it verbatim after validation,
  // but recompute the derived fields server-side so a client cannot invent a
  // completion percentage.
  const tasks: RoadmapTask[] = input.tasks.map((task, index) => ({
    order: task.order ?? index,
    taskKey: task.taskKey ?? taskKeyFor(task.kind ?? 'learn', task.order ?? index),
    kind: task.kind ?? 'learn',
    skillId: task.skillId,
    name: task.name,
    difficulty: task.difficulty,
    reason: '',
    essential: task.essential,
    estimatedHours: [task.estimatedHoursLow, task.estimatedHoursHigh],
    dependsOn: [],
    unlocks: [],
    practice: [],
    completionCriteria: [],
    resourceIds: [],
    projectIds: [],
    status: task.status,
    scheduledWeek: task.scheduledWeek,
    ...(typeof task.scheduledDay === 'number' ? { scheduledDay: task.scheduledDay } : {}),
    ...(task.note ? { notes: task.note } : {}),
  }))

  const roadmap: Roadmap = {
    // Must be a uuid: the column is `uuid` and update-progress validates
    // roadmapId as one, so a timestamp id would be rejected by our own API.
    id: input.roadmapId ?? crypto.randomUUID(),
    userId,
    title: sanitizeUntrustedText(input.title, 120),
    careerId: input.careerId,
    careerName: `career:${input.careerId.split(':')[1] ?? ''}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    weeklyHours: input.weeklyHours,
    pace: input.pace,
    tasks,
    milestones: [],
    estimateDisclaimer:
      'Weeks and hours are planning estimates based on the study time you entered. They are not a promise of completion dates or mastery.',
  }

  try {
    const { roadmapId, taskCount } = await repos.roadmaps.save(userId, roadmap)
    const payload: RoadmapSaveResponse = { roadmapId, taskCount, updatedAt: new Date().toISOString() }
    return json(200, { ok: true, data: payload, meta: metaFor(runtime.reader ?? ({} as never), {}) }, { 'cache-control': 'no-store' })
  } catch (error) {
    throw asApiError(error, request)
  }
}

/* -------------------------------------------------------------------------- */
/* GET / update-progress                                                       */
/* -------------------------------------------------------------------------- */

export async function getRoadmapsHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const userId = await requireUser(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.readPerMinute, 'roadmap-read')
  const repos = requireRepos(runtime, request)
  const input = parseOrThrow(progressQuerySchema, {
    ...Object.fromEntries(request.url.searchParams.entries()),
  })

  try {
    const rows = await repos.roadmaps.list(userId)
    const mapped = rows.map(({ roadmap, tasks }) => {
      const full = roadmapRowToRoadmap(roadmap, tasks)
      return {
        id: full.id,
        title: full.title,
        careerId: full.careerId,
        careerName: full.careerName,
        weeklyHours: full.weeklyHours,
        pace: full.pace,
        createdAt: full.createdAt,
        updatedAt: full.updatedAt,
        progress: summarizeProgress(full.tasks),
      }
    })

    const activeRow = input.roadmapId ? rows.find((row) => row.roadmap.id === input.roadmapId) : rows[0]
    const active = activeRow ? roadmapRowToRoadmap(activeRow.roadmap, activeRow.tasks) : null

    const payload: RoadmapGetResponse = { roadmaps: mapped, active }
    return json(200, { ok: true, data: payload, meta: { source: 'cache', generatedAt: new Date().toISOString() } }, { 'cache-control': 'no-store' })
  } catch (error) {
    throw asApiError(error, request)
  }
}

export async function updateProgressHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const userId = await requireUser(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.writePerMinute, 'progress-write')
  await enforceSignedRequest(runtime, request)
  const repos = requireRepos(runtime, request)
  const body = parseJsonBody(request)

  // Reset is a separate, explicitly confirmed action.
  if (body && typeof body === 'object' && 'confirm' in (body as Record<string, unknown>)) {
    const input = parseOrThrow(resetProgressBodySchema, body)
    try {
      const affected = await repos.progress.reset(userId, input.roadmapId)
      const roads = await repos.roadmaps.list(userId)
      const activeRow = input.roadmapId ? roads.find((row) => row.roadmap.id === input.roadmapId) : roads[0]
      const progress = activeRow ? summarizeProgress(roadmapRowToRoadmap(activeRow.roadmap, activeRow.tasks).tasks) : null
      return json(
        200,
        {
          ok: true,
          data: { resetTasks: affected, progress },
          meta: { source: 'cache', generatedAt: new Date().toISOString() },
        },
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      throw asApiError(error, request)
    }
  }

  const input = parseOrThrow(updateProgressBodySchema, body)
  try {
    const task = await repos.progress.updateTask(userId, {
      roadmapId: input.roadmapId,
      taskId: input.taskId,
      status: input.status,
      ...(input.note ? { note: input.note } : {}),
      ...(typeof input.actualHours === 'number' ? { actualHours: input.actualHours } : {}),
    })

    // Recompute progress from the stored rows — never from a client-supplied count.
    const rows = await repos.roadmaps.list(userId)
    const row = rows.find((entry) => entry.roadmap.id === input.roadmapId)
    const progress = row ? summarizeProgress(roadmapRowToRoadmap(row.roadmap, row.tasks).tasks) : null

    const payload: ProgressUpdateResponse = {
      task: {
        id: task.id,
        skillId: task.skill_id,
        name: task.name,
        status: task.status,
        scheduledWeek: task.scheduled_week,
        actualHours: task.actual_hours,
        note: task.note,
        updatedAt: task.updated_at,
      },
      progress,
    }
    return json(200, { ok: true, data: payload, meta: { source: 'cache', generatedAt: new Date().toISOString() } }, { 'cache-control': 'no-store' })
  } catch (error) {
    throw asApiError(error, request)
  }
}

/* -------------------------------------------------------------------------- */
/* POST /manage-bookmarks                                                      */
/* -------------------------------------------------------------------------- */

export async function manageBookmarksHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const userId = await requireUser(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.writePerMinute, 'bookmarks')
  const repos = requireRepos(runtime, request)
  const input = parseOrThrow(bookmarkBodySchema, parseJsonBody(request))

  try {
    if (input.action === 'add') {
      if (!input.targetType || !input.targetId) {
        throw new AppError('validation_failed', {
          requestId: request.requestId,
          fields: { targetId: 'Choose what to bookmark.' },
        })
      }
      await repos.bookmarks.add(userId, input.targetType, input.targetId, input.note)
    } else if (input.action === 'remove') {
      if (!input.targetId) {
        throw new AppError('validation_failed', { requestId: request.requestId, fields: { targetId: 'Missing target.' } })
      }
      await repos.bookmarks.remove(userId, input.targetId)
    }

    const rows = await repos.bookmarks.list(userId)
    const payload: BookmarkResponse = {
      bookmarks: rows.map((row) => ({
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        note: row.note,
        createdAt: row.created_at,
      })),
      ...(input.action !== 'list' && input.targetId
        ? { changed: { action: input.action as 'add' | 'remove', targetId: input.targetId } }
        : {}),
    }
    return json(200, { ok: true, data: payload, meta: { source: 'cache', generatedAt: new Date().toISOString() } }, { 'cache-control': 'no-store' })
  } catch (error) {
    throw asApiError(error, request)
  }
}

/* -------------------------------------------------------------------------- */
/* POST /submit-feedback                                                       */
/* -------------------------------------------------------------------------- */

export async function submitFeedbackHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  // Feedback is accepted from signed-in users and guests; the row records which.
  const userId = await requireUserOrNull(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.writePerMinute, 'feedback')
  const repos = requireRepos(runtime, request)
  const input = parseOrThrow(feedbackBodySchema, parseJsonBody(request))

  try {
    const id = await repos.feedback.submit(userId, {
      kind: input.kind,
      message: input.message,
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
    })
    const payload: FeedbackResponse = {
      id,
      receivedAt: new Date().toISOString(),
      note: 'Thanks — feedback is stored in the project owner’s Supabase database. Contact details are optional and never used for marketing.',
    }
    return json(202, { ok: true, data: payload, meta: { source: 'cache', generatedAt: new Date().toISOString() } }, { 'cache-control': 'no-store' })
  } catch (error) {
    throw asApiError(error, request)
  }
}

async function requireUserOrNull(runtime: Runtime, request: ApiRequest): Promise<string | null> {
  const check = await runtime.verifyAuth(request.headers)
  return check.status === 'valid' ? check.userId : null
}

/* -------------------------------------------------------------------------- */
/* POST /manage-account                                                        */
/* -------------------------------------------------------------------------- */

export interface AccountActionResponse {
  action: string
  detail: string
  payload?: unknown
}

export async function manageAccountHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const userId = await requireUser(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.writePerMinute, 'account')
  const repos = requireRepos(runtime, request)
  const body = parseJsonBody(request)
  const action = (body as { action?: unknown })?.action

  if (action === 'export') {
    const data = await repos.dataRights.export(userId)
    return json(
      200,
      {
        ok: true,
        data: { action: 'export', detail: 'Account data export (JSON).', payload: data },
        meta: { source: 'cache', generatedAt: new Date().toISOString() },
      },
      { 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="graphmentor-export.json"' },
    )
  }

  if (action === 'reset-progress') {
    const affected = await repos.progress.reset(userId)
    const clearedSkills = await repos.skills.clear(userId)
    return json(200, {
      ok: true,
      data: { action: 'reset-progress', detail: `Reset ${affected} task(s) and cleared ${clearedSkills} skill rating(s).` },
      meta: { source: 'cache', generatedAt: new Date().toISOString() },
    }, { 'cache-control': 'no-store' })
  }

  if (action === 'delete-account-data') {
    const { deleted } = await repos.dataRights.deleteAll(userId)
    return json(200, {
      ok: true,
      data: {
        action: 'delete-account-data',
        detail: `Deleted ${deleted} record(s) across roadmaps, tasks, skill ratings, bookmarks and profile. Your login stays active until you also delete the auth user.`,
      },
      meta: { source: 'cache', generatedAt: new Date().toISOString() },
    }, { 'cache-control': 'no-store' })
  }

  if (action === 'update-profile') {
    const patch = (body as { profile?: unknown }).profile
    if (!patch || typeof patch !== 'object') {
      throw new AppError('validation_failed', { requestId: request.requestId, fields: { profile: 'Missing profile payload.' } })
    }
    const allowed = [
      'education_level',
      'branch',
      'career_goal_id',
      'interests',
      'weekly_hours',
      'preferred_pace',
      'learning_style',
      'goal_note',
      'theme',
      'reduced_motion',
    ] as const
    const clean: Record<string, unknown> = {}
    for (const key of allowed) {
      const value = (patch as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (typeof value === 'string') clean[key] = sanitizeUntrustedText(value, 200)
      else if (typeof value === 'number') clean[key] = Math.min(24 * 60, Math.max(0, value))
      else if (typeof value === 'boolean') clean[key] = value
      else if (Array.isArray(value)) clean[key] = value.slice(0, 20).map((item) => sanitizeUntrustedText(String(item), 64))
    }
    await repos.profiles.upsert(userId, clean)
    return json(200, {
      ok: true,
      data: { action: 'update-profile', detail: 'Profile preferences saved.' },
      meta: { source: 'cache', generatedAt: new Date().toISOString() },
    }, { 'cache-control': 'no-store' })
  }

  throw new AppError('validation_failed', {
    requestId: request.requestId,
    publicMessage: 'Supported actions: export, reset-progress, delete-account-data, update-profile.',
    fields: { action: 'Unknown action.' },
  })
}

/** Re-exported so tests can assert the repository contract shape. */
export type { UserRepositories }


