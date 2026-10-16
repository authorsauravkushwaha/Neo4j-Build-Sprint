#!/usr/bin/env node
/** Supplemental history scan. Metadata only: never print matched credentials.
 * This is intentionally narrower than scan-secrets.mjs: known provider-key,
 * JWT and private-key shapes in every reachable text blob, including deleted
 * files. It cannot prove that arbitrary passwords/PII were never committed.
 */
import { execFileSync } from 'node:child_process'

const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 })
if (git('rev-parse', '--is-shallow-repository').toString().trim() === 'true') {
  console.error('History scan incomplete: shallow checkout. Fetch full history first (CI: fetch-depth: 0).')
  process.exit(2)
}
const rules = [
  ['provider key', /\b(?:sk|rk)-(?:live|test)?[-_A-Za-z0-9]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]
let scanned = 0
let exempted = 0
const findings = []
const seen = new Set()
for (const object of git('rev-list', '--objects', '--all').toString().trim().split('\n')) {
  const space = object.indexOf(' ')
  if (space < 0) continue
  const oid = object.slice(0, space)
  const path = object.slice(space + 1)
  if (seen.has(oid)) continue
  seen.add(oid)
  if (git('cat-file', '-t', oid).toString().trim() !== 'blob') continue
  if (Number(git('cat-file', '-s', oid).toString()) > 2 * 1024 * 1024) continue
  const bytes = git('cat-file', 'blob', oid)
  if (bytes.includes(0)) continue
  scanned++
  bytes.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    for (const [rule, pattern] of rules) {
      if (!pattern.test(line)) continue
      if (path.startsWith('tests/') && new RegExp('(?://|#)[^\\n]*' + ['secret-scan', 'allow'].join(':')).test(line)) {
        exempted++
        continue
      }
      findings.push({ blob: oid.slice(0, 12), path, line: i + 1, rule })
    }
  })
}
const commits = git('rev-list', '--all', '--count').toString().trim()
console.log(JSON.stringify({ commits: Number(commits), textBlobsScanned: scanned, explicitlyExemptedTestMatches: exempted, findings }, null, 2))
process.exitCode = findings.length ? 1 : 0
