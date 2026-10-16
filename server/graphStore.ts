/**
 * The deployment's own graph database — the store behind the repo-owned
 * backend (`server/graphApi.ts`).
 *
 * Why this file exists: the website only knew two worlds — a hosted
 * Supabase+Neo4j pair, or the bundled sample dataset in the browser. Anything
 * between (a free Node host with a disk, a classroom server, a container) had
 * no database to connect to, so the app could only ever run in sample mode
 * there. This store is the third world: a PostgreSQL database the project
 * itself owns — embedded on disk by PGlite by default, or any PostgreSQL the
 * operator points `GRAPH_DATABASE_URL` at — holding the curriculum as real
 * rows that the API actually reads, instead of a file baked into the bundle.
 *
 * What is true about the data, so nobody has to guess:
 *   - the rows are seeded from the project's curriculum dataset
 *     (`src/data/seed/knowledgeGraph.ts`, the same source that generates
 *     `neo4j/seed.cypher`), versioned by `dataset_version`;
 *   - after seeding, the database — not the app bundle — is the source of
 *     truth: every API read is answered from `SELECT`s against these tables,
 *     and an operator edit followed by `select graph.bump()` changes what the
 *     API serves without a redeploy;
 *   - the content is the public curriculum (no personal data), so the
 *     privilege story is "the API process can read and re-seed", nothing more.
 *
 * Layout (schema `graph`):
 *   graph.meta(key, value)                 — dataset_version, revision, seeded_at, provenance
 *   graph.documents(bucket, position, id, doc jsonb)
 *     one row per entity, `bucket` naming the dataset collection
 *     ('careers', 'skills', 'edges', …). `position` preserves the authored
 *     order exactly, so a load round-trips byte-for-byte.
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import lockfile from 'proper-lockfile'
import { Pool } from 'pg'

import { validateDataset, type KnowledgeDataset } from '../supabase/functions/_shared/core/dataset.ts'
import { knowledgeGraph } from '../src/data/seed/knowledgeGraph.ts'

/* ========================================================================
 * Minimal database handle (satisfied by PGlite, a pg Pool, or a test fake)
 * ====================================================================== */

export interface GraphDbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  release(): void
}

