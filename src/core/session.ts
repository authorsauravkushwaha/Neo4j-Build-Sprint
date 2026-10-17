/**
 * Which client the UI is using, and why.
 *
 * Browser demo mode is the default whenever a backend is not configured, and it
 * is labelled as such in the interface — sample data must never be presented as
 * if it came from a live database.
 *
 * When a backend *is* configured the app asks for its health first:
 *   - healthy          -> live mode,
 *   - graph unreachable -> live mode with an explicit warning banner (the API is
 *     answering, the graph is not; the UI must not silently switch to sample data),
 *   - API not answering -> demo mode with the real error message, so the user
 *     knows why they are looking at sample data.
 */
import { ApiError, createDemoClient, createLiveClient, type GraphMentorClient, type HealthReport } from './api.ts'
import { config, hasApiBackend, isDemoForced } from './env.ts'
import { getAccessToken } from './supabase.ts'

export type SourceStatus = 'LIVE NEO4J' | 'DEMO DATA' | 'BACKEND UNAVAILABLE' | 'NEO4J UNAVAILABLE' | 'LIVE POSTGRESQL' | 'GRAPH SOURCE UNAVAILABLE' | 'DATA SOURCE UNCONFIRMED'

export interface SessionState {
  mode: 'demo' | 'live'
  client: GraphMentorClient
  health: HealthReport | null
  /** Set when the app wanted live data but could not reach the backend. */
  fallbackReason: string | null
  graphWarning: string | null
  /** Updated only after a successful API response carries trustworthy source metadata. */
  verifiedSource: 'neo4j-live' | 'postgres-live' | 'local-sample' | 'cache' | 'unavailable' | null
  backendUnavailable: boolean
  ready: boolean
}

let state: SessionState = {
  mode: 'demo',
  client: createDemoClient(),
  health: null,
  fallbackReason: isDemoForced && hasApiBackend ? 'This build is configured to start in demo mode (VITE_FORCE_DEMO_MODE=true).' : null,
  graphWarning: null,
  verifiedSource: null,
  backendUnavailable: false,
  ready: false,
}

const listeners = new Set<(next: SessionState) => void>()

function graphWarningFor(health: HealthReport): string | null {
  if (health.graph === 'unreachable') return `The API is reachable but the knowledge graph is not: ${health.graphDetail}`
  if (health.graph === 'local-sample') return `The backend answered, but it reports serving the bundled sample dataset rather than a database: ${health.graphDetail}`
  return health.graphDetail.toLowerCase().includes('empty') ? health.graphDetail : null
}

function createConfiguredLiveClient(): GraphMentorClient {
  return createLiveClient({
    apiBaseUrl: config.apiBaseUrl,
    getToken: getAccessToken,
    onRequestStart: () => publish({ verifiedSource: null }),
    onBackendUnavailable: (reason) => publish({
      mode: 'demo', client: createDemoClient(), backendUnavailable: true, verifiedSource: null,
      fallbackReason: `Backend became unavailable; the current request will use the bundled demo when available: ${reason}`,
      graphWarning: null,
    }),
    onDataSource: (source) => publish({ verifiedSource: source }),
  })
}

/** Retry the failed read against the bundled client so a page never labels old live data as demo data. */
function createResilientLiveClient(liveClient: GraphMentorClient): GraphMentorClient {
  return new Proxy(liveClient, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver) as unknown
      if (property === 'health' || typeof method !== 'function') return method

      return async (...args: unknown[]) => {
        try {
          return await method.apply(target, args)
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'network_error' || !state.backendUnavailable) throw error

          const fallback = state.client.mode === 'demo' ? state.client : createDemoClient()
          const fallbackMethod = Reflect.get(fallback, property) as unknown
          if (typeof fallbackMethod !== 'function') throw error
          const result = await fallbackMethod.apply(fallback, args)
          publish({ verifiedSource: 'local-sample' })
          return result
        }
      }
    },
  })
}

function publish(next: Partial<SessionState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener(state)
}

export function subscribeSession(listener: (next: SessionState) => void): () => void {
  listeners.add(listener)
  listener(state)
  return () => listeners.delete(listener)
}

export function sessionState(): SessionState {
  return state
}

/** Derive the visible label from observed responses, never from a configured URL. */
export function sourceStatus(session: SessionState): SourceStatus {
  if (session.backendUnavailable) return 'BACKEND UNAVAILABLE'
  if (session.mode === 'live' && session.health?.graph === 'unreachable') {
    return session.health.graphBackend === 'postgres' ? 'GRAPH SOURCE UNAVAILABLE' : 'NEO4J UNAVAILABLE'
  }
  if (session.mode === 'demo' || session.verifiedSource === 'local-sample') return 'DEMO DATA'
  if (session.verifiedSource === 'neo4j-live') return 'LIVE NEO4J'
  if (session.verifiedSource === 'postgres-live') return 'LIVE POSTGRESQL'
  return 'DATA SOURCE UNCONFIRMED'
}

/** The client every page should use. */
export function api(): GraphMentorClient {
  return state.client
}

export async function initSession(): Promise<SessionState> {
  if (isDemoForced) {
    publish({ mode: 'demo', client: createDemoClient(), ready: true, health: await createDemoClient().health(), verifiedSource: 'local-sample', backendUnavailable: false, graphWarning: null })
    return state
  }

  const live = createConfiguredLiveClient()

  try {
    const health = await live.health()
    const graphWarning = graphWarningFor(health)
    publish({ mode: 'live', client: createResilientLiveClient(live), health, fallbackReason: null, graphWarning, verifiedSource: null, backendUnavailable: false, ready: true })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The backend did not answer.'
    publish({
      mode: 'demo',
      client: createDemoClient(),
      fallbackReason: `Falling back to the bundled sample dataset because the backend could not be reached: ${reason}`,
      graphWarning: null,
      verifiedSource: 'local-sample',
      backendUnavailable: true,
      ready: true,
    })
  }

  return state
}

/** Re-ask the backend for its status (Settings > Diagnostics). */
export async function refreshHealth(): Promise<HealthReport | null> {
  try {
    if (hasApiBackend && !isDemoForced) {
      const live = state.mode === 'live' ? state.client : createConfiguredLiveClient()
      const health = await live.health()
      publish({
        mode: 'live', client: createResilientLiveClient(live), health, fallbackReason: null,
        graphWarning: graphWarningFor(health), verifiedSource: null,
        backendUnavailable: false, ready: true,
      })
      return health
    }
    const health = await state.client.health()
    publish({ health })
    return health
  } catch {
    return null
  }
}


