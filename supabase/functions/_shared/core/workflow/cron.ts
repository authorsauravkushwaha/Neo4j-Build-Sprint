/**
 * A five-field cron parser, for `gm.trigger.schedule`.
 *
 * Deliberately small: minutes, hours, day-of-month, month, day-of-week. No
 * seconds, no `@reboot`, no time zone of its own — a schedule runs in UTC and the
 * trigger says so, because "Mondays at 06:00" that means something different per
 * machine is a bug that only shows up in the run that mattered.
 *
 * The parser is a pure function over a string and a `from` date, which means the
 * awkward parts (month ends, leap years, "the 31st") can be tested exhaustively
 * without waiting for a week to pass.
 *
 * The day-of-month / day-of-week combination follows the standard: when *both* are
 * restricted, a date matches if **either** matches. That is the behaviour every
 * other cron does, it surprises everybody the first time, and it is documented
 * here rather than quietly "fixed" into something incompatible.
 */
import { stringifyValue } from './expressions.ts'

export interface CronField {
  /** The values the field can take, in order, without duplicates. */
  values: number[]
  raw: string
}

export interface ParsedCron {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
  /** The original string, kept so a run log can quote what was configured. */
  source: string
}

const FIELDS: Array<{ name: string; min: number; max: number; aliases?: Record<string, number> }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, aliases: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 } },
  { name: 'day-of-week', min: 0, max: 6, aliases: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } },
]

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function parseNumber(token: string, field: (typeof FIELDS)[number]): number {
  const lowered = token.trim().toLowerCase()
  const aliased = field.aliases?.[lowered]
  if (aliased !== undefined) return aliased
  if (!/^\d+$/.test(lowered)) throw new Error(`"${token}" is not a number or a known name in the ${field.name} field.`)
  const value = Number(lowered)
  // Sunday is both 0 and 7 in cron; accept 7 and normalise, refuse the rest.
  if (field.name === 'day-of-week' && value === 7) return 0
  if (value < field.min || value > field.max) {
    throw new Error(`The ${field.name} field starts at ${field.min} and ends at ${field.max}; "${token}" is outside that.`)
  }
  return value
}

function parseField(token: string, field: (typeof FIELDS)[number]): CronField {
  const values = new Set<number>()
  for (const part of token.split(',')) {
    const piece = part.trim()
    if (piece === '') throw new Error(`The ${field.name} field has an empty entry.`)
    const [rangeText, stepText] = piece.split('/')
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw new Error(`The step in "${piece}" must be a positive whole number.`)
    }
    const step = stepText === undefined ? 1 : Number(stepText)
    let start: number
    let end: number
    if (rangeText === '*') {
      start = field.min
      end = field.max
    } else if (rangeText !== undefined && rangeText.includes('-')) {
      const [from, to] = rangeText.split('-')
      start = parseNumber(from ?? '', field)
      end = parseNumber(to ?? '', field)
      if (start > end) throw new Error(`The range "${rangeText}" in the ${field.name} field runs backwards.`)
    } else {
      start = parseNumber(rangeText ?? '', field)
      end = stepText === undefined ? start : field.max
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (values.size === 0) throw new Error(`The ${field.name} field matches nothing.`)
  return { values: [...values].sort((a, b) => a - b), raw: token }
}

/** Parses a five-field expression. Throws a sentence a person can act on. */
export function parseCron(source: string): ParsedCron {
  const text = stringifyValue(source).trim()
  if (text === '') throw new Error('A schedule needs a cron expression.')
  const fields = text.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`A cron expression has five fields (minute hour day-of-month month day-of-week); "${text}" has ${fields.length}.`)
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  return {
    minute: parseField(minute, FIELDS[0]!),
    hour: parseField(hour, FIELDS[1]!),
    dayOfMonth: parseField(dayOfMonth, FIELDS[2]!),
    month: parseField(month, FIELDS[3]!),
    dayOfWeek: parseField(dayOfWeek, FIELDS[4]!),
    source: text,
  }
}

