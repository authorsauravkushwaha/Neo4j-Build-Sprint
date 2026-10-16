/**
 * Application state.
 *
 * Everything a guest does is stored locally and can be exported or erased from
 * Settings. Signing in adds a server copy (src/core/sync.ts) but never removes
 * the local one, so the app keeps working offline.
 */
import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'

import type { Difficulty, SkillState, TaskStatus } from '@core/types.ts'
import { api } from '@/core/session.ts'
import {
  DEFAULT_PROFILE,
  DEFAULT_UI,
  eraseAll,
  exportAll,
  loadBookmarks,
  loadLocalRoadmaps,
  loadProfile,
  loadProgress,
  loadSkillRatings,
  loadUiPrefs,
  saveBookmarks,
  saveProfile,
  saveProgress,
  saveSkillRatings,
  saveUiPrefs,
  storageAvailable,
  type LocalBookmark,
  type LocalProfile,
  type LocalProgress,
  type LocalSkillRating,
  type LocalUiPrefs,
} from '@/core/persistence.ts'

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  /** Optional follow-up hint, e.g. how to fix a configuration problem. */
  detail?: string
}

interface ProfileState {
  profile: LocalProfile
  ratings: LocalSkillRating[]
  progress: LocalProgress
  bookmarks: LocalBookmark[]
  ui: LocalUiPrefs
  session: Session | null
  toasts: Toast[]
  storageOk: boolean

  setProfile: (patch: Partial<LocalProfile>) => void
  completeOnboarding: () => void
  setSkillState: (skillId: string, state: SkillState, quizScore?: number) => void
  setRatingMap: (ratings: LocalSkillRating[]) => void
  /**
   * Records progress for one roadmap row. `taskKey` identifies the row (a spaced
   * review row reuses its skill's id, so the skill alone is not unique);
   * `skillId` is kept alongside so labels and analytics stay readable.
   */
  setTaskStatus: (
    roadmapKey: string,
    taskKey: string,
    status: TaskStatus,
    extra?: { skillId?: string; actualHours?: number; notes?: string },
  ) => void
  resetRoadmapProgress: (roadmapKey: string) => void
  toggleBookmark: (target: { targetType: LocalBookmark['targetType']; targetId: string; note?: string }) => boolean
  /** Replace the whole local set (account sync download). */
  replaceBookmarks: (bookmarks: LocalBookmark[]) => void
  replaceRatings: (ratings: LocalSkillRating[]) => void
  replaceProgress: (progress: LocalProgress) => void
  setUi: (patch: Partial<LocalUiPrefs>) => void
  setSession: (session: Session | null) => void
  pushToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  exportLocalData: () => Record<string, unknown>
  eraseLocalData: () => string[]
  /** Guest roadmaps (saved without an account). */
  localRoadmaps: () => unknown
}

