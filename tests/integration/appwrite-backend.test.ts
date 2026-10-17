/**
 * Backend conformance: the API, run twice.
 *
 * The question this file answers is the one that matters before a storage
 * migration — not "does Appwrite work", but "is the API *the same API* on
 * Appwrite". So a scenario of real requests is played against two runtimes: the
 * in-memory repositories every other test uses (which mirror the Postgres store,
 * including its ownership rules) and the real repository layer over a real
 * Appwrite client pointed at the fake document API. Both recordings are compared
 * after normalising the two things that are allowed to differ — generated ids and
 * timestamps.
 *
 * Everything else must match exactly: status codes, ownership refusals, error
 * codes, field names, and the progress numbers the client renders. If a field
 * disappears or a refusal becomes a success, this test fails and the migration
 * stops.
 *
 * The second half then checks the properties a comparison cannot express —
 * cross-account isolation at the storage level, and that deleting an account
 * deletes that account's documents and nobody else's.
 */
import { describe, expect, it } from 'vitest'

import {
  createAppwriteAuthVerifier,
  createAppwriteClient,
} from '../../supabase/functions/_shared/platform/appwrite.ts'
import { createUserRepositories } from '../../supabase/functions/_shared/platform/supabaseStore.ts'
import { healthCheckHandler } from '../../supabase/functions/_shared/handlers/health.ts'
import {
  manageAccountHandler,
  manageBookmarksHandler,
  submitFeedbackHandler,
  saveRoadmapHandler,
  getRoadmapsHandler,
  updateProgressHandler,
} from '../../supabase/functions/_shared/handlers/user.ts'
import type { Runtime } from '../../supabase/functions/_shared/runtime.ts'
import { toErrorResponse, type ApiRequest, type HttpResponse } from '../../supabase/functions/_shared/core/http.ts'
import { createRuntimeWithBackend, createTestRuntime, makeRequest } from '../helpers/runtime.ts'
import { createFakeAppwrite } from '../helpers/fakeAppwrite.ts'

const ROADMAP_BODY = {
  title: 'Conformance roadmap',
  careerId: 'career:software-engineer',
  pace: 'steady',
  weeklyHours: 8,
  tasks: [
    {
      taskKey: 'learn-0',
      skillId: 'skill:python-programming',
      name: 'Python programming',
      status: 'not-started',
      difficulty: 'beginner',
      kind: 'learn',
      order: 0,
      scheduledWeek: 1,
      estimatedHoursLow: 10,
      estimatedHoursHigh: 20,
      essential: true,
    },
    {
      taskKey: 'learn-1',
      skillId: 'skill:algorithms',
      name: 'Algorithms',
      status: 'not-started',
      difficulty: 'intermediate',
      kind: 'learn',
      order: 1,
      scheduledWeek: 2,
      estimatedHoursLow: 12,
      estimatedHoursHigh: 25,
      essential: true,
    },
  ],
}

interface Harness {
  runtime: Runtime
  token: (who: 'alice' | 'bob' | 'guest') => string | null
  /** The Appwrite document store, when the harness runs on Appwrite. */
  backend?: ReturnType<typeof createFakeAppwrite>
}

function memoryHarness(): Harness {
  const runtime = createTestRuntime()
  return {
    runtime,
    token: (who) => (who === 'guest' ? null : who),
  }
}

function appwriteHarness(): Harness {
  const backend = createFakeAppwrite()
  const config = { endpoint: 'https://appwrite.example.test/v1', projectId: 'gm', apiKey: 'server-key' }
  const sessions = { alice: backend.openSession('user-alice'), bob: backend.openSession('user-bob') }
  const client = createAppwriteClient(config, backend.transport)
  const runtime = createRuntimeWithBackend({
    repos: createUserRepositories(client),
    verifyAuth: createAppwriteAuthVerifier(config, backend.transport),
    storageBackend: 'appwrite',
  })
  return {
    runtime,
    backend,
    token: (who) => (who === 'guest' ? null : sessions[who]),
  }
}

