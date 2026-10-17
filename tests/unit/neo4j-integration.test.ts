// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { AppError } from '../../supabase/functions/_shared/core/errors.ts'
import {
  CAREER_DETAILS,
  CAREER_OVERVIEW_SUBGRAPH,
  CAREER_SEARCH,
  MODULES_FOR_CAREER,
  PROJECT_CATALOG,
  QUERY_CATALOG,
  RESOURCES_FOR_SKILLS,
  RESOURCES_FOR_SUBJECT,
  SKILL_DETAILS,
  SKILL_EDGES_BY_IDS,
  careerPrereqClosure,
  downstreamClosure,
  neighbourhoodQuery,
  skillPrereqClosure,
} from '../../supabase/functions/_shared/core/graphQuery.ts'
import {
  createNeo4jReader,
  decodeQueryApiResponse,
  resolveQueryEndpoint,
} from '../../supabase/functions/_shared/core/neo4jReader.ts'
import { assembleRuntime, createReaderFromConfig, readRuntimeConfig } from '../../supabase/functions/_shared/runtime.ts'
import { resolveNeo4jUri } from '../../server/neo4jDriverReader.ts'
import { getCareersHandler } from '../../supabase/functions/_shared/handlers/careers.ts'
import { makeRequest } from '../helpers/runtime.ts'

describe('Neo4j endpoint & environment configuration validation', () => {
  it('resolves NEO4J_QUERY_URL directly and appends default v2 path when bare host is given', () => {
    expect(
      resolveQueryEndpoint({
        queryUrl: 'https://abc12345.databases.neo4j.io/db/neo4j/query/v2',
        database: 'neo4j',
      }),
    ).toBe('https://abc12345.databases.neo4j.io/db/neo4j/query/v2')

    expect(
      resolveQueryEndpoint({
        queryUrl: 'https://abc12345.databases.neo4j.io',
        database: 'customdb',
      }),
    ).toBe('https://abc12345.databases.neo4j.io/db/customdb/query/v2')
  })

  it('derives HTTPS Query API v2 endpoint from NEO4J_URI (neo4j+s / bolt+s)', () => {
    expect(
      resolveQueryEndpoint({
        uri: 'neo4j+s://abc12345.databases.neo4j.io',
        database: 'neo4j',
      }),
    ).toBe('https://abc12345.databases.neo4j.io/db/neo4j/query/v2')

    expect(
      resolveQueryEndpoint({
        uri: 'bolt+s://abc12345.databases.neo4j.io:7687',
        database: 'aura_prod',
      }),
    ).toBe('https://abc12345.databases.neo4j.io/db/aura_prod/query/v2')
  })

  it('rejects plain http:// and URLs with embedded credentials', () => {
    expect(resolveQueryEndpoint({ queryUrl: 'http://abc12345.databases.neo4j.io/db/neo4j/query/v2' })).toBeNull()
    expect(resolveQueryEndpoint({ queryUrl: 'https://neo4j:secret@abc12345.databases.neo4j.io/db/neo4j/query/v2' })).toBeNull() // secret-scan:allow
    expect(resolveQueryEndpoint({ uri: 'bolt://localhost:7687' })).toBeNull()
  })

  it('validates readRuntimeConfig with NEO4J_QUERY_URL or NEO4J_URI and reports redacted issues on invalid config', () => {
    const unconfigured = readRuntimeConfig(() => undefined)
    expect(unconfigured.neo4j).toBeNull()
    expect(unconfigured.neo4jIssue).toContain('Neo4j is not configured')

    const httpConfig = readRuntimeConfig((k) =>
      ({
        NEO4J_QUERY_URL: 'http://abc.databases.neo4j.io/db/neo4j/query/v2',
        NEO4J_USERNAME: 'neo4j',
        NEO4J_PASSWORD: 'super-secret-password',
      })[k],
    )
    expect(httpConfig.neo4j).toBeNull()
    expect(httpConfig.neo4jIssue).toBe('NEO4J_QUERY_URL must be an https:// URL.')
    expect(httpConfig.neo4jIssue).not.toContain('super-secret-password')

    const missingPass = readRuntimeConfig((k) =>
      ({
        NEO4J_URI: 'neo4j+s://abc.databases.neo4j.io',
        NEO4J_USERNAME: 'neo4j',
      })[k],
    )
    expect(missingPass.neo4j).toBeNull()
    expect(missingPass.neo4jIssue).toContain('Neo4j credentials are incomplete')

    const fromBoltUri = readRuntimeConfig((k) =>
      ({
        NEO4J_URI: 'neo4j+s://abc.databases.neo4j.io',
        NEO4J_PASSWORD: 'valid-password',
        NEO4J_DATABASE: 'neo4j',
      })[k],
    )
    expect(fromBoltUri.neo4j).not.toBeNull()
    expect(fromBoltUri.neo4j?.queryUrl).toBe('https://abc.databases.neo4j.io/db/neo4j/query/v2')
    expect(fromBoltUri.neo4j?.username).toBe('neo4j')
  })

  it('validates resolveNeo4jUri for the Node Bolt driver backend', () => {
    expect(resolveNeo4jUri({})).toBeNull()

    expect(
      resolveNeo4jUri({
        NEO4J_URI: 'neo4j+s://abc.databases.neo4j.io',
        NEO4J_USERNAME: 'neo4j',
        NEO4J_PASSWORD: 'pw',
        NEO4J_DATABASE: 'neo4j',
      }),
    ).toEqual({
      uri: 'neo4j+s://abc.databases.neo4j.io',
      username: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    })

    expect(
      resolveNeo4jUri({
        NEO4J_QUERY_URL: 'https://abc.databases.neo4j.io/db/neo4j/query/v2',
        NEO4J_PASSWORD: 'pw',
      }),
    ).toEqual({
      uri: 'neo4j+s://abc.databases.neo4j.io',
      username: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    })

    expect(() => resolveNeo4jUri({ NEO4J_URI: 'neo4j+s://abc.databases.neo4j.io' })).toThrow(AppError)
    expect(() => resolveNeo4jUri({ NEO4J_PASSWORD: 'pw' })).toThrow(AppError)
    expect(() => resolveNeo4jUri({ NEO4J_URI: 'http://abc.databases.neo4j.io', NEO4J_PASSWORD: 'pw' })).toThrow(AppError)
    expect(() =>
      resolveNeo4jUri({ NEO4J_URI: 'neo4j+s://neo4j:pw@abc.databases.neo4j.io', NEO4J_PASSWORD: 'pw' }),
    ).toThrow(AppError)
  })
})

