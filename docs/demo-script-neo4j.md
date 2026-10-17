# Judge demo: verify before claiming live Neo4j

This script is evidence-led. If the actual service is not available, demonstrate the demo application and say it uses bundled sample data. Never present expected values as observed results.

## Preflight

1. Confirm the deployed Node backend URL from the Render dashboard (or use the configured Supabase Functions URL for the alternative deployment).
2. Check that the server-side Neo4j credentials exist in the host dashboard; do not show or copy the password into a browser or shell transcript.
3. If the Neo4j graph needs seeding, review the target database and run the idempotent `npm run seed:neo4j` process. The seed uses MERGE and has no reset step.
4. Verify the actual backend:

   ```bash
   node scripts/verify-neo4j.mjs https://ACTUAL-BACKEND-ORIGIN
   ```

   Continue with live claims only if the result is **PASS**. Save the real output, including query records and timing. **BLOCKED** means the live demonstration is unavailable; **FAIL** means a defect must be fixed.
5. Confirm that GitHub Actions variable `VITE_API_BASE_URL` has the actual public API base (Node example: `https://ACTUAL-BACKEND-ORIGIN/functions/v1`) and that a new Pages workflow completed afterward.

## Demonstration flow

1. Open the published Pages URL. The base path is `/Neo4j-Build-Sprint/`. A green or connected health indicator alone is not proof of returned live data.
2. Navigate to a graph-backed page and wait for a successful response. **LIVE NEO4J** should appear only after response metadata confirms `meta.source: "neo4j-live"`. If the status says DEMO DATA, BACKEND UNAVAILABLE, or NEO4J UNAVAILABLE, report that actual condition.
3. In DevTools Network, show a request to the deployed backend (not localhost), the CORS response, HTTP status, response `meta.source`, and data. Check for console errors.
4. For a direct backend demonstration, open the API response from the verifier. Its named query ID is `career.longest-prereq-chain`; it returns the actual records and parameterized Cypher. Paste the Cypher into Neo4j Browser and set `$careerId` and `$limit` to the exact values in the verification output. Do not claim identical results unless the query is run against the same unchanged database.
5. Optionally inspect `/api/ledger/recent` for a successful `NAMED:career.longest-prereq-chain` entry with row count and duration.

## Cypher demonstrated by the API

```cypher
MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(s:Skill)
MATCH path = (s)-[:REQUIRES*1..6]->(base:Skill)
WHERE NOT (base)-[:REQUIRES]->(:Skill)
RETURN c.name AS career, s.name AS skill, length(path) AS depth,
       [n IN nodes(path) | n.name] AS chain
ORDER BY depth DESC LIMIT $limit
```

Schema: `Career`, `Skill`, `REQUIRES_SKILL`, `REQUIRES`; `id` and `name` properties. The query starts at skills required by the selected career and follows prerequisite relationships to terminal prerequisites.

## Safe failure demonstration

Use a test deployment or a local backend with Neo4j intentionally unavailable; do not change production credentials to stage an outage. When the backend itself cannot be reached, the UI labels the bundled fallback **BACKEND UNAVAILABLE · DEMO DATA**. When the backend responds but Neo4j cannot be reached, it shows **NEO4J UNAVAILABLE**, and live graph requests fail rather than silently substituting the bundle.
