#!/usr/bin/env node
/**
 * verify-all — run the whole evidence chain in one command.
 *
 *   npm run verify                 # everything that needs no local infrastructure
 *   npm run verify -- --with-infra # and fail if a local-infra step cannot run
 *   npm run verify -- --list       # show the steps without running them
 *
 * Why this exists: the project's claims are backed by commands, and a claim whose
 * command only ever ran inside somebody's head is a claim nobody can check. This
 * runs the same chain in the same order every time and reports what actually
 * happened — including the steps it *skipped*, and why.
 *
 * Two kinds of step:
 *
 *   core    types, tests, dataset, generated Cypher, secrets, dependencies, build,
 *           and the cross-language Java oracle. No network, no database, no browser.
 *           The oracle is the one core step with an external requirement (a JDK):
 *           without one it is skipped *by name*, so nobody reads a green summary
 *           as "the Java and TypeScript engines agree" when Java never ran.
 *   local   the browser suite and the PostgreSQL-backed harnesses. These need a
 *           running preview server and/or DATABASE_URL. When those are absent the
 *           step is skipped and *said to be skipped* — never quietly counted as
 *           passing. That is the whole point: a green summary that quietly omitted
 *           the database tests would be worse than no summary.
 *
 * Exit code is 1 if any step failed, or if `--with-infra` was passed and a
 * local-infra step could not run.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const withInfra = args.includes('--with-infra')
const listOnly = args.includes('--list')

const baseUrl = process.env['BASE_URL'] ?? 'http://127.0.0.1:4173'
const databaseUrl = process.env['DATABASE_URL'] ?? ''

/** Can the preview server answer? Used to decide whether to skip, never to guess. */
async function previewReachable() {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2500) })
    return response.ok || response.status === 304
  } catch {
    return false
  }
}

const previewUp = await previewReachable()

