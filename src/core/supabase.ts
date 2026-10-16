/**
 * Supabase client wiring: the client itself, the current session, the access
 * token, and a subscription to auth changes.
 *
 * Sign-in, sign-up, magic links, password resets and sign-out are **not** here.
 * They live in `./auth.ts`, which routes every provider error through
 * `describeAuthError()` so the wording never reveals whether an address has an
 * account, and which asks `POST /auth-guard` for an attempt slot before trying.
 * Two thin wrappers for the same operations used to sit in this file as
 * leftovers; they were removed because an unused `signInWithEmail` that returned
 * `error.message` verbatim is a trap — importing it would quietly reintroduce the
 * account-enumeration leak the rest of the auth code is built to avoid.
 *
 * This module never talks to Neo4j, and never sees a service-role key. When the
 * project is not configured, everything here degrades to "no session" and the app
 * stays fully usable in guest mode with local storage.
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

import { config, hasBackend } from './env.ts'

let client: SupabaseClient | null = null

export function supabase(): SupabaseClient | null {
  if (!hasBackend) return null
  client ??= createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      storageKey: 'gm.auth',
    },
    global: { headers: { 'x-client-info': `graphmentor-web/${config.appVersion}` } },
  })
  return client
}

export async function getSession(): Promise<Session | null> {
  const sb = supabase()
  if (!sb) return null
  const { data, error } = await sb.auth.getSession()
  if (error) return null
  return data.session
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getSession()
  return session?.access_token ?? null
}

export function onAuthChange(handler: (session: Session | null) => void): () => void {
  const sb = supabase()
  if (!sb) return () => {}
  const { data } = sb.auth.onAuthStateChange((_event, session) => handler(session))
  return () => data.subscription.unsubscribe()
}


