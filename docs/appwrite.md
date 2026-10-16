# Running the API on Appwrite instead of Supabase

GraphMentor AI's server has one storage contract and two implementations of it.
The contract is `supabaseStore.ts` (despite the name — it is the *seam*, not the
vendor); the implementations are Postgres/Supabase and Appwrite. Everything above
the seam — 18 Edge Functions, all handlers, the rate limiter, the request
signing, the ownership rules — is unchanged by which one a deployment picks.

This page is the honest version: what is identical, what genuinely differs, how
each difference is covered, and what has *not* been exercised.

- Adapter: `supabase/functions/_shared/platform/appwrite.ts`
- Schema + provisioning: `supabase/functions/_shared/platform/appwriteSchema.ts`
- Wiring (the only place that reads the environment): `supabase/functions/_shared/platform/deno.ts`
- Tests: `tests/unit/appwrite-adapter.test.ts`, `tests/integration/appwrite-backend.test.ts`

## 1. The contract

`createUserRepositories(client)`, `createAuthVerifier(client)`,
`createPostgresFixedWindowStore(client)` and `createPostgresNonceStore(client)`
are written against three things:

```ts
interface SupabaseLikeClient {
  from<Row>(table: string): FilterBuilder<Row>   // select/insert/update/upsert/delete,
                                                 // eq/in/is/order/limit/single/maybeSingle
  rpc<T>(fn: string, args?: Record<string, unknown>): Promise<QueryResult<T>>
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: PostgrestError | null }> }
}
```

`createAppwriteClient()` returns that shape over Appwrite's REST API. The
consequence worth stating plainly: **the swap is one module and four environment
variables, not a rewrite**, and the handlers cannot tell which backend they are
on — except where a message legitimately should (`health-check` names the
backend; see §5).

## 2. What is identical, and how

| Behaviour the API depends on | Postgres | Appwrite |
| --- | --- | --- |
| Row shape reaching the handlers | `select *` returns snake_case columns | `decode()` strips `$id`/`$createdAt`/`$updatedAt`, restores `id`, parses JSON text back into arrays |
| Ids | `gen_random_uuid()` | the adapter generates a uuid and uses it as the `documentId` **and** as the `id` attribute |
| `upsert(..., { onConflict })` | one statement, atomic | resolve the conflict target, then `PATCH`; a `409` loses a race, so it re-reads and patches the winner |
| `insert(...).select('*').single()` | row or `PGRST116` | document, or the same `PGRST116` when it matched nothing or more than one |
| `count: 'exact'` | `Content-Range` | `x-total-count`, with a paging fallback when a server version does not send it |
| Filtering | SQL `WHERE` | `queries[]` strings (`equal(...)`, `isNull(...)`, `orderDesc(...)`, `limit(n)`, `offset(n)`) |
| Array / JSON columns | `text[]`, `jsonb` | JSON text, serialised on write and parsed on read (`JSON_TEXT_COLUMNS`) |
| Error codes | PostgREST codes | Appwrite HTTP status → the same codes (`POSTGREST_CODE_FOR_STATUS`), so `fail('…', error)` and `asApiError` behave identically |
| Rate limiting | `INSERT … ON CONFLICT DO UPDATE` returning the new count | one document per hit; the count **is** the number of documents in the window. Nothing is read-modified-written, so concurrent requests cannot lose an increment |
| Replay protection | `INSERT` into `gm_nonce` with a primary key | one document whose id is the SHA-256 of the nonce. The nonce itself is never stored, and a repeat insert is the replay signal |

Rows written by each backend are therefore interchangeable: same column names,
same value types, same ids.

## 3. What genuinely differs — and the control that covers it

### 3.1 There is no Row Level Security to fall back on

On Supabase, RLS is the primary control: even a bug in a query cannot expose
another account's rows, because Postgres refuses. Appwrite has collection
permissions, but the **server API key bypasses them**, and the server is what
holds the key. So the policy lives in the adapter instead:

