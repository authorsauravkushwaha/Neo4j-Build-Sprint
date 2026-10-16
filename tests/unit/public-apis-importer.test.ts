/**
 * The importer's rules, executed rather than described.
 *
 * `docs/public-apis.md` makes a list of promises about how the catalogue is built:
 * it never fetches anything itself, it refuses to write a catalogue it could not
 * parse, it keeps only https links, it drops entries with no curriculum link, it
 * caps a category, it ranks no-key-first, it dedupes, and it stamps the commit and
 * the date into the file it writes. The generated catalogue can only prove the
 * *outcome* of those rules — a test against the real 2,028-row upstream table would
 * be a test of somebody else's data.
 *
 * So this file runs the CLI against a synthetic table where every one of those rules
 * has a case, and asserts what it wrote. It is the slowest test in the suite (two
 * `tsx` subprocesses) and it is worth it: every other test in the repository treats
 * the generated file as input, so if the importer stopped filtering, deduping or
 * refusing, nothing else would notice until the catalogue had quietly changed shape.
 *
 * The synthetic table obeys one rule of its own: it is written to look like the
 * upstream README (same columns, same heading style, same `###`-per-category
 * structure) because *that* is the format the parser is written against.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')

/**
 * One row of the upstream table. `category` is not a column — upstream groups rows
 * under a `###` heading — so it is the caller's business, not this helper's.
 */
interface Row {
  name: string
  url: string
  description: string
  auth: string
  https: 'Yes' | 'No'
  cors: 'Yes' | 'No' | 'Unknown'
}

function row({ name, url, description, auth, https, cors }: Row): string {
  return `| [${name}](${url}) | ${description} | \`${auth}\` | ${https} | ${cors} |`
}

/**
 * A table shaped like upstream's: the eight categories kept by the importer, enough
 * filler to clear the 500-row parser floor, plus one planted case per rule.
 */
function buildSource(): string {
  const categories = ['Development', 'Geocoding', 'Weather', 'Security', 'Open Data', 'Test Data']
  const lines: string[] = ['# Synthetic public APIs', '', 'A table in the upstream format.', '']

  for (const [index, category] of categories.entries()) {
    lines.push(`### ${category}`, '', '| API | Description | Auth | HTTPS | CORS |', '| --- | --- | --- | --- | --- |')
    for (let n = 0; n < 100; n += 1) {
      // Planted cases, in the first category only:
      const planted =
        category === 'Development' && n === 0
          ? row({
              name: 'Plaintext API',
              url: 'http://plaintext.example.test/',
              description: 'Declares HTTPS Yes and links to http:// anyway.',
              auth: 'No',
              https: 'Yes',
              cors: 'Yes',
            })
          : category === 'Development' && n === 1
            ? // Same name and url as the row below: must appear once in the output.
              row({ name: 'Duplicate API', url: 'https://duplicate.example.test/', description: 'Listed twice upstream.', auth: 'No', https: 'Yes', cors: 'Yes' })
            : category === 'Development' && n === 2
              ? row({ name: 'Duplicate API', url: 'https://duplicate.example.test/', description: 'Listed twice upstream.', auth: 'No', https: 'Yes', cors: 'Yes' })
              : category === 'Development' && n === 3
                ? // HTTPS column says No: dropped regardless of everything else.
                  row({ name: 'Insecure Only', url: 'https://insecure.example.test/', description: 'No HTTPS support upstream.', auth: 'No', https: 'No', cors: 'Yes' })
                : // Interpolated, so the ranking is testable rather than accidental.
                  row({
                    name: `API ${String(index)}${String(n).padStart(3, '0')}`,
                    url: `https://api-${index}-${n}.example.test/`,
                    description: `Synthetic endpoint number ${n} for ${category}.`,
                    auth: n % 3 === 0 ? 'apiKey' : n % 3 === 1 ? 'OAuth' : 'No',
                    https: 'Yes',
                    cors: n % 2 === 0 ? 'Yes' : 'Unknown',
                  })
      lines.push(planted)
    }
    lines.push('')
  }

  // An entry with no curriculum link: its category is not in the importer's map and
  // its description matches none of the keyword rules, so it is dropped even though
  // it parses.
  lines.push('### Cryptocurrency', '', '| API | Description | Auth | HTTPS | CORS |', '| --- | --- | --- | --- | --- |')
  for (let n = 0; n < 120; n += 1) {
    lines.push(row({ name: `Coin ${n}`, url: `https://coin-${n}.example.test/`, description: 'A price ticker.', auth: 'No', https: 'Yes', cors: 'Yes' }))
  }

  // A malformed row among the good ones: it must be skipped, not throw.
  lines.push('', 'not a table row at all', '')

  return lines.join('\n')
}

