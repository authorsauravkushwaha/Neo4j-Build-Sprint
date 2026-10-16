# GraphMentor's own database

A self-owned PostgreSQL 17 cluster for this project. Not a managed service, not a hosted
Postgres: **this repository creates, configures, hardens and verifies the server it runs on**,
with every control either enforced in the files below or measured by `npm run verify:db`.

```
db/
├── postgresql.conf        policy source of truth — copied into PGDATA at provision, diffed by the verifier
├── pg_hba.conf            who may connect, from where, with what authentication
├── identity/
│   └── 00_auth_contract.sql   the `auth` schema + `auth.uid()` + anon/authenticated/service_role
├── security/
│   └── 00_hardening.sql   role attributes, least-privilege grants, FORCE RLS, revokes
└── bin/
    ├── provision.sh       create the cluster, roles, certificates, apply identity + migrations + hardening
    ├── start.sh / stop.sh / status.sh
    ├── gen-certs.sh       self-signed TLS material for 127.0.0.1 / localhost
    ├── sql.sh             open psql as admin, owner or app, reading the 0600 password files
    ├── backup.sh          pg_dump -Fc + checksum + retention, and the restore that proves it
    └── restore-verify.sh  restore the newest dump into a scratch database and compare row counts
```

Run it:

```bash
npm run db:provision      # idempotent: safe to re-run after any change
npm run db:up             # start (no-op if already running)
npm run verify:db         # the hardening + attack battery, writes docs/database-verification.json
npm run db:backup         # dump + verify the dump restores
npm run db:down
```

## The access model, in one table

| Role | Credential? | What it can do | Who uses it |
| --- | --- | --- | --- |
| `gm_admin` | yes — random 48-char password, `0600` file **outside the repository** | cluster administration: bootstrap, `set role` for migrations, backup, `verify:rls` / `smoke:http` harnesses | you, on this machine |
| `gm_owner` | **none — NOLOGIN** | owns the database, the schemas and every object; used only by `set role` during provisioning | `provision.sh` |
| `gm_app` | yes — random 48-char password **plus a client certificate** (private CA, `clientcert=verify-full`) | `EXECUTE` on three rate-limit/nonce functions. **No table privileges at all.** | the API server, if it talks to Postgres directly |
| `gm_auth` | yes — random 48-char password **plus a client certificate** | The credential tables (`auth.users`, `auth.credentials`, `auth.sessions`) plus four sync tables (`public.profiles`, `public.user_skill_progress`, `public.bookmarks`, `public.user_task_progress`) under role-scoped RLS policies; every statement is scoped by the server to the session's user id. **No access to server-saved roadmaps (`saved_roadmaps`/`roadmap_tasks`) or feedback.** | the sign-in server (`server/server.ts`) |
| `anon`, `authenticated`, `service_role` | none — NOLOGIN, exactly as the platform contract defines | reached only by `set role` from a trusted server session; `service_role` holds `BYPASSRLS` because the migrations' revokes are written against it | the migrations and the RLS verifier |

The point of that table: **the credential the application holds cannot read a single user row.**
`gm_app` is not a member of `service_role`, holds no `SELECT` on any table, and cannot create,
alter or drop anything. If it leaked, the blast radius is "somebody could spend your rate-limit
budget".

## The sign-in server

`server/server.ts` (`npm run server`, port 8787) is the account system behind
the sign-in form. It connects as `gm_auth`, stores scrypt password hashes in
`auth.credentials` and hashed session tokens in `auth.sessions`, and serves
`/api/auth/{register,login,logout,me,change-password,account}`. The browser
reaches it only through the Vite proxy at `/api`; sessions are HttpOnly
cookies, sign-in failures are one generic message (with a dummy-hash verify
so timing does not discriminate either), attempts are rate-limited, and
account deletion cascades through credentials, sessions and the profile.

## Why "only I can access it" is true, mechanically

1. `listen_addresses = '127.0.0.1'` — the server binds loopback only. Nothing outside this
   machine can open a TCP connection to it. `npm run verify:db` proves it from `ss -ltn`.
2. `pg_hba.conf` has exactly three `hostssl` lines (one per credential-holding role from
   `127.0.0.1/32`, `scram-sha-256 clientcert=verify-full`) and **rejects everything else**: no
   `trust`, no `peer`, no plaintext TCP, no Unix socket, no other host. Two factors are
   required — a client certificate signed by the project's private CA whose CN equals the
   role name, *and* that role's password. That second factor is what makes loopback-only
   binding meaningful on a host where a port forwarder can make a remote connection arrive
   looking local: `verify:db` connects through that forwarded path and is refused.
3. Passwords are 48 random characters generated at provision time, stored `0600` in a `0700`
   directory under `/srv/graphmentor-pg/secrets` — outside the repository, and asserted absent
   from the repo by the verifier.
4. `password_encryption = 'scram-sha-256'` (never `md5`), and the `passwordcheck` module
   refuses weak passwords at `CREATE`/`ALTER ROLE` time — verified by attempting one.
5. TLS is mandatory on every accepted connection (`hostssl` only) with a minimum of TLS 1.2;
   `sslmode=disable` is refused, and a TLS 1.1 handshake is refused.

## What this deployment does **not** claim

- **No encryption at rest.** The data files sit on this machine's disk unencrypted. Full-disk
  or filesystem encryption is a host decision this repository cannot make or verify; the
  honest mitigation is that the only credential that reads data is on the same host and the
  server is not reachable from a network.
- **No managed backups, no replication, no failover.** `backup.sh` writes dumps you own, and
  `restore-verify.sh` proves one restores. There is no off-site copy.
- **No native brute-force throttle.** PostgreSQL locks no accounts and delays no attacker. The
  app-layer limiter (`gm_rate_limit`) is what throttles HTTP attempts, and the server logs every
  failed connection; `verify:db` demonstrates both rather than implying the database does it.
- **No third-party audit.** Every claim here is produced by commands in this repository.
- **Not a substitute for the platform's PostgREST/GoTrue layers.** This cluster provides the
  *database*; the API surface in front of it is `supabase/functions/` running against it.


