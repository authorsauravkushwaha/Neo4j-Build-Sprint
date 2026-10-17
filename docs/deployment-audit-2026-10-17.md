# Deployment audit — 2026-10-17

This is the record of one pass over the deployment of this repository: what was
audited, what was changed, what was executed, and what remains outside the
reach of the code. Every statement below was produced by a command that ran;
nothing is asserted from configuration alone.

The two questions behind the audit were:

- **Issue 3** — can this project prove that it really talks to Neo4j and that
  real Cypher is executed?
- **Issue 4** — is the published GitHub Pages site actually connected to a
  correctly deployed backend, through the whole path?

## 1. What was audited

| Area | Finding |
| --- | --- |
| Backend implementations | Two exist: the Node service (`server/website.ts` → `server/graphApi.ts`) and the Supabase Edge Functions (`supabase/functions/*`). They serve the same contract at different paths: `/api/*` and `/functions/v1/*`. Both were left in place; the frontend was pointed at one of them. |
| Frontend API base | Two independent sources could set it (the `VITE_API_BASE_URL` variable and the committed `config/production-backend.json`), and they could disagree silently. |
| Neo4j reader | `server/neo4jDriverReader.ts` already used the official `neo4j-driver` with read-only sessions, bounded timeouts and parameterized Cypher. The missing piece was evidence, not code. |
| Verifier | `scripts/verify-neo4j.mjs` existed, but it could not distinguish "the database is unreachable" from "the database answered wrongly", and it mixed its JSON report with its narration. |
| Credentials | No Neo4j or Supabase credential exists in the repository, in the environment, or in any hosting dashboard reachable from the audit environment. |
| Published site | GitHub Pages is live at `https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint/`, built by the `Build and deploy` workflow from `main`. The API base it was built with could not be read from the sandbox (the published host is outside the reachable network). |
| Backend deployment | No Render service, no Supabase project, and no credential for either could be found from the repository, the GitHub API, or the environment. |

## 2. Defects found and fixed

These are the real problems the audit uncovered, in the order they were found.

### 2.1 The Content-Security-Policy blocked the whole API (found by a real browser)

The build put the API base into the CSP `connect-src` **with its path**:
`connect-src … https://api.example.com/functions/v1`. A CSP source that
carries a path matches only that exact path, so every real request —
`…/functions/v1/health-check`, `…/functions/v1/get-careers` — was refused by
the browser. The build stayed green, the API was healthy, and the site would
have shown "BACKEND UNAVAILABLE" forever.

The fix is to publish the API base's **origin** in the CSP
(`vite.config.ts`), and the regression is now covered by
`scripts/verify-frontend-backend.mjs`, which opens the built site in Chromium
and fails when the browser cannot reach the API.

### 2.2 The first page always rendered the bundled sample dataset (found by a real browser)

`initSession()` probes the backend in the background, so during the first
moments `api()` is the **demo** client. Every data page called it immediately
and therefore answered with the bundled dataset — while a live backend was
about to be confirmed. The banner was the only thing telling the truth, and
the data on screen was not the live data.

`useClientQuery` now waits for the session probe when a backend is configured,
and re-runs the query when the client itself changes (a backend that drops out
mid-session, for example). Without a configured backend there is nothing to
wait for, so demo builds behave exactly as before. The behaviour is pinned by
`tests/unit/client-query-session.test.tsx`.

### 2.3 The backend URL had two sources that could disagree

See §3.1.

### 2.4 The verifier could not tell "unreachable" from "wrong"

A backend with no Neo4j attached returned `503` on `/api/graph/stats`, and the
verifier counted that as a **FAIL** — the same verdict it gives to a backend
that answers with broken data. The distinction matters: a missing database is
an infrastructure gap, a wrong answer is a defect. `503` is now **BLOCKED**.

### 2.5 The verifier printed credentials and mixed its output

`--json` wrote the report and the narration to the same stream, so
`… --json | jq` failed; and the invalid-URL error echoed the target URL
verbatim, which could contain a password. The report now goes to stdout, the
narration to stderr, and every printed URL is redacted.

## 3. What changed, file by file