export interface GraphDatabase {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  /** Lease a single connection so BEGIN…COMMIT cannot interleave with others. */
  connect(): Promise<GraphDbClient>
  end(): Promise<void>
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Collection names, keyed exactly as in `KnowledgeDataset`. */
export const GRAPH_BUCKETS = [
  'branches',
  'careers',
  'subjects',
  'concepts',
  'skills',
  'languages',
  'tools',
  'projects',
  'resources',
  'modules',
  'assessments',
  'edges',
] as const

export type GraphBucket = (typeof GRAPH_BUCKETS)[number]

/** Table label used by the health check, per bucket (missing for `edges`). */
export const BUCKET_LABELS: Partial<Record<GraphBucket, string>> = {
  branches: 'EngineeringBranch',
  careers: 'Career',
  subjects: 'Subject',
  concepts: 'Concept',
  skills: 'Skill',
  languages: 'ProgrammingLanguage',
  tools: 'Tool',
  projects: 'Project',
  resources: 'Resource',
  modules: 'LearningModule',
  assessments: 'Assessment',
}

const SCHEMA_SQL = `
create schema if not exists graph;
create table if not exists graph.meta (
  key text primary key,
  value jsonb not null
);
create table if not exists graph.documents (
  bucket text not null,
  position integer not null,
  id text not null,
  doc jsonb not null,
  primary key (bucket, position)
);
create unique index if not exists documents_bucket_id on graph.documents (bucket, id);

-- After editing rows by hand, run  select graph.bump()  so the API notices
-- without a restart. The revision is the reader's cache key.
create or replace function graph.bump() returns integer
language sql
as $fn$
  insert into graph.meta as m (key, value) values ('revision', '1'::jsonb)
  on conflict (key) do update set value = to_jsonb(coalesce((m.value#>>'{}')::int, 0) + 1)
  returning (value#>>'{}')::int
$fn$;
`

/* ========================================================================
 * Opening the database
 * ====================================================================== */

/** Serialize access to a PGlite engine, which is a single connection. */
function serialize(engine: PGlite): <T>(task: (client: GraphDbClient) => Promise<T>) => Promise<T> {
  let tail = Promise.resolve()
  let closed = false
  return async (task) => {
    if (closed) throw new Error('Graph database is closed')
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((done) => {
      release = done
    })
    await previous
    const client: GraphDbClient = {
      query: (sql, values) => engine.query<Record<string, unknown>>(sql, values),
      release: () => {},
    }
    try {
      return await task(client)
    } finally {
      release()
    }
  }
}

/**
 * PGlite is single-connection, so a leased client and a queued query would
 * deadlock if both held locks. Instead of leasing, the store runs every unit
 * of work inside the serializer; transactions pass their whole body as one
 * task. This is the interface the seeder actually uses.
 */
export interface TransactionalGraphDatabase extends GraphDatabase {
  /** Run `body` with exclusive access; for PGlite, inside one real session. */
  exclusive<T>(body: (client: Pick<GraphDbClient, 'query'>) => Promise<T>): Promise<T>
}

/** Wrap a live PGlite engine as a TransactionalGraphDatabase (used by tests with in-memory engines). */
export function wrapPGlite(engine: PGlite): TransactionalGraphDatabase {
  const run = serialize(engine)
  const client: Pick<GraphDbClient, 'query'> = {
    query: (sql, values) => engine.query<Record<string, unknown>>(sql, values),
  }
  return {
    query: (sql, values) => run(() => client.query(sql, values)),
    connect: async () => {
      throw new Error('PGlite-backed stores use exclusive() instead of connect()')
    },
    exclusive: (body) => run(() => body(client)),
    end: () => engine.close().then(() => {}),
  }
}

function wrapPool(pool: Pool): TransactionalGraphDatabase {
  let ending: Promise<void> | undefined
  return {
    query: async (sql, values) => pool.query(sql, values as never[]),
    connect: async () => {
      const client = await pool.connect()
      let released = false
      return {
        query: (sql, values) => client.query(sql, values as never[]),
        release: () => {
          if (!released) {
            released = true
            client.release()
          }
        },
      }
    },
    exclusive: async (body) => {
      const client = await pool.connect()
      try {
        return await body({ query: (sql, values) => client.query(sql, values as never[]) })
      } finally {
        client.release()
      }
    },
    end: () => (ending ??= pool.end().then(() => {})),
  }
}

/** Embedded engine on disk: the zero-configuration default. */
export async function openEmbeddedGraphDatabase(directory: string): Promise<TransactionalGraphDatabase> {
  const path = resolve(directory)
  await mkdir(path, { recursive: true, mode: 0o700 })
  // Single-owner data directory, same rule as the account database: a second
  // process locking it would corrupt the store, so refuse instead.
  const unlock = await lockfile.lock(path, { stale: 10_000, retries: 0 })
  let engine: PGlite | undefined
  try {
    engine = await PGlite.create(path)
    await engine.exec(SCHEMA_SQL)
  } catch (error) {
    await engine?.close().catch(() => {})
    await unlock()
    throw error
  }
  const store = wrapPGlite(engine)
  let ending: Promise<void> | undefined
  return {
    ...store,
    end: () =>
      (ending ??= (async () => {
        try {
          await engine.close()
        } finally {
          await unlock()
        }
      })()),
  }
}

/** In-memory engine with the schema applied — the test double for the real store. */
export async function createInMemoryGraphStore(): Promise<TransactionalGraphDatabase> {
  const engine = await PGlite.create()
  await engine.exec(SCHEMA_SQL)
  return wrapPGlite(engine)
}

/**
 * Opens the graph store for this deployment:
 *   GRAPH_DATABASE_URL      -> that PostgreSQL (schema `graph` is created when
 *                              the role may; see docs/graph-database.md),
 *   GM_GRAPH_DATABASE_DIR   -> embedded PGlite at this directory,
 *   default                 -> .localdata/graph-postgres inside the project.
 */
export async function openGraphDatabase(env: NodeJS.ProcessEnv = process.env): Promise<TransactionalGraphDatabase> {
  const url = (env['GRAPH_DATABASE_URL'] ?? '').trim()
  if (url) {
    const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000 })
    try {
      await pool.query(SCHEMA_SQL)
    } catch (error) {
      await pool.end()
      throw error
    }
    return wrapPool(pool)
  }
  return openEmbeddedGraphDatabase(env['GM_GRAPH_DATABASE_DIR'] ?? join(root, '.localdata/graph-postgres'))
}

