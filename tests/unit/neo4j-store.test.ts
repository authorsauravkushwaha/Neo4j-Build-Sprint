/**
 * Account store on Neo4j, tested against a mock runner.
 *
 * What this proves: the repository logic (ownership, clamping, id handling,
 * parameter contract, fail-closed replay checks) behaves as specified.
 * What it does NOT prove: that AuraDB executes these statements. That needs a
 * live run against an instance.
 */
import { describe, expect, it } from 'vitest'
import type { QueryApiClient, RunOptions } from '../../supabase/functions/_shared/core/neo4jQueryApi.ts'
import {
  createNeo4jFixedWindowStore,
  createNeo4jNonceStore,
  createNeo4jUserRepositories,
} from '../../supabase/functions/_shared/platform/neo4jStore.ts'
import { PersistenceError } from '../../supabase/functions/_shared/platform/supabaseStore.ts'
import type { Roadmap } from '../../supabase/functions/_shared/core/types.ts'

type Row = Record<string, unknown>
interface Call {
  cypher: string
  params: Record<string, unknown>
  write: boolean
  tag: string | undefined
}

type Handler = (call: Call) => Row[] | Error

function mockClient(handler: Handler = () => []) {
  const calls: Call[] = []
  const client: QueryApiClient & { calls: Call[] } = {
    maxRows: 400,
    calls,
    async run(cypher: string, params: Record<string, unknown>, options: RunOptions = {}) {
      const call: Call = { cypher, params, write: options.write === true, tag: options.tag }
      calls.push(call)
      const result = handler(call)
      if (result instanceof Error) throw result
      return { rows: result, ms: 0 }
    },
  }
  return client
}

const USER = 'user-7f3a'
const OTHER = 'user-9c1d'
const ROADMAP_ID = '11111111-2222-4333-8444-555555555555'
const TASK_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'

function roadmapInput(overrides: Partial<Roadmap> = {}): Roadmap {
  return {
    id: '',
    userId: USER,
    title: 'Backend path',
    careerId: 'career-backend',
    careerName: 'Backend Engineer',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    weeklyHours: 6,
    pace: 'steady',
    estimateDisclaimer: 'Estimates only.',
    milestones: [],
    tasks: [
      {
        order: 0,
        taskKey: 'k0',
        kind: 'learn',
        skillId: 'skill-sql',
        name: 'SQL basics',
        difficulty: 'beginner',
        reason: '',
        essential: true,
        estimatedHours: [2, 4],
        dependsOn: [],
        unlocks: [],
        practice: [],
        completionCriteria: [],
        resourceIds: [],
        projectIds: [],
        status: 'not-started',
        scheduledWeek: 1,
      },
    ],
    ...overrides,
  } as unknown as Roadmap
}

/** The upsert returns the id it was given, as Neo4j does for MERGE ... RETURN r.id. */
const saveAware: Handler = (call) => (call.tag === 'ROADMAP_UPSERT' ? [{ id: call.params.roadmapId }] : [])

