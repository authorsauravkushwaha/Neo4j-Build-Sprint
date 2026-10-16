#!/bin/sh
# GraphMentor AI — provision (or re-provision) the project's own database.
#
# Idempotent: it creates what is missing and re-applies the policies, the
# identity contract, the migrations and the hardening in order. Safe to re-run
# after editing db/postgresql.conf, db/pg_hba.conf or any SQL in this directory.
#
# Passwords are generated once, with `openssl rand`, into $GM_SECRETS (0700,
# files 0600) — outside the repository — and never printed.
set -eu
. "$(dirname "$0")/common.sh"

say() { printf 'db: %s\n' "$1"; }

# ---- 1. directories ---------------------------------------------------------
for dir in "$GM_PGDATA" "$GM_RUN" "$GM_LOG" "$GM_CERTS" "$GM_SECRETS" "$GM_BACKUPS"; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    if [ "$dir" = "$GM_DB_ROOT" ]; then :; fi
  fi
done
# /srv/graphmentor-pg itself may need root to create; the caller is expected to
# have created it (see db/README.md). Everything below it is ours.
root_parent="$(dirname "$GM_DB_ROOT")"
if [ ! -w "$GM_DB_ROOT" ]; then
  say "cannot write $GM_DB_ROOT — create it first: sudo mkdir -p $GM_DB_ROOT && sudo chown $(id -un) $GM_DB_ROOT"
  exit 1
fi
chmod 700 "$GM_DB_ROOT" "$GM_SECRETS" "$GM_CERTS" "$GM_RUN" "$GM_LOG" "$GM_BACKUPS"
chmod 700 "$GM_PGDATA" 2>/dev/null || true

# ---- 2. secrets -------------------------------------------------------------
if [ ! -f "$GM_SECRETS/gm_admin.pass" ]; then
  openssl rand -base64 48 | tr -d '\n=' > "$GM_SECRETS/gm_admin.pass"
  say "generated a 48-byte password for gm_admin"
fi
if [ ! -f "$GM_SECRETS/gm_app.pass" ]; then
  openssl rand -base64 48 | tr -d '\n=' > "$GM_SECRETS/gm_app.pass"
  say "generated a 48-byte password for gm_app"
fi
if [ ! -f "$GM_SECRETS/gm_auth.pass" ]; then
  openssl rand -base64 48 | tr -d '\n=' > "$GM_SECRETS/gm_auth.pass"
  say "generated a 48-byte password for gm_auth"
