# Neo4j verification

Architecture and deployment facts are maintained in [architecture.md](architecture.md). This guide records how to verify the **actual backend**, not just whether this source tree compiles.

## What "verified" means here

A verification passes only when a **real Cypher query executed against a Neo4j instance** and the rows came back. Not a health ping, not a successful build, not a configured URL, not a mock. The script encodes that distinction in three verdicts:

| Verdict | Exit code | Meaning |
| --- | --- | --- |
| **PASS** | `0` | a real multi-hop Cypher query ran against Neo4j and returned rows; the response carried `servedBy: "neo4j-live"` and the official driver evidence |
| **FAIL** | `1` | the backend answered, but broke the contract (wrong payload, refused a valid query, accepted injected Cypher, or the query returned nothing) |
| **BLOCKED** | `2` | the check could not be completed: the backend is unreachable, or its Neo4j connection is not configured or not usable |

`BLOCKED` is not a soft `PASS`. It is the honest answer when there is no database to ask, and it is what the verifier reports for a deployment that has no Neo4j attached.

## Verify a local backend

Start the Node service after configuring `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` in your untracked local environment:

```bash
npm run build
npm start
# in another terminal
npm run verify:neo4j
```

The default target is `http://127.0.0.1:3000` (or `PORT` if set). To verify a deployed Render backend, pass its actual origin:

```bash
node scripts/verify-neo4j.mjs https://ACTUAL-SERVICE.onrender.com
```

Do not add `/functions/v1` to this URL: verification calls the backend's `/api/*` endpoints. The script calls liveness, Neo4j health, live graph statistics, and the allow-listed multi-hop career query, then checks that the returned data identifies Neo4j as its source. It prints each HTTP status, query ID, record count, execution time, a small record sample, and the returned Cypher.

### The two backend contracts

The verifier speaks the contract of the backend it was given, and never mixes them:

| Target | Contract | Endpoints used |
| --- | --- | --- |
| Node service (Render, `npm start`) | `/api/*` | `/api/health`, `/api/health/neo4j`, `/api/graph/stats`, `/api/query` |
| Supabase Edge Functions | `/functions/v1/*` | `/functions/v1/health-check`, `/functions/v1/get-careers`, `/functions/v1/get-career-details` |

The kind is detected from the URL (a base that ends in `/functions/v1` is a Supabase deployment) and can be forced with `--kind=node` or `--kind=supabase`. A Node backend is addressed by its origin; a Supabase deployment by its `.../functions/v1` base.

### What the verifier checks

1. the backend is alive and its health response identifies which graph reader it uses;
2. `/api/health/neo4j` (or the Supabase equivalent) reports a **reachable Neo4j** — a `503` here is `BLOCKED`, not `FAIL`, because it means the deployment has no database, not that the database is broken;
3. live graph statistics are returned (node and relationship counts);
4. the allow-listed multi-hop query `career.longest-prereq-chain` returns **rows**, with the response carrying `servedBy: "neo4j-live"`, the driver evidence, a row count and an execution time;
5. an unknown query template is refused (`400 unknown_query`);
6. a parameter that tries to inject Cypher is refused (`400 invalid_params`).

Checks 5 and 6 are what keep the allow-list honest: a backend that answers *any* Cypher is not acceptable, however good its data looks.

### Machine-readable output

```bash
node scripts/verify-neo4j.mjs https://ACTUAL-SERVICE.onrender.com --json
```

The JSON report goes to **stdout**; the human narration goes to **stderr**, so `... --json | jq` always works. Credentials that appear in a URL are redacted before anything is printed.

## Verify from GitHub Actions

`.github/workflows/verify-neo4j.yml` runs exactly that script inside GitHub Actions with the repository's **server-side** secrets, and publishes the verdict as a pull-request comment and a job summary. It runs on every pull request, on a schedule, and on demand.

The workflow never prints a secret value — only whether each one is present:

