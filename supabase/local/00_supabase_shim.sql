-- ============================================================================
-- Supabase platform contract — local verification shim
--
-- THIS FILE IS NOT PART OF A DEPLOYMENT. Never run it on a real project.
--
-- `supabase/migrations/*.sql` reference four things that the Supabase platform
-- provides and plain PostgreSQL does not:
--
--   1. the `auth` schema, and `auth.users` (the identity table),
--   2. `auth.uid()` — the function every RLS policy here is written against,
--   3. the `anon`, `authenticated` and `service_role` roles,
--   4. the `request.jwt.claims` session setting that PostgREST populates per
--      request from the verified JWT.
--
-- This shim reproduces those four things so the **unmodified** migrations and
-- the **unmodified** RLS policies can be applied to a real PostgreSQL server and
-- attacked from two accounts. `auth.uid()` below is Supabase's own definition —
-- it reads the `sub` claim out of `request.jwt.claims` — so a policy that passes
-- here is being evaluated by the same expression it would be in production.
--
-- What this shim does *not* reproduce, and therefore does not verify:
--   * PostgREST's translation of HTTP requests into SQL (so this proves the
--     policies, not the REST layer's use of them),
--   * GoTrue (sign-up, sign-in, email delivery, JWT signing),
--   * connection pooling, replication, or the platform's own hardening.
--
-- Usage is automated: `npm run verify:rls` applies this file, then both
-- migrations, then runs the isolation matrix in scripts/verify-rls.ts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Roles. Real Supabase creates these as NOLOGIN roles and switches into them
-- per request via `set local role`, which is exactly what the verifier does.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- bypassrls mirrors the real service role: it is why the key is server-side only.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- auth schema + auth.users
-- Real Supabase stores far more (encrypted_password, raw_user_meta_data,
-- confirmed_at, …). Only the columns the migrations constrain are reproduced:
-- `id` (referenced by every user-owned table) and `email`.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

-- ---------------------------------------------------------------------------
-- Self-identification.
--
-- `scripts/verify-rls.ts` refuses to touch a database whose `auth` schema it did
-- not create — that check is what stands between this file and somebody's
-- production project. This marker is how the script tells the two apart, so the
-- harness is safely re-runnable while a real project is still refused.
-- ---------------------------------------------------------------------------
create table if not exists auth.gm_local_shim_marker (
  marked_at timestamptz not null default now()
);
insert into auth.gm_local_shim_marker (marked_at)
  select now() where not exists (select 1 from auth.gm_local_shim_marker);

create table if not exists auth.users (
  id         uuid        primary key default gen_random_uuid(),
  email      text        unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- auth.uid()
--
-- Supabase's definition, verbatim in behaviour: the `sub` claim of the JWT that
-- PostgREST placed in the `request.jwt.claims` setting for this request. Returns
-- NULL when there is no request context (a direct psql session, a background
-- job), which is what makes every owner-only policy fail closed rather than open.
-- ---------------------------------------------------------------------------
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  -- Cast to uuid on the way out, exactly as Supabase does: the claim is text,
  -- the function returns uuid, and a null/garbage claim must yield NULL rather
  -- than a type error that would abort the request instead of denying it.
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

comment on function auth.uid() is
  'Local shim of the Supabase definition: the sub claim of the current request JWT, or NULL.';

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_setting('role', true)
  )
$$;

-- ---------------------------------------------------------------------------
-- Grants. Supabase grants usage on the auth schema but no table privileges to
-- anon/authenticated; the app only ever reaches auth.users through
-- SECURITY DEFINER functions, and the same is true here.
-- ---------------------------------------------------------------------------
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Default privileges — and the single most misunderstood thing about Supabase.
--
-- Every Supabase project grants table privileges in `public` to anon and
-- authenticated. That looks alarming and is not: the grant only lets a client
-- *attempt* the statement. Row level security decides what it may actually see,
-- which is why every table in 001 enables RLS and why "no table is readable by
-- anon" is a statement about policies, not about grants.
--
-- Reproducing the grant matters for a second reason: it is the only way the
-- REVOKEs at the end of 002 do anything. Revoking a privilege nobody held is a
-- no-op, so a verifier that skipped this would report the limiter as locked down
-- without ever having tested the lock.
-- ---------------------------------------------------------------------------
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- The verifier runs as a superuser and switches roles; it needs to be able to
-- read the role list.
grant select on auth.users to service_role;


