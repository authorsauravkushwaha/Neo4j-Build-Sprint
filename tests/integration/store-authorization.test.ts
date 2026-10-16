/**
 * Authentication is not authorisation — proved at the data layer.
 *
 * A verified token says *who* is calling. It says nothing about *which rows* the
 * caller may touch. These tests inspect the queries the store actually builds, so
 * every answer to "can user A reach user B's row?" comes from the query that would
 * have been sent, not from the intention behind it:
 *
 *   - every write carries the server-verified `userId` as a filter,
 *   - a row id supplied by a client is proven to belong to the caller *before* it
 *     can be used as a write target,
 *   - a foreign id and a nonexistent id are indistinguishable in the response.
 *
 * The database enforces the same rule independently through Row Level Security
 * (see `npm run verify:rls`); this is the other half of that defence in depth.
 */
import { describe, expect, it } from 'vitest'

import {
  createAuthVerifier,
  createUserRepositories,
  PersistenceError,
  type RoadmapRow,
} from '../../supabase/functions/_shared/platform/supabaseStore.ts'
import { createFakePostgrest } from '../helpers/fakePostgrest.ts'
import type { Roadmap } from '@core/types.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const BOBS_ROADMAP = '33333333-3333-4333-8333-333333333333'

/** The filter values a recorded query applied to a given column. */
const filterValues = (query: { filters: Array<{ column: string; value: unknown }> }, column: string) =>
  query.filters.filter((filter) => filter.column === column).map((filter) => filter.value)

function roadmapInput(id = ''): Roadmap {
  return {
    id,
    title: 'Controls engineer',
    careerId: 'career:controls-engineer',
    careerName: 'Controls engineer',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    weeklyHours: 8,
    pace: 'steady',
    estimateDisclaimer: 'Estimates, not promises.',
    milestones: [],
    tasks: [],
  }
}

describe('a saved roadmap cannot be aimed at another account', () => {
  it('proves ownership of a client-supplied id before the write, not after', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    // 1: the ownership lookup finds nothing (this id is not Alice's). 2: the insert.
    fake.push({ data: null })
    fake.push({ data: { id: '44444444-4444-4444-8444-444444444444' } })

    const result = await repos.roadmaps.save(ALICE, roadmapInput(BOBS_ROADMAP))

    const lookup = fake.forTable('saved_roadmaps', 'select')[0]
    expect(lookup, 'an ownership lookup must happen first').toBeTruthy()
    expect(filterValues(lookup, 'id')).toEqual([BOBS_ROADMAP])
    expect(filterValues(lookup, 'user_id')).toEqual([ALICE])

    const write = fake.forTable('saved_roadmaps', 'upsert')[0]
    const payload = write.values as Record<string, unknown>
    expect(payload.user_id).toBe(ALICE)
    // The foreign id is gone: this became a create, not a write to Bob's row.
    expect(payload).not.toHaveProperty('id')
    expect(write.onConflict).toBe('id')
    // A fresh row id came back from the server.
    expect(result.roadmapId).toBe('44444444-4444-4444-8444-444444444444')
  })

  it('keeps the id when the row really is the caller’s, so re-saving still converges', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.push({ data: { id: BOBS_ROADMAP } }) // ownership lookup: found for this user
    fake.push({ data: { id: BOBS_ROADMAP } })

    await repos.roadmaps.save(ALICE, roadmapInput(BOBS_ROADMAP))

    const write = fake.forTable('saved_roadmaps', 'upsert')[0]
    const payload = write.values as Record<string, unknown>
    expect(payload.id).toBe(BOBS_ROADMAP)
    expect(payload.user_id).toBe(ALICE)
  })

  it('does not even look up an id that is not a UUID', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.push({ data: { id: '55555555-5555-4555-8555-555555555555' } })

    await repos.roadmaps.save(ALICE, roadmapInput("1' or '1'='1"))

    expect(fake.forTable('saved_roadmaps', 'select')).toEqual([])
    const payload = fake.forTable('saved_roadmaps', 'upsert')[0].values as Record<string, unknown>
    expect(payload).not.toHaveProperty('id')
    expect(payload.user_id).toBe(ALICE)
  })

  it('fails closed when the ownership lookup itself errors (no accidental duplicate)', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.push({ data: null, error: { message: 'connection reset', code: '08006' } })

    await expect(repos.roadmaps.save(ALICE, roadmapInput(BOBS_ROADMAP))).rejects.toThrow(PersistenceError)
    // Crucially: no write was attempted on the strength of an unanswered question.
    expect(fake.forTable('saved_roadmaps', 'upsert')).toEqual([])
  })

  it('writes task rows against the caller’s id, so a task can never attach to a stranger’s roadmap', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.push({ data: { id: '66666666-6666-4666-8666-666666666666' } }) // the upsert of the roadmap
    fake.push({ data: null }) // the task upsert

    const roadmap = roadmapInput()
    roadmap.tasks = [
      {
        order: 0,
        taskKey: 'task-1',
        kind: 'learn',
        skillId: 'skill:pid-control',
        name: 'PID control',
        difficulty: 'beginner',
        reason: '',
        essential: true,
        estimatedHours: [4, 6],
        dependsOn: [],
        unlocks: [],
        practice: [],
        completionCriteria: [],
        resourceIds: [],
        projectIds: [],
        status: 'not-started',
        scheduledWeek: 1,
      },
    ]
    await repos.roadmaps.save(ALICE, roadmap)

    const taskWrite = fake.forTable('roadmap_tasks', 'upsert')[0]
    const rows = taskWrite.values as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(ALICE)
    expect(rows[0].roadmap_id).toBe('66666666-6666-4666-8666-666666666666')
  })
})

