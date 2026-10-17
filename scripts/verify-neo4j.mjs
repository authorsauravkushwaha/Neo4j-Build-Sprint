#!/usr/bin/env node
/**
 * verify-neo4j — prove that a GraphMentor backend really executes Cypher
 * against a real Neo4j database, and report exactly what was proven.
 *
 * The rule this script exists to enforce: a green build, a 200 from a health
 * endpoint, or a configured environment variable is NOT evidence that a
 * database answered. Only a real, non-empty query result carrying genuine
 * Neo4j provenance is.
 *
 * It verifies two backend contracts, chosen from the target URL (or forced with
 * --kind), and never mixes them:
 *
 *   node      the repository's own Node backend (server/graphApi.ts):
 *              GET  /api/health
 *              GET  /api/health/neo4j
 *              GET  /api/graph/stats
 *              POST /api/query          (allow-listed named query templates)
 *
 *   supabase  the Supabase Edge Functions deployment, which reads Neo4j over
 *              the HTTPS Query API:
 *              GET  <base>/health-check
 *              GET  <base>/get-career-details?id=<career>
 *              POST <base>/get-career-path
 *
 * Usage:
 *   node scripts/verify-neo4j.mjs [URL] [options]
 *
 *   URL                    Backend origin for the Node backend, or the
 *                          /functions/v1 base for a Supabase deployment.
 *                          Default: http://127.0.0.1:${PORT||3000}
 *   --kind=auto|node|supabase
 *                          Which contract to verify (default: auto).
 *   --timeout=MS           Per-request timeout in ms (default 15000).
 *   --query=ID             Named query template to execute (node mode).
 *                          Default: career.longest-prereq-chain
 *   --career=ID            Career id used as the query parameter.
 *   --json                 Print a machine-readable JSON report.
 *   --help                 Show this help.
 *
 * Verdicts (exit codes):
 *   PASS    (0) every mandatory check passed: a real query ran against Neo4j
 *           and the response identified Neo4j as its source.
 *   FAIL    (1) a reachable service broke the contract it claims to implement.
 *   BLOCKED (2) verification could not be completed: the service is not
 *           deployed/reachable, or its database is unavailable or unconfigured.
 *
 * Credentials are never read, printed or sent by this script. The URL is
 * redacted (userinfo stripped) before it is printed.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const OUTCOME = /** @type {const} */ ({ PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED' })
const DEFAULT_QUERY_ID = 'career.longest-prereq-chain'
const DEFAULT_CAREER_ID = 'career:software-engineer'

/* -------------------------------------------------------------------------- */
/* Command line                                                               */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = {
    target: '',
    kind: 'auto',
    timeoutMs: 15_000,
    queryId: DEFAULT_QUERY_ID,
    careerId: DEFAULT_CAREER_ID,
    json: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg.startsWith('--kind=')) { options.kind = arg.slice('--kind='.length).trim().toLowerCase(); continue }
    if (arg.startsWith('--timeout=')) {
      const value = Number(arg.slice('--timeout='.length))
      if (Number.isFinite(value) && value >= 1000) options.timeoutMs = Math.min(value, 120_000)
      continue
    }
    if (arg.startsWith('--query=')) { options.queryId = arg.slice('--query='.length).trim(); continue }
    if (arg.startsWith('--career=')) { options.careerId = arg.slice('--career='.length).trim(); continue }
    if (arg.startsWith('--')) continue
    options.target = arg
  }
  if (!options.target) options.target = `http://127.0.0.1:${process.env.PORT ?? '3000'}`
  return options
}

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  console.log(`Usage: node scripts/verify-neo4j.mjs [URL] [--kind=auto|node|supabase] [--timeout=MS] [--query=ID] [--career=ID] [--json]`)
  process.exit(0)
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where the human-readable narration goes.
 *
 * With --json, stdout carries the report and nothing else, so the output can
 * be piped into a parser without stripping anything by hand.
 */
const narrate = options.json ? console.error : console.log