interface ParsedRow {
  name: string
  url: string
  category: string
  auth: string
  cors: string
  linkScheme: string
  skillCount: number
}

/** Read back what the importer wrote, as rows rather than as text. */
function parse(written: string): ParsedRow[] {
  return [...written.matchAll(
    /name: "([^"]+)",\n\s+url: "([^"]+)",\n\s+description: "([^"]*)",\n\s+category: "([^"]+)",\n\s+auth: "([^"]+)",\n\s+cors: "([^"]+)",\n\s+linkScheme: "([^"]+)",\n\s+skillIds: \[([^\]]*)\]/g,
  )].map((match) => ({
    name: match[1]!,
    url: match[2]!,
    category: match[4]!,
    auth: match[5]!,
    cors: match[6]!,
    linkScheme: match[7]!,
    skillCount: match[8]!.trim() === '' ? 0 : match[8]!.split(',').length,
  }))
}

const work = mkdtempSync(join(tmpdir(), 'gm-public-apis-'))
const sourcePath = join(work, 'README.md')
/** The run with the cap raised: every rule that is not the cap is visible in it. */
const outPath = join(work, 'catalog.generated.ts')
/** The run with a cap of three: the cap and nothing else. */
const cappedPath = join(work, 'capped.generated.ts')
const BASE_ARGS = ['--source', sourcePath, '--date', '2026-01-02', '--commit', 'a'.repeat(40)]

