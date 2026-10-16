/**
 * The GitHub Pages contract, checked in both directions.
 *
 * Pages is the host this project actually ships to, and it is the least forgiving one:
 * a project site is served from `/<repo>/`, there are no rewrite rules, and an asset
 * path that ignores the base produces a blank page rather than an error. Every assertion
 * here corresponds to a failure that this repository would otherwise deploy
 * successfully and only discover by opening the URL:
 *
 *   * assets and manifest URLs that escape `/<repo>/`            -> blank page, PWA that
 *     will not install, shortcuts pointing at the host's root;
 *   * no `404.html`                                              -> every shared deep
 *     link shows GitHub's own error page;
 *   * a canonical URL built by appending the base to a site URL that already contains it
 *     -> `/<repo>/<repo>/`, which tells a crawler the app lives somewhere it does not;
 *   * an icon in `public/` that nobody committed                 -> a manifest that
 *     promises four PNGs and 404s on all of them.
 *
 * The rules live in `scripts/pages-target.ts` as pure functions so they can be tested
 * without importing Vite; `tests/unit/route-collisions.test.ts` is the precedent for
 * reading `vite.config.ts` as text where the point is that the wiring exists.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  canonicalSiteUrl,
  escapeRegExp,
  isUserSiteRepo,
  joinBase,
  normalizeBase,
  pagesBasePath,
  pagesSiteUrl,
  spaFallbackDocument,
  withManifestBaseUrl,
} from '../../scripts/pages-target.ts'

const root = resolve(__dirname, '../..')
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8')
const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8')
const deployWorkflow = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8')

/** `public/` is copied into the build verbatim, so a missing file here is a 404 there. */
function publicFile(path: string): boolean {
  return existsSync(join(root, 'public', path))
}

/** Read width and height out of a PNG's IHDR chunk — no image library needed. */
function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 8).toString('hex'), `${path} is not a PNG`).toBe('89504e470d0a1a0a')
  expect(bytes.subarray(12, 16).toString('ascii'), `${path} has no IHDR first`).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('base path and site URL', () => {
  it('normalises every way an operator might write the base', () => {
    expect(normalizeBase(undefined)).toBe('/')
    expect(normalizeBase('')).toBe('/')
    expect(normalizeBase('/')).toBe('/')
    // Vite's relative base is not usable here: the manifest, the social card and the 404
    // fallback join this value onto absolute paths.
    expect(normalizeBase('./')).toBe('/')
    expect(normalizeBase('Neo4j-Build-Sprint')).toBe('/Neo4j-Build-Sprint/')
    expect(normalizeBase('/Neo4j-Build-Sprint')).toBe('/Neo4j-Build-Sprint/')
    expect(normalizeBase('  /graphmentor/  ')).toBe('/graphmentor/')
  })

  it('knows which repositories are served at the domain root', () => {
    expect(isUserSiteRepo('authorsauravkushwaha', 'authorsauravkushwaha.github.io')).toBe(true)
    // GitHub matches the name case-insensitively, so the check has to as well.
    expect(isUserSiteRepo('AuthorSauravKushwaha', 'authorsauravkushwaha.GitHub.IO')).toBe(true)
    expect(isUserSiteRepo('authorsauravkushwaha', 'Neo4j-Build-Sprint')).toBe(false)
    expect(pagesBasePath('authorsauravkushwaha', 'authorsauravkushwaha.github.io')).toBe('/')
    // The case is the repository's own, because the path it is served from is a
    // case-sensitive lookup: lower-casing it here would 404 every asset in the build.
    expect(pagesBasePath('authorsauravkushwaha', 'Neo4j-Build-Sprint')).toBe('/Neo4j-Build-Sprint/')
    expect(pagesSiteUrl('authorsauravkushwaha', '/Neo4j-Build-Sprint/')).toBe('https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint')
    expect(pagesSiteUrl('authorsauravkushwaha', '/')).toBe('https://authorsauravkushwaha.github.io')
  })

  it('does not append the base path twice when the site URL already has it', () => {
    // The documented example is `https://<user>.github.io/<repo>/`, so the URL arrives
    // with the path in it while `base` is `/repo/`. Appending anyway yields /repo/repo/.
    const base = '/Neo4j-Build-Sprint/'
    expect(canonicalSiteUrl('https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint', base)).toBe(
      'https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint/',
    )
    expect(canonicalSiteUrl('https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint/', base)).toBe(
      'https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint/',
    )
    // The other way to write it: the origin alone, which needs the base appended.
    expect(canonicalSiteUrl('https://authorsauravkushwaha.github.io', base)).toBe('https://authorsauravkushwaha.github.io/Neo4j-Build-Sprint/')
    expect(canonicalSiteUrl('  ', base)).toBeNull()
    expect(canonicalSiteUrl(undefined, '/')).toBeNull()
    expect(canonicalSiteUrl('https://graphmentor.ai/', '/')).toBe('https://graphmentor.ai/')
    // A repository whose name merely ends like the base path is not the same site.
    expect(canonicalSiteUrl('https://x.github.io/my-Neo4j-Build-Sprint', base)).toBe('https://x.github.io/my-Neo4j-Build-Sprint/Neo4j-Build-Sprint/')
  })
})

