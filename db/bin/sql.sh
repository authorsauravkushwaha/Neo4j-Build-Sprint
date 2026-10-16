#!/bin/sh
# Open a psql session against the project database.
#
#   db/bin/sql.sh            # as gm_admin (administration)
#   db/bin/sql.sh owner      # as gm_owner, the object owner (SET ROLE inside the session)
#   db/bin/sql.sh app        # as gm_app, the application role — the least privileged view there is
#
# Passwords are read from the 0600 pgpass file; nothing appears in the command
# line or in `ps`.
set -eu
. "$(dirname "$0")/common.sh"
gm_require_secrets

which="${1:-admin}"
shift 2>/dev/null || true

case "$which" in
  admin) exec "$PGBIN/psql" "$(gm_admin_url "$GM_DB_NAME")" "$@" ;;
  owner) exec env PGOPTIONS='-c role=gm_owner' "$PGBIN/psql" "$(gm_admin_url "$GM_DB_NAME")" "$@" ;;
  app)   exec "$PGBIN/psql" "$(gm_app_url)" "$@" ;;
  *) echo "usage: sql.sh [admin|owner|app] [psql args]" >&2; exit 2 ;;
esac


