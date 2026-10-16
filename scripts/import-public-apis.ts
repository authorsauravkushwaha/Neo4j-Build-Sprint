/**
 * Importer for the public-apis directory.
 *
 * `https://github.com/public-apis/public-apis` is a community-maintained table
 * (thousands of rows, one per API, grouped by category) with an MIT licence. This
 * project uses it because a learner who has just finished "HTTP basics" should be
 * able to point at something real and callable, not at another course.
 *
 * The importer is deliberately a *filter*, not a mirror:
 *
 *   * it keeps a curated set of categories that map onto the curriculum, and drops
 *     the rest, because a list of 2,000 APIs is not guidance;
 *   * it keeps the four facts the upstream table actually states — name, link,
 *     description, and the Auth / HTTPS / CORS columns — and nothing else, so we
 *     never invent a rate limit or a free tier we did not verify;
 *   * it stamps the source commit and the date the rows were read, so "last
 *     checked" is a measurement rather than a claim;
 *   * it refuses to run on a file whose table does not parse, instead of quietly
 *     producing an empty catalogue.
 *
 * Usage:
 *   npx tsx scripts/import-public-apis.ts --source /path/to/public-apis/README.md
 *     [--commit <sha>] [--date <ISO date>] [--out src/data/publicApis/catalog.generated.ts]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Categories kept, and the curriculum skills each one plausibly serves. */
const CATEGORY_SKILLS: Record<string, string[]> = {
  'Cloud Storage & File Sharing': ['skill:cloud-fundamentals', 'skill:api-design-and-integration'],
  'Continuous Integration': ['skill:ci-cd-pipelines', 'skill:version-control-git'],
  'Data Validation': ['skill:testing-and-debugging', 'skill:secure-coding'],
  Development: ['skill:api-design-and-integration', 'skill:programming-fundamentals', 'skill:testing-and-debugging'],
  Education: ['skill:programming-fundamentals'],
  Geocoding: ['skill:gis-and-spatial-analysis', 'skill:geodesy-and-coordinate-systems'],
  'Machine Learning': ['skill:machine-learning-fundamentals', 'skill:responsible-ai-practices'],
  'Open Data': ['skill:data-analysis-and-pandas', 'skill:databases-and-sql'],
  'Open Source Projects': ['skill:version-control-git', 'skill:software-design-patterns'],
  'Science & Math': ['skill:engineering-mathematics', 'skill:statistical-modelling'],
  Security: ['skill:cybersecurity-fundamentals', 'skill:network-security-and-monitoring'],
  'Test Data': ['skill:testing-and-debugging', 'skill:databases-and-sql'],
  'Text Analysis': ['skill:data-analysis-and-pandas', 'skill:machine-learning-fundamentals'],
  'URL Shorteners': ['skill:web-frontend-development', 'skill:api-design-and-integration'],
  Weather: ['skill:remote-sensing-and-imagery', 'skill:environmental-monitoring'],
  'Environment': ['skill:renewable-energy-systems', 'skill:energy-auditing'],
  Government: ['skill:gis-and-spatial-analysis', 'skill:open-data-and-civic-technology'],
  Jobs: ['skill:work-design-and-ergonomics'],
  Calendar: ['skill:api-design-and-integration'],
  'Documents & Productivity': ['skill:technical-writing-and-documentation'],
}