describe('the web-app manifest under a base path', () => {
  const manifest = {
    id: '/?source=pwa',
    name: 'GraphMentor AI — Engineering Career Navigator',
    start_url: '.',
    scope: '.',
    shortcuts: [
      { name: 'Explore careers', url: '/careers' },
      { name: 'Knowledge graph', url: '/graph' },
    ],
  }

  it('keeps the app inside its own path', () => {
    const based = withManifestBaseUrl(manifest, '/Neo4j-Build-Sprint/')
    expect(based.id).toBe('/Neo4j-Build-Sprint/?source=pwa')
    expect(based.shortcuts?.map((s) => s.url)).toEqual(['/Neo4j-Build-Sprint/careers', '/Neo4j-Build-Sprint/graph'])
    // start_url and scope are relative to the manifest, which the host already serves
    // from the base path, and vite-plugin-pwa rebases them itself. Leave them alone.
    expect(based.start_url).toBe('.')
    expect(based.scope).toBe('.')
  })

  it('is a no-op at the domain root, and does not touch other URLs', () => {
    expect(withManifestBaseUrl(manifest, '/')).toEqual(manifest)
    const odd = { id: 'https://graphmentor.ai/?source=pwa', shortcuts: [{ name: 'Docs', url: './docs' }] }
    expect(withManifestBaseUrl(odd, '/Neo4j-Build-Sprint/')).toEqual(odd)
    expect(joinBase(undefined, '/x/')).toBeUndefined()
  })

  it('is applied in the build, not just available as a function', () => {
    // A helper nobody calls is how this bug shipped in the first place.
    expect(viteConfig).toMatch(/manifest:\s*withManifestBaseUrl\(/)
    expect(viteConfig).toMatch(/,\s*\n?\s*base,\s*\n?\s*\),/)
  })
})

