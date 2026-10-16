import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA, type ManifestOptions } from 'vite-plugin-pwa'

import { canonicalSiteUrl, escapeRegExp, normalizeBase, spaFallbackDocument, withManifestBaseUrl } from './scripts/pages-target.ts'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Build-time HTML injector: Content-Security-Policy hosts and the canonical URL.
 *
 * The canonical link cannot be written as a relative path in index.html: Vite's
 * HTML asset pipeline resolves `href="./"` against the project root and tries to
 * read the folder as a file (EISDIR, and the build dies before transforming any
 * module). So the tag is injected here as an absolute URL, or omitted entirely
 * when no site URL is configured — a wrong canonical is worse than none.
 *
 * Content-Security-Policy injector.
 * Replaces __CSP_CONNECT_SRC__ in index.html with the hosts the app is allowed to
 * talk to (Supabase REST/Auth/Edge Functions, plus an optional custom API domain),
 * and __CSP_STYLE_SRC__ with the style policy for the mode being built.
 *
 * The style policy differs by mode on purpose:
 *
 *   build (and therefore Capacitor, which ships dist/):
 *     style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'
 *       No injected <style> element is allowed. The app needs nothing more: its
 *       only stylesheet is a <link> to its own bundled CSS, its dynamic styles go
 *       through the CSSOM (which CSP does not govern), and the shipped HTML has
 *       no literal style attribute. style-src-attr stays permissive as the
 *       fallback for a browser that only understands CSP level 2.
 *   dev:
 *     style-src 'self' 'unsafe-inline'
 *       Tailwind's HMR runtime injects <style> elements while editing, and a
 *       development server that cannot show its own styles is not usable. This
 *       relaxation is never in a built artifact.
 *
 * Static hosting headers (public/_headers, netlify.toml) carry the production
 * policy explicitly, plus the frame-ancestors / HSTS directives that a <meta>
 * tag cannot express.
 */
function htmlPlugin(connectSrc: string, styleSrc: string, canonicalHref: string | null, socialCard: string | null): Plugin {
  return {
    name: 'graphmentor-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const canonical = canonicalHref ? `<link rel="canonical" href="${canonicalHref}" />` : ''
        /**
         * The Open Graph image block, or a comment explaining its absence. The caller
         * resolved the URL (see the `socialCard` computation) and checked that the file
         * is in the output; writing `og:image:width` / `og:image:height` for an image
         * that was never rendered would be a promise the deploy cannot keep.
         */
        const socialCardBlock = socialCard
          ? [
              `<meta property="og:image" content="${socialCard}" />`,
              '<meta property="og:image:width" content="1200" />',
              '<meta property="og:image:height" content="630" />',
              '<meta property="og:image:alt" content="GraphMentor AI: engineering careers as a knowledge graph" />',
            ].join('\n    ')
          : '<!-- npm run emit:social-card has not been run, so there is no og:image to advertise. -->'
        const twitterImage = socialCard ? `<meta name="twitter:image" content="${socialCard}" />` : ''
        return html
          .replaceAll('__CSP_CONNECT_SRC__', connectSrc)
          .replaceAll('__CSP_STYLE_SRC__', styleSrc)
          .replaceAll('<!-- __CANONICAL__ -->', canonical)
          .replaceAll('<!-- __OG_IMAGE__ -->', socialCardBlock)
          .replaceAll('<!-- __TWITTER_IMAGE__ -->', twitterImage)
      },
    },
  }
}

/**
 * The 404.html that makes deep links work on a host with no rewrite rules.
 *
 * GitHub Pages serves one static file per URL and offers no `/* -> /index.html`
 * fallback (Netlify and Cloudflare get that from netlify.toml and _redirects).
 * Without this, every shared link to `/careers/backend-engineer` — the single most
 * likely way this app gets forwarded — lands on GitHub's own 404 page even though the
 * client router knows exactly how to render it.
 *
 * Written in `writeBundle`, after Vite has put `index.html` on disk and before
 * `vite-plugin-pwa` globs the output for the precache list, so the fallback is a
 * byte-relative copy of the real app shell and is itself cached for offline use.
 */
