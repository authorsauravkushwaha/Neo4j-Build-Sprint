#!/bin/sh
# GraphMentor AI — cluster paths and binary discovery, sourced by every db/bin script.
#
# Nothing here contains a secret: the passwords live in $GM_SECRETS (0700) and are
# read through a 0600 pgpass file, never through an argument or an environment
# variable that `ps` could show another user.
set -eu

GM_DB_ROOT="${GM_DB_ROOT:-/srv/graphmentor-pg}"
GM_PGDATA="$GM_DB_ROOT/data"
GM_RUN="$GM_DB_ROOT/run"
GM_LOG="$GM_DB_ROOT/log"
GM_CERTS="$GM_DB_ROOT/certs"
GM_SECRETS="$GM_DB_ROOT/secrets"
GM_BACKUPS="$GM_DB_ROOT/backups"
GM_PORT="${GM_PORT:-5433}"
GM_DB_NAME="${GM_DB_NAME:-graphmentor}"
GM_REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# Debian installs the server binaries outside PATH; find the newest by version.
if [ -z "${PGBIN:-}" ]; then
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/pg_ctl" ]; then
  PGBIN="$(dirname "$(command -v pg_ctl 2>/dev/null || echo /nonexistent)")"
fi
if [ ! -x "$PGBIN/pg_ctl" ]; then
  echo "db: PostgreSQL server tools not found (pg_ctl). Install postgresql-17 first." >&2
  exit 1
fi

export PGPASSFILE="$GM_SECRETS/pgpass"
export PGHOST=127.0.0.1
export PGPORT="$GM_PORT"
export PGSSLMODE=require
export PGCONNECT_TIMEOUT=5

gm_psql() { "$PGBIN/psql" -v ON_ERROR_STOP=1 "$@"; }

# Every URL carries the CA that verifies the server and the client certificate
# that identifies the caller, because pg_hba.conf requires both a certificate and
# a password. Paths are absolute; no secret travels in the URL itself.
gm_ssl_params() {
  printf 'sslmode=verify-full&sslrootcert=%s/ca.crt&sslcert=%s/client-%s.crt&sslkey=%s/client-%s.key' \
    "$GM_CERTS" "$GM_CERTS" "$1" "$GM_CERTS" "$1"
}

# A superuser session. Used for provisioning, backups and the verifier only.
gm_admin_url() { echo "postgresql://gm_admin@127.0.0.1:$GM_PORT/${1:-postgres}?$(gm_ssl_params gm_admin)"; }
# The application role: three EXECUTE grants and nothing else.
gm_app_url() { echo "postgresql://gm_app@127.0.0.1:$GM_PORT/$GM_DB_NAME?$(gm_ssl_params gm_app)"; }
# The sign-in server role: the auth schema's credential/session tables only.
gm_auth_url() { echo "postgresql://gm_auth@127.0.0.1:$GM_PORT/$GM_DB_NAME?$(gm_ssl_params gm_auth)"; }

gm_is_up() {
  "$PGBIN/pg_isready" -h 127.0.0.1 -p "$GM_PORT" -t 2 >/dev/null 2>&1
}

gm_require_secrets() {
  for f in gm_admin.pass gm_app.pass pgpass; do
    if [ ! -f "$GM_SECRETS/$f" ]; then
      echo "db: missing $GM_SECRETS/$f — run db/bin/provision.sh first" >&2
      exit 1
    fi
  done
  chmod 700 "$GM_SECRETS"
  chmod 600 "$GM_SECRETS"/*.pass "$GM_SECRETS/pgpass"
}


