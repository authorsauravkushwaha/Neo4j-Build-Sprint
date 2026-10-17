# GraphMentor AI architecture and deployment truth

**Status as of 2026-10-17:** the code supports live Neo4j and an explicitly configured PostgreSQL graph-reader alternative. This repository checkout does not prove that any external Render service, Neo4j instance, GitHub Pages build variable, or public-site request is configured. Treat production connectivity as **unverified until the HTTP verification script returns PASS against the deployed backend**.

## Production live architecture (deployment not verified)

The intended production live path is GitHub Pages → Node API → Neo4j, but no live external service or public-site request is verified from this checkout. When that path is configured and verified, use the evidence gates below before calling it the production architecture. The supported PostgreSQL and bundled demo paths are alternatives, not evidence of Neo4j production connectivity.

## Request paths

```mermaid
flowchart LR
  Browser[GitHub Pages frontend\nVite build-time API base] -->|/functions/v1/*| Backend[Node service\nserver/website.ts]
  Backend -->|official neo4j-driver\nBolt + parameterised Cypher| Neo4j[(Configured Neo4j)]
  Backend -->|only if explicitly configured\nGRAPH_DATABASE_URL / GM_GRAPH_DATABASE_DIR| PG[(PostgreSQL / PGlite alternative)]
  Browser -->|when no backend, network failure, or forced demo| Demo[Bundled sample graph\nDEMO DATA]
  Backend -.->|no reachable graph| Unavailable[503 / unreachable\nno live-result fallback]
```

The React client normally calls the shared `/functions/v1/*` API contract. On the Node service, `server/website.ts` routes those paths to `server/graphApi.ts`, which passes the configured reader into the shared handlers. The Neo4j reader in `server/neo4jDriverReader.ts` uses the official `neo4j-driver`, read-only sessions, bounded timeouts, parameterized Cypher, and closes each query session. The long-lived driver is closed on shutdown. API response `meta.source` is selected from the reader actually used; the dedicated `/api/query` allow-list reports `servedBy: neo4j-live` only after its driver query succeeds.

### Runtime source states

- **LIVE NEO4J:** only after a successful non-health API response includes valid `meta.source: "neo4j-live"` (or a successful named-query response includes `servedBy: "neo4j-live"`). A configured URL or health ping alone does not set this label.
- **DEMO DATA:** the frontend is using its bundled `src/data/seed/knowledgeGraph.ts` sample. Demo mode remains useful offline and is never mixed invisibly with a live response.
- **BACKEND UNAVAILABLE:** a configured backend could not be reached; bundled demo data is used, with both facts displayed.
- **NEO4J UNAVAILABLE:** the API responds but says its graph reader is unreachable. Live endpoints return errors; they do not silently substitute bundled JSON.
- **LIVE POSTGRESQL:** supported as an alternative when Neo4j is not configured and a PostgreSQL/PGlite graph store is explicitly configured. It is never called Neo4j.

## Backend deployment

`render.yaml` describes one Render Node web service. It runs `npm ci --include=dev && npm run build`, then `npm start`; the server binds `0.0.0.0:$PORT`, serves `/api/health`, `/api/health/neo4j`, `/api/graph/stats`, `/api/query` and the `/functions/v1/*` routes, and supports CORS preflight using `ALLOWED_ORIGINS`.

Configure server-side Render environment variables:

- `NEO4J_URI` — Bolt URI such as `neo4j+s://...databases.neo4j.io`
- `NEO4J_USERNAME`
- `NEO4J_PASSWORD` — secret; never expose to Vite or commit it
- `NEO4J_DATABASE` — normally `neo4j`
- `ALLOWED_ORIGINS` — include `https://authorsauravkushwaha.github.io` (origin only, no repository path)

The Neo4j credentials must be stored in the hosting dashboard, not in frontend variables. Render service creation and credentials are external actions and have not been verified from this repository. The backend can start without Neo4j; liveness remains distinct from graph readiness and graph endpoints report unavailable.

## GitHub Pages frontend configuration

The `.github/workflows/deploy.yml` computes and preserves the project Pages base path (`/Neo4j-Build-Sprint/`) and embeds `VITE_API_BASE_URL` at build time. For the Node service, the repository Actions **variable** must be set to the actual deployed service API base, for example `https://<actual-render-host>/functions/v1` (replace the example only with the real service URL). This variable is public configuration, not a secret. Never use a `VITE_*` variable for Neo4j credentials. Setting the variable does not change an existing Pages artifact: run a new Pages build after setting it. If the variable is empty, the Pages workflow deliberately builds the demo-capable frontend.

## Seed and data safety

`neo4j/seed.cypher` and `scripts/seed-neo4j.ts` are repeatable upserts: nodes are `MERGE`d by schema `id`, relationships by endpoints/type, and default generated writes set properties only on create. Reruns do not duplicate graph records or overwrite existing properties. `npm run seed:neo4j -- --update-existing` is an explicit operator action that updates seed-owned properties on matched records; review/authorize the target before using it. There is no database reset/delete in the Neo4j seed. The script posts generated, parameterized row payloads and verifies node counts. Separately, `npm run seed:graphdb -- --wipe` is destructive to the alternative PostgreSQL store and requires an explicit command; it is not part of normal deployment.

## Verification levels

| Capability | Implemented in code | Tested in this checkout | Verified in production |
| --- | --- | --- | --- |
| Official Neo4j driver, parameterized named queries, driver/session lifecycle | Yes | Unit/integration tests can exercise contracts | **Not established here** |
| Neo4j seed uses MERGE, no reset | Yes | Generated seed validation | Not established here |
| Render backend blueprint and GitHub Pages API-base build input | Yes | Workflow/config checks | **Not established here** |
| Actual Neo4j query through deployed API | Verification script supports it | No external credentials/service available in this environment | **BLOCKED until deployed endpoint returns PASS** |
| Public Pages-to-backend request and live UI badge | Implemented based on response metadata | Frontend/API tests | **Not established here** |

## Useful commands

```bash
npm run typecheck
npm test
npm run build
npm run lint:secrets
npm run verify:neo4j                         # local backend defaults to http://127.0.0.1:3000
node scripts/verify-neo4j.mjs https://ACTUAL_BACKEND
```

The verifier expects a backend root where `/api/health` exists. For the Render Node backend, pass its origin (no `/functions/v1` suffix): `node scripts/verify-neo4j.mjs https://ACTUAL_BACKEND`. It requires health, Neo4j health, graph stats, and a non-empty `career.longest-prereq-chain` query response. Exit codes: `0` PASS, `1` FAIL, `2` BLOCKED.

See [Neo4j verification](verification-neo4j.md), [deployment](deployment.md), [graph database options](graph-database.md), and [judge demo](demo-script-neo4j.md). These pages defer to this document for architecture facts.