function spaFallbackPlugin(): Plugin {
  return {
    name: 'graphmentor-spa-fallback',
    apply: 'build',
    writeBundle(options, bundle) {
      const outDir = options.dir ?? fileURLToPath(new URL('./dist/', import.meta.url))
      const emitted = bundle['index.html']
      const built =
        emitted?.type === 'asset'
          ? typeof emitted.source === 'string'
            ? emitted.source
            : Buffer.from(emitted.source).toString('utf8')
          : existsSync(`${outDir}/index.html`)
            ? readFileSync(`${outDir}/index.html`, 'utf8')
            : null
      if (!built) {
        // Nothing to copy: a build that produced no app shell has already failed
        // elsewhere, and inventing a fallback page here would hide that.
        // eslint-disable-next-line no-console
        console.log('[pages] no index.html in the output: wrote no 404.html fallback.')
        return
      }
      writeFileSync(`${outDir}/404.html`, spaFallbackDocument(built))
      // eslint-disable-next-line no-console
      console.log('[pages] wrote 404.html: GitHub Pages serves it for unmatched paths, so deep links still render.')
    },
  }
}

/**
 * Crawl files, written from the same route table the app uses.
 *
 * `/sitemap.xml` used to be a 200 that returned `index.html` — a real file that
 * never existed, served by the preview server's SPA fallback. A sitemap that is
 * HTML is worse than no sitemap: a crawler reads garbage and learns nothing.
 * These are emitted as real files, or not at all when no site URL is configured,
 * because a sitemap of relative URLs is invalid by the sitemap spec.
 */
