# Verification results

This file records **what was actually run, where, and what came back**. It is the honest counterpart to
the feature list: anything not in the "verified" sections below has not been proven to work, and the app
says so in its own UI where relevant.

Environment used for this build:

| | |
| --- | --- |
| Date of this run | **2026-10-14 (UTC)**: types, the full test suite, the build, the bundle, the cross-language oracle, the browser checks and the local PostgreSQL rows were all re-run on that date, after the security-hardening pass and the frontier/delta work. §3 (resource links, measured live) was re-run on the same date — see `docs/resource-verification.md` for the timestamped report |
| Node.js | v20.20.2 |
| npm | 10.8.2 |
| OS | Linux container, x86_64 (no Android SDK, no JDK 17) |
| Local infrastructure used in §5 | PostgreSQL **17.11** on `127.0.0.1` with the project's migrations; headless **Chromium 156** via Playwright 1.64.0 with WebGL 2.0 (ANGLE/SwiftShader) |
| Credentials available | **none** — no Neo4j instance, no Supabase project, no AI provider key. §5 runs against local infrastructure only, and is described that way throughout |

Re-run everything yourself with the commands in the last section. This is a **historical 2026-10-14/16 snapshot**, not evidence for the current working tree or an external deployment. For current architecture and production verification, see [architecture.md](architecture.md). In particular, this old log does not establish that the public Pages site reaches a deployed backend or that a current hosted Neo4j query succeeds; those remain unverified until the current HTTP verifier returns PASS.

---

## 1. Verified: build, types, tests

| Check | Command | Result |
| --- | --- | --- |
| Dependency install | `npm ci` | OK — 622 lockfile entries installed with the pinned versions from `package-lock.json` |
| Type check | `npx tsc -b` | **0 errors** |
| Unit + integration tests | `npx vitest run` | **383 passed / 0 failed** across 22 files |
| Cross-language oracle | `npm run oracle` | **MATCH — 39 case(s), 507 canonical line(s)** recomputed independently in Java (javac 11, no build tool) from the same fixture; the self-test then corrupts one character of the expectation and requires the diff to catch it |
| Production build | `npm run build` | OK — built in 7.44 s (timings vary by machine) |
| Bundle size | (build output) | entry `index-*.js` 1004 kB (293 kB gzipped, measured with `gzip -9` on the shipped file); graph chunk 443 kB (cytoscape, loaded only by the graph view); `three.module` 747 kB (loaded only when a scene actually builds). Both heavy dependencies are split into their own chunks — the entry bundle contains neither |
| PWA service worker | `npm run build` | 35 precache entries, 2674.76 KiB as the build reports; `dist/sw.js` + `dist/workbox-*.js` generated |
| Output size | `du -sh dist` | 2.5 MB |

The build prints a chunk-size warning. It is left visible rather than silenced: the entry bundle is over the
900 kB advisory line, `three.js` is the largest single contributor after it moves to its own chunk, and
hiding the warning would hide the reason to split the landing route further.

### Test breakdown (all green)

