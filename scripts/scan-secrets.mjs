#!/usr/bin/env node
/**
 * Secret scanner for the repository (frontend, Edge Functions, scripts, docs).
 *
 *   npm run lint:secrets
 *
 * It looks for credential *shapes* rather than the words "password" or "key",
 * because lesson text legitimately explains those words. Findings are printed
 * with file, line and a redacted preview. Exit code 1 when anything is found, so
 * it can be wired into CI before a deploy.
 *
 * Known-safe placeholders in `.env.example` files are allow-listed explicitly —
 * a scanner that cries wolf gets switched off.
 *
 * It also makes a second pass over `dist/` — the actual bytes a browser
 * downloads. Source scanning cannot see what Vite inlines, and an env key that
 * leaked into the bundle would be readable by every visitor, so the built output
 * is checked separately and reported separately.
 *
 * Two deliberate escape hatches, both visible in the output rather than silent:
 *
 *   `secret-scan:allow`   as a comment (`//` or `#`) on a line of source exempts
 *                         that line (test fixtures). The number of exempted lines
 *                         is always printed, so exemptions stay visible — and the
 *                         marker is only honoured in code files, so documentation
 *                         *about* the marker is not mistaken for one.
 *   `ALLOW_PATTERNS`      recognises placeholder *shapes* repo-wide.
 *
 * And a canary: `scripts/secret-scan-canary.mjs` holds planted secrets that must
 * be caught plus real placeholders that must not be. If the rules ever stop
 * matching, the canary fails the run instead of reporting a clean sweep.
 */

import { CANARY_FIXTURES } from './secret-scan-canary.mjs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.cache',
  'android',
  '.gradle',
  'ios',
  '.idea',
  '.vscode',
  'out',
  'target',
  '__pycache__',
])

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml',
  '.html', '.css', '.sql', '.cypher', '.sh', '.env', '.example', '.xml', '.toml',
])

/** Files whose whole purpose is to document placeholder values. */
const PLACEHOLDER_FILES = new Set(['.env.example', '.env.sample', '.env.template'])