/** Replaces generated ids and timestamps, which are the only allowed differences. */
function normalise(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return '<uuid>'
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return '<timestamp>'
    // The feedback receipt names the backend that stored the row, on purpose. Which
    // name appears there is checked in "tells the user which backend holds their data".
    if (/^Thanks — feedback is stored in/.test(value)) return '<feedback-note>'
    return value
  }
  if (Array.isArray(value)) {
    // Order between two writes in the same millisecond is not a property of the
    // backend, so arrays are compared as multisets.
    return value.map(normalise).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalise((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Handlers throw `AppError` and let the platform map it to a response, so a test
 * that only awaited the handler would see an exception where production sees a
 * 4xx. Mapping it here is what makes a refusal comparable across backends.
 */
async function respond(
  handler: (runtime: Runtime, request: ApiRequest) => Promise<HttpResponse>,
  runtime: Runtime,
  request: ApiRequest,
): Promise<HttpResponse> {
  try {
    return await handler(runtime, request)
  } catch (error) {
    const mapped = toErrorResponse(error)
    return { status: mapped.status, body: await mapped.json(), headers: {} }
  }
}

interface Recording {
  label: string
  status: number
  body: unknown
}

/** The scenario both backends must agree on, in order, with the responses recorded. */
async function runScenario(harness: Harness): Promise<Recording[]> {
  const { runtime, token } = harness
  const recordings: Recording[] = []
  const call = async (label: string, handler: (runtime: Runtime, request: ApiRequest) => Promise<HttpResponse>, request: ApiRequest) => {
    const response = await respond(handler, runtime, request)
    recordings.push({ label, status: response.status, body: normalise(response.body) })
    return response
  }

  const alice = { token: token('alice') }
  const bob = { token: token('bob') }

  const saved = await call('save-roadmap:alice', saveRoadmapHandler, makeRequest({ path: '/save-roadmap', body: ROADMAP_BODY, ...alice }))
  const roadmapId = (saved.body as { data?: { roadmapId?: string } }).data?.roadmapId ?? ''
  const tasks = await call('get-roadmaps:alice', getRoadmapsHandler, makeRequest({ method: 'GET', path: '/get-roadmaps', ...alice }))
  const taskId = ((tasks.body as { data?: { active?: { tasks?: Array<{ taskKey: string }> } } }).data?.active?.tasks ?? [])[0]?.taskKey ?? ''

  // A valid save with the caller's own task id, so the task actually exists.
  await call('update-progress:alice', updateProgressHandler, makeRequest({ path: '/update-progress', body: { roadmapId, taskId, status: 'completed', actualHours: 6 }, ...alice }))
  await call('update-progress:again', updateProgressHandler, makeRequest({ path: '/update-progress', body: { roadmapId, taskId, status: 'completed', actualHours: 7 }, ...alice }))
  await call('get-roadmaps:after-update', getRoadmapsHandler, makeRequest({ method: 'GET', path: '/get-roadmaps', ...alice }))

  // The interesting one: another account naming somebody else's roadmap and task.
  await call('update-progress:bob-on-alices-task', updateProgressHandler, makeRequest({ path: '/update-progress', body: { roadmapId, taskId, status: 'completed' }, ...bob }))
  await call('get-roadmaps:bob', getRoadmapsHandler, makeRequest({ method: 'GET', path: '/get-roadmaps', ...bob }))
  await call('get-roadmaps:bob-explicit-id', getRoadmapsHandler, makeRequest({ method: 'GET', path: '/get-roadmaps', query: `roadmapId=${roadmapId}`, ...bob }))

  await call('bookmarks:add', manageBookmarksHandler, makeRequest({ path: '/manage-bookmarks', body: { action: 'add', targetType: 'skill', targetId: 'skill:python-programming', note: 'revisit' }, ...alice }))
  await call('bookmarks:add-again', manageBookmarksHandler, makeRequest({ path: '/manage-bookmarks', body: { action: 'add', targetType: 'skill', targetId: 'skill:python-programming' }, ...alice }))
  await call('bookmarks:list', manageBookmarksHandler, makeRequest({ method: 'GET', path: '/manage-bookmarks', ...alice }))
  await call('bookmarks:remove', manageBookmarksHandler, makeRequest({ path: '/manage-bookmarks', body: { action: 'remove', targetId: 'skill:python-programming' }, ...alice }))

  await call('feedback:guest', submitFeedbackHandler, makeRequest({ path: '/submit-feedback', body: { kind: 'bug', message: 'The conformance scenario is anonymous.' }, ...{ token: null } }))
  await call('account:export', manageAccountHandler, makeRequest({ path: '/manage-account', body: { action: 'export' }, ...alice }))
  await call('account:reset-unconfirmed', manageAccountHandler, makeRequest({ path: '/manage-account', body: { action: 'reset-progress' }, ...alice }))
  await call('account:reset', manageAccountHandler, makeRequest({ path: '/manage-account', body: { action: 'reset-progress', confirm: 'RESET' }, ...alice }))
  await call('account:update-profile', manageAccountHandler, makeRequest({ path: '/manage-account', body: { action: 'update-profile', profile: { branch: 'Computer science', weekly_hours: 9, interests: ['graphs', 'mentoring'], theme: 'dark' } }, ...alice }))
  await call('account:delete-unconfirmed', manageAccountHandler, makeRequest({ path: '/manage-account', body: { action: 'delete-account-data' }, ...alice }))
  await call('account:delete', manageAccountHandler, makeRequest({ path: '/manage-account', body: { action: 'delete-account-data', confirm: 'DELETE' }, ...alice }))
  await call('get-roadmaps:alice-after-delete', getRoadmapsHandler, makeRequest({ method: 'GET', path: '/get-roadmaps', ...alice }))
  await call('get-roadmaps:bob-after-alices-delete', getRoadmapsHandler, makeRequest({ method: 'GET', path: '/get-roadmaps', ...bob }))

  return recordings
}

describe('the API on the Appwrite backend', () => {
  it('answers every request exactly as the Postgres-shaped backend does', async () => {
    const recordings = await runScenario(appwriteHarness())
    const reference = await runScenario(memoryHarness())
    expect(recordings.map((recording) => recording.label)).toEqual(reference.map((recording) => recording.label))
    // Compared one request at a time so a failure names the request that diverged.
    for (const [index, recording] of recordings.entries()) {
      expect(recording, `${recording.label} (request ${index + 1})`).toEqual(reference[index])
    }
  })

  it('persists the roadmap in the collections the schema declares, owned by the caller', async () => {
    const harness = appwriteHarness()
    const response = await saveRoadmapHandler(harness.runtime, makeRequest({ path: '/save-roadmap', body: ROADMAP_BODY, token: harness.token('alice') }))
    expect(response.status).toBe(200)

    const roadmaps = harness.backend!.documents('saved_roadmaps')
    expect(roadmaps).toHaveLength(1)
    expect(roadmaps[0]).toMatchObject({ user_id: 'user-alice', career_id: 'career:software-engineer', weekly_hours: 8 })
    // The row id is a uuid on both backends, so a client-held URL keeps working.
    expect(String(roadmaps[0]!.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(String(roadmaps[0]!.$id)).toBe(roadmaps[0]!.id)

    const tasks = harness.backend!.documents('roadmap_tasks')
    expect(tasks).toHaveLength(2)
    // The owner is on every child row too: nothing relies on joining through the
    // parent to know who a row belongs to.
    expect(tasks.every((task) => task.user_id === 'user-alice')).toBe(true)
    expect(tasks.every((task) => task.roadmap_id === roadmaps[0]!.id)).toBe(true)
  })

  it('serialises and restores the fields Appwrite has no type for', async () => {
    const harness = appwriteHarness()
    const alice = { token: harness.token('alice') }
    await saveRoadmapHandler(harness.runtime, makeRequest({ path: '/save-roadmap', body: ROADMAP_BODY, ...alice }))
    const listed = await getRoadmapsHandler(harness.runtime, makeRequest({ method: 'GET', path: '/get-roadmaps', ...alice }))
    const active = (listed.body as { data: { active: { milestones: unknown; tasks: unknown[] } } }).data.active
    // `milestones` is a jsonb array in Postgres and JSON text here; the API must
    // not be able to tell the difference.
    expect(Array.isArray(active.milestones)).toBe(true)
    expect(active.tasks).toHaveLength(2)
  })

  it('leaves another account nothing to read, and no way to write', async () => {
    const harness = appwriteHarness()
    const alice = { token: harness.token('alice') }
    const bob = { token: harness.token('bob') }
    const saved = await saveRoadmapHandler(harness.runtime, makeRequest({ path: '/save-roadmap', body: ROADMAP_BODY, ...alice }))
    const roadmapId = (saved.body as { data: { roadmapId: string } }).data.roadmapId

    const strangerRead = await getRoadmapsHandler(harness.runtime, makeRequest({ method: 'GET', path: '/get-roadmaps', query: `roadmapId=${roadmapId}`, ...bob }))
    expect(strangerRead.status).toBe(200)
    // An empty list, not a refusal: the response must not reveal that the id exists.
    expect((strangerRead.body as { data: { roadmaps: unknown[]; active: unknown } }).data).toMatchObject({ roadmaps: [], active: null })

    const taskId = String(harness.backend!.documents('roadmap_tasks')[0]!.$id)
    const strangerWrite = await respond(updateProgressHandler, harness.runtime, makeRequest({ path: '/update-progress', body: { roadmapId, taskId, status: 'completed' }, ...bob }))
    // 404, not 403: refusing with "forbidden" would confirm that the id exists.
    expect(strangerWrite.status).toBe(404)
    expect((strangerWrite.body as { error: { code: string } }).error.code).toBe('not_found')
    // The row is untouched, which is the part a status code cannot promise.
    expect(harness.backend!.documents('roadmap_tasks').every((task) => task.status === 'not-started')).toBe(true)
    // And no row was created for Bob in the process.
    expect(harness.backend!.documents('roadmap_tasks').every((task) => task.user_id === 'user-alice')).toBe(true)
  })

  it('deletes one account without touching another', async () => {
    const harness = appwriteHarness()
    const alice = { token: harness.token('alice') }
    const bob = { token: harness.token('bob') }
    await saveRoadmapHandler(harness.runtime, makeRequest({ path: '/save-roadmap', body: ROADMAP_BODY, ...alice }))
    await saveRoadmapHandler(harness.runtime, makeRequest({ path: '/save-roadmap', body: { ...ROADMAP_BODY, title: 'Bob roadmap' }, ...bob }))
    await manageBookmarksHandler(harness.runtime, makeRequest({ path: '/manage-bookmarks', body: { action: 'add', targetType: 'career', targetId: 'career:software-engineer' }, ...alice }))

    const deleted = await manageAccountHandler(harness.runtime, makeRequest({ path: '/manage-account', body: { action: 'delete-account-data', confirm: 'DELETE' }, ...alice }))
    expect(deleted.status).toBe(200)

    expect(harness.backend!.documents('saved_roadmaps').map((row) => row.user_id)).toEqual(['user-bob'])
    expect(harness.backend!.documents('roadmap_tasks').every((row) => row.user_id === 'user-bob')).toBe(true)
    expect(harness.backend!.documents('bookmarks')).toHaveLength(0)

    const bobStillWorks = await getRoadmapsHandler(harness.runtime, makeRequest({ method: 'GET', path: '/get-roadmaps', ...bob }))
    expect((bobStillWorks.body as { data: { roadmaps: unknown[] } }).data.roadmaps).toHaveLength(1)
  })

  it('keeps a guest feedback row anonymous rather than inventing an owner', async () => {
    const harness = appwriteHarness()
    const response = await submitFeedbackHandler(harness.runtime, makeRequest({ path: '/submit-feedback', body: { kind: 'content', message: 'The prerequisite list is missing a step.' } }))
    // 202: accepted and stored, not "here is the thing you created".
    expect(response.status).toBe(202)
    const feedback = harness.backend!.documents('feedback')
    expect(feedback).toHaveLength(1)
    expect(feedback[0]!.user_id ?? null).toBeNull()
  })

  it('tells the user which backend holds their data, instead of saying Supabase by habit', async () => {
    const harness = appwriteHarness()
    const health = await healthCheckHandler(harness.runtime, makeRequest({ path: '/health-check' }))
    const payload = (health.body as { data: { storage: { configured: boolean; backend?: string; note: string } } }).data.storage
    expect(payload.configured).toBe(true)
    expect(payload.backend).toBe('appwrite')
    expect(payload.note).toMatch(/Appwrite/)
    expect(payload.note).not.toMatch(/Supabase/)

    const guest = await healthCheckHandler(createTestRuntime({ withRepos: false }), makeRequest({ path: '/health-check' }))
    const guestStorage = (guest.body as { data: { storage: { configured: boolean; backend?: string; note: string } } }).data.storage
    // Guest mode must not imply a hosted database at all.
    expect(guestStorage.configured).toBe(false)
    expect(guestStorage.backend).toBeUndefined()
    expect(guestStorage.note).toMatch(/guest mode/)

    const hosted = await healthCheckHandler(createTestRuntime(), makeRequest({ path: '/health-check' }))
    expect((hosted.body as { data: { storage: { backend?: string } } }).data.storage.backend).toBe('neo4j')
  })

  it('rate-limits through the same provider interface, on document counters', async () => {
    const harness = appwriteHarness()
    const alice = { token: harness.token('alice') }
    // The memory store is not the only implementation of `FixedWindowStore`: the
    // Appwrite client's `rpc` satisfies the same interface, so a deployment gets
    // global counters without Postgres.
    const client = createAppwriteClient({ endpoint: 'https://appwrite.example.test/v1', projectId: 'gm', apiKey: 'server-key' }, harness.backend!.transport)
    const first = await client.rpc<number>('gm_consume_rate_limit', { p_key: 'user-alice:write', p_window_seconds: 60, p_limit: 3 })
    const second = await client.rpc<number>('gm_consume_rate_limit', { p_key: 'user-alice:write', p_window_seconds: 60, p_limit: 3 })
    const other = await client.rpc<number>('gm_consume_rate_limit', { p_key: 'user-bob:write', p_window_seconds: 60, p_limit: 3 })
    expect([first.data, second.data, other.data]).toEqual([1, 2, 1])

    // And a normal request still succeeds while the store is in use.
    const saved = await saveRoadmapHandler(harness.runtime, makeRequest({ path: '/save-roadmap', body: ROADMAP_BODY, ...alice }))
    expect(saved.status).toBe(200)
  })
})
