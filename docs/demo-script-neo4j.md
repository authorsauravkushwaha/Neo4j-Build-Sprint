# Judge Demo Script (3–5 minutes) — GraphMentor AI on live Neo4j

Goal: prove to a technical judge that the site really answers a learner's
question using Cypher executed against a live Neo4j instance, and that the
evidence and read ledger are truthful.

## Pre-flight (you do this once)

1. Create (or reuse) a Neo4j AuraDB Free instance.
2. Set `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` in the backend host
   (Render, or a local `npm start`).
3. Load the curriculum:
   ```bash
   npm run seed:neo4j
   ```
4. Verify from your machine:
   ```bash
   npm run verify:neo4j
   # PASS — LIVE NEO4J VERIFIED
   ```
5. Deploy the Node backend (`render.yaml` Blueprint works) and set
   `VITE_API_BASE_URL` for the Pages build to that backend URL.

## Demo flow (3 minutes)

1. **Open the site.** The banner should read **LIVE NEO4J** (green) and show
   real counts from the database (444 nodes / 1,585 relationships). If you
   see **DEMO DATA** or **DATABASE UNAVAILABLE**, stop — the banner is honest.

2. **Open Settings → About** and show the provenance string:
   *"Live deployment: careers, skills, projects and resources are read from a
   Neo4j knowledge graph through the deployed backend API."*

3. **Pick a career**, e.g. *Software engineer*. The screen shows the required
   skills, ordered by the prerequisite traversal. Open **Skill gaps** and
   rate a few skills (e.g. mark `programming-fundamentals` as confident, leave
   everything else unknown). The gap analysis and roadmap are computed from
   the multi-hop `REQUIRES` traversal — the same Cypher as
   `career.longest-prereq-chain` and `skill.routes-to-career` in
   `neo4j/live-demo.cypher`.

4. **Open the Knowledge Graph**, pick the same career, click a skill, and
   show the subgraph. The data was fetched from `/api/graph/explore` — it
   returns actual nodes and edges from Neo4j, not a static bundle.

5. **Open Mentor** and ask: *"What is the longest prerequisite chain from
   programming fundamentals to a skill a software engineer needs?"* — the
   answer cites skills you can click through to.

6. **Open DevTools → Network**, hit refresh on the `/functions/v1/health-check`
   call. Show the payload:
   ```json
   "graph": { "configured": true, "reachable": true, "source": "neo4j-live", "nodeCount": 444, "relationshipCount": 1585, ... }
   ```

7. **Hit the read ledger** directly:
   ```
   curl https://<your-backend>/api/ledger/recent
   ```
   Show the first few entries — real query ids, timings, row counts, and
   `servedBy: "neo4j-live"`.

8. **Show the judge the Cypher.** Open `neo4j/live-demo.cypher` and paste the
   *longest prerequisite chain* query into Neo4j Browser. Run it against the
   Aura instance — the result is the same chain the UI showed. That is the
   proof: the app's answer is a view onto real graph traversal results.

## Failure-mode demo (30 seconds)

Stop the backend (or use a deliberately wrong password in `.env.local`).
Reload the site. The banner changes to **DATABASE UNAVAILABLE** and the graph
screens tell you why — no silent fallback, no fabricated counts.

## Commands to show verbatim

```bash
# Honest integration verdict
npm run verify:neo4j

# End-to-end HTTP smoke against a running backend
node scripts/verify-neo4j.mjs https://<your-backend>

# Seed the Aura instance (idempotent)
npm run seed:neo4j

# Cypher catalogue used by the app (reviewable)
cat neo4j/live-demo.cypher
```
