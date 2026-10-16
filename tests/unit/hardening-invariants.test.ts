/**
 * Hardening invariants.
 *
 * Three claims in this project are the kind that quietly stop being true: "there
 * is no upload surface", "every Cypher query is parameterised", and "the browser
 * bundle cannot contain a server secret". Each is easy to believe and easy to
 * break with an innocent-looking change, so each gets a test that reads the
 * actual source (and, where it matters, the actual build output) instead of
 * trusting a comment.
 *
 * The point is not coverage for its own sake. It is that the *claims the UI
 * makes to a learner* are checked against the code they describe — a discipline
 * this codebase applies everywhere else and should apply to its security surface
 * too.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { QUERY_CATALOG } from '@core/graphQuery.ts'
import { readConfig } from '@/core/env.ts'

// Same convention as tests/unit/docs.test.ts: resolve from the test file.
const root = resolve(__dirname, '../..')

/** Every .ts/.tsx file under a directory, skipping build output and deps. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  const skip = new Set(['node_modules', 'dist', 'coverage', '.vite', 'android', 'ios'])
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const sources = [
  ...sourceFiles(join(root, 'src')),
  ...sourceFiles(join(root, 'supabase')),
  ...sourceFiles(join(root, 'tests')),
]

describe('there is no file-upload surface (and the claim says so)', () => {
  /*
   * The landing page states this in as many words: "There is no upload endpoint,
   * no storage bucket and no file input anywhere in the app." That is the
   * strongest form of file-upload security — you cannot exploit a parser that is
   * not there — but only for as long as it stays true. If someone adds a file
   * input, this fails and the claim gets revisited rather than silently lying.
   */
  const read = (file: string): string => readFileSync(file, 'utf8')

  it('no component renders a file input', () => {
    const offenders = sources
      .filter((file) => !file.endsWith('hardening-invariants.test.ts'))
      .filter((file) => /type=\{?["']file["']\}?/.test(read(file)))
    expect(offenders.map((file) => relative(root, file))).toEqual([])
  })

  it('nothing client-side builds a FormData or multipart request', () => {
    const offenders = sources
      .filter((file) => !file.endsWith('hardening-invariants.test.ts'))
      .filter((file) => /\bnew FormData\(|multipart\/form-data/i.test(read(file)))
    expect(offenders.map((file) => relative(root, file))).toEqual([])
  })

  it('no Edge Function reads files, writes files, or opens a storage bucket', () => {
    const edgeFiles = sourceFiles(join(root, 'supabase'))
    const offenders = edgeFiles.filter((file) => /\bDeno\.(readTextFile|writeTextFile|open|mkdir)\b|\.storage\.from\(/.test(read(file)))
    expect(offenders.map((file) => relative(root, file))).toEqual([])
  })

  it('the landing page still carries the claim this test defends', () => {
    const landing = read(join(root, 'src/features/landing/LandingPage.tsx'))
    expect(landing).toMatch(/no upload endpoint/i)
    expect(landing).toMatch(/no storage bucket/i)
  })
})

describe('every shipped Cypher query is static text with bound parameters', () => {
  /*
   * Neo4j's Query API does not parameterise labels or relationship types, so the
   * only safe construction is: the query text is a literal, and every value that
   * varies arrives as `$param`. This asserts the shipped catalogue never
   * interpolates anything — which is what makes the "no injection" claim about
   * the graph layer structural rather than aspirational.
   */
  const queries = Object.entries(QUERY_CATALOG)

  it('ships a non-trivial catalogue', () => {
    expect(queries.length).toBeGreaterThanOrEqual(20)
  })

  it('contains no template interpolation and no string concatenation', () => {
    const offenders: string[] = []
    for (const [name, text] of queries) {
      if (typeof text !== 'string') continue
      if (text.includes('${')) offenders.push(`${name}: template interpolation`)
      if (/["'`]\s*\+\s*[A-Za-z_$]/.test(text)) offenders.push(`${name}: string concatenation`)
    }
    expect(offenders).toEqual([])
  })

  it('bounds result sets with $limit, allowing only LIMIT 1 for single-entity lookups', () => {
    // A cardinality bound must come from a parameter so no caller — and no future
    // edit — can silently raise it to a table-scanning number. The one literal
    // that is allowed is `LIMIT 1`, which is how the four single-entity lookups
    // (one career, one skill, one project, one resource) say "at most one row".
    const offenders: string[] = []
    for (const [name, text] of queries) {
      if (typeof text !== 'string') continue
      for (const clause of text.match(/LIMIT\s+[^\n]*/g) ?? []) {
        const trimmed = clause.trim()
        if (trimmed === 'LIMIT $limit' || /^LIMIT 1\b/.test(trimmed)) continue
        offenders.push(`${name}: ${trimmed}`)
      }
    }
    expect(offenders).toEqual([])
    // Sanity: the parameterised bound really is the common case.
    const parameterised = queries.filter(([, text]) => typeof text === 'string' && text.includes('LIMIT $limit'))
    expect(parameterised.length).toBeGreaterThanOrEqual(12)
  })
})

describe('the browser bundle cannot receive a server secret', () => {
  /*
   * Vite inlines `VITE_*` values into the bundle. Anything else in the
   * environment is not supposed to reach the client at all — so `readConfig`
   * must ignore keys it does not know, even if a misconfigured build passes the
   * whole environment through. This test pins that against a future refactor
   * that spreads `env` into the config "for convenience".
   */
  it('ignores non-VITE keys even when they are present in the environment', () => {
    const config = readConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'public-anon-key',
      // These must never appear in a client config, and must not be copied in.
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
      NEO4J_PASSWORD: 'neo4j-password-value',
      GM_SIGN_SECRET: 'signing-secret-value',
      AI_PROVIDER_API_KEY: 'provider-key-value',
    })
    const serialised = JSON.stringify(config)
    expect(serialised).not.toContain('service-role-value')
    expect(serialised).not.toContain('neo4j-password-value')
    expect(serialised).not.toContain('signing-secret-value')
    expect(serialised).not.toContain('provider-key-value')
    // And the known-public keys still work.
    expect(config.supabaseUrl).toBe('https://project.supabase.co')
    expect(config.apiBaseUrl).toBe('https://project.supabase.co/functions/v1')
  })

  it('the built bundle, when present, contains no secret-shaped strings', () => {
    const assets = join(root, 'dist/assets')
    if (!existsSync(assets)) {
      // The bundle is not built in every test run; the npm lint:secrets step
      // scans dist/ when it exists. Nothing to assert here in that case.
      expect(true).toBe(true)
      return
    }
    const shapes: Array<[string, RegExp]> = [
      ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
      ['connection string', /(?:neo4j|postgres(?:ql)?):\/\/[^\s"'`]+:[^\s"'`]+@/],
    ]
    const bundle = readdirSync(assets)
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(assets, file), 'utf8'))
      .join('\n')
    for (const [name, pattern] of shapes) {
      expect(pattern.test(bundle), `built bundle contains a ${name}`).toBe(false)
    }
  })
})

/* ==========================================================================
 * Content-Security-Policy: three copies, one policy
 * ======================================================================== */

/** Parse a policy string into directive → value(gits) tokens. */
function directivesOf(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const [name, ...rest] = trimmed.split(/\s+/)
    map.set(name.toLowerCase(), rest.map((token) => token.trim()).filter(Boolean))
  }
  return map
}

/** The same policy, sorted, so formatting differences cannot hide a real one. */
const canonical = (tokens: string[] | undefined) => [...(tokens ?? [])].sort().join(' ')

describe('the Content-Security-Policy cannot drift between its three copies', () => {
  /*
   * The policy ships in three places because three different delivery paths read
   * different files: the `<meta>` tag in index.html (used by the Capacitor/Android
   * WebView and by any host that ignores header files), `public/_headers` (copied
   * to dist/ for static hosts), and netlify.toml. Nothing forces them to agree, so
   * a directive tightened in one file and forgotten in the others is exactly the
   * kind of regression that never shows up until it matters. This test reads all
   * three and compares them directive by directive.
   */
  const htmlSource = readFileSync(join(root, 'index.html'), 'utf8')
  const headersSource = readFileSync(join(root, 'public/_headers'), 'utf8')
  const netlifySource = readFileSync(join(root, 'netlify.toml'), 'utf8')

  const metaPolicy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(htmlSource)?.[1]
  const headersPolicy = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(headersSource)?.[1]
  const netlifyPolicy = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(netlifySource)?.[1]

  /**
   * Directives whose values must be byte-identical wherever they appear.
   *
   * Two are deliberately absent. `connect-src` is deployment-specific: the meta
   * tag carries a build-time placeholder filled from the configured hosts, while
   * the header files carry the default hosts for whoever copies them. `style-src`
   * differs by mode — the dev server needs 'unsafe-inline' for Tailwind's HMR
   * runtime, the built artifact needs none of it — so the meta tag carries a
   * placeholder rather than a value, and the style directives are asserted
   * separately below.
   */
  const shared = [
    'default-src', 'script-src', 'img-src', 'font-src',
    'object-src', 'base-uri', 'form-action', 'frame-src', 'worker-src', 'manifest-src',
  ]

  it('finds a policy in all three files', () => {
    expect(metaPolicy, 'index.html meta tag').toBeTruthy()
    expect(headersPolicy, 'public/_headers').toBeTruthy()
    expect(netlifyPolicy, 'netlify.toml').toBeTruthy()
  })

  it('states the same value for every shared directive', () => {
    const copies: Array<[string, string]> = [
      ['index.html', metaPolicy ?? ''],
      ['public/_headers', headersPolicy ?? ''],
      ['netlify.toml', netlifyPolicy ?? ''],
    ]
    const seen = new Map<string, string>()
    for (const [label, policy] of copies) {
      const directives = directivesOf(policy)
      for (const name of shared) {
        expect(directives.has(name), `${label} is missing ${name}`).toBe(true)
        const value = canonical(directives.get(name))
        const previous = seen.get(name)
        if (previous === undefined) seen.set(name, value)
        else expect(value, `${label}: ${name} differs from the other copies`).toBe(previous)
      }
    }
  })

  it('the shipped header policy denies injected style elements outright', () => {
    // The build's style policy. style-src-elem is what stops an injected <style>
    // from adding rules; style-src-attr stays permissive only as the CSP-level-2
    // fallback, because that level cannot express the two separately.
    for (const [label, policy] of [['public/_headers', headersPolicy], ['netlify.toml', netlifyPolicy]] as const) {
      const directives = directivesOf(policy ?? '')
      expect(directives.get('style-src-elem'), `${label} style-src-elem`).toEqual(["'self'"])
      expect(directives.get('style-src-attr'), `${label} style-src-attr`).toEqual(["'unsafe-inline'"])
      expect(canonical(directives.get('style-src')), `${label} style-src must not allow inline styles`).not.toContain('unsafe-inline')
    }
  })

  it('the meta tag carries a style placeholder, so no mode can leak into the source', () => {
    // If the dev policy were written into index.html instead of a placeholder,
    // `npm run build` would ship it — the relaxation would reach production and
    // nothing would notice, because the page would still look right.
    expect(metaPolicy ?? '').toContain('__CSP_STYLE_SRC__')
    expect(metaPolicy ?? '').not.toContain('unsafe-inline')
  })

  it('the production meta tag matches the shipped header policy, directive for directive', () => {
    // Cross-file: the artifact a browser actually loads versus the headers a
    // static host sends. Compared on the built output when it exists.
    const builtHtml = join(root, 'dist/index.html')
    if (!existsSync(builtHtml)) {
      expect(true).toBe(true)
      return
    }
    const builtMeta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(builtHtml, 'utf8'))?.[1]
    expect(builtMeta, 'built meta tag').toBeTruthy()
    const built = directivesOf(builtMeta ?? '')
    const shipped = directivesOf(headersPolicy ?? '')
    for (const name of ['style-src', 'style-src-elem', 'style-src-attr', 'script-src', 'default-src', 'object-src', 'base-uri', 'form-action', 'frame-src', 'worker-src', 'manifest-src', 'img-src', 'font-src']) {
      expect(canonical(built.get(name)), `built meta ${name} must match public/_headers`).toBe(canonical(shipped.get(name)))
    }
    expect(canonical(built.get('style-src')), 'the built artifact must not allow inline styles').not.toContain('unsafe-inline')
  })

  it('never permits inline or eval script execution', () => {
    for (const [label, policy] of [['index.html', metaPolicy], ['public/_headers', headersPolicy], ['netlify.toml', netlifyPolicy]] as const) {
      const scriptSrc = canonical(directivesOf(policy ?? '').get('script-src'))
      expect(scriptSrc, `${label} script-src`).toBe("'self'")
      expect(policy ?? '', `${label} must not contain unsafe-eval anywhere`).not.toMatch(/unsafe-eval/)
      expect(directivesOf(policy ?? '').get('default-src'), `${label} default-src`).toEqual(["'self'"])
    }
  })

  it('denies plugin content, base-uri rewriting and form hijacking everywhere', () => {
    for (const [label, policy] of [['index.html', metaPolicy], ['public/_headers', headersPolicy], ['netlify.toml', netlifyPolicy]] as const) {
      const directives = directivesOf(policy ?? '')
      expect(directives.get('object-src'), `${label} object-src`).toEqual(["'none'"])
      expect(directives.get('base-uri'), `${label} base-uri`).toEqual(["'self'"])
      expect(directives.get('form-action'), `${label} form-action`).toEqual(["'self'"])
    }
  })

  it('blocks framing, using the directive each delivery path can express', () => {
    // A <meta> tag cannot express frame-ancestors, so the meta copy says
    // frame-src 'none' and the header copies say frame-ancestors 'none'.
    expect(directivesOf(metaPolicy ?? '').get('frame-src')).toEqual(["'none'"])
    for (const [label, policy] of [['public/_headers', headersPolicy], ['netlify.toml', netlifyPolicy]] as const) {
      expect(directivesOf(policy ?? '').get('frame-ancestors'), `${label} frame-ancestors`).toEqual(["'none'"])
      expect(directivesOf(policy ?? '').get('frame-src'), `${label} should also deny frame-src`).toEqual(["'none'"])
    }
  })

  it('the built meta tag covers every host the built headers allow', () => {
    // Catches the production-only drift: a host added to the static headers but
    // not to the build environment leaves the meta policy blocking that call.
    const builtHtml = join(root, 'dist/index.html')
    const builtHeaders = join(root, 'dist/_headers')
    if (!existsSync(builtHtml) || !existsSync(builtHeaders)) {
      expect(true).toBe(true) // not built in this run; lint:secrets covers dist separately
      return
    }
    const builtMeta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(builtHtml, 'utf8'))?.[1] ?? ''
    const builtHeaderPolicy = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(builtHeaders, 'utf8'))?.[1] ?? ''
    const metaHosts = new Set(directivesOf(builtMeta).get('connect-src') ?? [])
    for (const host of directivesOf(builtHeaderPolicy).get('connect-src') ?? []) {
      expect(metaHosts.has(host), `dist/index.html connect-src is missing ${host}, which dist/_headers allows`).toBe(true)
    }
    // And the placeholder really was substituted at build time.
    expect(builtMeta).not.toContain('__CSP_CONNECT_SRC__')
  })
})

