/**
 * Seed the deployment's own knowledge-graph database with the bundled
 * curriculum (`src/data/seed/knowledgeGraph.ts`).
 *
 *   npm run seed:graphdb            # seed if empty or outdated (default)
 *   npm run seed:graphdb -- --force # rebuild the tables from the bundle
 *   npm run seed:graphdb -- --wipe  # drop the graph tables and exit
 *
 * Where it writes (same rule as the running API, see server/graphStore.ts):
 *   GRAPH_DATABASE_URL        -> that PostgreSQL (schema `graph`),
 *   GM_GRAPH_DATABASE_DIR     -> embedded PGlite at this directory,
 *   default                   -> .localdata/graph-postgres in the project.
 *
 * The write is idempotent: tables carry the dataset version, so rerunning
 * against unchanged data is a no-op and operator edits are preserved.
 */
import {
  dropGraphStore,
  graphCounts,
  graphDatasetVersion,
  graphRevision,
  openGraphDatabase,
  seedGraphDatabase,
} from '../server/graphStore.ts'

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main() {
  const target = (process.env['GRAPH_DATABASE_URL'] ?? '').trim()
    ? 'GRAPH_DATABASE_URL'
    : process.env['GM_GRAPH_DATABASE_DIR'] ?? '.localdata/graph-postgres (embedded)'
  console.log(`Graph database target: ${target}`)

  const db = await openGraphDatabase(process.env)
  try {
    if (flag('wipe')) {
      const dropped = await dropGraphStore(db)
      console.log(dropped ? 'Graph tables dropped. The database is empty again.' : 'Nothing to drop — there were no graph tables.')
      return
    }

    const beforeVersion = await graphDatasetVersion(db)
    const beforeRevision = await graphRevision(db)
    const seeded = await seedGraphDatabase(db, { force: flag('force') })
    const afterVersion = (await graphDatasetVersion(db)) ?? '(none)'
    const afterRevision = await graphRevision(db)
    const counts = await graphCounts(db)

    if (seeded.seeded) {
      console.log(`Seeded dataset v${JSON.stringify(afterVersion)}: ${counts.nodes} nodes, ${counts.relationships} relationships.`)
      console.log(`Revision ${beforeRevision} -> ${afterRevision}.
Every graph answer now comes from these tables, not the app bundle.`)
    } else {
      console.log(`No change — ${seeded.reason}.`)
      console.log('The tables already hold this dataset (operator edits included). Use --force to rebuild them from the bundle.')
    }
    if (beforeVersion !== afterVersion && beforeVersion) {
      console.log(`Dataset version changed: v${JSON.stringify(beforeVersion)} -> v${JSON.stringify(afterVersion)}.`)
    }
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