| Suite | Tests | What it pins |
| --- | --- | --- |
| `tests/unit/security.test.ts` | 46 | Template-injection detection (including the `{user.__class__}` bypass that was found and fixed), redundant-path/ReDoS guard, URL validation, long-password policy (length + blocklist, verified to accept long single-class passphrases), prompt-injection screening, secret redaction |
| `tests/unit/hardening-invariants.test.ts` | 28 | The claims that were true by inspection, now enforced: no file-upload surface anywhere (asserted against the landing page's own wording), every shipped Cypher query is a literal with `$limit` bounds, `readConfig` ignores non-`VITE_` keys so no server secret can be inlined, the built bundle carries no secret-shaped string, the three CSP copies declare identical directives and never allow inline style elements or eval script, the two static-host header files agree on every security header, every `target="_blank"` link carries `noopener`, zod is configured jitless *before* the modules that would trigger its eval probe, and no `innerHTML`/`eval`/`new Function` sink exists in application code (with a guard proving the comment-stripper cannot hide one) |
| `tests/integration/store-authorization.test.ts` | 17 | Authentication is not authorisation, checked at the layer that talks to Postgres: every write carries the verified `user_id`, a client-supplied roadmap id is looked up under the caller's id before it can be a write target (and a foreign id becomes an ordinary create), a foreign row and a missing row give byte-identical errors, account delete/export touch only the caller's rows, and the auth verifier refuses forged, malformed and unverifiable tokens |
| `tests/integration/command-palette.test.tsx` | 7 | The palette: real dialog semantics, focus handling, grouping and ranking, and that the panel is the same neumorphic surface as the rest of the app |
| `tests/unit/palette-search.test.ts` | 12 | The ranker's rules, including that fuzzy subsequence matching is gone for good (`pdc` must not resolve) |
| `tests/unit/frontier.test.ts` | 25 | The delta engine: the startable set is exactly what has nothing unmet in front of it, the met-threshold behaves as documented (and a quiz score can move a borderline claim but never promotes one the self-report did not support), gates are counted as a union rather than a sum, the critical chain is a real prerequisite path in the input graph, cycles are disclosed without hanging, output is byte-identical run to run, ordering is code-unit rather than locale-dependent, effort is a range with the pace it assumed — and, across all 17 careers, more knowledge never increases what is left to do |
| `tests/unit/recommend.test.ts` | 31 | Gap analysis, dependency-respecting ordering, scheduler invariants, determinism under a pinned clock, review spacing, project/resource ranking, prerequisite closure and cycle detection |
| `tests/unit/validate.test.ts` | 25 | Unknown-field rejection, range and enum enforcement, control-character rejection, length limits |
| `tests/unit/persistence.test.ts` | 25 | Local readers against hostile and legacy input, erasure, export, live storage probing |
| `tests/integration/handlers.test.ts` | 43 | All 16 endpoints through the real handler stack: auth, ownership (a second user cannot read or update another's rows), validation statuses, rate limits, error hygiene |
| `tests/integration/pages.test.tsx` | 12 | Real screens in jsdom: graph canvas + accessible list view, roadmap progress round-trip, gap analyzer, the resource library's effort estimates and skill-linked prerequisites, no invented social proof |
| `tests/integration/writes.test.ts` | 17 | Write endpoints through both clients; demo mode never claims data was sent |
| `tests/unit/rateLimit.test.ts` | 10 | Fixed-window counting, bucket isolation |
| `tests/unit/assessmentCodec.test.ts` | 10 | Assessment encode/decode round-trips and option-count bounds |
| `tests/unit/resources.test.ts` | 9 | Only reachable links are labelled verified; no paid tier described as free; every resource states outcomes, prerequisites, limits and time; no summary wastes itself repeating the outcome list; every skill is routed through two or more resources; search reaches the detail fields, not just the summary |
| `tests/unit/auth.test.ts` | 17 | The browser's password rule is the server's function, not a copy of it; multi-byte passwords measured in bytes; sign-in error wording never reveals whether an address is registered; session facts never contain a token |
| `tests/integration/authGuard.test.ts` | 13 | Sign-in guard: per-address and per-host ceilings fire, identical answers for registered and unknown addresses, strict body schema, fail-open when the counter store breaks, no echo of the submitted fingerprint |
| `tests/integration/authPages.test.tsx` | 7 | With no backend configured there is no password form and guest mode is still offered; a stale reset link explains itself; the "how this is protected" list claims nothing the code does not do |
| `tests/integration/landing.test.tsx` | 6 | The 3D hero is labelled a fixed composition, no fabricated social proof, `guarantee` appears only in a denial, security bullets match implemented controls, the WebGL fallback still carries the page |
| `tests/unit/docs.test.ts` | 3 | Every `docs/*.md` referenced from `src/` or `supabase/` exists and is cased correctly — the check that would have caught the three dead references this repo once had |

### Later runs (2026-10-16)

The rows above are the 2026-10-14 run and are kept as written, because a log that gets edited to match the
current tree is no longer a log. These were re-measured on **2026-10-16**, after the workflow engine, the
public-API import, the self-audit harness and the Appwrite storage adapter landed:

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc -b` | **0 errors** |
| Unit + integration tests | `npx vitest run` | **639 passed / 0 failed** across **44 files** |
| Self-audit | `npx tsx scripts/audit/self.ts` | **25/25 passed**, 0 failed, 0 errored (report: [security-self-audit.md](security-self-audit.md)) |
| Production build | `npm run build` | OK — 30 precache entries, 2851.85 KiB |
| Appwrite adapter + conformance | `npx vitest run tests/unit/appwrite-adapter.test.ts tests/integration/appwrite-backend.test.ts` | **49 passed** (41 + 8; the integration half replays 21 requests on both backends and compares them one at a time) |

Suites that did not exist when the table above was written: `tests/unit/workflow-engine.test.ts` (56),
`tests/unit/self-audit.test.ts` (9), `tests/unit/appwrite-adapter.test.ts` (41),
`tests/integration/appwrite-backend.test.ts` (8), `tests/unit/story-graph.test.ts` (11),
`tests/unit/skiper-motion.test.ts` (14), `tests/integration/workflows.test.tsx` (7),
`tests/unit/public-apis.test.ts` (17), `tests/unit/dataset-prose.test.ts` (3),
`tests/integration/scroll-chrome.test.tsx` (10), `tests/unit/scroll-coverage.test.ts` (8),
`tests/unit/public-apis-importer.test.ts` (6), `tests/integration/apis.test.tsx` (8),
`tests/unit/route-collisions.test.ts` (4), `tests/unit/mentor-ledger.test.ts` (10) and
`tests/integration/mentor.test.tsx` (4).

**Not re-run on 2026-10-16**, and therefore still only claimed for 2026-10-14: §3 (resource links, which
needs the open internet), §5's browser checks and local PostgreSQL rows, and the Java oracle. The container
this change was made in has no Chromium download, no local database and no JDK; CI runs the first two.

## 2. Verified: dataset and generated Cypher

| Check | Command | Result |
| --- | --- | --- |
| Dataset self-check | `npm run validate:seed` | **58/58 checks passed** — dataset, engine and generated Cypher agree |
| Cypher freshness | `npm run emit:cypher -- --check` | `neo4j artefacts are up to date` |
| Seed dry run | `npm run seed:neo4j -- --dry-run` | 32 batched `MERGE` statements, 1363 rows. Nothing written. |

Dataset contents (counted from the source of truth, `src/data/seed/knowledgeGraph.ts`, and asserted
against the prose in this repository by `tests/unit/dataset-prose.test.ts`):

| Entity | Count | Entity | Count |
| --- | --- | --- | --- |
| Engineering branches | 16 | Languages | 8 |
| Careers | 17 | Tools | 37 |
| Subjects | 24 | Projects | 33 |
| Concepts | 37 | Resources | 154 |
| Skills | 89 | Learning modules | 13 |
| Assessments | 16 | Graph edges | 1585 |

Edge types, counted from the dataset: `BELONGS_TO` 75, `HAS_CONCEPT` 37, `BUILDS_ON` 18, `REQUIRES` 144,
`REQUIRES_SKILL` 173, `USES` 70, `BUILDS_SKILL` 106, `PRACTICED_BY` 106, `SUGGESTS_PROJECT` 56,
`COVERS` 340, `TAUGHT_BY` 237, `ASSUMES` 120 (across 91 resources), `TEACHES` 55, `ASSESSES` 16,
`RELATED_TO` 32 — 15 relationship types in total, which is what `datasetCounts.relationshipTypes` reports.

## 3. Verified: resource links (measured live, 2026-10-14)

> **Read this section with its date.** It was measured when the library held 97
> resources; the dataset now holds **154**, so 57 of them have never been opened by
> this report. The method, the outcome vocabulary and the honesty rules below are
> unchanged — only the set is stale. Re-running it (`npm run verify:resources`)
> overwrites `docs/resource-verification.md` with a fresh measurement, and the app
> shows each resource's own `lastVerified` date next to its link, which is the
> number that actually travels with the data.

`npm run verify:resources` opened all 97 links with a plain HTTPS request.

| Outcome | Count |
| --- | --- |
| Reachable, no redirect | 89 |
| Reachable, redirects | 7 |
| Blocked (403 from this network) | 1 |
| Failed (4xx/5xx) | 0 |
| Timed out | 0 |

Full per-link table: [resource-verification.md](resource-verification.md).

Three links in the dataset were **replaced** because the checker proved the old ones dead or moved:
Linux Journey (now `linuxcommand.org`'s free book), the NREL solar resource page (unresolvable from this
network — replaced by the EU JRC PVGIS tool, which was reachable) and the US DOE solar page (404 after
their site restructure — now `energy.gov/cmei/systems/how-does-solar-work`).

The one `blocked` entry (All About Circuits, HTTP 403 to automated clients) is deliberately **left
unverified in the dataset**: no check date, no "link checked" badge. That is the intended behaviour — a
site that refuses the checker must not be presented as confirmed.

### What each entry promises (and how it is enforced)

A list of links is not a library. Every resource now carries four fields beyond its access note, and the
self-check fails the build if any of them is missing:

| Field | Meaning | Enforced by |
| --- | --- | --- |
| `outcomes` | what you can actually do after working through it (at least two per resource) | `validate:seed` — "every resource states outcomes, prerequisites, limits and time" |
| `assumes` | what the material presumes you already know | same check |
| `limits` | where the material stops — the honest boundary | same check |
| `commitment` | the shape of the time involved, never a promise about it | same check |
| `estimatedHours` | an honest range in hours, calibrated against the skill estimates in the same dataset | `validate:seed` — "every resource carries a sane hour estimate (1 ≤ low ≤ high ≤ 400)" |
| `assumesSkillIds` → `ASSUMES` edges | the prerequisites as graph skills, not prose — clickable in the UI, queryable as `(r:Resource)-[:ASSUMES]->(s:Skill)` | `validate:seed` — every target is a real skill, comes back with its name, and is taught by some resource |

They travel the whole way: the seed dataset, the `Resource` nodes in Neo4j, the reader interface, the API
contract and the resource page. The browser check (§5) asserts that all 97 rows render them. The summaries
themselves are held to one sentence that does not repeat the outcome list — a unit test fails if a summary
starts restating its own bullets — and search runs across the detail fields, so a query like
`padding oracle` finds the resource whose *limits* mention it rather than only its title.

**Coverage is enforced, not hoped for.** The graph has 89 skills; the library has to route every one of
them, and no skill may hang off a single link. `validate:seed` now fails with the list of skills if that
stops being true:

```text
  ok   every skill is reachable from at least one resource — 89 skills linked
  ok   no skill rests on a single resource link — every skill has 2+ resources
```

## 4. Verified: security controls (code and tests)

| Control | Where | Evidence |
| --- | --- | --- |
| No secrets committed | `npm run lint:secrets` | `Secret scan clean: 156 file(s) checked, no credential-shaped strings found` |
| Shipped dependency tree | `npm audit --omit=dev` | **0 vulnerabilities** |
| Template / SSTI indicators | `supabase/functions/_shared/core/security.ts` | 39 unit tests, including the fixed `__class__` bypass |
| ReDoS | `security.ts` redundant-path guard | unit tests with pathological inputs |
| Long-password DoS | `DEFAULT_PASSWORD_LIMITS` (10 chars min, 72 bytes max, refused rather than truncated) | unit tests |
| Sign-in attempt flooding | `POST /auth-guard` ceilings: 10/min and 40/h per address (hashed), 30/min per host | `tests/integration/authGuard.test.ts` (13); over real HTTP and a real Postgres in §5 (429 with `retry-after`) |
| Account enumeration | One wording per failure class; the guard answers identically for known and unknown addresses | `tests/unit/auth.test.ts`, `tests/integration/authGuard.test.ts` |
| Injection | All queries parameterised; identifiers allow-listed; PostgREST filters typed | `handlers.test.ts` (unknown query parameters are rejected, not ignored) |
| Authorization ≠ authentication | Ownership checks in every write handler + RLS | `handlers.test.ts`: a second authenticated user cannot read, update or delete another user's roadmap; §5 replays thirteen intruder attacks against the real policies |
| Replay | HMAC over `method\npath\ntimestamp\nbody` + single-use nonce store (fails closed) | unit + handler tests for `stale`, `future`, `mismatch`, `malformed` |
| Rate limiting | Fixed-window buckets in Postgres, per user or per IP | `rateLimit.test.ts`, handler tests (429 with `retryAfterSeconds`); §5 counts 64 concurrent increments to exactly 64, and drives the Postgres-backed limiter over HTTP |
| Error hygiene | `toErrorResponse` — public messages only | handler tests assert no SQL, no stack frames, no internal paths, no credentials in any error body |
| CORS | Explicit allow-list, `vary: origin`, never `*` | handler tests |
| Cache policy | Private responses `no-store`; public reads 60–300 s | handler tests |

Full mapping, including what each control does *not* cover: [security.md](security.md).

## 5. Verified: the security-critical paths against real infrastructure (locally)

Sections 1–4 run in Node and jsdom. The four runs below drive the same code against real infrastructure:
a real PostgreSQL, a real socket, and a real browser engine. They exist because the first three of them
**found real defects that no unit test had caught**.

| Check | Command | Environment | Result |
| --- | --- | --- | --- |
| Row Level Security, with the migrations unmodified | `DATABASE_URL=postgres://postgres:local-dev-only@127.0.0.1:5432/graphmentor npm run verify:rls` | PostgreSQL 17.11, plus `supabase/local/00_supabase_shim.sql` — a local-only re-creation of the Supabase auth contract (roles, `auth.users`, `auth.uid()`, Supabase's own default privileges) | **42/42 checks** |
| The auth path over HTTP, with the limiter on that database | `DATABASE_URL=… npm run smoke:http` | A Node HTTP server on an ephemeral port running the same pipeline as `platform/deno.ts` (`buildApiRequest` → CORS → method → handler → `toErrorResponse`) | **30/30 checks** |
| Nine hostile payload classes plus the guest-mode claim, typed into the product's own controls | `BASE_URL=http://127.0.0.1:4173 npm run verify:injection` | Headless Chromium, 1440×900, a fresh context per payload class with `alert`/`confirm`/`prompt` trapped, a side-effect flag inside each payload, and a MutationObserver watching for payload-shaped markup | **10/10 checks** — 8 editable controls on 4 routes (`/onboarding`, `/graph`, `/mentor`, `/settings`), payloads committed and echoed as literal text, nothing executed, nothing parsed as markup, no page error; input ceilings recorded rather than glossed over (5 of 8 controls refuse the 20 kB value at `maxLength`) |
| The 3D UI, the neumorphic material and the mobile layouts in a real browser engine | `BASE_URL=http://127.0.0.1:4173 npm run verify:browser` (add `CHECK_OFFLINE=1` for the service worker) | Headless Chromium 156, WebGL 2.0 via ANGLE/SwiftShader — a fresh browser context per situation (desktop 1440×900, phone 360×740, a reduced-motion context, the service-worker/offline context, the library, the palette, the CSP probes, the delta view, the worked example and the pointer audit) | **112/112 checks**, with 9 screenshots written (the recorded `docs/browser-verification.json` is this run) |

**What the database run covers**, in order: the shim and both migrations apply unmodified; the sign-up
trigger creates profiles; the invariants hold (RLS enabled on all six tables; `anon` *is* granted
privileges — Supabase grants `ALL` and lets RLS decide the rows — while `gm_rate_limit` and `gm_nonce`
are revoked outright and carry zero policies); owner inserts commit and read back; **thirteen intruder
attacks are refused** (`42501` from RLS, `23503` from the composite foreign key that stops a task being
filed under someone else's roadmap); an anonymous reader sees zero rows yet can still submit unattributed
feedback; the service role reads across accounts through `bypassrls`; the limiter counts a window
correctly, rejects a too-short key with `22023`, and **64 concurrent increments produce exactly 64**; a
nonce is claimed once and the replay is refused; deleting a user cascades to zero orphans.

**What the HTTP run covers:** `POST /auth-guard` answers 200 with a slot and `cache-control: no-store`;
attempts decrease and a spent address then gets **429 with a numeric `retry-after`** and the ceiling that
stopped it; a fresh address starts with the full allowance; **two different addresses get byte-identical
answer shapes, and no identifier is ever echoed back**; one busy host runs out of attempts across many
addresses; `OPTIONS` is a 204 preflight; `GET` is a 405 with `Allow`; an unlisted origin gets a response
with no CORS headers at all; an invalid body is 422 with a stable code and no stack, SQL or file path in
the message; unknown fields are rejected rather than ignored; an oversized body is 413 before the handler
runs; malformed JSON is 400 rather than 500. In its database phase the same requests write counters into
`public.gm_rate_limit` through the project's own SQL functions: the stored keys are hashed
(`auth.addr.4754f5d1…`), the refusal is driven by the stored count, and the nonce store accepts a nonce
exactly once.

**What the browser run covers:** the hero scene and the 3D graph reach `data-status="running"` and actually
**draw** (composited pixel statistics, not merely a mounted `<canvas>`); dragging rotates both and the
wheel zooms without scrolling the page; the hero copy is painted above the scene — 0 of 688 hit-test
samples reach the canvas — with a legibility scrim measured between them; the neumorphic material is
measured twice over, in computed styles *and* in rendered pixels (a card and the app bar paint the page
colour, the shadow pair is light-up-left/shade-down-right, chips reuse it at chip scale, form fields are
inset, a held button inverts its shadow, and no surface carries a backdrop blur); the 360 px layouts
neither overflow nor
contain a tap target under 24 px; reduced motion mounts no canvas and neutralises the animations; the
console stays clean across the whole run; and with `CHECK_OFFLINE=1` the service worker registers and an
offline navigation still renders the app shell. The capability gate is reported rather than assumed: this
Chromium hands back a context even for the caveat-bearing request, so the check asserts that the app follows
its own probe (refused → no canvas; allowed → the scene must run) and then exercises the user's override
through the real Settings screen, confirming it re-probes and persists. Section 8 opens the resource library
and compares the rendered page against the shipped dataset: **154 rows render for 154 resources**, every row
carries what you can do afterwards, what the material assumes, where it stops and how long it takes, every
row shows an effort estimate of the form `≈ 10–30 hours`, the 59 rows that have prerequisites link them to
the skill pages they name (read from the dataset, so the check fails if the two drift), every link is https,
and all three filters genuinely narrow the list rather than only appearing to — including a search for
`padding oracle`, which appears only in one resource's *limits* field.

**Three defects these runs found, all fixed:** the 3D scenes never built in *any* browser — the build effect
depended on a boolean that could not change, so every scene sat in `waiting` forever while jsdom tests,
which measure a zero-sized box and assert the fallback, stayed green; the graph explorer's career selector
did nothing at all, because two `setSearchParams` calls in one handler rebuilt the URL from the
pre-navigation params and the second erased the first; and cytoscape's `cose` layout threw
`Cannot read properties of null (reading 'notify')` from inside the library when a visitor switched views
mid-layout, because its animation frames outlived the core they belonged to. A fourth, smaller one was
found by the resource-library section while this document was being written: the page asked for a literal
`limit: 80` and silently showed 80 of 154 resources — it now requests exactly what the dataset holds, and
the browser check fails if the two ever disagree again. All four are covered by the checks above.

### Boundaries — read these before repeating any of the above

- All three runs are **local**. PostgreSQL 17 with the project's migrations and a local auth shim is not a
  Supabase deployment, and a Node port of the Deno request wrapper is not the Supabase gateway.
- Because there is no project, **nothing here exercises GoTrue**: password sign-in, sign-in links, and
  **email delivery for sign-in links and password resets have still never been sent or verified**.
- The hosted gateway's own behaviour — cold starts, timeouts, CDN caching, JWT verification, secret
  storage — is not covered by any run.
- The browser run renders through a software rasteriser (SwiftShader), so its frame times say nothing
  about a device with a GPU. They do prove the scenes are correct, not that they are fast.

## 6. NOT verified — read this before believing anything else

These are the parts that could not be exercised in this environment. The application tells the user the
same thing at runtime (health check, empty states, settings copy).

| Not verified | Why | What would verify it |
| --- | --- | --- |
| Live Neo4j query (historical entry) | No Neo4j AuraDB instance and no password available for that 2026-10-16 run | For a current proof, configure the backend, seed only after reviewing the target, and run `node scripts/verify-neo4j.mjs https://ACTUAL-BACKEND-ORIGIN`; health alone is insufficient. |
| Cypher correctness against a real server | The Query API was never contacted; only the generated statements and the local reader were exercised | Run `neo4j/sample-queries.cypher` in Neo4j Browser or via `npm run seed:neo4j` and inspect the returned rows |
| The Supabase-hosted backend | The handlers run against a local Postgres (§5), but PostgREST, the gateway, cold starts, timeouts and secret storage were never exercised | `supabase db push` + `supabase functions deploy …`, then sign in as two accounts and confirm each sees only their own rows |
| GoTrue, end to end | There is no project and no SMTP, so `signInWithPassword` was never called against a real provider and **no email was ever sent** | Create the project, configure SMTP, enable password sign-in, and sign in from `/login`; then request a link and a reset |
| AI provider calls | No key, and no paid dependency is used | Set `AI_PROVIDER=gemini` with a free key and ask the mentor a question |
| Android app and APK | No Android SDK and no JDK 17 in this container, so Gradle cannot run | `npm run cap:add:android && npm run cap:sync`, then `./gradlew assembleDebug` |
| Performance on a mid-range phone | No device, no Lighthouse run; the browser check in §5 renders through a software rasteriser | Lighthouse (mobile) against the deployed site |
| Performance of the 2D canvas on a slow machine | The graph canvas itself draws in under a second from a cold load here, but remounting it immediately after the 3D view took seconds under software rendering — not reproducible evidence for real hardware either way | Open `/graph` on a mid-range phone and switch Canvas → 3D → Canvas while watching for jank |
| Behaviour behind a real CDN/proxy | Local servers only | Deploy, then confirm `vary: origin` survives the CDN and that cached responses are the public ones |

The canvas note that used to live here is now resolved rather than outstanding: jsdom reports zero size for
every element, and the graph used to crash the layout engine and unmount the page as a result. It now
measures its container, waits for a real box, and falls back to a message plus the list view — and the
rendered canvas has since been exercised in a real engine with WebGL (see §5).

## 7. Reproducing all of this

```bash
npm ci                                        # exact pinned dependency tree
npx tsc -b                                    # 0 errors expected
npx vitest run                                # 639 passed expected, in 44 files
npm run validate:seed                         # 53/53 expected
npm run emit:cypher -- --check                # "artefacts are up to date"
npm run lint:secrets                          # "Secret scan clean"
npm audit --omit=dev                          # "found 0 vulnerabilities"
npm run seed:neo4j -- --dry-run                # 32 statements, 1363 rows, nothing written
npm run build                                 # production build + service worker
npm run verify                                # the whole chain in one command, with skips named
npm run verify -- --with-infra                # ...and refuse to skip the local-infra steps
npm run verify:resources                      # needs internet; rewrites docs/resource-verification.md
```

The three runs in §5 need local infrastructure first:

```bash
# 1. PostgreSQL 17 + the project's migrations, then the isolation matrix (42 checks)
sudo apt-get install -y postgresql postgresql-client
sudo pg_ctlcluster 17 main start
psql "postgres://postgres@127.0.0.1:5432/postgres" \
  -c "create role gm_app login password 'local-dev-only'" -c "create database graphmentor owner gm_app"
DATABASE_URL=postgres://postgres:local-dev-only@127.0.0.1:5432/graphmentor npm run verify:rls

# 2. The auth path over a real socket, with the limiter in that database (30 checks)
DATABASE_URL=postgres://postgres:local-dev-only@127.0.0.1:5432/graphmentor npm run smoke:http

# 3. A real browser (52 checks; CHECK_OFFLINE=1 adds the service-worker and offline phases)
npm run build && npx vite preview --host 0.0.0.0 --port 4173 &
npx playwright install --with-deps chromium
BASE_URL=http://127.0.0.1:4173 CHECK_OFFLINE=1 npm run verify:browser
```

`verify:rls` creates its own schemas and refuses to run against a database it did not create; if it exits
with code 2, reset that database with `drop schema auth, public cascade; create schema public;` first.

`npm run verify:resources` writes its results and updates `src/data/seed/resourceVerification.json`. After
running it, `npm run validate:seed && npm run emit:cypher` keeps the Cypher in step with the dataset.

### Known dev-toolchain advisories (not shipped)

`npm audit` (including dev dependencies) reports 3 advisories, all inside the **test runner**:
`tinypool` (2 critical, via `vitest@3.2.7`) and `@vitest/mocker` (1 moderate). Neither is part of the
built app — `npm audit --omit=dev` reports zero — and neither is reachable at runtime, because tests are
not run in production. The available fix is `vitest@4`, a major upgrade that was **not** adopted here
because it would need the whole suite re-verified; it is recorded as a deliberate, documented trade-off
rather than silently ignored.


