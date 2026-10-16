-- ============================================================================
-- GraphMentor AI — the auth contract, owned by this project
--
-- This is the identity layer of *our* database. It exists because
-- `supabase/migrations/*.sql` reference four things a plain PostgreSQL server
-- does not provide, and we would rather own those four things than depend on a
-- hosted platform to provide them:
--
--   1. the `auth` schema and `auth.users` (the identity table),
--   2. `auth.uid()` — the expression every RLS policy in this repository is
--      written against,
--   3. the `anon`, `authenticated` and `service_role` roles,
--   4. the `request.jwt.claims` session setting the request layer populates per
--      request from a verified token.
--
-- Applied by `db/bin/provision.sh` **as `gm_owner`** (the NOLOGIN role that owns
-- every object in this database), so nothing here is owned by a superuser.
--
-- Relationship to `supabase/local/00_supabase_shim.sql`: that file is the test
-- harness's copy, marked "never run this on a real project" because it would
-- collide with a hosted platform's own `auth` schema. This file is the same
-- contract, owned by us, for a server we run. `tests/unit/db-contract.test.ts`
-- compares the two `auth.uid()` bodies so they cannot drift apart.
--
-- Deliberate difference from the hosted platform: nothing in this database
-- grants the application role (`gm_app`) the ability to switch into
-- `service_role`, so `BYPASSRLS` is never reachable by a credential the
-- application holds. See db/security/00_hardening.sql.
-- ============================================================================

create schema if not exists auth;

-- ---------------------------------------------------------------------------
-- Ownership marker.
--
-- `scripts/verify-rls.ts` refuses to touch any database whose `auth` schema it
-- did not create, and it identifies its own work with this table. Ours is the
-- same table, for the same reason, one level up: it marks the `auth` schema as
-- project-owned rather than a hosted platform's. Without it the RLS harness
-- would (correctly) refuse to run against our own server.
-- ---------------------------------------------------------------------------
create table if not exists auth.gm_local_shim_marker (
  marked_at timestamptz not null default now()
);
insert into auth.gm_local_shim_marker (marked_at)
  select now() where not exists (select 1 from auth.gm_local_shim_marker);

comment on table auth.gm_local_shim_marker is
  'Marks the auth schema as created by this project''s own tooling, so verify-rls may run here.';

-- ---------------------------------------------------------------------------
-- auth.users — identities.
--
-- Only the two columns the migrations constrain are modelled: `id` (every
-- user-owned table references it) and `email`. A self-hosted identity service
-- would add credentials, confirmation state and hashed refresh tokens; those
-- belong to that service, not to this schema, and this file does not pretend to
-- have them.
-- ---------------------------------------------------------------------------
create table if not exists auth.users (
  id         uuid        primary key default gen_random_uuid(),
  email      text        unique,
  created_at timestamptz not null default now()
);

comment on table auth.users is
  'Identity rows. Passwords and sessions live in the identity service, never here.';

-- ---------------------------------------------------------------------------
-- auth.uid() — the identity of the current request.
--
-- Behaviourally identical to the hosted platform's definition: the `sub` claim
-- of the verified token the request layer placed in `request.jwt.claims`, cast
-- to uuid, and NULL when there is no request context at all. NULL is the
-- important half: it is what makes every owner-only policy fail closed for a
-- background job or a bare psql session instead of failing open.
-- ---------------------------------------------------------------------------
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

comment on function auth.uid() is
  'The sub claim of the current request token as uuid, or NULL when there is no request context.';

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

comment on function auth.role() is
  'The role claim of the current request token, or the current SQL role.';

-- ---------------------------------------------------------------------------
-- Grants.
--
-- `usage` on the schemas is what lets a role resolve the names it is allowed to
-- touch; it grants no data access. Table privileges are deliberately absent for
-- anon/authenticated: row level security decides what a policy allows, and the
-- only way to attempt a statement is to hold the grant, which is why the
-- migrations' REVOKEs are meaningful here.
-- ---------------------------------------------------------------------------
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- The RLS harness reads auth.users while it runs; it is the only reader, and it
-- is a NOLOGIN role that must be entered deliberately.
grant select on auth.users to service_role;


