// @vitest-environment node
/**
 * The repo-owned graph API (server/graphApi.ts), tested end to end: a real
 * HTTP server in front of a real (in-memory) PostgreSQL graph store, serving
 * the same shared handlers the Supabase Edge Functions serve.
 *
 * What is pinned here is the contract the React live client depends on:
 * the envelope shape, the provenance label, the POST-input path, CORS, and
 * honest 4xxs for anything else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'

import { createGraphApi, type GraphApi } from '../../server/graphApi.ts'
import { createInMemoryGraphStore } from '../../server/graphStore.ts'

let api: GraphApi
let server: Server
let base: string

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  const db = await createInMemoryGraphStore()
  api = await createGraphApi({
    env: { ALLOWED_ORIGINS: 'http://graph-allowed.test', LOG_LEVEL: 'error' },
    db,
  })
  server = createServer((request, response) => void api.handle(request, response))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  base = `http://127.0.0.1:${address.port}/functions/v1`
})

afterAll(async () => {
  await new Promise<void>((done) => {
    server.close(() => done())
    server.closeAllConnections()
  })
  await api.close()
})

describe('health-check reports the deployment database, not a bundle', () => {
  it('answers reachable, postgres-live, with counts straight from the tables', async () => {
    const response = await fetch(`${base}/health-check`)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.graph.configured).toBe(true)
    expect(body.data.graph.reachable).toBe(true)
    expect(body.data.graph.source).toBe('postgres-live')
    expect(body.data.graph.nodeCount).toBe(444)
    expect(body.data.graph.relationshipCount).toBe(1585)
    expect(body.meta.source).toBe('postgres-live')
    // The exact shape the frontend mapper reads (regression guard for the
    // bug where the client looked for graph.status/service-less fields).
    expect(body.data.service.version).toBeTruthy()
    expect(body.data.service.environment).toBeTruthy()
    expect(typeof body.data.ai.configured).toBe('boolean')
    expect(typeof body.data.storage.configured).toBe('boolean')
    expect(typeof body.data.security.requestSigningRequired).toBe('boolean')
  })
})

describe('curriculum reads against the database', () => {
  it('lists the whole catalogue with no hidden default truncation', async () => {
    const body = await (await fetch(`${base}/get-careers`)).json()
    expect(body.data.total).toBe(17)
    expect(body.meta.truncated).toBe(false)
    expect(body.meta.source).toBe('postgres-live')
  })

  it('applies a branch-only filter instead of returning the whole catalogue', async () => {
    const all = await (await fetch(`${base}/get-careers`)).json()
    const filtered = await (await fetch(`${base}/get-careers?branch=branch:mechanical`)).json()
    expect(filtered.data.total).toBeGreaterThan(0)
    expect(filtered.data.total).toBeLessThan(all.data.total)
    for (const career of filtered.data.careers) expect(career.branchIds).toContain('branch:mechanical')
  })

  it('serves the career detail with skills read from the store', async () => {
    const body = await (await fetch(`${base}/get-career-details?id=career:robotics-engineer`)).json()
    expect(body.data.career.name).toBe('Robotics engineer')
    expect(body.data.career.skills.length).toBeGreaterThan(5)
    expect(body.data.projects.length).toBeGreaterThan(0)
    expect(body.meta.source).toBe('postgres-live')
  })

  it('accepts the POST body the live client sends to get-graph', async () => {
    const response = await fetch(`${base}/get-graph`, {
      method: 'POST',
      ...json({ careerId: 'career:robotics-engineer', depth: 1, limit: 25 }),
    })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.graph.nodes.length).toBeGreaterThan(1)
    expect(body.data.graph.nodes.length).toBeLessThanOrEqual(25)
    expect(body.data.graph.edges.length).toBeGreaterThan(0)
    expect(body.meta.source).toBe('postgres-live')
    // A dangling edge can never be rendered: both endpoints in the payload.
    const ids = new Set(body.data.graph.nodes.map((node: { id: string }) => node.id))
    for (const edge of body.data.graph.edges) {
      expect(ids.has(edge.from) && ids.has(edge.to)).toBe(true)
    }
  })

  it('still serves get-graph over GET for shareable links and curl', async () => {
    const body = await (await fetch(`${base}/get-graph?careerId=career:robotics-engineer&depth=1&limit=15`)).json()
    expect(body.data.graph.nodes.length).toBeGreaterThan(1)
    expect(body.data.graph.nodes.length).toBeLessThanOrEqual(15)
  })

  it('takes the skillIds array form the client POSTs to get-resources', async () => {
    const body = await (
      await fetch(`${base}/get-resources`, {
        method: 'POST',
        ...json({ skillIds: ['skill:circuit-analysis'], limit: 5 }),
      })
    ).json()
    expect(body.resources ?? body.data.resources).toBeTruthy()
    expect(body.data.resources.length).toBeGreaterThan(0)
    expect(body.data.resources.length).toBeLessThanOrEqual(5)
    expect(body.meta.source).toBe('postgres-live')
  })

  it('answers the skill index for the command palette', async () => {
    const body = await (await fetch(`${base}/get-skills?q=circuit&limit=10`)).json()
    expect(body.data.skills.length).toBeGreaterThan(0)
  })

  it('runs analysis and roadmap generation over the database', async () => {
    const gaps = await (
      await fetch(`${base}/analyze-skill-gaps`, {
        method: 'POST',
        ...json({ careerId: 'career:robotics-engineer', ratings: [], interests: [], weeklyHours: 6 }),
      })
    ).json()
    expect(gaps.data.report.items.length).toBeGreaterThan(0)
    expect(gaps.meta.source).toBe('postgres-live')

    const roadmap = await (
      await fetch(`${base}/generate-learning-roadmap`, {
        method: 'POST',
        ...json({ careerId: 'career:robotics-engineer', ratings: [], interests: [], weeklyHours: 6, pace: 'steady', learningStyle: 'mixed' }),
      })
    ).json()
    expect(roadmap.data.roadmap.tasks.length).toBeGreaterThan(0)
    expect(roadmap.meta.source).toBe('postgres-live')
  })

  it('answers a mentor question from database context, labelled as such', async () => {
    const body = await (
      await fetch(`${base}/mentor-chat`, {
        method: 'POST',
        ...json({ message: 'What skills do I need for robotics?', mode: 'concise' }),
      })
    ).json()
    expect(body.data.answer.answer.length).toBeGreaterThan(40)
    expect(body.data.context.graphSource).toBe('postgres-live')
    // The read ledger: the graph queries behind the answer.
    expect(body.data.context.reads.length).toBeGreaterThan(0)
  })
})

describe('honest edges', () => {
  it('write endpoints answer 401, not a 404 that would look like a bug', async () => {
    const response = await fetch(`${base}/save-roadmap`, {
      method: 'POST',
      ...json({ careerId: 'career:robotics-engineer', weeklyHours: 5, pace: 'steady', tasks: [] }),
    })
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('unauthorized')
  })

  it('unknown endpoints 404 with the shared envelope', async () => {
    const response = await fetch(`${base}/no-such-endpoint`)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('not_found')
  })

  it('wrong methods 405 with the allowed list', async () => {
    const response = await fetch(`${base}/get-careers`, { method: 'DELETE' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toContain('GET')
  })

  it('a non-object POST body is a 400, never a silent default', async () => {
    const response = await fetch(`${base}/get-graph`, { method: 'POST', ...json([1, 2, 3]) })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('bad_request')
  })
})

describe('CORS allow-list', () => {
  it('answers preflights from allow-listed origins only', async () => {
    const allowed = await fetch(`${base}/get-careers`, {
      method: 'OPTIONS',
      headers: { origin: 'http://graph-allowed.test', 'access-control-request-method': 'GET' },
    })
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://graph-allowed.test')

    const unlisted = await fetch(`${base}/get-careers`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET' },
    })
    // No CORS headers: the browser blocks the read — the response itself still 204s.
    expect(unlisted.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('the store is the source of truth', () => {
  it('an operator edit becomes visible without a redeploy', async () => {
    const before = await (await fetch(`${base}/get-career-details?id=career:robotics-engineer`)).json()
    expect(before.data.career.summary).not.toBe('Changed in the database.')

    const db = api.db
    await db.query("update graph.documents set doc = jsonb_set(doc, '{summary}', '\"Changed in the database.\"'::jsonb) where bucket = 'careers' and id = 'career:robotics-engineer'")
    await db.query('select graph.bump()')

    // The reader's refresh budget is 1s; wait past it, then ask again.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const after = await (await fetch(`${base}/get-career-details?id=career:robotics-engineer`)).json()
    expect(after.data.career.summary).toBe('Changed in the database.')
  })
})
