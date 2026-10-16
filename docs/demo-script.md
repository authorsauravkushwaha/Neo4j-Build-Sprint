# Demo script — showing the app, and reproducing every number

Two audiences: someone showing this to another person (a 5-minute demo path), and someone who wants to
check the claims themselves (the reproduction commands).

---

## Part 1 — A 5-minute demo, in order

The point of this order is that the graph comes **before** the AI: the signature feature is the knowledge
graph, and the mentor is a thin layer over it. Do not open the mentor first.

### 0:00 — Landing page (`/`)

> "This is a career navigator for engineering students. It plans *what to learn, in what order, and what is
> actually free* — from a knowledge graph, not a course list."

Point at the honesty banner: it says whether the app is on **live graph data** or the **bundled sample
dataset**. Say which one you are showing. If you are running demo mode, say so out loud — the app does.

### 0:30 — Knowledge graph (`/graph`)

Pick **Embedded systems and IoT engineer** in *Career view*.

- Drag a node, scroll to zoom, press **Fit**.
- Click *C programming language*. Point at the panel: prerequisites in amber, unlocks in green, everything
  unrelated dimmed. That colouring is not decoration — it is a Cypher path query.
- Press **List** and show the same subgraph as a table. Say why: *"a canvas is invisible to a screen reader,
  so every capability here has a text equivalent."*
- Set **Path from / to** to two nodes that are several hops apart to draw the dependency chain between them.

> "Every query is bounded by depth and row limits. When a result is truncated, the UI says so instead of
> drawing a partial graph and hoping you do not notice."

### 1:45 — Skill gap (`/gaps`)

Choose **Data scientist and analyst**. Rate two or three skills (or use stored ratings from onboarding).

Point at the three counters: **missing prerequisites**, **recommended next**, **optional specialisations**.
Emphasise the split — the most common bad advice is "learn everything in the syllabus", and the graph lets
the app say "this is breadth, not a requirement".

Read the caveat out loud: *"Self-ratings are estimates: the graph cannot verify them."* That sentence is
deliberate.

### 2:45 — Roadmap (`/roadmap`)

Same career. Set **Hours per week** to 3 h, then to 15 h, and show the plan reflowing.

- Weeks are sized to the hours you really have.
- Find a **Review** chip: spaced review rows exist because the plan would otherwise be unrealistic.
- Mark one task complete. If signed in on a live backend, press **Save to my account**, then change a status
  and note the toast says *"saved on this device and to your account"* — the app never claims a copy exists
  when it does not.
- Show **Export Markdown**: your statuses and the caveats travel with the plan.

### 3:45 — Projects and resources

`/projects`: open a hardware project and scroll to **Safety notes** (mains voltage, soldering, cloud cost).
`/resources`: point at the two honesty labels on every card — what *free* means for that provider, and the
day the link was last checked.

> "Fifty-two free resources, each with a stated access model. A link that refused our checker shows as
> unverified — we do not label something 'checked' when the check failed."

### 4:15 — Mentor (`/mentor`)

Ask: **"What should I learn first for embedded systems, and why?"**

- The answer cites the skills it used and lists what it does not know.
- Point at the provider line in the answer footer: *"Answered by the deterministic rules engine… No language
  model was called."* Explain that this is the default — the app is fully useful with no AI key, and an AI
  only rephrases facts the graph already contains.

Then ask it something outside its scope (e.g. *"should I quit my degree?"*) to show it declines rather than
improvising.

### 4:45 — Close on limits

Open **`/about`** and read the *what this app cannot do* list: no job or salary guarantee, curated finite
dataset, unverified self-ratings, free-tier quotas, and what could not be verified in this build.

> "The feature list and the limitation list are the same length on purpose."

---

## Part 2 — Reproduce every number yourself

Everything below was run to produce [verification.md](verification.md). None of it needs credentials.

```bash
npm ci                                   # exact pinned tree
npx tsc -b                               # 0 TypeScript errors
npx vitest run                           # 621 tests pass across 41 files
npm run validate:seed                    # 58/58 dataset + engine + Cypher checks
npm run emit:cypher -- --check           # generated Cypher is current
npm run lint:secrets                     # no credential-shaped strings in the source tree or the built bundle
npm run oracle                           # 39 frontier cases recomputed in Java, 507 lines identical
npm audit --omit=dev                     # 0 vulnerabilities in the shipped tree
npm run seed:neo4j -- --dry-run           # 32 statements, 1363 rows, writes nothing
npm run build                            # production build + PWA service worker
npm run verify:resources                 # re-check all 154 links (needs internet)
```

