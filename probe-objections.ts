/** One-off discovery: find real reasons a stranger would not use this site.
 *  Prints a compact checklist. Deleted after use. */
import { createRequire } from 'node:module'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  ;(window as any).__name = (fn: unknown) => fn
})
const page = await context.newPage()
await page.goto(`${BASE}/`, { waitUntil: 'load' })
await page.waitForTimeout(2500)

const head = await page.evaluate(() => {
  const meta = (name: string) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute('content') ?? null
  const link = (rel: string) => Array.from(document.querySelectorAll(`link[rel="${rel}"]`)).map((n) => n.getAttribute('href'))
  return {
    title: document.title,
    titleLength: document.title.length,
    description: meta('description'),
    og: ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name'].map((k) => [k, meta(k)]),
    twitter: ['twitter:card', 'twitter:title', 'twitter:image'].map((k) => [k, meta(k)]),
    canonical: link('canonical'),
    icon: link('icon'),
    apple: link('apple-touch-icon'),
    manifest: link('manifest'),
    themeColor: meta('theme-color'),
    h1Count: document.querySelectorAll('h1').length,
    jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).length,
    noscript: !!document.querySelector('noscript'),
    lang: document.documentElement.lang,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 8).map((n) => `${n.tagName}:${(n.textContent || '').trim().slice(0, 28)}`),
  }
})
console.log('--- head ' + JSON.stringify(head, null, 1))

for (const path of ['/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/favicon.svg', '/offline.html', '/_redirects']) {
  const response = await page.request.get(`${BASE}${path}`).catch(() => null)
  console.log(`${path.padEnd(24)} ${response ? response.status() : 'ERR'}`)
}

const app = await page.evaluate(() => {
  const has = (selector: string) => document.querySelectorAll(selector).length
  return {
    installButton: has('[data-testid="install-app"], button[data-install]'),
    shareButton: has('[data-testid*="share"], button[aria-label*="hare"]'),
    printButton: has('[data-testid*="print"], button[aria-label*="rint"]'),
    exportButton: has('[data-testid*="export"], button[aria-label*="xport"]'),
    importInput: has('input[type="file"]'),
    skipLink: has('a[href="#main-content"]'),
    liveRegions: has('[aria-live], [role="status"], [role="alert"]'),
    changelogLink: Array.from(document.querySelectorAll('a')).filter((a) => /changelog|release notes|licen[cs]e/i.test(a.textContent ?? '')).length,
    externalLinks: Array.from(document.querySelectorAll('a[href^="http"]')).map((a) => (a as HTMLAnchorElement).host).slice(0, 6),
    footerText: (document.querySelector('footer')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
  }
})
console.log('--- app ' + JSON.stringify(app, null, 1))

const manifest = await page.request.get(`${BASE}/manifest.webmanifest`).catch(() => null)
if (manifest?.ok()) {
  const body = await manifest.json()
  console.log('--- manifest ' + JSON.stringify({ name: body.name, short_name: body.short_name, display: body.display, start_url: body.start_url, theme_color: body.theme_color, background_color: body.background_color, icons: (body.icons ?? []).map((i: any) => `${i.sizes}${i.purpose ? '/' + i.purpose : ''}`), shortcuts: (body.shortcuts ?? []).length, screenshots: (body.screenshots ?? []).length }))
}

console.log('--- repo files')
for (const file of ['LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', '.github/workflows/ci.yml', 'public/robots.txt', 'public/_headers', 'netlify.toml', 'public/social-card.png', 'docs/accessibility.md', 'docs/changelog.md']) {
  console.log(`${file.padEnd(34)} ${existsSync(file) ? 'present' : 'MISSING'}`)
}
console.log('--- public/ ' + (existsSync('public') ? readdirSync('public').join(', ') : 'none'))
console.log('--- index.html description tag: ' + (readFileSync('index.html', 'utf8').match(/<meta[^>]+description[^>]*>/)?.[0] ?? 'none'))
console.log('--- index.html has noscript: ' + /<noscript/i.test(readFileSync('index.html', 'utf8')))
await browser.close()


