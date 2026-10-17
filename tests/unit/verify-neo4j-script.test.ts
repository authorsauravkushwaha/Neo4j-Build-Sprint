// @vitest-environment node
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/verify-neo4j.mjs', import.meta.url))

async function run(scriptPath: string, target: string): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, target], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output }))
  })
}

async function listen(handler: (path: string) => { status: number; body: unknown }): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://local.test').pathname
    const result = handler(path)
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

const healthy = (path: string) => {
  if (path === '/api/health') return { status: 200, body: { ok: true, graphBackend: 'neo4j' } }
  if (path === '/api/health/neo4j') return { status: 200, body: { ok: true, connected: true, backend: 'neo4j' } }
  if (path === '/api/graph/stats') return { status: 200, body: { ok: true, source: 'neo4j-live', nodes: 444, relationships: 1585, labels: [{ label: 'Career', count: 17 }] } }
  return { status: 200, body: {
    ok: true,
    queryId: 'career.longest-prereq-chain',
    servedBy: 'neo4j-live',
    evidence: { driver: 'neo4j-javascript-driver' },
    rowCount: 1,
    executionMs: 3,
    cypher: 'MATCH ...',
    records: [{ career: 'Software engineer', skill: 'Data structures', depth: 2, chain: ['Data structures', 'Programming'] }],
  } }
}

describe('verify-neo4j script', () => {
  it('has valid JavaScript syntax', async () => {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--check', script], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      child.stderr.on('data', (chunk) => { output += String(chunk) })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, output }))
    })
    expect(result.code).toBe(0)
  })

  it('returns PASS only when mock backend data satisfies the complete response contract', async () => {
    const { server, origin } = await listen(healthy)
    try {
      const result = await run(script, origin)
      expect(result.code).toBe(0)
      expect(result.output).toContain('PASS — REAL NEO4J QUERY VERIFIED')
      expect(result.output).toContain('Query ID: career.longest-prereq-chain')
      expect(result.output).toContain('Record count: 1')
      expect(result.output).toContain('3 ms')
    } finally { await close(server) }
  })

  it('returns BLOCKED with a non-zero exit when the target backend is unreachable', async () => {
    const result = await run(script, 'http://127.0.0.1:1')
    expect(result.code).toBe(2)
    expect(result.output).toContain('BLOCKED — EXTERNAL BACKEND OR NEO4J UNAVAILABLE')
  })

  it('returns FAIL when a reachable backend falsely omits valid graph stats', async () => {
    const { server, origin } = await listen((path) => path === '/api/graph/stats'
      ? { status: 200, body: { ok: true, source: 'postgres-live', nodes: 444, relationships: 1, labels: [] } }
      : healthy(path))
    try {
      const result = await run(script, origin)
      expect(result.code).toBe(1)
      expect(result.output).toContain('FAIL — VERIFICATION FOUND A DEFECT')
    } finally { await close(server) }
  })
})