describe('every write and read is filtered by the verified caller id', () => {
  it('delete-roadmap filters on user_id as well as the roadmap id', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.push({ data: null })

    await repos.roadmaps.remove(ALICE, BOBS_ROADMAP)

    const query = fake.forTable('saved_roadmaps', 'delete')[0]
    expect(filterValues(query, 'user_id')).toEqual([ALICE])
    expect(filterValues(query, 'id')).toEqual([BOBS_ROADMAP])
  })

  it('updating a task requires the task id, the roadmap id and the owner', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.push({ data: null }) // not this user's row

    await expect(
      repos.progress.updateTask(ALICE, { roadmapId: BOBS_ROADMAP, taskId: '77777777-7777-4777-8777-777777777777', status: 'completed' }),
    ).rejects.toThrow(PersistenceError)

    const query = fake.forTable('roadmap_tasks', 'update')[0]
    expect(filterValues(query, 'user_id')).toEqual([ALICE])
    expect(filterValues(query, 'id')).toEqual(['77777777-7777-4777-8777-777777777777'])
    expect(filterValues(query, 'roadmap_id')).toEqual([BOBS_ROADMAP])
  })

  it('a foreign row and a missing row produce the same error, so ids cannot be probed', async () => {
    const reposWithNothing = createFakePostgrest()
    const missing = createUserRepositories(reposWithNothing.client)
    reposWithNothing.push({ data: null })

    const reposWithForeignRow = createFakePostgrest()
    const foreign = createUserRepositories(reposWithForeignRow.client)
    // Identical to the case above: RLS means the row simply is not visible.
    reposWithForeignRow.push({ data: null })

    const input = {
      roadmapId: BOBS_ROADMAP,
      taskId: '88888888-8888-4888-8888-888888888888',
      status: 'completed' as const,
    }
    const missingError = await missing.progress.updateTask(ALICE, input).catch((error: Error) => error.message)
    const foreignError = await foreign.progress.updateTask(ALICE, input).catch((error: Error) => error.message)
    expect(missingError).toBe(foreignError)
    expect(missingError).toMatch(/not found for this account/i)
  })

  it('deleting an account touches each table under the caller’s own id', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.pushEmpty(5)

    await repos.dataRights.deleteAll(ALICE)

    const deletes = fake.queries.filter((query) => query.operation === 'delete')
    expect(deletes.map((query) => query.table)).toEqual([
      'roadmap_tasks',
      'saved_roadmaps',
      'user_skill_progress',
      'bookmarks',
      'profiles',
    ])
    for (const query of deletes) {
      // `profiles` is keyed by id; everything else by user_id.
      const column = query.table === 'profiles' ? 'id' : 'user_id'
      expect(filterValues(query, column), `${query.table} must be scoped`).toEqual([ALICE])
    }
  })

  it('export reads only the caller’s rows', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.pushEmpty(6)

    const exported = await repos.dataRights.export(BOB)

    expect(exported.userId).toBe(BOB)
    const selects = fake.queries.filter((query) => query.operation === 'select')
    for (const query of selects) {
      const column = query.table === 'profiles' ? 'id' : 'user_id'
      expect(filterValues(query, column), `${query.table} must be scoped`).toEqual([BOB])
    }
  })

  it('bookmarks are per account: adding always stamps the caller and removing filters by owner', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    fake.push({
      data: {
        id: '99999999-9999-4999-8999-999999999999',
        user_id: ALICE,
        target_type: 'skill',
        target_id: 'skill:pid-control',
        note: null,
        created_at: new Date().toISOString(),
      },
    })
    fake.push({ data: null })

    await repos.bookmarks.add(ALICE, 'skill', 'skill:pid-control')
    await repos.bookmarks.remove(ALICE, 'skill:pid-control')

    const add = fake.forTable('bookmarks', 'upsert')[0]
    expect((add.values as Record<string, unknown>).user_id).toBe(ALICE)
    expect(add.onConflict).toBe('user_id,target_id')
    const remove = fake.forTable('bookmarks', 'delete')[0]
    expect(filterValues(remove, 'user_id')).toEqual([ALICE])
  })
})

