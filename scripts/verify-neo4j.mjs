#!/usr/bin/env node
/** Verify the actual GraphMentor HTTP backend (local or deployed). */
const target = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`
let base
try {
  base = new URL(target)
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('HTTP(S) URL required')
} catch {
  console.error(`FAIL — invalid backend URL: ${target}`)
  process.exit(1)
}
base.pathname = base.pathname.replace(/\/$/, '')
base.search = ''
base.hash = ''
const root = base.toString().replace(/\/$/, '')
const checks = []

async function request(path, init = {}) {
  const started = Date.now()
  try {
    const response = await fetch(`${root}${path}`, { ...init, signal: AbortSignal.timeout(12_000) })
    const text = await response.text()
    let body
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    return { response, body, ms: Date.now() - started }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }
  }
}

function logCheck(name, result) {
  const status = result.response?.status ?? 'NO HTTP RESPONSE'
  console.log(`${name}: HTTP ${status}${result.ms !== undefined ? ` (${result.ms} ms)` : ''}`)
  checks.push({ name, ...result })
}

let verdict = 'PASS'
let reason = ''

const health = await request('/api/health')
logCheck('/api/health', health)
if (health.error) {
  verdict = 'BLOCKED'
  reason = `Backend could not be reached: ${health.error}`
} else if (!health.response.ok || health.body?.ok !== true || typeof health.body?.graphBackend !== 'string') {
  verdict = health.response.status === 404 ? 'BLOCKED' : 'FAIL'
  reason = `Backend liveness response was invalid (HTTP ${health.response.status}).`
}

if (verdict === 'PASS') {
  const neoHealth = await request('/api/health/neo4j')
  logCheck('/api/health/neo4j', neoHealth)
  if (neoHealth.error) {
    verdict = 'BLOCKED'
    reason = `Neo4j health check could not be reached: ${neoHealth.error}`
  } else if (neoHealth.response.status === 503 && neoHealth.body?.connected === false) {
    verdict = 'BLOCKED'
    reason = neoHealth.body.reason ?? 'Backend is reachable but Neo4j is unavailable.'
  } else if (!neoHealth.response.ok || neoHealth.body?.ok !== true || neoHealth.body?.connected !== true || neoHealth.body?.backend !== 'neo4j') {
    verdict = 'FAIL'
    reason = `Neo4j health response did not confirm a live Neo4j connection (HTTP ${neoHealth.response.status}).`
  }

  if (verdict === 'PASS') {
    const stats = await request('/api/graph/stats')
    logCheck('/api/graph/stats', stats)
    const statsValid = stats.body?.ok === true && stats.body?.source === 'neo4j-live' &&
      Number.isSafeInteger(stats.body?.nodes) && stats.body.nodes > 0 &&
      Number.isSafeInteger(stats.body?.relationships) && stats.body.relationships >= 0 &&
      Array.isArray(stats.body?.labels)
    if (!stats.response?.ok || !statsValid) {
      verdict = 'FAIL'
      reason = `Graph statistics were not valid live Neo4j data (HTTP ${stats.response?.status ?? 'none'}).`
    }
  }

  if (verdict === 'PASS') {
    const queryId = 'career.longest-prereq-chain'
    const query = await request('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ queryId, params: { careerId: 'career:software-engineer', limit: 10 } }),
    })
    logCheck('/api/query', query)
    const resultValid = query.body?.ok === true && query.body?.queryId === queryId &&
      query.body?.servedBy === 'neo4j-live' && query.body?.evidence?.driver === 'neo4j-javascript-driver' &&
      Array.isArray(query.body?.records) && query.body.records.length > 0 &&
      query.body.rowCount === query.body.records.length &&
      query.body.records.every((row) => typeof row.career === 'string' && typeof row.skill === 'string' &&
        Number.isFinite(row.depth) && Array.isArray(row.chain) && row.chain.length >= 2)
    console.log(`Query ID: ${query.body?.queryId ?? queryId}`)
    console.log(`Record count: ${Number.isInteger(query.body?.rowCount) ? query.body.rowCount : 'unavailable'}`)
    console.log(`Execution time: ${Number.isFinite(query.body?.executionMs) ? `${query.body.executionMs} ms` : 'unavailable'}`)
    if (!query.response?.ok || !resultValid) {
      verdict = 'FAIL'
      reason = `The named multi-hop query did not return valid, non-empty Neo4j records (HTTP ${query.response?.status ?? 'none'}).`
    } else {
      console.log('Query sample:')
      console.log(JSON.stringify(query.body.records.slice(0, 3), null, 2))
      console.log(`Cypher: ${query.body.cypher}`)
    }
  }
}

console.log('\n============================================================')
console.log({ PASS: 'PASS — REAL NEO4J QUERY VERIFIED', BLOCKED: 'BLOCKED — EXTERNAL BACKEND OR NEO4J UNAVAILABLE', FAIL: 'FAIL — VERIFICATION FOUND A DEFECT' }[verdict])
console.log('============================================================')
if (reason) console.log(`Reason: ${reason}`)
for (const item of checks) {
  if (item.body?.reason && verdict !== 'PASS') console.log(`${item.name} reason: ${item.body.reason}`)
}
process.exit(verdict === 'PASS' ? 0 : verdict === 'BLOCKED' ? 2 : 1)
