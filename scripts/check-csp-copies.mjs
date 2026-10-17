#!/usr/bin/env node
/**
 * Confirm the two Content-Security-Policy copies in the built artifact agree
 * on connect-src. A browser enforces the intersection of every policy it is
 * given, so a host listed in the <meta> tag but missing from dist/_headers
 * silently blocks every API request while the build stays green.
 *
 * Usage: node scripts/check-csp-copies.mjs [distDir]
 * Exit 0 when they agree, 1 when they do not or a copy is missing.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const dist = resolve(process.argv[2] ?? 'dist')
const htmlPath = resolve(dist, 'index.html')
const headersPath = resolve(dist, '_headers')

if (!existsSync(htmlPath) || !existsSync(headersPath)) {
  console.error(`missing ${htmlPath} or ${headersPath} — run npm run build first`)
  process.exit(1)
}

const html = readFileSync(htmlPath, 'utf8')
const headers = readFileSync(headersPath, 'utf8')
const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
const header = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(headers)?.[1]

if (!meta || !header) {
  console.error('missing Content-Security-Policy in dist/index.html or dist/_headers')
  process.exit(1)
}

const connect = (policy) =>
  (policy.match(/connect-src\s+([^;]+)/)?.[1] ?? '').trim().split(/\s+/).filter(Boolean).sort().join(' ')

const metaConnect = connect(meta)
const headerConnect = connect(header)

if (metaConnect !== headerConnect) {
  console.error('connect-src disagrees between dist/index.html and dist/_headers')
  console.error('meta:   ', metaConnect)
  console.error('header: ', headerConnect)
  process.exit(1)
}

if (meta.includes('__CSP_CONNECT_SRC__')) {
  console.error('the built meta tag still contains the connect-src placeholder')
  process.exit(1)
}

console.log('connect-src agrees:', metaConnect)
