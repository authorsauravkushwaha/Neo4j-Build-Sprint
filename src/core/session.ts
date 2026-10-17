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
import { createDemoClient, createLiveClient, type GraphMentorClient, type HealthReport } from './api.ts'
import { config, hasApiBackend, isDemoForced } from './env.ts'
import { getAccessToken } from './supabase.ts'

export interface SessionState {
  mode: 'demo' | 'live'
  client: GraphMentorClient
  health: HealthReport | null
  /** Set when the app wanted live data but could not reach the backend. */
  fallbackReason: string | null
  graphWarning: string | null
  ready: boolean
}

let state: SessionState = {
  mode: 'demo',
  client: createDemoClient(),
  health: null,
  fallbackReason: isDemoForced && hasApiBackend ? 'This build is configured to start in demo mode (VITE_FORCE_DEMO_MODE=true).' : null,
  graphWarning: null,
  ready: false,
}

const listeners = new Set<(next: SessionState) => void>()

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

/** The client every page should use. */
export function api(): GraphMentorClient {
  return state.client
}

export async function initSession(): Promise<SessionState> {
  if (isDemoForced) {
    publish({ mode: 'demo', client: createDemoClient(), ready: true, health: await createDemoClient().health() })
    return state
  }

  const live = createLiveClient({
    apiBaseUrl: config.apiBaseUrl,
    getToken: getAccessToken,
  })

  try {
    const health = await live.health()
    const graphWarning =
      health.graph === 'unreachable'
        ? `The API is reachable but the knowledge graph is not: ${health.graphDetail}`
        : health.graph === 'local-sample'
          ? `The backend answered, but it reports serving the bundled sample dataset rather than a database: ${health.graphDetail}`
          : health.graphDetail.toLowerCase().includes('empty')
            ? health.graphDetail
            : null
    publish({ mode: 'live', client: live, health, fallbackReason: null, graphWarning, ready: true })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The backend did not answer.'
    publish({
      mode: 'demo',
      client: createDemoClient(),
      fallbackReason: `Falling back to the bundled sample dataset because the backend could not be reached: ${reason}`,
      graphWarning: null,
      ready: true,
    })
  }

  return state
}

/** Re-ask the backend for its status (Settings > Diagnostics). */
export async function refreshHealth(): Promise<HealthReport | null> {
  try {
    const health = await state.client.health()
    publish({ health })
    return health
  } catch {
    return null
  }
}