/** Can the Node backend answer? Used only to decide whether to skip. */
async function backendReachable() {
  try {
    const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch {
    return false
  }
}

const backendUp = await backendReachable()

/**
 * Is the preview serving a *build* or a dev server? The service-worker checks
 * only mean anything against a build (`vite dev` does not emit sw.js), so the
 * presence of one is used to decide whether to enable them — rather than
 * assuming, or making the reader remember a flag.
 */
async function servesBuild() {
  if (!previewUp) return false
  try {
    const response = await fetch(`${baseUrl}/sw.js`, { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch {
    return false
  }
}

const previewIsBuild = await servesBuild()

/**
 * The cross-language oracle is a core step, but it needs a JDK. Probed by running
 * `javac`, never assumed: a machine without Java must see the step reported as
 * skipped, not as passed.
 */
function javaAvailable() {
  const probe = spawnSync('javac -version', { cwd: root, shell: true, encoding: 'utf8' })
  return probe.status === 0
}

const jdkPresent = javaAvailable()

const steps = [
  {
    name: 'Type check',
    run: 'npx tsc -b',
    detail: '0 errors expected',
  },
  {
    name: 'Unit + integration tests',
    run: 'npx vitest run',
    detail: 'the whole suite, every file',
  },
  {
    name: 'Dataset self-check',
    run: 'npm run validate:seed',
    detail: 'dataset, engines and generated Cypher agree',
  },
  {
    name: 'Generated Cypher is current',
    run: 'npm run emit:cypher -- --check',
    detail: 'fails if neo4j/ was not regenerated after a dataset change',
  },
  {
    name: 'Secret scan',
    run: 'npm run lint:secrets',
    detail: 'source tree, built bundle, and the scanner canary',
  },
  {
    name: 'Dependency audit (shipped tree)',
    run: 'npm audit --omit=dev',
    detail: 'dev-only advisories are documented rather than force-fixed',
  },
  {
    name: 'Production build',
    run: 'npm run build',
    detail: 'the artifact every other browser check reads',
  },
  {
    name: 'Built CSP copies agree',
    run: 'npm run check:csp',
    detail: 'the <meta> tag and dist/_headers list the same connect-src hosts',
  },
  {
    name: 'Cross-language oracle (Java)',
    run: 'npm run oracle',
    detail: 'recomputes every frontier number in Java and diffs it against the TypeScript engine',
    skip: jdkPresent ? null : 'javac is not on PATH — install a JDK 11+ to run the cross-language diff (docs/frontier.md)',
  },
  {
    name: 'Browser suite',
    run: 'npm run verify:browser',
    env: { BASE_URL: baseUrl, ...(previewIsBuild ? { CHECK_OFFLINE: '1' } : {}) },
    detail: `real Chromium against ${baseUrl}${previewIsBuild ? ', service-worker checks included' : ' (dev server — service-worker checks need a build)'}`,
    skip: previewUp
      ? null
      : `no server answering at ${baseUrl} — start one with \`npm run build && npm run preview\` (or \`npm run dev\` and BASE_URL=http://127.0.0.1:5173)`,
    infra: true,
  },
  {
    name: 'Injection audit (real browser)',
    run: 'npm run verify:injection',
    env: { BASE_URL: baseUrl },
    detail: 'nine hostile payload classes plus the guest-mode claim, typed into the product\'s own controls: nothing becomes markup, nothing executes',
    skip: previewUp ? null : `no server answering at ${baseUrl} — start one with \`npm run build && npm run preview\``,
    infra: true,
  },
  {
    name: 'Row Level Security harness',
    run: 'npm run verify:rls',
    env: { DATABASE_URL: databaseUrl },
    detail: 'PostgreSQL 17 with the shipped migrations applied unmodified',
    skip: databaseUrl ? null : 'DATABASE_URL is not set — see docs/verification.md §5 for the local setup',
    infra: true,
  },
  {
    name: 'Auth path over HTTP',
    run: 'npm run smoke:http',
    env: { DATABASE_URL: databaseUrl },
    detail: 'rate limiting and error hygiene through a real socket',
    skip: databaseUrl ? null : 'DATABASE_URL is not set — see docs/verification.md §5 for the local setup',
    infra: true,
  },
  {
    name: 'Backend URL a build would embed',
    run: 'npm run verify:api-config -- --check',
    detail: 'an empty value is a legitimate demo build; a set value must be a valid https /functions/v1 URL',
  },
  {
    name: 'Live Neo4j contract',
    run: 'npm run verify:neo4j -- http://127.0.0.1:3000',
    detail: 'PASS only when a real Cypher query ran against Neo4j; BLOCKED (exit 2) when the database is not Neo4j or is unconfigured',
    skip: backendUp ? null : 'no backend answering at http://127.0.0.1:3000 — start one with `npm run build && npm start`',
    blockedExit: 2,
    infra: true,
  },
  {
    name: 'Frontend talks to the backend (real browser)',
    run: 'npm run verify:frontend-backend -- http://127.0.0.1:3000 http://127.0.0.1:3000',
    detail: 'Chromium loads the built site and checks the API requests, the source label, and the banner',
    skip: backendUp
      ? null
      : 'no backend answering at http://127.0.0.1:3000 — start one with `npm run build && npm start`',
    blockedExit: 2,
    infra: true,
  },
]

if (listOnly) {
  console.log('Steps, in order:\n')
  for (const [index, step] of steps.entries()) {
    const kind = step.infra ? 'local' : 'core '
    const state = step.skip ? `would skip (${step.skip})` : 'would run'
    console.log(`  ${String(index + 1).padStart(2)}. [${kind}] ${step.name} — ${state}`)
  }
  console.log('\n--with-infra turns a skipped local step into a failure.')
  process.exit(0)
}

console.log('verify-all — the whole chain, in order\n')
console.log(
  `  preview   ${
    previewUp ? `reachable at ${baseUrl}${previewIsBuild ? ' (serving a build)' : ' (dev server)'}` : `not reachable at ${baseUrl}`
  }`,
)
console.log(`  database  ${databaseUrl ? 'DATABASE_URL is set' : 'DATABASE_URL is not set'}\n`)

const results = []
let failed = 0
let skipped = 0

for (const [index, step] of steps.entries()) {
  const label = `${index + 1}/${steps.length} ${step.name}`
  if (step.skip) {
    skipped += 1
    results.push({ ...step, status: 'skipped', ms: 0 })
    console.log(`\n── SKIP  ${label}\n          ${step.skip}`)
    continue
  }

  console.log(`\n── RUN   ${label} — ${step.detail}`)
  const startedAt = Date.now()
  const result = spawnSync(step.run, {
    cwd: root,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ...(step.env ?? {}) },
  })
  const ms = Date.now() - startedAt
  if (result.status === 0) {
    results.push({ ...step, status: 'passed', ms })
    console.log(`── PASS  ${label} (${(ms / 1000).toFixed(1)}s)`)
    continue
  }
  if (step.blockedExit != null && result.status === step.blockedExit) {
    skipped += 1
    results.push({ ...step, status: 'blocked', ms })
    console.log(`── BLOCK ${label} (${(ms / 1000).toFixed(1)}s) — verification could not be completed (not a code defect)`)
    continue
  }
  failed += 1
  results.push({ ...step, status: 'failed', ms })
  console.log(`── FAIL  ${label} (${(ms / 1000).toFixed(1)}s)`)
}

const width = Math.max(...results.map((entry) => entry.name.length))
console.log(`\n${'='.repeat(72)}\nSummary\n${'='.repeat(72)}`)
for (const entry of results) {
  const mark = entry.status === 'passed' ? 'ok  ' : entry.status === 'skipped' ? 'skip' : entry.status === 'blocked' ? 'BLOCK' : 'FAIL'
  const timing = entry.status === 'skipped' ? '' : `${(entry.ms / 1000).toFixed(1)}s`
  console.log(`  ${mark}  ${entry.name.padEnd(width)}  ${timing}`)
}

const ran = results.filter((entry) => entry.status === 'passed' || entry.status === 'failed').length
console.log(`\n${ran - failed}/${ran} executed step(s) passed; ${skipped} skipped or blocked.`)

if (failed > 0) {
  console.log('\nFailed:')
  for (const entry of results.filter((e) => e.status === 'failed')) console.log(`  - ${entry.name}: ${entry.run}`)
}

if (withInfra && skipped > 0) {
  console.log('\n--with-infra was passed, so a skipped local step is a failure here.')
  process.exit(1)
}

if (skipped > 0 && failed === 0) {
  console.log('\nThe skipped/blocked steps above are local-infrastructure checks. A BLOCKED Neo4j')
  console.log('step means the database was not there to query — it is not evidence of a live connection.')
  console.log('Last recorded results: docs/verification.md §5. Do not read this summary as having re-run them.')
}

process.exit(failed > 0 ? 1 : 0)