describe('the static-host security headers agree across both files', () => {
  /*
   * The CSP is not the only header duplicated between `public/_headers` and
   * netlify.toml. Writing the CSP drift test is what revealed the rest: netlify.toml
   * was missing Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy, which
   * public/_headers had. Whichever host a deployment picks, the reply should carry
   * the same security headers, so the whole set is compared rather than the one
   * header that happened to be under a spotlight.
   */
  const REQUIRED = [
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'Strict-Transport-Security',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
  ]

  /** Parse one file's security headers into a normalised map. */
  const headersOf = (text: string, syntax: 'nginx' | 'toml') => {
    const map = new Map<string, string>()
    for (const line of text.split(/\r?\n/)) {
      const match =
        syntax === 'nginx'
          ? /^\s{2}([A-Za-z-]+):\s*(.+?)\s*$/.exec(line)
          : /^\s{4}([A-Za-z-]+)\s*=\s*"([^"]*)"\s*$/.exec(line)
      if (!match) continue
      const [, name, value] = match
      if (name === 'Cache-Control') continue
      map.set(name.toLowerCase(), value.trim())
    }
    return map
  }

  const fileHeaders = headersOf(readFileSync(join(root, 'public/_headers'), 'utf8'), 'nginx')
  const netlifyHeaders = headersOf(readFileSync(join(root, 'netlify.toml'), 'utf8'), 'toml')

  it('declares every required security header in both files', () => {
    for (const name of REQUIRED) {
      expect(fileHeaders.has(name.toLowerCase()), `public/_headers is missing ${name}`).toBe(true)
      expect(netlifyHeaders.has(name.toLowerCase()), `netlify.toml is missing ${name}`).toBe(true)
    }
  })

  it('gives each header the same value in both files', () => {
    for (const name of REQUIRED) {
      const key = name.toLowerCase()
      expect(netlifyHeaders.get(key), `${name} differs between public/_headers and netlify.toml`).toBe(fileHeaders.get(key))
    }
  })

  it('carries no stale directives that would undo the policy', () => {
    // A leftover permissive value is the classic way a hardened header silently
    // stops being one.
    for (const [label, map] of [['public/_headers', fileHeaders], ['netlify.toml', netlifyHeaders]] as const) {
      const permissions = map.get('permissions-policy') ?? ''
      for (const feature of ['camera', 'microphone', 'geolocation', 'usb', 'payment']) {
        expect(permissions, `${label} must deny ${feature}`).toContain(`${feature}=()`)
      }
      const referrer = map.get('referrer-policy') ?? ''
      expect(referrer, `${label} referrer policy`).not.toContain('unsafe-url')
      expect(referrer, `${label} referrer policy`).not.toBe('no-referrer-when-downgrade')
      const hsts = map.get('strict-transport-security') ?? ''
      expect(hsts, `${label} HSTS must include a max-age`).toMatch(/max-age=\d{6,}/)
    }
  })
})