### 3.1 `scripts/resolve-api-base.ts` (new) and `config/production-backend.json` (new)

One resolver decides the backend URL, and the build and the workflow both call
it, so they cannot disagree:

- the `VITE_API_BASE_URL` environment variable wins;
- `config/production-backend.json` is the committed fallback that makes a build
  reproducible from the repository;
- when both are set they must be equal;
- production requires an absolute `https://` URL, no credentials, no
  `localhost`, and the `/functions/v1` function contract.

`npm run verify:api-config [-- --check|--json]` exposes it.

### 3.2 `scripts/verify-neo4j.mjs`

Rewritten around three verdicts — PASS (0), FAIL (1), BLOCKED (2) — with:

- contract detection (Node `/api/*` versus Supabase `/functions/v1/*`), never
  mixed;
- `503` on the Neo4j health or statistics endpoints ⇒ BLOCKED;
- the allow-listed multi-hop query must return **rows**, with `servedBy`,
  row count and execution time;
- proof that an unknown query template and an injected parameter are refused;
- credential redaction, and a JSON report on stdout with narration on stderr.

### 3.3 `server/graphApi.ts`

- `neo4jUnavailableReason()`: a Postgres deployment now says "the graph store
  is PostgreSQL, Neo4j is not configured" instead of the misleading "Neo4j
  unavailable";
- every response carries the reader that actually served it (`servedBy`), and
  the ledger records the provenance of each request;
- `/api/query` validates its parameters and answers `400 invalid_params` for a
  malformed id, and `400 unknown_query` for an unknown template;
- `/api/health/neo4j` reports the database identity.

### 3.4 `server/neo4jDriverReader.ts`

`identity()` reads the database identity with `SHOW DATABASES` (with a
fallback), so the verification can state *which* database answered.

### 3.5 `scripts/seed-neo4j.ts`

Rewritten to seed over **Bolt** (official driver) or the **HTTPS Query API**,
whichever is configured, with:

- `--check`: read-only inspection of the target database against
  `neo4j/MANIFEST.json`;
- `--dry-run`: no writes;
- MERGE-based, idempotent upserts, never a reset;
- it refuses to run when no credential is configured — it never invents one.

### 3.6 `.github/workflows/verify-neo4j.yml` (new)

Runs the verifier inside GitHub Actions with the repository's server-side
secrets, on every pull request, on a schedule and on demand. It publishes the
verdict as a job summary and as a pull-request comment, prints **which**
secrets are present (never their values), and fails the run only on a real
FAIL — a missing credential is reported as BLOCKED.

### 3.7 `.github/workflows/deploy.yml` and `.github/workflows/ci.yml`

The Pages build resolves the API base through the shared resolver, and the CI
workflow runs `npm run verify:api-config -- --check`.

### 3.8 `vite.config.ts`

- the resolved API base is written back into the build environment, so the
  client configuration, the CSP and the workflow all read the same string;
- the CSP `connect-src` uses the API base's **origin** (see §2.1);
- `GM_GRAPH_API_TARGET` forwards `/functions/v1` to a local backend in the dev
  and preview servers, so the built site can be previewed against a real
  backend.

### 3.9 `src/features/shared/hooks.ts`

`useClientQuery` waits for the session probe when a backend is configured and
re-runs when the client changes (see §2.2).

### 3.10 `scripts/verify-frontend-backend.mjs` (new)

Opens the built site in a real browser and checks the whole chain: no
JavaScript errors, the browser really issued the API requests, they succeeded,
they carried a source, and the banner the user sees matches that source.

### 3.11 Tests

| File | What it pins |
| --- | --- |
| `tests/unit/verify-neo4j-script.test.ts` | the verifier's verdicts, both contracts, the redaction, the JSON contract |
| `tests/unit/backend-config.test.ts` | the resolver's rules and the committed configuration |
| `tests/unit/client-query-session.test.tsx` | the session wait and the client change |
| `tests/integration/graph-api.test.ts` | parameter validation, unknown templates, ledger provenance |
| `tests/unit/architecture-consistency.test.ts` | that the workflows delegate to the shared resolver |

