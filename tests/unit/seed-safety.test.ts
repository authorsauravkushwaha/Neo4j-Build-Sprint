// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const seed = JSON.parse(readFileSync(resolve(root, 'neo4j/seed.parameters.json'), 'utf8')) as {
  statements: Array<{ tag: string; query: string }>
}

describe('Neo4j seed defaults are repeatable and non-overwriting', () => {
  it('MERGEs nodes and creates seed properties only for newly created nodes', () => {
    const nodeQueries = seed.statements.filter((statement) => statement.tag.startsWith('nodes:'))
    expect(nodeQueries.length).toBeGreaterThan(0)
    for (const statement of nodeQueries) {
      expect(statement.query).toMatch(/MERGE \(n:[A-Za-z]+ \{id: row\.id\}\)/)
      expect(statement.query).toContain('ON CREATE SET')
      expect(statement.query).not.toContain('ON MATCH SET')
    }
  })

  it('does not overwrite existing relationship properties in default seed data', () => {
    const edgeQueries = seed.statements.filter((statement) => statement.tag.startsWith('edges:'))
    expect(edgeQueries.length).toBeGreaterThan(0)
    for (const statement of edgeQueries) expect(statement.query).not.toContain('ON MATCH SET')
  })

  it('makes matched-record overwrites opt-in through an explicit CLI flag', () => {
    const loader = readFileSync(resolve(root, 'scripts/seed-neo4j.ts'), 'utf8')
    expect(loader).toContain("flags.has('update-existing')")
    expect(loader).toContain("statement.query.replaceAll('ON CREATE SET', 'SET')")
    expect(loader).toContain('OVERWRITE MODE')
  })
})
