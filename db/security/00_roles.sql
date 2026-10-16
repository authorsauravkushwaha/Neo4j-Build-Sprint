-- ============================================================================
-- GraphMentor AI — roles (applied by gm_admin at provision time)
--
-- Run with psql variables:
--   psql -v app_pw="$(cat /srv/graphmentor-pg/secrets/gm_app.pass)"
--
-- The four roles and why each exists:
--
--   gm_admin   cluster superuser. Bootstrap, `set role` for migrations, backup,
--              and the two verification harnesses. Never used by the app.
--   gm_owner   NOLOGIN. Owns the database, the schemas and every object, so the
--              SECURITY DEFINER functions run as a NON-superuser. There is no
--              password to steal because there is no login.
--   gm_app     The credential the API server holds. Its entire privilege set is
--              three EXECUTE grants, applied in 00_hardening.sql. It cannot read
--              one row of user data even if it is compromised.
--   anon /     created by the auth contract, NOLOGIN, exactly as the migrations
--   authenticated / service_role   expect to find them.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gm_admin') then
    create role gm_admin login superuser;
  end if;
end
$$;

-- gm_admin is the only superuser this project creates. Attributes are asserted
-- rather than assumed, so re-running after a manual edit restores the intent.
alter role gm_admin with login superuser connection limit 3;
alter role gm_admin set statement_timeout = '120s';
alter role gm_admin set idle_in_transaction_session_timeout = '30s';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gm_owner') then
    -- noinherit: membership grants do not silently apply; nologin: no credential.
    create role gm_owner nologin noinherit;
  end if;
end
$$;
alter role gm_owner with nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit;

-- ---------------------------------------------------------------------------
-- The platform contract roles.
--
-- The migrations are written against these three identities, so our database
-- provides them with the attributes the hosted platform uses: NOLOGIN (they are
-- entered with SET ROLE by a trusted server session, never by a client
-- credential) and, for service_role, BYPASSRLS — which is exactly why nothing
-- grants gm_app membership of it, and why the hardening file revokes any
-- membership it finds. `npm run verify:db` asserts both facts.
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
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;
alter role anon with nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
alter role authenticated with nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
alter role service_role with nologin nosuperuser nocreatedb nocreaterole bypassrls noinherit noreplication;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gm_app') then
    create role gm_app login;
  end if;
end
$$;
--   * nosuperuser, nocreatedb, nocreaterole — cannot administer anything,
--   * nobypassrls   — row level security applies to it, always,
--   * noinherit     — a membership granted later does not silently take effect,
--   * connection limit 8 — a connection flood from the app cannot exhaust the
--     server's 40 slots and starve the maintenance path.
alter role gm_app with
  login nosuperuser nocreatedb nocreaterole nobypassrls noreplication noinherit
  connection limit 8
  password :'app_pw';

-- Per-role ceilings, so a bug in one code path cannot pin a backend forever.
alter role gm_app set statement_timeout = '10s';
alter role gm_app set lock_timeout = '3s';
alter role gm_app set idle_in_transaction_session_timeout = '10s';
alter role gm_app set idle_session_timeout = '10min';
alter role gm_app set temp_file_limit = '128MB';
alter role gm_app set search_path = 'public';

-- ---------------------------------------------------------------------------
-- The sign-in server role.
--
-- gm_auth is what server/server.ts connects as. Its whole world is three
-- tables in the auth schema (users, credentials, sessions); the grants live in
-- 00_hardening.sql. It has no access to any public table — in particular it
-- cannot read a roadmap, a bookmark or a progress row.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gm_auth') then
    create role gm_auth login;
  end if;
end
$$;
alter role gm_auth with
  login nosuperuser nocreatedb nocreaterole nobypassrls noreplication noinherit
  connection limit 4
  password :'auth_pw';
alter role gm_auth set statement_timeout = '10s';
alter role gm_auth set idle_in_transaction_session_timeout = '10s';

comment on role gm_app is
  'Application runtime role: EXECUTE on the rate-limit and nonce functions, no table privileges at all.';
comment on role gm_owner is
  'Object owner. NOLOGIN by design: provisioning enters it with SET ROLE, so no credential exists.';