## 4. What was executed, and what it returned

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc -b --pretty false` | exit 0 |
| Unit + integration suite | `npm test` | see §6 |
| Production build | `npm run build` | exit 0 |
| Secret scan | `npm run lint:secrets` | clean (416 files, canary 18/18) |
| Seed validation | `npm run validate:seed` | 58/58 |
| Cypher emission | `npm run emit:cypher -- --check` | up to date |
| API-base resolution | `npm run verify:api-config` | "(none — demo build)" — no backend URL is configured in the repository |
| Live verifier, local backend | `node scripts/verify-neo4j.mjs http://127.0.0.1:3000` | **BLOCKED** (exit 2) — correct: that deployment has no Neo4j |
| Live verifier, workflow | `Verify Neo4j (live)` on PR #11 | **BLOCKED** — the repository has no Neo4j or Supabase secret configured (names reported, values never) |
| Browser path | `node scripts/verify-frontend-backend.mjs` | **PASS** — see §5 |

## 5. The path that was proven end to end

With a real backend running locally (the PostgreSQL graph store, 444 nodes and
1585 relationships) and the production build served over HTTP, a real Chromium
browser did this:

```
200 http://127.0.0.1:3000/functions/v1/health-check      (source: postgres-live)
200 http://127.0.0.1:3000/functions/v1/analyze-skill-gaps (source: postgres-live)
200 http://127.0.0.1:3000/functions/v1/get-careers         (source: postgres-live)
```

and the page showed the banner **"LIVE POSTGRESQL · The most recent successful
graph response confirms PostgreSQL as its data source."**, with the 17 careers
rendered from the backend. The screenshot is in
`docs/evidence/frontend-backend-cross-origin.png`.

This is the whole path — browser → CORS → backend → database → provenance in
the response → the label the user sees — exercised for real. The one thing it
does **not** prove is that the database behind it was Neo4j: on this machine
there is no Neo4j to point at, so the honest label is LIVE POSTGRESQL. The same
path, with a Neo4j instance behind it, is what the `Verify Neo4j (live)`
workflow proves and what `scripts/verify-neo4j.mjs` reports as PASS.

## 6. Automated check results

Recorded from the final run of each command in this environment.

| Command | Exit status |
| --- | --- |
| `npx tsc -b --pretty false` | 0 |
| `npm test` | 0 — 65 files, 840 tests, all passing |
| `npm run build` | 0 |
| `npm run lint:secrets` | 0 |
| `npm run validate:seed` | 0 (58/58) |
| `npm run emit:cypher -- --check` | 0 (up to date) |
| `npm run verify:api-config` | 0 |
| `node scripts/verify-neo4j.mjs http://127.0.0.1:3000` | 2 (BLOCKED — no Neo4j) |
| `node scripts/verify-frontend-backend.mjs …` | 0 (PASS) |

## 7. What still needs a human

None of these can be done from the code, and none of them may be faked.

1. **Add the Neo4j credentials as repository secrets** — `NEO4J_URI`,
   `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`. Then the
   `Verify Neo4j (live)` workflow reports PASS (or a real FAIL) on the pull
   request, with the query, the row count and the execution time.
2. **Deploy the backend.** Either create the Render service from
   `render.yaml` and set the same `NEO4J_*` variables plus
   `ALLOWED_ORIGINS=https://authorsauravkushwaha.github.io`, or set
   `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` and run
   `.github/workflows/deploy-backend.yml`. One path, not both.
3. **Point the frontend at it.** Put the real URL in
   `config/production-backend.json` (or in the `VITE_API_BASE_URL` variable —
   the two must agree) and open a pull request. The URL that ends up in the
   published artifact is then visible in the diff.
4. **Re-run the Pages build** on `main`, then re-run the verifier and the
   browser check against the published site.
5. **Seed the database** with `npm run seed:neo4j -- --check` first, then
   `npm run seed:neo4j` (idempotent; it never resets anything).

Until step 1 and step 2 are done, the honest verdict for Issue 3 and Issue 4 is
**BLOCKED**, and the tooling that will produce the evidence is in place and
tested.
