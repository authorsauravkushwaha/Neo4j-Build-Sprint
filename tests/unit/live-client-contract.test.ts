// @vitest-environment jsdom
/**
 * The pinned contract between the browser's live client (src/core/api.ts) and
 * the deployed handlers (supabase/functions/_shared/handlers/*).
 *
 * The sample-data banner once appeared even against a healthy backend because
 * this client's health() read fields the health-check payload has never
 * contained (`graph.status`, top-level `environment`/`version`), and because
 * three catalogue endpoints only read query parameters while the client POSTs
 * JSON bodies. These tests run the live client against responses produced by
 * the REAL handlers, so the two sides can never silently drift apart again.
 */
import { describe, expect, it, vi } from 'vitest'

import { createLiveClient, type LiveClientOptions } from '@/core/api.ts'
import type { GraphReader } from '@core/graphReader.ts'
import { createLocalReader } from '@core/localReader.ts'
import { assembleRuntime, readRuntimeConfig } from '../../supabase/functions/_shared/runtime.ts'
import { healthCheckHandler } from '../../supabase/functions/_shared/handlers/health.ts'
import { getCareersHandler } from '../../supabase/functions/_shared/handlers/careers.ts'
import { MemoryFixedWindowStore, MemoryNonceStore } from '@core/rateLimit.ts'
import { makeRequest } from '../helpers/runtime.ts'
import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'

/** A reader just real enough for the handlers used below. */
function stubReader(kind: 'neo4j' | 'postgres' | 'local', totalsError?: Error): GraphReader {
  const base = {
    kind,
    provenance: 'contract-test reader',
    configured: true,
    async totals() {
      if (totalsError) throw totalsError
      return {
        value: {
          nodes: 444,
          relationships: 1585,
          labels: [{ label: 'Career', count: knowledgeGraph.careers.length }],
        },
        ms: 1,
      }
    },
  }
  const fail = async (): Promise<never> => {
    throw new Error('not implemented in the contract stub')
  }
  return {
    ...base,
    listCareers: fail,
    searchCareers: fail,
    listBranches: fail,
    getCareer: fail,
    getCareerSkills: fail,
    getCareerClosure: fail,
    getSkillEdges: fail,
    listSkillIndex: fail,
    getSkill: fail,
    getSkillClosure: fail,
    getDownstream: fail,
    getRoutes: fail,
    getNeighborhood: fail,
    getEdgesAmong: fail,
    findProjects: fail,
    findResources: fail,
    getAssessments: fail,
    getModules: fail,
  } as unknown as GraphReader
}

/** Run a real handler and convert its HttpResponse into a fetch Response. */
async function handlerResponse(
  handler: (runtime: ReturnType<typeof makeRuntime>, request: ReturnType<typeof makeRequest>) => ReturnType<typeof healthCheckHandler>,
  runtime: ReturnType<typeof makeRuntime>,
  request: ReturnType<typeof makeRequest>,
): Promise<Response> {
  const result = await handler(runtime, request)
  return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers })
}

function makeRuntime(reader: GraphReader | null) {
  const config = readRuntimeConfig(() => undefined)
  return assembleRuntime({
    config,
    reader,
    readerReason: reader ? null : 'No reader in this test.',
    repos: null,
    rateLimit: new MemoryFixedWindowStore(),
    nonce: new MemoryNonceStore(),
  })
}

/** The fully-working local engine, re-labelled as another backend kind. */
function localReaderAs(kind: 'postgres' | 'neo4j'): GraphReader {
  const reader = createLocalReader(knowledgeGraph)
  return { ...reader, kind, provenance: `contract-test reader labelled ${kind}` } as GraphReader
}

/** A live client whose network layer is the handler under test. */
function liveClientServedBy(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: string[] = []
  const options: LiveClientOptions = {
    apiBaseUrl: 'https://functions.example.test/v1',
    getToken: async () => null,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      return respond(url, init ?? {})
    }) as typeof fetch,
  }
  return { client: createLiveClient(options), calls }
}