describe('decodeQueryApiResponse v1, v2, and malformed payload handling', () => {
  it('decodes Query API v2 fields + values into keyed rows', () => {
    const decoded = decodeQueryApiResponse({
      data: {
        fields: ['id', 'name', 'difficulty'],
        values: [
          ['skill:python-programming', 'Python programming', 'beginner'],
          ['skill:sql', 'SQL', 'beginner'],
        ],
      },
    })
    expect(decoded.errors).toEqual([])
    expect(decoded.rows).toEqual([
      { id: 'skill:python-programming', name: 'Python programming', difficulty: 'beginner' },
      { id: 'skill:sql', name: 'SQL', difficulty: 'beginner' },
    ])
  })

  it('decodes Query API v1 results[0].columns + data[].row into keyed rows', () => {
    const decoded = decodeQueryApiResponse({
      results: [
        {
          columns: ['id', 'name'],
          data: [{ row: ['career:data-engineer', 'Data engineer'] }],
        },
      ],
      errors: [],
    })
    expect(decoded.errors).toEqual([])
    expect(decoded.rows).toEqual([{ id: 'career:data-engineer', name: 'Data engineer' }])
  })

  it('flags non-object, array, or unrecognized JSON shapes as Neo.ClientError.Request.InvalidFormat', () => {
    expect(decodeQueryApiResponse(null).errors[0]?.code).toBe('Neo.ClientError.Request.InvalidFormat')
    expect(decodeQueryApiResponse(['not', 'an', 'object']).errors[0]?.code).toBe('Neo.ClientError.Request.InvalidFormat')
    expect(decodeQueryApiResponse({ message: 'upstream proxy welcome page' }).errors[0]?.code).toBe(
      'Neo.ClientError.Request.InvalidFormat',
    )
    expect(decodeQueryApiResponse({ data: { unexpected: true } }).errors[0]?.code).toBe(
      'Neo.ClientError.Request.InvalidFormat',
    )
  })
})

