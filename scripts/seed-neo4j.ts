/**
 * Loads neo4j/seed.parameters.json into a Neo4j instance through the HTTPS Query
 * API (AuraDB Free compatible).
 *
 *   NEO4J_QUERY_URL=https://<id>.databases.neo4j.io/db/neo4j/query/v2 \
 *   NEO4J_USERNAME=neo4j NEO4J_PASSWORD=... npm run seed:neo4j
 *
 * Flags:
 *   --dry-run        show what would be sent (statements, row counts) and exit
 *   --only=nodes     write nodes only
 *   --only=edges     write relationships only
 *   --batch=N        stop after N statements (useful to inspect partial progress)
 *
 * Safety properties:
 *   - the query text comes from the generated file, never from user input,
 *   - every write sends its rows as Cypher *parameters* (`$rows`), so no value
 *     is ever concatenated into a query string,
 *   - credentials are read from the environment only and never printed or logged,
 *   - http:// endpoints are refused unless NEO4J_ALLOW_HTTP=true, because the
 *     Query API carries the password in a Basic auth header,
 *   - the run ends by re-counting the graph and comparing it with the manifest.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      const err = e as { code?: string; message?: string }
      return `${err.code ?? 'error'}: ${err.message ?? 'unknown'}`
    }),
  }
}

async function main(): Promise<void> {
  const flags = new Map(
    process.argv.slice(2).map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
      return [key, value] as const
    }),
  )
  const dryRun = flags.has('dry-run')
  const only = flags.get('only')
  const batchLimit = flags.has('batch') ? Math.max(1, Number(flags.get('batch'))) : Number.POSITIVE_INFINITY

  const seed = JSON.parse(readFileSync(resolve(root, 'neo4j', 'seed.parameters.json'), 'utf8')) as SeedFile
  const manifest = JSON.parse(readFileSync(resolve(root, 'neo4j', 'MANIFEST.json'), 'utf8')) as Manifest

  let statements = seed.statements
  if (only === 'nodes') statements = statements.filter((s) => s.tag.startsWith('nodes:'))
  if (only === 'edges') statements = statements.filter((s) => s.tag.startsWith('edges:'))
  statements = statements.slice(0, batchLimit)

  const rows = statements.reduce((sum, s) => sum + s.parameters.rows.length, 0)
  console.log(`Dataset ${seed.generatedFrom.version} (${seed.generatedFrom.updated})`)
  console.log(`Provenance: ${seed.generatedFrom.provenance}`)
  console.log(`${statements.length} statement(s), ${rows} row(s) to write${only ? ` (only=${only})` : ''}\n`)

  const url = (process.env.NEO4J_QUERY_URL ?? '').trim()
  const username = (process.env.NEO4J_USERNAME ?? '').trim()
  const password = process.env.NEO4J_PASSWORD ?? ''
  const allowHttp = (process.env.NEO4J_ALLOW_HTTP ?? '').toLowerCase() === 'true'

  if (dryRun) {
    for (const statement of statements.slice(0, 8)) {
      console.log(`  [${statement.tag}] ${statement.parameters.rows.length} row(s)`)
      console.log(`      ${statement.query.split('\n').join('\n      ')}`)
    }
    if (statements.length > 8) console.log(`  ... ${statements.length - 8} more statement(s)`)
    console.log('\nDry run: nothing was written.')
    return
  }

  if (!url || !username || !password) {
    console.error('Missing Neo4j configuration.')
    console.error('Set NEO4J_QUERY_URL, NEO4J_USERNAME and NEO4J_PASSWORD (see supabase/.env.example).')
    console.error('For Neo4j Aura: console -> instance -> Connect -> Query API gives the exact URL.')
    console.error('\nTo inspect the payload without a database, run: npm run seed:neo4j -- --dry-run')
    process.exit(1)
  }
  if (!/^https:\/\//i.test(url) && !allowHttp) {
    console.error('Refusing to send credentials over http://. Use an https:// Query API URL.')
    console.error('For a local Neo4j with a self-signed certificate, set NEO4J_ALLOW_HTTP=true knowingly.')
    process.exit(1)
  }

  const auth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
  const headers = { 'content-type': 'application/json', authorization: auth, accept: 'application/json' }

  const started = Date.now()
  let written = 0

  for (const [index, statement] of statements.entries()) {
    const label = `[${index + 1}/${statements.length}] ${statement.tag}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ statement: statement.query, parameters: statement.parameters }),
      })
    } catch (error) {
      console.error(`${label} — transport failure: ${error instanceof Error ? error.message : 'unknown'}`)
      console.error('Check the Query API URL and that this machine can reach the instance.')
      process.exit(1)
    }

    const body = await response.json().catch(() => ({}))
    const decoded = decode(body)

    if (!response.ok || decoded.errors.length > 0) {
      console.error(`${label} — FAILED (HTTP ${response.status})`)
      for (const message of decoded.errors) console.error(`    ${message}`)
      if (response.status === 401 || response.status === 403) {
        console.error('    Authentication failed: check NEO4J_USERNAME / NEO4J_PASSWORD (Aura shows the password once).')
      }
      if (response.status === 404) {
        console.error('    Endpoint not found: the URL must end with /query/v2 (or /query for older instances).')
      }
      process.exit(1)
    }

    written += statement.parameters.rows.length
    console.log(`${label} — ok (${statement.parameters.rows.length} row(s))`)
  }

  // Verification step: re-count the graph and compare with the manifest.
  const verifyQuery = `MATCH (n) WITH labels(n)[0] AS label, count(*) AS nodes RETURN label, nodes ORDER BY label`
  let verifyOk = false
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ statement: verifyQuery, parameters: {} }),
    })
    const decoded = decode(await response.json().catch(() => ({})))
    const seen = new Map<string, number>(decoded.rows.map((row) => [String(row[0]), Number(row[1])]))
    console.log('\nNodes now in the database:')
    let mismatches = 0
    for (const [label, expected] of Object.entries(manifest.counts)) {
      if (label === 'edges') continue
      const actual = seen.get(label) ?? 0
      const flag = actual === expected ? 'ok  ' : 'DIFF'
      if (actual !== expected) mismatches += 1
      console.log(`  ${flag} ${label}: expected ${expected}, found ${actual}`)
    }
    verifyOk = mismatches === 0
    if (!verifyOk) {
      console.warn('\nCounts differ from the manifest. This is expected if the dataset changed since the last')
      console.warn('emit, or if the database holds extra nodes. Re-run `npm run emit:cypher` and try again.')
    }
  } catch (error) {
    console.warn(`Verification query failed: ${error instanceof Error ? error.message : 'unknown'}`)
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\nWrote ${written} row(s) in ${seconds}s.`)
  console.log(
    verifyOk
      ? 'Verification passed: the graph matches the manifest.'
      : 'Finished, but the counts do not match the manifest — see the DIFF lines above.',
  )
  console.log('Next: deploy the functions (supabase functions deploy) so get-careers and friends read this graph.')
  process.exit(verifyOk ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('Seeding failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})


