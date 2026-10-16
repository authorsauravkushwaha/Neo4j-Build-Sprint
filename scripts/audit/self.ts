/**
 * `npm run audit:self` — the adversarial self-audit.
 *
 * It runs every check in `scripts/audit/checks.ts` against the handlers this
 * repository ships, in-process, and writes two artefacts:
 *
 *   docs/security-self-audit.md     the committed report, readable by a person
 *   tmp/security-self-audit.json    the machine-readable run, for diffs in CI
 *
 * Why there is no `--target` flag. A harness that can be pointed at a host is a
 * scanner, and a scanner pointed at somebody else's host is a legal and ethical
 * problem waiting to happen. This tool's job is to answer one question — "does the
 * code in this repository hold when somebody hostile calls it" — and that question
 * is answerable without a socket. The report says so in its own coverage section,
 * so nobody mistakes it for a penetration test.
 *
 * Exit code: non-zero when a critical or high check does not pass. Medium and low
 * findings are reported without failing the build, because an audit that blocks on
 * its own judgement calls is an audit somebody will disable.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { exitCodeFor, renderReport, runChecks, type AuditReport } from '../../supabase/functions/_shared/core/selfAudit.ts'
import { AUDIT_CHECKS } from './checks.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

interface Args {
  json: boolean
  only: string[]
  report: string | null
  machine: string | null
  quiet: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, only: [], report: resolve(root, 'docs/security-self-audit.md'), machine: resolve(root, 'tmp/security-self-audit.json'), quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--json') args.json = true
    else if (flag === '--quiet') args.quiet = true
    else if (flag === '--only' && value) args.only.push(...value.split(',').map((entry) => entry.trim()))
    else if (flag === '--report' && value) args.report = value === 'none' ? null : resolve(process.cwd(), value)
    else if (flag === '--machine' && value) args.machine = value === 'none' ? null : resolve(process.cwd(), value)
    else if (flag === '--help' || flag === '-h') {
      process.stdout.write(
        [
          'npm run audit:self -- [options]',
          '',
          '  --json                 print the report as JSON instead of a table',
          '  --only <id,id>         run a subset of checks (ids come from the table)',
          '  --report <path|none>   where to write the markdown report (default docs/security-self-audit.md)',
          '  --machine <path|none>  where to write the JSON report (default tmp/security-self-audit.json)',
          '  --quiet                print only the summary line',
          '',
          'There is no --target: this harness calls the handlers in-process and never opens a socket.',
          '',
        ].join('\n'),
      )
      process.exit(0)
    }
  }
  return args
}

function printTable(report: AuditReport): void {
  const width = Math.max(...report.findings.map((finding) => finding.id.length))
  for (const finding of report.findings) {
    const badge = finding.outcome === 'pass' ? 'PASS ' : finding.outcome === 'fail' ? 'FAIL ' : 'ERROR'
    process.stdout.write(`${badge} ${finding.severity.padEnd(8)} ${finding.id.padEnd(width)}  ${finding.evidence.slice(0, 90)}\n`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const started = Date.now()
  const report = await runChecks(AUDIT_CHECKS, { only: args.only })
  const durationMs = Date.now() - started

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...report, durationMs }, null, 2)}\n`)
  } else if (!args.quiet) {
    printTable(report)
    process.stdout.write('\n')
  }

  if (!args.json) {
    const { summary } = report
    process.stdout.write(
      `Self-audit: ${summary.pass}/${summary.total} checks passed in ${durationMs}ms` +
        ` (${summary.fail} failed, ${summary.error} errored; critical+high failures: ${summary.bySeverity.critical + summary.bySeverity.high}).\n`,
    )
    for (const finding of report.findings.filter((entry) => entry.outcome !== 'pass')) {
      process.stdout.write(`  ! ${finding.id}: ${finding.evidence}\n`)
      if (finding.remediation) process.stdout.write(`    fix: ${finding.remediation}\n`)
    }
  }

  const markdown = renderReport(report)
  if (args.report) {
    mkdirSync(dirname(args.report), { recursive: true })
    writeFileSync(args.report, markdown, 'utf8')
    if (!args.json) process.stdout.write(`Wrote ${args.report}\n`)
  }
  if (args.machine) {
    mkdirSync(dirname(args.machine), { recursive: true })
    writeFileSync(args.machine, `${JSON.stringify({ ...report, durationMs }, null, 2)}\n`, 'utf8')
    if (!args.json) process.stdout.write(`Wrote ${args.machine}\n`)
  }

  process.exitCode = exitCodeFor(report)
}

void main().catch((error: unknown) => {
  process.stderr.write(`The self-audit could not run: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
