/**
 * The imported public-API catalogue.
 *
 * This data is *quoted*, not authored: every row comes from somebody else's table,
 * and the whole value of quoting it is that we can say what we did not touch. That
 * makes the interesting assertions here negative ones — nothing was invented, nothing
 * was rewritten, nothing was dropped without being counted. A row that acquires a
 * field nobody publishes, or a skill id that is not in the curriculum, or a link
 * whose scheme disagrees with the row's own claim about the scheme, is a bug even
 * though nothing throws.
 *
 * The catalogue is generated, so these also stand in for "the importer still works":
 * a hand edit to the generated file fails here, and so does an importer change that
 * quietly stops capping or stamping the source.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PUBLIC_API_CATALOG, PUBLIC_API_SOURCE, type PublicApiEntry } from '@/data/publicApis/catalog.generated.ts'
import { listPublicApis, publicApiCategories, publicApiProvenance, publicApisForSkill } from '@/data/publicApis/index.ts'

/** The skills the curriculum actually defines, read from the seed rather than restated. */
function curriculumSkills(): Set<string> {
  const seed = readFileSync(resolve(process.cwd(), 'src/data/seed/knowledgeGraph.ts'), 'utf8')
  return new Set([...seed.matchAll(/skill:[a-z0-9-]+/g)].map((match) => match[0]))
}

const CATALOGUE = PUBLIC_API_CATALOG as readonly PublicApiEntry[]
const FIELDS = ['auth', 'category', 'cors', 'description', 'linkScheme', 'name', 'skillIds', 'url']

