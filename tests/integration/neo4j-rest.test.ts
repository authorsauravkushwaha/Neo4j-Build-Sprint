// @vitest-environment node
/**
 * REST API contract tests against the Node graphApi when Neo4j is *not*
 * configured. The point here is to prove that:
 *   - /api/health/neo4j reports 503 honestly (never 200 with fake numbers).
 *   - /api/query refuses unknown query ids (no arbitrary Cypher path).
 *   - The read ledger records failures honestly.
 *   - CORS preflight is answered without touching the graph.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'

import { createGraphApi, type GraphApi } from '../../server/graphApi.ts'
import type { DriverReader } from '../../server/neo4jDriverReader.ts'

let api: GraphApi
let server: Server
let base: string

beforeAll(async () => {
  // No NEO4J_*, no pgDb — Neo4j is unavailable by design.
  api = await createGraphApi({
    env: { ALLOWED_ORIGINS: 'http://graph-allowed.test', LOG_LEVEL: 'error' },
  })
  server = createServer((request, response) => void api.handle(request, response))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((done) => {
    server.close(() => done())
    server.closeAllConnections()
  })
  await api.close()
})

describe('Neo4j health endpoint is honest when no instance is configured', () => {
  it('/api/health reports graphBackend "none"', async () => {
    const r = await fetch(`${base}/api/health`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(body.graphBackend).toBe('none')
  })

  it('/api/health/neo4j returns 503 with a truthful reason, never a fake "connected"', async () => {
    const r = await fetch(`${base}/api/health/neo4j`)
    expect(r.status).toBe(503)
    const body = await r.json()
    expect(body.ok).toBe(false)
    expect(body.connected).toBe(false)
    expect(body.reason).toMatch(/NEO4J/)
  })

  it('/api/graph/stats returns 503 instead of inventing counts', async () => {
    const r = await fetch(`${base}/api/graph/stats`)
    expect(r.status).toBe(503)
    const body = await r.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('Neo4j unavailable')
  })

  it('/api/query rejects unknown query ids (no arbitrary Cypher path)', async () => {
    const r = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queryId: 'DROP DATABASE neo4j' }),
    })
    expect(r.status).toBe(400)
    const body = await r.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('unknown_query')
    expect(Array.isArray(body.allowedQueryIds)).toBe(true)
    // The allow-list must contain only the curated named queries.
    for (const id of body.allowedQueryIds as string[]) {
      expect(id).toMatch(/^[a-z][a-z0-9.-]+$/)
      expect(id).not.toMatch(/(drop|delete|create|set|remove|merge)/i)
    }
  })

  it('/api/query 503s for known ids when Neo4j is down instead of returning sample data', async () => {
    const r = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queryId: 'graph.stats' }),
    })
    expect(r.status).toBe(503)
    const body = await r.json()
    expect(body.ok).toBe(false)
  })

  it('/api/ledger/recent records the failures honestly', async () => {
    // First, generate two known requests.
    await fetch(`${base}/api/health/neo4j`)
    await fetch(`${base}/api/graph/stats`)
    const r = await fetch(`${base}/api/ledger/recent`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.entries)).toBe(true)
    const failed = body.entries.filter((e: { status: string }) => e.status === 'error')
    expect(failed.length).toBeGreaterThan(0)
    for (const entry of failed as Array<{ servedBy: string; queryId: string }>) {
      // No reader is configured: failed health/stats entries must not claim
      // that they served Neo4j or PostgreSQL results.
      expect(entry.servedBy).toBe('unavailable')
      expect(entry.queryId).toMatch(/^(REST:|NAMED:|[A-Z_]+)/)
    }
  })

  it('answers OPTIONS preflights with CORS headers for allowed origins', async () => {
    const r = await fetch(`${base}/api/health`, {
      method: 'OPTIONS',
      headers: { origin: 'http://graph-allowed.test', 'access-control-request-method': 'GET' },
    })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe('http://graph-allowed.test')
  })
})

// Contract-only mock: proves source metadata and safe parameter binding without
// claiming that a real Neo4j instance was reached in this test environment.
describe('named query contract with an injected Neo4j driver reader', () => {
  it('returns driver provenance and keeps all user values in bound parameters', async () => {
    const calls: Array<{ cypher: string; params: Record<string, unknown>; tag: string }> = []
    const mock = {
      kind: 'neo4j', configured: true, provenance: 'test reader', uri: 'bolt://test.invalid:7687',
      async runQuery(cypher: string, params: Record<string, unknown>, tag: string) {
        calls.push({ cypher, params, tag })
        return { rows: [{ career: 'Software engineer', skill: 'Testing', depth: 2, chain: ['Testing', 'Programming'] }], ms: 4, summary: {} }
      },
      async totals() { return { value: { nodes: 444, relationships: 1585, labels: [{ label: 'Career', count: 17 }] }, ms: 2 } },
      async close() {},
    } as unknown as DriverReader
    const testApi = await createGraphApi({
      env: { NEO4J_URI: 'bolt://test.invalid:7687', NEO4J_PASSWORD: 'test-only', LOG_LEVEL: 'error' },
      neo4jReader: mock,
    })
    const testServer = createServer((request, response) => void testApi.handle(request, response))
    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve))
    const address = testServer.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    const testBase = `http://127.0.0.1:${address.port}`
    try {
      const stats = await (await fetch(`${testBase}/api/graph/stats`)).json()
      expect(stats.source).toBe('neo4j-live')
      expect(stats.nodes).toBe(444)
      const response = await fetch(`${testBase}/api/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryId: 'career.longest-prereq-chain', params: { careerId: 'career:software-engineer', limit: 10 } }),
      })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.servedBy).toBe('neo4j-live')
      expect(body.evidence.driver).toBe('neo4j-javascript-driver')
      expect(body.records).toHaveLength(1)
      expect(calls[0]?.cypher).toContain('$careerId')
      expect(calls[0]?.cypher).not.toContain('career:software-engineer')
      expect(calls[0]?.params.careerId).toBe('career:software-engineer')
      expect(calls[0]?.tag).toBe('NAMED:career.longest-prereq-chain')
    } finally {
      await new Promise<void>((resolve) => { testServer.close(() => resolve()); testServer.closeAllConnections() })
      await testApi.close()
    }
  })
})