- every collection is created with **no read or write permissions for any role**
  (`SERVER_ONLY_PERMISSIONS`); the browser never talks to Appwrite at all, it
  talks to our API. There is no client-visible Appwrite endpoint to attack;
- `assertScoped` refuses to *build* a `select`, `update`, `delete` on a
  user-owned collection unless it carries a `user_id` filter (`id` for
  `profiles`). The refusal happens before the request leaves the process, so this
  is a guard, not a review comment;
- `assertOwned` refuses to `PATCH` a document whose `user_id` differs from the
  row being written — the case an upsert could otherwise get wrong;
- ownership never comes from the request body: `user_id` is the verified caller
  id, and `roadmapId`/`taskId` are validated as uuids and matched against rows
  already owned by that user.

This is the main reason the adapter exists as its own module with its own tests
rather than a second `if` branch in `deno.ts`.

### 3.2 Sessions are opaque secrets, not JWTs

`createAuthVerifier` rejects any token that is not three dot-separated parts — a
correct check for a Supabase access token and a *fatal* one for an Appwrite
session secret (a long opaque string), which would make every request
unauthenticated. `createAppwriteAuthVerifier` keeps the `AuthCheck` contract
(`none` / `invalid(reason)` / `valid(userId)`) and replaces the JWT shape check
with a length and character-range test. The verdict still comes from the backend
(`GET /account`), never from the token's contents — decoding a token locally is
how authentication bypasses are written.

### 3.3 No stored procedures, no per-statement atomicity

`gm_consume_rate_limit`, `gm_claim_nonce` and `gm_cleanup_rate_limit` are
Postgres functions. The adapter answers the same three names in `rpc`, but the
implementation is documents:

- counters are **one document per request**, so the window count is a count of
  documents — exact under concurrency, with no read-modify-write;
- the nonce claim is a create whose id is the nonce hash — a primary-key
  conflict *is* the replay defence;
- cleanup deletes documents whose `expires_at` has passed, which is stricter than
  the SQL function's `p_days` and cannot touch a live window.

`createPostgresFixedWindowStore` and `createPostgresNonceStore` are reused as-is
(aliased as `createAppwriteFixedWindowStore`/`createAppwriteNonceStore`), because
they only ever called `rpc`. Forking a security primitive to rename it is exactly
the kind of change that introduces the bug the fork was meant to avoid.

### 3.4 A filtered update is N requests

Postgres updates every matching row in one statement. Appwrite has no such call,
so `update`/`delete` first resolve the target documents and then write each one.
Two bounds apply, and both **fail loudly** rather than writing half a batch:

- `maxWriteTargets` (default 1,000) for a filtered write whose result set is
  larger than the adapter will touch in one request;
- the query has to be scoped (§3.1), so "delete everything" is not expressible.

Cost: an account reset on Appwrite is a handful of requests instead of one. For
this API (one roadmap per save, one task per progress update, ~120 rows in the
worst case) that is acceptable; it would not be for a bulk analytics write, and
nothing here does bulk analytics writes.

## 4. Provisioning

The schema is declared once, in `appwriteSchema.ts`, and read by both the adapter
and the provisioning script — so a collection cannot be written without existing,
and an index cannot be missing for an upsert the code performs. A test enforces
that pairing against `supabaseStore.ts` itself: **every table the store touches
must have a collection, and every `onConflict` target must have a matching unique
index** (`tests/unit/appwrite-adapter.test.ts`).

```bash
npm run appwrite:provision                # prints the commands
npm run appwrite:provision -- --json      # machine-readable, for a pipeline
npm run appwrite:provision -- --run       # executes them (needs the appwrite CLI)
```

Eight collections in one database (`graphmentor`):

| Collection | Scope | Unique index used by an upsert |
| --- | --- | --- |
| `profiles` | keyed by `id` | `id` (insert-only in practice; the primary key *is* the account) |
| `saved_roadmaps` | `user_id` | `id` |
| `roadmap_tasks` | `user_id` | `roadmap_id, skill_id, order_index, status` |
| `user_skill_progress` | `user_id` | `user_id, skill_id` |
| `bookmarks` | `user_id` | `user_id, target_id` |
| `feedback` | `user_id` (nullable — guests may submit) | `id` |
| `rate_limit_hits` | server-only | none: rows are per-request counters with an `expires_at` |
| `used_nonces` | server-only | document id is the nonce hash |