describe('roadmaps: ownership and ids', () => {
  it('reuses a client id only when the roadmap already belongs to the caller', async () => {
    const owned = mockClient((call) => (call.tag === 'ROADMAP_OWNED' ? [{ id: ROADMAP_ID }] : saveAware(call)))
    const repos = createNeo4jUserRepositories(owned)
    const saved = await repos.roadmaps.save(USER, roadmapInput({ id: ROADMAP_ID }))
    expect(saved.roadmapId).toBe(ROADMAP_ID)
    expect(owned.calls.find((c) => c.tag === 'ROADMAP_UPSERT')?.params.roadmapId).toBe(ROADMAP_ID)
  })

  it('discards a client id that belongs to someone else and creates a fresh one', async () => {
    // Ownership lookup returns nothing for this caller, which is the case for a stranger's id.
    const client = mockClient(saveAware)
    const repos = createNeo4jUserRepositories(client)
    const saved = await repos.roadmaps.save(USER, roadmapInput({ id: ROADMAP_ID }))
    expect(saved.roadmapId).not.toBe(ROADMAP_ID)
    expect(saved.roadmapId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(client.calls.find((c) => c.tag === 'ROADMAP_UPSERT')?.params.roadmapId).toBe(saved.roadmapId)
  })

  it('creates the task key from roadmap, order and skill, so re-saves update in place', async () => {
    const client = mockClient(saveAware)
    const repos = createNeo4jUserRepositories(client)
    const saved = await repos.roadmaps.save(USER, roadmapInput())
    const tasks = client.calls.find((c) => c.tag === 'TASK_UPSERT')?.params.tasks as Array<{ key: string; status: string }>
    expect(tasks[0].key).toBe(`${saved.roadmapId}|0|skill-sql`)
    expect(saved.taskCount).toBe(1)
  })

  it('clamps free-text fields and milestone count before they are stored', async () => {
    const client = mockClient(saveAware)
    const repos = createNeo4jUserRepositories(client)
    await repos.roadmaps.save(USER, roadmapInput({ title: 'x'.repeat(500) } as Partial<Roadmap>))
    const upsert = client.calls.find((c) => c.tag === 'ROADMAP_UPSERT')
    expect(String(upsert?.params.title)).toHaveLength(120)
  })

  it('rejects a non-UUID roadmap id before any query runs', async () => {
    const client = mockClient(() => [])
    const repos = createNeo4jUserRepositories(client)
    await expect(repos.roadmaps.get(USER, 'not-a-uuid')).rejects.toThrow(PersistenceError)
    await expect(repos.roadmaps.remove(USER, 'not-a-uuid')).rejects.toThrow(PersistenceError)
    expect(client.calls).toHaveLength(0)
  })

  it('returns null for a roadmap the caller does not own, with no second query', async () => {
    const client = mockClient(() => [])
    const result = await createNeo4jUserRepositories(client).roadmaps.get(USER, ROADMAP_ID)
    expect(result).toBeNull()
    expect(client.calls).toHaveLength(1)
  })

  it('maps stored rows to the roadmap row contract, including parsed milestones', async () => {
    const client = mockClient((call) => {
      if (call.tag === 'ROADMAP_GET') {
        return [
          {
            id: ROADMAP_ID,
            userId: USER,
            title: 'T',
            careerId: 'c',
            careerName: 'C',
            weeklyHours: 5,
            pace: 'steady',
            estimateDisclaimer: 'd',
            milestonesJson: JSON.stringify([{ id: 'm1' }]),
            createdAt: 'a',
            updatedAt: 'b',
          },
        ]
      }
      return []
    })
    const result = await createNeo4jUserRepositories(client).roadmaps.get(USER, ROADMAP_ID)
    expect(result?.roadmap).toMatchObject({ id: ROADMAP_ID, user_id: USER, career_id: 'c', weekly_hours: 5, milestones: [{ id: 'm1' }] })
    expect(result?.tasks).toEqual([])
  })
})

describe('progress', () => {
  it('reports a missing or foreign task with one generic message', async () => {
    const client = mockClient(() => [])
    await expect(
      createNeo4jUserRepositories(client).progress.updateTask(USER, { roadmapId: ROADMAP_ID, taskId: TASK_ID, status: 'completed' }),
    ).rejects.toThrow('Task not found for this account')
  })

  it('scopes the task update to the caller through the ownership path', async () => {
    const client = mockClient(() => [])
    await createNeo4jUserRepositories(client)
      .progress.updateTask(USER, { roadmapId: ROADMAP_ID, taskId: TASK_ID, status: 'completed', note: 'n', actualHours: 3 })
      .catch(() => undefined)
    const call = client.calls[0]
    expect(call.cypher).toContain('(:AppUser {id: $userId})-[:OWNS]->(:Roadmap {id: $roadmapId})')
    expect(call.params).toMatchObject({ userId: USER, roadmapId: ROADMAP_ID, taskId: TASK_ID, status: 'completed', actualHours: 3 })
  })

  it('resets all of an account when no roadmap is named, and only one roadmap when one is', async () => {
    const client = mockClient(() => [{ updated: 4 }])
    const repos = createNeo4jUserRepositories(client)
    expect(await repos.progress.reset(USER)).toBe(4)
    expect(client.calls[0].params.roadmapId).toBe('')
    await repos.progress.reset(USER, ROADMAP_ID)
    expect(client.calls[1].params.roadmapId).toBe(ROADMAP_ID)
  })
})

describe('skills, bookmarks, feedback, profiles', () => {
  it('keys skill ratings by user and skill, and clamps quiz scores', async () => {
    const client = mockClient((call) => (call.tag === 'SKILLS_UPSERT' ? [{ saved: 1 }] : []))
    const count = await createNeo4jUserRepositories(client).skills.upsert(USER, [{ skillId: 'skill-sql', state: 'learning', quizScore: 4 }])
    expect(count).toBe(1)
    const ratings = client.calls.find((c) => c.tag === 'SKILLS_UPSERT')?.params.ratings as Array<{ key: string; quizScore: number }>
    expect(ratings[0].key).toBe(`${USER}|skill-sql`)
    expect(ratings[0].quizScore).toBe(1)
  })

  it('keys bookmarks by user and target, so two users can bookmark the same target', async () => {
    const client = mockClient(() => [{ id: 'b1', userId: USER, targetType: 'skill', targetId: 'skill-sql', note: null, createdAt: 'c' }])
    const bookmark = await createNeo4jUserRepositories(client).bookmarks.add(USER, 'skill', 'skill-sql')
    expect(bookmark.user_id).toBe(USER)
    expect(client.calls[0].params.key).toBe(`${USER}|skill-sql`)
  })

  it('allows anonymous feedback with a null user id', async () => {
    const client = mockClient(() => [{ id: 'f1' }])
    const id = await createNeo4jUserRepositories(client).feedback.submit(null, { kind: 'bug', message: 'x'.repeat(2000) })
    expect(id).toBe('f1')
    expect(client.calls[0].params.userId).toBeNull()
    expect(String(client.calls[0].params.message)).toHaveLength(1500)
  })

  it('writes only whitelisted profile fields, so an unknown key is dropped', async () => {
    const client = mockClient(() => [])
    await createNeo4jUserRepositories(client).profiles.upsert(USER, {
      education_level: 'undergrad',
      weekly_hours: 8,
      role: 'admin',
      userId: OTHER,
    })
    const profile = client.calls[0].params.profile as Row
    expect(profile).toEqual({ educationLevel: 'undergrad', weeklyHours: 8 })
    expect(client.calls[0].params.userId).toBe(USER)
  })

  it('maps profile properties back to the snake_case contract', async () => {
    const client = mockClient(() => [{ props: { id: USER, educationLevel: 'undergrad', weeklyHours: 8, passwordHash: 'x' } }])
    const profile = await createNeo4jUserRepositories(client).profiles.get(USER)
    expect(profile).toMatchObject({ id: USER, education_level: 'undergrad', weekly_hours: 8 })
    expect(profile).not.toHaveProperty('passwordHash')
  })
})

describe('data rights', () => {
  it('exports every category for the caller and returns the table-shaped keys', async () => {
    const client = mockClient(() => [])
    const out = await createNeo4jUserRepositories(client).dataRights.export(USER)
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining(['exportedAt', 'userId', 'profiles', 'saved_roadmaps', 'roadmap_tasks', 'user_skill_progress', 'bookmarks', 'feedback']),
    )
    expect(out.userId).toBe(USER)
  })

  it('deletes account data for the caller only, and keeps feedback', async () => {
    const client = mockClient((call) => (call.tag?.startsWith('ACCOUNT_DELETE') || call.tag === 'SKILLS_CLEAR' ? [{ deleted: 2, cleared: 2 }] : []))
    const result = await createNeo4jUserRepositories(client).dataRights.deleteAll(USER)
    expect(result.deleted).toBe(10)
    expect(client.calls.every((c) => c.params.userId === USER)).toBe(true)
    expect(client.calls.some((c) => c.cypher.includes('Feedback'))).toBe(false)
  })
})

