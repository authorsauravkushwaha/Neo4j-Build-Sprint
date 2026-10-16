/**
 * Checks every resource link in the curated dataset and writes what it actually
 * found to docs/resource-verification.md.
 *
 *   npm run verify:resources              # check all links, write the report
 *   npm run verify:resources -- --strict  # exit non-zero if any link failed
 *   npm run verify:resources -- --limit=10
 *
 * This script reports measured results only. A blocked network, a timeout or a
 * 403 is written down as exactly that — never converted into "verified". The
 * dataset keeps its own `verification` field; this report tells a maintainer
 * which of those claims still hold today.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { knowledgeGraph } from '../src/data/seed/knowledgeGraph.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const limitArg = args.find((arg) => arg.startsWith('--limit='))
const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1])) : Number.POSITIVE_INFINITY
const timeoutMs = 12_000
const concurrency = 5

interface CheckResult {
  id: string
  name: string
  provider: string
  url: string
  accessModel: string
  verification: string
  lastVerified: string | null
  status: number | null
  finalUrl: string | null
  outcome: 'ok' | 'redirected' | 'blocked' | 'failed' | 'timeout'
  note: string
}

async function checkOne(resource: (typeof knowledgeGraph.resources)[number]): Promise<CheckResult> {
  const base = {
    id: resource.id,
    name: resource.name,
    provider: resource.provider,
    url: resource.url,
    accessModel: resource.accessModel,
    verification: resource.verification,
    lastVerified: resource.lastVerified,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // Some providers reject requests that do not look like a browser, which would
  // otherwise be reported as a dead link. The header says honestly what this is.
  const headers = {
    'user-agent': 'GraphMentorAI-link-check/1.0 (+free-resource-verification; contact: repo maintainer)',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }
  try {
    // A HEAD request is cheaper, but several providers answer 405, so fall back
    // to a ranged GET before concluding anything.
    let response = await fetch(resource.url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers })
    // Several CDNs answer 403/404 to HEAD but serve the page to GET, so a HEAD
    // is a hint and never the verdict.
    if ([403, 404, 405, 501].includes(response.status)) {
      response = await fetch(resource.url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { ...headers, range: 'bytes=0-1024' },
      })
    }
    const status = response.status
    const finalUrl = response.url || resource.url
    const redirected = finalUrl.replace(/\/$/, '') !== resource.url.replace(/\/$/, '')
    const outcome: CheckResult['outcome'] =
      status >= 200 && status < 400 ? (redirected ? 'redirected' : 'ok') : status === 401 || status === 403 || status === 429 ? 'blocked' : 'failed'
    return { ...base, status, finalUrl, outcome, note: redirected ? `Redirects to ${finalUrl}` : `HTTP ${status}` }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ...base,
      status: null,
      finalUrl: null,
      outcome: aborted ? 'timeout' : 'failed',
      note: aborted
        ? `No response within ${timeoutMs / 1000}s`
        : `Request error: ${error instanceof Error ? error.message : 'unknown'}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  const checkedAt = new Date().toISOString().slice(0, 10)
  const resources = knowledgeGraph.resources.slice(0, limit)
  console.log(`Checking ${resources.length} resource link(s) with ${concurrency} parallel requests...\n`)

  const results: CheckResult[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, resources.length) }, async () => {
    while (cursor < resources.length) {
      const index = cursor++
      const resource = resources[index]
      const result = await checkOne(resource)
      results.push(result)
      const marker =
        result.outcome === 'ok' ? 'ok     ' : result.outcome === 'redirected' ? 'moved  ' : result.outcome.padEnd(7)
      console.log(`  ${marker} ${result.url} — ${result.note}`)
    }
  })
  await Promise.all(workers)

  results.sort((a, b) => a.url.localeCompare(b.url))
  const totals = {
    ok: results.filter((r) => r.outcome === 'ok').length,
    redirected: results.filter((r) => r.outcome === 'redirected').length,
    blocked: results.filter((r) => r.outcome === 'blocked').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    timeout: results.filter((r) => r.outcome === 'timeout').length,
  }

  const lines: string[] = [
    '# Resource link verification',
    '',
    `Run at: ${new Date().toISOString()}`,
    '',
    'This report contains **measured** results from `npm run verify:resources` on the machine and',
    'network where it ran. It is a maintenance aid, not a guarantee: providers change URLs, move',
    'content behind logins, or retire courses. The dataset itself marks each resource with an',
    '`accessModel` and a `lastVerified` date, and the app shows those labels next to every link.',
    '',
    '## Summary',
    '',
    '| Outcome | Count |',
    '| --- | --- |',
    `| Reachable, no redirect | ${totals.ok} |`,
    `| Reachable, redirected | ${totals.redirected} |`,
    `| Blocked (401/403/429 from this network) | ${totals.blocked} |`,
    `| Failed (4xx/5xx) | ${totals.failed} |`,
    `| Timed out | ${totals.timeout} |`,
    '',
    '## Per-resource results',
    '',
    '| Resource | Provider | URL | HTTP | Outcome | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.provider} | <${r.url}> | ${r.status ?? '—'} | ${r.outcome} | ${r.note.replace(/\|/g, '\\|')} |`,
    ),
    '',
    '## How to act on this report',
    '',
    '- `redirected` — update the URL in `src/data/seed/knowledgeGraph.ts` so the learner skips the hop.',
    '- `blocked` — many free providers reject datacentre IPs or automated clients; a maintainer should',
    '  open the link in a browser and confirm before changing anything.',
    '- `failed` / `timeout` — re-run once; if it repeats, replace the resource or mark it in the dataset.',
    '- After editing the dataset: `npm run validate:seed && npm run emit:cypher`.',
    '',
  ]

  mkdirSync(resolve(root, 'docs'), { recursive: true })
  const outPath = resolve(root, 'docs', 'resource-verification.md')
  writeFileSync(outPath, lines.join('\n'), 'utf8')

  console.log(
    `\nSummary: ${totals.ok} reachable, ${totals.redirected} redirected, ${totals.blocked} blocked, ${totals.failed} failed, ${totals.timeout} timed out.`,
  )
  console.log(`Report written to docs/resource-verification.md`)

  // Feed the measured outcomes back into the dataset so the app can say when a
  // link was last actually checked, instead of every resource claiming the same
  // thing forever. `ok`/`redirected` mean "reachable when checked"; `blocked`
  // and `failed` are recorded as-is and keep the resource at `community`.
  const verification: Record<string, { outcome: CheckResult['outcome']; status: number | null; checkedAt: string; url: string }> = {}
  for (const result of [...results].sort((a, b) => a.id.localeCompare(b.id))) {
    const current = knowledgeGraph.resources.find((resource) => resource.id === result.id)
    verification[result.id] = {
      outcome: result.outcome,
      status: result.status,
      checkedAt: checkedAt,
      url: current?.url ?? result.url,
    }
  }
  const verificationPath = resolve(root, 'src/data/seed/resourceVerification.json')
  writeFileSync(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, 'utf8')
  console.log('Wrote src/data/seed/resourceVerification.json (run npm run emit:cypher afterwards)')

  if (totals.ok + totals.redirected === 0) {
    console.warn(
      '\nNo link could be reached from this machine. That usually means outbound network access is\n' +
        'blocked in this environment rather than every provider being down — the report records what\n' +
        'happened so it can be re-run somewhere with normal internet access.',
    )
  }

  if (strict && totals.failed + totals.timeout > 0) {
    console.error('\n--strict: some links failed. See the report.')
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error('Resource verification crashed:', error instanceof Error ? error.message : error)
  process.exit(1)
})


