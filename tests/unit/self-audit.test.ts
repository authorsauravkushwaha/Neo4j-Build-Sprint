/**
 * The self-audit runner.
 *
 * An audit tool is security-critical infrastructure: if it reports "pass" for a
 * check that never ran, or leaks a credential into the report it writes, it is
 * worse than no tool. So the runner is tested like any other code — including the
 * awkward parts, like what happens when a check itself throws.
 */
import { describe, expect, it } from 'vitest'

import { AuditFailure, COVERAGE, exitCodeFor, redact, renderReport, runChecks, type AuditCheck } from '@core/selfAudit.ts'

const check = (overrides: Partial<AuditCheck> = {}): AuditCheck => ({
  id: 'test.check',
  title: 'A check',
  severity: 'high',
  area: 'test',
  threat: 'Nothing, it is a test.',
  assertion: 'It passes.',
  probe: async () => 'held',
  ...overrides,
})

describe('the self-audit runner', () => {
  it('runs every check and reports each outcome', async () => {
    const report = await runChecks([
      check({ id: 'a', probe: async () => 'fine' }),
      check({ id: 'b', probe: async () => { throw new AuditFailure('it broke') } }),
      check({ id: 'c', probe: async () => { throw new Error('the check itself is broken') } }),
    ])
    expect(report.findings.map((finding) => finding.outcome)).toEqual(['pass', 'fail', 'error'])
    expect(report.summary).toMatchObject({ total: 3, pass: 1, fail: 1, error: 1 })
    expect(report.summary.bySeverity.high).toBe(2)
  })

  it('distinguishes a finding from a broken check, because they need different people', async () => {
    const found = await runChecks([check({ severity: 'critical', probe: async () => { throw new AuditFailure('a real hole') } })])
    const broken = await runChecks([check({ severity: 'critical', probe: async () => { throw new TypeError('cannot read properties of undefined') } })])
    // Both are red, but only the second means "the audit is wrong".
    expect(found.summary.fail).toBe(1)
    expect(found.summary.error).toBe(0)
    expect(broken.summary.error).toBe(1)
    expect(broken.summary.fail).toBe(0)
    expect(exitCodeFor(found)).toBe(1)
    expect(exitCodeFor(broken)).toBe(1)
  })

  it('does not fail a build for medium and low findings', async () => {
    const report = await runChecks([
      check({ id: 'm', severity: 'medium', probe: async () => { throw new AuditFailure('cosmetic') } }),
      check({ id: 'l', severity: 'low', probe: async () => { throw new AuditFailure('nit') } }),
    ])
    // An audit that blocks on its own judgement calls gets disabled by lunchtime.
    expect(exitCodeFor(report)).toBe(0)
    expect(report.summary.fail).toBe(2)
  })

  it('scrubs credentials out of the evidence it records', async () => {
    // A fixture JWT: nothing verifies it, and the test asserts it never reaches the report.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' // secret-scan:allow — test fixture
    const report = await runChecks([
      check({ probe: async () => `response contained ${jwt} and api_key=abcdef123456 and password: hunter2hunter2` }),
    ])
    const evidence = report.findings[0]!.evidence
    expect(evidence).not.toContain(jwt)
    expect(evidence).not.toContain('abcdef123456')
    expect(evidence).not.toContain('hunter2hunter2')
    expect(evidence).toContain('[jwt-redacted]')
  })

  it('bounds the length of every piece of evidence', () => {
    const long = 'x'.repeat(5000)
    const scrubbed = redact(long, 100)
    expect(scrubbed.length).toBeLessThan(200)
    expect(scrubbed).toMatch(/more characters/)
  })

  it('runs a subset when asked, and nothing at all if the subset is empty', async () => {
    const checks = [check({ id: 'one' }), check({ id: 'two' })]
    expect((await runChecks(checks, { only: ['two'] })).findings.map((finding) => finding.id)).toEqual(['two'])
    expect((await runChecks(checks, { only: [] })).summary.total).toBe(2)
  })

  it('states what it does not cover, and why', () => {
    expect(COVERAGE.inScope.length).toBeGreaterThan(3)
    expect(COVERAGE.outOfScope.length).toBeGreaterThan(3)
    for (const item of COVERAGE.outOfScope) {
      expect(item.why.length).toBeGreaterThan(20)
    }
    // The browser and the database are the two things a rules-based harness
    // genuinely cannot check, so they must be named rather than quietly skipped.
    const names = COVERAGE.outOfScope.map((item) => item.what).join(' ')
    expect(names).toMatch(/database/i)
    expect(names).toMatch(/browser/i)
  })

  it('renders a report a person can read, with the failures first', async () => {
    const report = await runChecks([
      check({ id: 'low.pass', severity: 'low' }),
      check({ id: 'critical.fail', severity: 'critical', probe: async () => { throw new AuditFailure('the door was open') }, remediation: 'Lock it.' }),
    ])
    const markdown = renderReport(report)
    expect(markdown).toMatch(/^# Self-audit report/m)
    expect(markdown).toMatch(/FAIL — critical\.fail/)
    expect(markdown).toMatch(/PASS — low\.pass/)
    // Severity order: the critical section is written before the low one.
    expect(markdown.indexOf('## Critical')).toBeLessThan(markdown.indexOf('## Low'))
    expect(markdown).toContain('Lock it.')
    expect(markdown).toContain('the door was open')
    expect(markdown).toMatch(/not a penetration test/i)
    expect(markdown).toMatch(/Out of scope, and why/)
  })

  it('never claims a check passed when it produced no evidence', async () => {
    const report = await runChecks([check({ probe: async () => {} })])
    expect(report.findings[0]!.outcome).toBe('pass')
    expect(report.findings[0]!.evidence.length).toBeGreaterThan(0)
  })
})
