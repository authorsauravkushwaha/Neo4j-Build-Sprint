# Deployment

Use [architecture.md](architecture.md) as the source of truth. The repository contains two supported backend deployment paths and a browser-only demo:

1. **Node backend + Neo4j (intended live path):** deploy the `render.yaml` Blueprint, add Neo4j server-side environment variables, then verify the real service with `node scripts/verify-neo4j.mjs https://ACTUAL-SERVICE-ORIGIN`. Render service creation, credentials, and production connectivity are not confirmed by the presence of this file.
2. **Supabase Edge Functions + Neo4j (alternative):** `.github/workflows/deploy-backend.yml` deploys the shared function handlers using Neo4j's HTTPS Query API. It is a separate supported route, not a dependency of the Render service. Use the Supabase URL plus `/functions/v1` as the frontend API base. Review and configure its required GitHub secrets before running it.
3. **Demo:** publish the Vite build without an API backend; the app uses bundled curriculum and labels it DEMO DATA.

## Render / Node backend

`render.yaml` uses `npm ci --include=dev && npm run build`, starts with `npm start`, and relies on `server/website.ts` binding to `0.0.0.0:$PORT`. It exposes `/api/health` as the service liveness check. Configure `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` in the Render dashboard; keep the password server-side. Set `ALLOWED_ORIGINS` to include the browser origin `https://authorsauravkushwaha.github.io` (an origin has no `/Neo4j-Build-Sprint/` suffix). No Render service URL is asserted here.

## GitHub Pages frontend

The Pages workflow computes the repository-specific base path. For this repository, it remains `/Neo4j-Build-Sprint/`. Set Actions repository **variable** `VITE_API_BASE_URL` to the real backend origin plus `/functions/v1`, such as `https://<actual-render-host>/functions/v1`. This is public, build-time configuration. It is not a credential. Then trigger a new `Build and deploy` workflow run; an already-published artifact will not change just because a variable changed.

Never set a Neo4j password or other private credential in any `VITE_*` variable. Without the API variable, a Pages build remains a usable demo deployment. Verify the new public build and backend using the script in [verification-neo4j.md](verification-neo4j.md) and browser network tools; do not call the deployment live before the actual query succeeds.

## Environment naming

- Node/Bolt: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, optional `NEO4J_DATABASE`.
- Supabase/Deno HTTPS Query API alternative: `NEO4J_QUERY_URL`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` as function secrets.
- Browser API URL: build-time `VITE_API_BASE_URL` only.

More details: [architecture.md](architecture.md), [graph-database.md](graph-database.md).
