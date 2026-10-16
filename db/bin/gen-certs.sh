#!/bin/sh
# GraphMentor AI — TLS material for the database server.
#
# A private certificate authority is created on this machine and used to issue:
#
#   ca.crt / ca.key            the trust anchor. The key is 0600 and never leaves.
#   server.crt / server.key    the server's identity, SAN = localhost + 127.0.0.1.
#   client-gm_admin.crt/.key   a *client* certificate whose CN is gm_admin.
#   client-gm_app.crt/.key     a *client* certificate whose CN is gm_app.
#
# Why client certificates at all: `pg_hba.conf` requires `clientcert=verify-full`
# alongside SCRAM, so a connection needs the key file in $GM_CERTS *and* the
# password. A password alone is not enough — which matters on a host where a
# port forwarder can make a remote connection look like it came from loopback.
#
# Regenerating invalidates every existing client certificate, so it only happens
# when material is missing.
set -eu
. "$(dirname "$0")/common.sh"

mkdir -p "$GM_CERTS"
chmod 700 "$GM_CERTS"

if [ -f "$GM_CERTS/ca.crt" ] && [ -f "$GM_CERTS/ca.key" ] \
   && [ -f "$GM_CERTS/server.crt" ] && [ -f "$GM_CERTS/server.key" ] \
   && [ -f "$GM_CERTS/client-gm_admin.crt" ] && [ -f "$GM_CERTS/client-gm_admin.key" ] \
   && [ -f "$GM_CERTS/client-gm_app.crt" ] && [ -f "$GM_CERTS/client-gm_app.key" ] \
   && [ -f "$GM_CERTS/client-gm_auth.crt" ] && [ -f "$GM_CERTS/client-gm_auth.key" ]; then
  echo "db: certificate authority and certificates already present in $GM_CERTS"
  exit 0
fi

# A half-generated set is worse than none: start clean rather than mix issuers.
rm -f "$GM_CERTS"/ca.* "$GM_CERTS"/server.* "$GM_CERTS"/client-*.crt "$GM_CERTS"/client-*.key

echo "db: creating a private certificate authority"
openssl req -new -x509 -days 3650 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$GM_CERTS/ca.key" -out "$GM_CERTS/ca.crt" \
  -subj "/CN=graphmentor-db-ca" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

issue() {
  name="$1"; cn="$2"; usage="$3"; san="$4"
  openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$GM_CERTS/$name.key" -out "$GM_CERTS/$name.csr" -subj "/CN=$cn" 2>/dev/null
  if [ -n "$san" ]; then
    openssl x509 -req -in "$GM_CERTS/$name.csr" -CA "$GM_CERTS/ca.crt" -CAkey "$GM_CERTS/ca.key" \
      -CAcreateserial -days 3650 -out "$GM_CERTS/$name.crt" \
      -extfile /dev/stdin 2>/dev/null <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=$usage
subjectAltName=$san
EXT
  else
    openssl x509 -req -in "$GM_CERTS/$name.csr" -CA "$GM_CERTS/ca.crt" -CAkey "$GM_CERTS/ca.key" \
      -CAcreateserial -days 3650 -out "$GM_CERTS/$name.crt" \
      -extfile /dev/stdin 2>/dev/null <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=$usage
EXT
  fi
  rm -f "$GM_CERTS/$name.csr"
}

echo "db: issuing the server certificate (SAN localhost + 127.0.0.1)"
issue server graphmentor-db serverAuth "DNS:localhost,IP:127.0.0.1"

# The CN of a client certificate must equal the database role name, because
# pg_hba.conf uses clientcert=verify-full.
echo "db: issuing client certificates for gm_admin, gm_app and gm_auth"
issue client-gm_admin gm_admin clientAuth ""
issue client-gm_app gm_app clientAuth ""
issue client-gm_auth gm_auth clientAuth ""

chmod 600 "$GM_CERTS"/ca.key "$GM_CERTS"/server.key "$GM_CERTS"/client-*.key
chmod 644 "$GM_CERTS"/ca.crt "$GM_CERTS"/server.crt "$GM_CERTS"/client-*.crt
rm -f "$GM_CERTS"/ca.srl
echo "db: wrote CA, server and client certificates to $GM_CERTS"