export function isValidCron(source: string): boolean {
  try {
    parseCron(source)
    return true
  } catch {
    return false
  }
}

const isWildcard = (field: CronField, min: number, max: number): boolean => field.raw === '*' || field.values.length === max - min + 1

function matches(date: Date, cron: ParsedCron): boolean {
  if (!cron.minute.values.includes(date.getUTCMinutes())) return false
  if (!cron.hour.values.includes(date.getUTCHours())) return false
  if (!cron.month.values.includes(date.getUTCMonth() + 1)) return false
  const domRestricted = !isWildcard(cron.dayOfMonth, 1, 31)
  const dowRestricted = !isWildcard(cron.dayOfWeek, 0, 6)
  if (domRestricted && dowRestricted) {
    // Both restricted: either may match. Standard, surprising, documented above.
    return cron.dayOfMonth.values.includes(date.getUTCDate()) || cron.dayOfWeek.values.includes(date.getUTCDay())
  }
  if (domRestricted) return cron.dayOfMonth.values.includes(date.getUTCDate())
  if (dowRestricted) return cron.dayOfWeek.values.includes(date.getUTCDay())
  return true
}

/**
 * The next `count` times the expression fires, strictly after `from`.
 *
 * Walks minute by minute from the minute after `from`, which is fine for a
 * five-field expression and a bounded search, and refuses to pretend otherwise:
 * an expression that matches nothing within four years (an impossible February
 * combination, say) throws instead of looping.
 */
export function nextOccurrences(source: string, from: Date, count = 3): Date[] {
  const cron = parseCron(source)
  const results: Date[] = []
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours(), from.getUTCMinutes()))
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  const limit = new Date(cursor.getTime())
  limit.setUTCFullYear(limit.getUTCFullYear() + 4)
  while (results.length < count && cursor <= limit) {
    if (matches(cursor, cron)) results.push(new Date(cursor.getTime()))
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  }
  if (results.length < count) {
    throw new Error(`"${source}" does not fire ${count} times within four years of ${from.toISOString()}; check the day-of-month and month fields.`)
  }
  return results
}

/** True when the expression fires at this minute. Used by the CLI's `--due` check. */
export function isDue(source: string, at: Date): boolean {
  return matches(at, parseCron(source))
}

/**
 * A sentence for the UI.
 *
 * Never a restatement of the expression: a reading of it. "0 6 * * 1" is a thing
 * people copy from a blog post and cannot check; "minute 0 of hour 06:00, every
 * Monday (UTC)" is a claim they can verify at a glance, and disagree with.
 */
export function describeCron(source: string): string {
  const cron = parseCron(source)
  const minuteText =
    cron.minute.raw === '*'
      ? 'every minute'
      : /^\*\/\d+$/.test(cron.minute.raw)
        ? `every ${cron.minute.raw.slice(2)} minutes`
        : `minute ${cron.minute.values.join(', ')}`
  const hourText =
    cron.hour.raw === '*' ? 'every hour' : `hour ${cron.hour.values.map((hour) => `${String(hour).padStart(2, '0')}:00`).join(', ')}`

  const domWild = cron.dayOfMonth.raw === '*'
  const dowWild = cron.dayOfWeek.raw === '*'
  const dayNames = cron.dayOfWeek.values.map((value) => DAY_NAMES[value] ?? String(value)).join(' or ')
  const domNames = cron.dayOfMonth.values.map((value) => `day ${value}`).join(' or ')
  const dayText = domWild && dowWild ? ' every day' : domWild ? ` every ${dayNames}` : dowWild ? ` on ${domNames}` : ` on ${domNames} or ${dayNames}`

  const monthText = cron.month.raw === '*' ? '' : ` in ${cron.month.values.map((value) => MONTH_NAMES[value - 1] ?? String(value)).join(' or ')}`
  return `${minuteText} of ${hourText},${dayText}${monthText} (UTC)`
}
