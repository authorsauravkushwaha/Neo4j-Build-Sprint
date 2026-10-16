# Deployment

Three free-first targets. Pick one; they are alternatives, not steps.

Everything here assumes you already have the project cloned and `npm ci` has run once.
Nothing in this document was executed for you — see [verification.md](verification.md#6-not-verified--read-this-before-believing-anything-else).

---

## 0. Before any deployment: decide whether you want live mode

| | Demo deployment (5 minutes) | Live deployment (about 40 minutes) |
| --- | --- | --- |
| Needs | a host for static files | Neo4j AuraDB Free + a Supabase project + a host |
| Data | bundled sample dataset, labelled as such | Neo4j knowledge graph, read through Edge Functions |
| Accounts | none (guest mode only) | email-link sign-in |
| Cost | free | free tier of everything, no paid dependency |

A demo deployment is a legitimate outcome: it is the honest way to show the app while you set up the
backend. Both are described below.

### Environment variables (frontend, build-time)

Copy `.env.example` to `.env.local`. Only `VITE_*` values go here, because everything in this file ends up
compiled into the JavaScript bundle.

```bash
# Demo deployment — leave everything empty. That is a valid configuration.
VITE_FORCE_DEMO_MODE=true

# Live deployment
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon/publishable key>
VITE_SITE_URL=https://<your-site-url>       # canonical link and share metadata (optional, recommended)
VITE_BASE_PATH=/                           # "/<repo-name>/" for GitHub Pages project sites
VITE_APP_VERSION=1.0.0
```

Never put the `service_role` key, the Neo4j password, or an AI key in this file. They belong in
`supabase/.env` (server-side) only.

---

## 1. GitHub Pages

A workflow is committed at `.github/workflows/deploy.yml`. It type-checks, tests, builds and publishes
`dist/` to Pages on every push to `main`.

**The URL and the base path are derived from the repository, not configured.** GitHub Pages decides
them for you: a repository named `<owner>.github.io` is served at the domain root, and every other
repository is served from `/<repo-name>/`. The workflow computes both and logs what it chose:

| Repository | Published at | Base path |
| --- | --- | --- |
| `Neo4j-Build-Sprint` | `https://<owner>.github.io/Neo4j-Build-Sprint/` | `/Neo4j-Build-Sprint/` |
| `<owner>.github.io` | `https://<owner>.github.io/` | `/` |

This repository is deployed at **<https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint/>**.

Steps:

1. Push the repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main` (or run the workflow manually from the Actions tab). The workflow prints
   `Publishing <url> with base path <base>` in the *Resolve the Pages target* step — that is the URL
   the site will answer on.
4. Optional, for live mode only — **Settings → Secrets and variables → Actions → New repository
   secret**:

   | Secret | Value |
   | --- | --- |
   | `VITE_SUPABASE_URL` | your project URL |
   | `VITE_SUPABASE_ANON_KEY` | your anon/publishable key |
   | `VITE_SITE_URL` | the public URL, only if it differs from the derived one (a custom domain) |

   A secrets-only deployment is fine: with none of them set the build produces a working demo-mode
   site, which is a legitimate deployment.

Overrides, both optional: repository **variable** `VITE_BASE_PATH` replaces the derived base path
(custom domain in front of the same Pages deployment → `/`), and repository **secret**
`VITE_SITE_URL` replaces the derived canonical URL. For a local build against a project site set the
same values in `.env.local`:

```bash
VITE_BASE_PATH=/Neo4j-Build-Sprint/
```

If you get the base path wrong, the deployed page loads a blank screen with 404s for `/assets/…` in
the console — that is the symptom. The workflow's final *Check the published artifact* step refuses
to accept a deploy with that shape.

### Deep links

GitHub Pages has no rewrite rules, so the workflow's build also writes `404.html` from the app
shell: a shared link to `/careers/backend-engineer` renders the screen it names instead of GitHub's
own 404 page. The status code is still 404 — Pages gives a static host no way to change that — but
the content is the app. Netlify and Cloudflare do the same job with `netlify.toml` /
`public/_headers` redirects and never serve this file.

## 2. Netlify

`netlify.toml` is committed with the build command, the SPA fallback (`/* → /index.html`) and the security
headers (CSP, HSTS, `X-Frame-Options`, Permissions-Policy).

1. Netlify → **Add new site → Import an existing project** → pick the repository.
2. Build command `npm ci && npm run build`, publish directory `dist` (already configured).
3. **Site configuration → Environment variables** → add the same `VITE_*` values as above.
4. Deploy. Add your custom domain under **Domain management** if you have one.

The `_headers` file in `public/` is also committed for hosts that read it (Cloudflare Pages, Surge); it
carries the same policy as `netlify.toml`.

## 3. Cloudflare Pages (alternative)

- Framework preset: **None**. Build command `npm ci && npm run build`. Output directory `dist`.
- Add the `VITE_*` environment variables in the project settings.
- `public/_headers` is picked up by Cloudflare, so the CSP and security headers apply without extra config.

---

## 4. Live backend setup (do this before or after the first deploy)

### 4.1 Neo4j AuraDB Free

1. <https://console.neo4j.io> → **Create instance → Free**. Save the generated password immediately; it is
   shown once.
2. Copy the Query API endpoint from **Connect → Query API**:
   `https://<instance-id>.databases.neo4j.io/db/neo4j/query/v2`
3. From your machine:

   ```bash
   cp supabase/.env.example supabase/.env
   # edit supabase/.env: NEO4J_QUERY_URL, NEO4J_PASSWORD, NEO4J_DATABASE, NEO4J_USERNAME
   npm run seed:neo4j -- --dry-run     # prints 31 statements / 1284 rows, writes nothing
   npm run seed:neo4j                  # idempotent MERGEs — safe to re-run
   ```

   The seeder refuses a plain `http://` URL and refuses a non-Aura host unless you set
   `NEO4J_ALLOW_HTTP=true` for a local server you control.
4. Sanity-check the graph: open Neo4j Browser and run any statement from
   [`neo4j/sample-queries.cypher`](../neo4j/sample-queries.cypher). You should see 444 nodes and 1585
   relationships.

### 4.2 Storage backend: Supabase (default) or Appwrite

The API has one storage contract and two implementations, so this choice does not change any screen, any
handler or any ownership rule. Pick Supabase if you want row-level security enforced *in the database* (the
stronger guarantee — it survives an application bug). Pick Appwrite if your organisation already runs it.
Both are first-class; [docs/appwrite.md](appwrite.md) states exactly what differs, how each gap is covered,
and what has not been exercised (no live Appwrite project has been run against this code yet).

For Appwrite, provision the collections first and then set the secrets:

```bash
npm run appwrite:provision            # review the commands
npm run appwrite:provision -- --run   # create the 8 collections + indexes (no client permissions)
supabase secrets set --env-file supabase/.env   # APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY
```

`health-check` reports which backend is live under `data.storage.backend`, and the sentence it shows a user
is derived from that — not hard-coded to one vendor.

### 4.3 Supabase (accounts, migrations, functions)

1. <https://supabase.com> → new project (free tier is enough). Note the project ref and the anon key.
2. Apply the migrations, in order, with the SQL editor or the CLI:

   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push          # runs 001_graphmentor_core.sql then 002_graphmentor_rate_limit.sql
   ```

   This creates the tables, the RLS policies and the rate-limit buckets. **Verify RLS is on** before you
   give the URL to anyone:

   ```sql
   select tablename, rowsecurity from pg_tables where schemaname = 'public';
   -- every row must show rowsecurity = true
   ```

3. Set the Edge Function secrets and deploy:

   ```bash
   supabase secrets set --env-file supabase/.env
   supabase functions deploy health-check get-careers get-career-details get-career-path \
     get-skill-details get-skills get-graph get-projects get-resources analyze-skill-gaps \
     generate-learning-roadmap mentor-chat save-roadmap update-progress manage-bookmarks \
     manage-account submit-feedback auth-guard
   ```

   `auth-guard` is the pre-flight rate limiter for sign-in attempts. It must be deployed for the sign-in
   ceilings in `supabase/.env` (`AUTH_ATTEMPTS_*`) to apply; without it the app still works and relies on
   Supabase Auth's own rate limiting, which is the backstop rather than the plan.

4. Set `ALLOWED_ORIGINS` in `supabase/.env` to the exact origins that may call the API (your Pages/Netlify
   URL, plus `https://localhost` and `capacitor://localhost` for the Android app). CORS echoes these back and
   never answers with `*`.
5. Configure sign-in under **Authentication**:

   - **URL Configuration** → add your site URL to the redirect allow-list. Password reset and email-link
     sign-in both return to `<site>/login`, and the app rejects nothing that arrives without this.
   - **Providers → Email → Password**: keep it enabled if you want password sign-in; the app shows both
     password and email-link options and neither is promoted over the other.
   - **Email**: set up SMTP if you expect more than the default handful of messages per hour. The free
     default is fine for a class project and will rate-limit a real cohort.
   - **Security → password requirements**: set the minimum length to **10** so Supabase's server-side check
     matches the rule the app shows (`validatePasswordStrength` in `shared/core/security.ts`). Be clear about
     who enforces what: the browser runs that function before submitting, but a password check in a browser
     is a courtesy, not a control — the authoritative gate is Supabase Auth's own configured policy. Set the
     minimum there. Do **not** add a "must contain a symbol" rule: §2 of `docs/security.md` explains why
     composition rules are deliberately absent, and adding one here would contradict the app's own advice.
   - **Security → rate limits**: Supabase's per-hour sign-in caps are the backstop. Leave them generous
     enough that a shared campus network does not lock out a class.
6. Check it end to end:

   ```bash
   curl -s https://<project>.supabase.co/functions/v1/health-check | jq
   ```

   Expect `graph.source: "neo4j-live"`, `graph.reachable: true`, `ai.configured: false`.

   Then check the sign-in guard, which is the one endpoint that must work before anyone is signed in:

   ```bash
   # Allowed, with attempts remaining:
   curl -s -X POST https://<project>.supabase.co/functions/v1/auth-guard \
     -H 'content-type: application/json' \
     -d '{"emailHash":"0123456789abcdef0123456789abcdef"}' | jq

   # Run it 11 times and the eleventh must be 429 with a Retry-After header.
   ```

   If it answers `503 not_configured`, the function is deployed but the rate-limit table is missing — run
   `supabase db push` again.

### 4.4 Optional: AI provider

```bash
# in supabase/.env
AI_PROVIDER=gemini               # or openai-compatible
GEMINI_API_KEY=<free key from https://aistudio.google.com>
AI_TIMEOUT_MS=20000
AI_MAX_OUTPUT_TOKENS=800
AI_MAX_CONTEXT_CHARS=12000
```

Redeploy the `mentor-chat` function after changing secrets. With `AI_PROVIDER=none` nothing is sent
anywhere and the mentor uses the rules engine — the UI states which path answered.

### 4.5 Turn on request signing (optional hardening)

```bash
openssl rand -hex 32            # REQUEST_SIGNING_SECRET
REQUIRE_REQUEST_SIGNING=true
```

Only enable this **after** the client that signs requests is deployed, or `mentor-chat`,
`generate-learning-roadmap` and `save-roadmap` will refuse traffic. The algorithm is documented in
[security.md](security.md#5-replay-and-request-integrity).

---

## 5. Android app and APK

Requires **Android Studio** (or the Android SDK + JDK 17) on your own machine. It cannot be built in a
container without them — see the honest note in [verification.md](verification.md#6-not-verified--read-this-before-believing-anything-else).

```bash
# 1. Point the app at your live backend (a Capacitor build bakes in .env.local like any web build)
#    .env.local: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SITE_URL

# 2. Build and copy the web assets into the Android project
npm run build
npm run cap:add:android      # only the first time; creates android/
npm run cap:sync             # copies dist/ + plugins into android/

# 3. Open in Android Studio and press Run, or build from the CLI:
cd android
./gradlew assembleDebug                    # macOS/Linux
gradlew.bat assembleDebug                  # Windows (PowerShell or cmd)
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Install the debug APK on a device with `adb install -r app-debug.apk` (enable USB debugging first).

For a release APK you must sign it with your own keystore — Android will not install an unsigned release
build:

```bash
keytool -genkey -v -keystore graphmentor.keystore -alias graphmentor \
  -keyalg RSA -keysize 2048 -validity 10000
# then configure signingConfigs in android/app/build.gradle and run:
cd android && ./gradlew assembleRelease
```

Keep the keystore and its passwords out of the repository — `.gitignore` already excludes
`*.keystore` and `*.jks`.

**For a Play Store release** you also need a signed **AAB** (`./gradlew bundleRelease`), a privacy policy
URL, a data-safety declaration (this app collects only what sign-in requires, and nothing is sold), and
screenshots. The Play Console rejects unsigned artifacts.

Capacitor notes for this project specifically:

- `appId: ai.graphmentor.app`, `appName: GraphMentor AI`, `webDir: dist`.
- `androidScheme: 'https'`, so the WebView origin is `https://localhost` — that exact origin must be in
  `ALLOWED_ORIGINS` or the app's API calls will be blocked by CORS.
- External links open in the system browser rather than navigating the WebView.
- No Android runtime permissions are requested (no location, camera, contacts or storage).
- Changing `VITE_*` values requires `npm run build && npx cap sync android` again — the web assets are
  copied, not linked.

---

## 6. Post-deploy checklist

Run through this on the deployed URL. It takes two minutes and catches the failures that actually happen.

- [ ] `https://<site>/` loads and the hero does **not** claim live data.
- [ ] Open Settings → the health block shows the graph source you expect (`neo4j-live` or `local-sample`).
- [ ] `/careers` lists every career; open one and confirm skills, related careers and caveats render.
- [ ] `/graph` with a career selected draws nodes; switch to **List** and confirm the table has rows.
- [ ] `/gaps` produces categories; the "self-rating is unverified" copy is present.
- [ ] `/roadmap` shows week 1 and a Review chip somewhere in the plan.
- [ ] Hard-refresh on a deep link (e.g. `/careers/data-analyst`) — no 404 (SPA fallback works).
- [ ] Install the PWA (address-bar install icon) and confirm the app shell loads with the network off.
- [ ] If live mode: sign in, save a plan, open it from a second browser, and confirm a **different** account
      cannot see it.
- [ ] If live mode: send a bookmark and a progress update, then check the `bookmarks` / `roadmap_tasks`
      tables in Supabase.
- [ ] Confirm no secret appears in `dist/assets/*.js`: `npm run lint:secrets` and a quick grep for your Neo4j
      hostname.

## 7. Rolling back

Deployments are static files plus Edge Functions, so rollback is cheap:

- **Frontend**: re-deploy the previous commit (GitHub Pages: re-run the workflow on the older commit;
  Netlify: "Deploy previous build" from the deploys list).
- **Edge Functions**: `supabase functions deploy <name>` from an older checkout; versions are not kept by
  Supabase, so keep the previous release tag of your repo.
- **Data**: migrations are additive (`create table if not exists`), so an older frontend can run against the
  newer schema. Do not drop columns to roll back — nothing in the app requires destructive migration.


