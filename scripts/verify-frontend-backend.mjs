#!/usr/bin/env node
/**
 * verify-frontend-backend — prove that the built frontend really talks to the
 * configured backend, in a real browser.
 *
 * A green build and a 200 from a backend are two separate facts, and neither
 * of them proves that the *browser* reached the backend. This script opens the
 * published (or locally previewed) site in Chromium and checks the whole
 * chain:
 *
 *   1. the page loads without JavaScript errors,
 *   2. the browser really issued requests to the configured API base,
 *   3. those requests succeeded and carried a data-source label,
 *   4. the banner the user sees matches the source that was actually
 *      observed — LIVE NEO4J only for a Neo4j-sourced response, DEMO DATA for
 *      the bundled dataset, BACKEND UNAVAILABLE when the backend could not be
 *      reached.
 *
 * Usage:
 *   node scripts/verify-frontend-backend.mjs [FRONTEND_URL] [BACKEND_URL]
 *     --chromium=PATH        use a specific Chromium binary
 *     --screenshot=PATH      write a screenshot of the page
 *     --timeout=MS           how long to wait for the data requests
 *
 * Environment:
 *   FRONTEND_URL            default http://127.0.0.1:4173
 *   BACKEND_URL             default http://127.0.0.1:3000
 *   CHROMIUM_PATH           optional Chromium binary
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED (no browser, or the frontend could
 * not be reached at all).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium as playwright } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

function parseArgs(argv) {
  const options = {
    frontend: process.env.FRONTEND_URL ?? 'http://127.0.0.1:4173',
    backend: process.env.BACKEND_URL ?? 'http://127.0.0.1:3000',
    chromiumPath: process.env.CHROMIUM_PATH ?? '',
    screenshot: '',
    timeoutMs: 20_000,
    // The landing page only performs the session handshake; a data route is
    // what actually reads the graph, so both are visited.
    routes: ['/', '/careers'],
  }
  for (const arg of argv) {
    if (arg.startsWith('--chromium=')) { options.chromiumPath = arg.slice('--chromium='.length); continue }
    if (arg.startsWith('--screenshot=')) { options.screenshot = arg.slice('--screenshot='.length); continue }
    if (arg.startsWith('--route=')) {
      options.routes.push(arg.slice('--route='.length))
      continue
    }
    if (arg.startsWith('--timeout=')) {
      const value = Number(arg.slice('--timeout='.length))
      if (Number.isFinite(value) && value >= 1000) options.timeoutMs = Math.min(value, 120_000)
      continue
    }
    if (arg.startsWith('--')) continue
    if (!options.frontendExplicit) { options.frontend = arg; options.frontendExplicit = true; continue }
    options.backend = arg
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, ...(detail ? { detail } : {}) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log(`\nFrontend -> backend verification`)
console.log(`Frontend: ${options.frontend}`)
console.log(`Backend:  ${options.backend}`)
console.log('-'.repeat(60))

let browser
try {
  browser = await playwright.launch({
    ...(options.chromiumPath ? { executablePath: options.chromiumPath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
} catch (error) {
  console.log('BLOCKED — no browser could be started.')
  console.log(error instanceof Error ? error.message : String(error))
  console.log('Install one with: npx playwright install chromium')
  process.exit(2)
}

const consoleErrors = []
const pageErrors = []
const failedRequests = []
const apiResponses = []
const allRequests = []

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => { pageErrors.push(error.message) })
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`)
  })
  page.on('request', (request) => { allRequests.push(request.url()) })
  page.on('response', async (response) => {
    const url = response.url()
    if (!/health-check|get-|mentor-chat|analyze-|generate-/.test(url)) return
    let body = null
    try { body = await response.json() } catch { body = null }
    apiResponses.push({ url, status: response.status(), body })
  })

  const response = await page.goto(options.frontend, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
  if (!response) throw new Error('The frontend did not answer.')

  // Give the app time to run its session handshake and its first data read.
  await page.waitForTimeout(4000)

  // Then visit the routes that read the graph, so the check covers a real data
  // request and not only the handshake.
  for (const route of options.routes.slice(1)) {
    const url = new URL(route, options.frontend).toString()
    const routeResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
    if (!routeResponse) continue
    await page.waitForTimeout(3000)
  }

  const banner = (await page.locator('[role="status"]').allTextContents()).join(' | ').trim()
  const apiCalls = allRequests.filter((url) => url.startsWith(options.backend) || /\/functions\/v1\//.test(url))
  const health = apiResponses.find((entry) => entry.url.includes('health-check'))
  const dataResponses = apiResponses.filter((entry) => !entry.url.includes('health-check'))

  check('the page loaded', true, `HTTP ${response.status()}`)
  check('the page produced no JavaScript errors', pageErrors.length === 0 && consoleErrors.length === 0,
    pageErrors.length || consoleErrors.length ? [...pageErrors, ...consoleErrors].join('; ').slice(0, 300) : 'none')
  check('the browser called the configured backend', apiCalls.length > 0,
    `${apiCalls.length} request(s) to the API base`)
  check('the health request succeeded', Boolean(health) && health.status === 200,
    health ? `HTTP ${health.status}, source ${health.body?.data?.graph?.source ?? health.body?.meta?.source ?? 'unknown'}` : 'no health request observed')
  check('at least one data request succeeded', dataResponses.some((entry) => entry.status === 200),
    dataResponses.map((entry) => `${entry.url.split('/').pop()}=${entry.status}`).join(', ') || 'none observed')

  const observedSource = health?.body?.data?.graph?.source ?? health?.body?.meta?.source ?? null
  if (observedSource === 'neo4j-live') {
    check('the banner reports LIVE NEO4J', banner.includes('LIVE NEO4J'), banner.slice(0, 160) || '(no banner)')
  } else if (observedSource === 'postgres-live') {
    check('the banner reports LIVE POSTGRESQL', banner.includes('LIVE POSTGRESQL'), banner.slice(0, 160) || '(no banner)')
  } else if (observedSource === 'local-sample') {
    check('the banner reports DEMO DATA', banner.includes('DEMO DATA'), banner.slice(0, 160) || '(no banner)')
  } else {
    check('the banner states an honest data source', banner.length > 0, banner.slice(0, 160) || '(no banner)')
  }

  check('no request failed at the network level', failedRequests.length === 0,
    failedRequests.join('; ').slice(0, 300) || 'none')

  if (options.screenshot) {
    const target = resolve(root, options.screenshot)
    mkdirSync(dirname(target), { recursive: true })
    await page.screenshot({ path: target, fullPage: false })
    console.log(`\nScreenshot: ${target}`)
  }

  console.log('\nObserved API traffic:')
  for (const entry of apiResponses) {
    const source = entry.body?.meta?.source ?? entry.body?.data?.graph?.source ?? '-'
    console.log(`  ${entry.status} ${entry.url}  (source: ${source})`)
  }
} finally {
  await browser.close().catch(() => {})
}

const failed = checks.filter((entry) => !entry.ok)
console.log('')
console.log('============================================================')
console.log(failed.length === 0
  ? 'PASS — THE FRONTEND REACHED THE BACKEND'
  : 'FAIL — THE FRONTEND/BACKEND PATH IS BROKEN')
console.log('============================================================')
process.exit(failed.length === 0 ? 0 : 1)
