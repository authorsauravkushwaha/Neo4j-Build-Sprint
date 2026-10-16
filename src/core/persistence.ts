/**
 * Local storage for guests and for anything that should survive a reload
 * without an account.
 *
 * Rules this module enforces (they are product requirements, not preferences):
 *   - only non-sensitive data is stored: onboarding answers, self-reported skill
 *     states, task progress, bookmarks, theme. Never tokens, never chat content,
 *     never anything the server considers private,
 *   - every read validates the stored shape and falls back to defaults, so a
 *     hand-edited or older payload can never crash the app,
 *   - the user can export and erase everything from Settings, and `eraseAll()`
 *     removes every key this app writes.
 *
 * When the user signs in, the same shapes are synced to Supabase by
 * `src/core/sync.ts`; localStorage stays the offline copy.
 */
import type { Difficulty, SkillState, TaskStatus } from '@core/types.ts'

const PREFIX = 'gm.v1.'
export const STORAGE_KEYS = {
  profile: `${PREFIX}profile`,
  skillRatings: `${PREFIX}skill-ratings`,
  progress: `${PREFIX}progress`,
  bookmarks: `${PREFIX}bookmarks`,
  roadmaps: `${PREFIX}roadmaps`,
  feedback: `${PREFIX}feedback`,
  ui: `${PREFIX}ui`,
  consent: `${PREFIX}consent`,
  recent: `${PREFIX}recent`,
} as const

export type LocalKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]

export interface LocalProfile {
  onboardedAt: string | null
  educationLevel: string
  branch: string
  interestIds: string[]
  careerGoalId: string | null
  weeklyHours: number
  preferredPace: 'relaxed' | 'steady' | 'intensive'
  learningStyle: 'video' | 'reading' | 'hands-on' | 'mixed'
  difficultyComfort: Difficulty
  goalNote: string
}

export interface LocalSkillRating {
  skillId: string
  state: SkillState
  quizScore?: number
  updatedAt: string
}

export interface LocalTaskProgress {
  skillId: string
  status: TaskStatus
  actualHours?: number
  notes?: string
  updatedAt: string
}

export interface LocalProgress {
  /** Keyed by roadmap id (or `career:<careerId>` before a roadmap is saved). */
  [roadmapId: string]: { tasks: Record<string, LocalTaskProgress>; updatedAt: string }
}

/**
 * A roadmap this device remembers, plus how to reach it on the server.
 *
 * Guest plans live here too: `storedOn` says where the copy actually is, and the
 * UI repeats that rather than implying a backup exists.
 */
export interface LocalSavedRoadmap {
  roadmapId: string
  title: string
  careerId: string
  weeklyHours: number
  pace: string
  taskCount: number
  /** Client task key (learn-3, review-1.5) → the id that row answers to. */
  taskIds: Record<string, string>
  tasks: Array<{
    skillId: string
    name: string
    order: number
    scheduledWeek: number
    estimatedHoursLow: number
    estimatedHoursHigh: number
    taskKey: string
    kind: 'learn' | 'review'
  }>
  savedAt: string
  storedOn: 'device' | 'account'
}

/** A feedback report. In demo mode it stays on the device instead of being sent. */
export interface LocalFeedbackEntry {
  id: string
  kind: string
  message: string
  contact?: string
  targetId?: string
  pageUrl?: string
  createdAt: string
}

export interface LocalBookmark {
  targetType: 'skill' | 'project' | 'resource' | 'career' | 'module'
  targetId: string
  note: string
  createdAt: string
}

export interface LocalUiPrefs {
  theme: 'dark' | 'light' | 'system'
  reducedMotion: boolean
  graphLabels: boolean
  graphAnimations: boolean
  /**
   * Try the 3D views even when the capability probe says the GPU looks slow.
   *
   * The probe refuses a context when the browser reports a major performance
   * caveat — which is correct on a genuinely weak device and wrong on a machine
   * whose only problem is software rendering. Since that judgement is a guess
   * about hardware, the person using it gets the final say, with a warning that
   * it may be slow. Defaults to false so the cautious answer stays the default.
   */
  force3d: boolean
}

