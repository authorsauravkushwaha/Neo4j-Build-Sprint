/**
 * Loads the Neo4j schema files as individual statements, in apply order.
 *
 * Pure: no network, no environment. `scripts/seed-neo4j.ts` applies these before
 * the curriculum seed, and the schema-consistency test imports them.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface SchemaStatement {
  tag: string
  query: string
  parameters: { rows: unknown[] }
}

/** Schema files, in apply order. Both are idempotent (IF NOT EXISTS). */
export const SCHEMA_FILES = ['schema.cypher', 'user-schema.cypher'] as const

/**
 * Splits a .cypher file into statements. Full-line `//` comments are removed
 * first, so a semicolon inside a comment cannot split a statement. The schema
 * files contain no string literals with semicolons (checked by the test suite).
 */
export function splitCypherStatements(text: string): string[] {
  const code = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  return code
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

export function loadSchemaStatements(root: string): SchemaStatement[] {
  return SCHEMA_FILES.flatMap((file) =>
    splitCypherStatements(readFileSync(resolve(root, 'neo4j', file), 'utf8')).map((query, index) => ({
      tag: `schema:${file}#${index + 1}`,
      query,
      parameters: { rows: [] },
    })),
  )
}
