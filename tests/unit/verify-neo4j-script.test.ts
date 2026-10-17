// @vitest-environment node
/**
 * The verification script is the project's evidence of a live Neo4j
 * connection, so its verdicts are pinned here: PASS only for a real,
 * non-empty, Neo4j-sourced query; FAIL for a reachable service that breaks
 * its contract; BLOCKED for anything that is an infrastructure gap.
 *
 * These are mock-backend tests. They prove the *verifier's* logic; they are
 * not a live database verification, and the script never reports a mock as
 * one — it only reads what the service actually returned.
 */
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/verify-neo4j.mjs', import.meta.url))

async function run(args: string[]): Promise<{ code: number | null; output: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output: stdout + stderr, stdout }))
  })
}

type Reply = { status: number; body: unknown }

const neo4jQueryReply: Reply = {
  status: 200,
  body: {
    ok: true,
    requestId: 'req-1',
    queryId: 'career.longest-prereq-chain',
    servedBy: 'neo4j-live',
    source: 'neo4j-live',
    evidence: { driver: 'neo4j-javascript-driver', database: 'neo4j' },
    rowCount: 1,
    executionMs: 3,
    cypher: 'MATCH ...',
    records: [{ career: 'Software engineer', skill: 'Data structures', depth: 2, chain: ['Data structures', 'Programming'] }],
  },
}

/** A Node backend that answers every documented route correctly. */
function nodeBackend(overrides: Record<string, Reply> = {}): (path: string, body: unknown) => Reply {
  return (path, body) => {
    void body
    if (overrides[path]) return overrides[path]
    if (path === '/api/health') return { status: 200, body: { ok: true, service: 'graphmentor-neo4j-backend', graphBackend: 'neo4j' } }
    if (path === '/api/health/neo4j') {
      return {
        status: 200,
        body: { ok: true, connected: true, backend: 'neo4j', database: 'neo4j', nodes: 444, relationships: 1585, pingMs: 4 },
      }
    }
    if (path === '/api/graph/stats') {
      return { status: 200, body: { ok: true, source: 'neo4j-live', nodes: 444, relationships: 1585, labels: [{ label: 'Career', count: 17 }] } }
    }
    if (path === '/api/query') {
      const request = (body ?? {}) as { queryId?: string; params?: { careerId?: string } }
      if (request.queryId !== 'career.longest-prereq-chain') {
        return { status: 400, body: { ok: false, error: 'unknown_query', allowedQueryIds: ['career.longest-prereq-chain'] } }
      }
      if (request.params?.careerId && !/^career:[a-z0-9-]+$/.test(request.params.careerId)) {
        return { status: 400, body: { ok: false, error: 'invalid_params', message: '"careerId" is not a valid node identifier.' } }
      }
      return neo4jQueryReply
    }
    return { status: 404, body: { ok: false, error: { code: 'not_found', message: 'Unknown endpoint.' } } }
  }
}

/** A Supabase Edge Functions deployment that answers the function contract. */
function supabaseBackend(overrides: Record<string, Reply> = {}): (path: string, body: unknown) => Reply {
  return (path, body) => {
    void body
    if (overrides[path]) return overrides[path]
    if (path === '/functions/v1/health-check') {
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            graph: { configured: true, reachable: true, source: 'neo4j-live', nodeCount: 444, relationshipCount: 1585 },
            ai: { configured: false, provider: 'none' },
            storage: { configured: false },
            security: { requestSigningRequired: false },
            service: { version: '1.0.0', environment: 'production' },
          },
          meta: { source: 'neo4j-live' },
        },
      }
    }
    if (path === '/functions/v1/get-career-details') {
      return {
        status: 200,
        body: {
          ok: true,
          data: { career: { id: 'career:software-engineer', name: 'Software engineer', skills: [{ id: 'skill:programming-fundamentals' }] } },
          meta: { source: 'neo4j-live' },
        },
      }
    }
    if (path === '/functions/v1/get-career-path') {
      return {
        status: 200,
        body: {
          ok: true,
          data: { pathway: { steps: [{ skillId: 'skill:programming-fundamentals' }, { skillId: 'skill:data-structures-and-algorithms' }] } },
          meta: { source: 'neo4j-live', queryMs: 12 },
        },
      }
    }
    return { status: 404, body: { ok: false, error: { code: 'not_found', message: 'Unknown endpoint.' } } }
  }
}

async function listen(handler: (path: string, body: unknown) => Reply): Promise<{ server: Server; origin: string }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://local.test').pathname
      let body: unknown = null
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null } catch { body = null }
      const result = handler(path, body)
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