describe('health(): maps the real health-check payload', () => {
  it('reports neo4j-live when the backend reads from Neo4j', async () => {
    const runtime = makeRuntime(stubReader('neo4j'))
    const { client } = liveClientServedBy(() =>
      handlerResponse(healthCheckHandler, runtime, makeRequest({ path: '/health-check' })),
    )
    const report = await client.health()
    expect(report.mode).toBe('live')
    expect(report.graph).toBe('neo4j-live')
    expect(report.graphDetail).toContain('444 nodes')
    expect(report.version).toBeTruthy()
    expect(report.environment).toBeTruthy()
  })

  it('reports postgres-live when the backend reads from its own PostgreSQL', async () => {
    const runtime = makeRuntime(stubReader('postgres'))
    const { client } = liveClientServedBy(() =>
      handlerResponse(healthCheckHandler, runtime, makeRequest({ path: '/health-check' })),
    )
    const report = await client.health()
    expect(report.graph).toBe('postgres-live')
  })

  it('reports local-sample when the backend itself serves the bundled sample', async () => {
    const runtime = makeRuntime(stubReader('local'))
    const { client } = liveClientServedBy(() =>
      handlerResponse(healthCheckHandler, runtime, makeRequest({ path: '/health-check' })),
    )
    const report = await client.health()
    expect(report.graph).toBe('local-sample')
  })

  it('reports unreachable when the graph is down, with the handler message', async () => {
    const runtime = makeRuntime(stubReader('neo4j', new Error('connect ECONNREFUSED')))
    const { client } = liveClientServedBy(() =>
      handlerResponse(healthCheckHandler, runtime, makeRequest({ path: '/health-check' })),
    )
    const report = await client.health()
    expect(report.graph).toBe('unreachable')
    expect(report.graphDetail.toLowerCase()).toContain('could not be reached')
  })
})

describe('listCareers(): reads the handler envelope as-is', () => {
  it('keeps the handler-provided provenance label in meta.source', async () => {
    const runtime = makeRuntime(localReaderAs('postgres'))
    const { client, calls } = liveClientServedBy((url) => {
      const { searchParams } = new URL(url)
      const query = searchParams.toString()
      return handlerResponse(
        getCareersHandler,
        runtime,
        makeRequest({ path: '/get-careers', ...(query ? { query } : {}) }),
      )
    })
    const result = await client.listCareers({})
    expect(calls[0]).toBe('https://functions.example.test/v1/get-careers')
    expect(result.meta.source).toBe('postgres-live')
    expect(result.data.careers.length).toBe(knowledgeGraph.careers.length)
  })
})

describe('data-source evidence', () => {
  it('does not invent live status when a transport failure triggers the demo fallback', async () => {
    let unavailable = ''
    let requested = false
    const client = createLiveClient({
      apiBaseUrl: 'https://api.example.test/functions/v1',
      getToken: async () => null,
      onRequestStart: () => { requested = true },
      onBackendUnavailable: (reason) => { unavailable = reason },
      fetchImpl: (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch,
    })
    await expect(client.listCareers()).rejects.toMatchObject({ code: 'network_error' })
    expect(requested).toBe(true)
    expect(unavailable).toBe('Failed to fetch')
  })

  it('forwards only actual response provenance and never invents neo4j-live metadata', async () => {
    const observed: string[] = []
    const client = createLiveClient({
      apiBaseUrl: 'https://api.example.test/functions/v1',
      getToken: async () => null,
      onDataSource: (source) => observed.push(source),
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, data: {}, meta: { source: 'neo4j-live' } }), { status: 200 })) as typeof fetch,
    })
    const result = await client.listCareers()
    expect(result.meta.source).toBe('neo4j-live')
    expect(observed).toEqual(['neo4j-live'])

    const malformed = createLiveClient({
      apiBaseUrl: 'https://api.example.test/functions/v1',
      getToken: async () => null,
      onDataSource: (source) => observed.push(source),
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })) as typeof fetch,
    })
    const missingMeta = await malformed.listCareers()
    expect(missingMeta.meta.source).toBe('unavailable')
    expect(observed).toEqual(['neo4j-live'])
  })
})

describe('endpointUrl(): relative bases resolve against the page origin', () => {
  it('a same-origin relative base hits /functions/v1/<fn> on this host', async () => {
    const seen: string[] = []
    const client = createLiveClient({
      apiBaseUrl: '/functions/v1',
      getToken: async () => null,
      fetchImpl: (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        const runtime = makeRuntime(stubReader('postgres'))
        return handlerResponse(healthCheckHandler, runtime, makeRequest({ path: '/health-check' }))
      }) as typeof fetch,
    })
    const report = await client.health()
    expect(report.graph).toBe('postgres-live')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(`${window.location.origin}/functions/v1/health-check`)
    expect(seen[0].startsWith('http')).toBe(true)
  })

  it('absolute bases are used verbatim', async () => {
    const seen: string[] = []
    const client = createLiveClient({
      apiBaseUrl: 'https://xyz.supabase.co/functions/v1',
      getToken: async () => null,
      fetchImpl: (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        const runtime = makeRuntime(stubReader('neo4j'))
        return handlerResponse(healthCheckHandler, runtime, makeRequest({ path: '/health-check' }))
      }) as typeof fetch,
    })
    await client.health()
    expect(seen[0]).toBe('https://xyz.supabase.co/functions/v1/health-check')
  })
})

// Silence the unused-import guard for `vi` when editors trim it: this file
// stubs via the options seam (fetchImpl) on purpose, no module mocks.
void vi
