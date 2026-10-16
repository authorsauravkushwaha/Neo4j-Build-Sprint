# GraphMentor AI — The Engineering Career Navigator

A career navigator for engineering students and early-career engineers, built on a **knowledge graph**
instead of a course list. It answers questions like *"what do I actually need to learn for this role,
in what order, and what is genuinely free?"* — and it shows the graph edges behind every claim it makes.

**One codebase, four ways to run it:** responsive website · installable PWA · Android app (Capacitor) ·
APK (built on your machine — see [docs/deployment.md](docs/deployment.md)).

> **It works with nothing configured.** No Neo4j account, no Supabase project, no AI key: the app starts
> in a clearly-labelled **local sample mode** using the bundled dataset (`src/data/seed/knowledgeGraph.ts`).
> Every screen works, and every screenshot-visible claim says "bundled sample dataset" rather than
> pretending to be live. Add credentials later and the same UI switches to live graph data.

---

## Contents

1. [What it does](#what-it-does)
2. [Who it is for](#who-it-is-for)
3. [What it deliberately does not do](#what-it-deliberately-does-not-do)
4. [Quick start (works with zero configuration)](#quick-start-works-with-zero-configuration)
5. [Windows: the short version](#windows-the-short-version)
6. [Commands you will actually use](#commands-you-will-actually-use)
7. [Going live: Neo4j + Supabase](#going-live-neo4j--supabase)
8. [Accounts and sign-in](#accounts-and-sign-in)
9. [Deploying](#deploying)
10. [Android app and APK](#android-app-and-apk)
11. [Project layout](#project-layout)
12. [Tests and verification](#tests-and-verification)
13. [Security and privacy](#security-and-privacy)
14. [Troubleshooting](#troubleshooting)

---

## What it does

| Screen | Route | What it gives you |
| --- | --- | --- |
| Landing | `/` | What the app is, what it needs, and an honest list of limits. |
| Onboarding | `/onboarding` | Skippable. Guest mode works without an account. |
| Dashboard | `/dashboard` | Your current plan, next actions, and what is missing. |
| Career explorer | `/careers`, `/careers/:id` | 17 curated engineering careers with skills, roles and caveats. |
| Knowledge graph | `/graph` | The signature feature: zoom/pan canvas, filters, prerequisite and downstream highlighting, path tracing between two nodes, a **3D view** of the same subgraph (drag to orbit, click to select) and a **list view with the same data** for keyboard and screen-reader users. |
| Accounts | `/login`, `/account` | Optional. Password or emailed link, rate-limited sign-in, and "sign out everywhere". |
| Pathway builder | `/pathway` | The route from where you are to a role, in dependency order, split into essentials and optional breadth. |
| Skill-gap analyzer | `/gaps` | Which prerequisites are actually missing, which are optional, and roughly how much study time remains. Leads with the delta view: what you can start today, what gates the rest, and the one chain that cannot be parallelised. |
| Roadmap | `/roadmap` | A week-by-week plan sized to the hours you really have, with spaced review rows and progress you control. |
| Projects | `/projects` | 33 projects with deliverable lists and **safety notes** (mains voltage, soldering, machines, cloud cost). |
| Resources | `/resources` | 154 free and free-to-audit resources. Every one states what you can do afterwards, what it assumes (with the prerequisites linked to the skill pages), where it stops, an hour estimate for the effort involved, what "free" means for that provider, and the date the link was last checked. Every skill in the graph is reachable from at least two of them. |
| Mentor | `/mentor` | Graph-grounded Q&A with citations. Works with **no AI key** — a deterministic rules engine over the same context answers, and the UI says which one replied. Every answer carries a **read ledger**: the graph queries behind it, with row counts and timings. |
| Progress | `/progress` | What you have done, without streaks, points or invented motivation mechanics. |
| Settings | `/settings` | Accessibility, theme, data export, account deletion, feedback. |
| Public APIs | `/public-apis` | 259 endpoints imported from the public-apis directory, each linked to the skills it exercises, with a "needs no key" filter and the catalogue's five caveats above the results instead of in a footnote. A filtered view is a link. |
| Anywhere | Cmd/Ctrl+K | Command palette: every page, career, skill, concept, project and resource in one search, offline, with keyboard navigation and focus that returns where it was. The library's search also lives in the URL (`/resources?q=docker`), so a filtered view is a link. |

**Presentation:** the interface is built on a neumorphic system (`src/styles/index.css`): one opaque
material shared by the page, cards, chips and the app bar, soft shadow pairs (light up-left, shade
down-right), inset form fields, and a pressed state that casts that pair inwards. No surface uses a
backdrop blur. Two 3D scenes render with three.js
(`src/components/three/Scene3D.tsx`): a hero composition on the landing page and a physics-laid-out 3D
view of the graph. Both degrade to a static CSS/SVG fallback when WebGL is unavailable or the visitor has
reduced motion enabled, and neither is required to use the app.

**Scroll, across the whole app and not only the landing page** (`src/skiper/`, documented in
`docs/skiper-ui.md`): the app bar condenses once it is no longer the top of the page, every route enters
with the same short rise, content lists arrive in order (one CSS rule per position — no per-row
JavaScript, no extra wrapper elements), a roadmap's week heading pins while its own week scrolls past, and
a hairline rail plus a back-to-top control make a long page navigable. Every effect is switched off — not
shortened — by reduced motion, the back-to-top control excepted, because a control is not decoration.
Filters, forms and the mentor transcript deliberately do not animate.

**Graph model:** `(A)-[:REQUIRES]->(B)` means *A needs B first*. Careers, branches, subjects, concepts,
skills, languages, tools, projects, resources, learning modules and assessments are nodes; 15 relationship
types connect them. The dataset has **444 nodes and 1,585 relationships**.

**Recommendation engine** (`supabase/functions/_shared/core/recommend.ts`) is deterministic and
independent of any AI: transparent weights (goal relevance 0.35, prerequisite centrality 0.25, gap 0.20,
interest fit 0.10, minus an effort penalty of 0.20), dependency-respecting scheduling, and a documented
explanation for every ordering decision. AI, when configured, only rephrases what the graph says.

## Who it is for

Two people, one engine, one screen. Both start on the skill-gap analyzer at `/gaps`;
the only difference is whether you leave the ratings empty or fill them in.

**You have not studied any of this yet.** You get one short list of skills that
nothing else depends on — the ones you can genuinely start today — the single chain
that has to be done in order, and the whole route expressed as a range of weeks at
the pace you set. Not a catalogue of a hundred courses ranked by nothing. It works
with no account, no network and no AI key, because the curriculum is bundled and the
analysis runs in your browser.

**You already work in the field.** Rate what you know and the same page returns your
delta rather than a curriculum: what is still missing, which of those skills gate the
rest (and how much of the route each one unblocks, counted once and never added up
twice), and the longest prerequisite chain that extra hours cannot shorten. The
prerequisites the career's own list never mentions are called out separately — that
is usually where experienced people find the hole they did not know they had. Rate
everything and the panel says the route is finished and stops inventing work.

**Why it earns the time.** It is not a course catalogue and not a chatbot: every
number is a computation over the prerequisite graph that ships with the app, the
same graph is re-derived independently in Java by `npm run oracle`, and where it
cannot know something it says so — self-ratings are not verified, hours are planning
ranges, and every screen states its own limits. The mechanics, the evidence and the
honest boundaries are written down in [docs/frontier.md](docs/frontier.md).

**How that answer was tested rather than asserted.** Fourteen modelled personas — a
school student on a phone, a teacher retraining, an architect, a bootcamp instructor —
walk a seven-stage funnel against a measurement of this build, and the study names
where each one leaves and which measured fact made them leave:
[docs/audience-simulation.md](docs/audience-simulation.md). It is a model, not user
research, and it says so in its own caveats. What was done about each finding, and what
is still open, is in [docs/audience-actions.md](docs/audience-actions.md).

## What it deliberately does not do

- **No job, salary or placement guarantees.** The app plans study order; it does not promise outcomes.
- **No fabricated social proof.** No invented user counts, testimonials, ratings or success statistics.
- **No invented prices, quotas or links.** Every resource is a real free offering with an access note
  and a link-check date; the dataset is validated by `npm run validate:seed`.
- **No AI-only answers.** With no key configured, the mentor still answers from the graph and says so.
- **No silently-live claims.** If the graph is unreachable, the UI says the graph is unreachable instead
  of quietly serving sample data as if it were live.
- **No dark patterns.** No streaks that punish you, no locked features behind an account, no upsell.

Full feature and limitation lists: [docs/features-and-limitations.md](docs/features-and-limitations.md).

---

## Quick start (works with zero configuration)

You need **Node.js 20 or newer** (built and tested on Node 20.20.2) and npm.

```bash
git clone <your-fork-or-this-repo-url> graphmentor-ai
cd graphmentor-ai
npm ci          # exact versions from package-lock.json
npm run dev     # http://localhost:5173
```

That is the whole setup. With no `.env.local`, the app runs in local sample mode and every screen works.

To see it as a production build (this is also what the PWA service worker needs):

```bash
npm run build
npm run preview   # http://localhost:4173
```

Stop either server with `Ctrl+C` in the terminal that is running it.

## Windows: the short version

You can use either **Git Bash** (recommended, the commands above work as written) or **PowerShell**.

1. Install Node.js from <https://nodejs.org> — pick the **LTS** installer (`.msi`). Accept the defaults
   and let it add Node to `PATH`.
2. Open **Git Bash** (installed with [Git for Windows](https://git-scm.com/download/win)) or PowerShell.
3. Check it worked:

   ```bash
   node --version    # v20.x or newer
   npm --version
   ```

4. Put the project somewhere **without spaces in the path** — `C:\dev\graphmentor-ai` is fine,
   `C:\Users\Your Name\My Projects\...` causes avoidable trouble with some tools.
5. Then follow the Quick start commands above.

Notes for Windows users:

- If PowerShell refuses to run anything with *"running scripts is disabled on this system"*, you are not
  running a Node command — you are running a `.ps1` shim. Use Git Bash, or run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (this allows locally written scripts).
- `npm run dev` prints a URL. Hold **Ctrl** and click it, or type `http://localhost:5173` into your browser.
- To stop a running server, click the terminal and press `Ctrl+C`, then `Y` if it asks.
- Line endings: the repo is configured for LF. If Git asks, keep the default (`core.autocrlf` handled by
  `.gitattributes`-free defaults is fine for this project).

## Commands you will actually use

| Command | What it does | Needs network/credentials? |
| --- | --- | --- |
| `npm run dev` | Development server with hot reload. | No |
| `npm run build` | Type-check (`tsc -b`) then production build + PWA service worker into `dist/`. | No |
| `npm run preview` | Serve the built app locally. | No |
| `npm run typecheck` | TypeScript only. | No |
| `npm test` | Unit + integration tests (Vitest, node + jsdom projects). | No |
| `npm run test:coverage` | Same, with coverage. | No |
| `npm run lint:secrets` | Scans the repo for credential-shaped strings. Fails the build if any appear. | No |
| `npm run validate:seed` | 57 checks over the dataset, the engine and the generated Cypher. | No |
| `npm run verify` | The whole evidence chain in one command: types, tests, dataset, Cypher, secrets, audit, build, the Java oracle, and the local browser/database harnesses. Add `--with-infra` to make a skipped local step fatal, or `--list` to see the plan first. | No |
| `npm run oracle` | Exports the frontier fixture, compiles `tools/oracle/FrontierOracle.java` with `javac`, recomputes every number in Java and diffs it against the TypeScript engine — then corrupts one character to prove the diff can fail. Needs a JDK 11+. | No |
| `npm run emit:cypher` | Regenerates `neo4j/schema.cypher` + `neo4j/seed.cypher` from the dataset. | No |
| `npm run emit:cypher -- --check` | Fails if the committed Cypher is stale. | No |
| `npm run verify:resources` | Opens every resource link and writes what it found to `docs/resource-verification.md`. | Yes (internet) |
| `npm run verify:rls` | Applies the migrations to a local PostgreSQL and runs the isolation/attack matrix (42 checks). Needs `DATABASE_URL`. | No (local DB) |
| `npm run db:provision` | Creates (or re-applies) this project's own hardened PostgreSQL 17 cluster: loopback-only, TLS with client certificates, least-privilege roles, FORCE RLS. Secrets live outside the repo in `/srv/graphmentor-pg`. | No (local DB) |
| `npm run verify:db` | Hardening assertions plus a live attack battery against that cluster (71 checks; `-- --with-backup` also proves a dump restores). Writes `docs/database-verification.json`. | No (local DB) |
| `npm run smoke:http` | Serves the Edge Function request pipeline on a real port and asserts the auth path over HTTP (30 checks; add `DATABASE_URL=…` to run the limiter against Postgres). | No (local) |
| `npm run appwrite:provision` | Prints the Appwrite collections and indexes this API needs (`--json` for a pipeline, `--run` to execute). Derived from the same schema module the adapter reads, so the two cannot drift. | No |
| `npm run verify:browser` | Drives the built app in headless Chromium: WebGL scenes, the neumorphic material, mobile layout, reduced motion, the command palette, the delta view and the enforced CSP. The script prints its own total — 112 in the last full run, 114 with `CHECK_OFFLINE=1`. Needs a running preview of `dist/` — pass `BASE_URL=http://127.0.0.1:4173`. | No (local) |
| `npm run seed:neo4j -- --dry-run` | Prints the statements it would send. | No |
| `npm run seed:neo4j` | Loads the graph into Neo4j (needs credentials). | Yes |
| `npm run cap:sync`, `cap:open`, `cap:add:android` | Capacitor helpers — see [Android](#android-app-and-apk). | Yes (Android SDK) |

## Going live: Neo4j + Supabase

Everything below is optional. Nothing in the app requires it to run.

### 1. Neo4j AuraDB Free (graph)

1. Create a free instance at <https://console.neo4j.io>. Free instances are enough for this dataset.
2. In the console: **Connect → Query API** and copy the URL — it looks like
   `https://<instance-id>.databases.neo4j.io/db/neo4j/query/v2`. The password is shown once at creation.
3. Load the schema and the seed data (this runs from your machine, not the browser):

   ```bash
   cp supabase/.env.example supabase/.env      # then edit it
   npm run emit:cypher                         # regenerate artefacts if you edited the dataset
   npm run seed:neo4j -- --dry-run             # show the statements (31 batched MERGEs)
   npm run seed:neo4j                          # idempotent: safe to run twice
   ```

   The seeder refuses `http://` URLs and refuses to run against a non-Aura host unless you explicitly
   set `NEO4J_ALLOW_HTTP=true` for a local server you control.

4. The same `.env` values become Edge Function secrets in the next step. **They never go in the frontend
   `.env` file** — the browser never talks to Neo4j directly.

### 2. Supabase (accounts, policies, API)

1. Create a project at <https://supabase.com>. Free tier is sufficient.
2. Apply the migrations in `supabase/migrations/` (`001_graphmentor_core.sql`, then
   `002_graphmentor_rate_limit.sql`) with the SQL editor, or with the CLI:

   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   They create the tables, the row-level-security policies and the rate-limit buckets. Every table is
   `user_id`-scoped and every policy says `auth.uid() = user_id`: private data is not readable by other
   users even with a valid token.
3. Set the Edge Function secrets and deploy the functions:

   ```bash
   supabase secrets set --env-file supabase/.env
   supabase functions deploy health-check get-careers get-career-details get-career-path \
     get-skill-details get-skills get-graph get-projects get-resources analyze-skill-gaps \
     generate-learning-roadmap mentor-chat save-roadmap update-progress manage-bookmarks \
     manage-account submit-feedback
   ```

   All of them are thin shims over `supabase/functions/_shared/handlers/` so the same code is unit-tested
   in Node.
4. Deploy the sign-in guard as well (`supabase functions deploy auth-guard`) — it is the rate limiter that
   runs before the browser talks to Supabase Auth. Without it, sign-in still works and relies on Supabase's
   own limits; see [Accounts and sign-in](#accounts-and-sign-in).
5. Point the frontend at it — copy `.env.example` to `.env.local` and fill in:

   ```bash
   VITE_SUPABASE_URL=https://<your-project>.supabase.co
   VITE_SUPABASE_ANON_KEY=<your anon/publishable key>
   VITE_SITE_URL=https://<your-site-url>        # canonical link + share metadata
   ```

   The **anon** key is safe in a browser only because RLS protects every table. The `service_role` key
   belongs in `supabase/.env` (server-side) and nowhere else. `npm run lint:secrets` fails the build if a
   key-shaped string is ever committed.

### 3. Optional: run the same API on Appwrite instead

The storage layer has two implementations behind one contract, so the Edge Functions, the ownership rules
and every handler are identical on either. To switch:

```bash
npm run appwrite:provision -- --run   # creates the 8 collections + indexes (no client permissions)
```

then set `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` and `APPWRITE_API_KEY` as function secrets. A
partially filled Appwrite block is **not** a fallback to Supabase — the deployment goes read-only and
`health-check` names the missing variables. What genuinely differs (no row-level security to fall back on,
session secrets instead of JWTs, no stored procedures, one request per document write) and how each gap is
covered is in [docs/appwrite.md](docs/appwrite.md), including the part that has *not* been exercised: no
live Appwrite project has been run against this code.

### 4. Optional: an AI provider for the mentor

With `AI_PROVIDER=none` the mentor answers from a deterministic rules engine and the UI shows
*"no language model was called"*. To let a model rephrase those answers (it still only sees graph context,
never your identity), set in `supabase/.env`:

```bash
AI_PROVIDER=gemini            # or: openai-compatible (Groq, OpenRouter, a local llama.cpp server)
GEMINI_API_KEY=<your key>     # free tier available at https://aistudio.google.com
```

The answer is always assembled from graph facts first; the model cannot invent a skill that is not in the
graph, and every answer shows which skills, projects and resources it used.

---

## Accounts and sign-in

Accounts are **optional**, and guest mode is the default: nothing in this app is behind a login. What an
account adds is that your roadmap, ratings, progress and bookmarks live on the server instead of only in
this browser.

Three ways in, all handled by Supabase Auth:

| Route | What happens |
| --- | --- |
| `/login` | Password sign-in, create account, or email a single-use sign-in link. |
| `/reset-password` | Where an emailed reset link lands. It explains itself when the link is stale or reused. |
| `/account` | Signed-in view: session facts, change password, **sign out everywhere**. |

Design decisions you can check in the code (`src/core/auth.ts`, `docs/security.md`):

- **The password rule is one function, used twice.** `validatePasswordStrength()` in
  `supabase/functions/_shared/core/security.ts` is imported by the browser, so the checklist you see is the
  rule that runs. `tests/unit/auth.test.ts` compares the two entry points and fails if they ever diverge.
- **Attempts are rate limited before they reach the identity provider** by `POST /auth-guard`. The address
  is hashed with SHA-256 in the browser first, so the counter can count without being able to read it.
- **No enumeration.** Sign-in failures, reset requests and registration conflicts are worded so that they
  never reveal whether an address has an account here.
- **Sign out everywhere** calls `signOut({ scope: 'global' })`, which revokes every refresh token for the
  account — the button to press after losing a device.
- **Deleting account data deletes rows, not the login.** Removing an auth user needs the `service_role`
  key, which never goes near a browser. The UI says exactly that.

To turn accounts on, follow [Going live](#going-live-neo4j--supabase) and remember to deploy the
`auth-guard` function — without it, sign-in still works but the app has no ceiling of its own.

## Deploying

The frontend is static files; the API is Supabase Edge Functions. Typical free-first options:

- **GitHub Pages** — push to `main`, the workflow in `.github/workflows/deploy.yml` builds and publishes
  `dist/`. The base path and the site URL are derived from the repository (`/<repo-name>/` for project
  sites, `/` for a `<owner>.github.io` repository), so there is nothing to remember to set: this
  repository is deployed at <https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint/>. Deep links
  work through a generated `404.html`, and a manually dispatched run can publish a branch before it is
  merged.
- **Netlify** — `netlify.toml` is committed (build command, SPA fallback, security headers). Connect the
  repo and it works as-is.

Step-by-step instructions, including the GitHub secrets to add, are in
[docs/deployment.md](docs/deployment.md).

## Android app and APK

The Android app is the same `dist/` build inside a hardened Capacitor WebView (`appId:
ai.graphmentor.app`). It is not a second codebase and it holds no secrets.

```bash
npm run build
npm run cap:add:android    # creates android/ (once) — needs Android Studio or the Android SDK
npm run cap:sync
npm run cap:open           # Android Studio -> Run
```

To produce an installable APK:

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
# output: android/app/build/outputs/apk/debug/app-debug.apk
```

> **Honest status:** no APK is committed to this repository and none was built in the environment this
> project was assembled in — that machine has no Android SDK or JDK 17, so `gradlew` could not run. The
> Capacitor configuration, web assets and icon set are in place; the commands above are the real path to
> an APK, and they are the same commands the deployment doc lists. The web app behind it has since been
> rendered and checked in a real browser engine (see [docs/verification.md](docs/verification.md) §5);
> the APK itself is still unbuilt and unverified.

## Project layout

```
graphmentor-ai/
├─ src/                          # the web app (React 19 + TypeScript + Vite + Tailwind 4)
│  ├─ app/                       # routing, layout, error boundary
│  ├─ components/ui.tsx          # buttons, cards, fields, callouts — the shared primitives
│  ├─ core/                      # env, api client (live + demo), session, persistence, supabase, format
│  ├─ data/seed/                 # the curated dataset + link-check results
│  ├─ features/                  # one folder per screen (graph, careers, roadmap, gaps, mentor, …)
│  └─ state/store.ts             # zustand store: profile, ratings, progress, bookmarks, toasts
├─ supabase/
│  ├─ functions/_shared/core/    # the engine: recommend, validate, security, rateLimit, assessment…
│  ├─ functions/_shared/handlers/# one handler per endpoint (unit-tested without a server)
│  ├─ functions/_shared/platform/# storage seam: Supabase store, Appwrite client, Deno adapter
│  ├─ functions/<name>/index.ts  # 18 deployed shims — no logic, just wiring
│  ├─ migrations/                # 001 core schema + RLS, 002 rate limiting
│  └─ .env.example               # every server secret, documented
├─ neo4j/                        # schema.cypher, seed.cypher, seed.parameters.json, sample-queries.cypher
├─ scripts/                      # emit-cypher, validate-seed, seed-neo4j, verify-resources, icons, secret scan
├─ tests/                        # unit/ (engine, security, validation) + integration/ (handlers, pages)
├─ docs/                         # verification results, deployment, security, demo script, limitations
└─ public/                       # favicon, icons, offline page, _headers
```

**Data flow:** the browser only ever calls the Edge Functions (Supabase-hosted, or any Deno/Node host that
mounts the same handlers). They hold the Neo4j credentials and run parameterized Cypher through the HTTPS
Query API, and they hold the only credential that reaches the account database — on Supabase that is the
service-role key, on Appwrite the server API key. See [docs/appwrite.md](docs/appwrite.md).

The browser can also run the same engine locally over the bundled dataset (demo mode) — the two paths share
one interface (`GraphMentorClient`), so a screen cannot behave differently in the two modes by accident.

## Tests and verification

```bash
npm test                     # 639 tests in 44 files
npm run typecheck            # no TypeScript errors
npm run lint:secrets         # no credential-shaped strings
npm run validate:seed        # 53/53 dataset, engine and Cypher checks
npm run emit:cypher -- --check
npm run build                # production build + service worker

# The two checks that need a browser and a running preview server:
BASE_URL=http://127.0.0.1:4173 npm run verify:browser      # 112/112 — 3D, neumorphism, CSP, links, motion
BASE_URL=http://127.0.0.1:4173 npm run verify:injection    # 10/10 — hostile payloads, typed in and submitted
npm run verify -- --with-infra   # everything above in one chain, naming any step it had to skip
```

What each suite covers:

- `tests/unit/security.test.ts` — template-injection detection, redundant-path ReDoS guard, URL validation,
  password-length policy, prompt-injection screening, secret redaction.
- `tests/unit/recommend.test.ts` — gap analysis, dependency-respecting ordering, scheduler invariants,
  determinism, review spacing, project/resource ranking.
- `tests/unit/frontier.test.ts` — the delta engine: what is startable, the met-threshold behaviour, gate
  counting as a union rather than a sum, the critical chain being a real prerequisite path, cycle handling,
  byte-for-byte determinism, and the property that more knowledge never increases the work left — checked
  across all 17 careers.
- `tests/unit/validate.test.ts`, `assessmentCodec.test.ts`, `rateLimit.test.ts` — input validation,
  assessment encoding, rate-limit window behaviour.
- `tests/unit/cors.test.ts` — the CORS decision table: an unlisted origin is refused, a wildcard is never
  answered with `allow-credentials`, and a wildcard-subdomain pattern does not match an apex domain.
- `scripts/verify-injection.ts` — the same hostile inputs, but typed into the shipped product in a real
  browser: nine payload classes plus the guest-mode claim, with execution flags, trapped dialogs, a
  MutationObserver and text echoes as evidence.
- `tests/unit/persistence.test.ts`, `resources.test.ts` — local storage readers (including hostile input)
  and resource honesty (no "verified" without a real check date).
- `tests/unit/docs.test.ts` — every documentation path referenced from the source resolves to a real file,
  so code comments cannot point at evidence that does not exist.
- `tests/unit/auth.test.ts` — password policy parity with the server function, byte-vs-character counting,
  error wording that does not reveal whether an address is registered, session facts that never include a
  token.
- `tests/integration/authGuard.test.ts` — the sign-in guard: ceilings per address and per host, identical
  answers for registered and unregistered addresses, strict body validation, and fail-open behaviour that
  does not leak why.
- `tests/integration/handlers.test.ts` — every endpoint through the real handler stack: auth, ownership,
  validation errors, rate limits, error hygiene (no SQL, no stack traces, no internals).
- `tests/integration/pages.test.tsx` — real screens in jsdom: graph canvas plus its accessible list view,
  roadmap progress round-trip, gap analyzer, and checks that the app contains no invented social proof.
- `tests/integration/authPages.test.tsx` — account screens tell the truth: with no backend configured there
  is no password form at all, guest mode is still offered, and a stale reset link is not a dead end.
- `tests/integration/landing.test.tsx` — the landing page's claims: the 3D hero is labelled a fixed
  composition, there is no fabricated social proof, and the security bullets match implemented controls.
- `tests/integration/writes.test.ts` — the write endpoints through both clients, including that demo mode
  never claims data was sent anywhere.

Measured results for this build are in [docs/verification.md](docs/verification.md) — including the three
runs that go past jsdom and into real infrastructure, all of them local:

- **`npm run verify:rls` — 42/42** against PostgreSQL 17 with the shipped migrations applied unmodified:
  thirteen intruder attacks refused, 64 concurrent limiter increments counted as exactly 64, a nonce
  refused on replay, and cascading deletes leaving zero orphans.
- **`npm run smoke:http` — 30/30** over a real socket, with the limiter backed by that database: 429 with
  `retry-after` once attempts run out, byte-identical answers for two different addresses (no account
  enumeration), CORS scoped to the allow-list, method rejections, and error bodies carrying no stack or SQL.
- **`npm run oracle`** — 39 cases and 507 canonical lines recomputed in Java and identical to the
  TypeScript engine, with a self-test proving the diff detects an injected error. The division of labour is
  explicit: algorithms are independently implemented, tuning constants are declared by the fixture and
  pinned by unit tests.
- **`npm run verify:browser` — 112/112** in headless Chromium with WebGL 2.0: the hero scene and the 3D graph
  reach `running` and actually draw, dragging rotates them, the hero copy is painted above the scene and
  stays legible, the neumorphic material is checked in rendered pixels as well as computed styles (a card
  and the app bar paint the page colour, shadows come in light/shade pairs, fields are pressed in, a held
  button inverts its shadow, no surface carries a backdrop blur), Cmd/Ctrl+K opens the command palette and
  Enter opens the highlighted result, the 360 px layouts do not overflow, reduced
  motion mounts no canvas, the console stays clean, the resource library renders all 154 entries with their
  outcomes, linked prerequisites, limits, hour estimates and time, the delta view on the gap page keeps its
  own three renderings of the numbers in agreement and follows its suggestions to real skill pages, and the
  service worker serves the shell offline.

What is still **not** verified is anything that needs a deployment: live Neo4j reads, the Supabase-hosted
backend and GoTrue (password sign-in, sign-in links, **email delivery**), AI provider calls, and the Android
APK. §5 of that document lists each one with the command that would close it.

## Security and privacy

Defended against, with code and tests, not just intentions: **server-side template injection**,
**ReDoS**, **long-password DoS**, **secret leakage**, **SQL/NoSQL/Cypher injection**, **clipboard
attacks**, **replay attacks**, **rate limiting**, **input validation**, **authorization (not just
authentication)**, **secrets management**, **error-handling information leakage** and **file-upload
surface** (there is none: the app has no upload endpoint).

[docs/security.md](docs/security.md) §13 maps each of those to its control, its file and the test that
proves it, and §14 lists what is *not* defended — including that this code has never had an external
review or penetration test.

Privacy posture, in short:

- Guest mode is complete: no account is needed for any feature, and an account never silently uploads
  local data.
- localStorage holds preferences, self-reported skill states, roadmap progress, bookmarks and (in demo
  mode) feedback drafts. **Never** tokens, passwords or chat transcripts.
- Server-side data is RLS-scoped to `auth.uid()`. Private responses are `no-store`.
- You can export your data and delete it yourself, from Settings, at any time. There is no telemetry and
  no third-party analytics in the code.
- The templates to publish your own privacy policy and terms are in
  [docs/privacy-and-terms.md](docs/privacy-and-terms.md), and the in-app pages (`/privacy`) mirror them.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm ci` fails with `EBADENGINE` | Node is too old. Install Node 20 LTS or newer. |
| `npm run dev` starts but the page is blank | Open the browser console. If a chunk failed to load after an update, hard-reload (`Ctrl+Shift+R`). |
| The app says "local sample dataset" and you expected live data | No `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (or `VITE_FORCE_DEMO_MODE=true`). Check `/health-check` in the deployed functions for the server-side reason. |
| Mentor answers say "no language model was called" | `AI_PROVIDER=none`. That is the default and everything still works; set a provider to change the wording, not the facts. |
| `npm run verify:resources` reports `blocked` | A provider refused the automated checker (common: Cloudflare-protected sites). Open the link in a browser to confirm; the dataset keeps saying "not re-checked" until a check actually succeeds. |
| `npm run seed:neo4j` refuses to run | It checks for an `https://` Aura URL and a password first. Read the error: it names the missing value. |
| `npm run build` fails with `EISDIR` | A `href="./"` crept into `index.html`. Vite 7 resolves directory links during build; the canonical tag must use an absolute URL. |
| Port already in use | `npm run dev -- --port 5174`, or find and stop the other process. |
| `Blocked request. This host is not allowed` | Vite's DNS-rebinding guard. Add the hostname to `DEV_ALLOWED_HOSTS` in `.env.local` (comma separated). `localhost` and the common tunnelled preview domains already work. |
| Windows: `'tsx' is not recognized` | Run the npm script (`npm run emit:cypher`), not the bare binary — npm puts `node_modules/.bin` on the path for its own scripts. |

---

## Licence and credits

The dataset links to third-party courses and documentation; those remain under their own licences and
terms, listed per resource in the app. The curriculum structure, engine and UI in this repository are
yours to adapt under the MIT licence in [`LICENSE`](./LICENSE) (review it if you want something else —
it is a permissive default, not a legal decision made for you).

Nothing in this project is affiliated with the providers it links to.

Work on the repository: [`CONTRIBUTING.md`](./CONTRIBUTING.md) ·
[`SECURITY.md`](./SECURITY.md) · [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) ·
[`CHANGELOG.md`](./CHANGELOG.md). The candid list of reasons somebody might not use this — and what
happened to each — is [`docs/objections.md`](./docs/objections.md); accessibility facts and known
exceptions are in [`docs/accessibility.md`](./docs/accessibility.md).

Six repositories were named as references when this was built — Supabase, n8n, public-apis, Appwrite,
MiroFish and PentAGI. What was taken from each, what was refused, and why, is
[`docs/prior-art.md`](./docs/prior-art.md): a table of mechanisms with the file they live in, not a list of
thank-yous.


