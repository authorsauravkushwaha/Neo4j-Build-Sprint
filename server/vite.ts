/** Same-origin APIs in dev/preview: one command starts the website AND the databases. */
import type { Plugin, ViteDevServer, PreviewServer } from 'vite'
import { openDatabase, type Database } from './database.ts'
import { loadServerEnv } from './env.ts'
import { createAuthServer } from './server.ts'
import { createGraphApi, type GraphApi } from './graphApi.ts'

interface SharedDatabase { refs: number; database: Promise<Database> }
interface SharedGraphApi { refs: number; api: Promise<GraphApi | null> }
// Vite constructs a NEW server before closing the old one on config reload.
// Its config modules are re-bundled, so module-local state cannot share the
// embedded connection across that overlap. Retain reference-counted leases in
// the Node process, never in the browser, and close only after the last server.
const state = globalThis as typeof globalThis & {
  __graphmentorViteDatabases?: Map<string, SharedDatabase>
  __graphmentorViteGraphApis?: Map<string, SharedGraphApi>
}
const databases = state.__graphmentorViteDatabases ??= new Map()
const graphApis = state.__graphmentorViteGraphApis ??= new Map()

const GRAPH_LEASE_KEYS = [
  'NEO4J_URI',
  'NEO4J_BOLT_URI',
  'NEO4J_QUERY_URL',
  'NEO4J_USERNAME',
  'NEO4J_USER',
  'NEO4J_PASSWORD',
  'NEO4J_DATABASE',
  'GRAPH_DATABASE_URL',
  'GM_GRAPH_DATABASE_DIR',
] as const

/** Lease the graph API the same way the account database is leased. */
async function leaseGraphApi(env: Record<string, string>): Promise<{ graph: GraphApi | null; release: () => Promise<void> }> {
  const settings = { ...process.env, ...env }
  const key = JSON.stringify(GRAPH_LEASE_KEYS.map((name) => settings[name] ?? ''))
  let shared = graphApis.get(key)
  if (!shared) {
    shared = {
      refs: 0,
      api: createGraphApi({ env: settings }).catch((error: unknown) => {
        console.warn(
          `GraphMentor graph API unavailable (${error instanceof Error ? error.message : 'unknown error'}); ` +
            '/functions/v1 will not be served by this dev server.',
        )
        return null
      }),
    }
    graphApis.set(key, shared)
  }
  const lease = shared
  lease.refs++
  let releasing: Promise<void> | undefined
  const release = (): Promise<void> => {
    releasing ??= (async () => {
      if (--lease.refs === 0) {
        graphApis.delete(key)
        const api = await lease.api
        await api?.close()
      }
    })()
    return releasing
  }
  return { graph: await lease.api, release }
}

export function accountsPlugin(env: Record<string, string>): Plugin {
  let closeDatabase: (() => Promise<void>) | undefined
  let closeGraph: (() => Promise<void>) | undefined
  async function attach(server: ViteDevServer | PreviewServer): Promise<void> {
    loadServerEnv()
    // Set GM_EXTERNAL_API=true when running npm run server independently.
    if (env['GM_EXTERNAL_API'] === 'true') return
    const settings = { ...process.env, ...env }
    const key = JSON.stringify(['DATABASE_AUTH_URL', 'GM_DATABASE_DIR', 'GM_DB_ROOT', 'GM_PORT', 'GM_DB_NAME']
      .map((name) => settings[name] ?? ''))
    let shared = databases.get(key)
    if (!shared) {
      shared = { refs: 0, database: openDatabase(settings) }
      databases.set(key, shared)
    }
    const lease = shared
    lease.refs++
    let releasing: Promise<void> | undefined
    closeDatabase = () => {
      releasing ??= (async () => {
        if (--lease.refs === 0) {
          databases.delete(key)
          const database = await lease.database.catch(() => null)
          await database?.end()
        }
      })()
      return releasing
    }
    let db: Database
    try { db = await lease.database }
    catch (error) {
      await closeDatabase().catch(() => {})
      throw error
    }
    const api = createAuthServer(db, {
      trustProxy: settings['AUTH_TRUST_PROXY'] === 'true',
      allowInsecureHttp: settings['AUTH_ALLOW_INSECURE_HTTP'] === 'true',
    })

    // The graph API on the same origin: build with VITE_API_BASE_URL=/functions/v1
    // and `npm run dev` is the full live stack, database included.
    const graphLease = await leaseGraphApi(env)
    closeGraph = graphLease.release
    const graph = graphLease.graph

    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? '').split('?')[0]
      // Graph REST endpoints (/api/graph/*, /api/health/*, /api/query, /api/evidence/*, /api/ledger/*)
      // and /functions/v1/* belong to the graph API; /api/auth/* and /api/sync belong to the account server.
      if (graph?.matches(path) && !path.startsWith('/api/auth') && !path.startsWith('/api/sync')) {
        void graph.handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500).end('Unable to serve this request.')
          else response.destroy()
        })
      } else if (path === '/api' || path.startsWith('/api/')) {
        api.emit('request', request, response)
      } else {
        next()
      }
    })
    server.httpServer?.once('close', () => {
      void closeDatabase?.()
      void closeGraph?.()
    })
    server.config.logger.info('GraphMentor account database connected — /api/auth and /api/sync ready')
    if (graph) {
      const mode = graph.driver ? 'Neo4j' : graph.db ? 'PostgreSQL' : 'unconfigured'
      server.config.logger.info(`GraphMentor graph API connected — /functions/v1 ready (${mode})`)
    }
  }
  return {
    name: 'graphmentor-accounts',
    configureServer: attach,
    configurePreviewServer: attach,
    async closeBundle() {
      await closeDatabase?.()
      await closeGraph?.()
    },
  }
}