const makeId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const useAppStore = create<ProfileState>((set, get) => ({
  profile: loadProfile(),
  ratings: loadSkillRatings(),
  progress: loadProgress(),
  bookmarks: loadBookmarks(),
  ui: loadUiPrefs(),
  session: null,
  toasts: [],
  storageOk: storageAvailable(),

  setProfile: (patch) => {
    const next = { ...get().profile, ...patch }
    saveProfile(next)
    set({ profile: next })
  },

  completeOnboarding: () => {
    const next = { ...get().profile, onboardedAt: new Date().toISOString() }
    saveProfile(next)
    set({ profile: next })
  },

  setSkillState: (skillId, state, quizScore) => {
    const now = new Date().toISOString()
    const others = get().ratings.filter((rating) => rating.skillId !== skillId)
    const next: LocalSkillRating[] = [
      ...others,
      { skillId, state, ...(quizScore !== undefined ? { quizScore } : {}), updatedAt: now },
    ].sort((a, b) => a.skillId.localeCompare(b.skillId))
    saveSkillRatings(next)
    set({ ratings: next })
  },

  setRatingMap: (ratings) => {
    saveSkillRatings(ratings)
    set({ ratings })
  },

  setTaskStatus: (roadmapKey, taskKey, status, extra) => {
    const now = new Date().toISOString()
    const progress = { ...get().progress }
    const entry = progress[roadmapKey] ?? { tasks: {}, updatedAt: now }
    progress[roadmapKey] = {
      tasks: {
        ...entry.tasks,
        [taskKey]: {
          skillId: extra?.skillId ?? entry.tasks[taskKey]?.skillId ?? taskKey,
          status,
          ...(extra?.actualHours !== undefined ? { actualHours: extra.actualHours } : {}),
          ...(extra?.notes !== undefined ? { notes: extra.notes.slice(0, 600) } : {}),
          updatedAt: now,
        },
      },
      updatedAt: now,
    }
    saveProgress(progress)
    set({ progress })
  },

  resetRoadmapProgress: (roadmapKey) => {
    const progress = { ...get().progress }
    delete progress[roadmapKey]
    saveProgress(progress)
    set({ progress })
  },

  toggleBookmark: ({ targetType, targetId, note }) => {
    const existing = get().bookmarks.find((bookmark) => bookmark.targetId === targetId)
    let next: LocalBookmark[]
    let added = false
    if (existing) {
      next = get().bookmarks.filter((bookmark) => bookmark.targetId !== targetId)
    } else {
      next = [{ targetType, targetId, note: note ?? '', createdAt: new Date().toISOString() }, ...get().bookmarks]
      added = true
    }
    saveBookmarks(next)
    set({ bookmarks: next })

    // Mirror to the account when the learner is signed in on a live backend. The
    // local write never waits for the network, and a failure says which copy is
    // missing instead of pretending the bookmark is safe everywhere.
    const session = get().session
    if (session && api().mode === 'live') {
      void api()
        .manageBookmarks({ action: added ? 'add' : 'remove', targetType, targetId, ...(note ? { note } : {}) })
        .catch((error: unknown) => {
          get().pushToast({
            kind: 'warning',
            message: added ? 'Bookmarked on this device only.' : 'Removed on this device only.',
            detail: `${error instanceof Error ? error.message : 'The request failed.'} Your account copy was not updated.`,
          })
        })
    }
    return added
  },

  replaceBookmarks: (bookmarks) => {
    saveBookmarks(bookmarks)
    set({ bookmarks })
  },

  replaceRatings: (ratings) => {
    saveSkillRatings(ratings)
    set({ ratings })
  },

  replaceProgress: (progress) => {
    saveProgress(progress)
    set({ progress })
  },

  setUi: (patch) => {
    const next = { ...get().ui, ...patch }
    saveUiPrefs(next)
    set({ ui: next })
    applyTheme(next)
  },

  setSession: (session) => set({ session }),

  pushToast: (toast) => {
    const withId: Toast = { ...toast, id: makeId() }
    set({ toasts: [...get().toasts.slice(-3), withId] })
    if (toast.kind !== 'error') {
      window.setTimeout(() => get().dismissToast(withId.id), 6000)
    }
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),

  exportLocalData: () => exportAll(),

  eraseLocalData: () => {
    const removed = eraseAll()
    set({
      profile: { ...DEFAULT_PROFILE },
      ratings: [],
      progress: {},
      bookmarks: [],
      ui: { ...DEFAULT_UI },
    })
    return removed
  },

  localRoadmaps: () => loadLocalRoadmaps(),
}))

/** Applies the theme to <html data-theme>, following the OS when asked to. */
export function applyTheme(prefs: LocalUiPrefs = useAppStore.getState().ui): 'dark' | 'light' {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const resolved: 'dark' | 'light' = prefs.theme === 'system' ? (prefersDark ? 'dark' : 'light') : prefs.theme
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved
    /*
     * `data-motion` is the spelling the 3D gate (components/three/webgl.ts) and
     * the stylesheet both read. This used to write `data-reduced-motion`, which
     * nothing read: the Settings switch "Reduce motion" therefore changed one
     * attribute and nothing else — the 3D scenes kept drifting and the CSS
     * animations kept running for anyone who had explicitly asked them to stop.
     * The OS preference was honoured (a media query + matchMedia), which hid the
     * bug from every test that emulated the OS setting alone.
     * Found by the audience study's `a11y.reducedMotion` measurement, which read
     * the attribute that is actually consulted and got "(unset)".
     */
    /*
     * `data-motion` is the answer to "is motion reduced right now?", so it must
     * reflect both sources: the switch in Settings and the operating system. It
     * used to answer a narrower question ("is the app switch on?"), which left
     * the page declaring `full` while the OS was asking for less motion — true
     * about the switch, false about the page.
     */
    const osPrefers = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    document.documentElement.dataset.motion = prefs.reducedMotion || osPrefers ? 'reduced' : 'full'
  }
  return resolved
}

/** Ratings in the shape the engines expect. */
export function ratingPayload(): Array<{ skillId: string; state: SkillState; quizScore?: number }> {
  return useAppStore.getState().ratings.map((rating) => ({
    skillId: rating.skillId,
    state: rating.state,
    ...(rating.quizScore !== undefined ? { quizScore: rating.quizScore } : {}),
  }))
}

export function interestIds(): string[] {
  return useAppStore.getState().profile.interestIds
}

export function profileDifficulty(): Difficulty {
  return useAppStore.getState().profile.difficultyComfort
}


