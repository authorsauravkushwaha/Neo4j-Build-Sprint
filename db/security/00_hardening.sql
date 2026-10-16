-- ============================================================================
-- GraphMentor AI — least privilege and defence in depth
--
-- Applied by gm_admin immediately after the identity contract and the
-- migrations. Everything here is a narrowing: revokes first, then the smallest
-- grants that let the application do its job.
--
-- The verifier (`scripts/verify-db.ts`) re-asserts every claim in this file
-- against the live server, so this is a statement of intent that is checked,
-- not a comment that is trusted.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The database itself
-- ---------------------------------------------------------------------------
-- PUBLIC holds CONNECT and TEMP on a new database by default. Both go: no role
-- connects unless it was named, and nobody gets to write temporary objects.
revoke all on database graphmentor from public;
grant connect on database graphmentor to gm_admin, gm_owner, gm_app, gm_auth;

-- ---------------------------------------------------------------------------
-- 2. Schemas
-- ---------------------------------------------------------------------------
-- CREATE on `public` is gone for everyone but the owner: an application role
-- that can create objects can create a table with a name an unqualified query
-- later resolves to. USAGE is what gm_app needs and all it gets.
revoke all on schema public from public;
revoke create on schema public from public;
alter schema public owner to gm_owner;
grant usage on schema public to gm_app;

-- ---------------------------------------------------------------------------
-- 3. What gm_app may do, in full
-- ---------------------------------------------------------------------------
-- First take EXECUTE away from PUBLIC on everything in `public`. PostgreSQL
-- grants EXECUTE on new functions to PUBLIC by default, which is how `crypt`,
-- `pgp_sym_encrypt`, `digest`, `pg_stat_statements` and the two trigger helpers
-- ended up callable by any role — including the application role — without
-- anyone deciding that. (pgcrypto installs into `public` when created without a
-- schema qualifier, as migration 001 does; this closes the door after it.)
revoke execute on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;

-- Then grant the application exactly three functions. Not one SELECT, INSERT,
-- UPDATE or DELETE on any table in this database — the API server reaches user
-- data through the verified-claim path, never by holding broad table rights.
grant execute on function public.gm_consume_rate_limit(text, integer, integer) to gm_app;
grant execute on function public.gm_claim_nonce(text, integer) to gm_app;
grant execute on function public.gm_cleanup_rate_limit(integer) to gm_app;

-- Explicitly: gm_app is not a member of anything. (Membership is how a "small"
-- grant turns into BYPASSRLS in a repository nobody re-reads.)
do $$
declare
  membership record;
begin
  for membership in
    select r.rolname as parent
    from pg_auth_members m
    join pg_roles r on r.oid = m.roleid
    join pg_roles g on g.oid = m.member
    where g.rolname = 'gm_app'
  loop
    execute format('revoke %I from gm_app', membership.parent);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3b. What gm_auth (the sign-in server) may do, in full
-- ---------------------------------------------------------------------------
-- The three credential tables in the auth schema, plus — for account sync —
-- three of the personal-data tables in public: profiles, skill ratings and
-- bookmarks. Note what is still absent: saved roadmaps, roadmap tasks and
-- feedback are not granted, and there is no access to any other public table.
grant select, insert, update, delete on table auth.users to gm_auth;
grant select, insert, update, delete on table auth.credentials to gm_auth;
grant select, insert, update, delete on table auth.sessions to gm_auth;
grant usage on schema auth to gm_auth;

grant select, insert, update, delete on table public.profiles to gm_auth;
grant select, insert, update, delete on table public.user_skill_progress to gm_auth;
grant select, insert, update, delete on table public.bookmarks to gm_auth;
grant select, insert, update, delete on table public.user_task_progress to gm_auth;
grant usage on schema public to gm_auth;

-- The sync tables have FORCE row level security, and their user policies are
-- written for the `authenticated` role — which gm_auth is not. These
-- role-scoped policies are what let the server in at all: they apply only
-- when the session role is gm_auth, a NOLOGIN-in-practice server role no
-- browser can become. Per-user isolation is then enforced by the server,
-- which scopes every statement to the session's user id (server/server.ts
-- /api/sync) — the same defence-in-depth split the migrations document: the
-- API scopes, RLS backstops the roles that represent people.
drop policy if exists gm_auth_sync_profiles on public.profiles;
create policy gm_auth_sync_profiles on public.profiles
  for all to gm_auth using (true) with check (true);
