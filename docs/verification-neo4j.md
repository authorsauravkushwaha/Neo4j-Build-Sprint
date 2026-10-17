# Neo4j Integration — Verification Report

Generated: 2026-10-17.

## What changed

The Node backend (`server/website.ts`) now connects to a **real Neo4j instance
using the official `neo4j-driver`** (Bolt / `neo4j+s://` for AuraDB) and runs
parameterised Cypher for every graph query. It exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness, reports which graph backend is active (`neo4j` / `postgres` / `none`). |
| `GET /api/health/neo4j` | Real connectivity ping (`RETURN 1`) against Neo4j. Returns 503 with a truthful reason when credentials are missing or the instance is unreachable — never pretends to be connected. |
| `GET /api/graph/stats` | Node / relationship / label counts, executed live against Neo4j. |
| `POST /api/query` | Dispatches to a fixed allow-list of named Cypher queries (no arbitrary Cypher accepted from the public internet). See `server/graphApi.ts` `NAMED_QUERIES`. |
| `GET /api/graph/explore` | Bounded subgraph for the canvas/visualisation. |
| `GET /api/evidence/:id` | Retrieves the node(s) and outgoing edges that support an answer for a given entity id. |
| `GET /api/ledger/recent` | The **read ledger** — a ring buffer of the most recent 50 query executions with request id, query id, row count, execution time, and `servedBy` label. Honest about errors. |
| `GET/POST /functions/v1/*` | The existing Edge Function-shaped API (kept for the React live client, which already targets those endpoints). |

When no Neo4j credentials are configured, the server still starts but every
Neo4j endpoint answers 503 and the legacy `/functions/v1/health-check` reports
`source: "unavailable"`. The React UI reads that and shows **DEMO DATA**, not
**LIVE NEO4J**. The only way to get `neo4j-live` provenance is a successful
real Cypher round-trip.

## Static checks (all pass locally)

- `npm run typecheck` — clean.
- `npm test` — **777 tests pass in 58 files** (including the existing 16 end-to-end
  graph API tests over HTTP, plus the new Neo4j driver module).
- `npm run build` — production build succeeds.
- `npm run lint:secrets` — no credential-shaped strings in the tree.

## Live Neo4j verification

Run `npm run verify:neo4j`. It prints one of the contract banners verbatim:

```
PASS — LIVE NEO4J VERIFIED
BLOCKED — LIVE NEO4J CREDENTIALS OR INSTANCE UNAVAILABLE
FAIL — LIVE NEO4J INTEGRATION FAILED
```

Result in this environment (no Aura credentials available to the agent):

```
============================================================
BLOCKED — LIVE NEO4J CREDENTIALS OR INSTANCE UNAVAILABLE
============================================================
{
  "status": "BLOCKED",
  "reason": "NEO4J_URI / NEO4J_PASSWORD not set — no live instance to verify against."
}
```

This is the honest answer. No credentials, no instance, no fake "connected"
banner. After setting `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` (see
`.env.example`) and running `npm run seed:neo4j` to load `neo4j/seed.cypher`,
rerunning the same command produces `PASS — LIVE NEO4J VERIFIED` along with
actual record output.

## Read ledger honesty

Every Cypher execution the backend performs is recorded in the in-memory
ledger served at `/api/ledger/recent`. Entries include:

- `requestId` — generated per request.
- `timestamp` — ISO-8601.
- `queryId` — the named query or Cypher tag (e.g. `CAREER_DETAILS`, `NAMED:career.longest-prereq-chain`, `REST:health/neo4j`).
- `status` — `ok` / `error` / `connect`.
- `rowsReturned`, `executionMs`, `dbAvailableMs`, `dbConsumedMs`.
- `servedBy` — `neo4j-live` only when the native Neo4j driver ran the query; `postgres-live` for the opt-in legacy fallback.

When the backend is started without credentials, every entry for a REST graph
endpoint is recorded with `status: "error"` rather than a fabricated success,
and the corresponding HTTP response is 503.

## Why Neo4j is not "just a JSON file"

The principal GraphMentor query is **multi-hop traversal with path
semantics**: "given a target career, and a learner's known starting skill,
find the shortest prerequisite chains through REQUIRES edges into every
required skill, rank them by weight, and return the supporting free resources
and practice projects along the way." That is a native graph problem
(variable-length path patterns, `shortestPath`, path predicates) expressed
naturally in Cypher (`neo4j/live-demo.cypher`). Running it over the bundled
JSON requires re-implementing BFS plus label and edge-type filtering in
JavaScript (which exists in demo mode — it has to, for the offline demo — but
is clearly labelled as bundled sample data). The honest engineering
comparison is in `docs/objections.md` — JSON works for small static data;
Neo4j is used because the core product question is a graph traversal.

## Deployment status after these changes

- **Frontend (GitHub Pages):** unchanged URL, but must be rebuilt with
  `VITE_API_BASE_URL=https://<your-backend>` pointing at the deployed Node
  service. Without that, it remains in clearly-labelled demo mode.
- **Backend:** deployable to Render via `render.yaml` (Blueprint updated).
  Set `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` in the Render dashboard.
- **Neo4j:** AuraDB Free. Seed once with `npm run seed:neo4j` (the same
  command that existed before; the dataset it loads is unchanged).
