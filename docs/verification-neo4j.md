# Neo4j verification

Architecture and deployment facts are maintained in [architecture.md](architecture.md). This guide records how to verify the **actual backend**, not just whether this source tree compiles.

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

Verdicts and exit codes are intentionally distinct:

- **PASS** (exit 0): an actual non-empty query response came back from the Neo4j-backed API with `servedBy: "neo4j-live"` and the official driver evidence field.
- **BLOCKED** (exit 2): backend/infrastructure is unreachable, not deployed, or its Neo4j connection is unavailable.
- **FAIL** (exit 1): a reachable service returned an invalid response or the required live query failed.

This checkout has no Neo4j credentials or confirmed deployed service URL. Therefore live verification is **BLOCKED unless the command above is run against an available instance and reports PASS**. A build, local mock test, or health ping is not a live-query result.

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

Example parameters are `$careerId = "career:software-engineer"` and `$limit = 10`. In Neo4j Browser, set those parameters or substitute the literal career ID and limit. The script only reports PASS if actual non-empty rows with career, skill, depth, and chain shape return. Its sample rows, when available, are the evidence; expected counts should not be invented in advance.

## Seed safety

`npm run seed:neo4j` loads generated parameterized data via Neo4j Query API. Seed statements use `MERGE`; by default, properties are set only on create, so reruns do not duplicate records or overwrite existing properties. `npm run seed:neo4j -- --update-existing` explicitly opts into updating seed-owned properties on matched records; review and authorize the target before using it. Normal seeding never clears or resets the database. The script compares counts to the generated manifest.