describe('the app never asks the browser to compile code at runtime', () => {
  /*
   * `script-src 'self'` forbids dynamic code generation, and one dependency
   * tries it anyway: zod v4 probes for eval (a guarded `new Function("")`) to
   * decide whether it may use its JIT fast path. The probe is caught and zod
   * falls back correctly — but a strict CSP *reports the attempt*, so the browser
   * logged a securitypolicyviolation on every page load even though nothing was
   * broken. `src/core/zod-config.ts` sets zod's documented `jitless` flag, which
   * skips the probe entirely.
   *
   * The order matters and is the part that silently breaks: the probe fires
   * during module evaluation (the shared dataset modules build schemas at import
   * time), so the config has to be imported before them — which is why this test
   * checks the *position* of the import, not just its presence. The real proof is
   * in the browser suite (§10 reports zero violations on load); this keeps the
   * ordering from being undone by a tidy-looking import sort.
   */
  const mainSource = readFileSync(join(root, 'src/main.tsx'), 'utf8')
  const configSource = readFileSync(join(root, 'src/core/zod-config.ts'), 'utf8')

  it('configures zod for jitless mode', () => {
    expect(configSource).toMatch(/z\.config\(\{\s*jitless:\s*true\s*\}\)/)
  })

  it('imports that config before anything that builds a schema at load time', () => {
    const imports = [...mainSource.matchAll(/^import\s+'([^']+)'/gm)].map((match) => match[1])
    const index = mainSource.indexOf("import './core/zod-config.ts'")
    expect(index, 'main.tsx must import the zod config').toBeGreaterThanOrEqual(0)
    // No side-effect import may precede it.
    const firstSideEffect = imports[0]
    expect(firstSideEffect).toBe('./core/zod-config.ts')
    // And it must come before React and the app itself.
    expect(index).toBeLessThan(mainSource.indexOf("from 'react'"))
    expect(index).toBeLessThan(mainSource.indexOf("from './app/App.tsx'"))
  })
})

