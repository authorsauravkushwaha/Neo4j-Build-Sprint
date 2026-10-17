/**
 * Applies the Neo4j schema, then loads neo4j/seed.parameters.json into a Neo4j instance.
 *
 * Schema first: neo4j/schema.cypher (curriculum) and neo4j/user-schema.cypher (accounts,
 * roadmaps, progress, rate limits, nonces). Both are idempotent, so every write run applies them.
 *
 * Two transports, one payload:
 *   - Bolt (the official `neo4j-driver`): used when NEO4J_URI is set. This is
 *     the transport the Node backend itself uses, so the database that is
 *     seeded is the database the backend reads.
 *   - HTTPS Query API: used when NEO4J_QUERY_URL is set. This is the
 *     transport the Supabase Edge Functions use, because the Deno runtime
 *     cannot load the native driver.
 *
 * Flags:
 *   --dry-run        show what would be sent (statements, row counts) and exit
 *   --check          read-only: report the database identity and what the
 *                    database already holds, without writing anything
 *   --only=nodes     write nodes only
 *   --only=edges     write relationships only
 *   --batch=N        stop after N statements (useful to inspect partial progress)
 *   --update-existing explicitly overwrite seed-owned properties on matching nodes/edges
 *   --transport=bolt|query-api|auto  choose the transport explicitly
 *
 * Safety properties:
 *   - the query text comes from the generated file, never from user input,
 *   - every write sends its rows as Cypher *parameters* (`$rows`), so no value
 *     is ever concatenated into a query string,
 *   - credentials are read from the environment only and never printed or logged,
 *   - http:// Query API endpoints are refused unless NEO4J_ALLOW_HTTP=true,
 *     because the Query API carries the password in a Basic auth header,
 *   - default writes use MERGE + ON CREATE SET, preserving existing properties
 *     on reruns; the script never deletes or resets anything,
 *   - overwriting matching properties requires the explicit --update-existing flag,
 *   - the run ends by re-counting the graph and comparing it with the manifest.
 */
import { loadSchemaStatements } from './neo4j-schema-statements.ts'
import { parseQueryApiUrl } from '../supabase/functions/_shared/core/neo4jQueryApi.ts'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import neo4j, { type Driver } from 'neo4j-driver'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

interface SeedStatement {
  tag: string
  query: string
  parameters: { rows: unknown[] }
}

interface SeedFile {
  generatedFrom: { version: string; updated: string; provenance: string }
  statements: SeedStatement[]
}

interface Manifest {
  counts: Record<string, number>
}

interface QueryApiV1 {
  results?: Array<{ columns?: string[]; data?: Array<{ row?: unknown[]; meta?: unknown[] }>; errors?: unknown[] }>
  errors?: Array<{ code?: string; message?: string }>
}

interface QueryApiV2 {
  data?: { fields?: string[]; values?: unknown[][] }
  errors?: Array<{ code?: string; message?: string }>
}

interface Decoded {
  fields: string[]
  rows: unknown[][]
  errors: string[]
}

type Transport = 'bolt' | 'query-api'

/**
 * The Query API URL names the database (/db/<name>/query/v2). A separately declared
 * NEO4J_DATABASE must agree, otherwise the seed and the app could write and read
 * different databases. Exits with status 2 on a problem; returns the database name.
 */
function validateQueryApiConfig(queryUrl: string, allowHttp: boolean): string {
  const urlCheck = parseQueryApiUrl(queryUrl, { allowHttp })
  if (!urlCheck.ok) {
    console.error(urlCheck.reason)
    process.exit(2)
  }
  const declared = (process.env.NEO4J_DATABASE ?? '').trim()
  if (declared && declared !== urlCheck.database) {
    console.error(`NEO4J_DATABASE ("${declared}") does not match the database in NEO4J_QUERY_URL ("${urlCheck.database}").`)
    console.error('Remove NEO4J_DATABASE or make the two agree.')
    process.exit(2)
  }
  return urlCheck.database
}

/** Handles both Query API response shapes (v1 `results[].data[].row` and v2 `data.values`). */
function decode(body: unknown): Decoded {
  const v2 = body as QueryApiV2
  if (v2?.data?.values) {
    return {
      fields: v2.data.fields ?? [],
      rows: v2.data.values,
      errors: (v2.errors ?? []).map((e) => `${e.code ?? 'error'}: ${e.message ?? 'unknown'}`),
    }
  }
  const v1 = body as QueryApiV1
  const result = v1?.results?.[0]
  return {
    fields: result?.columns ?? [],
    rows: (result?.data ?? []).map((row) => (Array.isArray(row?.row) ? row.row : [])),
    errors: (v1.errors ?? result?.errors ?? []).map((e) => {
      const error = e as { code?: string; message?: string }
      return `${error.code ?? 'error'}: ${error.message ?? 'unknown'}`
    }),
  }
}

