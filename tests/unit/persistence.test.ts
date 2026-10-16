/**
 * Local storage and the client-side state it backs.
 *
 * Three promises are tested here:
 *  - a corrupted or hand-edited store never crashes the app (validators),
 *  - everything a guest produces is exportable and erasable,
 *  - no secret is ever written to local storage (the "XSS cannot steal
 *    credentials from here" claim in Settings and the privacy page).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PROFILE,
  DEFAULT_UI,
  eraseAll,
  exportAll,
  loadBookmarks,
  loadProgress,
  loadProfile,
  loadSkillRatings,
  loadUiPrefs,
  saveBookmarks,
  saveProfile,
  saveSkillRatings,
  saveUiPrefs,
  STORAGE_KEYS,
  storageAvailable,
} from '@/core/persistence.ts'
import { useAppStore } from '@/state/store.ts'

const readAllStored = (): string => {
  const parts: string[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)!
    parts.push(`${key}=${window.localStorage.getItem(key) ?? ''}`)
  }
  return parts.join('\n')
}

describe('profile', () => {
  it('starts from documented defaults when nothing is stored', () => {
    const profile = loadProfile()
    expect(profile.onboardedAt).toBeNull()
    expect(profile.weeklyHours).toBe(DEFAULT_PROFILE.weeklyHours)
    expect(profile.preferredPace).toBe(DEFAULT_PROFILE.preferredPace)
  })

  it('round-trips through storage', () => {
    saveProfile({ ...DEFAULT_PROFILE, branch: 'Electronics', weeklyHours: 8 })
    const loaded = loadProfile()
    expect(loaded.branch).toBe('Electronics')
    expect(loaded.weeklyHours).toBe(8)
  })

  it('falls back to defaults for a corrupted record instead of throwing', () => {
    window.localStorage.setItem(STORAGE_KEYS.profile, '{"weeklyHours": "lots", }')
    expect(() => loadProfile()).not.toThrow()
    expect(loadProfile().weeklyHours).toBe(DEFAULT_PROFILE.weeklyHours)
  })

  it('drops out-of-range and unknown-shaped values', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.profile,
      JSON.stringify({ ...DEFAULT_PROFILE, weeklyHours: 100_000, preferredPace: 'sprint', theme: 'neon' }),
    )
    const loaded = loadProfile()
    expect(loaded.weeklyHours).toBeLessThanOrEqual(60)
    expect(['relaxed', 'steady', 'intensive']).toContain(loaded.preferredPace)
  })

  it('caps a hand-edited goal note instead of trusting its length', () => {
    window.localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify({ ...DEFAULT_PROFILE, goalNote: 'x'.repeat(5000) }))
    expect(loadProfile().goalNote.length).toBeLessThanOrEqual(600)
  })
})

describe('ratings, progress and bookmarks', () => {
  it('keeps one rating per skill, newest wins', () => {
    saveSkillRatings([{ skillId: 'skill:python-programming', state: 'new', updatedAt: '2026-01-01T00:00:00.000Z' }])
    const loaded = loadSkillRatings()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].state).toBe('new')
  })

  it('discards entries with an unknown state or a malformed id', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.skillRatings,
      JSON.stringify([
        { skillId: 'skill:python-programming', state: 'confident', updatedAt: '2026-01-01T00:00:00.000Z' },
        { skillId: 'skill:python-programming', state: 'expert', updatedAt: '2026-01-01T00:00:00.000Z' },
        { skillId: '', state: 'new', updatedAt: '2026-01-01T00:00:00.000Z' },
        'not an object',
      ]),
    )
    const loaded = loadSkillRatings()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].state).toBe('confident')
  })

  it('stores progress per roadmap and keeps the real skill id on each entry', () => {
    // Keys are task keys (a review row reuses a skill), so the entry has to carry
    // the skill separately — otherwise labels would show "review-3.5".
    window.localStorage.setItem(
      STORAGE_KEYS.progress,
      JSON.stringify({
        'career:software-engineer': {
          updatedAt: '2026-01-01T00:00:00.000Z',
          tasks: {
            'learn-0': { skillId: 'skill:python-programming', status: 'completed', actualHours: 12, updatedAt: '2026-01-01T00:00:00.000Z' },
            'review-2.5': { status: 'in-progress', updatedAt: '2026-01-02T00:00:00.000Z' },
          },
        },
      }),
    )
    const loaded = loadProgress()
    const tasks = loaded['career:software-engineer'].tasks
    expect(tasks['learn-0'].skillId).toBe('skill:python-programming')
    expect(tasks['learn-0'].actualHours).toBe(12)
    // A missing skillId falls back to the key rather than becoming undefined.
    expect(tasks['review-2.5'].skillId).toBe('review-2.5')
    expect(tasks['review-2.5'].status).toBe('in-progress')
  })

  it('rejects an unknown task status and an absurd hour count', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.progress,
      JSON.stringify({
        'career:x': {
          updatedAt: '2026-01-01T00:00:00.000Z',
          tasks: {
            a: { skillId: 'skill:a', status: 'finished', updatedAt: '2026-01-01T00:00:00.000Z' },
            b: { skillId: 'skill:b', status: 'completed', actualHours: -5, updatedAt: '2026-01-01T00:00:00.000Z' },
            c: { skillId: 'skill:c', status: 'completed', actualHours: 99_999, updatedAt: '2026-01-01T00:00:00.000Z' },
          },
        },
      }),
    )
    const tasks = loadProgress()['career:x'].tasks
    expect(tasks.a).toBeUndefined()
    expect(tasks.b).toBeUndefined()
    expect(tasks.c).toBeUndefined()
  })

  it('keeps bookmarks with a known target type only', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.bookmarks,
      JSON.stringify([
        { targetType: 'skill', targetId: 'skill:python-programming', note: '', createdAt: '2026-01-01T00:00:00.000Z' },
        { targetType: 'everything', targetId: 'x', note: '', createdAt: '2026-01-01T00:00:00.000Z' },
      ]),
    )
    const loaded = loadBookmarks()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].targetType).toBe('skill')
  })

  it('caps the number of stored bookmarks so the store cannot be used as free storage', () => {
    const many = Array.from({ length: 500 }, (_, index) => ({
      targetType: 'skill' as const,
      targetId: `skill:s${index}`,
      note: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    }))
    saveBookmarks(many)
    expect(loadBookmarks().length).toBeLessThanOrEqual(300)
  })
})

describe('UI preferences', () => {
  it('round-trips and defaults', () => {
    expect(loadUiPrefs().theme).toBe(DEFAULT_UI.theme)
    saveUiPrefs({ ...DEFAULT_UI, theme: 'light', reducedMotion: true })
    expect(loadUiPrefs()).toMatchObject({ theme: 'light', reducedMotion: true })
  })

  it('rejects an unknown theme rather than writing it through to <html>', () => {
    window.localStorage.setItem(STORAGE_KEYS.ui, JSON.stringify({ ...DEFAULT_UI, theme: '<script>' }))
    expect(loadUiPrefs().theme).toBe(DEFAULT_UI.theme)
  })
})

describe('export and erase (data rights)', () => {
  it('exports everything a guest has, scoped to this device', () => {
    saveProfile({ ...DEFAULT_PROFILE, branch: 'Mechanical' })
    saveSkillRatings([{ skillId: 'skill:python-programming', state: 'practised', updatedAt: '2026-01-01T00:00:00.000Z' }])

    const exported = exportAll()
    expect(exported.scope).toBe('local-device-only')
    expect(JSON.stringify(exported)).toContain('Mechanical')
    expect(JSON.stringify(exported)).toContain('skill:python-programming')
    expect(JSON.stringify(exported)).toContain('exportedAt')
  })

  it('erases every key it owns and reports which ones were removed', () => {
    saveProfile({ ...DEFAULT_PROFILE, branch: 'Civil' })
    saveUiPrefs({ ...DEFAULT_UI, theme: 'light' })
    const removed = eraseAll()
    expect(removed.length).toBeGreaterThan(0)
    for (const key of Object.values(STORAGE_KEYS)) {
      expect(window.localStorage.getItem(key), key).toBeNull()
    }
    expect(loadProfile().branch).toBe(DEFAULT_PROFILE.branch)
    expect(readAllStored()).not.toContain('Civil')
  })

  it('reports storage availability honestly, and survives a blocked store', () => {
    expect(storageAvailable()).toBe(true)
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    // Private mode / quota exhaustion must be reported, not assumed away.
    expect(storageAvailable()).toBe(false)
    // And the app keeps working: writes are swallowed, reads fall back to defaults.
    expect(() => saveProfile({ ...DEFAULT_PROFILE, branch: 'Blocked' })).not.toThrow()
    spy.mockRestore()
    expect(storageAvailable()).toBe(true)
  })
})

describe('no secrets are ever written to local storage', () => {
  it('writes no credential-shaped value, even after a full guest session', () => {
    const store = useAppStore.getState()
    store.setProfile({ ...DEFAULT_PROFILE, branch: 'Software', goalNote: 'Aim for embedded work' })
    store.setSkillState('skill:python-programming', 'confident', 80)
    store.setTaskStatus('career:software-engineer', 'learn-0', 'in-progress', { skillId: 'skill:python-programming' })
    store.toggleBookmark({ targetType: 'skill', targetId: 'skill:python-programming' })
    store.setUi({ theme: 'light' })

    const dump = readAllStored()
    const credentialShapes = [
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
      /sk-[A-Za-z0-9]{12,}/, // OpenAI-style key
      /AIza[0-9A-Za-z_-]{20,}/, // Google API key
      /\bBearer\s+\S+/i,
      /neo4j(\+s)?:\/\//i,
      /postgres(ql)?:\/\//i,
      /\b(password|passwd|secret|api[_-]?key|service_role)\b/i,
    ]
    for (const shape of credentialShapes) {
      expect(shape.test(dump), `local storage matched ${shape}`).toBe(false)
    }
  })

  it('namespaces every key under one prefix so erasure is complete', () => {
    for (const key of Object.values(STORAGE_KEYS)) expect(key.startsWith('gm.v1.')).toBe(true)
  })
})

describe('store behaviour', () => {
  beforeEach(() => {
    useAppStore.getState().eraseLocalData()
  })

  it('tracks progress against the task key while remembering the skill', () => {
    const store = useAppStore.getState()
    store.setTaskStatus('career:data-analyst', 'review-1.5', 'completed', { skillId: 'skill:python-programming' })
    const entry = useAppStore.getState().progress['career:data-analyst'].tasks['review-1.5']
    expect(entry.status).toBe('completed')
    expect(entry.skillId).toBe('skill:python-programming')
  })

  it('resets only the roadmap asked for', () => {
    const store = useAppStore.getState()
    store.setTaskStatus('career:a', 'learn-0', 'completed')
    store.setTaskStatus('career:b', 'learn-0', 'completed')
    store.resetRoadmapProgress('career:a')
    const progress = useAppStore.getState().progress
    expect(progress['career:a']).toBeUndefined()
    expect(progress['career:b']).toBeDefined()
  })

  it('toggles a bookmark and reports whether it was added', () => {
    const store = useAppStore.getState()
    expect(store.toggleBookmark({ targetType: 'skill', targetId: 'skill:a' })).toBe(true)
    expect(useAppStore.getState().bookmarks).toHaveLength(1)
    expect(useAppStore.getState().toggleBookmark({ targetType: 'skill', targetId: 'skill:a' })).toBe(false)
    expect(useAppStore.getState().bookmarks).toHaveLength(0)
  })

  it('replaces a rating rather than stacking duplicates', () => {
    const store = useAppStore.getState()
    store.setSkillState('skill:a', 'new')
    store.setSkillState('skill:a', 'confident', 90)
    const ratings = useAppStore.getState().ratings
    expect(ratings).toHaveLength(1)
    expect(ratings[0]).toMatchObject({ state: 'confident', quizScore: 90 })
  })

  it('applies the theme to the document and resolves "system"', () => {
    const store = useAppStore.getState()
    store.setUi({ theme: 'light' })
    expect(document.documentElement.dataset.theme).toBe('light')
    store.setUi({ theme: 'dark' })
    expect(document.documentElement.dataset.theme).toBe('dark')
    store.setUi({ theme: 'system' })
    // matchMedia is stubbed to report a light OS preference in tests/setup.ts.
    expect(['light', 'dark']).toContain(document.documentElement.dataset.theme)
    store.setUi({ reducedMotion: true })
    // The attribute the 3D gate and the stylesheet read. This assertion used to
    // check `data-reduced-motion`, which the store wrote and nothing read — the
    // writer was tested, the reader was not, and the two disagreed for as long
    // as it took a measurement to notice. tests/unit/motion-preference.test.ts
    // now pins writer, reader and stylesheet together.
    expect(document.documentElement.dataset.motion).toBe('reduced')
    store.setUi({ reducedMotion: false })
    expect(document.documentElement.dataset.motion).toBe('full')
  })

  it('queues toasts and dismisses them', () => {
    const store = useAppStore.getState()
    store.pushToast({ kind: 'info', message: 'Hello' })
    expect(useAppStore.getState().toasts).toHaveLength(1)
    useAppStore.getState().dismissToast(useAppStore.getState().toasts[0].id)
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('keeps the toast list bounded so a runaway loop cannot grow it forever', () => {
    const store = useAppStore.getState()
    for (let index = 0; index < 20; index += 1) store.pushToast({ kind: 'info', message: `Toast ${index}` })
    expect(useAppStore.getState().toasts.length).toBeLessThanOrEqual(4)
  })
})


