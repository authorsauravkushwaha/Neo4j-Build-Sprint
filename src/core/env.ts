/**
 * Build-time configuration.
 *
 * Everything here is public by definition: Vite inlines these values into the
 * bundle. Secrets (Neo4j password, AI keys, service-role key) live only in the
 * selected backend's server-side environment.
 *
 * The app has to work in three situations, and says which one it is in:
 *   1. no backend configured        -> demo mode over the bundled dataset,
 *   2. backend configured + health   -> use the API client, but do not claim a
 *                                       data source until a successful response
 *                                       supplies provenance metadata,
 *   3. backend configured but down   -> labelled bundled demo fallback, with
 *                                       BACKEND UNAVAILABLE shown explicitly.
 */
export interface AppConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  /**
   * Base URL of the deployed graph API; empty means "not configured".
   * Accepts an absolute URL (Supabase Edge Functions, or the project's own
   * server on another host) or a same-origin relative base ("/functions/v1"
   * when the website server also mounts the API).
   */
  apiBaseUrl: string
  appVersion: string
  /** Force demo mode even when a backend is configured (see VITE_FORCE_DEMO_MODE). */
  forceDemoMode: boolean
  basePath: string
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readConfig(env: Record<string, unknown>): AppConfig {
  const supabaseUrl = trimmed(env.VITE_SUPABASE_URL)
  const supabaseAnonKey = trimmed(env.VITE_SUPABASE_ANON_KEY)
  const explicitApi = trimmed(env.VITE_API_BASE_URL)
  const apiBaseUrl = explicitApi || (supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/functions/v1` : '')

  return {
    supabaseUrl,
    supabaseAnonKey,
    apiBaseUrl,
    appVersion: trimmed(env.VITE_APP_VERSION) || 'dev',
    forceDemoMode: trimmed(env.VITE_FORCE_DEMO_MODE).toLowerCase() === 'true',
    basePath: trimmed(env.VITE_BASE_PATH) || '/',
  }
}

export const config: AppConfig = readConfig(import.meta.env as unknown as Record<string, unknown>)

/**
 * True when a Supabase project is configured for accounts (auth + RLS storage).
 * Kept separate from the graph API: a self-hosted deployment (the project's own
 * Node server) serves the graph API without any Supabase project at all.
 */
export const hasBackend: boolean = Boolean(config.supabaseUrl && config.supabaseAnonKey)

/**
 * True when the frontend has somewhere to send graph API calls — either the
 * Supabase Edge Functions (derived from VITE_SUPABASE_URL) or an explicit
 * VITE_API_BASE_URL, absolute or same-origin relative ("/functions/v1").
 */
export const hasApiBackend: boolean = Boolean(config.apiBaseUrl)

/** True when the app must not attempt network calls at all. */
export const isDemoForced: boolean = config.forceDemoMode || !hasApiBackend