export const DEFAULT_PROFILE: LocalProfile = {
  onboardedAt: null,
  educationLevel: '',
  branch: '',
  interestIds: [],
  careerGoalId: null,
  weeklyHours: 8,
  preferredPace: 'steady',
  learningStyle: 'mixed',
  difficultyComfort: 'beginner',
  goalNote: '',
}

export const DEFAULT_UI: LocalUiPrefs = {
  theme: 'system',
  reducedMotion: false,
  graphLabels: true,
  graphAnimations: true,
  force3d: false,
}

function available(): boolean {
  try {
    const probe = `${PREFIX}probe`
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

const canStore = typeof window !== 'undefined' && available()

function readRaw(key: LocalKey): unknown {
  if (!canStore) return null
  try {
    const text = window.localStorage.getItem(key)
    return text ? (JSON.parse(text) as unknown) : null
  } catch {
    return null
  }
}

function writeRaw(key: LocalKey, value: unknown): void {
  if (!canStore) return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota exceeded or storage disabled: the app keeps working in memory.
  }
}

/* ------------------------------------------------------------------ readers */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Statuses a task row may carry; anything else is discarded on read. */
const TASK_STATUSES = ['not-started', 'in-progress', 'completed', 'needs-review'] as const

export function loadProfile(): LocalProfile {
  const raw = readRaw(STORAGE_KEYS.profile)
  if (!isRecord(raw)) return { ...DEFAULT_PROFILE }
  const pace = raw.preferredPace
  const style = raw.learningStyle
  const comfort = raw.difficultyComfort
  return {
    onboardedAt: typeof raw.onboardedAt === 'string' ? raw.onboardedAt : null,
    educationLevel: typeof raw.educationLevel === 'string' ? raw.educationLevel : '',
    branch: typeof raw.branch === 'string' ? raw.branch : '',
    interestIds: Array.isArray(raw.interestIds) ? raw.interestIds.filter((v): v is string => typeof v === 'string') : [],
    careerGoalId: typeof raw.careerGoalId === 'string' ? raw.careerGoalId : null,
    weeklyHours: typeof raw.weeklyHours === 'number' && raw.weeklyHours > 0 ? Math.min(60, raw.weeklyHours) : 8,
    preferredPace: pace === 'relaxed' || pace === 'intensive' || pace === 'steady' ? pace : 'steady',
    learningStyle: style === 'video' || style === 'reading' || style === 'hands-on' || style === 'mixed' ? style : 'mixed',
    difficultyComfort: comfort === 'beginner' || comfort === 'intermediate' || comfort === 'advanced' ? comfort : 'beginner',
    goalNote: typeof raw.goalNote === 'string' ? raw.goalNote.slice(0, 200) : '',
  }
}

export function saveProfile(profile: LocalProfile): void {
  writeRaw(STORAGE_KEYS.profile, profile)
}

export function loadSkillRatings(): LocalSkillRating[] {
  const raw = readRaw(STORAGE_KEYS.skillRatings)
  if (!Array.isArray(raw)) return []
  const states: SkillState[] = ['unknown', 'new', 'learning', 'practised', 'confident']
  return raw.flatMap((entry): LocalSkillRating[] => {
    if (!isRecord(entry) || typeof entry.skillId !== 'string') return []
    // An empty or foreign id cannot be joined against the graph, so it is not
    // worth keeping: it would only inflate "skills rated" counts.
    if (!entry.skillId.startsWith('skill:') || entry.skillId.length > 80) return []
    const state = entry.state
    if (typeof state !== 'string' || !states.includes(state as SkillState)) return []
    return [
      {
        skillId: entry.skillId,
        state: state as SkillState,
        ...(typeof entry.quizScore === 'number' ? { quizScore: Math.min(1, Math.max(0, entry.quizScore)) } : {}),
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
      },
    ]
  })
}

export function saveSkillRatings(ratings: LocalSkillRating[]): void {
  writeRaw(STORAGE_KEYS.skillRatings, ratings.slice(0, 400))
}

export function loadProgress(): LocalProgress {
  const raw = readRaw(STORAGE_KEYS.progress)
  if (!isRecord(raw)) return {}
  const out: LocalProgress = {}
  for (const [roadmapId, value] of Object.entries(raw)) {
    if (!isRecord(value) || !isRecord(value.tasks)) continue
    const tasks: Record<string, LocalTaskProgress> = {}
    // Entries are keyed by task key (a review row reuses the skill it rehearses),
    // so the skill id is stored on the entry itself. Older records keyed by skill
    // id keep working: the key is the fallback.
    for (const [taskKey, task] of Object.entries(value.tasks)) {
      if (!isRecord(task) || typeof task.status !== 'string') continue
      if (!(TASK_STATUSES as readonly string[]).includes(task.status)) continue
      if (typeof task.actualHours === 'number' && !(task.actualHours >= 0 && task.actualHours <= 10_000)) continue
      tasks[taskKey] = {
        skillId: typeof task.skillId === 'string' && task.skillId.length > 0 ? task.skillId.slice(0, 80) : taskKey,
        status: task.status as TaskStatus,
        ...(typeof task.actualHours === 'number' ? { actualHours: task.actualHours } : {}),
        ...(typeof task.notes === 'string' ? { notes: task.notes.slice(0, 600) } : {}),
        updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : new Date().toISOString(),
      }
    }
    out[roadmapId] = { tasks, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString() }
  }
  return out
}

export function saveProgress(progress: LocalProgress): void {
  writeRaw(STORAGE_KEYS.progress, progress)
}

export function loadBookmarks(): LocalBookmark[] {
  const raw = readRaw(STORAGE_KEYS.bookmarks)
  if (!Array.isArray(raw)) return []
  const types: LocalBookmark['targetType'][] = ['skill', 'project', 'resource', 'career', 'module']
  return raw.flatMap((entry): LocalBookmark[] => {
    if (!isRecord(entry) || typeof entry.targetId !== 'string') return []
    const type = entry.targetType
    if (typeof type !== 'string' || !types.includes(type as LocalBookmark['targetType'])) return []
    return [
      {
        targetType: type as LocalBookmark['targetType'],
        targetId: entry.targetId,
        note: typeof entry.note === 'string' ? entry.note.slice(0, 400) : '',
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
      },
    ]
  })
}

export function saveBookmarks(bookmarks: LocalBookmark[]): void {
  writeRaw(STORAGE_KEYS.bookmarks, bookmarks.slice(0, 200))
}

export function loadUiPrefs(): LocalUiPrefs {
  const raw = readRaw(STORAGE_KEYS.ui)
  if (!isRecord(raw)) return { ...DEFAULT_UI }
  const theme = raw.theme
  return {
    theme: theme === 'dark' || theme === 'light' || theme === 'system' ? theme : 'system',
    reducedMotion: raw.reducedMotion === true,
    graphLabels: raw.graphLabels !== false,
    graphAnimations: raw.graphAnimations !== false,
    force3d: raw.force3d === true,
  }
}

export function saveUiPrefs(prefs: LocalUiPrefs): void {
  writeRaw(STORAGE_KEYS.ui, prefs)
}

/**
 * Roadmaps this device knows about.
 *
 * Older builds stored a raw `Roadmap` object here; anything that does not match
 * the current record shape is skipped rather than trusted, so a stale record
 * cannot crash a page.
 */
export function loadLocalRoadmaps(): LocalSavedRoadmap[] {
  const raw = readRaw(STORAGE_KEYS.roadmaps)
  const list = Array.isArray(raw) ? raw : []
  return list.flatMap((entry): LocalSavedRoadmap[] => {
    if (!isRecord(entry) || typeof entry.roadmapId !== 'string' || typeof entry.careerId !== 'string') return []
    const taskIds: Record<string, string> = {}
    if (isRecord(entry.taskIds)) {
      for (const [key, value] of Object.entries(entry.taskIds)) {
        if (typeof value === 'string' && key.length <= 80 && value.length <= 80) taskIds[key] = value
      }
    }
    const tasks = Array.isArray(entry.tasks)
      ? entry.tasks.flatMap((task): LocalSavedRoadmap['tasks'] => {
          if (!isRecord(task) || typeof task.skillId !== 'string' || typeof task.taskKey !== 'string') return []
          return [
            {
              skillId: task.skillId.slice(0, 80),
              name: typeof task.name === 'string' ? task.name.slice(0, 160) : task.taskKey,
              order: typeof task.order === 'number' ? task.order : 0,
              scheduledWeek: typeof task.scheduledWeek === 'number' ? task.scheduledWeek : 1,
              estimatedHoursLow: typeof task.estimatedHoursLow === 'number' ? task.estimatedHoursLow : 0,
              estimatedHoursHigh: typeof task.estimatedHoursHigh === 'number' ? task.estimatedHoursHigh : 0,
              taskKey: task.taskKey.slice(0, 80),
              kind: task.kind === 'review' ? 'review' : 'learn',
            },
          ]
        })
      : []
    return [
      {
        roadmapId: entry.roadmapId.slice(0, 80),
        title: typeof entry.title === 'string' ? entry.title.slice(0, 120) : 'My study plan',
        careerId: entry.careerId.slice(0, 80),
        weeklyHours: typeof entry.weeklyHours === 'number' ? entry.weeklyHours : 8,
        pace: typeof entry.pace === 'string' ? entry.pace : 'steady',
        taskCount: typeof entry.taskCount === 'number' ? entry.taskCount : tasks.length,
        taskIds,
        tasks,
        savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : new Date().toISOString(),
        storedOn: entry.storedOn === 'account' ? 'account' : 'device',
      },
    ]
  })
}

export function saveLocalRoadmaps(roadmaps: LocalSavedRoadmap[]): void {
  writeRaw(STORAGE_KEYS.roadmaps, roadmaps.slice(0, 20))
}

/* --------------------------------------------------------------- progress */

/**
 * Records one task's status locally.
 *
 * This is the write the client uses in demo mode and the one the store uses
 * always, so both paths produce identical rows.
 */
export function setTaskStatus(
  roadmapKey: string,
  taskKey: string,
  status: TaskStatus,
  extra: { skillId?: string; actualHours?: number; notes?: string } = {},
): void {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) return
  const progress = loadProgress()
  const entry = progress[roadmapKey] ?? { tasks: {}, updatedAt: new Date().toISOString() }
  const previous = entry.tasks[taskKey]
  progress[roadmapKey] = {
    tasks: {
      ...entry.tasks,
      [taskKey]: {
        skillId: (extra.skillId ?? previous?.skillId ?? taskKey).slice(0, 80),
        status,
        ...(typeof extra.actualHours === 'number'
          ? { actualHours: extra.actualHours }
          : previous?.actualHours !== undefined
            ? { actualHours: previous.actualHours }
            : {}),
        ...(extra.notes !== undefined ? { notes: extra.notes.slice(0, 600) } : previous?.notes !== undefined ? { notes: previous.notes } : {}),
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  }
  saveProgress(progress)
}

/** Removes every stored task for one roadmap. Returns how many were removed. */
export function resetRoadmapProgress(roadmapKey?: string): number {
  const progress = loadProgress()
  if (!roadmapKey) {
    const removed = Object.values(progress).reduce((sum, entry) => sum + Object.keys(entry.tasks).length, 0)
    saveProgress({})
    return removed
  }
  const removed = Object.keys(progress[roadmapKey]?.tasks ?? {}).length
  delete progress[roadmapKey]
  saveProgress(progress)
  return removed
}

/** Progress counts computed from the stored rows — never from a caller's tally. */
export function summarizeLocalProgress(roadmapKey: string): { totalTasks: number; completed: number; percentComplete: number } | null {
  const entry = loadProgress()[roadmapKey]
  if (!entry) return null
  const tasks = Object.values(entry.tasks)
  const completed = tasks.filter((task) => task.status === 'completed').length
  return {
    totalTasks: tasks.length,
    completed,
    percentComplete: tasks.length === 0 ? 0 : Math.round((completed / tasks.length) * 100),
  }
}

/* --------------------------------------------------------------- feedback */

export function loadFeedbackOutbox(): LocalFeedbackEntry[] {
  const raw = readRaw(STORAGE_KEYS.feedback)
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): LocalFeedbackEntry[] => {
    if (!isRecord(entry) || typeof entry.message !== 'string') return []
    return [
      {
        id: typeof entry.id === 'string' ? entry.id : `${Date.now().toString(36)}`,
        kind: typeof entry.kind === 'string' ? entry.kind.slice(0, 32) : 'other',
        message: entry.message.slice(0, 1500),
        ...(typeof entry.contact === 'string' ? { contact: entry.contact.slice(0, 160) } : {}),
        ...(typeof entry.targetId === 'string' ? { targetId: entry.targetId.slice(0, 80) } : {}),
        ...(typeof entry.pageUrl === 'string' ? { pageUrl: entry.pageUrl.slice(0, 300) } : {}),
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
      },
    ]
  })
}

