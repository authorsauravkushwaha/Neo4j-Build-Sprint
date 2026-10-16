/**
 * Reading the imported public-apis catalogue.
 *
 * The catalogue is data (`catalog.generated.ts`, refreshed by
 * `scripts/import-public-apis.ts`); this module is how the app asks it questions
 * and, just as importantly, how it describes itself.
 *
 * Three rules, each of which has already been broken by other "free API" lists:
 *
 *   1. **Match reasons are stated.** An API is offered because it serves a skill
 *      the learner is working on, and the reason says which — never "recommended
 *      for you".
 *   2. **The vintage travels with the row.** Every response carries the source
 *      commit and the date the rows were read. An undated link list rots silently.
 *   3. **Auth and CORS are upstream's columns, quoted.** We do not add "free" to an
 *      entry that upstream marks `apiKey`, because a key is a condition — and the
 *      scheme of the link is recorded next to it, because upstream's HTTPS column
 *      is occasionally "Yes" next to an `http://` link.
 */
import { PUBLIC_API_CATALOG, PUBLIC_API_SOURCE, type PublicApiEntry } from './catalog.generated.ts'

export type { PublicApiEntry }

export interface PublicApiMatch extends PublicApiEntry {
  /** Why this row is in front of you. */
  matchReason: string
  /** The skills in your route that this API exercises. */
  matchedSkillIds: string[]
}

export interface PublicApiQuery {
  skillIds?: string[]
  category?: string
  q?: string
  limit?: number
}

/** The catalogue's own description of itself, for the UI and for the run log. */
export function publicApiProvenance(): {
  directory: string
  licence: string
  commit: string
  rowsRead: string
  rowsTotal: number
  rowsKept: number
  plaintextLinks: number
  categories: readonly string[]
  limitations: string[]
} {
  return {
    ...PUBLIC_API_SOURCE,
    limitations: [
      PUBLIC_API_SOURCE.plaintextLinks > 0
        ? `The link scheme is recorded separately from upstream's HTTPS column: ${PUBLIC_API_SOURCE.plaintextLinks} of the ${PUBLIC_API_SOURCE.rowsKept} rows say HTTPS "Yes" and link to a plaintext http:// page anyway. Those rows are kept, marked \`linkScheme: "http"\` and ranked last — they are never presented as ready to call.`
        : 'Every kept row links to an https:// page; the link scheme is recorded separately from upstream\'s HTTPS column, which is not the same claim.',
      'Imported, not live: the rows are a snapshot of the upstream directory at the commit above, refreshed by a script rather than by a background job.',
      'Both columns are upstream\'s: an entry marked apiKey needs a key, and CORS "Unknown" means the directory does not say — test it before building a browser app around it.',
      'Free means free at import time. Rate limits, quotas and terms change without notice, and nobody here re-reads them for you.',
      'A related API is a practice target, not a lesson. It appears next to a skill because calling it exercises that skill, not because it teaches it.',
    ],
  }
}

export function listPublicApis(query: PublicApiQuery = {}): PublicApiMatch[] {
  const wanted = new Set(query.skillIds ?? [])
  const needle = (query.q ?? '').trim().toLowerCase()
  const matches = PUBLIC_API_CATALOG.filter((entry) => {
    if (query.category && entry.category !== query.category) return false
    if (wanted.size > 0 && !entry.skillIds.some((skillId) => wanted.has(skillId))) return false
    if (needle !== '' && !`${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(needle)) return false
    return true
  }).map((entry) => {
    const matchedSkillIds = wanted.size > 0 ? entry.skillIds.filter((skillId) => wanted.has(skillId)) : []
    return {
      ...entry,
      matchedSkillIds,
      matchReason:
        matchedSkillIds.length > 0
          ? `Calling this exercises ${matchedSkillIds.length} skill(s) in your route.`
          : 'Listed in the imported directory under a category that matches engineering practice.',
    }
  })

  /*
   * Callable-today first, then alphabetical, so the same query always returns the
   * same order — a list that reshuffles between visits makes it impossible to tell
   * whether anything changed.
   *
   * The three components are deliberately far apart (auth wins by 30, CORS by 5,
   * link scheme by 1) and added, not multiplied, so no later tiebreak can silently
   * outrank an earlier one. A key is a condition; an unknown CORS is a caveat; a
   * plaintext link is the smallest of the three, and it still sorts after a secure
   * link rather than disappearing.
   */
  const rank = (entry: PublicApiMatch): number => {
    const auth = entry.auth.toLowerCase()
    return (
      (auth === 'no' ? 0 : auth === 'oauth' ? 30 : 60) +
      (entry.cors === 'Yes' ? 0 : 5) +
      (entry.linkScheme === 'https' ? 0 : 1)
    )
  }
  return matches
    .sort((a, b) => {
      const difference = rank(a) - rank(b)
      return difference !== 0 ? difference : a.name.localeCompare(b.name)
    })
    .slice(0, query.limit ?? 12)
}

export function publicApiCategories(): string[] {
  return [...PUBLIC_API_SOURCE.categories]
}

export function publicApisForSkill(skillId: string, limit = 6): PublicApiMatch[] {
  return listPublicApis({ skillIds: [skillId], limit })
}
