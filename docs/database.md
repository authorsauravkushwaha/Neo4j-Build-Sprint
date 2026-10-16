# A website with its own account database (no Supabase required)

## Run it

Use Node 22 LTS (minimum 20.19) and run from the repository root:

```sh
npm ci
npm run dev
```

Vite now starts the same-origin account API **and a disk-backed PostgreSQL engine** automatically.
There is no second terminal, database installation, cloud project or key to create. For a production
build, use:

```sh
npm run build
npm start
```

The production server binds to `0.0.0.0:${PORT:-3000}` and serves both `dist/` and `/api/*`.
`npm run preview` also starts accounts, but use `npm start` for a deployed service.
Do **not** run dev, preview, and start simultaneously with the same database directory.

1. Open **Settings**. Account should show **Account database connected**.
2. Choose **Sign in or create account**, create an account, then sign in.
3. Open **Account and database sync** (`/account`). Choose **Upload this device to my account**.
4. On another browser/device, sign in with that account and download the account copy.

Sync explicitly copies **bookmarks, self-reported skill ratings, profile/display preferences, and
roadmap task progress (including hours and notes)**. Upload replaces the account copy; download
replaces the device copy after confirmation. It is not automatic background sync. Guests still keep
their data in their browser. Full generated roadmap definitions and chat transcripts are not part of
this sync. The curated knowledge graph continues to use the labelled bundled sample unless a separate
live graph backend is configured.

## How storage works

`server/database.ts` runs [PGlite](https://github.com/electric-sql/pglite), an embedded PostgreSQL engine,
**inside Node on the server**, with its data files on disk. It is not an in-browser database or an
in-memory mock. The first start transactionally applies the existing identity, table and RLS SQL from
`db/` and `supabase/migrations/`. A migration version is recorded in `gm_internal.migrations`, so
restarts do not recreate accounts. Future schema changes must add a new versioned migration to the
runner; do not edit an already-applied migration and expect it to run again.

The default directory is `.localdata/postgres` (ignored by Git). Set **`GM_DATABASE_DIR`** to a persistent
volume on a host. One Node process owns each embedded database. A heartbeat file lock prevents
simultaneous writers; after an unclean crash the lock becomes recoverable after 10 seconds. The adapter
serializes operations and reserves the connection across transactions so parallel HTTP requests cannot
interleave commits or rollbacks. Shutdown closes the database and releases the lock.

Credentials are scrypt password hashes with per-user salts. Session tokens are random; only their
SHA-256 hashes are in the database. The browser receives an HttpOnly, SameSite=Lax, Secure cookie.
Writes require a CSRF header and reject cross-host Origins. Queries use bound parameters and scope
private rows to the authenticated user. After bootstrap, the embedded engine runs as `gm_auth`, with
the same restricted grants and RLS policies used by the full PostgreSQL deployment, not as superuser.
The database files are private server data; never put them inside `public/` or `dist/`.

For plain HTTP **local development only**, set `AUTH_ALLOW_INSECURE_HTTP=true` in `.env.local` if your
browser will not accept a Secure cookie on localhost. Do not enable this on a public deployment. HTTPS
previews work with the default Secure cookies. `AUTH_TRUST_PROXY=true` is only appropriate behind a
proxy that overwrites forwarded headers; it is not required when the proxy preserves Host.

## Deploy the database-backed website

**Uploading `dist/` alone to GitHub Pages does not run Node or a database.** GitHub Pages can still host
the guest/sample frontend or a frontend connected to Supabase. To use the built-in account database,
deploy the Node website instead.

A `render.yaml` Blueprint is included for a Node web service with a persistent disk:

1. In Render, create a **Blueprint** from this repository and select the branch containing this change.
2. Review the service and disk plan before accepting it. Persistent disks require a paid plan; this
   configuration is not a promise of free hosting.
3. Render installs/builds with `npm ci --include=dev && npm run build`, starts with `npm start`, and mounts
   storage at `/var/data`. `GM_DATABASE_DIR=/var/data/postgres` keeps data across restarts/redeploys.
4. Open its HTTPS URL, check `/api/health`, then create an account. Use that URL as the database-backed
   website rather than the old GitHub Pages URL.

Any Node host/VPS with a persistent disk works with the same commands and environment variables. Keep
**one replica and one Node worker** for embedded storage; do not use ephemeral serverless functions or
multiple replicas sharing the directory. Terminate TLS at the host/reverse proxy, preserve Host, and
forward all paths (including `/api`) to the Node service. Database or migration startup failures stop
the service; it must not silently fall back to an empty database.

No hosting account is provisioned and no public deployment is made just by adding these files.

## Existing full PostgreSQL and Supabase deployments

Storage selection is explicit:

1. `DATABASE_AUTH_URL` set: use that PostgreSQL connection with `pg`. Provision its identity/schema and
   grants first with the existing `db/` tooling. It must be the `gm_auth` role, not a public browser key.
   Configure TLS/pgpass as appropriate; never disable certificate verification to make a hosted URL work.
2. Existing `GM_DB_ROOT` with `secrets/gm_auth.pass`: use the existing certificate-authenticated cluster.
   If `GM_DB_ROOT` is explicitly configured but not provisioned, startup fails with setup instructions.
3. Otherwise: use PGlite at `GM_DATABASE_DIR` or `.localdata/postgres`.

When using `npm run server` as an independently managed API, set `GM_EXTERNAL_API=true` for Vite to
proxy `/api` to `127.0.0.1:${AUTH_PORT:-8787}` rather than opening another database. In production put
that API behind a same-origin reverse proxy. The browser must never call a sandbox's localhost.

Existing Supabase-configured frontends still use Supabase Auth. Its email links/recovery and live graph
functions are not replaced by the embedded account service. Embedded accounts support password sign-in,
change password, logout and password-confirmed account deletion; there is no email verification or
forgot-password email service. Use a hosted identity provider if those capabilities are required.

## Backups and checks

Stop the website cleanly before copying the **entire** embedded data directory to private backup
storage. Restore that directory while the service is stopped, then restart and verify account login
and data. Never copy a running database directory as a consistent backup. Keep encrypted backups,
restrict disk access and test restoration before relying on this for important user data. Full
PostgreSQL deployments retain the existing `npm run db:backup` tooling.

```sh
curl http://localhost:3000/api/health
# {"ok":true,"accounts":true,"database":"connected"}
npm test -- tests/integration/database-website.test.ts tests/integration/settings-database.test.tsx
```

The integration test uses a real temporary disk-backed database and HTTP server to verify migration,
sign-up/sign-in, sync, separation between users, persistence across close/reopen, transaction rollback,
concurrent requests, CSRF checks, larger uploads and account deletion.
