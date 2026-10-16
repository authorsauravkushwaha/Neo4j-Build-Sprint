#!/bin/sh
# Start / stop / status for the project's own PostgreSQL cluster.
#   db/bin/start.sh | stop.sh | status.sh
set -eu
. "$(dirname "$0")/common.sh"

command_name="${1:-$(basename "$0" .sh)}"

case "$command_name" in
  start)
    if gm_is_up; then
      echo "db: already running on 127.0.0.1:$GM_PORT"
      exit 0
    fi
    "$PGBIN/pg_ctl" -D "$GM_PGDATA" -l "$GM_LOG/postgres.log" -w -t 30 start
    echo "db: started on 127.0.0.1:$GM_PORT (log: $GM_LOG/postgres.log)"
    ;;
  stop)
    if ! gm_is_up; then
      echo "db: not running"
      exit 0
    fi
    "$PGBIN/pg_ctl" -D "$GM_PGDATA" -m fast -w -t 30 stop
    echo "db: stopped"
    ;;
  status)
    if gm_is_up; then
      echo "db: running on 127.0.0.1:$GM_PORT"
      "$PGBIN/psql" "$(gm_admin_url "$GM_DB_NAME")" -tAc \
        "select version() || E'\nlistening: ' || current_setting('listen_addresses') || ':' || current_setting('port') || E'\nconnections: ' || (select count(*) from pg_stat_activity) || ' of ' || current_setting('max_connections')"
    else
      echo "db: not running"
      exit 1
    fi
    ;;
  *)
    echo "usage: start.sh | stop.sh | status.sh" >&2
    exit 2
    ;;
esac


