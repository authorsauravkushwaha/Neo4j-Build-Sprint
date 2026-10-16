#!/bin/sh
# Back up the project database: a custom-format dump, a checksum beside it, and
# a retention window. Then prove the newest dump restores — an unverified backup
# is a belief, not a backup.
set -eu
. "$(dirname "$0")/common.sh"
gm_require_secrets

if ! gm_is_up; then
  echo "db: server is not running — start it with npm run db:up" >&2
  exit 1
fi

mkdir -p "$GM_BACKUPS"
chmod 700 "$GM_BACKUPS"

stamp="$(date -u +%Y%m%d-%H%M%S)"
out="$GM_BACKUPS/graphmentor-$stamp.dump"

"$PGBIN/pg_dump" -Fc -f "$out" "$(gm_admin_url "$GM_DB_NAME")"
chmod 600 "$out"
( cd "$GM_BACKUPS" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )
chmod 600 "$out.sha256"

size="$(du -h "$out" | cut -f1)"
echo "db: dump written $out ($size)"

# Retention: newest 14 dumps, and their checksums. Dumps of a database that only
# holds curriculum-adjacent per-user rows are small; the window is about having
# several restore points, not about disk.
keep=14
ls -1t "$GM_BACKUPS"/graphmentor-*.dump 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do
  rm -f "$old" "$old.sha256"
  echo "db: pruned $(basename "$old")"
done

if [ "${1:-}" = "--verify" ]; then
  exec "$(dirname "$0")/restore-verify.sh" "$out"
fi

echo "db: verify it restores with: npm run db:restore-verify"


