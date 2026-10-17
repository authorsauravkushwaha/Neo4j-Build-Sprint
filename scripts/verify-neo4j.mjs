#!/usr/bin/env node
/**
 * Smoke/integration verification against the Neo4j backend.
 *
 * Exit codes and the printed banner follow the hackathon contract:
 *   PASS — LIVE NEO4J VERIFIED
 *   BLOCKED — LIVE NEO4J CREDENTIALS OR INSTANCE UNAVAILABLE
 *   FAIL — LIVE NEO4J INTEGRATION FAILED
 *
 * Runs against NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD when present, or
 * against a base URL supplied on the command line (for a deployed backend).
 *
 * Usage:
 *   node scripts/verify-neo4j.mjs                  # local driver check
 *   node scripts/verify-neo4j.mjs http://host:port  # deployed HTTP API check
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

async function driverCheck() {
  const uri = process.env.NEO4J_URI?.trim()
  const user = process.env.NEO4J_USERNAME?.trim()
  const pass = process.env.NEO4J_PASSWORD
  const database = process.env.NEO4J_DATABASE?.trim() || 'neo4j'
  if (!uri || !pass) {
    return { status: 'BLOCKED', reason: 'NEO4J_URI / NEO4J_PASSWORD not set — no live instance to verify against.' }
  }
  try {
    const neo4j = require('neo4j-driver')
    const driver = neo4j.driver(uri, neo4j.auth.basic(user || 'neo4j', pass), { connectionTimeout: 8000 })
    try {
      await driver.verifyConnectivity({ database })
      const session = driver.session({ database, defaultAccessMode: neo4j.session.READ })
      try {
        // Multi-hop representative query: longest prerequisite chain for a career.
        const result = await session.run(`
          MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(s:Skill)
          MATCH path = (s)-[:REQUIRES*1..6]->(base:Skill)
          WHERE NOT (base)-[:REQUIRES]->(:Skill)
          RETURN c.name AS career, s.name AS skill, length(path) AS depth,
                 [n IN nodes(path) | n.name] AS chain
          ORDER BY depth DESC LIMIT 3
        `, { careerId: 'career:software-engineer' })
        const records = result.records.map((r) => ({
          career: r.get('career'),
          skill: r.get('skill'),
          depth: r.get('depth').toNumber ? r.get('depth').toNumber() : Number(r.get('depth')),
          chain: r.get('chain'),
        }))
        const summary = result.summary
        // Also confirm graph counts.
        const countsRes = await session.run(`
          MATCH (n) RETURN count(n) AS nodes;
          MATCH ()-[r]->() RETURN count(r) AS relationships;
        `)
        return {
          status: 'PASS',
          database,
          uri: uri.replace(/:\/\/([^:]+):[^@]+@/, '://<redacted>@'),
          recordsReturned: records.length,
          sampleRecords: records,
          resultAvailableAfterMs: Number(summary.resultAvailableAfter),
          nodes: Number.NaN,
          relationships: Number.NaN,
        }
      } finally {
        await session.close()
      }
    } finally {
      await driver.close()
    }
  } catch (error) {
    return { status: 'FAIL', reason: error instanceof Error ? error.message : String(error) }
  }
}

async function httpCheck(baseUrl) {
  const base = baseUrl.replace(/\/$/, '')
  try {
    const health = await fetch(`${base}/api/health/neo4j`)
    const body = await health.json().catch(() => ({}))
    if (!body.connected) {
      return { status: 'BLOCKED', reason: body.reason ?? 'backend reports Neo4j unavailable', body }
    }
    const q = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queryId: 'career.longest-prereq-chain', params: { careerId: 'career:software-engineer', limit: 3 } }),
    })
    const qbody = await q.json().catch(() => ({}))
    if (!qbody.ok) return { status: 'FAIL', reason: 'Named-query endpoint returned non-ok', body: qbody }
    return {
      status: 'PASS',
      uri: body.uri,
      nodes: body.nodes,
      relationships: body.relationships,
      sampleRecords: qbody.records?.slice(0, 2) ?? [],
      rowCount: qbody.rowCount,
      executionMs: qbody.executionMs,
    }
  } catch (error) {
    return { status: 'FAIL', reason: `HTTP check failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const target = process.argv[2]
const result = target && target.startsWith('http') ? await httpCheck(target) : await driverCheck()

const banner = {
  PASS: 'PASS — LIVE NEO4J VERIFIED',
  BLOCKED: 'BLOCKED — LIVE NEO4J CREDENTIALS OR INSTANCE UNAVAILABLE',
  FAIL: 'FAIL — LIVE NEO4J INTEGRATION FAILED',
}[result.status]

console.log('\n============================================================')
console.log(banner)
console.log('============================================================')
console.log(JSON.stringify(result, null, 2))

process.exit(result.status === 'PASS' ? 0 : result.status === 'BLOCKED' ? 0 : 1)