const checks = []
/** The worst outcome wins: a FAIL anywhere is a FAIL, otherwise a BLOCKED. */
function worst(a, b) {
  if (a === OUTCOME.FAIL || b === OUTCOME.FAIL) return OUTCOME.FAIL
  if (a === OUTCOME.BLOCKED || b === OUTCOME.BLOCKED) return OUTCOME.BLOCKED
  return OUTCOME.PASS
}

function record(name, outcome, detail, extra = {}) {
  checks.push({ name, outcome, ...(detail ? { detail } : {}), ...extra })
  const mark = outcome === OUTCOME.PASS ? 'ok  ' : outcome === OUTCOME.FAIL ? 'FAIL' : 'BLOCK'
  narrate(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`)
  return outcome
}

/* -------------------------------------------------------------------------- */
/* URL handling                                                               */
/* -------------------------------------------------------------------------- */

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')
}

/** Strips credentials and query/hash so a URL can safely be printed. */
function safeUrl(url) {
  try {
    const copy = new URL(url)
    copy.username = ''
    copy.password = ''
    copy.search = ''
    copy.hash = ''
    return copy.toString().replace(/\/$/, '')
  } catch {
    return '(unparseable URL)'
  }
}

let base
try {
  base = new URL(options.target)
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('HTTP(S) URL required')
  if (base.username || base.password) throw new Error('the URL must not carry credentials')
} catch (error) {
  // The target is printed redacted: a URL can carry a password, and this
  // script must never put one in a log.
  console.error(`FAIL — invalid backend URL: ${safeUrl(options.target)} (${error instanceof Error ? error.message : 'unparseable'})`)
  console.error('Pass an absolute http(s) origin, e.g. https://your-service.onrender.com')
  process.exit(1)
}

if (base.protocol === 'http:' && !isLocalHost(base.hostname)) {
  console.error(`FAIL — refusing to verify a public backend over plain http: ${safeUrl(base)}`)
  console.error('Production backends must be reached over https.')
  process.exit(1)
}

base.pathname = base.pathname.replace(/\/+$/, '')
base.search = ''
base.hash = ''

const origin = `${base.protocol}//${base.host}`
/** Path prefix of the shared function contract, e.g. "/functions/v1". */
const functionBase = base.pathname.replace(/\/+$/, '')

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

async function request(url, init = {}) {
  const started = Date.now()
  let response
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const blocked = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout|abort/i.test(message)
    return { error: message, blocked, ms: Date.now() - started }
  }
  const text = await response.text().catch(() => '')
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { response, body, text, ms: Date.now() - started }
}

/* -------------------------------------------------------------------------- */
/* Dataset helpers (read from the generated seed — never invented)            */
/* -------------------------------------------------------------------------- */

/** Career ids that exist in the shipped dataset, so a query has a real target. */
function datasetCareerIds() {
  try {
    const seed = JSON.parse(readFileSync(resolve(root, 'neo4j', 'seed.parameters.json'), 'utf8'))
    const statement = (seed.statements ?? []).find((entry) => String(entry.tag).startsWith('nodes:Career'))
    const ids = (statement?.parameters?.rows ?? []).map((row) => String(row.id ?? '')).filter(Boolean)
    return ids
  } catch {
    return []
  }
}

const DATASET_CAREERS = datasetCareerIds()

/**
 * Picks a career that exists in the dataset. A hard-coded id that later leaves
 * the dataset would turn a working database into a false FAIL, so the list is
 * read from the generated seed file every run.
 */
function chooseCareer() {
  if (options.careerId && DATASET_CAREERS.includes(options.careerId)) return options.careerId
  if (options.careerId && DATASET_CAREERS.length === 0) return options.careerId
  if (DATASET_CAREERS.includes(DEFAULT_CAREER_ID)) return DEFAULT_CAREER_ID
  return DATASET_CAREERS[0] ?? options.careerId
}

const careerId = chooseCareer()

/* -------------------------------------------------------------------------- */
/* Node backend contract                                                      */
/* -------------------------------------------------------------------------- */

async function verifyNode() {
  let outcome = OUTCOME.PASS

  // 1. Liveness.
  const health = await request(`${origin}/api/health`)
  if (health.error) {
    return {
      outcome: record('GET /api/health', OUTCOME.BLOCKED,
        `the backend could not be reached (${health.error})`, { httpStatus: null }),
      evidence: null,
    }
  }
  const healthOk = health.response.ok && health.body?.ok === true &&
    typeof health.body?.service === 'string' && typeof health.body?.graphBackend === 'string'
  if (!healthOk) {
    return {
      outcome: record('GET /api/health', OUTCOME.FAIL,
        `liveness response did not match the contract (HTTP ${health.response.status})`, { httpStatus: health.response.status }),
      evidence: null,
    }
  }
  record('GET /api/health', OUTCOME.PASS,
    `HTTP ${health.response.status}, graph backend: ${health.body.graphBackend}`, { httpStatus: health.response.status })

  // 2. Real connectivity to Neo4j.
  const neo = await request(`${origin}/api/health/neo4j`)
  if (neo.error) {
    outcome = worst(outcome, record('GET /api/health/neo4j', OUTCOME.BLOCKED,
      `the backend could not be reached (${neo.error})`, { httpStatus: null }))
  } else if (neo.response.status === 503 && neo.body?.connected === false) {
    const reason = typeof neo.body.reason === 'string' ? neo.body.reason : 'Neo4j is unavailable on this deployment.'
    outcome = worst(outcome, record('GET /api/health/neo4j', OUTCOME.BLOCKED, reason, { httpStatus: 503 }))
  } else if (!neo.response.ok || neo.body?.ok !== true || neo.body?.connected !== true || neo.body?.backend !== 'neo4j') {
    outcome = worst(outcome, record('GET /api/health/neo4j', OUTCOME.FAIL,
      `the health response did not confirm a live Neo4j connection (HTTP ${neo.response.status})`, { httpStatus: neo.response.status }))
  } else {
    const nodes = Number(neo.body.nodes ?? 0)
    record('GET /api/health/neo4j', OUTCOME.PASS,
      `HTTP ${neo.response.status}, database "${neo.body.database ?? 'neo4j'}", ${nodes} node(s), ${neo.body.pingMs ?? '?'} ms ping`,
      { httpStatus: neo.response.status, database: neo.body.database ?? 'neo4j', nodes })
  }

  // 3. Live graph statistics, sourced from Neo4j.
  const stats = await request(`${origin}/api/graph/stats`)
  if (stats.error) {
    outcome = worst(outcome, record('GET /api/graph/stats', OUTCOME.BLOCKED,
      `the backend could not be reached (${stats.error})`, { httpStatus: null }))
  } else if (stats.response.status === 503) {
    // The backend is up and says its database is unavailable: an
    // infrastructure gap, not a broken contract.
    const reason = typeof stats.body?.reason === 'string' && stats.body.reason
      ? stats.body.reason
      : 'the backend reported that its graph database is unavailable.'
    outcome = worst(outcome, record('GET /api/graph/stats', OUTCOME.BLOCKED, reason, { httpStatus: 503 }))
  } else {
    const valid = stats.response.ok && stats.body?.ok === true && stats.body?.source === 'neo4j-live' &&
      Number.isSafeInteger(stats.body?.nodes) && stats.body.nodes > 0 &&
      Number.isSafeInteger(stats.body?.relationships) && stats.body.relationships >= 0 &&
      Array.isArray(stats.body?.labels)
    if (!valid) {
      outcome = worst(outcome, record('GET /api/graph/stats', OUTCOME.FAIL,
        `the statistics were not valid live Neo4j data (HTTP ${stats.response.status}, source ${JSON.stringify(stats.body?.source ?? null)})`,
        { httpStatus: stats.response.status }))
    } else {
      record('GET /api/graph/stats', OUTCOME.PASS,
        `${stats.body.nodes} node(s), ${stats.body.relationships} relationship(s), source ${stats.body.source}`,
        { httpStatus: stats.response.status, nodes: stats.body.nodes, relationships: stats.body.relationships, source: stats.body.source })
    }
  }

  // 4. The actual multi-hop Cypher query, through the allow-list.
  const query = await request(`${origin}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queryId: options.queryId, params: { careerId, limit: 10 } }),
  })
  let queryEvidence = null
  if (query.error) {
    outcome = worst(outcome, record('POST /api/query', OUTCOME.BLOCKED,
      `the backend could not be reached (${query.error})`, { httpStatus: null }))
  } else if (query.response.status === 503) {
    outcome = worst(outcome, record('POST /api/query', OUTCOME.BLOCKED,
      typeof query.body?.reason === 'string' ? query.body.reason : 'the backend reported that Neo4j is unavailable.',
      { httpStatus: 503 }))
  } else if (!query.response.ok) {
    outcome = worst(outcome, record('POST /api/query', OUTCOME.FAIL,
      `the named query did not complete (HTTP ${query.response.status})`, { httpStatus: query.response.status }))
  } else {
    const records = Array.isArray(query.body?.records) ? query.body.records : null
    const valid = query.body?.ok === true && query.body?.queryId === options.queryId &&
      query.body?.servedBy === 'neo4j-live' && query.body?.evidence?.driver === 'neo4j-javascript-driver' &&
      records !== null && records.length > 0 &&
      query.body?.rowCount === records.length && Number.isFinite(query.body?.executionMs)
    if (!valid) {
      const why = records === null
        ? 'the response carried no records array'
        : records.length === 0
          ? 'the query returned zero records'
          : 'the response did not match the query contract'
      outcome = worst(outcome, record('POST /api/query', OUTCOME.FAIL,
        `${why} (HTTP ${query.response.status}, source ${JSON.stringify(query.body?.servedBy ?? null)})`,
        { httpStatus: query.response.status }))
    } else {
      record('POST /api/query', OUTCOME.PASS,
        `query ${options.queryId} returned ${records.length} record(s) in ${query.body.executionMs} ms`,
        { httpStatus: query.response.status, queryId: options.queryId, rowCount: records.length, executionMs: query.body.executionMs, source: query.body.servedBy })
      queryEvidence = {
        queryId: options.queryId,
        rowCount: records.length,
        executionMs: query.body.executionMs,
        source: query.body.servedBy,
        driver: query.body.evidence?.driver ?? null,
        database: query.body.evidence?.database ?? null,
        requestId: query.body.requestId ?? null,
        cypher: typeof query.body.cypher === 'string' ? query.body.cypher : null,
        records: records.slice(0, 3),
      }
    }
  }

  // 5. The allow-list must reject anything that is not a known template.
  const injection = await request(`${origin}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queryId: 'arbitrary-cypher', params: {} }),
  })
  if (injection.error) {
    outcome = worst(outcome, record('POST /api/query (unknown template rejected)', OUTCOME.BLOCKED,
      `the backend could not be reached (${injection.error})`, { httpStatus: null }))
  } else if (injection.response.status === 400 && injection.body?.error === 'unknown_query') {
    record('POST /api/query (unknown template rejected)', OUTCOME.PASS,
      'arbitrary Cypher is refused with unknown_query (HTTP 400)', { httpStatus: 400 })
  } else {
    outcome = worst(outcome, record('POST /api/query (unknown template rejected)', OUTCOME.FAIL,
      `an unknown query template was not rejected (HTTP ${injection.response.status})`, { httpStatus: injection.response.status }))
  }

  // 6. A caller-supplied parameter must never become Cypher.
  const injected = await request(`${origin}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queryId: options.queryId, params: { careerId: "career:software-engineer' OR 1=1 //" } }),
  })
  if (injected.error) {
    outcome = worst(outcome, record('POST /api/query (parameter injection rejected)', OUTCOME.BLOCKED,
      `the backend could not be reached (${injected.error})`, { httpStatus: null }))
  } else if (injected.response.status === 400) {
    record('POST /api/query (parameter injection rejected)', OUTCOME.PASS,
      'an injected parameter is refused with HTTP 400', { httpStatus: 400 })
  } else if (injected.response.ok && Array.isArray(injected.body?.records) && injected.body.records.length === 0) {
    record('POST /api/query (parameter injection rejected)', OUTCOME.PASS,
      'an injected parameter is bound as a value and matches no record', { httpStatus: injected.response.status })
  } else {
    outcome = worst(outcome, record('POST /api/query (parameter injection rejected)', OUTCOME.FAIL,
      `an injected parameter was not handled safely (HTTP ${injected.response.status})`, { httpStatus: injected.response.status }))
  }

  return { outcome, evidence: queryEvidence }
}

/* -------------------------------------------------------------------------- */
/* Supabase Edge Functions contract                                           */
/* -------------------------------------------------------------------------- */

async function verifySupabase() {
  let outcome = OUTCOME.PASS

  const health = await request(`${origin}${functionBase}/health-check`)
  if (health.error) {
    return { outcome: record('GET /health-check', OUTCOME.BLOCKED,
      `the function could not be reached (${health.error})`, { httpStatus: null }), evidence: null }
  }
  const graph = health.body?.data?.graph
  if (!health.response.ok) {
    return { outcome: record('GET /health-check', OUTCOME.FAIL,
      `the health function answered HTTP ${health.response.status}`, { httpStatus: health.response.status }), evidence: null }
  }
  if (graph?.reachable !== true) {
    const reason = typeof graph?.message === 'string' ? graph.message : 'the deployment reports that its graph is not reachable.'
    return { outcome: record('GET /health-check', OUTCOME.BLOCKED, reason, { httpStatus: health.response.status }), evidence: null }
  }
  if (graph?.source !== 'neo4j-live') {
    return { outcome: record('GET /health-check', OUTCOME.FAIL,
      `the deployment reports source ${JSON.stringify(graph?.source ?? null)} instead of neo4j-live`,
      { httpStatus: health.response.status }), evidence: null }
  }
  record('GET /health-check', OUTCOME.PASS,
    `HTTP ${health.response.status}, ${graph.nodeCount ?? 0} node(s), ${graph.relationshipCount ?? 0} relationship(s), source ${graph.source}`,
    { httpStatus: health.response.status, nodes: graph.nodeCount ?? 0, relationships: graph.relationshipCount ?? 0, source: graph.source })

  // The career read: a real record set with real provenance.
  const details = await request(`${origin}${functionBase}/get-career-details?id=${encodeURIComponent(careerId)}`)
  if (details.error) {
    outcome = worst(outcome, record('GET /get-career-details', OUTCOME.BLOCKED,
      `the function could not be reached (${details.error})`, { httpStatus: null }))
  } else if (!details.response.ok || details.body?.ok !== true) {
    outcome = worst(outcome, record('GET /get-career-details', OUTCOME.FAIL,
      `the career read failed (HTTP ${details.response.status})`, { httpStatus: details.response.status }))
  } else if (details.body?.meta?.source !== 'neo4j-live') {
    outcome = worst(outcome, record('GET /get-career-details', OUTCOME.FAIL,
      `the response did not identify Neo4j as its source (source ${JSON.stringify(details.body?.meta?.source ?? null)})`,
      { httpStatus: details.response.status }))
  } else {
    const career = details.body?.data?.career
    const skills = Array.isArray(career?.skills) ? career.skills : []
    if (!career || career.id !== careerId || skills.length === 0) {
      outcome = worst(outcome, record('GET /get-career-details', OUTCOME.FAIL,
        `the career read returned no usable records for ${careerId}`, { httpStatus: details.response.status }))
    } else {
      record('GET /get-career-details', OUTCOME.PASS,
        `${career.name ?? careerId} with ${skills.length} required skill(s), source ${details.body.meta.source}`,
        { httpStatus: details.response.status, source: details.body.meta.source, rowCount: skills.length })
    }
  }

  // The multi-hop read: prerequisite closure over the graph.
  const path = await request(`${origin}${functionBase}/get-career-path`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ careerId, mode: 'prerequisites', maxDepth: 4 }),
  })
  let evidence = null
  if (path.error) {
    outcome = worst(outcome, record('POST /get-career-path', OUTCOME.BLOCKED,
      `the function could not be reached (${path.error})`, { httpStatus: null }))
  } else if (!path.response.ok || path.body?.ok !== true) {
    outcome = worst(outcome, record('POST /get-career-path', OUTCOME.FAIL,
      `the pathway query failed (HTTP ${path.response.status})`, { httpStatus: path.response.status }))
  } else if (path.body?.meta?.source !== 'neo4j-live') {
    outcome = worst(outcome, record('POST /get-career-path', OUTCOME.FAIL,
      `the response did not identify Neo4j as its source (source ${JSON.stringify(path.body?.meta?.source ?? null)})`,
      { httpStatus: path.response.status }))
  } else {
    const steps = Array.isArray(path.body?.data?.pathway?.steps) ? path.body.data.pathway.steps : []
    if (steps.length === 0) {
      outcome = worst(outcome, record('POST /get-career-path', OUTCOME.FAIL,
        'the pathway query returned no prerequisite steps', { httpStatus: path.response.status }))
    } else {
      record('POST /get-career-path', OUTCOME.PASS,
        `${steps.length} prerequisite step(s) for ${careerId}, source ${path.body.meta.source}`,
        { httpStatus: path.response.status, source: path.body.meta.source, rowCount: steps.length })
      evidence = {
        queryId: 'get-career-path',
        rowCount: steps.length,
        executionMs: path.body.meta?.queryMs ?? null,
        source: path.body.meta.source,
        driver: 'neo4j-https-query-api',
        records: steps.slice(0, 3),
      }
    }
  }

  return { outcome, evidence }
}

/* -------------------------------------------------------------------------- */
/* Kind detection                                                             */
/* -------------------------------------------------------------------------- */

async function detectKind() {
  if (options.kind === 'node' || options.kind === 'supabase') return options.kind
  if (functionBase.endsWith('/functions/v1')) return 'supabase'
  const probe = await request(`${origin}/api/health`)
  if (probe.error) return 'node'
  if (probe.response.status === 404) {
    const functionProbe = await request(`${functionBase}/health-check`)
    if (!functionProbe.error && functionProbe.response.ok) return 'supabase'
  }
  return 'node'
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

const kind = await detectKind()

narrate(`\nGraphMentor Neo4j verification`)
narrate(`Target: ${safeUrl(base)}${kind === 'supabase' ? ' (supabase edge functions)' : ' (node backend)'}`)
narrate(`Career under test: ${careerId}`)
narrate('-'.repeat(60))

const result = kind === 'supabase' ? await verifySupabase() : await verifyNode()
const outcome = result.outcome

narrate('-'.repeat(60))
if (outcome === OUTCOME.PASS && result.evidence) {
  narrate('Query ID:', result.evidence.queryId)
  narrate('Data source:', result.evidence.source)
  narrate('Record count:', result.evidence.rowCount)
  narrate('Execution time:', result.evidence.executionMs === null ? 'unavailable' : `${result.evidence.executionMs} ms`)
  if (result.evidence.cypher) narrate('Cypher:\n' + result.evidence.cypher)
  narrate('Query sample:')
  narrate(JSON.stringify(result.evidence.records, null, 2))
}
narrate('')
narrate('============================================================')
narrate({
  PASS: 'PASS — REAL NEO4J QUERY VERIFIED',
  BLOCKED: 'BLOCKED — EXTERNAL BACKEND OR NEO4J UNAVAILABLE',
  FAIL: 'FAIL — VERIFICATION FOUND A DEFECT',
}[outcome])
narrate('============================================================')

if (options.json) {
  console.log(JSON.stringify({
    outcome,
    target: safeUrl(base),
    kind,
    careerId,
    checks: checks.map(({ name, outcome: checkOutcome, detail, httpStatus }) => ({
      name, outcome: checkOutcome, ...(detail ? { detail } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}),
    })),
    evidence: result.evidence ?? null,
  }, null, 2))
}

process.exit(outcome === OUTCOME.PASS ? 0 : outcome === OUTCOME.BLOCKED ? 2 : 1)
