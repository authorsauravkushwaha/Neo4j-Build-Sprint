/**
 * The GitHub Pages publishing contract, as pure functions.
 *
 * GitHub Pages is the least forgiving host this app can be pointed at: it serves
 * static files from a path under the domain (`https://<owner>.github.io/<repo>/`)
 * unless the repository is named `<owner>.github.io`, it has no rewrite rules, and
 * it has no way to say "send index.html for unknown paths". Every one of those three
 * limitations has produced a broken deployment somewhere:
 *
 *   * assets requested from `/assets/…` instead of `/<repo>/assets/…`  -> blank page;
 *   * a manifest `id` or a shortcut URL of `/careers`                   -> escapes the
 *     app's path, so the PWA is not installable and its shortcuts 404;
 *   * a shared deep link like `/<repo>/careers/backend-engineer`        -> GitHub's own
 *     404 page, because the file does not exist on disk.
 *
 * The functions here are the single place those rules are written down, and they are
 * exported from `scripts/` (not inlined into `vite.config.ts`) so
 * `tests/unit/github-pages.test.ts` can check them without importing Vite.
 */

/** An app served from the domain root has base `/`; anything else ends in `/`. */
export function normalizeBase(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  /**
   * `./` (Vite's relative base) is deliberately folded onto `/`: several places in
   * this build join the base onto an absolute path with plain string concatenation
   * (the manifest, the social card URL, the 404 fallback), and `./careers` is not a
   * URL. The app also needs a real base for `BrowserRouter`'s `basename`. So an
   * absolute base is required — this is the one place that says so.
   */
  if (trimmed === '' || trimmed === '/' || trimmed === './') return '/'
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`
}

/**
 * True for the repository whose Pages site is served at the domain root.
 *
 * GitHub matches this name case-insensitively, so the comparison lowercases both
 * sides rather than trusting how the owner typed the repository name.
 */
export function isUserSiteRepo(owner: string, repoName: string): boolean {
  return repoName.trim().toLowerCase() === `${owner.trim().toLowerCase()}.github.io`
}

/**
 * The base path a repository needs on GitHub Pages: `/` for a user site, `/<repo>/`
 * for anything else.
 *
 * The repository name is kept exactly as spelled, because a Pages path is a case
 * sensitive lookup into that repository's published files: lower-casing
 * `Neo4j-Build-Sprint` into `/neo4j-build-sprint/` would ask the host for a directory
 * it has never heard of, and every stylesheet and chunk on the page would 404. Only
 * the hostname is folded, since DNS is not.
 */
export function pagesBasePath(owner: string, repoName: string): string {
  return isUserSiteRepo(owner, repoName) ? '/' : `/${repoName.trim()}/`
}

/** Absolute origin(+path) of the published site, with no trailing slash. */
export function pagesSiteUrl(owner: string, base: string): string {
  const path = base === '/' ? '' : base.replace(/\/$/, '')
  return `https://${owner.trim().toLowerCase()}.github.io${path}`
}

/**
 * Prefix a root-relative URL with the base path, leaving anything else alone.
 *
 * `/careers` under base `/Neo4j-Build-Sprint/` becomes `/Neo4j-Build-Sprint/careers`.
 * An absolute URL, a scheme-relative URL or a relative path is returned untouched:
 * only URLs that *claim* to be at the root of the origin are this function's business.
 */
export function joinBase(url: string | undefined, base: string): string | undefined {
  if (!url || base === '/' || !url.startsWith('/')) return url
  return `${base}${url.slice(1)}`
}

/**
 * The subset of the web-app manifest this build has to rewrite for a subpath.
 *
 * Deliberately only the two fields the function touches: a structural constraint with an
 * index signature would refuse `Partial<ManifestOptions>` (interfaces get no implicit
 * index signature), and a richer one would duplicate the plugin's own type.
 */
export interface ManifestLike {
  id?: string
  shortcuts?: Array<{ url: string }>
}

/**
 * Make the manifest fields that Vite's PWA plugin does *not* rebased.
 *
 * `vite-plugin-pwa` prefixes `start_url` and `scope` with the build base, but leaves
 * `id` and every shortcut `url` exactly as written. A manifest served from
 * `/<repo>/manifest.webmanifest` whose `id` is `/` therefore names a page outside the
 * app's scope, which is fatal for installation, and its shortcuts point at the host's
 * root. This joins those paths onto the base; with base `/` nothing changes.
 */