/* ========================================================================
 * Seeding and loading
 * ====================================================================== */

const INSERT_BATCH = 150

async function insertBucket(client: Pick<GraphDbClient, 'query'>, bucket: GraphBucket, rows: Array<{ id?: string }>): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const sliceRows = rows.slice(start, start + INSERT_BATCH)
    const values: unknown[] = []
    const tuples = sliceRows
      .map((row, index) => {
        const position = start + index
        const id = typeof row.id === 'string' ? row.id : `${bucket}:${position}`
        values.push(bucket, position, id, JSON.stringify(row))
        return `($${values.length - 3}, $${values.length - 2}, $${values.length - 1}, $${values.length}::jsonb)`
      })
      .join(', ')
    await client.query(`insert into graph.documents (bucket, position, id, doc) values ${tuples}`, values)
  }
}

export interface SeedResult {
  seeded: boolean
  reason: string
  datasetVersion: string
  revision: number
}

function asMetaNumber(value: unknown): number {
  if (typeof value === 'number') return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function readMeta(db: Pick<GraphDbClient, 'query'>): Promise<Map<string, unknown>> {
  try {
    const { rows } = await db.query('select key, value from graph.meta')
    return new Map(rows.map((row) => [String(row['key']), row['value']]))
  } catch {
    // Schema missing/unfinished (first boot against a restricted role is loud
    // about it at open time; an empty map here simply means "not seeded").
    return new Map()
  }
}

/**
 * Idempotent seeding. A store whose `dataset_version` matches the bundled
 * dataset is left untouched (operator edits included); anything older,
 * newer or absent is replaced wholesale, in one transaction, so the API can
 * never observe a half-written graph.
 */
export async function seedGraphDatabase(
  db: TransactionalGraphDatabase,
  options: { force?: boolean; dataset?: KnowledgeDataset } = {},
): Promise<SeedResult> {
  const dataset = options.dataset ?? knowledgeGraph
  const meta = await readMeta(db)
  const current = typeof meta.get('dataset_version') === 'string' ? (meta.get('dataset_version') as string) : null

  if (!options.force && current === dataset.version) {
    const revision = asMetaNumber(meta.get('revision'))
    return { seeded: false, reason: `dataset v${dataset.version} already present`, datasetVersion: dataset.version, revision }
  }

  const validation = validateDataset(dataset)
  if (!validation.ok) {
    const first = validation.issues.find((issue) => issue.level === 'error')
    throw new Error(`Refusing to seed an invalid dataset: ${first ? `${first.where}: ${first.message}` : 'validation failed'}`)
  }

  const revision = await db.exclusive(async (client) => {
    await client.query('begin')
    try {
      await client.query('delete from graph.documents')
      for (const bucket of GRAPH_BUCKETS) {
        await insertBucket(client, bucket, dataset[bucket] as Array<{ id?: string }>)
      }
      await client.query(
        `insert into graph.meta (key, value) values
           ('dataset_version', to_jsonb($1::text)),
           ('dataset_updated', to_jsonb($2::text)),
           ('provenance', to_jsonb($3::text)),
           ('seeded_at', to_jsonb($4::text))
         on conflict (key) do update set value = excluded.value`,
        [dataset.version, dataset.updated, dataset.provenance, new Date().toISOString()],
      )
      const bumped = await client.query('select graph.bump() as revision')
      await client.query('commit')
      return asMetaNumber(bumped.rows[0]?.['revision'])
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }
  })

  const edges = dataset.edges.length
  const nodes = GRAPH_BUCKETS.filter((bucket) => bucket !== 'edges').reduce((sum, bucket) => sum + dataset[bucket].length, 0)
  return {
    seeded: true,
    reason: `seeded v${dataset.version}: ${nodes} nodes, ${edges} relationships`,
    datasetVersion: dataset.version,
    revision,
  }
}

/** Drop the graph schema wholesale (`--wipe`). Returns true when anything was dropped. */
export async function dropGraphStore(db: Pick<GraphDbClient, 'query'>): Promise<boolean> {
  // Not `drop schema cascade`: a restricted role only needs its own tables
  // gone, and dropping a whole schema it does not fully own would fail midway.
  const { rows } = await db.query(
    `select count(*)::int as n
       from information_schema.tables
      where table_schema = 'graph' and table_name in ('documents', 'meta')`,
  )
  const tables = Number(rows[0]?.['n'] ?? 0)
  if (tables === 0) return false
  await db.query('drop table if exists graph.documents, graph.meta')
  await db.query('drop function if exists graph.bump()')
  return true
}

/** The store's change counter; the API reader caches against this value. */
export async function graphRevision(db: Pick<GraphDbClient, 'query'>): Promise<number> {
  const meta = await readMeta(db)
  return asMetaNumber(meta.get('revision'))
}

/** Dataset version recorded at seed time, or null when the store has not been seeded. */
export async function graphDatasetVersion(db: Pick<GraphDbClient, 'query'>): Promise<string | null> {
  const meta = await readMeta(db)
  const version = meta.get('dataset_version')
  return typeof version === 'string' ? version : null
}

/**
 * Rebuilds the typed dataset from the tables. Returns null for an unseeded
 * store (the caller reports "empty graph", honestly, instead of serving an
 * invented one). A store that fails validation is a server error — loud beats
 * wrong.
 */
export async function loadDataset(db: Pick<GraphDbClient, 'query'>): Promise<KnowledgeDataset | null> {
  const meta = await readMeta(db)
  const version = meta.get('dataset_version')
  if (typeof version !== 'string') return null

  const { rows } = await db.query('select bucket, position, id, doc from graph.documents order by bucket, position')
  if (rows.length === 0) return null

  const dataset = {
    version,
    updated: typeof meta.get('dataset_updated') === 'string' ? (meta.get('dataset_updated') as string) : '',
    provenance: typeof meta.get('provenance') === 'string' ? (meta.get('provenance') as string) : '',
    branches: [],
    careers: [],
    subjects: [],
    concepts: [],
    skills: [],
    languages: [],
    tools: [],
    projects: [],
    resources: [],
    modules: [],
    assessments: [],
    edges: [],
  } as unknown as KnowledgeDataset

  for (const row of rows) {
    const bucket = String(row['bucket']) as GraphBucket
    if (!(GRAPH_BUCKETS as readonly string[]).includes(bucket)) {
      throw new Error(`graph.documents contains unknown bucket "${bucket}" — refusing to guess at the schema.`)
    }
    ;(dataset[bucket] as unknown[]).push(row['doc'])
  }

  const validation = validateDataset(dataset)
  if (!validation.ok) {
    const first = validation.issues.find((issue) => issue.level === 'error')
    throw new Error(
      `The graph database failed its own validation (${first ? `${first.where}: ${first.message}` : 'unknown error'}). ` +
        'The stored data is not served in this state; re-seed with npm run seed:graphdb.',
    )
  }
  return dataset
}

/** Per-label and total row counts, straight from the tables (health check). */
export async function graphCounts(db: Pick<GraphDbClient, 'query'>): Promise<{
  nodes: number
  relationships: number
  labels: Array<{ label: string; count: number }>
}> {
  const { rows } = await db.query('select bucket, count(*)::int as n from graph.documents group by bucket order by bucket')
  let nodes = 0
  let relationships = 0
  const labels: Array<{ label: string; count: number }> = []
  for (const row of rows) {
    const bucket = String(row['bucket']) as GraphBucket
    const count = Number(row['n'])
    if (bucket === 'edges') {
      relationships = count
      continue
    }
    nodes += count
    const label = BUCKET_LABELS[bucket]
    if (label && count > 0) labels.push({ label, count })
  }
  const order = new Map(Object.values(BUCKET_LABELS).map((label, index) => [label, index]))
  labels.sort((a, b) => (order.get(a.label) ?? 99) - (order.get(b.label) ?? 99))
  return { nodes, relationships, labels }
}