function seoPlugin(siteUrl: string | null, routes: string[]): Plugin {
  return {
    name: 'graphmentor-seo',
    apply: 'build',
    closeBundle() {
      const outDir = fileURLToPath(new URL('./dist/', import.meta.url))
      const origin = siteUrl?.replace(/\/$/, '') ?? null
      if (!origin) {
        writeFileSync(
          `${outDir}robots.txt`,
          ['# Set VITE_SITE_URL to publish a sitemap and canonical URLs.', 'User-agent: *', 'Allow: /', 'Disallow: /settings', 'Disallow: /account', 'Disallow: /login', 'Disallow: /reset-password', ''].join('\n'),
        )
        // eslint-disable-next-line no-console
        console.log('[seo] VITE_SITE_URL is unset: robots.txt written without a Sitemap line, no sitemap.xml emitted.')
        return
      }
      const today = new Date().toISOString().slice(0, 10)
      const urls = routes
        .map((route) => `  <url><loc>${origin}${route}</loc><lastmod>${today}</lastmod><priority>${route === '/' ? '1.0' : '0.7'}</priority></url>`)
        .join('\n')
      writeFileSync(`${outDir}sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`)
      writeFileSync(
        `${outDir}robots.txt`,
        ['User-agent: *', 'Allow: /', 'Disallow: /settings', 'Disallow: /account', 'Disallow: /login', 'Disallow: /reset-password', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n'),
      )
      // eslint-disable-next-line no-console
      console.log(`[seo] wrote sitemap.xml with ${routes.length} URL(s) and a robots.txt that points at it.`)
    },
  }
}

/** The one place the production style policy is written down. */
export const PRODUCTION_STYLE_POLICY = "style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'"
/** The development policy, which can never reach a built artifact. */
const DEVELOPMENT_STYLE_POLICY = "style-src 'self' 'unsafe-inline'"

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  /**
   * `/` for a root domain or `/<repo>/` for a GitHub Pages project site. Normalised
   * here once, because the manifest, the social card and the 404 fallback all join
   * this value onto paths with string concatenation — see `normalizeBase`.
   */
  const base = normalizeBase(env.VITE_BASE_PATH)
  /** The site's own URL including the base path and a trailing slash, or null. */
  const siteCanonical = canonicalSiteUrl(env.VITE_SITE_URL, base)
  /**
   * URL of the Open Graph card: absolute when a site URL is configured, root-relative
   * otherwise — the same rule the canonical link follows, so the page never invents an
   * origin it does not have. `canonicalSiteUrl` already ends with the base path *and* a
   * slash, so the file name is joined to it directly; joining `base` a second time is
   * what made the old build advertise `/<repo>/<repo>/social-card.png`.
   *
   * `public/social-card.png` is rendered by `npm run emit:social-card` from the
   * dataset, so it exists in a deploy that ran that step and not in one that did not.
   * A card that is not there is not advertised: a broken `og:image` renders the same
   * empty preview as no `og:image`, but with a 404 in the log and a lie in the markup.
   */
  const socialCard = existsSync(r('./public/social-card.png'))
    ? `${siteCanonical ?? base}social-card.png`
    : null
  /**
   * Hosts the dev/preview servers will answer to. Vite rejects unknown Host
   * headers by default (DNS-rebinding protection), which breaks tunnelled
   * preview URLs and remote containers, so the known-safe ones are listed
   * explicitly — plus whatever the developer adds in DEV_ALLOWED_HOSTS.
   * Nothing here affects the built site, which is served by a host of your
   * choosing and never by this dev server.
   */
  const devAllowedHosts = [
    'localhost',
    '127.0.0.1',
    '.e2b.app', // hosted Agent Mode sandbox previews: <port>-<id>.e2b.app
    '.trycloudflare.com', // `cloudflared tunnel` used to test the Android app
    ...(env.DEV_ALLOWED_HOSTS
      ? env.DEV_ALLOWED_HOSTS.split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []),
  ]

  const connectHosts = [
    "'self'",
    'https://*.supabase.co',
    'https://*.supabase.in',
    env.VITE_API_BASE_URL?.trim(),
    env.VITE_CSP_EXTRA_CONNECT_SRC?.trim(),
  ].filter((v): v is string => Boolean(v))

  const appVersion = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version as string
  /**
   * Public routes a crawler may index — the same paths `src/app/App.tsx` serves.
   *
   * This list had drifted: it advertised `/library` and `/accessibility`, which the
   * router has never served (the resource library is `/resources`), and omitted
   * `/skills`, `/pathway`, `/workflows` and the rest. A sitemap is a promise to a
   * crawler, so `tests/unit/route-collisions.test.ts` now fails if this list and the
   * router disagree in either direction.
   *
   * Personal screens are deliberately absent: `/dashboard`, `/progress` and
   * `/settings` are the learner's own state, `/login`, `/account` and
   * `/reset-password` are for a person, not an index, and robots.txt disallows all
   * six.
   */
  const publicRoutes = [
    '/',
    '/onboarding',
    '/careers',
    '/skills',
    '/graph',
    '/pathway',
    '/gaps',
    '/roadmap',
    '/projects',
    '/resources',
    '/mentor',
    '/workflows',
    '/public-apis',
    '/about',
    '/privacy',
  ]

  return {
    base,
    // The build knows its own version; before this the footer rendered "vdev".
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion) },
    plugins: [
      react(),
      tailwindcss(),
      htmlPlugin(
        [...new Set(connectHosts)].join(' '),
        // `command` is 'build' for both `vite build` and `vite preview`'s source
        // build, and 'serve' only for the dev server, which is exactly the split
        // this policy needs.
        command === 'build' ? PRODUCTION_STYLE_POLICY : DEVELOPMENT_STYLE_POLICY,
        siteCanonical,
        socialCard,
      ),
      spaFallbackPlugin(),
      seoPlugin(siteCanonical?.replace(/\/$/, '') ?? null, publicRoutes),
      VitePWA({
        // 'prompt' => the UI asks before reloading; we never silently swap the app shell.
        registerType: 'prompt',
        // We register the service worker ourselves from a module import so that the
        // production page contains zero inline scripts (required by script-src 'self').
        injectRegister: null,
        strategies: 'generateSW',
        includeAssets: ['favicon.svg', 'icons/*.png', 'offline.html', 'robots.txt'],
        // Every root-relative field below is joined onto the base path by
        // `withManifestBaseUrl`, because vite-plugin-pwa rebases `start_url` and
        // `scope` but leaves `id` and the shortcut URLs alone. Under a project site
        // those two are what stop the installed app from pointing at the host's root.
        manifest: withManifestBaseUrl(
          {
            id: '/?source=pwa',
              name: 'GraphMentor AI — Engineering Career Navigator',
              short_name: 'GraphMentor',
              description:
                'Explore engineering careers as a knowledge graph: trace prerequisites, find skill gaps, build a dependency-aware learning roadmap, and get practical project ideas.',
              theme_color: '#0b1220',
              background_color: '#0b1220',
              display: 'standalone',
              display_override: ['standalone', 'minimal-ui'],
              orientation: 'any',
              // Relative to the manifest's own URL, which the host serves from the
              // base path — so these two need no rebasing and are left as written.
              start_url: '.',
              scope: '.',
              lang: 'en',
              dir: 'ltr',
              categories: ['education', 'productivity'],
              icons: [
                { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
                { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
                { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
              ],
              shortcuts: [
                { name: 'Explore careers', url: '/careers' },
                { name: 'Knowledge graph', url: '/graph' },
                { name: 'AI mentor', url: '/mentor' },
              ],
          } satisfies Partial<ManifestOptions>,
          base,
        ),
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,json}'],
          // Never precache the app shell for PDFs / assets that must hit the network.
          navigateFallback: 'index.html',
          // Workbox tests the denylist against the whole path, not the path relative to
          // the base, so the pattern has to carry the base: under a project site the
          // file is `/<repo>/offline.html`, and `^/offline\.html$` would never match it.
          navigateFallbackDenylist: [new RegExp(`^${escapeRegExp(base)}offline\\.html$`)],
          cleanupOutdatedCaches: true,
          clientsClaim: false,
          skipWaiting: false,
          runtimeCaching: [
            {
              // Public (unauthenticated) career/graph reads only. Authenticated
              // responses carry an Authorization header and are never cached, so a
              // shared device can never leak one user's data to the next.
              urlPattern: ({ url, request }) =>
                request.method === 'GET' &&
                url.pathname.includes('/functions/v1/') &&
                !request.headers.has('authorization') &&
                !request.headers.has('x-client-demo'),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'gm-public-api-v1',
                networkTimeoutSeconds: 6,
                expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 7 },
                cacheableResponse: { statuses: [200] },
              },
            },
            {
              urlPattern: ({ request }) => request.destination === 'image',
              handler: 'CacheFirst',
              options: {
                cacheName: 'gm-images-v1',
                expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: {
        '@': r('./src'),
        // Single source of truth: the pure, runtime-agnostic core is owned by the
        // Edge Functions folder (so `supabase functions deploy` can bundle it) and is
        // imported by the frontend through this alias. No logic is duplicated.
        '@core': r('./supabase/functions/_shared/core'),
      },
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            graph: ['cytoscape'],
          },
        },
      },
    },
    /*
     * Dev/preview servers bind to every interface so a container, a VM or the
     * Capacitor dev workflow can reach them. `allowedHosts` is an allow-list, not
     * a wildcard: localhost, the Cloudflare-style tunnelled preview domains used
     * by hosted sandboxes, and anything listed in DEV_ALLOWED_HOSTS. These
     * settings affect local tooling only — the built site is static files and
     * never runs this server.
     */
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      allowedHosts: devAllowedHosts,
      // The sign-in server (server/server.ts) on our own database. Browsers
      // only ever see same-origin /api; the database stays behind two hops.
      proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, xfwd: true } },
    },
    preview: {
      host: true,
      port: 4173,
      strictPort: true,
      allowedHosts: devAllowedHosts,
      proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, xfwd: true } },
    },
  }
})


