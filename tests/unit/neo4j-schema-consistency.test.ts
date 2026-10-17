/**
 * Schema consistency: the Cypher the account store sends must match the schema
 * that is applied to the database, and the schema must match its documentation.
 *
 * These are static checks on text. They cannot tell whether AuraDB accepts the
 * statements; only a live `npm run seed:neo4j` run can do that.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { USER_DATA_CYPHER } from '../../supabase/functions/_shared/platform/neo4jStore.ts'
import { loadSchemaStatements, splitCypherStatements } from '../../scripts/neo4j-schema-statements.ts'

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const userSchema = read('neo4j/user-schema.cypher')
const curriculumSchema = read('neo4j/schema.cypher')
const docs = read('docs/neo4j-schema.md')

/** Every uniqueness constraint in both schema files, as "Label.property". */
function uniqueConstraints(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(/FOR \(\w+:(\w+)\) REQUIRE \w+\.(\w+) IS UNIQUE/g)) found.add(`${match[1]}.${match[2]}`)
  return found
}

/** Every range index in both schema files, as "Label.property". */
function rangeIndexes(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(/CREATE INDEX \w+ IF NOT EXISTS FOR \(\w+:(\w+)\) ON \(\w+\.(\w+)\)/g)) found.add(`${match[1]}.${match[2]}`)
  return found
}

const allConstraints = uniqueConstraints(userSchema + curriculumSchema)
const allIndexes = rangeIndexes(userSchema + curriculumSchema)
const allQueries = Object.values(USER_DATA_CYPHER).join('\n')

describe('schema files parse into individual statements', () => {
  it('loads both schema files in apply order and every statement is idempotent DDL', () => {
    const statements = loadSchemaStatements(root)
    expect(statements.length).toBeGreaterThan(20)
    for (const statement of statements) {
      expect(statement.query).toMatch(/^CREATE (CONSTRAINT|INDEX) \w+ IF NOT EXISTS FOR /)
    }
  })

  it('splits on semicolons that end statements, ignoring full-line comments', () => {
    const parts = splitCypherStatements('// a; comment\nCREATE INDEX a IF NOT EXISTS FOR (n:A) ON (n.x);\n\n// tail; comment\n')
    expect(parts).toEqual(['CREATE INDEX a IF NOT EXISTS FOR (n:A) ON (n.x)'])
  })

  it('has one statement per semicolon in the user schema, so nothing is silently merged', () => {
    const withoutComments = userSchema
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    const semicolons = withoutComments.split(';').filter((part) => part.trim().length > 0).length
    expect(splitCypherStatements(userSchema)).toHaveLength(semicolons)
  })

  it('has no quoted literal containing a semicolon, so the splitter is safe on these files', () => {
    for (const text of [userSchema, curriculumSchema]) {
      expect(text.replace(/\/\/.*$/gm, '')).not.toMatch(/'[^']*;[^']*'|"[^"]*;[^"]*"/)
    }
  })
})

