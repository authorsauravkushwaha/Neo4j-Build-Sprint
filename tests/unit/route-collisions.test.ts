/**
 * A route must not collide with a proxy path.
 *
 * This test exists because one did. The public-API catalogue was added at `/apis`
 * — a sensible name for it — and `vite.config.ts` proxies `/api` to the Edge
 * Functions dev server (`127.0.0.1:8787`) so the browser can talk to the same
 * origin. Vite matches a proxy key by **prefix**, so `/apis` matched `/api`, the
 * backend was not running, and the dev-server log for that route read:
 *
 *     http proxy error: /apis
 *     Error: connect ECONNREFUSED 127.0.0.1:8787
 *
 * with a 500 sent to the browser instead of the app. Nothing in the test suite
 * noticed, because jsdom has no dev server and no proxy: every page test passed,
 * the production build passed, and the only broken surface was the one a person
 * would open first. That is the shape of a whole class of bug, so the rule is
 * asserted rather than remembered.
 *
 * The rule, stated generally: a client-side route may not equal a proxied prefix,
 * and may not start with one followed by a path separator or by nothing.
 *
 *     proxy '/api'  collides with  '/api', '/api/', '/apis', '/api-docs'
 *     proxy '/api'  does not collide with  '/app', '/graph'
 *
 * If a future route really must live under a proxied prefix, the fix is to make the
 * proxy key exact (`'^/api/'` in Vite's regex form) — never to hope the collision
 * goes unnoticed.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8')
const appSource = readFileSync(resolve(root, 'src/app/App.tsx'), 'utf8')

/**
 * The `proxy:` keys in vite.config.ts.
 *
 * Only the `proxy` blocks are read — not every quoted string in the file. The
 * first version of this test scanned the whole file and "found" a proxy for
 * `/onboarding`, because the sitemap route list also contains quoted paths.
 */
function proxyPrefixes(): string[] {
  const prefixes = new Set<string>()
  for (const block of viteConfig.matchAll(/proxy:\s*\{([^}]*)\}/g)) {
    for (const key of (block[1] ?? '').matchAll(/'([^']+)'\s*:/g)) prefixes.add(key[1]!)
    for (const key of (block[1] ?? '').matchAll(/"([^"]+)"\s*:/g)) prefixes.add(key[1]!)
  }
  return [...prefixes].filter((prefix) => prefix.startsWith('/') && !prefix.startsWith('/^'))
}

/** The `path="…"` literals in the routing table. */
function routePaths(): string[] {
  return [...appSource.matchAll(/path="([^"]+)"/g)].map((match) => match[1]!).filter((path) => path.startsWith('/'))
}

describe('client-side routes and dev-server proxies', () => {
  it('finds both lists, so the assertions below cannot pass vacuously', () => {
    expect(proxyPrefixes().length).toBeGreaterThan(0)
    expect(routePaths().length).toBeGreaterThan(10)
    expect(routePaths()).toContain('/public-apis')
  })

  it('never routes a page under a path the dev server forwards to the backend', () => {
    for (const route of routePaths()) {
      for (const prefix of proxyPrefixes()) {
        const collides = route === prefix || route.startsWith(`${prefix}/`) || route.startsWith(prefix) && route.length > prefix.length
        expect(collides, `route ${route} is swallowed by the proxy for ${prefix}`).toBe(false)
      }
    }
  })

  it('keeps the crawl list and the router in agreement', () => {
    // Both halves of the drift this file was written for. A sitemap that lists a
    // page the app does not serve is a promise it cannot keep; a public page that
    // is missing from it is invisible to the one audience the file exists for.
    const block = /const publicRoutes = \[([\s\S]*?)\]/.exec(viteConfig)?.[1]
    expect(block, 'vite.config.ts no longer declares publicRoutes').toBeTruthy()
    const crawlList = [...block!.matchAll(/'(\/[a-z-]*)'/g)].map((match) => match[1]!)
    expect(crawlList.length).toBeGreaterThan(10)
    expect(crawlList).toContain('/public-apis')

    const served = new Set(routePaths())
    for (const route of crawlList) {
      expect(served.has(route) || route === '/', `sitemap advertises ${route}, which is not a route`).toBe(true)
    }

    // The personal screens must stay out of a sitemap, and robots.txt must keep
    // disallowing them.
    for (const personal of ['/dashboard', '/progress', '/settings', '/login', '/account', '/reset-password']) {
      expect(crawlList, `${personal} should not be in the sitemap`).not.toContain(personal)
    }
    for (const disallowed of ['/settings', '/account', '/login', '/reset-password']) {
      expect(viteConfig, `robots.txt no longer disallows ${disallowed}`).toContain(`Disallow: ${disallowed}`)
    }
  })

  it('keeps the naming note next to the route, so the next person does not re-add it', () => {
    expect(appSource, 'the reason /apis became /public-apis is no longer recorded').toMatch(/proxies to the\n\s+\*?\s*Edge Functions|proxies to the Edge Functions/)
  })
})