const RULES = [
  {
    name: 'JWT-shaped token',
    // Supabase anon/service keys and any other JWT.
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    detail: 'A JSON Web Token is embedded here. Rotate it and move it to a secret store.',
  },
  {
    name: 'PEM private key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    detail: 'Private key material must never be committed.',
  },
  {
    name: 'Provider API key',
    pattern: /\b(?:sk|pk|rk)-(?:live|test)?[-_A-Za-z0-9]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{30,}\b/g,
    detail: 'Looks like a live API key from a known provider.',
  },
  {
    name: 'Credentials inside a URL',
    // Inclusive of the host, so the allow-list below can recognise reserved
    // example domains and placeholder user/password pairs.
    pattern: /(?:https?|bolt|neo4j|postgres(?:ql)?|mysql):\/\/[^\s:'"`]+:[^\s:@'"`]{3,}@[^\s/'"`]+/g,
    detail: 'A connection string with an inline password. Use environment variables instead.',
  },
  {
    name: 'Assigned secret value',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|service[_-]?role[_-]?key)\b\s*[:=]\s*["'][^"'\s]{12,}["']/gi,
    detail: 'A non-trivial value is assigned to a secret-looking name.',
    /**
     * Minified bundles are full of key names echoed as values:
     * `access_token:"access_token"` is a symbol, not a credential. The value is
     * only suspicious when it is something *other* than the name it is assigned
     * to, so that specific shape is skipped — everywhere, not just in dist.
     */
    allowMatch(value) {
      const match = /([A-Za-z][\w-]*)\s*[:=]\s*["']([^"'\s]{12,})["']/.exec(value)
      if (!match) return false
      const normalise = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
      return normalise(match[1]) === normalise(match[2])
    },
  },
]

/** Extensions that may carry a deliberate exemption marker. */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/** Extensions worth reading inside `dist/` (build output, not source). */
const DIST_EXT = new Set(['.js', '.css', '.html', '.json', '.txt', '.svg', '.webmanifest', '.xml'])

const ALLOW_PATTERNS = [
  /REPLACE_WITH/i,
  /YOUR_[A-Z_]+/i,
  /<[^>]+>/,
  /\$\{?[A-Z_0-9]+\}?/,
  /process\.env\./,
  /import\.meta\.env\./,
  /Deno\.env\.get/,
  /env\('[A-Z_0-9]+'\)/,
  /^\s*(?:\/\/|\*|#)/,
  /example\.com|YOUR_PROJECT|YOUR_INSTANCE_ID/i,
  // Documentation placeholders: `https://user:pass@host` style examples.
  /\/\/(?:user|username|USER|USERNAME):(?:pass|password|PASS|PASSWORD)@/,
  /\b(?:localhost|127\.0\.0\.1|host|instance|example)\b/i,
  /*
   * Genuinely placeholder-shaped values. Note what is *not* here anymore: an
   * earlier version allow-listed any match containing the bare words
   * "password"/"secret"/"token", on the theory that prose about secrets should
   * not trip the scanner. But every match of the assigned-secret rule contains
   * its own key name, so that pattern waved through an obvious test password, a
   * 32-character secret and an opaque access token — i.e. it silenced precisely
   * the leaks the rule exists to find. The allow-list now matches on placeholder
   * *shape* only, and `tests/unit/*` lines that deliberately hold fake secrets
   * carry an explicit `secret-scan:allow` marker instead.
   */
  /\b(?:your|my|the)[-_ ]?(?:own)?[-_ ]?(?:password|secret|token|key)\b/i,
  /\b(?:change[-_ ]?me|replace[-_ ]?me|placeholder|redacted|dummy|fake|sample|example|todo)\b/i,
  /\bxxx+\b|\.\.\.|<\w+>|\*{3,}|\[\[|\]\]/i,
]

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      walk(full, out)
    } else if (stats.isFile()) {
      if (stats.size > 2 * 1024 * 1024) continue
      const ext = extname(entry).toLowerCase()
      if (!TEXT_EXT.has(ext) && !PLACEHOLDER_FILES.has(entry) && !entry.startsWith('.env')) continue
      out.push(full)
    }
  }
  return out
}

function redact(value) {
  const trimmed = value.slice(0, 120)
  if (trimmed.length <= 12) return '<redacted>'
  return `${trimmed.slice(0, 6)}…<redacted:${trimmed.length} chars>`
}

/**
 * Scan one file's text and return findings, without touching the exit code.
 * The returned `exempted` count keeps a deliberate `secret-scan:allow` visible.
 */
function scanText(rel, name, text) {
  const found = []
  let exempted = 0
  /*
   * Two details that keep the exemption honest:
   *   - it only counts as a *comment* (`// …` or `# …`), so the marker can never
   *     be smuggled in as a string value;
   *   - this file never exempts itself, because its own documentation and the
   *     hint it prints both name the marker. Without that, the scanner counts
   *     its own prose as exemptions — which is what it did before this comment
   *     existed, reporting 9 where the repository has 3.
   */
  const selfScan = rel === 'scripts/scan-secrets.mjs'
  // Only source lines can be exempted: prose *about* the marker (this project's
  // own security documentation, for instance) must not count as an exemption, and
  // a credential hiding in a Markdown file should never be silenceable.
  const exemptable = !selfScan && CODE_EXT.has(extname(rel).toLowerCase())
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (exemptable && /(?:\/\/|#)[^\n]*secret-scan:allow/.test(line)) {
      exempted += 1
      continue
    }
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0
      let match
      while ((match = rule.pattern.exec(line)) !== null) {
        const value = match[0]
        const allowed =
          ALLOW_PATTERNS.some((pattern) => pattern.test(value)) ||
          PLACEHOLDER_FILES.has(name) ||
          rule.allowMatch?.(value) === true
        if (allowed) continue
        found.push({
          file: rel,
          line: index + 1,
          rule: rule.name,
          detail: rule.detail,
          preview: redact(value),
        })
      }
    }
  }
  return { findings: found, exempted }
}