describe('the SPA fallback that stands in for rewrite rules', () => {
  it('is generated for the build and read from the built shell', () => {
    expect(viteConfig).toMatch(/function spaFallbackPlugin\(\)/)
    expect(viteConfig).toMatch(/plugins:\s*\[[\s\S]*?spaFallbackPlugin\(\)/)
  })

  it('copies the shell, drops its canonical claim and adds no inline script', () => {
    const built = [
      '<html><head>',
      '<link rel="canonical" href="https://x.github.io/repo/" />',
      '<link rel="manifest" href="/repo/manifest.webmanifest" />',
      '<script type="module" src="/repo/assets/index.js"></script>',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n')
    const fallback = spaFallbackDocument(built)
    expect(fallback).toContain('<link rel="manifest" href="/repo/manifest.webmanifest" />')
    expect(fallback).toContain('<script type="module" src="/repo/assets/index.js"></script>')
    expect(fallback).not.toContain('rel="canonical"')
    // The comment proves which file this is, and it must not smuggle in executable code:
    // script-src 'self' allows no inline script, and a fallback that tripped the policy
    // would be a blank page instead of the app.
    expect(fallback).toContain('SPA fallback')
    const inline = [...fallback.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)]
    expect(inline).toEqual([])
  })

  it('references every asset absolutely, because the fallback is served at unknown depth', () => {
    // `./favicon.svg` inside a document served for /careers/backend-engineer resolves to
    // /careers/favicon.svg. Root-relative references are rewritten onto the base by
    // Vite, so they are correct at every path.
    for (const match of indexHtml.matchAll(/(?:href|src)="(\.[^"]*)"/g)) {
      expect(match[1], `index.html must not reference ${match[1]} relatively`).not.toMatch(/^\.\//)
    }
    expect(indexHtml).toMatch(/<link rel="icon"[^>]*href="\/favicon\.svg"/)
    expect(indexHtml).toMatch(/apple-touch-icon"[^>]*href="\/icons\/apple-touch-icon\.png"/)
  })

  it('is published by the workflow that checks it in', () => {
    expect(deployWorkflow).toMatch(/404\.html/)
    expect(deployWorkflow).toMatch(/github\.event\.repository\.name/)
    // The base path and the site URL are derived, with the variable and the secret as
    // overrides, so a first deploy cannot be blank for want of a remembered setting.
    expect(deployWorkflow).toMatch(/VITE_BASE_PATH:\s*\$\{\{\s*steps\.target\.outputs\.base\s*\}\}/)
    expect(deployWorkflow).toMatch(/VITE_SITE_URL:\s*\$\{\{\s*steps\.target\.outputs\.url\s*\}\}/)
    expect(deployWorkflow).toMatch(/vars\.VITE_BASE_PATH/)
  })
})

describe('the assets the manifest promises', () => {
  const icons = [
    { file: 'icons/icon-192.png', size: 192 },
    { file: 'icons/icon-512.png', size: 512 },
    { file: 'icons/maskable-512.png', size: 512 },
    { file: 'icons/apple-touch-icon.png', size: 180 },
  ]

  it.each(icons)('ships $file at the declared size', ({ file, size }) => {
    // public/icons/*.png is generated by scripts/generate-icons.py from the geometry in
    // public/favicon.svg and committed, because nothing in the build can render it: a
    // deploy that shipped without these has an installable-looking manifest and four
    // 404s, which is exactly what happened before they were added.
    expect(publicFile(file), `public/${file} is missing — run: python3 scripts/generate-icons.py`).toBe(true)
    const { width, height } = pngDimensions(join(root, 'public', file))
    expect({ width, height }, `${file} is not ${size}x${size}`).toEqual({ width: size, height: size })
  })

  it('matches the sizes declared in the build config', () => {
    for (const size of ['192x192', '512x512']) {
      expect(viteConfig, `the manifest no longer declares ${size}`).toContain(size)
    }
    // `[^\]]` and not `[^]]`: in a JavaScript class a leading ] closes it, so `[^]]*`
    // means "anything, then a literal ]" and never matches what it appears to mean.
    expect(viteConfig).toMatch(/includeAssets:[^\]]*icons\/\*\.png/)
  })

  it('advertises the social card only where one was rendered', () => {
    // The card is an output of `npm run emit:social-card`, not a committed asset, so the
    // head must follow whatever is on disk instead of asserting a 1200x630 image exists.
    const cardExists = publicFile('social-card.png')
    const block = /<!-- __OG_IMAGE__ -->/.test(indexHtml)
    expect(block, 'index.html must keep the marker the build fills in').toBe(true)
    expect(viteConfig).toMatch(/existsSync\(r\('\.\/public\/social-card\.png'\)\)/)
    expect(viteConfig).toMatch(/npm run emit:social-card has not been run/)
    expect(cardExists || viteConfig.includes('socialCard'), 'the build must cope with the card being absent').toBe(true)
  })
})

describe('the offline navigation fallback', () => {
  it('denies offline.html at the deployed path, not at the host root', () => {
    // Workbox tests navigateFallbackDenylist against the whole path, so a pattern
    // anchored at ^/offline\.html$ never matches /<repo>/offline.html.
    expect(viteConfig).toMatch(/navigateFallbackDenylist:\s*\[new RegExp\(`\^\$\{escapeRegExp\(base\)\}/)
    expect(escapeRegExp('/Neo4j-Build-Sprint/')).toBe('/Neo4j-Build-Sprint/')
    expect(escapeRegExp('/a.b*c?/')).toBe('/a\\.b\\*c\\?/')
    const pattern = new RegExp(`^${escapeRegExp('/Neo4j-Build-Sprint/')}offline\\.html$`)
    expect(pattern.test('/Neo4j-Build-Sprint/offline.html')).toBe(true)
    expect(pattern.test('/offline.html')).toBe(false)
    expect(new RegExp(`^${escapeRegExp('/')}offline\\.html$`).test('/offline.html')).toBe(true)
  })
})
