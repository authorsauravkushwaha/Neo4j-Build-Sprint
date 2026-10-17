/**
 * Neo4j environment validation in `readRuntimeConfig`. Pure: no network.
 */
import { describe, expect, it } from 'vitest'
import { readRuntimeConfig, type EnvAccessor } from '../../supabase/functions/_shared/runtime.ts'

const PASSWORD = 'pw-not-a-real-secret-123' // secret-scan:allow
const URL_OK = 'https://abc123.databases.neo4j.io/db/neo4j/query/v2'

function env(values: Record<string, string>): EnvAccessor {
  return (key) => values[key]
}

describe('readRuntimeConfig: Neo4j', () => {
  it('reports not configured when no credentials are set, and keeps sample mode available', () => {
    const config = readRuntimeConfig(env({}))
    expect(config.neo4j).toBeNull()
    expect(config.neo4jIssue).toMatch(/not configured/)
  })

  it('takes the database from the URL path', () => {
    const config = readRuntimeConfig(env({ NEO4J_QUERY_URL: URL_OK, NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: PASSWORD }))
    expect(config.neo4jIssue).toBeNull()
    expect(config.neo4j?.database).toBe('neo4j')
    expect(config.neo4j?.queryUrl).toBe(URL_OK)
  })

  it('accepts a matching NEO4J_DATABASE', () => {
    const config = readRuntimeConfig(env({ NEO4J_QUERY_URL: URL_OK, NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: PASSWORD, NEO4J_DATABASE: 'neo4j' }))
    expect(config.neo4j).not.toBeNull()
  })

  it('refuses a NEO4J_DATABASE that disagrees with the URL, and does not expose the password', () => {
    const config = readRuntimeConfig(
      env({ NEO4J_QUERY_URL: URL_OK, NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: PASSWORD, NEO4J_DATABASE: 'other' }),
    )
    expect(config.neo4j).toBeNull()
    expect(config.neo4jIssue).toMatch(/does not match/)
    expect(config.neo4jIssue).not.toContain(PASSWORD)
  })

  it('refuses plain http and names the fix', () => {
    const config = readRuntimeConfig(
      env({ NEO4J_QUERY_URL: 'http://abc123.databases.neo4j.io/db/neo4j/query/v2', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: PASSWORD }),
    )
    expect(config.neo4j).toBeNull()
    expect(config.neo4jIssue).toMatch(/https/)
  })

  it('refuses a URL that is not the Query API path, such as a Bolt address', () => {
    const config = readRuntimeConfig(
      env({ NEO4J_QUERY_URL: 'https://abc123.databases.neo4j.io', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: PASSWORD }),
    )
    expect(config.neo4j).toBeNull()
    expect(config.neo4jIssue).toMatch(/query\/v2/)
  })

  it('refuses credentials embedded in the URL', () => {
    const config = readRuntimeConfig(
      env({ NEO4J_QUERY_URL: 'https://neo4j:leak@abc123.databases.neo4j.io/db/neo4j/query/v2', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: PASSWORD }), // secret-scan:allow
    )
    expect(config.neo4j).toBeNull()
    expect(config.neo4jIssue).not.toContain('leak')
  })

  it('does not read Supabase service-role configuration at all', () => {
    const seen: string[] = []
    readRuntimeConfig((key) => {
      seen.push(key)
      return key === 'SUPABASE_SERVICE_ROLE_KEY' ? 'service-role-value' : undefined
    })
    expect(seen).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })
})
