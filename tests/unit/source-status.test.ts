import { describe, expect, it } from 'vitest'
import { sourceStatus, type SessionState } from '@/core/session.ts'

const makeState = (patch: Partial<SessionState> = {}): SessionState => ({
  mode: 'live',
  client: {} as SessionState['client'],
  health: null,
  fallbackReason: null,
  graphWarning: null,
  verifiedSource: null,
  backendUnavailable: false,
  ready: true,
  ...patch,
})

describe('visible data-source status requires observed provenance', () => {
  it('does not label a successful health check or configured live client as LIVE NEO4J', () => {
    expect(sourceStatus(makeState({
      health: {
        mode: 'live', graph: 'neo4j-live', graphDetail: 'connected', aiConfigured: false,
        aiProvider: 'none', storageConfigured: false, requestSigningRequired: false,
        environment: 'test', version: 'test',
      },
    }))).toBe('DATA SOURCE UNCONFIRMED')
  })

  it('labels Neo4j only after successful query metadata has been observed', () => {
    expect(sourceStatus(makeState({ verifiedSource: 'neo4j-live' }))).toBe('LIVE NEO4J')
  })

  it('distinguishes the bundled demo, an unreachable backend, and unreachable Neo4j', () => {
    expect(sourceStatus(makeState({ mode: 'demo', verifiedSource: 'local-sample' }))).toBe('DEMO DATA')
    expect(sourceStatus(makeState({ mode: 'demo', backendUnavailable: true }))).toBe('BACKEND UNAVAILABLE')
    expect(sourceStatus(makeState({ health: {
      mode: 'live', graph: 'unreachable', graphDetail: 'offline', aiConfigured: false,
      aiProvider: 'none', storageConfigured: false, requestSigningRequired: false,
      environment: 'test', version: 'test',
    } }))).toBe('NEO4J UNAVAILABLE')
  })

  it('does not mislabel a PostgreSQL alternative or stale/unavailable provenance as Neo4j', () => {
    expect(sourceStatus(makeState({ verifiedSource: 'postgres-live' }))).toBe('LIVE POSTGRESQL')
    expect(sourceStatus(makeState({ verifiedSource: 'cache' }))).toBe('DATA SOURCE UNCONFIRMED')
    expect(sourceStatus(makeState({ verifiedSource: 'unavailable' }))).toBe('DATA SOURCE UNCONFIRMED')
  })
})