const findings = []
let exemptedLines = 0
const files = walk(root)

for (const file of files) {
  const rel = relative(root, file)
  // Generated Cypher and lockfiles are large and contain no credentials by
  // construction; skipping them keeps the output readable.
  if (rel === 'package-lock.json') continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const scanned = scanText(rel, basename(file), text)
  findings.push(...scanned.findings)
  exemptedLines += scanned.exempted
}

/*
 * Second pass: the built bundle. `walk` skips `dist/` so the source count stays
 * stable, but the browser only ever sees `dist/` — so it is scanned too, with
 * the same rules, and reported on its own line.
 */
const distDir = join(root, 'dist')
let distFiles = 0
if (existsSync(distDir)) {
  const distTargets = []
  const collectDist = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stats = statSync(full)
      if (stats.isDirectory()) {
        if (entry === 'icons') continue
        collectDist(full)
        continue
      }
      if (!stats.isFile()) continue
      if (!DIST_EXT.has(extname(entry).toLowerCase()) && entry !== '_headers') continue
      if (stats.size > 4 * 1024 * 1024) continue
      distTargets.push(full)
    }
  }
  collectDist(distDir)
  for (const file of distTargets) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    distFiles += 1
    findings.push(...scanText(relative(root, file), basename(file), text).findings)
  }
}

/*
 * Canary: prove the rules still match what they are supposed to match. Run
 * before reporting anything clean, so a blind scanner can never report a pass.
 */
const canaryMisses = []
for (const entry of CANARY_FIXTURES) {
  const { findings: hits } = scanText('<canary>', 'canary.ts', entry.fixture)
  const caught = hits.length > 0
  const wanted = entry.expect === 'caught'
  if (caught !== wanted) canaryMisses.push({ ...entry, caught })
}

if (canaryMisses.length > 0) {
  console.error('Secret scan canary FAILED — the rules no longer classify known fixtures correctly:\n')
  for (const miss of canaryMisses) {
    console.error(`  ${miss.expect === 'caught' ? 'expected a catch but found nothing:' : 'expected silence but flagged:'} ${miss.label}`)
    console.error(`      fixture: ${miss.fixture}`)
  }
  console.error('\nThe scan below cannot be trusted until the canary passes. See scripts/secret-scan-canary.mjs.')
  process.exit(1)
}

const canaryLine = `Rule canary: ${CANARY_FIXTURES.length}/${CANARY_FIXTURES.length} fixtures classified correctly (planted secrets caught, placeholders left alone).`

if (findings.length === 0) {
  console.log(`Secret scan clean: ${files.length} source file(s) checked, no credential-shaped strings found.`)
  console.log(canaryLine)
  if (exemptedLines > 0) {
    console.log(
      `  ${exemptedLines} line(s) carry an explicit secret-scan:allow comment (review with: grep -rn -e '// secret-scan:allow' -e '# secret-scan:allow' src tests).`,
    )
  }
  if (existsSync(distDir)) {
    if (distFiles === 0) {
      console.error('Secret scan error: dist/ exists but no built files were readable — the bundle pass would be blind.')
      process.exit(1)
    }
    console.log(`Built bundle clean: ${distFiles} file(s) under dist/ checked, nothing a visitor could read as a credential.`)
  }
  process.exit(0)
}

console.error(`Secret scan found ${findings.length} potential issue(s):\n`)
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]  ${finding.preview}`)
  console.error(`      ${finding.detail}`)
}
console.error('\nThree ways out, in order of preference:')
console.error('  1. Remove the credential and read it from the environment.')
console.error('  2. For a deliberate fake (a test fixture), append `secret-scan:allow` to the line.')
console.error('  3. For a documented placeholder shape, add a pattern to ALLOW_PATTERNS.')
console.error(`\n${canaryLine}`)
process.exit(1)


