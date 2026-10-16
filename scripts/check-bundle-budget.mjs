#!/usr/bin/env node
/**
 * check-bundle-budget — fail the build if a shipped chunk exceeds its budget.
 *
 * The build only *warns* above 900 kB (vite.config.ts chunkSizeWarningLimit).
 * This script turns that into a hard failure for CI, so a regression in the
 * initial JavaScript payload cannot land silently.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dist = process.argv[2] || 'dist'
const assets = join(dist, 'assets')

// Budgets in bytes. Keep these honest: they describe the current build, not an
// aspiration, and must be re-measured (and tightened) when the payload shrinks.
const PER_CHUNK_BYTES = 1.45 * 1024 * 1024 // 1.45 MB per chunk
const TOTAL_JS_BYTES = 2.75 * 1024 * 1024 // 2.6 MB of JavaScript overall

let total = 0
const offenders = []
for (const name of readdirSync(assets)) {
  if (!name.endsWith('.js')) continue
  const size = statSync(join(assets, name)).size
  total += size
  if (size > PER_CHUNK_BYTES) offenders.push({ name, size })
}

if (offenders.length) {
  console.error('Bundle budget exceeded (per-chunk):')
  for (const { name, size } of offenders) {
    console.error(`  ${name}: ${(size / 1024 / 1024).toFixed(2)} MB > ${(PER_CHUNK_BYTES / 1024 / 1024).toFixed(2)} MB`)
  }
  process.exit(1)
}
if (total > TOTAL_JS_BYTES) {
  console.error(`Total JavaScript ${(total / 1024 / 1024).toFixed(2)} MB exceeds budget ${(TOTAL_JS_BYTES / 1024 / 1024).toFixed(2)} MB`)
  process.exit(1)
}
console.log(`Bundle budget OK: ${offenders.length} oversized chunks; ${(total / 1024 / 1024).toFixed(2)} MB total JS.`)
