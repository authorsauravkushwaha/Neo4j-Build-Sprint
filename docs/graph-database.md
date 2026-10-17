# Graph database options

See [architecture.md](architecture.md) for the single architecture source of truth. This document summarizes supported options without treating one unverified deployment as live production.

## Neo4j (intended live graph)

Neo4j holds the curriculum and, on the Supabase deployment, all user data (see [neo4j-schema.md](neo4j-schema.md)). Supabase is used for sign-in only.

- Node hosting uses `server/neo4jDriverReader.ts` and the official `neo4j-driver` over Bolt.
- Supabase Edge Functions are an alternative host and use the HTTPS Query API implementation under `supabase/functions/_shared/core/neo4jReader.ts`.
- Both use the checked-in graph schema and parameterized queries. Credentials remain server-side.
- A successful local build or static test does not establish that an external instance is configured. Verify an actual backend with `scripts/verify-neo4j.mjs`.

## PostgreSQL / PGlite alternative

The Node server can explicitly use `GRAPH_DATABASE_URL` or `GM_GRAPH_DATABASE_DIR` for its graph-reader store when Neo4j is not configured. This path reports `postgres-live`, never `neo4j-live`. It remains supported for existing deployments but is not proof of a Neo4j traversal.

The separate account database uses the project's own PGlite/PostgreSQL-backed code and is not automatically the graph database. Supabase may also be used for account/storage features in the separate Edge Functions deployment path.

## Demo path

With no API configured, or when the backend cannot be reached, the browser can use the bundled `src/data/seed/knowledgeGraph.ts` curriculum. This powers the navigation and graph-oriented learning features locally but is static sample data, not a database response. Source status is displayed explicitly.

Seed sources and identifiers are in `neo4j/schema.cypher`, `neo4j/seed.cypher`, and the TypeScript dataset. The Neo4j seed uses `MERGE`; it does not delete or reset an existing Neo4j database.
