#!/bin/sh
# Print the environment the application and the verification harnesses need,
# without ever putting a password in it (the 0600 pgpass file is the only place
# a password is read from):
#
#   eval "$(db/bin/app-env.sh)"
#   npm run smoke:http
#   npm run verify:rls
#
# `gm_app` is the least-privileged role: three EXECUTE grants. `verify:rls`
# additionally needs a superuser because it provisions and switches roles, so it
# uses the admin URL.
set -eu
. "$(dirname "$0")/common.sh"
gm_require_secrets

echo "export PGPASSFILE='$GM_SECRETS/pgpass'"
echo "export PGHOST=127.0.0.1"
echo "export PGPORT=$GM_PORT"
echo "export PGSSLMODE=verify-full"
echo "export PGSSLROOTCERT='$GM_CERTS/ca.crt'"
echo "export PGSSLCERT='$GM_CERTS/client-gm_app.crt'"
echo "export PGSSLKEY='$GM_CERTS/client-gm_app.key'"
echo "export DATABASE_URL='$(gm_app_url)'"
echo "export DATABASE_ADMIN_URL='$(gm_admin_url "$GM_DB_NAME")'"
echo "export DATABASE_AUTH_URL='$(gm_auth_url)'"