| Secret | Used for |
| --- | --- |
| `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE` | the Bolt connection (official `neo4j-driver`) |
| `NEO4J_QUERY_URL` | the HTTPS Query API connection |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` | deploying and verifying the Supabase Edge Functions backend |

If a secret is missing, the workflow reports `BLOCKED` and names the missing variable. It never fabricates a connection.

## Demonstration query

The API allow-list includes `career.longest-prereq-chain`, using the verified seed schema (`Career`, `Skill`, `REQUIRES_SKILL`, `REQUIRES`, and properties `id`, `name`). The career ID exists in `neo4j/seed.cypher`. The exact parameterized Cypher returned by the API is:

```cypher
MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(s:Skill)
MATCH path = (s)-[:REQUIRES*1..6]->(base:Skill)
WHERE NOT (base)-[:REQUIRES]->(:Skill)
RETURN c.name AS career, s.name AS skill, length(path) AS depth,
       [n IN nodes(path) | n.name] AS chain
ORDER BY depth DESC LIMIT $limit
```

Example parameters are `$careerId = "career:software-engineer"` and `$limit = 10`. The script reads the career IDs from `neo4j/seed.parameters.json` rather than assuming one. In Neo4j Browser, set those parameters or substitute the literal career ID and limit. The script only reports PASS if actual non-empty rows with career, skill, depth, and chain shape return. Its sample rows, when available, are the evidence; expected counts should not be invented in advance.

## The frontend path

A verified backend is only half of the deployment. `scripts/verify-frontend-backend.mjs` opens the **built** site in a real browser and checks that the browser really reached the backend, that the responses carried a source, and that the banner the user sees matches that source:

```bash
CHROMIUM_PATH=/path/to/chromium node scripts/verify-frontend-backend.mjs https://THE-PUBLIC-SITE https://THE-BACKEND
```

It catches the failure modes that a green build hides — a Content-Security-Policy that blocks the API, a CORS origin that does not match, a page that renders the bundled sample dataset while claiming a live backend.

## Seed safety

`npm run seed:neo4j` loads generated parameterized data over **Bolt** (official `neo4j-driver`) or the **HTTPS Query API**, whichever is configured. Seed statements use `MERGE`; by default, properties are set only on create, so reruns do not duplicate records or overwrite existing properties. `npm run seed:neo4j -- --update-existing` explicitly opts into updating seed-owned properties on matched records; review and authorize the target before using it. Normal seeding never clears or resets the database. The script compares counts to the generated manifest.

Before seeding anything, look at what is already there:

```bash
npm run seed:neo4j -- --check
```

That is read-only: it reports the identity of the configured database, what it already holds, and whether that matches the generated manifest.

## Account data in Neo4j

User data (saved roadmaps and tasks, skill progress, bookmarks, feedback, profile preferences,
data export and deletion, rate-limit windows and nonce replay records) is stored in the same
database. The schema is `neo4j/user-schema.cypher`; the design is [docs/neo4j-schema.md](neo4j-schema.md).

Steps, in order. Each one is safe to repeat:

1. `npm run seed:neo4j -- --dry-run` lists the schema and seed statements and validates
   `NEO4J_QUERY_URL` and `NEO4J_DATABASE`. It writes nothing.
2. `npm run seed:neo4j -- --check` reads the database and compares curriculum counts with the manifest.
   This is the live connectivity check. It needs real credentials and the instance must be running.
3. `npm run seed:neo4j` applies `neo4j/schema.cypher`, then `neo4j/user-schema.cypher`, then the seed.
4. `SHOW CONSTRAINTS` in Neo4j Browser should list the `gm_appuser_id`, `gm_roadmap_id`,
   `gm_roadmaptask_key`, `gm_skillrating_key`, `gm_bookmark_key` and `gm_usednonce_nonce` constraints.

What the automated tests prove: the store's logic, the parameter contract, the schema-to-query
consistency, and the Query API client's request and failure handling, all against mocks. They do not
prove that AuraDB accepts these statements. Only step 2 and step 3 against a live instance do that,
and that result is reported separately.