describe('Cypher query templates and dynamic builders', () => {
  it('contains no unbound variables in skillPrereqClosure, careerPrereqClosure, downstreamClosure, or neighbourhoodQuery', () => {
    for (const depth of [1, 2, 3, 4]) {
      const sp = skillPrereqClosure(depth).cypher
      expect(sp).not.toMatch(/\blabels\(n\)/)
      expect(sp).toContain('p.estimatedHoursLow AS estimatedHoursLow')
      expect(sp).toContain('p.completionCriteria AS completionCriteria')

      const cp = careerPrereqClosure(depth).cypher
      expect(cp).toContain('n.estimatedHoursLow AS estimatedHoursLow')
      expect(cp).toContain('n.completionCriteria AS completionCriteria')
    }

    for (const depth of [1, 2, 3]) {
      const dc = downstreamClosure(depth).cypher
      expect(dc).not.toMatch(/\bx\.(id|name|difficulty)\b/)
      expect(dc).toContain('collect(DISTINCT c { .id, .name }) AS careers')
      expect(dc).toContain('next { .id, .name, .summary, .difficulty, .estimatedHoursLow, .estimatedHoursHigh, .completionCriteria, .practice }')

      const nq = neighbourhoodQuery('Skill', depth).cypher
      expect(nq).toContain(`OPTIONAL MATCH p = (seed)-[*1..${depth}]-(neighbor)`)
      expect(nq).toContain('UNWIND ([seed] + [x IN neighbors WHERE x IS NOT NULL]) AS n')
    }
  })

  it('includes required columns across catalog queries for live/sample parity', () => {
    expect(CAREER_SEARCH).toContain('collect(DISTINCT s.id) AS skillIds')
    expect(CAREER_DETAILS).toContain('s { .id, .name, .summary, .difficulty, essential: rs.essential, weight: rs.weight }')
    expect(SKILL_EDGES_BY_IDS).toContain('coalesce(r.weight, r.strength, 1.0) AS weight')
    expect(SKILL_DETAILS).toContain('coalesce(r.weight, r.strength)')
    expect(SKILL_DETAILS).toContain('s.estimatedHoursLow AS estimatedHoursLow')
    expect(PROJECT_CATALOG).toContain('MATCH (p:Project)')
    expect(RESOURCES_FOR_SKILLS).toContain('AS coversIds')
    expect(RESOURCES_FOR_SKILLS).toContain('AS coversNames')
    expect(RESOURCES_FOR_SUBJECT).toContain(':HAS_CONCEPT')
    expect(RESOURCES_FOR_SUBJECT).toContain('AS coversIds')
    expect(CAREER_OVERVIEW_SUBGRAPH).toContain('WITH ([c] + skills + tools + projects + resources) AS base')
    expect(MODULES_FOR_CAREER).toContain('ORDER BY overlap DESC, name ASC')
    expect(QUERY_CATALOG.PROJECT_CATALOG).toBe(PROJECT_CATALOG)
  })
})