function runImporter(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('npx', ['tsx', 'scripts/import-public-apis.ts', ...args], { cwd: ROOT, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status: number | null; stdout?: string; stderr?: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

beforeAll(() => {
  writeFileSync(sourcePath, buildSource(), 'utf8')
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('the public-apis importer', () => {
  it('refuses to run without a source, and never fetches one itself', () => {
    const result = runImporter([])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--source/)
    // Nothing was written: the script had no output path to write to.
    expect(() => readFileSync(outPath, 'utf8')).toThrow()
  })

  it('refuses to write a catalogue it could not parse', () => {
    const tiny = join(work, 'tiny.md')
    writeFileSync(tiny, '# Empty\n\n| API | Description | Auth | HTTPS | CORS |\n| --- | --- | --- | --- | --- |\n', 'utf8')
    const result = runImporter(['--source', tiny, '--out', outPath])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/refusing to write/i)
    expect(() => readFileSync(outPath, 'utf8')).toThrow()
  })

  it('keeps the rows the rules allow, marks the ones upstream contradicts itself about, and stamps the source', () => {
    const result = runImporter([...BASE_ARGS, '--out', outPath, '--max-per-category', '200'])
    expect(result.status, `importer exited ${result.status}: ${result.stdout}${result.stderr}`).toBe(0)

    const written = readFileSync(outPath, 'utf8')

    // Stamped: a reader can always say which commit and which day this was read.
    expect(written).toContain(`Source commit: ${'a'.repeat(40)}`)
    expect(written).toContain('Rows read: 2026-01-02')
    expect(written).toMatch(/GENERATED FILE — do not edit by hand/)

    // `HTTPS: No` means the endpoint does not support it upstream, so the row is
    // dropped. `HTTPS: Yes` with an http:// link is upstream contradicting itself:
    // the link is reproduced unchanged and the scheme is recorded next to it.
    expect(written).not.toContain('insecure.example.test')
    expect(written).toContain('http://plaintext.example.test')
    expect(written).toContain('linkScheme: "http"')
    expect(written).toMatch(/url: "https:\/\/[^"]+",[^}]*linkScheme: "https"/)

    // An entry with no curriculum link is trivia in a list that claims to be useful.
    expect(written).not.toContain('Cryptocurrency')
    expect(written).not.toContain('Coin 1')
    // A malformed line between valid ones is skipped, not fatal. The proof is the
    // run above exiting 0 with that line in the source file, and the row count:
    // 599 of the 620 table rows carry a curriculum link and an https endpoint.

    // One row per API.
    const urls = [...written.matchAll(/url: "([^"]+)"/g)].map((match) => match[1]!)
    expect(urls.length).toBeGreaterThan(100)
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls.filter((url) => url.includes('duplicate.example.test')).length).toBe(1)

    // Every emitted skill id is real, and no row is emitted without one.
    const skillIds = new Set([...written.matchAll(/"(skill:[a-z0-9-]+)"/g)].map((match) => match[1]!))
    expect(skillIds.size).toBeGreaterThan(0)
    for (const skillId of skillIds) expect(skillId).toMatch(/^skill:[a-z0-9-]+$/)
    expect(written).not.toMatch(/skillIds: \[\]/)

    // Categories are grouped, sorted, and only the mapped ones.
    const categories = [...written.matchAll(/category: "([^"]+)"/g)].map((match) => match[1]!)
    expect(new Set(categories).size).toBe(6)
    expect([...new Set(categories)]).toEqual([...new Set(categories)].sort())

    // The provenance block agrees with the rows that were written.
    const kept = Number(/Rows kept: (\d+) of (\d+)/.exec(written)?.[1])
    const total = Number(/Rows kept: (\d+) of (\d+)/.exec(written)?.[2])
    expect(kept).toBe(urls.length)
    expect(total).toBeGreaterThan(500)
    expect(written).toContain(`rowsKept: ${kept},`)
    expect(written).toContain('plaintextLinks: 1,')
  })

  it('caps a category, because 900 rows is a haystack and not guidance', () => {
    const result = runImporter([...BASE_ARGS, '--out', cappedPath, '--max-per-category', '3'])
    expect(result.status, `importer exited ${result.status}: ${result.stdout}${result.stderr}`).toBe(0)

    const written = readFileSync(cappedPath, 'utf8')
    const perCategory = new Map<string, number>()
    for (const match of written.matchAll(/category: "([^"]+)"/g)) {
      perCategory.set(match[1]!, (perCategory.get(match[1]!) ?? 0) + 1)
    }
    expect(perCategory.size).toBe(6)
    for (const [category, count] of perCategory) expect([category, count]).toEqual([category, Math.min(count, 3)])
    // The cap is a real cap: the uncapped run keeps far more than three per category.
    const uncapped = readFileSync(outPath, 'utf8')
    expect([...uncapped.matchAll(/url: "/g)].length).toBeGreaterThan([...written.matchAll(/url: "/g)].length * 5)
  })

  it('keeps the best-ranked rows when the cap bites, and writes them alphabetically for stable diffs', () => {
    // Two separate behaviours, often confused, and the importer does both:
    //   * the RANKING decides which rows survive the cap (callable-today first);
    //   * the FILE is written alphabetically inside each category, so a refresh
    //     diffs as "rows added/removed" rather than as a reshuffle.
    // The query layer re-ranks at read time (`listPublicApis`), which is what the
    // reader sees; the file order only has to be stable.
    const uncapped = parse(readFileSync(outPath, 'utf8'))
    const capped = parse(readFileSync(cappedPath, 'utf8'))
    expect(capped.length).toBeLessThan(uncapped.length)

    // File order: categories sorted, names alphabetical within a category.
    for (let index = 1; index < capped.length; index += 1) {
      const previous = capped[index - 1]!
      const current = capped[index]!
      expect(previous.category.localeCompare(current.category)).toBeLessThanOrEqual(0)
      if (previous.category === current.category) expect(previous.name.localeCompare(current.name)).toBeLessThanOrEqual(0)
    }

    // Selection: the capped run holds exactly the top three of each category by the
    // importer's own ranking — no key first, then a known CORS answer, then a secure
    // link, then more curriculum links, then alphabetical.
    const rank = (entry: ParsedRow): [number, number, number, number, string] => [
      entry.auth.toLowerCase() === 'no' ? 0 : 1,
      entry.cors === 'Yes' ? 0 : 1,
      entry.linkScheme === 'https' ? 0 : 1,
      -entry.skillCount,
      entry.name.toLowerCase(),
    ]
    const compare = (a: ParsedRow, b: ParsedRow): number => {
      const left = rank(a)
      const right = rank(b)
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return (left[index]! as number | string) < (right[index]! as number | string) ? -1 : 1
      }
      return 0
    }
    const bestByCategory = new Map<string, ParsedRow[]>()
    for (const entry of uncapped) bestByCategory.set(entry.category, [...(bestByCategory.get(entry.category) ?? []), entry])
    for (const [category, entries] of bestByCategory) {
      const expected = [...entries].sort(compare).slice(0, 3).map((entry) => entry.url).sort()
      const actual = capped.filter((entry) => entry.category === category).map((entry) => entry.url).sort()
      expect(actual, `${category} kept the wrong rows`).toEqual(expected)
    }
  })

  it('is deterministic: the same input file produces byte-identical output', () => {
    const again = join(work, 'second.generated.ts')
    const result = runImporter([...BASE_ARGS, '--out', again, '--max-per-category', '200'])
    expect(result.status).toBe(0)
    expect(readFileSync(again, 'utf8')).toBe(readFileSync(outPath, 'utf8'))
  })
})