export function saveFeedbackOutbox(entries: LocalFeedbackEntry[]): void {
  writeRaw(STORAGE_KEYS.feedback, entries.slice(0, 50))
}

/* ------------------------------------------------------------ recent views */

/** One recently viewed career or skill. Stored on this device only. */
export interface LocalRecentView {
  /** Route to reopen, e.g. `/careers/career:aerospace-engineer`. */
  to: string
  name: string
  kind: 'Career' | 'Skill'
  viewedAt: string
}

const RECENT_LIMIT = 8

export function loadRecentViews(): LocalRecentView[] {
  const raw = readRaw(STORAGE_KEYS.recent)
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (entry): entry is LocalRecentView =>
        isRecord(entry) &&
        typeof entry.to === 'string' &&
        typeof entry.name === 'string' &&
        (entry.kind === 'Career' || entry.kind === 'Skill') &&
        typeof entry.viewedAt === 'string',
    )
    .slice(0, RECENT_LIMIT)
}

/**
 * Record a page view, newest first, de-duplicated by route. Deliberately
 * capped and name-only: this is a convenience for the person using this
 * device, not an analytics trail — it is exported and erased with everything
 * else in Settings.
 */
export function recordRecentView(entry: Omit<LocalRecentView, 'viewedAt'>): void {
  const current = loadRecentViews().filter((view) => view.to !== entry.to)
  writeRaw(STORAGE_KEYS.recent, [{ ...entry, viewedAt: new Date().toISOString() }, ...current].slice(0, RECENT_LIMIT))
}

