# The knowledge-graph database

This project runs in **live mode** — no "Sample data in use" banner — out of two database choices. Both
serve the *same* endpoints, the *same* response envelopes, and the *same* recommendation logic; they differ
only in who hosts the graph and what accounts you need.

| | Path A — the repo-owned graph store | Path B — Supabase + Neo4j Aura |
| --- | --- | --- |
| Database | PostgreSQL the deployment itself owns — embedded on disk by [PGlite](https://pglite.dev) by default, or any PostgreSQL you point at it | Neo4j AuraDB (+ Supabase for accounts and functions) |
| Running the API | this repo's Node server (`server/graphApi.ts`), mounted next to the website | Supabase Edge Functions (`supabase/functions/`) |
| Third-party accounts needed | **none** | Neo4j Aura + Supabase (both free tier) |
| Works on | any Node host with one persistent disk (Render, Railway, Fly, a classroom server, a container, your laptop), or `npm start` locally | the GitHub Pages build (static) plus Supabase |
| What health-check reports | `source: "postgres-live"` | `source: "neo4j-live"` |
| Exact same business logic | yes — `supabase/functions/_shared/` behind an HTTP seam, tested once for both | yes |

Both readers implement the same `GraphReader` contract (`supabase/functions/_shared/core/graphReader.ts`) —
the third implementation of that contract is the in-browser demo reader over the bundled sample, labelled
`local-sample`. The provenance label is computed in exactly one place (`sourceFor` in
`supabase/functions/_shared/handlers/shared.ts`), so a response can never claim one backend while actually
reading another.

---

## Path A — the repo-owned PostgreSQL store

### What it is, precisely

Files: [server/graphStore.ts](../server/graphStore.ts) (the tables), [server/graphReader.ts](../server/graphReader.ts)
(the reader), [server/graphApi.ts](../server/graphApi.ts) (the HTTP surface), [scripts/seed-graph-db.ts](../scripts/seed-graph-db.ts) (the operator tool).

- The curriculum lives as real rows in schema `graph`:
  `graph.documents(bucket, position, id, doc jsonb)` — one row per entity — plus `graph.meta` holding the
  dataset version, a change **revision** counter, seed time and provenance.
- Every API call is answered from **SELECTs against these tables**. The reader re-reads the database whenever
  the revision changes (and its live `totals()` SQL counts feed the health check), so delete or edit a row and
  the answers change — the database is the source of truth, the bundle only seeds it.
- An operator edit followed by `select graph.bump()` changes what the API serves **without a redeploy**
  (proven in `tests/integration/graph-api.test.ts`, "an operator edit becomes visible without a redeploy").

### Zero-configuration start

```bash
npm ci --include=dev
npm run build          # or npm run dev for the Vite dev server
npm start              # serves the site + /api (accounts) + /functions/v1 (graph API)
```

On first boot the graph store is created at `.localdata/graph-postgres/` (single-owner directory, file-locked
like the account database) and seeded automatically: `444 nodes, 1585 relationships` from
`src/data/seed/knowledgeGraph.ts`. Build the frontend with the same-origin API base so it opens in live mode:

```bash
VITE_BASE_PATH=/ VITE_API_BASE_URL=/functions/v1 npm run build
```

(The `render.yaml` Blueprint does exactly this: one Node service with one persistent disk, both databases on
it, `VITE_API_BASE_URL=/functions/v1`.)

### Seeding and inspecting by hand

```bash
npm run seed:graphdb              # idempotent: seeds when empty or the dataset version changed
npm run seed:graphdb -- --force   # rebuild the tables from the bundle (discards operator edits)
npm run seed:graphdb -- --wipe    # drop the graph.tables
```

Seeding is idempotent by dataset version: rerunning it against unchanged data is a no-op and preserves
operator edits; a dataset whose *version moved* (older deployment, newer bundle) is replaced in one
transaction, so the API can never observe a half-written graph.

### Pointing it at a real PostgreSQL cluster

```bash
export GRAPH_DATABASE_URL=postgres://graph:secret@your-host:5432/graphmentor
npm run seed:graphdb
npm start
```

- The role needs to own nothing but the `graph` schema (created by the app when the role may; otherwise
  create it first: `CREATE SCHEMA graph AUTHORIZATION graph; CREATE EXTENSION IF NOT EXISTS pgcrypto;`
  is *not* required — plain `jsonb` only).
- Everything else — transactions, reader, health counts, the whole test suite — runs unchanged on the same
  code; the embedded in-memory engine used by the tests is driven through the identical interface.

### Editing the graph like a database (the point of having one)

```sql
-- fix a summary; take effect immediately for every visitor
update graph.documents
   set doc = jsonb_set(doc, '{summary}', '"The corrected summary."'::jsonb)
 where bucket = 'careers' and id = 'career:robotics-engineer';
select graph.bump();
```

The reader notices the revision bump within ~1 s and rebuilds from the tables. Editing without `graph.bump()`
still works — the change is picked up at the next seed or restart — but bumping is the deliberate,
observable route. A store that fails the dataset validation is *not* served: the API reports the graph as
unreachable with a re-seed hint rather than answer from a broken graph.

### Why PostgreSQL can serve a *graph* here (honest scope)

The app asks the graph 20 questions (`GraphReader` methods): catalogues, career/skill details, bounded
neighbourhoods and closures, prerequisite routes, project/resource lookup. All of them are answered by
walking the seeded `edges` rows, an in-core index rebuilt whenever the database revision changes — the same
exhaustively tested engine the browser demo and the test-suite use, hydrated from database rows instead of a
temp file. If you grow past what this shape fits well — arbitrary Cypher queries, graph algorithms at scale,
millions of nodes — that is exactly when Path B (Neo4j) exists.

---

## Path B — Supabase Edge Functions + Neo4j Aura

The originally documented route: Neo4j holds the graph, Supabase Edge Functions run the same shared handlers
against it over the HTTPS Query API. Steps are in the README's [Going live](../README.md#going-live-neo4j--supabase)
section; automation lives in [`.github/workflows/deploy-backend.yml`](../.github/workflows/deploy-backend.yml), which:

1. links your Supabase project (`SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` secrets),
2. generates `supabase/config.toml` marking every function `verify_jwt = false` — the frontend reaches the
   functions *anonymously*, each handler checks requests itself (the gateway's JWT check would otherwise
   reject every guest with a 401), pushes the migrations and sets secrets (`NEO4J_QUERY_URL`,
   `NEO4J_USERNAME`, `NEO4J_PASSWORD` through GitHub secrets, never committed),
3. deploys all 18 functions and optionally reseeds Neo4j,
4. verifies the deployment end to end: an anonymous GET to `health-check` must answer `reachable: true` and
   `source: "neo4j-live"` — the workflow fails loudly if it does not.

When it finishes it prints the exact `VITE_*` values for the frontend build (same step summary).

---

## Choosing, and what the banner then says

The decision is `VITE_API_BASE_URL` at frontend build time: empty → demo mode (bundled sample, labelled as
such); `/functions/v1` or your service URL → live mode. After health-check passes, the banner reads
**"Live data: reading the knowledge graph from this deployment's own PostgreSQL database."** (Path A) or
**"Live data: reading the Neo4j knowledge graph through the deployed backend."** (Path B) — the honest reason
is *also* shown on the About page and the graph explorer.