describe('verify-neo4j script', () => {
  it('has valid JavaScript syntax', async () => {
    const result = await new Promise<{ code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--check', script], { stdio: ['ignore', 'pipe', 'pipe'] })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code }))
    })
    expect(result.code).toBe(0)
  })

  it('returns PASS only when the backend satisfies the complete response contract', async () => {
    const { server, origin } = await listen(nodeBackend())
    try {
      const result = await run([origin])
      expect(result.code).toBe(0)
      expect(result.output).toContain('PASS — REAL NEO4J QUERY VERIFIED')
      expect(result.output).toContain('Query ID: career.longest-prereq-chain')
      expect(result.output).toContain('Record count: 1')
      expect(result.output).toContain('3 ms')
      expect(result.output).toContain('Data source: neo4j-live')
    } finally { await close(server) }
  })

  it('returns BLOCKED with a non-zero exit when the target backend is unreachable', async () => {
    const result = await run(['http://127.0.0.1:1'])
    expect(result.code).toBe(2)
    expect(result.output).toContain('BLOCKED — EXTERNAL BACKEND OR NEO4J UNAVAILABLE')
  })

  it('returns BLOCKED when the backend is up but its database is unavailable', async () => {
    const { server, origin } = await listen(nodeBackend({
      '/api/health/neo4j': { status: 503, body: { ok: false, connected: false, backend: 'none', reason: 'No NEO4J_* credentials are set.' } },
    }))
    try {
      const result = await run([origin])
      expect(result.code).toBe(2)
      expect(result.output).toContain('BLOCKED — EXTERNAL BACKEND OR NEO4J UNAVAILABLE')
      expect(result.output).toContain('No NEO4J_* credentials are set.')
    } finally { await close(server) }
  })

  it('returns FAIL when a reachable backend falsely omits valid graph stats', async () => {
    const { server, origin } = await listen(nodeBackend({
      '/api/graph/stats': { status: 200, body: { ok: true, source: 'postgres-live', nodes: 444, relationships: 1, labels: [] } },
    }))
    try {
      const result = await run([origin])
      expect(result.code).toBe(1)
      expect(result.output).toContain('FAIL — VERIFICATION FOUND A DEFECT')
    } finally { await close(server) }
  })

  it('returns FAIL when the query response is not labelled as Neo4j', async () => {
    const { server, origin } = await listen(nodeBackend({
      '/api/query': { status: 200, body: { ...(neo4jQueryReply.body as Record<string, unknown>), servedBy: 'postgres-live' } },
    }))
    try {
      const result = await run([origin])
      expect(result.code).toBe(1)
      expect(result.output).toContain('FAIL — VERIFICATION FOUND A DEFECT')
    } finally { await close(server) }
  })

  it('returns FAIL when the query returns no records', async () => {
    const { server, origin } = await listen(nodeBackend({
      '/api/query': { status: 200, body: { ...(neo4jQueryReply.body as Record<string, unknown>), records: [], rowCount: 0 } },
    }))
    try {
      const result = await run([origin])
      expect(result.code).toBe(1)
      expect(result.output).toContain('FAIL — VERIFICATION FOUND A DEFECT')
    } finally { await close(server) }
  })

  it('returns FAIL when an unknown query template is not rejected', async () => {
    const { server, origin } = await listen(nodeBackend({
      '/api/query': neo4jQueryReply,
    }))
    // The override makes every /api/query call answer like a valid query, so
    // the allow-list check must fail.
    try {
      const result = await run([origin])
      expect(result.code).toBe(1)
      expect(result.output).toContain('unknown template rejected')
    } finally { await close(server) }
  })

  it('rejects a malformed URL before making any request', async () => {
    const result = await run(['not-a-url'])
    expect(result.code).toBe(1)
    expect(result.output).toContain('invalid backend URL')
  })

  it('refuses to verify a public backend over plain http', async () => {
    const result = await run(['http://example.com'])
    expect(result.code).toBe(1)
    expect(result.output).toContain('refusing to verify a public backend over plain http')
  })

  it('verifies a Supabase deployment through its own function routes', async () => {
    const { server, origin } = await listen(supabaseBackend())
    try {
      const result = await run([`${origin}/functions/v1`])
      expect(result.code).toBe(0)
      expect(result.output).toContain('PASS — REAL NEO4J QUERY VERIFIED')
      expect(result.output).toContain('Query ID: get-career-path')
      expect(result.output).toContain('supabase edge functions')
    } finally { await close(server) }
  })

  it('returns BLOCKED when a Supabase deployment reports an unreachable graph', async () => {
    const { server, origin } = await listen(supabaseBackend({
      '/functions/v1/health-check': {
        status: 200,
        body: { ok: true, data: { graph: { configured: true, reachable: false, source: 'unavailable', message: 'The graph could not be reached.' } } },
      },
    }))
    try {
      const result = await run([`${origin}/functions/v1`])
      expect(result.code).toBe(2)
      expect(result.output).toContain('BLOCKED — EXTERNAL BACKEND OR NEO4J UNAVAILABLE')
    } finally { await close(server) }
  })

  it('returns FAIL when a Supabase deployment does not claim Neo4j as its source', async () => {
    const { server, origin } = await listen(supabaseBackend({
      '/functions/v1/health-check': {
        status: 200,
        body: { ok: true, data: { graph: { configured: true, reachable: true, source: 'local-sample', nodeCount: 444 } } },
      },
    }))
    try {
      const result = await run([`${origin}/functions/v1`])
      expect(result.code).toBe(1)
      expect(result.output).toContain('FAIL — VERIFICATION FOUND A DEFECT')
    } finally { await close(server) }
  })

  it('prints a machine-readable report on request', async () => {
    const { server, origin } = await listen(nodeBackend())
    try {
      const result = await run([origin, '--json'])
      expect(result.code).toBe(0)
      // With --json, stdout carries the report and nothing else.
      const json = JSON.parse(result.stdout)
      expect(json.outcome).toBe('PASS')
      expect(json.kind).toBe('node')
      expect(json.evidence.source).toBe('neo4j-live')
      expect(json.evidence.rowCount).toBe(1)
      expect(json.checks.every((check: { outcome: string }) => check.outcome === 'PASS')).toBe(true)
    } finally { await close(server) }
  })

  it('never prints credentials that were supplied in the URL', async () => {
    const result = await run(['http://user:secret@127.0.0.1:1'])
    // Credentials in a URL are refused outright, and the secret is not echoed.
    expect(result.code).toBe(1)
    expect(result.output).not.toContain('secret')
  })
})