const NODE_COUNT_QUERY = 'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS nodes ORDER BY label'
const REL_COUNT_QUERY = 'MATCH ()-[r]->() RETURN count(r) AS relationships'

async function main(): Promise<void> {
  const flags = new Map(
    process.argv.slice(2).map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
      return [key, value] as const
    }),
  )
  const dryRun = flags.has('dry-run')
  const checkOnly = flags.has('check')
  const updateExisting = flags.has('update-existing')
  const only = flags.get('only')
  const batchLimit = flags.has('batch') ? Math.max(1, Number(flags.get('batch'))) : Number.POSITIVE_INFINITY
  const transportFlag = (flags.get('transport') ?? 'auto').toLowerCase()

  const seed = JSON.parse(readFileSync(resolve(root, 'neo4j', 'seed.parameters.json'), 'utf8')) as SeedFile
  const manifest = JSON.parse(readFileSync(resolve(root, 'neo4j', 'MANIFEST.json'), 'utf8')) as Manifest

  let seedStatements = seed.statements
  if (only === 'nodes') seedStatements = seedStatements.filter((s) => s.tag.startsWith('nodes:'))
  if (only === 'edges') seedStatements = seedStatements.filter((s) => s.tag.startsWith('edges:'))
  seedStatements = seedStatements.slice(0, batchLimit)
  // Schema first (constraints and indexes, both idempotent), then the seed. The
  // schema is applied on every write so a new deployment is never missing a constraint
  // that MERGE relies on; --only and --batch limit the seed data only.
  const schemaStatements = loadSchemaStatements(root)
  const statements = [...schemaStatements, ...seedStatements]

  const rows = statements.reduce((sum, s) => sum + s.parameters.rows.length, 0)
  console.log(`Dataset ${seed.generatedFrom.version} (${seed.generatedFrom.updated})`)
  console.log(`Provenance: ${seed.generatedFrom.provenance}`)
  console.log(`${statements.length} statement(s), ${rows} row(s) to write${only ? ` (only=${only})` : ''}`)
  console.log(updateExisting
    ? 'OVERWRITE MODE: matching node/relationship properties will be updated by the seed payload.'
    : 'SAFE MODE: existing node/relationship properties are preserved on reruns.')

  const uri = (process.env.NEO4J_URI ?? '').trim()
  const queryUrl = (process.env.NEO4J_QUERY_URL ?? '').trim()
  const username = (process.env.NEO4J_USERNAME ?? '').trim()
  const password = process.env.NEO4J_PASSWORD ?? ''
  const database = (process.env.NEO4J_DATABASE ?? 'neo4j').trim() || 'neo4j'
  const allowHttp = (process.env.NEO4J_ALLOW_HTTP ?? '').toLowerCase() === 'true'

  if (dryRun) {
    for (const statement of statements.slice(0, 8)) {
      console.log(`  [${statement.tag}] ${statement.parameters.rows.length} row(s)`)
      console.log(`      ${statement.query.split('\n').join('\n      ')}`)
    }
    if (statements.length > 8) console.log(`  ... ${statements.length - 8} more statement(s)`)
    if (queryUrl) {
      const database = validateQueryApiConfig(queryUrl, allowHttp)
      console.log(`Query API URL: ok (database "${database}").`)
    }
    console.log('\nDry run: nothing was written.')
    return
  }

  /* Which transport? Bolt is preferred when it is configured, because it is
   * the transport the Node backend reads the same database through. */
  let transport: Transport
  if (transportFlag === 'bolt' || transportFlag === 'query-api') {
    transport = transportFlag
  } else if (uri) {
    transport = 'bolt'
  } else if (queryUrl) {
    transport = 'query-api'
  } else {
    transport = 'bolt'
  }

  if (!username || !password) {
    console.error('Missing Neo4j configuration.')
    console.error('Set NEO4J_USERNAME and NEO4J_PASSWORD, plus either NEO4J_URI (Bolt, e.g. neo4j+s://…) or NEO4J_QUERY_URL (HTTPS Query API).')
    console.error('To inspect the payload without a database, run: npm run seed:neo4j -- --dry-run')
    process.exit(2)
  }
  if (transport === 'bolt' && !uri) {
    console.error('NEO4J_URI is not set, so there is no Bolt endpoint to write to.')
    console.error('Set NEO4J_URI (neo4j+s://<id>.databases.neo4j.io) or use the Query API with NEO4J_QUERY_URL.')
    process.exit(2)
  }
  if (transport === 'query-api' && !queryUrl) {
    console.error('NEO4J_QUERY_URL is not set, so there is no Query API endpoint to write to.')
    console.error('For Neo4j Aura: console -> instance -> Connect -> Query API gives the exact URL.')
    process.exit(2)
  }
  if (transport === 'query-api' && !/^https:\/\//i.test(queryUrl) && !allowHttp) {
    console.error('Refusing to send credentials over http://. Use an https:// Query API URL.')
    console.error('For a local Neo4j with a self-signed certificate, set NEO4J_ALLOW_HTTP=true knowingly.')
    process.exit(2)
  }
  if (transport === 'query-api') validateQueryApiConfig(queryUrl, allowHttp)
  if (transport === 'bolt' && /^neo4j:\/\//i.test(uri) && (process.env.NODE_ENV ?? '') === 'production') {
    console.warn('Warning: NEO4J_URI uses an unencrypted scheme. Use neo4j+s:// for a hosted instance.')
  }

  const started = Date.now()
  let written = 0

  if (checkOnly) {
    // Read-only: what is in the database, and which database is it?
    await reportGraph({
      transport, uri, queryUrl, username, password, database, manifest,
    })
    return
  }

  if (transport === 'bolt') {
    await seedOverBolt({ uri, username, password, database, statements, updateExisting, manifest, onWritten: (n) => { written += n } })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`\nWrote ${written} row(s) over Bolt in ${seconds}s.`)
    console.log('Next: deploy the backend (render.yaml or the Supabase functions) so it reads this graph.')
    return
  }

  await seedOverQueryApi({
    queryUrl, username, password, statements, updateExisting, manifest,
    onWritten: (n) => { written += n },
  })

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\nWrote ${written} row(s) in ${seconds}s.`)
  console.log('Next: deploy the functions (supabase functions deploy) so get-careers and friends read this graph.')
}

/* -------------------------------------------------------------------------- */
/* Read-only inspection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Reports the database identity and what the database already holds.
 *
 * This is the step that runs *before* a seed: it answers "is this the right
 * database, and does it already have the graph?" without writing anything, so
 * a seed is only ever run against a database that needs it.
 */
async function reportGraph(options: {
  transport: Transport
  uri: string
  queryUrl: string
  username: string
  password: string
  database: string
  manifest: Manifest
}): Promise<void> {
  if (options.transport === 'bolt') {
    const driver: Driver = neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password), {
      connectionTimeout: 15_000,
      connectionAcquisitionTimeout: 15_000,
      maxConnectionPoolSize: 2,
      userAgent: 'GraphMentorAI/1.0 (seed-check)',
    })
    try {
      await driver.verifyConnectivity({ database: options.database })
      const identity = await readIdentity(driver, options.database)
      const counts = await countGraph(driver, options.database)
      console.log(`\nDatabase: ${identity.name}${identity.status ? ` (${identity.status})` : ''}`)
      console.log(`Nodes: ${counts.nodes}, relationships: ${counts.relationships}`)
      const ok = compareWithManifest(counts.labels, counts.relationships, options.manifest)
      console.log(ok.ok
        ? 'The graph already matches the manifest: nothing needs to be seeded.'
        : 'The graph does not match the manifest: run npm run seed:neo4j to add the missing records.')
      process.exit(ok.ok ? 0 : 1)
    } catch (error) {
      console.error(`Could not inspect the database: ${error instanceof Error ? error.message : 'unknown error'}`)
      process.exit(2)
    } finally {
      await driver.close().catch(() => {})
    }
  }

  const auth = `Basic ${Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64')}`
  const headers = { 'content-type': 'application/json', authorization: auth, accept: 'application/json' }
  const post = async (statement: string): Promise<Decoded> => {
    const response = await fetch(options.queryUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ statement, parameters: {} }),
    })
    const body = await response.json().catch(() => ({}))
    const decoded = decode(body)
    if (!response.ok || decoded.errors.length > 0) {
      throw new Error(decoded.errors.join('; ') || `HTTP ${response.status}`)
    }
    return decoded
  }
  try {
    const decoded = await post(NODE_COUNT_QUERY)
    const labels = new Map<string, number>()
    decoded.rows.forEach((row) => labels.set(String(row[0]), Number(row[1])))
    const rels = await post(REL_COUNT_QUERY)
    const relationships = rels.rows[0] ? Number(rels.rows[0][0]) : 0
    const total = [...labels.values()].reduce((sum, count) => sum + count, 0)
    console.log(`\nDatabase: ${options.database}`)
    console.log(`Nodes: ${total}, relationships: ${relationships}`)
    const ok = compareWithManifest(labels, relationships, options.manifest)
    console.log(ok.ok
      ? 'The graph already matches the manifest: nothing needs to be seeded.'
      : 'The graph does not match the manifest: run npm run seed:neo4j to add the missing records.')
    process.exit(ok.ok ? 0 : 1)
  } catch (error) {
    console.error(`Could not inspect the database: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exit(2)
  }
}

/* -------------------------------------------------------------------------- */
/* Bolt transport                                                             */
/* -------------------------------------------------------------------------- */

interface SeedOptions {
  statements: SeedStatement[]
  updateExisting: boolean
  manifest: Manifest
  onWritten: (rows: number) => void
}

async function seedOverBolt(options: SeedOptions & {
  uri: string
  username: string
  password: string
  database: string
}): Promise<void> {
  const driver: Driver = neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password), {
    connectionTimeout: 15_000,
    connectionAcquisitionTimeout: 15_000,
    maxConnectionPoolSize: 5,
    userAgent: 'GraphMentorAI/1.0 (seed)',
  })
  try {
    // Prove the connection before writing anything, and report which database
    // it is: a seed that lands in the wrong database is worse than no seed.
    await driver.verifyConnectivity({ database: options.database })
    const identity = await readIdentity(driver, options.database)
    console.log(`\nConnected to ${identity.status ? `${identity.name} (${identity.status})` : identity.name}.`)
    console.log(`Database: ${options.database}`)

    const before = await countGraph(driver, options.database)
    console.log(`Before: ${before.nodes} node(s), ${before.relationships} relationship(s).`)

    if (options.manifest) console.log('Comparing against the generated manifest after writing.')

    for (const [index, statement] of options.statements.entries()) {
      const label = `[${index + 1}/${options.statements.length}] ${statement.tag}`
      const query = options.updateExisting ? statement.query.replaceAll('ON CREATE SET', 'SET') : statement.query
      const session = driver.session({ database: options.database })
      try {
        await session.run(query, statement.parameters as Record<string, unknown>)
      } catch (error) {
        console.error(`${label} — FAILED`)
        console.error(`    ${error instanceof Error ? error.message : 'unknown error'}`)
        process.exit(1)
      } finally {
        await session.close().catch(() => {})
      }
      options.onWritten(statement.parameters.rows.length)
      console.log(`${label} — ok (${statement.parameters.rows.length} row(s))`)
    }

    const after = await countGraph(driver, options.database)
    console.log(`\nAfter: ${after.nodes} node(s), ${after.relationships} relationship(s).`)
    console.log(`Created: ${Math.max(0, after.nodes - before.nodes)} node(s), ${Math.max(0, after.relationships - before.relationships)} relationship(s).`)
    const ok = compareWithManifest(after.labels, after.relationships, options.manifest)
    console.log(ok.ok
      ? 'Verification passed: the graph matches the manifest.'
      : 'Finished, but the counts do not match the manifest — see the DIFF lines above.')
    if (!ok.ok) process.exit(1)
  } finally {
    await driver.close().catch(() => {})
  }
}

interface GraphCounts {
  nodes: number
  relationships: number
  labels: Map<string, number>
}

async function readIdentity(driver: Driver, database: string): Promise<{ name: string; status: string | null }> {
  const session = driver.session({ database })
  try {
    const result = await session.run(
      'SHOW DATABASES YIELD name, currentStatus WHERE name = $name RETURN name AS name, currentStatus AS status',
      { name: database },
    )
    const record = result.records[0]
    if (record) return { name: String(record.get('name')), status: record.get('status') ? String(record.get('status')) : null }
  } catch {
    // Listing databases needs administrative rights; the configured name is
    // still the identity this process writes to.
  } finally {
    await session.close().catch(() => {})
  }
  return { name: database, status: null }
}

async function countGraph(driver: Driver, database: string): Promise<GraphCounts> {
  const session = driver.session({ database })
  try {
    const nodes = await session.run(NODE_COUNT_QUERY)
    const rels = await session.run(REL_COUNT_QUERY)
    const labels = new Map<string, number>()
    for (const record of nodes.records) labels.set(String(record.get('label')), Number(record.get('nodes')))
    const relationships = rels.records[0] ? Number(rels.records[0].get('relationships')) : 0
    const total = [...labels.values()].reduce((sum, count) => sum + count, 0)
    return { nodes: total, relationships, labels }
  } finally {
    await session.close().catch(() => {})
  }
}

/* -------------------------------------------------------------------------- */
/* Query API transport                                                        */
/* -------------------------------------------------------------------------- */

async function seedOverQueryApi(options: SeedOptions & {
  queryUrl: string
  username: string
  password: string
}): Promise<void> {
  const auth = `Basic ${Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64')}`
  const headers = { 'content-type': 'application/json', authorization: auth, accept: 'application/json' }

  const post = async (statement: string, parameters: Record<string, unknown>): Promise<Decoded> => {
    const response = await fetch(options.queryUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ statement, parameters }),
    })
    const body = await response.json().catch(() => ({}))
    const decoded = decode(body)
    if (!response.ok || decoded.errors.length > 0) {
      const detail = decoded.errors.length > 0 ? decoded.errors.join('; ') : `HTTP ${response.status}`
      throw new Error(detail)
    }
    return decoded
  }

  console.log(`\nQuery API: ${new URL(options.queryUrl).origin}${new URL(options.queryUrl).pathname}`)

  for (const [index, statement] of options.statements.entries()) {
    const label = `[${index + 1}/${options.statements.length}] ${statement.tag}`
    try {
      await post(
        options.updateExisting ? statement.query.replaceAll('ON CREATE SET', 'SET') : statement.query,
        statement.parameters as Record<string, unknown>,
      )
    } catch (error) {
      console.error(`${label} — FAILED`)
      console.error(`    ${error instanceof Error ? error.message : 'unknown error'}`)
      if (/401|403/.test(error instanceof Error ? error.message : '')) {
        console.error('    Authentication failed: check NEO4J_USERNAME / NEO4J_PASSWORD (Aura shows the password once).')
      }
      if (/404/.test(error instanceof Error ? error.message : '')) {
        console.error('    Endpoint not found: the URL must end with /query/v2 (or /query for older instances).')
      }
      process.exit(1)
    }
    options.onWritten(statement.parameters.rows.length)
    console.log(`${label} — ok (${statement.parameters.rows.length} row(s))`)
  }

  const decoded = await post(NODE_COUNT_QUERY, {})
  const labels = new Map<string, number>()
  decoded.rows.forEach((row) => labels.set(String(row[0]), Number(row[1])))
  const rels = await post(REL_COUNT_QUERY, {})
  const relationships = rels.rows[0] ? Number(rels.rows[0][0]) : 0
  const total = [...labels.values()].reduce((sum, count) => sum + count, 0)
  console.log('\nNodes now in the database:')
  const ok = compareWithManifest(labels, relationships, options.manifest)
  if (!ok.ok) {
    console.warn('Counts differ from the manifest. This is expected if the dataset changed since the last')
    console.warn('emit, or if the database holds extra nodes. Re-run `npm run emit:cypher` and try again.')
    process.exit(1)
  }
}

function compareWithManifest(labels: Map<string, number>, relationships: number, manifest: Manifest): { ok: boolean } {
  let mismatches = 0
  for (const [label, expected] of Object.entries(manifest.counts)) {
    if (label === 'edges') continue
    const actual = labels.get(label) ?? 0
    const flag = actual === expected ? 'ok  ' : 'DIFF'
    if (actual !== expected) mismatches += 1
    console.log(`  ${flag} ${label}: expected ${expected}, found ${actual}`)
  }
  const expectedEdges = manifest.counts['edges'] ?? 0
  const edgeFlag = relationships === expectedEdges ? 'ok  ' : 'DIFF'
  if (relationships !== expectedEdges) mismatches += 1
  console.log(`  ${edgeFlag} edges: expected ${expectedEdges}, found ${relationships}`)
  return { ok: mismatches === 0 }
}

main().catch((error: unknown) => {
  console.error('Seeding failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