fi
chmod 600 "$GM_SECRETS"/*.pass

# pgpass so no password ever appears in an argument or an environment variable.
{
  printf '127.0.0.1:%s:*:gm_admin:%s\n' "$GM_PORT" "$(cat "$GM_SECRETS/gm_admin.pass")"
  printf '127.0.0.1:%s:*:gm_app:%s\n' "$GM_PORT" "$(cat "$GM_SECRETS/gm_app.pass")"
  printf 'localhost:%s:*:gm_admin:%s\n' "$GM_PORT" "$(cat "$GM_SECRETS/gm_admin.pass")"
  printf 'localhost:%s:*:gm_app:%s\n' "$GM_PORT" "$(cat "$GM_SECRETS/gm_app.pass")"
  printf '127.0.0.1:%s:*:gm_auth:%s\n' "$GM_PORT" "$(cat "$GM_SECRETS/gm_auth.pass")"
  printf 'localhost:%s:*:gm_auth:%s\n' "$GM_PORT" "$(cat "$GM_SECRETS/gm_auth.pass")"
} > "$GM_SECRETS/pgpass"
chmod 600 "$GM_SECRETS/pgpass"

# ---- 3. certificates --------------------------------------------------------
sh "$GM_REPO/db/bin/gen-certs.sh" >/dev/null

# ---- 4. the cluster --------------------------------------------------------
if [ ! -f "$GM_PGDATA/PG_VERSION" ]; then
  say "initdb (new cluster, superuser gm_admin, UTF-8, SCRAM-only from the first connection)"
  "$PGBIN/initdb" -D "$GM_PGDATA" -U gm_admin --encoding=UTF8 --locale=C.UTF-8 \
    --auth-local=reject --auth-host=scram-sha-256 \
    --pwfile="$GM_SECRETS/gm_admin.pass" >/dev/null
  say "cluster created at $GM_PGDATA"
fi

# ---- 5. config: the repository files are the source of truth ----------------
install -m 600 "$GM_REPO/db/postgresql.conf" "$GM_PGDATA/postgresql.conf"
install -m 600 "$GM_REPO/db/pg_hba.conf" "$GM_PGDATA/pg_hba.conf"
say "installed postgresql.conf and pg_hba.conf from db/"

# ---- 6. start ---------------------------------------------------------------
if gm_is_up; then
  say "server already running; reloading configuration"
  "$PGBIN/pg_ctl" -D "$GM_PGDATA" reload >/dev/null
else
  say "starting the server on 127.0.0.1:$GM_PORT"
  "$PGBIN/pg_ctl" -D "$GM_PGDATA" -l "$GM_LOG/postgres.log" -w -t 30 start >/dev/null
fi

# ---- 7. roles, database -----------------------------------------------------
gm_require_secrets
say "applying roles (db/security/00_roles.sql)"
gm_psql "$(gm_admin_url postgres)" \
  -v app_pw="$(cat "$GM_SECRETS/gm_app.pass")" \
  -v auth_pw="$(cat "$GM_SECRETS/gm_auth.pass")" \
  -f "$GM_REPO/db/security/00_roles.sql" >/dev/null

if [ "$(gm_psql "$(gm_admin_url postgres)" -tAc "select 1 from pg_database where datname = '$GM_DB_NAME'")" != "1" ]; then
  say "creating database $GM_DB_NAME owned by gm_owner"
  gm_psql "$(gm_admin_url postgres)" -c "create database $GM_DB_NAME owner gm_owner" >/dev/null
fi

# ---- 8. identity contract, migrations, hardening — all as the owner ---------
say "applying the auth contract (db/identity/00_auth_contract.sql) as gm_owner"
gm_psql "$(gm_admin_url "$GM_DB_NAME")" \
  -c 'set role gm_owner' \
  -f "$GM_REPO/db/identity/00_auth_contract.sql" >/dev/null

say "applying credential tables (db/identity/01_credentials.sql) as gm_owner"
gm_psql "$(gm_admin_url "$GM_DB_NAME")" \
  -c 'set role gm_owner' \
  -f "$GM_REPO/db/identity/01_credentials.sql" >/dev/null

say "applying task progress (db/identity/02_task_progress.sql) as gm_owner"
gm_psql "$(gm_admin_url "$GM_DB_NAME")" \
  -c 'set role gm_owner' \
  -f "$GM_REPO/db/identity/02_task_progress.sql" >/dev/null

for migration in "$GM_REPO"/supabase/migrations/0*.sql; do
  say "applying $(basename "$migration") as gm_owner"
  gm_psql "$(gm_admin_url "$GM_DB_NAME")" -c 'set role gm_owner' -f "$migration" >/dev/null
done

say "applying hardening (db/security/00_hardening.sql)"
gm_psql "$(gm_admin_url "$GM_DB_NAME")" -f "$GM_REPO/db/security/00_hardening.sql" >/dev/null

# ---- 9. summary -------------------------------------------------------------
tables=$(gm_psql "$(gm_admin_url "$GM_DB_NAME")" -tAc "select count(*) from pg_tables where schemaname = 'public'")
rls=$(gm_psql "$(gm_admin_url "$GM_DB_NAME")" -tAc "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity")
forced=$(gm_psql "$(gm_admin_url "$GM_DB_NAME")" -tAc "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity")
app_tables=$(gm_psql "$(gm_admin_url "$GM_DB_NAME")" -tAc "select count(*) from information_schema.role_table_grants where grantee = 'gm_app'")
say "ready: $tables tables in public, RLS on $rls, FORCE on $forced, table privileges held by gm_app: $app_tables"
say "verify it: npm run verify:db"