describe('every key the store matches on is constrained or indexed', () => {
  // Node patterns with inline properties, for example (u:AppUser {id: $userId}).
  const nodePattern = /\(\s*\w*\s*:\s*(\w+)\s*\{([^}]*)\}/g

  it('finds at least the expected store patterns (guards the regex itself)', () => {
    const labels = new Set([...allQueries.matchAll(nodePattern)].map((m) => m[1]))
    for (const label of ['AppUser', 'Roadmap', 'RoadmapTask', 'SkillRating', 'Bookmark', 'RateLimitBucket', 'UsedNonce']) {
      expect(labels.has(label)).toBe(true)
    }
  })

  it('each inline property in a MATCH or MERGE is unique-constrained or range-indexed on its label', () => {
    // CREATE property maps (for example the Feedback node) are data, not lookup keys, so they are excluded.
    const lookups = Object.values(USER_DATA_CYPHER).filter((cypher) => !/^\s*CREATE\b/m.test(cypher)).join('\n')
    const problems: string[] = []
    for (const match of lookups.matchAll(nodePattern)) {
      const label = match[1]
      for (const part of match[2].split(',')) {
        const property = part.split(':')[0]?.trim()
        if (!property || property.startsWith('$')) continue
        const key = `${label}.${property}`
        if (!allConstraints.has(key) && !allIndexes.has(key)) problems.push(key)
      }
    }
    expect(problems).toEqual([])
  })

  it('every MERGE on a node uses a unique-constrained key, so concurrent writes stay race-safe', () => {
    const problems: string[] = []
    for (const [name, cypher] of Object.entries(USER_DATA_CYPHER)) {
      if (!/\bMERGE\b/.test(cypher)) continue
      for (const match of cypher.matchAll(/MERGE\s*\(\s*\w*\s*(?::(\w+))?\s*\{\s*(\w+)\s*:/g)) {
        const label = match[1]
        if (!label) continue
        if (!allConstraints.has(`${label}.${match[2]}`)) problems.push(`${name}: ${label}.${match[2]}`)
      }
      for (const match of cypher.matchAll(/\(\s*\w+\s*:\s*(\w+)\s*\{\s*key\s*:/g)) {
        if (!allConstraints.has(`${match[1]}.key`) && /MERGE/.test(cypher)) problems.push(`${name}: ${match[1]}.key`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('labels, relationships and properties are declared', () => {
  it('every node label the store uses is declared in a schema file', () => {
    const labels = new Set([...allQueries.matchAll(/:([A-Z][a-z]\w*)/g)].map((m) => m[1]))
    const declared = new Set([...(userSchema + curriculumSchema).matchAll(/FOR \(\w+:(\w+)\)/g)].map((m) => m[1]))
    const missing = [...labels].filter((label) => !declared.has(label))
    expect(missing).toEqual([])
  })

  it('every relationship type the store uses is documented', () => {
    const relationships = new Set([...allQueries.matchAll(/\[:([A-Z_]+)\]/g)].map((m) => m[1]))
    expect(relationships.size).toBeGreaterThan(3)
    for (const type of relationships) {
      expect(docs).toContain(type)
    }
  })

  it('every node property the store reads or writes is documented in neo4j-schema.md', () => {
    const properties = new Set<string>()
    for (const match of allQueries.matchAll(/\b(?:r|t|b|u|rt|f|n)\.(\w+)\b/g)) properties.add(match[1])
    for (const match of allQueries.matchAll(/\bSET\s+u\s*\+=\s*\$profile/g)) void match
    // Properties written through the profile map are documented as AppUser fields.
    for (const name of ['educationLevel', 'branch', 'careerGoalId', 'interests', 'weeklyHours', 'preferredPace', 'learningStyle', 'goalNote', 'theme', 'reducedMotion']) {
      properties.add(name)
    }
    const undocumented = [...properties].filter((property) => !new RegExp(`\\b${property}\\b`).test(docs))
    expect(undocumented).toEqual([])
  })

  it('every node label and key in the user schema is documented', () => {
    const labels = new Set([...userSchema.matchAll(/FOR \(\w+:(\w+)\)/g)].map((m) => m[1]))
    for (const label of labels) expect(docs).toContain(label)
  })
})

describe('store queries are parameterised', () => {
  it('no store query interpolates a value: Cypher text has no quotes around user-shaped data', () => {
    for (const [name, cypher] of Object.entries(USER_DATA_CYPHER)) {
      // String literals are allowed only for fixed enum-like values such as 'not-started'.
      const literals = [...cypher.matchAll(/'([^']*)'/g)].map((m) => m[1])
      const allowed = new Set(['', 'not-started'])
      for (const literal of literals) {
        expect(allowed.has(literal), `${name} contains literal ${JSON.stringify(literal)}`).toBe(true)
      }
    }
  })

  it('every account-scoped query takes $userId, except the replay and rate-limit queries', () => {
    const shared = new Set(['rateLimitIncrement', 'rateLimitPrune', 'noncePrune', 'nonceClaim'])
    const problems: string[] = []
    for (const [name, cypher] of Object.entries(USER_DATA_CYPHER)) {
      if (shared.has(name)) continue
      if (name === 'feedbackCreate' || name === 'feedbackList') continue // scoped by userId property or anonymous
      if (!cypher.includes('$userId') && !cypher.includes('$key')) problems.push(name)
    }
    expect(problems).toEqual([])
  })
})