/* ------------------------------------------------------------ data rights */

export function exportAll(): Record<string, unknown> {
  return {
    exportedAt: new Date().toISOString(),
    scope: 'local-device-only',
    note:
      'This file contains the data this device stored locally: onboarding answers, self-reported skill states, ' +
      'roadmap progress and bookmarks. It contains no credentials and no chat transcript. Server-side data ' +
      '(if you signed in) is exported separately from Settings > Your data.',
    profile: loadProfile(),
    skillRatings: loadSkillRatings(),
    progress: loadProgress(),
    bookmarks: loadBookmarks(),
    ui: loadUiPrefs(),
    roadmaps: loadLocalRoadmaps(),
    feedback: loadFeedbackOutbox(),
    recentViews: loadRecentViews(),
  }
}

/** Removes every key this app wrote. Used by Settings > Erase local data. */
export function eraseAll(): string[] {
  const removed: string[] = []
  for (const key of Object.values(STORAGE_KEYS)) {
    if (!canStore) break
    try {
      if (window.localStorage.getItem(key) !== null) {
        window.localStorage.removeItem(key)
        removed.push(key)
      }
    } catch {
      // ignore
    }
  }
  return removed
}

/**
 * Probed once at startup for the write path (`canStore`), and re-probed here
 * because callers use this to *report* the state — private-mode or quota changes
 * mid-session should be visible in Settings rather than frozen at import time.
 */
export function storageAvailable(): boolean {
  return canStore && available()
}