describe('outbound links cannot reach back through window.opener', () => {
  /*
   * Every external link in the app opens in a new tab. Without `noopener`, the
   * opened page can navigate the tab that opened it (reverse tabnabbing) — and the
   * pages linked here are third-party course sites, not ones this project
   * controls. `noreferrer` is included because the links are to someone else's
   * servers and the referrer adds nothing they need.
   */
  const files = sourceFiles(join(root, 'src')).filter((file) => file.endsWith('.tsx'))

  it('every target="_blank" carries rel="noopener"', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/<a\b[\s\S]{0,400}?\/?>/g)) {
        const tag = match[0]
        if (!/target=["']_blank["']/.test(tag)) continue
        const rel = /rel=["']([^"']*)["']/.exec(tag)?.[1] ?? ''
        if (!/\bnoopener\b/.test(rel)) offenders.push(`${relative(root, file)}: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('finds the external links it is supposed to be checking', () => {
    // A guard against the test silently passing because the regex stopped
    // matching anything at all.
    const withBlank = files.filter((file) => /target=["']_blank["']/.test(readFileSync(file, 'utf8')))
    expect(withBlank.length).toBeGreaterThanOrEqual(3)
  })
})

describe('application code contains no HTML injection sink', () => {
  /*
   * The whole app renders through React text nodes, which escape by default. There
   * is no `dangerouslySetInnerHTML` anywhere — and because a single one would undo
   * that guarantee for every string the app displays (lesson text, mentor replies,
   * resource titles), the absence is asserted rather than assumed.
   */
  const code = [
    ...sourceFiles(join(root, 'src')).filter((file) => !file.includes('/src/data/seed/')),
    ...sourceFiles(join(root, 'supabase')),
  ]
  /**
   * Strip comments before looking for sinks, because a sink *named* in a comment
   * is not a sink — this project's own `zod-config.ts` explains zod's eval probe
   * by quoting it, and that should not fail a security check.
   *
   * Only block comments and whole-line comments are removed, never trailing ones:
   * a naive `//.*` strip would eat the rest of any line containing a URL
   * (`'https://…'`), which is exactly where a real sink could hide.
   */
  const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  const sinks: Array<[string, RegExp]> = [
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['direct innerHTML assignment', /\.innerHTML\s*=/],
    ['direct outerHTML assignment', /\.outerHTML\s*=/],
    ['document.write', /document\.write\s*\(/],
    ['eval', /(?:^|[^.\w])eval\s*\(/],
    ['new Function', /new\s+Function\s*\(/],
    ['insertAdjacentHTML', /insertAdjacentHTML\s*\(/],
  ]

  it('uses none of them', () => {
    const offenders: string[] = []
    for (const file of code) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const [name, pattern] of sinks) {
        if (pattern.test(text)) offenders.push(`${relative(root, file)}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the comment stripper cannot hide a real sink', () => {
    // A guard on the guard: the same scanner must still see a sink on a code line,
    // including one with a trailing comment or a URL earlier on the line.
    const sample = [
      'const url = \'https://example.com/x\'',
      'el.innerHTML = url // trailing note',
      '/* a block comment mentioning new Function("x") */',
      '// a whole-line comment mentioning eval(1)',
    ].join('\n')
    const stripped = stripComments(sample)
    expect(stripped).toMatch(/\.innerHTML\s*=/)
    expect(stripped).toMatch(/https:\/\/example\.com/)
    expect(stripped).not.toMatch(/new\s+Function/)
    expect(stripped).not.toMatch(/eval\s*\(/)
  })

  it('the seed data file that names these sinks is data, not code', () => {
    // src/data/seed/knowledgeGraph.ts lists `innerHTML` and `eval` as *wrong quiz
    // answers*, which is why it is excluded above. This keeps that exclusion
    // honest: strip string literals (the answers are strings), then require that
    // no executable call to either survives.
    const seed = readFileSync(join(root, 'src/data/seed/knowledgeGraph.ts'), 'utf8')
    const withoutStrings = seed.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")
    expect(withoutStrings).not.toMatch(/\.innerHTML\s*=/)
    expect(withoutStrings).not.toMatch(/(?:^|[^\w.])eval\s*\(/)
    expect(withoutStrings).not.toMatch(/dangerouslySetInnerHTML/)
  })
})