/** Extra keywords that add a skill even when the category did not. */
const KEYWORD_SKILLS: Array<{ pattern: RegExp; skills: string[] }> = [
  { pattern: /\b(rest|graphql|json|http|api|sdk)\b/i, skills: ['skill:api-design-and-integration'] },
  { pattern: /\b(sql|database|postgres|query)\b/i, skills: ['skill:databases-and-sql'] },
  { pattern: /\b(oauth|authentication|jwt|token)\b/i, skills: ['skill:applied-cryptography', 'skill:secure-coding'] },
  { pattern: /\b(docker|container|kubernetes|kubernetes?|deploy|hosting)\b/i, skills: ['skill:containers-and-docker', 'skill:cloud-fundamentals'] },
  { pattern: /\b(machine learning|neural|nlp|classification|embedding)\b/i, skills: ['skill:machine-learning-fundamentals'] },
  { pattern: /\b(geospat|gis|latitude|longitude|map|coordinate)\b/i, skills: ['skill:gis-and-spatial-analysis'] },
  { pattern: /\b(tls|certificate|vulnerab|threat|malware|phishing)\b/i, skills: ['skill:cybersecurity-fundamentals'] },
  { pattern: /\b(csv|statistic|dataset|analytics|time series)\b/i, skills: ['skill:data-analysis-and-pandas', 'skill:probability-statistics'] },
  { pattern: /\b(sensor|iot|telemetry|device)\b/i, skills: ['skill:embedded-iot-connectivity', 'skill:sensors-and-actuators'] },
  { pattern: /\b(energy|solar|climate|emission|renewable)\b/i, skills: ['skill:renewable-energy-systems'] },
  { pattern: /\b(robot|ros|robot arm)\b/i, skills: ['skill:robotics-ros2'] },
]

const KNOWN_SKILLS = new Set<string>()

interface Row {
  name: string
  url: string
  description: string
  auth: string
  https: boolean
  cors: string
  category: string
  skills: string[]
}

interface Options {
  source: string
  out: string
  commit: string
  date: string
  /** Cap per category, so the catalogue stays guidance instead of becoming a dump. */
  maxPerCategory: number
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    source: '',
    out: resolve(ROOT, 'src/data/publicApis/catalog.generated.ts'),
    commit: 'unknown',
    date: new Date().toISOString().slice(0, 10),
    maxPerCategory: 16,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--source' && value) options.source = resolve(process.cwd(), value)
    else if (flag === '--out' && value) options.out = resolve(ROOT, value)
    else if (flag === '--commit' && value) options.commit = value
    else if (flag === '--date' && value) options.date = value
    else if (flag === '--max-per-category' && value) options.maxPerCategory = Math.max(1, Number(value))
  }
  if (options.source === '') {
    throw new Error('Pass --source <path to the public-apis README.md>. The importer never fetches on its own.')
  }
  return options
}

/** Skill ids are checked against the curriculum so a typo cannot enter the catalogue. */
function loadKnownSkills(): void {
  const seed = readFileSync(resolve(ROOT, 'src/data/seed/knowledgeGraph.ts'), 'utf8')
  for (const match of seed.matchAll(/skill:[a-z0-9-]+/g)) KNOWN_SKILLS.add(match[0])
}

