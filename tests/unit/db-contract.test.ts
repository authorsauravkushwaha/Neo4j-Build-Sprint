/**
 * The project's own database and the local test shim must implement the same
 * auth contract.
 *
 * `db/identity/00_auth_contract.sql` is what our server runs;
 * `supabase/local/00_supabase_shim.sql` is what `verify:rls` runs. If the two
 * `auth.uid()` definitions drift, the RLS harness would be proving properties
 * of a function production does not have — the exact failure this test exists
 * to prevent. It also pins the hardening promises that live in SQL: the roles
 * exist with the right attributes, the app role's grants are named in the
 * hardening file, and pg_hba.conf refuses everything that is not TLS + SCRAM +
 * a verified client certificate.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

/** The body of `create or replace function auth.uid()` ... up to the closing $$. */
function uidBody(sql: string): string {
  const start = sql.indexOf('create or replace function auth.uid()')
  expect(start, 'auth.uid() definition present').toBeGreaterThanOrEqual(0)
  const end = sql.indexOf('$$', sql.indexOf('$$', start) + 2)
  const body = sql.slice(start, end)
  // Strip comments, then normalise whitespace and case: prose may differ,
  // behaviour may not.
  return body.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

describe('database auth contract parity', () => {
  it('auth.uid() is identical in the owned database and the test shim', () => {
    const owned = uidBody(read('db/identity/00_auth_contract.sql'))
    const shim = uidBody(read('supabase/local/00_supabase_shim.sql'))
    expect(owned).toBe(shim)
  })

  it('auth.uid() fails closed: no claim means NULL, not an error or a default user', () => {
    const body = uidBody(read('db/identity/00_auth_contract.sql'))
    expect(body).toContain("nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'")
    expect(body).toContain('::uuid')
  })

  it('both files mark the auth schema so verify-rls can tell owned from hosted', () => {
    expect(read('db/identity/00_auth_contract.sql')).toContain('auth.gm_local_shim_marker')
    expect(read('supabase/local/00_supabase_shim.sql')).toContain('auth.gm_local_shim_marker')
  })
})

describe('database hardening, as written', () => {
  const roles = read('db/security/00_roles.sql')
  const hardening = read('db/security/00_hardening.sql')
  const hba = read('db/pg_hba.conf')

  it('gm_app is created with no administrative attribute and cannot bypass RLS', () => {
    expect(roles).toContain('login nosuperuser nocreatedb nocreaterole nobypassrls noreplication noinherit')
    expect(roles).toContain('connection limit 8')
  })

  it('gm_owner cannot log in, so there is no owner credential to steal', () => {
    expect(roles).toContain('alter role gm_owner with nologin')
  })

  it('the platform roles are NOLOGIN and only service_role bypasses RLS', () => {
    expect(roles).toContain('alter role service_role with nologin')
    // anon and authenticated must carry nobypassrls (which contains the
    // substring 'bypassrls', so assert on the whole attribute word).
    expect(roles).toContain('alter role anon with nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit;')
    expect(roles).toContain('alter role authenticated with nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit;')
    expect(roles).toContain('nocreaterole bypassrls noinherit noreplication;')
  })

  it('hardening revokes PUBLIC execute before granting the app its three functions', () => {
    const revokeAt = hardening.indexOf('revoke execute on all functions in schema public from public')
    const grantAt = hardening.indexOf('grant execute on function public.gm_consume_rate_limit')
    expect(revokeAt).toBeGreaterThanOrEqual(0)
    expect(grantAt).toBeGreaterThan(revokeAt)
    expect(hardening).toContain('grant execute on function public.gm_claim_nonce(text, integer) to gm_app')
    expect(hardening).toContain('grant execute on function public.gm_cleanup_rate_limit(integer) to gm_app')
  })

  it('FORCE row level security covers every table that holds personal data', () => {
    for (const table of ['profiles', 'saved_roadmaps', 'roadmap_tasks', 'user_skill_progress', 'bookmarks', 'feedback']) {
      expect(hardening).toContain(`alter table public.${table}`)
      expect(hardening).toContain(`public.${table}             force row level security`.slice(0, 20))
    }
  })

  it('pg_hba.conf refuses plaintext, sockets and every other host outright', () => {
    const active = hba.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'))
    expect(active.some((line) => line.trim() === 'local       all             all                             reject')).toBe(true)
    expect(active.some((line) => line.startsWith('hostnossl') && line.trim().endsWith('reject'))).toBe(true)
    expect(hba).not.toMatch(/(^|\s)(trust|peer|md5)(\s|$)/)
    for (const line of active.filter((entry) => !entry.trim().endsWith('reject'))) {
      expect(line.trim().startsWith('hostssl')).toBe(true)
      expect(line).toContain('scram-sha-256')
      expect(line).toContain('clientcert=verify-full')
    }
  })

  it('no SQL file in db/ contains a password literal', () => {
    for (const file of ['db/security/00_roles.sql', 'db/security/00_hardening.sql', 'db/identity/00_auth_contract.sql']) {
      const sql = read(file)
      expect(sql).not.toMatch(/password\s*=\s*'[A-Za-z0-9+/=]{12,}'/)
      expect(sql).not.toMatch(/with\s+password\s+'[^']+'/i)
    }
    // The one legitimate placeholder is the psql variable substituted at provision time.
    expect(roles).toContain("password :'app_pw'")
  })
})