describe('createNeo4jReader HTTP transport, retries, error handling, and domain parity', () => {
  const baseConfig = {
    queryUrl: 'https://test-instance.databases.neo4j.io/db/neo4j/query/v2',
    database: 'neo4j',
    username: 'neo4j',
    password: 'p@sswörd-with-ütf8', // secret-scan:allow
    timeoutMs: 2000,
    maxRows: 400,
  }

  it('constructs POST requests with UTF-8 Basic auth and bound parameters', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(
        JSON.stringify({
          data: {
            fields: ['id', 'name', 'summary', 'difficulty', 'verification', 'branchIds', 'skillIds'],
            values: [
              [
                'career:software-engineer',
                'Software Engineer',
                'Builds reliable software systems.',
                'intermediate',
                'verified',
                ['branch:computer-science'],
                ['skill:python-programming'],
              ],
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const reader = createNeo4jReader({ ...baseConfig, fetchImpl })
    const res = await reader.searchCareers({ q: 'software', branchId: 'branch:computer-science', limit: 10 })

    expect(res.value).toHaveLength(1)
    expect(res.value[0]?.skillIds).toEqual(['skill:python-programming'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(baseConfig.queryUrl)
    expect(calls[0]?.init?.method).toBe('POST')

    const headers = calls[0]?.init?.headers as Record<string, string>
    const expectedAuth = `Basic ${Buffer.from(`${baseConfig.username}:${baseConfig.password}`, 'utf8').toString('base64')}`
    expect(headers.authorization).toBe(expectedAuth)

    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.statement).toContain('MATCH (c:Career)')
    expect(body.parameters).toEqual({
      q: 'software',
      branchId: 'branch:computer-science',
      difficulty: '',
      limit: 10,
      offset: 0,
    })
  })

  it('retries transient HTTP 503 responses and succeeds when AuraDB recovers', async () => {
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts++
      if (attempts === 1) {
        return new Response('Service Unavailable', { status: 503 })
      }
      return new Response(
        JSON.stringify({
          data: {
            fields: ['id', 'name', 'summary', 'careerCount'],
            values: [['branch:cs', 'Computer Science', 'Core computing', 5]],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const reader = createNeo4jReader({ ...baseConfig, fetchImpl })
    const branches = await reader.listBranches(10)
    expect(attempts).toBe(2)
    expect(branches.value).toEqual([{ id: 'branch:cs', name: 'Computer Science', summary: 'Core computing', careerCount: 5 }])
  })

  it('throws dependency_unavailable when HTTP 200 returns a malformed non-Query-API JSON body', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ status: 'ok', html: 'not neo4j' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const reader = createNeo4jReader({ ...baseConfig, fetchImpl })
    await expect(reader.listCareers(5)).rejects.toMatchObject({
      code: 'dependency_unavailable',
    })
  })

  it('honors an already-aborted AbortSignal without making network calls', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const reader = createNeo4jReader({ ...baseConfig, fetchImpl })
    const controller = new AbortController()
    controller.abort()

    await expect(reader.listCareers(5, { signal: controller.signal })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses PROJECT_CATALOG for unfiltered project queries and filters by difficulty after fetching', async () => {
    const statements: Array<{ statement: string; parameters: Record<string, unknown> }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const parsed = JSON.parse(String(init?.body))
      statements.push(parsed)
      return new Response(
        JSON.stringify({
          data: {
            fields: ['id', 'name', 'summary', 'description', 'difficulty', 'skillIds', 'matchedSkills', 'estimatedHoursLow', 'estimatedHoursHigh'],
            values: [
              ['project:one', 'Project One', 'Summary 1', 'Desc 1', 'beginner', ['skill:python-programming'], ['skill:python-programming'], 6, 12],
              ['project:two', 'Project Two', 'Summary 2', 'Desc 2', 'advanced', ['skill:python-programming'], ['skill:python-programming'], 20, 40],
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const reader = createNeo4jReader({ ...baseConfig, fetchImpl })
    const allProjects = await reader.findProjects({ limit: 12 })
    expect(allProjects.value).toHaveLength(2)
    expect(statements[0]?.statement).toBe(PROJECT_CATALOG)
    expect(statements[0]?.parameters).toEqual({ difficulty: '', limit: 12 })

    const filteredBySkillAndDiff = await reader.findProjects({
      skillIds: ['skill:python-programming'],
      difficulty: 'advanced',
      limit: 5,
    })
    expect(filteredBySkillAndDiff.value).toHaveLength(1)
    expect(filteredBySkillAndDiff.value[0]?.id).toBe('project:two')
  })

  it('routes subjectId resource queries to RESOURCES_FOR_SUBJECT and preserves coversIds/coversNames', async () => {
    const statements: Array<{ statement: string; parameters: Record<string, unknown> }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const parsed = JSON.parse(String(init?.body))
      statements.push(parsed)
      return new Response(
        JSON.stringify({
          data: {
            fields: [
              'id',
              'name',
              'summary',
              'url',
              'provider',
              'format',
              'difficulty',
              'language',
              'accessModel',
              'accessNote',
              'outcomes',
              'assumes',
              'limits',
              'commitment',
              'estimatedHoursLow',
              'estimatedHoursHigh',
              'assumesIds',
              'assumesNames',
              'lastVerified',
              'verification',
              'coversIds',
              'coversNames',
              'matchedSkills',
            ],
            values: [
              [
                'resource:linear-algebra-mit',
                'MIT 18.06 Linear Algebra',
                'Foundational linear algebra lectures.',
                'https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/',
                'MIT OpenCourseWare',
                'course',
                'beginner',
                'en',
                'free',
                'Full lecture videos and problem sets are free.',
                ['Solve linear systems', 'Compute eigenvalues', 'Understand subspaces', 'Apply SVD', 'Orthogonal projections', 'Matrix decompositions', 'Seventh outcome'],
                'High-school algebra',
                'Does not cover numerical stability in depth',
                '36 hours across 34 lectures',
                30,
                45,
                [],
                [],
                '2026-10-01',
                'verified',
                ['subject:linear-algebra', 'skill:linear-algebra'],
                ['Linear Algebra', 'Linear Algebra Skill'],
                ['subject:linear-algebra', 'skill:linear-algebra'],
              ],
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const reader = createNeo4jReader({ ...baseConfig, fetchImpl })
    const res = await reader.findResources({ subjectId: 'subject:linear-algebra', limit: 10 })
    expect(statements[0]?.statement).toBe(RESOURCES_FOR_SUBJECT)
    expect(res.value).toHaveLength(1)
    expect(res.value[0]?.coversIds).toEqual(['subject:linear-algebra', 'skill:linear-algebra'])
    expect(res.value[0]?.coversNames).toEqual(['Linear Algebra', 'Linear Algebra Skill'])
    expect(res.value[0]?.outcomes).toHaveLength(7)
    expect(res.value[0]?.estimatedHours).toEqual([30, 45])
  })

  it('fetches the full skill index before filtering by search query q and detects neighborhood truncation', async () => {
    const calls: Array<{ statement: string; parameters: Record<string, unknown> }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const parsed = JSON.parse(String(init?.body))
      calls.push(parsed)
      if (parsed.statement.includes('AS parentName')) {
        return new Response(
          JSON.stringify({
            data: {
              fields: ['id', 'label', 'name', 'difficulty', 'parentName'],
              values: [
                ['skill:algorithms', 'Skill', 'Algorithms', 'intermediate', 'Computer Science'],
                ['skill:zig-systems', 'Skill', 'Zig Systems Programming', 'advanced', 'Systems'],
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // Neighborhood nodes query (limit + 1 rows returned to signal truncation)
      if (parsed.statement.includes('UNWIND ([seed]')) {
        return new Response(
          JSON.stringify({
            data: {
              fields: ['id', 'label', 'name', 'summary', 'difficulty'],
              values: [
                ['skill:python-programming', 'Skill', 'Python', 'Summary', 'beginner'],
                ['skill:sql', 'Skill', 'SQL', 'Summary', 'beginner'],
                ['skill:git', 'Skill', 'Git', 'Summary', 'beginner'],
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ data: { fields: ['from', 'to', 'type'], values: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const reader = createNeo4jReader({ ...baseConfig, fetchImpl })
    const skills = await reader.listSkillIndex({ q: 'zig', limit: 1 })
    expect(calls[0]?.parameters.limit).toBe(400)
    expect(skills.value).toHaveLength(1)
    expect(skills.value[0]?.id).toBe('skill:zig-systems')

    const neighborhood = await reader.getNeighborhood({ seedId: 'skill:python-programming', depth: 1, limit: 2 })
    expect(neighborhood.value.nodes).toHaveLength(2)
    expect(neighborhood.value.truncated).toBe(true)
    expect(neighborhood.truncated).toBe(true)
  })
})

describe('API handlers backed by live Neo4j Query API reader', () => {
  it('serves live Neo4j provenance on success and returns 502 dependency_unavailable (never silent sample data) when Neo4j fails', async () => {
    let shouldFail = false
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (shouldFail) {
        return new Response('Bad Gateway', { status: 502 })
      }
      const { statement } = JSON.parse(String(init?.body))
      if (statement.includes('MATCH (b:EngineeringBranch)')) {
        return new Response(
          JSON.stringify({
            data: {
              fields: ['id', 'name', 'summary', 'careerCount'],
              values: [['branch:cs', 'Computer Science', 'CS branch', 1]],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          data: {
            fields: ['id', 'name', 'summary', 'difficulty', 'verification', 'branchIds', 'skillIds'],
            values: [
              [
                'career:software-engineer',
                'Software Engineer',
                'Designs and maintains software systems.',
                'intermediate',
                'verified',
                ['branch:cs'],
                ['skill:python-programming'],
              ],
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const config = readRuntimeConfig((k) =>
      ({
        NEO4J_QUERY_URL: 'https://live-aura.databases.neo4j.io/db/neo4j/query/v2',
        NEO4J_USERNAME: 'neo4j',
        NEO4J_PASSWORD: 'secret-password',
        NEO4J_TIMEOUT_MS: '1000',
      })[k],
    )
    const selection = createReaderFromConfig(config, { fetchImpl })
    const runtime = assembleRuntime({
      config,
      reader: selection.reader,
      readerReason: selection.reason,
      repos: null,
      fetchImpl,
    })

    const okResponse = await getCareersHandler(runtime, makeRequest({ path: '/get-careers' }))
    expect(okResponse.status).toBe(200)
    const okBody = okResponse.body as { ok: boolean; meta: { source: string }; data: { careers: Array<{ id: string }> } }
    expect(okBody.ok).toBe(true)
    expect(okBody.meta.source).toBe('neo4j-live')
    expect(okBody.data.careers[0]?.id).toBe('career:software-engineer')

    // Now simulate an AuraDB outage: handler must fail honestly with 502, never silently substitute local sample data.
    shouldFail = true
    await expect(getCareersHandler(runtime, makeRequest({ path: '/get-careers' }))).rejects.toMatchObject({
      code: 'dependency_unavailable',
      status: 502,
    })
  })
})