And the three that go past jsdom into real infrastructure — all local, none of them a deployment:

```bash
# 42 checks: the migrations applied to PostgreSQL 17, then the isolation/attack matrix
DATABASE_URL=postgres://postgres:local-dev-only@127.0.0.1:5432/graphmentor npm run verify:rls

# 30 checks: the auth path over a real socket, limiter in that same database
DATABASE_URL=postgres://postgres:local-dev-only@127.0.0.1:5432/graphmentor npm run smoke:http

# 69 checks: headless Chromium with WebGL — hero, 3D graph, the neumorphic material, the command palette, 360 px, reduced motion
npm run build && npx vite preview --host 0.0.0.0 --port 4173 &
BASE_URL=http://127.0.0.1:4173 CHECK_OFFLINE=1 npm run verify:browser
```

### What to look at in each result

| Command | What a correct result looks like |
| --- | --- |
| `npx vitest run` | `Test Files 41 passed (41)`, `Tests 621 passed (621)` |
| `npm run validate:seed` | `58/58 checks passed` then `Self-check passed.` |
| `npm run emit:cypher -- --check` | `neo4j artefacts are up to date.` |
| `npm run lint:secrets` | `Secret scan clean: <n> source file(s) checked…` plus `Built bundle clean: <n> file(s) under dist/ checked` and a `Rule canary: 14/14 fixtures classified correctly` line — the file counts grow with the repository, the canary is the assertion |
| `npm run verify:rls` | `42/42 checks passed` against PostgreSQL 17 |
| `npm run smoke:http` | `30/30 checks passed` then `The auth pipeline behaves over HTTP: rate-limited, CORS-scoped, leaking nothing.` |
| `npm run verify:browser` | `112/112 checks passed` then `Rendered in a real engine: WebGL scenes, the neumorphic material, mobile layout and reduced motion all behave.` Screenshots land in `docs/screenshots/` |
| `npm run seed:neo4j -- --dry-run` | `32 statement(s), 1363 row(s) to write` then `Dry run: nothing was written.` |
| `npm run build` | `✓ built in …` then `PWA v2.0.0 … precache 35 entries` and `dist/sw.js` |
| `npm run oracle` | `MATCH: 39 case(s), 507 canonical line(s) identical…` then `Self-test OK` |
| `npm run verify:resources` | A summary line plus a table in `docs/resource-verification.md`. Counts vary by network. |

### Exploring the graph by hand

`neo4j/sample-queries.cypher` contains the 29 statements the application actually runs, generated from the
same source as the app, with the parameters documented. To use one in Neo4j Browser, replace the
`$parameters` with literals. Good starting points:

- `CAREER_DETAILS` — one career with branches, required skills, related careers and projects.
- `ROUTES_SKILL_TO_CAREER` — the shortest routes from a skill you already have to a target career.
- `PROJECTS_FOR_SKILLS` — projects ranked by how many of a given skill set they exercise.
- `RESOURCES_FOR_SKILLS` — free resources covering a set of skills.

After seeding a real instance, these should return rows immediately:

```cypher
MATCH (n) RETURN count(n) AS nodes;              // 304
MATCH ()-[r]->() RETURN count(r) AS rels;        // 1437
MATCH (c:Career) RETURN c.name ORDER BY c.name;  // 17 careers
```

### Checking the honesty claims mechanically

Three of the promises in this project are asserted by tests, so they cannot quietly decay:

```bash
npx vitest run tests/integration/pages.test.tsx   # "contains no invented social proof"
npx vitest run tests/unit/resources.test.ts       # "only calls a resource verified when the checker actually reached it"
npx vitest run tests/integration/handlers.test.ts # error bodies leak no SQL, paths or stack frames
```

---

## Part 3 — Demo-mode caveats to state out loud

If you are demoing without a backend (the default), say these before anyone asks:

1. **The pages are computing, not fetching.** The same engine runs in your browser over the bundled
   dataset. That is a real computation over real curated content — it is just not a database round trip.
2. **No account is needed and none exists in this build.** Sign-in buttons are hidden when the backend is
   not configured; nothing is faked to look like a server.
3. **Progress lives in this browser.** Use Settings → export before clearing a browser profile.
4. **The mentor is the rules engine.** Answers are cited but templated; with a provider configured, the
   same facts get phrased more naturally.
5. **No screenshots in this repository were taken from a live Neo4j instance**, because none was available
   while it was built. Live mode is implemented and covered by handler tests; running it against a real
   instance is the one step that has not been done.


