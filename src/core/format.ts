/**
 * Presentation helpers. Kept boring and deterministic so the UI reads the same
 * everywhere: numbers get thin spaces, hour ranges always show a range, and
 * nothing ever claims more precision than the data has.
 */
import type { Difficulty, GapCategory, SkillState, TaskStatus } from '@core/types.ts'

const nf = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })

export function formatNumber(value: number): string {
  return nf.format(value)
}

/** "6–10 h" — always a range, because every estimate in this app is a range. */
export function formatHours(range: [number, number]): string {
  const [low, high] = range
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 'unestimated'
  if (low === high) return `${formatNumber(low)} h`
  return `${formatNumber(low)}–${formatNumber(high)} h`
}

/** "about 8 weeks" — deliberately vague, since pace varies by learner. */
export function formatWeeks(hours: [number, number], weeklyHours: number): string {
  if (weeklyHours <= 0) return 'no weekly time budget set'
  const low = Math.max(1, Math.ceil(hours[0] / weeklyHours))
  const high = Math.max(low, Math.ceil(hours[1] / weeklyHours))
  return low === high ? `about ${low} week${low === 1 ? '' : 's'}` : `about ${low}–${high} weeks`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const diffMs = Date.now() - date.getTime()
  const days = Math.round(diffMs / 86_400_000)
  if (Math.abs(days) < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days > 1 && days < 45) return `${days} days ago`
  if (days < 0 && days > -45) return `in ${Math.abs(days)} days`
  return formatDate(value)
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
}

export const SKILL_STATE_LABELS: Record<SkillState, string> = {
  unknown: 'Not started',
  new: 'Just started',
  learning: 'Learning',
  practised: 'Practised',
  confident: 'Confident',
}

export const SKILL_STATE_HINTS: Record<SkillState, string> = {
  unknown: 'No experience yet, or not assessed.',
  new: 'Seen the basics, still needs guidance.',
  learning: 'Can follow along and do guided exercises.',
  practised: 'Can do it unaided on a small task.',
  confident: 'Can explain it and use it in a new situation.',
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  completed: 'Completed',
  'needs-review': 'Needs review',
}

export const GAP_CATEGORY_LABELS: Record<GapCategory, string> = {
  'already-familiar': 'Already familiar',
  'ready-to-practice': 'Ready to practise',
  'recommended-next': 'Recommended next',
  'missing-prerequisite': 'Missing prerequisite',
  'optional-specialization': 'Optional specialisation',
}

export const GAP_CATEGORY_TONES: Record<GapCategory, 'success' | 'accent' | 'warning' | 'danger' | 'violet'> = {
  'already-familiar': 'success',
  'ready-to-practice': 'accent',
  'recommended-next': 'violet',
  'missing-prerequisite': 'danger',
  'optional-specialization': 'warning',
}

/** Turns "skill:data-structures-and-algorithms" into "Data structures and algorithms". */
export function idToLabel(id: string): string {
  const [, raw = id] = id.split(':')
  const spaced = raw.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function truncate(text: string, max = 220): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)))
}

/** Verdict shown next to a resource link; never claims "free" on its own. */
export function accessTone(accessModel: string): 'success' | 'accent' | 'warning' | 'default' {
  if (accessModel === 'free' || accessModel === 'free-open-source') return 'success'
  if (accessModel === 'free-audit' || accessModel === 'freemium') return 'accent'
  if (accessModel === 'paid' || accessModel === 'unknown') return 'warning'
  return 'default'
}