export function withManifestBaseUrl<T extends ManifestLike>(manifest: T, base: string): T {
  const rewritten: T = { ...manifest }
  if (typeof manifest.id === 'string') {
    rewritten.id = joinBase(manifest.id, base)
  }
  if (Array.isArray(manifest.shortcuts)) {
    rewritten.shortcuts = manifest.shortcuts.map((shortcut) => ({
      ...shortcut,
      url: joinBase(shortcut.url, base) ?? shortcut.url,
    }))
  }
  return rewritten
}

/**
 * Absolute canonical URL of the site — origin, base path, trailing slash — or null
 * when the operator has not configured a site URL at all.
 *
 * `VITE_SITE_URL` is accepted in either of the two forms people naturally write: the
 * origin (`https://<owner>.github.io`) or the full project-site URL
 * (`https://<owner>.github.io/<repo>`). The base path is appended only when the
 * configured URL does not already end with it, which is what stopped the old build
 * from advertising `https://<owner>.github.io/<repo>/<repo>/` — the double path the
 * documentation's own example produced, on the canonical link, the sitemap and the
 * Open Graph image alike.
 */
export function canonicalSiteUrl(siteUrl: string | undefined, base: string): string | null {
  const trimmed = (siteUrl ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return null
  const suffix = base === '/' ? '' : base.replace(/\/$/, '')
  const alreadyHasBase = suffix === '' || trimmed.toLowerCase().endsWith(suffix.toLowerCase())
  return `${alreadyHasBase ? trimmed : `${trimmed}${suffix}`}/`
}

/** Escape a literal string for use inside a `RegExp`. */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ==========================================================================
   The static-host Content-Security-Policy
   ========================================================================== */

/**
 * Replace the `connect-src` value of a policy string.
 *
 * The policy ships in three copies (the `<meta>` tag, `public/_headers` and
 * netlify.toml) and the browser enforces the *intersection* of every policy it
 * is given. That makes the header copies dangerous when the deployment's API
 * lives on a host the committed default does not list: the meta tag is
 * generated at build time and allows the real backend, but the header copy
 * still says `connect-src 'self' https://*.supabase.co https://*.supabase.in`,
 * so the browser blocks the API request and the page quietly falls back to
 * demo data. The build stays green, the backend stays healthy, and the site
 * looks like a demo for ever.
 *
 * So the header copies are generated too: this build writes the resolved
 * allow-list into the emitted `_headers`, and the two copies cannot disagree
 * because they come from the same list.
 *
 * The rewrite is deliberately narrow: only the `connect-src` directive is
 * touched, and only the first one. Every other directive — the ones that make
 * the policy a policy — is left exactly as it was written.
 */
export function rewriteConnectSrc(policy: string, connectSrc: string): string {
  const value = connectSrc.trim()
  if (!value) return policy
  return policy.replace(/connect-src\s+[^;]*/, `connect-src ${value}`)
}

/**
 * Rewrite the `Content-Security-Policy` header inside a `_headers` file.
 *
 * Returns the new text and whether a policy was found at all: a file without
 * one is a deployment that silently has no header policy, and the caller is
 * told so it can say so rather than pretend the rewrite happened.
 */
export function rewriteStaticHeaders(text: string, connectSrc: string): { text: string; found: boolean } {
  let found = false
  const lines = text.split(/\r?\n/).map((line) => {
    const match = /^(\s*Content-Security-Policy:\s*)(.+)$/.exec(line)
    if (!match) return line
    found = true
    return `${match[1]}${rewriteConnectSrc(match[2] ?? '', connectSrc)}`
  })
  return { text: lines.join('\n'), found }
}

/**
 * Turn the built app shell into the document a static host serves for unknown paths.
 *
 * The body is copied verbatim: every asset it loads is addressable as an absolute
 * path under the base, so it boots correctly at `/careers/backend-engineer` as well as
 * at the root. The one edit is the removal of `<link rel="canonical">` — this document
 * is served at *every* unmatched URL, and a fallback that declares itself the canonical
 * page of all of them tells a crawler that the homepage is where the deep link is.
 * The status line still says 404 (GitHub Pages gives a static host no way to change
 * that), which is the honest half: the content is the app, the number is a warning that
 * no file lives at this exact path.
 */
export function spaFallbackDocument(indexHtml: string): string {
  const withoutCanonical = indexHtml.replace(/[ \t]*<link rel="canonical"[^>]*>\r?\n?/g, '')
  const notice =
    '<!-- SPA fallback. GitHub Pages has no rewrite rules, so it serves this file for any\n' +
    '     path that has no matching file. The app reads location.pathname, so a shared deep\n' +
    '     link renders the screen it names instead of GitHub\'s own 404 page. The canonical\n' +
    '     link from index.html was removed here on purpose, and there is no inline script\n' +
    '     because the Content-Security-Policy (script-src \'self\') forbids one. -->'
  return `${notice}\n${withoutCanonical}`
}
