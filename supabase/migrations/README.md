# Database migrations

Two migrations describe everything the Edge Functions and the web app store.

| File | Contents |
| --- | --- |
| `001_graphmentor_core.sql` | `profiles`, `saved_roadmaps`, `roadmap_tasks`, `user_skill_progress`, `bookmarks`, `feedback`, RLS policies, `updated_at` triggers, signup trigger. |
| `002_graphmentor_rate_limit.sql` | `gm_rate_limit`, `gm_nonce`, and the three `SECURITY DEFINER` functions (`gm_consume_rate_limit`, `gm_claim_nonce`, `gm_cleanup_rate_limit`) used for rate limiting and replay protection. |

The knowledge graph itself does **not** live in Postgres. It lives in Neo4j (or in
the bundled sample dataset) and is read through the Edge Functions. Postgres only
holds per-user records.

## Applying them

```bash
# one time: log in and link this folder to your project
supabase login
supabase link --project-ref YOUR_PROJECT_REF
# if supabase/config.toml does not exist yet, create it without touching migrations
supabase init

supabase db push          # applies 001 then 002
```

`supabase db push` runs each migration once and records it in
`supabase_migrations.schema_migrations`. Both files are written to be safe to run
again by hand (all `create ... if not exists`, `drop policy if exists`, and
`create or replace function`), but the CLI is the supported path.

## Verifying

After pushing, run the queries at the bottom of `002_graphmentor_rate_limit.sql`:

1. every table in `public` has `relrowsecurity = true`,
2. `has_table_privilege('anon', 'public.gm_rate_limit', 'select')` is `false`,
3. `has_function_privilege('anon', 'public.gm_claim_nonce(text, integer)', 'execute')` is `false`,
4. the constraint names used as upsert conflict targets exist.

Then confirm the app sees them:

```bash
curl -s "$SUPABASE_URL/functions/v1/health-check" | jq
# "storage": { "configured": true }  means the service-role client is working
```

## What the policies protect

- **Every user table** is owner-only: `auth.uid() = user_id` (or `= id` for
  `profiles`) on SELECT, INSERT, UPDATE and DELETE. The Edge Functions also scope
  every query to the server-verified user id — RLS is the second layer, not the
  only one.
- **`feedback`** can be inserted by guests (`user_id` must be `null` or the
  caller's own id) and read back only by its author. There is no client-facing
  read-all policy: maintainers read it through the Supabase dashboard.
- **`gm_rate_limit` and `gm_nonce`** have RLS enabled and *no* policies, and
  their functions are callable only by `service_role`. A leaked anon key cannot
  read counters, inflate them, or claim nonces.
- **Composite keys** (`roadmap_tasks (roadmap_id, user_id) -> saved_roadmaps (id, user_id)`)
  make it impossible to attach a task to somebody else's roadmap even if a bug
  let an unowned id through.

## Verified against this project's own database

Superseded note: these migrations were once only checked by eye. They are now
applied, unmodified, to the project's own PostgreSQL 17 cluster (`db/`, created
by `npm run db:provision`) and attacked there:

- `npm run verify:rls` — 42/42: cross-account isolation, the limiter, nonces.
- `npm run verify:db` — 71/71: hardening assertions plus a live attack battery
  (wrong passwords, plaintext and socket connections, privilege escalation,
  SQL injection through the limiter, nonce replay, DoS ceilings, config drift).
- `npm run smoke:http` — 30/30 with the limiter on this database, driven by the
  least-privileged `gm_app` role.

Results are written to `docs/database-verification.json`. What remains
unverified is a hosted Supabase deployment: `supabase db push` against a real
project has still never been run from here, so treat the first push as a test,
not a formality.


