#!/bin/sh
# Restore the newest dump into a scratch database and compare every row count
# against the live server. The scratch database is dropped afterwards.
#
#   db/bin/restore-verify.sh [path/to/dump]
set -eu
. "$(dirname "$0")/common.sh"
gm_require_secrets

dump="${1:-$(ls -1t "$GM_BACKUPS"/graphmentor-*.dump 2>/dev/null | head -1)}"
if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "db: no dump found — run npm run db:backup first" >&2
  exit 1
fi

echo "db: restore check on $(basename "$dump")"

if [ -f "$dump.sha256" ]; then
  ( cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" >/dev/null )
  echo "  checksum matches"
fi

scratch="graphmentor_restore_check"
gm_psql "$(gm_admin_url postgres)" -c "drop database if exists $scratch" >/dev/null
gm_psql "$(gm_admin_url postgres)" -c "create database $scratch owner gm_admin" >/dev/null

"$PGBIN/pg_restore" --no-owner --no-privileges -d "$(gm_admin_url "$scratch")" "$dump" >/dev/null 2>&1
echo "  restored into $scratch"

counts() {
  "$PGBIN/psql" "$(gm_admin_url "$1")" -tA -F'|' -c "
    select c.relname, (xpath('/row/c/text()',
             query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname"
}

live="$(counts "$GM_DB_NAME")"
restored="$(counts "$scratch")"

if [ "$live" = "$restored" ]; then
  tables="$(printf '%s\n' "$live" | wc -l | tr -d ' ')"
  echo "  row counts identical across $tables tables — the dump restores"
  status=0
else
  echo "  MISMATCH between live and restored:" >&2
  printf 'live:     %s\nrestored: %s\n' "$live" "$restored" >&2
  status=1
fi

gm_psql "$(gm_admin_url postgres)" -c "drop database $scratch" >/dev/null
exit "$status"


