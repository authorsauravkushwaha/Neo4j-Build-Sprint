/**
 * Build-time configuration.
 *
 * Everything here is public by definition: Vite inlines these values into the
 * bundle. Secrets (Neo4j password, AI keys, service-role key) live only in
 * Supabase Edge Function secrets — see supabase/.env.example.
 *
 * The app has to work in three situations, and says which one it is in:
 *   1. no backend configured        -> demo mode over the bundled dataset,
 *   2. backend configured + health   -> live mode (Neo4j or Supabase),
 *   3. backend configured but down   -> error state with the real reason, no
 *                                       pretend data and no silent fallback that
 *                                       could be mistaken for live information.
 */
export interface AppConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  /** Base URL of the deployed Edge Functions; empty means "not configured". */
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

/** True when the frontend has somewhere to send API calls. */
export const hasBackend: boolean = Boolean(config.apiBaseUrl && config.supabaseUrl && config.supabaseAnonKey)

/** True when the app must not attempt network calls at all. */
export const isDemoForced: boolean = config.forceDemoMode || !hasBackend