describe('the auth verifier decides identity from the Auth server, never from the token’s own claims', () => {
  /*
   * A JWT is trivially forgeable if you only read its `sub` claim. This verifier
   * asks the Auth server for the user, so a self-signed token with a plausible
   * body gets nowhere. Each rejection path is pinned here.
   */
  const headersWith = (authorization?: string) => new Headers(authorization ? { authorization } : {})

  it('accepts a token the Auth server accepts, and uses its id', async () => {
    const fake = createFakePostgrest()
    fake.pushAuth({ user: { id: ALICE, email: 'alice@example.com' } })
    const verify = createAuthVerifier(fake.client)

    await expect(verify(headersWith(`Bearer ${'a'.repeat(24)}.${'b'.repeat(8)}.${'c'.repeat(8)}`))).resolves.toEqual({
      status: 'valid',
      userId: ALICE,
    })
  })

  it('treats a missing header as anonymous, not as invalid', async () => {
    const fake = createFakePostgrest()
    const verify = createAuthVerifier(fake.client)
    await expect(verify(headersWith())).resolves.toEqual({ status: 'none' })
  })

  it('rejects a token the Auth server refuses', async () => {
    const fake = createFakePostgrest()
    fake.pushAuth({ user: null, error: { message: 'invalid JWT' } })
    const verify = createAuthVerifier(fake.client)

    const result = await verify(headersWith(`Bearer ${'a'.repeat(24)}.${'b'.repeat(8)}.${'c'.repeat(8)}`))
    expect(result).toEqual({ status: 'invalid', reason: 'token-rejected' })
  })

  it('rejects a header that is not a bearer token, and one that is not a JWT', async () => {
    const fake = createFakePostgrest()
    const verify = createAuthVerifier(fake.client)

    await expect(verify(headersWith('Basic Zm9vOmJhcg=='))).resolves.toEqual({
      status: 'invalid',
      reason: 'malformed-authorization-header',
    })
    await expect(verify(headersWith('Bearer not-a-jwt-at-all'))).resolves.toEqual({
      status: 'invalid',
      reason: 'not-a-jwt',
    })
    // Neither case should have spent a call to the Auth server.
    expect(fake.queries).toEqual([])
  })

  it('fails closed when the Auth server cannot be reached', async () => {
    const fake = createFakePostgrest()
    fake.pushAuth({ user: { id: ALICE } })
    const verify = createAuthVerifier({
      ...fake.client,
      auth: {
        getUser: async () => {
          throw new Error('network down')
        },
      },
    } as typeof fake.client)

    await expect(verify(headersWith(`Bearer ${'a'.repeat(24)}.${'b'.repeat(8)}.${'c'.repeat(8)}`))).resolves.toEqual({
      status: 'invalid',
      reason: 'auth-unreachable',
    })
  })
})

describe('the row shapes the store hands back keep the owner attached', () => {
  it('a listed roadmap row still carries its user_id, so nothing downstream can lose track of ownership', async () => {
    const fake = createFakePostgrest()
    const repos = createUserRepositories(fake.client)
    const row: RoadmapRow = {
      id: BOBS_ROADMAP,
      user_id: BOB,
      title: 'Bob’s plan',
      career_id: 'career:controls-engineer',
      career_name: 'Controls engineer',
      weekly_hours: 8,
      pace: 'steady',
      milestones: [],
      estimate_disclaimer: 'Estimates, not promises.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    fake.push({ data: [row] }) // list
    fake.push({ data: [] }) // tasks for that roadmap

    const listed = await repos.roadmaps.list(BOB)

    expect(listed).toHaveLength(1)
    expect(listed[0].roadmap.user_id).toBe(BOB)
    // And the listing query itself never asked for another account's rows.
    const list = fake.forTable('saved_roadmaps', 'select')[0]
    expect(filterValues(list, 'user_id')).toEqual([BOB])
  })
})


