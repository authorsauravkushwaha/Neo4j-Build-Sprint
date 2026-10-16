/**
 * Text normalisation used for search, matching and identifier handling.
 * Deliberately dependency-free and deterministic so tests are stable.
 */

/** Lower-cases, removes diacritics, collapses whitespace and trims punctuation edges. */
export function normalizeText(input: string): string {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenize(input: string, maxTokens = 24): string[] {
  const normalized = normalizeText(input)
  if (!normalized) return []
  return normalized.split(' ').filter(Boolean).slice(0, maxTokens)
}

/** URL/seed-friendly slug. Never used as a security boundary, only for display. */
export function slugify(input: string, maxLength = 60): string {
  return normalizeText(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
}

/** Cheap token-overlap similarity (Jaccard). Used for "did you mean" suggestions. */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let intersection = 0
  for (const token of ta) if (tb.has(token)) intersection++
  return intersection / (ta.size + tb.size - intersection)
}

/**
 * Bounded Levenshtein distance. Both inputs are truncated first, so the O(n*m)
 * table can never be used as a CPU exhaustion vector (ReDoS-adjacent defence).
 */
export function levenshtein(a: string, b: string, maxLength = 64): number {
  const s = a.slice(0, maxLength)
  const t = b.slice(0, maxLength)
  if (s === t) return 0
  if (s.length === 0) return t.length
  if (t.length === 0) return s.length

  let previous = new Array<number>(t.length + 1)
  let current = new Array<number>(t.length + 1)
  for (let j = 0; j <= t.length; j++) previous[j] = j

  for (let i = 1; i <= s.length; i++) {
    current[0] = i
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[t.length]
}

/**
 * Scores how well a candidate matches a search query without any regex, so a
 * hostile query string cannot cause backtracking.
 */
export function searchMatchScore(query: string, candidate: string): number {
  const q = normalizeText(query)
  const c = normalizeText(candidate)
  if (!q) return 0
  if (c === q) return 100
  if (c.startsWith(q)) return 88
  if (c.includes(` ${q}`)) return 76
  if (c.includes(q)) return 62
  const qTokens = tokenize(q)
  const cTokens = new Set(tokenize(c))
  if (qTokens.length > 1) {
    let hit = 0
    for (const t of qTokens) if (cTokens.has(t)) hit++
    if (hit === qTokens.length) return 58
    if (hit > 0) return 30 + (hit / qTokens.length) * 20
  }
  const distance = levenshtein(q, c)
  if (distance <= 2 && q.length >= 4) return 34
  return 0
}

/** Stable comparison so list ordering is deterministic across runs/devices. */
export function compareIds(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function unique<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items))
}

export function uniqueBy<T, K>(items: readonly T[], key: (item: T) => K): T[] {
  const seen = new Set<K>()
  const out: T[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Resource-URL gate used before a URL is stored, rendered or sent to the model.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}


