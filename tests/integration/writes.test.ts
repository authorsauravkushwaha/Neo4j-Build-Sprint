/**
 * Write surface, exercised through the real client.
 *
 * Two things are being pinned here:
 *  1. the four write endpoints behave the same way through one client interface
 *     in both modes (demo writes land in the same local storage the app reads),
 *  2. demo mode never pretends a report or a plan was sent anywhere: every
 *     result says the data stayed on this device.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDemoClient, createLiveClient } from '@/core/api.ts'
import { loadBookmarks, loadFeedbackOutbox, loadLocalRoadmaps, loadProgress } from '@/core/persistence.ts'

const client = createDemoClient()

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

const roadmapInput = {
  careerId: 'career:software-engineer',
  title: 'Spring plan',
  weeklyHours: 8,
  pace: 'steady' as const,
  tasks: [
    {
      skillId: 'skill:python-programming',
      name: 'Python programming',
      order: 0,
      scheduledWeek: 1,
      estimatedHoursLow: 6,
      estimatedHoursHigh: 10,
      taskKey: 'learn-0',
      kind: 'learn' as const,
    },
    {
      skillId: 'skill:python-programming',
      name: 'Review: Python programming',
      order: 0.5,
      scheduledWeek: 2,
      estimatedHoursLow: 1,
      estimatedHoursHigh: 2,
      taskKey: 'review-0.5',
      kind: 'review' as const,
    },
  ],
}

describe('save-roadmap', () => {
  it('stores the plan locally and returns a mapping the UI can address rows with', async () => {
    const result = await client.saveRoadmap(roadmapInput)
    expect(result.data.roadmapId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.data.taskCount).toBe(2)
    expect(result.data.taskIds).toEqual({ 'learn-0': 'learn-0', 'review-0.5': 'review-0.5' })

    const stored = loadLocalRoadmaps()
    expect(stored).toHaveLength(1)
    expect(stored[0].title).toBe('Spring plan')
    expect(stored[0].storedOn).toBe('device')
    // Review rows are labelled, not silently merged with their learn row.
    expect(stored[0].tasks.map((task) => task.kind)).toEqual(['learn', 'review'])
  })

  it('derives a task key and kind when the caller omits them', async () => {
    const result = await client.saveRoadmap({
      ...roadmapInput,
      tasks: [
        {
          skillId: 'skill:statistics',
          name: 'Review: Probability and statistics',
          order: 2,
          scheduledWeek: 3,
          estimatedHoursLow: 1,
          estimatedHoursHigh: 2,
        },
      ],
    })
    expect(result.data.taskIds).toHaveProperty('review-2')
    expect(loadLocalRoadmaps()[0].tasks[0].kind).toBe('review')
  })

  it('replaces the previous record for the same roadmap instead of duplicating it', async () => {
    const first = await client.saveRoadmap(roadmapInput)
    await client.saveRoadmap({ ...roadmapInput, roadmapId: first.data.roadmapId, title: 'Renamed' })
    const stored = loadLocalRoadmaps()
    expect(stored).toHaveLength(1)
    expect(stored[0].title).toBe('Renamed')
  })

  it('keeps the saved list bounded', async () => {
    for (let index = 0; index < 25; index += 1) {
      await client.saveRoadmap({ ...roadmapInput, title: `Plan ${index}` })
    }
    expect(loadLocalRoadmaps().length).toBeLessThanOrEqual(20)
  })
})

describe('update-progress', () => {
  it('writes the status under the row key and recomputes the summary itself', async () => {
    const saved = await client.saveRoadmap(roadmapInput)
    const result = await client.updateProgress({
      roadmapId: saved.data.roadmapId,
      taskId: 'learn-0',
      taskKey: 'learn-0',
      skillId: 'skill:python-programming',
      status: 'completed',
      actualHours: 7,
    })

    expect(result.data.status).toBe('completed')
    // One of two rows is done: the count comes from storage, not from the caller.
    expect(result.data.progress).toEqual({ totalTasks: 1, completed: 1, percentComplete: 100 })

    const stored = loadProgress()[saved.data.roadmapId].tasks['learn-0']
    expect(stored.status).toBe('completed')
    expect(stored.skillId).toBe('skill:python-programming')
    expect(stored.actualHours).toBe(7)
  })

  it('refuses a status that is not in the vocabulary', async () => {
    const saved = await client.saveRoadmap(roadmapInput)
    await client.updateProgress({
      roadmapId: saved.data.roadmapId,
      taskId: 'learn-0',
      status: 'mastered' as never,
    })
    expect(loadProgress()[saved.data.roadmapId]?.tasks['learn-0']).toBeUndefined()
  })

  it('clears one roadmap without touching another', async () => {
    const first = await client.saveRoadmap(roadmapInput)
    const second = await client.saveRoadmap({ ...roadmapInput, title: 'Other plan' })
    await client.updateProgress({ roadmapId: first.data.roadmapId, taskId: 'learn-0', status: 'completed' })
    await client.updateProgress({ roadmapId: second.data.roadmapId, taskId: 'learn-0', status: 'completed' })

    const reset = await client.resetProgress({ roadmapId: first.data.roadmapId, confirm: 'RESET' })
    expect(reset.data.resetTasks).toBe(1)
    expect(loadProgress()[first.data.roadmapId]).toBeUndefined()
    expect(loadProgress()[second.data.roadmapId].tasks['learn-0'].status).toBe('completed')
  })
})

describe('manage-bookmarks', () => {
  it('adds, lists and removes, and mirrors what the plain local store holds', async () => {
    const added = await client.manageBookmarks({ action: 'add', targetType: 'skill', targetId: 'skill:python-programming' })
    expect(added.data.changed).toEqual({ action: 'add', targetId: 'skill:python-programming' })
    expect(added.data.bookmarks).toHaveLength(1)
    expect(loadBookmarks()).toHaveLength(1)

    const listed = await client.manageBookmarks({ action: 'list' })
    expect(listed.data.bookmarks[0].targetId).toBe('skill:python-programming')
    expect(listed.data.changed).toBeUndefined()

    const removed = await client.manageBookmarks({ action: 'remove', targetType: 'skill', targetId: 'skill:python-programming' })
    expect(removed.data.bookmarks).toHaveLength(0)
    expect(loadBookmarks()).toHaveLength(0)
  })

  it('accepts every target type the database allows, including modules', async () => {
    for (const targetType of ['skill', 'career', 'project', 'resource', 'module'] as const) {
      const result = await client.manageBookmarks({ action: 'add', targetType, targetId: `skill:${targetType}-example`.replace(/^skill:career/, 'career:career') })
      expect(result.data.bookmarks.length).toBeGreaterThan(0)
    }
    expect(loadBookmarks().length).toBe(5)
  })

  it('rejects an add without a target', async () => {
    await expect(client.manageBookmarks({ action: 'add', targetType: 'skill' })).rejects.toThrow(/target/i)
  })

  it('caps the stored list', async () => {
    for (let index = 0; index < 250; index += 1) {
      await client.manageBookmarks({ action: 'add', targetType: 'skill', targetId: `skill:example-${index}` })
    }
    expect(loadBookmarks().length).toBeLessThanOrEqual(200)
  })
})

describe('submit-feedback', () => {
  it('keeps the report on the device and says so', async () => {
    const result = await client.submitFeedback({ kind: 'resource-link', message: 'The Kubernetes tutorial link 404s.' })
    expect(result.data.id).toBeTruthy()
    expect(result.data.note).toMatch(/device only|on this device/i)
    expect(loadFeedbackOutbox()).toHaveLength(1)
    expect(loadFeedbackOutbox()[0].message).toBe('The Kubernetes tutorial link 404s.')
  })

  it('caps an oversized report instead of storing the whole thing', async () => {
    await client.submitFeedback({ kind: 'bug', message: 'x'.repeat(9000) })
    expect(loadFeedbackOutbox()[0].message.length).toBeLessThanOrEqual(1500)
  })

  it('keeps the outbox bounded', async () => {
    for (let index = 0; index < 60; index += 1) {
      await client.submitFeedback({ kind: 'other', message: `Report ${index}` })
    }
    expect(loadFeedbackOutbox().length).toBeLessThanOrEqual(50)
  })
})

describe('live client write contract', () => {
  it('sends the exact field names the server schemas accept, and never sends a session it does not have', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = []
    const fetchImpl = vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
      calls.push({
        url: new URL(url).pathname,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body) : undefined,
        headers: init.headers ?? {},
      })
      // save-roadmap then the read-back of the stored rows.
      const payload =
        calls.length === 1
          ? { ok: true, data: { roadmapId: '11111111-1111-4111-8111-111111111111', taskCount: 1, updatedAt: '2026-01-01T00:00:00.000Z' } }
          : {
              ok: true,
              data: {
                roadmaps: [
                  {
                    roadmap: {
                      id: '11111111-1111-4111-8111-111111111111',
                      tasks: [{ taskKey: '22222222-2222-4222-8222-222222222222', order: 0, kind: 'learn' }],
                    },
                  },
                ],
              },
            }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const live = createLiveClient({
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      getToken: async () => 'token-abc',
      fetchImpl: fetchImpl as never,
    })

    const saved = await live.saveRoadmap(roadmapInput)
    expect(calls[0].url).toBe('/functions/v1/save-roadmap')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toMatchObject({
      title: 'Spring plan',
      careerId: 'career:software-engineer',
      weeklyHours: 8,
      pace: 'steady',
    })
    expect((calls[0].body as { tasks: unknown[] }).tasks).toHaveLength(2)
    // The bearer token is attached, so the handler can authorize the caller.
    expect(calls[0].headers.authorization).toBe('Bearer token-abc')

    // The row ids come back from the server and replace the local keys, so a
    // later progress write addresses a real row.
    expect(saved.data.taskIds).toEqual({ '22222222-2222-4222-8222-222222222222': '22222222-2222-4222-8222-222222222222' })
    expect(calls[1].method).toBe('GET')
  })

  it('refuses to write without a token instead of silently degrading', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Sign in to do that.' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const live = createLiveClient({
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      getToken: async () => null,
      fetchImpl: fetchImpl as never,
    })

    await expect(live.manageBookmarks({ action: 'list' })).rejects.toThrow(/sign in/i)
  })

  it('reports a network failure as a network failure, not as an empty result', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const live = createLiveClient({
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      getToken: async () => 'token-abc',
      fetchImpl: fetchImpl as never,
    })
    await expect(live.submitFeedback({ kind: 'bug', message: 'Something is broken here.' })).rejects.toThrow(/could not reach/i)
  })
})