drop policy if exists gm_auth_sync_progress on public.user_skill_progress;
create policy gm_auth_sync_progress on public.user_skill_progress
  for all to gm_auth using (true) with check (true);
drop policy if exists gm_auth_sync_bookmarks on public.bookmarks;
create policy gm_auth_sync_bookmarks on public.bookmarks
  for all to gm_auth using (true) with check (true);
drop policy if exists gm_auth_sync_tasks on public.user_task_progress;
create policy gm_auth_sync_tasks on public.user_task_progress
  for all to gm_auth using (true) with check (true);

-- gm_auth is a member of nothing either.
do $$
declare
  membership record;
begin
  for membership in
    select r.rolname as parent
    from pg_auth_members m
    join pg_roles r on r.oid = m.roleid
    join pg_roles g on g.oid = m.member
    where g.rolname = 'gm_auth'
  loop
    execute format('revoke %I from gm_auth', membership.parent);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Nobody creates anything by default
-- ---------------------------------------------------------------------------
-- Belt and braces for a future migration authored outside this repository.
alter default privileges in schema public revoke all on tables from public;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke all on sequences from public;

-- ---------------------------------------------------------------------------
-- 5. FORCE row level security on every table that holds a person's data
-- ---------------------------------------------------------------------------
-- Enabled RLS protects against anon/authenticated. FORCE extends it to the
-- table's own owner, which matters the day the owner identity acquires a
-- credential, or a future helper runs as gm_owner and forgets its claim.
--
-- Deliberately NOT forced: gm_rate_limit and gm_nonce. The SECURITY DEFINER
-- maintenance functions run as gm_owner, and with no policy defined those two
-- tables would become unreadable to their own owner — breaking the limiter in
-- the name of hardening it. They keep RLS *enabled* (so no policy means no
-- access for anon, authenticated or service_role except through the functions).
alter table public.profiles             force row level security;
alter table public.saved_roadmaps       force row level security;
alter table public.roadmap_tasks        force row level security;
alter table public.user_skill_progress  force row level security;
alter table public.bookmarks            force row level security;
alter table public.user_task_progress   force row level security;
alter table public.feedback             force row level security;

-- FORCE would otherwise break the one legitimate system write: migration 001's
-- gm_handle_new_user() is SECURITY DEFINER (owned by gm_owner) and inserts the
-- profile row at signup, when there is no request claim yet. This policy is
-- scoped `to gm_owner`, a NOLOGIN role reachable only through that definer
-- function, so it opens nothing for anon, authenticated or gm_app — the
-- verifier proves the trigger works and cross-account writes still fail.
drop policy if exists gm_owner_system_insert on public.profiles;
create policy gm_owner_system_insert on public.profiles
  for insert to gm_owner with check (true);
-- The function's INSERT ... ON CONFLICT DO NOTHING also needs SELECT
-- visibility for its arbiter check, or Postgres reports an RLS violation even
-- though the INSERT policy passed. Same scope: gm_owner only.
drop policy if exists gm_owner_system_select on public.profiles;
create policy gm_owner_system_select on public.profiles
  for select to gm_owner using (true);

-- ---------------------------------------------------------------------------
-- 6. Every SECURITY DEFINER function must pin its search_path
-- ---------------------------------------------------------------------------
-- A definer function without a pinned search_path is a privilege-escalation
-- gadget: a caller who can create a schema can shadow a function or operator it
-- resolves unqualified. The migrations already set it; this makes it true for
-- any function added later, and the verifier fails if one appears without it.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proconfig is null
  loop
    execute format('alter function %s set search_path = public, pg_temp', fn.signature);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Observability the server actually uses
-- ---------------------------------------------------------------------------
-- pg_stat_statements is loaded by shared_preload_libraries (db/postgresql.conf);
-- the extension records normalised statement text so an unexpected query shape
-- is discoverable after the fact.
create extension if not exists pg_stat_statements;