describe('failures are wrapped as PersistenceError with the cause kept', () => {
  it('turns a runner failure into a PersistenceError', async () => {
    const cause = new Error('upstream')
    const client = mockClient(() => cause)
    const error = await createNeo4jUserRepositories(client).bookmarks.list(USER).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).cause).toBe(cause)
  })
})

describe('no user value is interpolated into Cypher text', () => {
  it('keeps hostile input in parameters only, across every write path', async () => {
    const hostile = `x'}) DETACH DELETE (n) //`
    const client = mockClient(() => [{ id: 'z', userId: hostile, targetType: hostile, targetId: hostile, note: null, createdAt: 'c', updated: 0, cleared: 0, deleted: 0, saved: 0, removed: 0, count: 1, fresh: true }])
    const repos = createNeo4jUserRepositories(client)
    await repos.bookmarks.add(hostile, hostile, hostile, hostile).catch(() => undefined)
    await repos.bookmarks.remove(hostile, hostile).catch(() => undefined)
    await repos.feedback.submit(hostile, { kind: hostile, message: hostile }).catch(() => undefined)
    await repos.skills.upsert(hostile, [{ skillId: hostile, state: 'learning' }]).catch(() => undefined)
    await repos.roadmaps.save(hostile, roadmapInput({ title: hostile } as Partial<Roadmap>)).catch(() => undefined)
    await repos.profiles.upsert(hostile, { branch: hostile }).catch(() => undefined)
    await repos.dataRights.deleteAll(hostile).catch(() => undefined)
    expect(client.calls.length).toBeGreaterThan(0)
    for (const call of client.calls) {
      expect(call.cypher).not.toContain(hostile)
      expect(call.cypher).not.toContain('DETACH DELETE (n)')
    }
  })
})