describe('the generated catalogue', () => {
  it('is not empty, and not a mirror of a 2,000-row directory', () => {
    // The importer refuses to write fewer than 500 *parsed* rows; this is the other
    // end of the same rule, that what gets kept stays readable.
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(100)
    expect(CATALOGUE.length).toBeLessThanOrEqual(400)
    expect(PUBLIC_API_SOURCE.rowsTotal).toBeGreaterThanOrEqual(500)
    expect(PUBLIC_API_SOURCE.rowsKept).toBe(CATALOGUE.length)
  })

  it('stamps which commit and which day the rows came from', () => {
    // "Last checked" has to be a measurement. An undated link list rots in silence.
    expect(PUBLIC_API_SOURCE.directory).toBe('public-apis/public-apis')
    expect(PUBLIC_API_SOURCE.licence).toBe('MIT')
    expect(PUBLIC_API_SOURCE.commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(PUBLIC_API_SOURCE.rowsRead).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(new Date(`${PUBLIC_API_SOURCE.rowsRead}T00:00:00Z`).toString()).not.toBe('Invalid Date')
  })

  it('keeps only the fields the upstream table states, and no others', () => {
    for (const entry of CATALOGUE) {
      expect(Object.keys(entry).sort()).toEqual(FIELDS)
      expect(entry.name.trim()).not.toBe('')
      expect(entry.description.trim()).not.toBe('')
      expect(entry.category.trim()).not.toBe('')
      expect(entry.auth.trim()).not.toBe('')
      expect(entry.url).toMatch(/^https?:\/\//)
      expect(['https', 'http']).toContain(entry.linkScheme)
      expect(['Yes', 'No', 'Unknown']).toContain(entry.cors)
    }
  })

  it('truncates a description rather than shipping a paragraph', () => {
    // 200 characters is the cap in the importer; the longest description in the
    // current import is well under it, so this fails only if the cap is removed.
    expect(Math.max(...CATALOGUE.map((entry) => entry.description.length))).toBeLessThanOrEqual(200)
    for (const entry of CATALOGUE) expect(entry.description).not.toContain('\n')
  })

  it('records the link scheme instead of trusting the HTTPS column', () => {
    // Upstream says HTTPS "Yes" and links to http:// on a few rows. Rewriting the
    // URL would invent a link; dropping the row would hide one. So the scheme is
    // recorded, and this asserts the record matches the URL it describes.
    const plaintext = CATALOGUE.filter((entry) => entry.linkScheme === 'http')
    expect(plaintext.length).toBe(PUBLIC_API_SOURCE.plaintextLinks)
    for (const entry of CATALOGUE) {
      expect(entry.linkScheme).toBe(entry.url.startsWith('https://') ? 'https' : 'http')
    }
  })

  it('resolves every skill id against the curriculum', () => {
    const known = curriculumSkills()
    expect(known.size).toBeGreaterThan(50)
    const unknown = new Set<string>()
    for (const entry of CATALOGUE) {
      expect(entry.skillIds.length).toBeGreaterThan(0)
      expect(new Set(entry.skillIds).size).toBe(entry.skillIds.length)
      for (const skillId of entry.skillIds) if (!known.has(skillId)) unknown.add(skillId)
    }
    expect([...unknown]).toEqual([])
  })

  it('has one row per API, at most 16 per category, in sorted categories', () => {
    const pairs = CATALOGUE.map((entry) => `${entry.name}\u0000${entry.url}`)
    expect(new Set(pairs).size).toBe(pairs.length)

    const perCategory = new Map<string, number>()
    for (const entry of CATALOGUE) perCategory.set(entry.category, (perCategory.get(entry.category) ?? 0) + 1)
    for (const [category, count] of perCategory) expect([category, count]).toEqual([category, Math.min(count, 16)])

    const categories = PUBLIC_API_SOURCE.categories
    expect([...categories]).toEqual([...categories].sort())
    expect(new Set(categories).size).toBe(categories.length)
    expect([...perCategory.keys()].sort()).toEqual([...categories])
  })
})

describe('the query layer', () => {
  it('is deterministic for the same question', () => {
    expect(listPublicApis({ q: 'weather' })).toEqual(listPublicApis({ q: 'weather' }))
    expect(listPublicApis().map((entry) => entry.name)).toEqual(listPublicApis().map((entry) => entry.name))
  })

  it('returns a page, not the whole catalogue', () => {
    expect(listPublicApis()).toHaveLength(12)
    expect(listPublicApis({ limit: 3 })).toHaveLength(3)
    expect(listPublicApis({ limit: 1 })).toHaveLength(1)
    expect(listPublicApis({ limit: 10_000 }).length).toBeLessThanOrEqual(CATALOGUE.length)
  })

  it('never ranks a plaintext link above a secure one of the same kind', () => {
    // Two rows in the current import have an http:// link. They are listed; they are
    // just never offered first. The link scheme is the *smallest* of the three
    // tiebreaks, so the invariant holds inside a bucket, not across the whole list:
    // a no-key plaintext link still outranks anything that needs a key.
    expect(listPublicApis().some((entry) => entry.linkScheme === 'http')).toBe(false)

    const buckets = new Map<string, string[]>()
    for (const entry of listPublicApis({ limit: CATALOGUE.length })) {
      // Same auth tier, same CORS answer, same number of curriculum links: the only
      // thing the ranker may still be separating these by is the link scheme.
      const key = `${entry.auth.toLowerCase()}|${entry.cors}|${entry.skillIds.length}`
      buckets.set(key, [...(buckets.get(key) ?? []), entry.linkScheme])
    }

    let bucketsWithPlaintext = 0
    for (const schemes of buckets.values()) {
      const firstPlaintext = schemes.indexOf('http')
      if (firstPlaintext === -1) continue
      bucketsWithPlaintext += 1
      // Once a plaintext link appears in a bucket, no secure link follows it in it.
      expect(schemes.slice(firstPlaintext)).not.toContain('https')
    }
    expect(bucketsWithPlaintext).toBeGreaterThan(0)
  })

  it('ranks no-key before key, and known CORS before unknown', () => {
    const all = listPublicApis({ limit: CATALOGUE.length })
    const tier = (entry: { auth: string }): number => {
      const auth = entry.auth.toLowerCase()
      return auth === 'no' ? 0 : auth === 'oauth' ? 1 : 2
    }
    for (let index = 1; index < all.length; index += 1) {
      expect(tier(all[index]!) >= tier(all[index - 1]!)).toBe(true)
    }
    const sameTier = all.filter((entry) => tier(entry) === 0)
    const corsRanks = sameTier.map((entry) => (entry.cors === 'Yes' ? 0 : 1))
    expect([...corsRanks]).toEqual([...corsRanks].sort((a, b) => a - b))
  })

  it('filters by skill, and says which skill matched', () => {
    const matches = listPublicApis({ skillIds: ['skill:api-design-and-integration'], limit: 20 })
    expect(matches.length).toBeGreaterThan(0)
    for (const match of matches) {
      expect(match.skillIds).toContain('skill:api-design-and-integration')
      expect(match.matchedSkillIds).toEqual(['skill:api-design-and-integration'])
      expect(match.matchReason).toBe('Calling this exercises 1 skill(s) in your route.')
    }
    // A skill nobody in the catalogue serves is an empty answer, not an error and
    // not a fallback to everything.
    expect(listPublicApis({ skillIds: ['skill:not-a-real-skill'] })).toEqual([])
  })

  it('matches a reason to the request instead of recommending', () => {
    const matches = listPublicApis({ skillIds: ['skill:databases-and-sql', 'skill:testing-and-debugging'], limit: 20 })
    for (const match of matches) {
      expect(match.matchedSkillIds.length).toBeGreaterThan(0)
      for (const skillId of match.matchedSkillIds) {
        expect(['skill:databases-and-sql', 'skill:testing-and-debugging']).toContain(skillId)
        expect(match.skillIds).toContain(skillId)
      }
      expect(match.matchReason).not.toMatch(/recommend|for you|best|popular/i)
    }
  })

  it('searches the category too, and filters by category', () => {
    const byWord = listPublicApis({ q: 'machine learning', limit: 20 })
    expect(byWord.length).toBeGreaterThan(0)
    for (const entry of byWord) {
      const haystack = `${entry.name} ${entry.description} ${entry.category}`.toLowerCase()
      expect(haystack).toContain('machine learning')
    }
    const byCategory = listPublicApis({ category: 'Weather', limit: 20 })
    expect(byCategory.length).toBeGreaterThan(0)
    for (const entry of byCategory) expect(entry.category).toBe('Weather')
  })

  it('returns category and provenance objects that cannot be edited in place', () => {
    const categories = publicApiCategories()
    categories.push('Invented')
    expect(publicApiCategories()).not.toContain('Invented')

    const provenance = publicApiProvenance()
    expect(provenance.categories).toEqual([...PUBLIC_API_SOURCE.categories])
    expect(provenance.rowsKept).toBe(CATALOGUE.length)
    expect(provenance.plaintextLinks).toBe(PUBLIC_API_SOURCE.plaintextLinks)
  })

  it('states its limits in the same object it reports its provenance in', () => {
    // Four fixed caveats plus the link-scheme one: an imported snapshot, columns that
    // are upstream's, "free" meaning free at import time, and a practice target not
    // being a lesson. If one is dropped, the UI drops it too.
    const { limitations } = publicApiProvenance()
    expect(limitations.length).toBeGreaterThanOrEqual(5)
    expect(limitations.join(' ')).toMatch(/Imported, not live/)
    expect(limitations.join(' ')).toMatch(/apiKey/)
    expect(limitations.join(' ')).toMatch(/Free means free at import time/)
    expect(limitations.join(' ')).toMatch(/practice target/)
    expect(limitations.join(' ')).toMatch(/link scheme/)
  })

  it('serves a skill its own short list', () => {
    const forSkill = publicApisForSkill('skill:gis-and-spatial-analysis')
    expect(forSkill.length).toBeGreaterThan(0)
    expect(forSkill.length).toBeLessThanOrEqual(6)
    for (const entry of forSkill) expect(entry.skillIds).toContain('skill:gis-and-spatial-analysis')
  })
})
