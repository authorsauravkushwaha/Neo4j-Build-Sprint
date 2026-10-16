/**
 * The sync payload contract (`validateSyncPayload` in `server/server.ts`).
 *
 * The server is the boundary: whatever a client sends, only well-formed
 * bookmarks, ratings and profile fields may reach the database, with the
 * same enums and length ceilings the database enforces — failing here means
 * a 400 with a sentence instead of a constraint error. These tests pin the
 * accept/reject edges, including the multi-shape cases a hand-crafted
 * request would try.
 */
import { describe, expect, it } from 'vitest'

import { validateSyncPayload } from '../../server/server.ts'

const good = {
  bookmarks: [{ targetType: 'skill', targetId: 'skill:pid', note: 'later', createdAt: '2026-10-15T00:00:00.000Z' }],
  ratings: [{ skillId: 'skill:pid', state: 'learning', quizScore: 0.5 }],
  profile: { careerGoalId: 'career:x', weeklyHours: 6, preferredPace: 'steady', interests: ['robotics'] },
}

describe('validateSyncPayload', () => {
  it('accepts a well-formed payload and fills the profile defaults', () => {
    const result = validateSyncPayload(good)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.bookmarks).toHaveLength(1)
      expect(result.value.ratings[0]?.quizScore).toBe(0.5)
      expect(result.value.profile?.weeklyHours).toBe(6)
      expect(result.value.profile?.theme).toBeNull()
    }
  })

  it('rejects unknown enums instead of letting the database find them', () => {
    expect(validateSyncPayload({ ...good, ratings: [{ skillId: 'skill:x', state: 'wizard' }] }).ok).toBe(false)
    expect(validateSyncPayload({ ...good, bookmarks: [{ targetType: 'gadget', targetId: 'x' }] }).ok).toBe(false)
    const badPace = validateSyncPayload({ ...good, profile: { preferredPace: 'frantic' } })
    expect(badPace.ok).toBe(true)
    if (badPace.ok) expect(badPace.value.profile?.preferredPace).toBeNull()
  })

  it('drops an out-of-range quiz score rather than failing the whole sync', () => {
    const result = validateSyncPayload({ ...good, ratings: [{ skillId: 'skill:x', state: 'new', quizScore: 7 }] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.ratings[0]?.quizScore).toBeUndefined()
  })

  it('rejects oversized payloads and overlong ids', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ targetType: 'skill', targetId: `skill:${i}` }))
    expect(validateSyncPayload({ ...good, bookmarks: many }).ok).toBe(false)
    expect(validateSyncPayload({ ...good, bookmarks: [{ targetType: 'skill', targetId: 'x'.repeat(73) }] }).ok).toBe(false)
  })

  it('rejects a payload missing its lists, and tolerates a null profile', () => {
    expect(validateSyncPayload({ ratings: [] }).ok).toBe(false)
    const result = validateSyncPayload({ bookmarks: [], ratings: [], profile: null })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.profile).toBeNull()
  })
})

describe('validateSyncPayload — roadmap task progress', () => {
  it('accepts nested progress and keeps hours and notes', () => {
    const result = validateSyncPayload({
      bookmarks: [], ratings: [], profile: null,
      progress: { 'career:x': { tasks: { 'skill:python': { skillId: 'skill:python', status: 'completed', actualHours: 3.5, notes: 'done', updatedAt: '2026-01-01T00:00:00.000Z' } }, updatedAt: '2026-01-01T00:00:00.000Z' } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.progress['career:x']?.tasks['skill:python']?.actualHours).toBe(3.5)
  })
  it('defaults to empty progress when the field is absent (older clients)', () => {
    const result = validateSyncPayload({ bookmarks: [], ratings: [], profile: null })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.progress).toEqual({})
  })
  it('rejects an unknown task status', () => {
    const result = validateSyncPayload({
      bookmarks: [], ratings: [], profile: null,
      progress: { r: { tasks: { t: { skillId: 'skill:a', status: 'half-done' } }, updatedAt: 'x' } },
    })
    expect(result.ok).toBe(false)
  })
})


