/**
 * Production website + same-origin APIs. Deploy with ONE replica and a persistent disk.
 *
 * One process serves three things:
 *   - the static site (`dist/`),
 *   - the account API at `/api/*` (sign-in, sync — the project's own database),
 *   - the graph API at `/functions/v1/*` (the same endpoints the Supabase Edge
 *     Functions serve, backed by this deployment's own PostgreSQL graph store).
 * Build the frontend with `VITE_API_BASE_URL=/functions/v1` and this one
 * service is the whole live app, no third-party accounts involved.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve, extname, sep, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadServerEnv } from './env.ts'
import { openDatabase } from './database.ts'
import { createAuthServer } from './server.ts'
import { createGraphApi, describeGraphStore, type GraphApi } from './graphApi.ts'

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
}

export function staticWebsite(directory: string) {
  const root = resolve(directory)
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end('Method not allowed')
      return
    }
    let path: string
    try { path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname) }
    catch { response.writeHead(400).end('Invalid path'); return }
    if (path.includes('\0') || path.includes('\\') || path.split('/').some((part) => part.startsWith('.'))) {
      response.writeHead(404).end('Not found'); return
    }
    let file = resolve(root, `.${path}`)
    if (!file.startsWith(`${root}${sep}`) && file !== root) {
      response.writeHead(404).end('Not found'); return
    }
    let info = await stat(file).catch(() => null)
    if (!info?.isFile()) {
      // Client routes get the shell. Missing assets must remain real 404s.
      if (extname(path) || path.startsWith('/assets/')) { response.writeHead(404).end('Not found'); return }
      file = resolve(root, 'index.html')
      info = await stat(file).catch(() => null)
    }
    if (!info?.isFile()) { response.writeHead(503).end('Build the website with npm run build first.'); return }
    response.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    if (request.method === 'HEAD') { response.end(); return }
    const stream = createReadStream(file)
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false
if (isMain) {
  loadServerEnv()
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
  await stat(resolve(dist, 'index.html')).catch(() => { throw new Error('Run npm run build before npm start.') })
  const db = await openDatabase()

  /* The graph API must never take the site down with it: if the graph store
   * refuses to open (permissions, a locked directory), the website and the
   * account API still serve, and the frontend — honestly — reports demo mode. */
  let graph: GraphApi | null = null
  try {
    graph = await createGraphApi({ env: process.env })
    console.log(`GraphMentor graph API ready at /functions/v1 (${await describeGraphStore(graph.db)}).`)
  } catch (error) {
    console.error(
      `GraphMentor graph API is unavailable (${error instanceof Error ? error.message : 'unknown error'}); ` +
        'serving the website without it — the app will run in labelled sample mode.',
    )
  }

  const api = createAuthServer(db, {
    trustProxy: process.env['AUTH_TRUST_PROXY'] === 'true',
    allowInsecureHttp: process.env['AUTH_ALLOW_INSECURE_HTTP'] === 'true',
  })
  const serve = staticWebsite(dist)
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    if (path === '/api' || path.startsWith('/api/')) api.emit('request', request, response)
    else if (graph?.matches(path)) {
      void graph.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500).end('Unable to serve this request.')
        else response.destroy()
      })
    } else void serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end('Unable to serve this request.')
      else response.destroy()
    })
  })
  const port = Number(process.env['PORT'] ?? 3000)
  server.listen(port, '0.0.0.0', () => console.log(`GraphMentor website and account database ready on port ${port}`))
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close(() => {
        void db.end()
        void graph?.close()
      })
      server.closeIdleConnections()
    })
  }
}