function parseRows(markdown: string): Row[] {
  const rows: Row[] = []
  let category = ''
  for (const line of markdown.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line)
    if (heading?.[1]) {
      category = heading[1].replace(/`/g, '').trim()
      continue
    }
    const row = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*`?([^|`]*)`?\s*\|\s*(Yes|No)\s*\|\s*(Yes|No|Unknown)\s*\|\s*$/.exec(line)
    if (!row) continue
    const [, name, url, description, auth, https, cors] = row
    rows.push({
      name: (name ?? '').trim(),
      url: (url ?? '').trim(),
      description: (description ?? '').replace(/\s+/g, ' ').trim(),
      auth: (auth ?? 'Unknown').trim() || 'Unknown',
      https: https === 'Yes',
      cors: cors ?? 'Unknown',
      category,
      skills: [],
    })
  }
  return rows
}

function skillIdsFor(row: Row): string[] {
  const skills = new Set<string>(CATEGORY_SKILLS[row.category] ?? [])
  const haystack = `${row.name} ${row.description}`
  for (const rule of KEYWORD_SKILLS) {
    if (rule.pattern.test(haystack)) for (const skill of rule.skills) skills.add(skill)
  }
  if (row.auth.toLowerCase() !== 'no') skills.add('skill:applied-cryptography')
  return [...skills].filter((skill) => KNOWN_SKILLS.has(skill)).sort()
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  loadKnownSkills()
  const markdown = readFileSync(options.source, 'utf8')
  const parsed = parseRows(markdown)
  if (parsed.length < 500) {
    throw new Error(`Only ${parsed.length} rows parsed from ${options.source}. The table format has probably changed; refusing to write a catalogue that looks complete.`)
  }

  let commit = options.commit
  if (commit === 'unknown') {
    try {
      commit = execFileSync('git', ['-C', dirname(options.source), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      commit = 'unknown'
    }
  }

  const ranked = parsed
    .filter((row) => row.category in CATEGORY_SKILLS && row.https)
    .map((row) => ({ ...row, skills: skillIdsFor(row) }))
    // An entry with no curriculum link would be trivia in a list that claims to be useful.
    .filter((row) => row.skills.length > 0)
    .filter((row, index, all) => all.findIndex((other) => other.name === row.name && other.url === row.url) === index)
    /*
     * Ordering, then a cap per category.
     *
     * A learner starting a project wants something they can call today: no key
     * first, then browser-callable. Within that, more curriculum links first, then
     * alphabetical order so the file is stable between runs. The cap keeps the
     * catalogue at "here are a dozen things to try" rather than "here are 900".
     */
    .sort((a, b) => {
      const score = (row: Row): [number, number, number, string] => [
        row.auth.toLowerCase() === 'no' ? 0 : 1,
        row.cors === 'Yes' ? 0 : 1,
        -row.skills.length,
        row.name.toLowerCase(),
      ]
      const left = score(a)
      const right = score(b)
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
      }
      return 0
    })

  const perCategory = new Map<string, number>()
  const kept = ranked
    .filter((row) => {
      const used = perCategory.get(row.category) ?? 0
      if (used >= options.maxPerCategory) return false
      perCategory.set(row.category, used + 1)
      return true
    })
    .sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category)))

  const categories = [...new Set(kept.map((row) => row.category))].sort()
  const body = kept
    .map(
      (row) =>
        `  {\n    name: ${JSON.stringify(row.name)},\n    url: ${JSON.stringify(row.url)},\n    description: ${JSON.stringify(row.description.slice(0, 200))},\n    category: ${JSON.stringify(row.category)},\n    auth: ${JSON.stringify(row.auth)},\n    cors: ${JSON.stringify(row.cors)},\n    skillIds: [${row.skills.map((skill) => JSON.stringify(skill)).join(', ')}],\n  },`,
    )
    .join('\n')

  const file = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:    https://github.com/public-apis/public-apis (MIT licence)
 * Source commit: ${commit}
 * Rows read: ${options.date}
 * Rows kept: ${kept.length} of ${parsed.length}, across ${categories.length} categories
 *
 * Refresh with:
 *   git clone --depth 1 https://github.com/public-apis/public-apis.git /tmp/public-apis
 *   npx tsx scripts/import-public-apis.ts --source /tmp/public-apis/README.md [--max-per-category 16]
 *
 * Kept fields are the ones the upstream table states. Nothing here is inferred:
 * "auth" is upstream's column, not a promise that the API is free forever, and
 * the date above is when these rows were read.
 */
export interface PublicApiEntry {
  name: string
  url: string
  description: string
  category: string
  /** Upstream's Auth column: "No", "apiKey", "OAuth", "X-Mashape-Key", … */
  auth: string
  cors: 'Yes' | 'No' | 'Unknown'
  /** Curriculum skills this API is a plausible practice target for. */
  skillIds: string[]
}

export const PUBLIC_API_SOURCE = {
  directory: 'public-apis/public-apis',
  licence: 'MIT',
  commit: ${JSON.stringify(commit)},
  rowsRead: ${JSON.stringify(options.date)},
  rowsTotal: ${parsed.length},
  rowsKept: ${kept.length},
  categories: [${categories.map((category) => JSON.stringify(category)).join(', ')}],
} as const

export const PUBLIC_API_CATALOG: readonly PublicApiEntry[] = [
${body}
]
`

  writeFileSync(options.out, file, 'utf8')
  process.stdout.write(
    `Wrote ${options.out}\n  ${kept.length} APIs kept from ${parsed.length} rows (${categories.length} categories), source commit ${commit}\n`,
  )
}

main()
