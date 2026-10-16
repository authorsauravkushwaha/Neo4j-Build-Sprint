/**
 * The self-audit runner.
 *
 * `vxcontrol/pentagi` is an autonomous penetration-testing agent: it plans,
 * probes, observes and reports, and the interesting part of that architecture is
 * not the offences it can commit but the discipline — a plan, a record of what was
 * actually sent, and a report that distinguishes "checked and held" from "not
 * checked".
 *
 * This file is the runner half of that discipline, applied to our own code. The
 * checks live in `scripts/audit/checks.ts` and run **in-process against the
 * handlers this repository ships**, not against a host on the network. That is a
 * deliberate limit, and the report says so: a tool that can be pointed at someone
 * else's server is a liability, and this one has no `--target` flag at all.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. **Every check reports, including the ones that pass.** A report that only
 *      lists failures cannot distinguish "nothing found" from "nothing ran".
 *   2. **Evidence is redacted and bounded.** A check that captures a response body
 *      records a truncated, secret-scrubbed excerpt, because an audit report gets
 *      pasted into issues and tickets.
 *   3. **A check is a promise.** It declares what it asserts, and if it throws, the
 *      audit records `error` rather than `pass` — an audit that treats a crashed
 *      check as green is worse than no audit.
 */

export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low'

export type AuditOutcome = 'pass' | 'fail' | 'error'

export interface AuditFinding {
  /** Stable id, so a report can be compared with yesterday's. */
  id: string
  title: string
  severity: AuditSeverity
  /** Which part of the product this concerns, e.g. "authorisation". */
  area: string
  /** What an attacker would gain if this check failed. */
  threat: string
  /** What the check promises: stated before the result, not after. */
  assertion: string
  outcome: AuditOutcome
  /** What was observed, redacted and truncated. */
  evidence: string
  /** What to do about it, present whenever the outcome is not `pass`. */
  remediation?: string
  /** Wall-clock cost of the check, so a slow probe is visible. */
  ms: number
}

export interface AuditCheck {
  id: string
  title: string
  severity: AuditSeverity
  area: string
  threat: string
  assertion: string
  /** Passes when it resolves without throwing; throws to report a failure. */
  probe: () => Promise<string | void>
  /** Remediation shown when the probe throws. */
  remediation?: string
}

export interface AuditReport {
  generatedAt: string
  /** Checks the harness does not perform, with the reason. Never empty. */
  coverage: { inScope: string[]; outOfScope: Array<{ what: string; why: string }> }
  findings: AuditFinding[]
  summary: { total: number; pass: number; fail: number; error: number; bySeverity: Record<AuditSeverity, number> }
}

const SEVERITY_ORDER: AuditSeverity[] = ['critical', 'high', 'medium', 'low']

/** Anything that looks like a credential is scrubbed before it is recorded. */
export function redact(value: string, maxLength = 600): string {
  const scrubbed = value
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[jwt-redacted]')
    .replace(/\b(sb|sk|pk)_(live|test)?_?[A-Za-z0-9]{12,}/g, '[key-redacted]')
    .replace(/(service[_-]?role|api[_-]?key|password|secret)["'\s:=]+[^\s"',}]{6,}/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}… (${scrubbed.length - maxLength} more characters)` : scrubbed
}

/**
 * Runs the checks.
 *
 * Sequential on purpose: rate-limit checks count requests, and a harness that
 * fires probes in parallel would be measuring its own concurrency rather than the
 * app's policy.
 */
export async function runChecks(checks: readonly AuditCheck[], options: { only?: string[]; now?: () => number } = {}): Promise<AuditReport> {
  const now = options.now ?? (() => Date.now())
  const selected = options.only && options.only.length > 0 ? checks.filter((check) => options.only!.includes(check.id)) : checks
  const findings: AuditFinding[] = []

  for (const check of selected) {
    const started = now()
    try {
      const evidence = await check.probe()
      findings.push({
        id: check.id,
        title: check.title,
        severity: check.severity,
        area: check.area,
        threat: check.threat,
        assertion: check.assertion,
        outcome: 'pass',
        evidence: redact(typeof evidence === 'string' ? evidence : 'Held as asserted.'),
        ms: now() - started,
      })
    } catch (error) {
      findings.push({
        id: check.id,
        title: check.title,
        severity: check.severity,
        area: check.area,
        threat: check.threat,
        assertion: check.assertion,
        outcome: error instanceof AuditFailure ? 'fail' : 'error',
        evidence: redact(error instanceof Error ? error.message : String(error)),
        ...(check.remediation ? { remediation: check.remediation } : {}),
        ms: now() - started,
      })
    }
  }

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 } as Record<AuditSeverity, number>
  for (const finding of findings) {
    if (finding.outcome !== 'pass') bySeverity[finding.severity] += 1
  }

  return {
    generatedAt: new Date(now()).toISOString(),
    coverage: COVERAGE,
    findings,
    summary: {
      total: findings.length,
      pass: findings.filter((finding) => finding.outcome === 'pass').length,
      fail: findings.filter((finding) => finding.outcome === 'fail').length,
      error: findings.filter((finding) => finding.outcome === 'error').length,
      bySeverity,
    },
  }
}

/**
 * Thrown by a probe to report a failed assertion.
 *
 * The distinction between this and any other error is the whole point: a check
 * that *found* something is a finding, and a check that *broke* is a bug in the
 * audit. Reporting both as "failed" would hide the second.
 */
export class AuditFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditFailure'
  }
}