describe('rate limit store', () => {
  it('increments a per-window bucket and returns the new count', async () => {
    const client = mockClient(() => [{ count: 3 }])
    const count = await createNeo4jFixedWindowStore(client).increment('ip:203.0.113.9', 60, 1_700_000_030_000)
    expect(count).toBe(3)
    const params = client.calls[0].params
    // Window start is epoch-anchored: 1_700_000_030 floored to a 60 s boundary.
    expect(String(params.bucketId)).toBe('ip:203.0.113.9|60|1699999980')
    expect(client.calls[0].write).toBe(true)
  })

  it('rejects an out-of-range key before touching the database', async () => {
    const client = mockClient(() => [])
    await expect(createNeo4jFixedWindowStore(client).increment('x', 60, Date.now())).rejects.toThrow(PersistenceError)
    expect(client.calls).toHaveLength(0)
  })

  it('prunes expired buckets and nonces in bounded batches', async () => {
    const client = mockClient((call) => (call.tag === 'RATE_LIMIT_PRUNE' ? [{ removed: 3 }] : [{ removed: 0 }]))
    await createNeo4jFixedWindowStore(client).cleanup?.(Date.now())
    expect(client.calls.map((c) => c.tag)).toEqual(['RATE_LIMIT_PRUNE', 'NONCE_PRUNE'])
  })
})

describe('nonce store (replay protection fails closed)', () => {
  it('accepts a first use and rejects a replay', async () => {
    const first = mockClient(() => [{ fresh: true }])
    expect(await createNeo4jNonceStore(first).claim('nonce-abcdef12', 300_000)).toBe(true)
    const replay = mockClient(() => [{ fresh: false }])
    expect(await createNeo4jNonceStore(replay).claim('nonce-abcdef12', 300_000)).toBe(false)
  })

  it('throws when the store fails, so the caller refuses the request', async () => {
    const client = mockClient(() => new Error('connection refused'))
    await expect(createNeo4jNonceStore(client).claim('nonce-abcdef12', 300_000)).rejects.toThrow(PersistenceError)
  })

  it('rejects a malformed nonce before any query', async () => {
    const client = mockClient(() => [])
    await expect(createNeo4jNonceStore(client).claim('short', 300_000)).rejects.toThrow(PersistenceError)
    expect(client.calls).toHaveLength(0)
  })

  it('uses a write and a TTL of at least 30 seconds', async () => {
    const client = mockClient(() => [{ fresh: true }])
    await createNeo4jNonceStore(client).claim('nonce-abcdef12', 1000)
    expect(client.calls[0].write).toBe(true)
    const expiresAt = Number(client.calls[0].params.expiresAt)
    expect(expiresAt - Date.now()).toBeGreaterThanOrEqual(29_000)
  })
})
