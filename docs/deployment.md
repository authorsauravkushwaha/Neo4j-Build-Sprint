# Deployment

Use [architecture.md](architecture.md) as the source of truth. The repository contains two supported backend deployment paths and a browser-only demo:

1. **Node backend + Neo4j (intended live path):** deploy the `render.yaml` Blueprint, add Neo4j server-side environment variables, then verify the real service with `node scripts/verify-neo4j.mjs https://ACTUAL-SERVICE-ORIGIN`. Render service creation, credentials, and production connectivity are not confirmed by the presence of this file.
2. **Supabase Edge Functions + Neo4j (alternative):** `.github/workflows/deploy-backend.yml` deploys the shared function handlers using Neo4j's HTTPS Query API. It is a separate supported route, not a dependency of the Render service. Use the Supabase URL plus `/functions/v1` as the frontend API base. Review and configure its required GitHub secrets before running it.
3. **Demo:** publish the Vite build without an API backend; the app uses bundled curriculum and labels it DEMO DATA.

Pick one. Deploying both does not make the frontend work any better — the site has a single API base — and it doubles the places a stale URL can hide.

## The backend URL has one resolver

`scripts/resolve-api-base.ts` decides what the build talks to, and it is the only place that decides:

| Source | What it is | When it wins |
| --- | --- | --- |
| `VITE_API_BASE_URL` | the Actions **variable** (public configuration, not a secret) | always, when it is set |
| `config/production-backend.json` | a committed file in this repository | when the variable is unset |

When both are set they must be **equal**; a disagreement is an error, because a build that silently prefers one of them is how a site ends up pointing at a backend nobody is looking at. The committed file is what makes a build reproducible from the repository alone: the URL that ends up in the published artifact is visible in a pull request.

The rules the resolver enforces — and the workflow checks with the same code — are:

- an absolute `https://` URL in a production build; plain `http://` only for a local host;
- no `localhost` in a production build, unless the operator opts in (see below);
- no credentials in the URL;
- the base must end in `/functions/v1`, the shared function contract. The Node backend serves it too (`server/graphApi.ts` mounts every function route under `/functions/v1/`), so this is not a Supabase-only shape.

One legitimate production shape is a **same-origin** API: one process serves the static site *and* `/functions/v1` (the Render Blueprint, or `npm start` after `npm run build`). In that case set `VITE_API_BASE_URL=/functions/v1` **and** `GM_ALLOW_SAME_ORIGIN_API_BASE=true`. The second variable is never `VITE_*` — it never reaches the browser — and it is the operator saying this host really does serve the function contract. Without it a production build refuses a relative API base, because GitHub Pages cannot.

Check what a build would embed, without building:

```bash
npm run verify:api-config          # human-readable
npm run verify:api-config -- --json
npm run verify:api-config -- --check    # exit 1 when the configuration is invalid
```

## Render / Node backend

`render.yaml` uses `npm ci --include=dev && npm run build`, starts with `npm start`, and relies on `server/website.ts` binding to `0.0.0.0:$PORT`. It exposes `/api/health` as the service liveness check. Configure `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` in the Render dashboard; keep the password server-side. Set `ALLOWED_ORIGINS` to include the browser origin `https://authorsauravkushwaha.github.io` (an origin has no `/Neo4j-Build-Sprint/` suffix). No Render service URL is asserted here.

The backend starts without Neo4j. Liveness and graph readiness are different things, and the API says so: `/api/health` reports that the service is up, while `/api/health/neo4j` and the graph endpoints report that Neo4j is not configured or not reachable.

## GitHub Pages frontend

The Pages workflow computes the repository-specific base path. For this repository, it remains `/Neo4j-Build-Sprint/`. The API base comes from the resolver above, so there are two ways to set it, and they must agree:

- the Actions repository **variable** `VITE_API_BASE_URL`, or
- `config/production-backend.json`.

The value is the real backend origin plus `/functions/v1`, such as `https://<actual-render-host>/functions/v1`. This is public, build-time configuration. It is not a credential.

Then trigger a new `Build and deploy` workflow run; an already-published artifact will not change just because a variable changed.

Never set a Neo4j password or other private credential in any `VITE_*` variable. Without an API base, a Pages build remains a usable demo deployment that labels itself DEMO DATA.

The build embeds the API base in two places, and both have to be right:

- the client configuration (`import.meta.env.VITE_API_BASE_URL`), and
- the `connect-src` of the Content-Security-Policy.

The CSP entry is the API base's **origin**, not the whole URL. A CSP source that carries a path matches only that exact path, so `connect-src https://api.example.com/functions/v1` would have blocked every real request to `https://api.example.com/functions/v1/health-check` — the browser would have refused the whole API while the build stayed green.

The policy is written in two places a browser can see: the `<meta>` tag in `index.html` (generated at build time) and `dist/_headers` (the file a static host such as Netlify sends as a real header). Browsers enforce the *intersection* of every policy they are given, so those two copies have to list the same hosts. The build rewrites `dist/_headers` from the same allow-list it injects into the meta tag; CI fails if they disagree. `scripts/verify-frontend-backend.mjs` (`npm run verify:frontend-backend`) opens the built site in a real browser and fails when the browser still cannot reach the API.

## Environment naming

- Node/Bolt: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, optional `NEO4J_DATABASE`.
- Supabase/Deno HTTPS Query API alternative: `NEO4J_QUERY_URL`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` as function secrets.
- Browser API URL: build-time `VITE_API_BASE_URL` only.

## Local preview against a real backend

To see the built site talk to a backend on this machine:

```bash
# 1. the site, built so it talks to the same origin that will serve it
GM_ALLOW_SAME_ORIGIN_API_BASE=true VITE_API_BASE_URL=/functions/v1 npm run build

# 2. one process serves the site, the account API, and the graph API
GM_GRAPH_DATABASE_DIR=/tmp/gm-graph-pg npm start

# 3. the contract check (PASS only when Neo4j answered; BLOCKED for Postgres or no graph)
npm run verify:neo4j -- http://127.0.0.1:3000

# 4. the browser check (needs Chromium)
CHROMIUM_PATH=/path/to/chromium npm run verify:frontend-backend -- http://127.0.0.1:3000 http://127.0.0.1:3000
```

For a *cross-origin* preview (Vite on :4173, backend on :3000) build with
`GM_ALLOW_SAME_ORIGIN_API_BASE=true VITE_API_BASE_URL=http://127.0.0.1:3000/functions/v1`
and set `ALLOWED_ORIGINS=http://127.0.0.1:4173` on the backend.

The check reports the requests the browser really made, the source each response carried, and the banner the user sees. It fails when the browser could not reach the API, when the page produced JavaScript errors, or when the banner disagrees with the observed source.

## Verifying a deployment

1. `node scripts/verify-neo4j.mjs https://ACTUAL-BACKEND-ORIGIN` — PASS only when a real Cypher query ran. Exit codes: `0` PASS, `1` FAIL, `2` BLOCKED.
2. `node scripts/verify-frontend-backend.mjs https://THE-PUBLIC-SITE` — the browser path from the published site to the backend.
3. The `Verify Neo4j (live)` workflow runs the first of these inside GitHub Actions with the repository's server-side credentials and publishes the verdict on the pull request.

More details: [architecture.md](architecture.md), [graph-database.md](graph-database.md), [verification-neo4j.md](verification-neo4j.md).