/** Throws an `AuditFailure` unless the condition holds. */
export function expect(condition: boolean, message: string): void {
  if (!condition) throw new AuditFailure(message)
}

/** Throws an `AuditFailure` unless the actual value equals one of the allowed values. */
export function expectOneOf(actual: unknown, allowed: readonly unknown[], label: string): void {
  if (!allowed.includes(actual)) {
    throw new AuditFailure(`${label} was ${JSON.stringify(actual)}, expected one of ${allowed.map((value) => JSON.stringify(value)).join(', ')}`)
  }
}

/**
 * Exits non-zero when anything critical or high is not passing.
 *
 * Medium and low findings are printed and reported but do not break a build: an
 * audit that blocks on its own judgement calls gets disabled, and a disabled audit
 * protects nobody.
 */
export function exitCodeFor(report: AuditReport): number {
  return report.summary.bySeverity.critical > 0 || report.summary.bySeverity.high > 0 ? 1 : 0
}

/** What this harness covers, and — with equal prominence — what it does not. */
export const COVERAGE: AuditReport['coverage'] = {
  inScope: [
    'Authentication and authorisation on every handler this repository ships, including cross-user access attempts.',
    'Input handling: malformed JSON, oversized bodies, injection-shaped strings, prototype-pollution keys, unknown fields.',
    'Rate limiting and request-signing behaviour, driven through the real handler stack.',
    'Response hygiene: error codes without internals, security headers, cache directives, and whether any credential-shaped value reaches a response.',
    'The workflow engine as an attack surface: the reference grammar, the URL allow-list, and the run log.',
    'The second storage backend, where the ownership policy lives in code rather than in the database, and where the declared collections must match the tables the store actually uses.',
  ],
  outOfScope: [
    { what: 'Anything reachable only over the network', why: 'The checks call the handlers in-process. There is no --target flag, by design: this is a self-audit, not a scanner.' },
    { what: 'The database itself', why: 'Row-level security is verified separately by `npm run verify:rls` against a real Postgres, which is the only place it can be verified.' },
    { what: 'The browser', why: 'CSP behaviour, third-party script execution and clickjacking need a real browser: `npm run verify:browser`.' },
    { what: 'Dependency vulnerabilities', why: 'That is `npm audit` and Dependabot’s job; a rules-based harness would only duplicate it worse.' },
    { what: 'Timing side channels and statistical attacks', why: 'They need many samples and a stable host; a small probe would produce noise, not a finding.' },
    { what: 'The hosted Supabase platform', why: 'Auth, storage and the Postgres instance are somebody else’s audited surface. What is ours is the code above them.' },
  ],
}

/** Renders the report as the markdown that gets committed. */
export function renderReport(report: AuditReport): string {
  const lines: string[] = []
  lines.push('# Self-audit report')
  lines.push('')
  lines.push(`Generated by \`npm run audit:self\` at ${report.generatedAt}.`)
  lines.push('')
  lines.push(
    `**${report.summary.pass} of ${report.summary.total} checks passed** — ${report.summary.fail} failed, ${report.summary.error} errored. ` +
      `Critical and high findings: ${report.summary.bySeverity.critical + report.summary.bySeverity.high}.`,
  )
  lines.push('')
  lines.push('This is a self-audit, not a penetration test. It probes the code in this repository, in-process, with no network access. ')
  lines.push('It finds the classes of mistake that rules can find. It does not replace a human who is trying to break the thing.')
  lines.push('')

  for (const severity of SEVERITY_ORDER) {
    const group = report.findings.filter((finding) => finding.severity === severity)
    if (group.length === 0) continue
    lines.push(`## ${severity[0]!.toUpperCase()}${severity.slice(1)} (${group.length})`)
    lines.push('')
    for (const finding of group) {
      const badge = finding.outcome === 'pass' ? 'PASS' : finding.outcome === 'fail' ? 'FAIL' : 'ERROR'
      lines.push(`### ${badge} — ${finding.id}: ${finding.title}`)
      lines.push('')
      lines.push(`- **Area:** ${finding.area}`)
      lines.push(`- **Threat if it failed:** ${finding.threat}`)
      lines.push(`- **Assertion:** ${finding.assertion}`)
      lines.push(`- **Evidence:** ${finding.evidence}`)
      if (finding.remediation) lines.push(`- **Remediation:** ${finding.remediation}`)
      lines.push(`- **Cost:** ${finding.ms}ms`)
      lines.push('')
    }
  }

  lines.push('## Coverage')
  lines.push('')
  lines.push('### In scope')
  lines.push('')
  for (const item of report.coverage.inScope) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Out of scope, and why')
  lines.push('')
  for (const item of report.coverage.outOfScope) lines.push(`- **${item.what}** — ${item.why}`)
  lines.push('')
  lines.push('## Reproducing')
  lines.push('')
  lines.push('```bash')
  lines.push('npm run audit:self                 # run every check, print a table')
  lines.push('npm run audit:self -- --json       # the same run as JSON')
  lines.push('npm run audit:self -- --only authz.no-cross-user-read')
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}
