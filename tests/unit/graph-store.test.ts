// @vitest-environment node
/**
 * The Postgres-backed graph store (server/graphStore.ts): schema, seeding,
 * revision semantics and dataset round-trips, against a real in-memory
 * PostgreSQL engine — no mocked SQL anywhere.
 */
import { describe, expect, it, afterEach } from 'vitest'

import {
  createInMemoryGraphStore,
  graphCounts,
  graphDatasetVersion,
  graphRevision,
  loadDataset,
  seedGraphDatabase,
  BUCKET_LABELS,
  type TransactionalGraphDatabase,
} from '../../server/graphStore.ts'
import { knowledgeGraph } from '../../src/data/seed/knowledgeGraph.ts'
import { NODE_ID_PREFIXES } from '@core/validate.ts'

let store: TransactionalGraphDatabase | null = null

async function open(): Promise<TransactionalGraphDatabase> {
  store = await createInMemoryGraphStore()
  return store
}

afterEach(async () => {
  await store?.end()
  store = null
})

describe('graph store: seeding and honest emptiness', () => {
  it('starts unseeded — loadDataset returns null instead of an invented graph', async () => {
    const db = await open()
    expect(await loadDataset(db)).toBeNull()
    expect(await graphDatasetVersion(db)).toBeNull()
    expect((await graphCounts(db)).nodes).toBe(0)
  })

  it('seeds the full curriculum and reports live table counts', async () => {
    const db = await open()
    const result = await seedGraphDatabase(db)
    expect(result.seeded).toBe(true)
    expect(result.datasetVersion).toBe(knowledgeGraph.version)

    const counts = await graphCounts(db)
    const expectedNodes =
      knowledgeGraph.branches.length +
      knowledgeGraph.careers.length +
      knowledgeGraph.subjects.length +
      knowledgeGraph.concepts.length +
      knowledgeGraph.skills.length +
      knowledgeGraph.languages.length +
      knowledgeGraph.tools.length +
      knowledgeGraph.projects.length +
      knowledgeGraph.resources.length +
      knowledgeGraph.modules.length +
      knowledgeGraph.assessments.length
    expect(counts.nodes).toBe(expectedNodes)
    expect(counts.relationships).toBe(knowledgeGraph.edges.length)
    expect(counts.labels.find((entry) => entry.label === 'Career')?.count).toBe(knowledgeGraph.careers.length)
    // Every label the vocabulary knows is represented in the report.
    expect(counts.labels.map((entry) => entry.label).sort()).toEqual(Object.values(BUCKET_LABELS).sort())
  })

  it('is idempotent for the same dataset version and bumps the revision only on change', async () => {
    const db = await open()
    const first = await seedGraphDatabase(db)
    const second = await seedGraphDatabase(db)
    expect(second.seeded).toBe(false)
    expect(await graphRevision(db)).toBe(first.revision)
    const forced = await seedGraphDatabase(db, { force: true })
    expect(forced.seeded).toBe(true)
    expect(await graphRevision(db)).toBeGreaterThan(first.revision)
  })
})

describe('graph store: dataset round-trip', () => {
  it('rebuilds a dataset that validates and behaves identically to the source', async () => {
    const db = await open()
    await seedGraphDatabase(db)
    const loaded = await loadDataset(db)
    expect(loaded).not.toBeNull()
    expect(loaded!.version).toBe(knowledgeGraph.version)
    expect(loaded!.provenance).toBe(knowledgeGraph.provenance)

    // Counts per collection…
    for (const key of ['branches', 'careers', 'subjects', 'concepts', 'skills', 'languages', 'tools', 'projects', 'resources', 'modules', 'assessments', 'edges'] as const) {
      expect(loaded![key].length, `collection ${key}`).toBe(knowledgeGraph[key].length)
    }

    // …and content equality, order-sensitive: PGlite jsonb normalises object
    // key order inside a document, so compare each document semantically.
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, val: unknown) =>
        val !== null && typeof val === 'object' && !Array.isArray(val)
          ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
          : val,
      )
    for (const key of ['careers', 'skills', 'resources', 'projects', 'edges'] as const) {
      expect(loaded![key].map(canonical), `round-trip of ${key}`).toEqual(knowledgeGraph[key].map(canonical))
    }
  })

  it('every stored entity id still follows the prefix convention', async () => {
    const db = await open()
    await seedGraphDatabase(db)
    const { rows } = await db.query("select bucket, id from graph.documents where bucket <> 'edges'")
    expect(rows.length).toBeGreaterThan(400)
    for (const row of rows) {
      const prefix = String(row['id']).split(':')[0] as keyof typeof NODE_ID_PREFIXES
      expect(NODE_ID_PREFIXES[prefix], `id ${String(row['id'])}`).toBeTruthy()
    }
  })

  it('an operator edit plus graph.bump() changes what subsequent loads serve', async () => {
    const db = await open()
    await seedGraphDatabase(db)
    const before = await graphRevision(db)
    const career = knowledgeGraph.careers[0]!
    const renamed = { ...career, summary: 'Edited straight in the database.' }
    await db.query('update graph.documents set doc = $2::jsonb where bucket = $1 and id = $3', [
      'careers',
      JSON.stringify(renamed),
      career.id,
    ])
    await db.query('select graph.bump()')
    expect(await graphRevision(db)).toBeGreaterThan(before)
    const loaded = await loadDataset(db)
    expect(loaded!.careers.find((entry) => entry.id === career.id)?.summary).toBe('Edited straight in the database.')
  })

  it('refuses to serve a store that fails validation rather than reading it anyway', async () => {
    const db = await open()
    await seedGraphDatabase(db)
    // Break one REQUIRES edge so it points at a node that does not exist.
    await db.query(
      `update graph.documents set doc = jsonb_set(doc, '{to}', '"skill:does-not-exist"'::jsonb)
       where bucket = 'edges' and position = (select min(position) from graph.documents where bucket = 'edges' and doc->>'type' = 'REQUIRES')`,
    )
    await expect(loadDataset(db)).rejects.toThrow(/validation/i)
  })
})
