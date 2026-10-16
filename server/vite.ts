/** Same-origin API in dev/preview: one command starts the website AND storage. */
import type { Plugin, ViteDevServer, PreviewServer } from 'vite'
import { openDatabase, type Database } from './database.ts'
import { createAuthServer } from './server.ts'

interface SharedDatabase { refs: number; database: Promise<Database> }
// Vite constructs a NEW server before closing the old one on config reload.
// Its config modules are re-bundled, so module-local state cannot share the
// embedded connection across that overlap. Retain reference-counted leases in
// the Node process, never in the browser, and close only after the last server.
const state = globalThis as typeof globalThis & { __graphmentorViteDatabases?: Map<string, SharedDatabase> }
const databases = state.__graphmentorViteDatabases ??= new Map()

export function accountsPlugin(env: Record<string, string>): Plugin {
  let closeDatabase: (() => Promise<void>) | undefined
  async function attach(server: ViteDevServer | PreviewServer): Promise<void> {
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
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? '').split('?')[0]
      if (path === '/api' || path.startsWith('/api/')) api.emit('request', request, response)
      else next()
    })
    server.httpServer?.once('close', () => { void closeDatabase?.() })
    server.config.logger.info('GraphMentor account database connected — /api/auth and /api/sync ready')
  }
  return {
    name: 'graphmentor-accounts',
    configureServer: attach,
    configurePreviewServer: attach,
    async closeBundle() { await closeDatabase?.() },
  }
}
