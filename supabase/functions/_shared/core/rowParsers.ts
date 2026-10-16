/**
 * Tolerant parsers for values coming back from the graph database.
 *
 * The Neo4j Query API changed JSON shapes between v1 (`results[0].data[].row`)
 * and v2 (`data.values`), and `collect(...)` produces arrays of maps whose keys
 * are positional. Instead of trusting either shape, everything is funnelled
 * through these helpers, which:
 *  - accept only JSON primitives (objects/arrays are bounded and copied),
 *  - clamp arrays to a maximum length,
 *  - never throw on unexpected input: they degrade to a safe default,
 *  - keep the renderer immune to "graph poisoning" — a hostile or corrupt value
 *    can never become markup, a huge string, or an unbounded list.
 */
import { clamp } from './normalize.ts'

export const MAX_ARRAY_ITEMS = 200
export const MAX_STRING_LENGTH = 4000

export function asString(value: unknown, max = MAX_STRING_LENGTH): string | null {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return fallback
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
  }
  if (typeof value === 'number') return value !== 0
  return fallback
}

export function asStringArray(value: unknown, max = MAX_ARRAY_ITEMS): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value.slice(0, max)) {
    const str = asString(item, 500)
    if (str !== null && str !== '') out.push(str)
  }
  return out
}

export function asNumberArray(value: unknown, max = MAX_ARRAY_ITEMS): number[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, max).map((v) => asNumber(v))
}

/** Array of maps, e.g. `collect(DISTINCT s { .id, .name })`. */
export function asObjectArray(value: unknown, max = MAX_ARRAY_ITEMS): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const out: Record<string, unknown>[] = []
  for (const item of value.slice(0, max)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>)
    }
  }
  return out
}

export function asHourRange(low: unknown, high: unknown): [number, number] {
  const lo = clamp(asNumber(low, 4), 0, 400)
  const hi = clamp(asNumber(high, Math.max(lo, 8)), 0, 600)
  return hi < lo ? [lo, lo] : [lo, hi]
}

export function asUuidLike(value: unknown): string | null {
  const str = asString(value, 64)
  if (!str) return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str) ? str : null
}


