-- ============================================================================
-- GraphMentor AI — credentials and sessions for our own sign-in server
--
-- Applied after 00_auth_contract.sql, as gm_owner. These two tables are the
-- entire credential surface of the project:
--
--   auth.credentials  one row per account: a scrypt password hash (never the
--                     password, never a reversible form). Written only by the
--                     auth server (server/server.ts) running as gm_auth.
--   auth.sessions     one row per signed-in browser: the SHA-256 hash of the
--                     session token, never the token itself, so a database
--                     leak does not hand out live sessions. The browser holds
--                     the token in an HttpOnly cookie.
--
-- Deliberately NOT row-level-secured: the only role with any privilege on
-- these tables is gm_auth, which is the server itself. RLS policies are for
-- roles that represent end users; no end-user role ever connects here.
-- gm_app and the platform roles have no access at all (verified in
-- db/security/00_hardening.sql grants and by scripts/verify-db.ts).
-- ============================================================================

create table if not exists auth.credentials (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  password_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table auth.credentials is
  'scrypt password hashes, one per account. Only gm_auth (the sign-in server) may read or write.';

create table if not exists auth.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists auth_sessions_user_idx on auth.sessions (user_id);
create index if not exists auth_sessions_expiry_idx on auth.sessions (expires_at);

comment on table auth.sessions is
  'Server-side sessions: SHA-256 of the cookie token, expiry, nothing else.';