Every attribute is created explicitly (string sizes included) because Appwrite
validates them and a missing `--size` is a 400 at runtime, not at deploy time.

## 5. Configuration

```bash
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your-project-id
APPWRITE_API_KEY=standard_...        # server key. Never in the browser bundle.
APPWRITE_DATABASE_ID=graphmentor     # optional; this is the default
```

`selectBackend(env)` decides:

1. all three Appwrite values present → **appwrite**;
2. some but not all → **no backend at all**, and the reason names the missing
   variables. This is deliberate: falling through to Supabase would write a
   deployment's data to a database the operator did not configure, which is how a
   data-residency promise is broken;
3. `SUPABASE_URL` + `SUPABASE_ANON_KEY` → **supabase**;
4. nothing → **read-only**: the API serves the bundled sample graph, account
   routes answer honestly that storage is not configured, and `health-check` says
   so.

`health-check` reports which backend is live (`data.storage.backend`) and the
sentence a user reads follows it — "your Supabase project under Row Level
Security" would be a false statement on an Appwrite deployment, so the platform
records the choice in the runtime and the message is derived from it.

## 6. What is verified, and what is not

Verified on every `npm test`:

- **41 unit tests** over the adapter (`tests/unit/appwrite-adapter.test.ts`):
  query-string construction and round-tripping, uuid ids, row encoding/decoding
  for the types Appwrite lacks, every scoping refusal, upsert idempotency and the
  lost-race path, cross-account patch refusal, error-code translation, read
  retries and the deliberate absence of write retries, both nonce paths claiming
  once, rate-limit capping at `limit + 1`, the session verifier, the fetch
  transport (headers, timeout, non-JSON body, session instead of key), backend
  selection, and the schema/provisioning invariants.
- **8 integration tests** (`tests/integration/appwrite-backend.test.ts`): a
  **21-request scenario replayed on both backends** with the responses compared
  one request at a time — statuses, ownership refusals, error codes, field names
  and the progress numbers the client renders. Plus storage-level isolation, a
  deletion that provably spares the other account, guest feedback staying
  anonymous, rate-limit counters, and the health sentence.
- The **self-audit** (`npm run audit:self`, **25 checks**, all green) covers the
  other direction too: `storage.adapter-covers-the-schema` fails if the store
  touches a table no collection declares or upserts on a conflict target with no
  unique index, and `storage.no-unscoped-query-without-rls` proves that an
  unscoped select/update/delete and an ownerless insert are refused *before a
  request is sent*, while a scoped read still returns its row.

Not verified — and this is the honest part:

- **No live Appwrite project has been exercised.** CI has no Appwrite instance,
  so the adapter's tests run against an in-memory emulation of the document API
  (`tests/helpers/fakeAppwrite.ts`) built from the published request/response
  shapes. The emulation implements the subset the adapter uses — `queries[]`
  filtering, create/read/update/delete, unique-index conflicts, required
  attributes, `x-total-count` — and it is a *model* of Appwrite, not Appwrite.
  Before trusting a deployment, run the scenario against a real project: the
  adapter takes an injectable transport, so this is a one-line change in a test,
  not a code change.
- **Appwrite's own platform behaviour** (rate limits, quotas, backups,
  multi-region replicas, the Teams/Storage APIs) is out of scope here — this
  adapter uses the document API and the account API, nothing else.
- **Realtime subscriptions** are not used. The app polls `get-roadmaps` on focus;
  that is a deliberate choice (one code path for both backends), not an omission
  of an Appwrite feature.
- **RLS is still the stronger guarantee where it exists.** Appwrite's answer here
  is "the key is server-side and the adapter enforces scope"; Postgres additionally
  enforces it in the database, which survives an application bug. If you need
  that property, run Supabase. Both are supported because they are different
  trades, not because they are equivalent.
