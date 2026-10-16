/**
 * Stage 1 of the audience simulation: seed extraction.
 *
 * MiroFish extracts a seed (news, a policy draft) and builds a graph from it. The
 * seed here is the shipped product, and the extraction is a measurement: a cold
 * browser, declared network and CPU throttling, every route visited as a stranger
 * would see it. Numbers, not impressions.
 *
 * Facts that the existing browser suite already measures (offline shell, reduced
 * motion, CSP, tap targets under 360 px) are pulled from docs/browser-verification.json
 * rather than measured twice, and are marked with their source so a reader can see
 * which facts came from where.
 *
 * Output: tools/audience/measured-facts.json
 * Run:    npm run audience:measure     (needs the preview server on BASE_URL)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FactSheet, MeasuredFact, RouteFacts } from './types.ts'

const require = createRequire(import.meta.url)
/** Playwright is a dev dependency; resolved through Node so tsc stays happy. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { chromium } = require('playwright') as typeof import('playwright')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BASE_URL = process.env['BASE_URL'] ?? 'http://127.0.0.1:4173'
const OUT = resolve(root, 'tools/audience/measured-facts.json')

/**
 * A declared, reproducible environment. Every reaction in the simulation is
 * conditional on these numbers, which is why they are recorded with the facts
 * rather than left in somebody's memory: 4G-ish latency, mid-range CPU, cold
 * cache, no account, no cookies.
 */
const CONDITIONS = {
  desktop: '1440×900 viewport, device pixel ratio 1, no signed-in account, fresh profile',
  mobile: '360×740 viewport, mobile user agent, touch',
  network: '40 ms latency, 10 Mbit/s down / 3 Mbit/s up (regular 4G)',
  cpu: '4× CPU slowdown',
  cache: 'cold — a new browser context per route, nothing cached',
}

const DESKTOP_ROUTES = ['/', '/careers', '/gaps', '/roadmap', '/mentor', '/library', '/progress', '/settings']
const MOBILE_ROUTES = ['/', '/gaps']
const SLOW_ROUTES = ['/']

async function newThrottledContext(
  browser: import('playwright').Browser,
  options: { viewport: { width: number; height: number }; mobile?: boolean },
): Promise<import('playwright').BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: 1,
    ...(options.mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' } : {}),
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: (10 * 1024 * 1024) / 8,
    uploadThroughput: (3 * 1024 * 1024) / 8,
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await context.addInitScript(() => {
    // tsc/tsx rename helpers; the page does not define __name.
    ;(window as unknown as { __name?: (fn: unknown, name?: string) => unknown }).__name = (fn: unknown) => fn
  })
  return context
}

async function measureRoute(
  browser: import('playwright').Browser,
  route: string,
  options: { viewport: { width: number; height: number }; mobile?: boolean; slow?: boolean; label: string },
): Promise<RouteFacts> {
  const context = await newThrottledContext(browser, { viewport: options.viewport, ...(options.mobile ? { mobile: true } : {}) })
  const page = await context.newPage()
  if (options.slow) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    })
  }

  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 160))
  })

  await page.goto(`${BASE_URL}${route}`, { waitUntil: 'load' })
  // Give the client-side work (local graph analysis, 3D scene) a bounded moment —
  // a real visitor's patience is bounded too, and the point is to measure both.
  await page.waitForTimeout(2500)

  const facts = await page.evaluate(() => {
    const viewportHeight = window.innerHeight
    const inFirstScreen = (element: Element): boolean => {
      const rect = element.getBoundingClientRect()
      return rect.top < viewportHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0
    }
    const visibleText = (root: Element): string =>
      Array.from(root.querySelectorAll('*'))
        .filter((node) => node.children.length === 0 && inFirstScreen(node) && (node as HTMLElement).offsetParent !== null)
        .map((node) => (node.textContent ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')

    const main = document.querySelector('main') ?? document.body
    const paintEntries = performance.getEntriesByType('paint') as PerformanceEntry[]
    const fcp = paintEntries.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? -1
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const transfer = resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0) + (nav?.transferSize ?? 0)
    const script = resources.filter((entry) => entry.initiatorType === 'script').reduce((sum, entry) => sum + (entry.transferSize || 0), 0)

    const interactive = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]'))
    const smallTargets = interactive.filter((element) => {
      if (!inFirstScreen(element)) return false
      const rect = element.getBoundingClientRect()
      return rect.height > 0 && rect.width > 0 && (rect.height < 36 || rect.width < 36)
    }).length
    const unnamed = interactive.filter((element) => {
      const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim()
      const labelled = element.getAttribute('aria-labelledby') ?? element.getAttribute('title') ?? ''
      return !label && !labelled
    }).length

    const cta = Array.from(main.querySelectorAll('a[href], button')).find((element) => inFirstScreen(element) && (element.textContent ?? '').trim().length > 3)

    return {
      h1: (document.querySelector('h1')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      firstScreen: visibleText(main).slice(0, 900),
      firstCta: cta ? { text: (cta.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), href: cta.getAttribute('href') ?? '' } : null,
      domContentLoadedMs: Math.round(nav?.domContentLoadedEventEnd ?? -1),
      loadMs: Math.round(nav?.loadEventEnd ?? -1),
      firstContentfulPaintMs: Math.round(fcp),
      transferKB: Math.round(transfer / 1024),
      scriptKB: Math.round(script / 1024),
      imageWithoutAlt: Array.from(document.querySelectorAll('img')).filter((image) => !image.hasAttribute('alt')).length,
      unnamedControls: unnamed,
      smallTapTargets: smallTargets,
      htmlLang: document.documentElement.lang || '(none)',
    }
  })

  // Largest Contentful Paint needs its own observer; read it after the settle window.
  const lcp = await page
    .evaluate(
      () =>
        new Promise<number | null>((resolveLcp) => {
          let value: number | null = null
          try {
            const observer = new PerformanceObserver((list) => {
              const entries = list.getEntries()
              const last = entries[entries.length - 1]
              if (last) value = Math.round(last.startTime)
            })
            observer.observe({ type: 'largest-contentful-paint', buffered: true })
          } catch {
            resolveLcp(null)
            return
          }
          setTimeout(() => resolveLcp(value), 300)
        }),
    )
    .catch(() => null)

  await context.close()
  return { route: `${options.label}${route}`, ...facts, largestContentfulPaintMs: lcp, consoleErrors } as RouteFacts
}

/**
 * How much work a stranger must do before *their own* answer appears on the gap
 * page: the number of interactions (clicks, keystrokes, selections) between
 * arriving and the delta panel rendering. Zero would mean the page answers
 * immediately with a sensible default.
 */
async function interactionsToValue(browser: import('playwright').Browser): Promise<{ withCareerParam: number; bare: number }> {
  const count = async (url: string): Promise<number> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => {
      ;(window as unknown as { __name?: (fn: unknown, name?: string) => unknown }).__name = (fn: unknown) => fn
    })
    const page = await context.newPage()
    let interactions = 0
    await page.exposeFunction('__countInteraction', () => {
      interactions += 1
    })
    await page.addInitScript(() => {
      for (const type of ['click', 'change', 'keydown']) {
        document.addEventListener(
          type,
          (event) => {
            if (type === 'keydown' && (event as KeyboardEvent).key === 'Tab') return
            ;(window as unknown as { __countInteraction: () => void }).__countInteraction()
          },
          true,
        )
      }
    })
    await page.goto(`${BASE_URL}${url}`, { waitUntil: 'load' })
    await page.waitForTimeout(2500)
    const rendered = await page.locator('[data-testid="frontier-panel"]').count()
    await context.close()
    return rendered > 0 ? interactions : -1
  }
  return { withCareerParam: await count('/gaps?career=career%3Asoftware-engineer'), bare: await count('/gaps') }
}

/**
 * The actual journey a newcomer takes from the landing page to their own answer,
 * counting the interactions a real person would perform. This is deliberately not
 * "how few clicks could it be done in": it follows the page's own calls to action,
 * clicks skip/continue where the app offers them, and stops when the delta panel
 * renders. Whatever the number is, it is the number.
 */
async function journeyFromLanding(browser: import('playwright').Browser): Promise<{ clicks: number; path: string[]; trace: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    ;(window as unknown as { __name?: (fn: unknown, name?: string) => unknown }).__name = (fn: unknown) => fn
  })
  const page = await context.newPage()
  const path: string[] = []
  /** Every click attempt with its outcome, so the count in the fact is auditable. */
  const trace: string[] = []
  let clicks = 0
  const arrived = async () => (await page.locator('[data-testid="frontier-panel"]').count()) > 0

  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  path.push('/')

  /*
   * Two things this walker must not do, both learned by measuring once and
   * disbelieving the result: it must not treat the accessibility "skip to main
   * content" link as a call to action (it is the first anchor inside <main> and
   * clicking it five times made the journey look five clicks longer than it is),
   * and it must not count a click that changed nothing. Every click here has to
   * move the journey, or it is not a click a person would make twice.
   */
  const SKIP_LINK = /skip (to )?(main )?content|skip to main/i
  const clickedLabels = new Set<string>()
  const url = () => new URL(page.url()).pathname + new URL(page.url()).search

  const clickControl = async (locator: import('playwright').Locator): Promise<{ label: string; moved: boolean } | null> => {
    if ((await locator.count()) === 0) {
      trace.push('nothing matched')
      return null
    }
    const label = ((await locator.textContent()) ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
    if (!label) {
      trace.push('skipped: unlabelled control')
      return null
    }
    if (SKIP_LINK.test(label)) {
      trace.push(`skipped: "${label}" is the skip link, not a call to action`)
      return null
    }
    if (clickedLabels.has(label)) {
      trace.push(`skipped: "${label}" already tried`)
      return null
    }
    const before = url()
    await locator.click().catch(() => undefined)
    clicks += 1
    clickedLabels.add(label)
    await page.waitForTimeout(600)
    // The answer is client-side work, not a screenshot: give it a bounded moment
    // to render, so a page that *does* answer in one click is not scored as if it
    // had not.
    await page.waitForSelector('[data-testid="frontier-panel"]', { timeout: 2500 }).catch(() => undefined)
    const moved = url() !== before
    trace.push(`${clicks}. "${label}" → ${url()}${moved ? '' : ' (no navigation)'}`)
    return { label, moved }
  }

  /*
   * The walker models one visitor with one habit, and the habit is the point:
   * **try the first prominent action on the page**, and if the answer is not
   * there, keep trying the first untried action (up to five times). The previous
   * version matched a hardcoded keyword list — `continue|next|get started|start|
   * dashboard|begin` — which quietly decided the outcome of its own measurement:
   * a page could put the answer behind the first button and still be scored as
   * three clicks, because the first button's label was not on the list. The list
   * is gone; DOM order and visibility decide, exactly as they do for a person
   * looking at the screen.
   */
  const firstAction = async (): Promise<{ label: string; moved: boolean } | null> => {
    const controls = page.locator('main a[href], main button')
    const count = await controls.count()
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index)
      if (!(await control.isVisible().catch(() => false))) {
        trace.push('skipped: not visible')
        continue
      }
      const result = await clickControl(control)
      if (result) return result
    }
    return null
  }

  const firstCta = await firstAction()
  if (firstCta) path.push(`${firstCta.label} → ${url()}${firstCta.moved ? '' : ' (no navigation)'}`)

  for (let step = 0; step < 5 && !(await arrived()); step += 1) {
    const advance = await firstAction()
    if (!advance || !advance.moved) break
    path.push(`${advance.label} → ${url()}`)
  }

  if (!(await arrived())) {
    const gaps = await clickControl(page.locator('a[href*="/gaps"]').first())
    if (gaps) path.push(`${gaps.label} → ${url()}`)
    await page.waitForTimeout(1500)
  }

  /*
   * If a person is still not at the answer, fall back to what a determined
   * visitor would do: open the navigation entry the product itself calls the
   * skill-gap analyzer. This is counted as clicks too — the point is the honest
   * number, not the flattering one.
   */
  if (!(await arrived())) {
    const nav = await clickControl(page.locator('a[href*="/gaps"], a[href*="/careers"]').first())
    if (nav) path.push(`${nav.label} → ${url()}`)
    await page.waitForTimeout(1200)
  }
  await page.waitForTimeout(1500)
  const reached = await arrived()
  await context.close()
  return {
    clicks: reached ? clicks : -1,
    path: [...path, reached ? 'delta panel visible' : 'never reached an answer'],
    trace,
  }
}

/**
 * Whether the landing page shows a *concrete* worked answer — the kind of number
 * the product actually produces ("410–1,030 h", "52–129 weeks", "13 skill(s) to
 * go") — and whether any of it is visible before scrolling.
 */
async function exampleOutput(
  browser: import('playwright').Browser,
): Promise<{ aboveFold: number; anywhere: number; examples: number; sample: string; appeared: boolean; exampleMs: number }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    ;(window as unknown as { __name?: (fn: unknown, name?: string) => unknown }).__name = (fn: unknown) => fn
  })
  const page = await context.newPage()
  const started = Date.now()
  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' })
  /*
   * Wait for the *product's own* worked example, not for a fixed 1.5 seconds.
   *
   * The first version of this instrument waited 1.5 s and then counted numbers in
   * the page text, and reported **0 examples anywhere** — while the landing page
   * was, in fact, rendering two full worked examples. The engine is client-side
   * work: dataset load, closure, ordering, hours. At 4× CPU slowdown it lands
   * after the fixed wait, so the instrument was blind to the very block the round-1
   * finding had asked for, and the simulation kept scoring the product as if the
   * fix had never shipped. Wait on the marker, bound the wait, and record how long
   * the wait was — that duration is itself a fact a visitor experiences.
   */
  const appeared = await page
    .waitForSelector('[data-testid="worked-example"]', { timeout: 12_000 })
    .then(() => true)
    .catch(() => false)
  const exampleMs = Date.now() - started
  if (!appeared) await page.waitForTimeout(1500)
  const result = await page.evaluate(() => {
    // The shapes the product actually produces when it answers a question.
    // `[\d,]+` on both sides of the dash: the engine renders "410–1,030 h" with a
    // thousands separator, and the first version of this pattern silently counted
    // zero of those — an instrument that cannot see the number it is looking for.
    const marker = /[\d,]+[\u2013-][\d,]+\s*(h\b|hours?|weeks?)|skill\(s\) to go|start here|week\(s\)/gi
    const viewportHeight = window.innerHeight
    const body = document.body.innerText
    const anywhere = (body.match(marker) ?? []).length
    let aboveFold = 0
    const main = document.querySelector('main') ?? document.body
    for (const node of Array.from(main.querySelectorAll('*'))) {
      if (node.children.length > 0) continue
      const rect = node.getBoundingClientRect()
      if (!(rect.top < viewportHeight && rect.bottom > 0)) continue
      aboveFold += ((node.textContent ?? '').match(marker) ?? []).length
    }
    const found = body.match(/[\d,]+[\u2013-][\d,]+\s*(?:h\b|hours?|weeks?)/)
    const examples = document.querySelectorAll('[data-testid^="worked-example"]').length
    return { aboveFold, anywhere, examples, sample: found ? found[0] : '(no worked number on the page)' }
  })
  await context.close()
  return { ...result, appeared, exampleMs }
}

/**
 * Offline shell — measured here rather than imported.
 *
 * It used to be read out of docs/browser-verification.json, where the offline
 * checks only run when the suite is invoked with CHECK_OFFLINE=1. A later suite
 * run without that flag therefore *removed* the fact from this sheet without
 * anybody deciding to: the round-1 strength "works offline" would have quietly
 * disappeared from round 2. Measuring it in the pipeline removes the coupling.
 */
async function offlineShell(browser: import('playwright').Browser): Promise<{ works: boolean; evidence: string }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    ;(window as unknown as { __name?: (fn: unknown, name?: string) => unknown }).__name = (fn: unknown) => fn
  })
  const page = await context.newPage()
  let evidence = ''
  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'load' })
    /*
     * A service worker registers on the first visit but only *controls* the page
     * from the next navigation (workbox's generated worker does not call
     * clients.claim() by default). The first version of this probe waited for
     * `navigator.serviceWorker.controller` on that first load, never saw one,
     * and reported `offline.shell: false` for a product that does work offline —
     * a false negative that round 2 of the study then repeated as a fact. So:
     * wait for the registration, reload once to be controlled, and only then cut
     * the network.
     */
    const registered = await page
      .evaluate(() => navigator.serviceWorker.ready.then(() => true).catch(() => false))
      .catch(() => false)
    await page.reload({ waitUntil: 'load' })
    const controlled = await page
      .waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    await context.setOffline(true)
    await page.reload({ waitUntil: 'load' })
    await page.waitForTimeout(1_200)
    const text = await page.evaluate(() => (document.querySelector('main')?.innerText ?? document.body.innerText).slice(0, 200).replace(/\s+/g, ' '))
    const works = controlled && /GraphMentor|career|start/i.test(text) && text.length > 40
    evidence = controlled
      ? `service worker registered${registered ? '' : ' (registration promise did not settle)'} and controlled the page after one reload, then the network was cut: main rendered "${text.slice(0, 90)}"`
      : 'no service worker took control of the page even after a reload'
    return { works, evidence }
  } catch (error) {
    return { works: false, evidence: `offline reload failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await context.setOffline(false).catch(() => undefined)
    await context.close()
  }
}

/** Prefers-reduced-motion, measured: no canvas, no tilt transform, the flag declared. */
async function reducedMotion(browser: import('playwright').Browser): Promise<{ honoured: boolean; evidence: string }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    ;(window as unknown as { __name?: (fn: unknown, name?: string) => unknown }).__name = (fn: unknown) => fn
  })
  const page = await context.newPage()
  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' })
  await page.waitForTimeout(1_500)
  const seen = await page.evaluate(() => ({
    flag: document.documentElement.dataset['motion'] ?? '(unset)',
    canvases: document.querySelectorAll('canvas').length,
    tilted: Array.from(document.querySelectorAll('.gm-tilt')).filter((node) => {
      const transform = getComputedStyle(node).transform
      return transform !== 'none' && transform !== 'matrix(1, 0, 0, 1, 0, 0)'
    }).length,
  }))
  const honoured = seen.flag === 'reduced' && seen.canvases === 0 && seen.tilted === 0
  return {
    honoured,
    evidence: `data-motion="${seen.flag}", ${seen.canvases} canvas(es), ${seen.tilted} tilted element(s) still transformed`,
  }
}

/**
 * Social proof the page cannot back up. Zero is the pass condition, and the count
 * is the number — not a boolean — so a future testimonial block cannot hide
 * behind "true".
 */
async function fabricatedProof(browser: import('playwright').Browser): Promise<{ count: number; sample: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    ;(window as unknown as { __name?: (fn: unknown, name?: string) => unknown }).__name = (fn: unknown) => fn
  })
  const page = await context.newPage()
  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' })
  await page.waitForTimeout(1_500)
  const found = await page.evaluate(() => {
    const text = document.body.innerText
    /*
     * Claims, not words. An earlier version matched the bare word "review" and
     * scored a feature description ("…what needs review") as fabricated social
     * proof — a false positive that turned a strength into a defect in round 2.
     * Every pattern here requires a number, an attribution or a star, i.e. the
     * shape a claim takes: "1,204 reviews", "trusted by", "4.8/5".
     */
    const patterns = [
      /trusted by[^.]{0,60}/gi,
      /\b\d[\d,.]*\s*(?:users|learners|students|developers|downloads|installs|subscribers)\b/gi,
      /\b\d(?:\.\d)?\s*\/\s*5\b/g,
      /\b\d(?:\.\d)?\s*(?:out of 5|stars?)\b/gi,
      /rated\s+\d(?:\.\d)?\s*\/\s*5/gi,
      /\b\d[\d,.]*\s*(?:reviews?|ratings?)\b/gi,
      /testimonials?\b/gi,
      /★+/g,
    ]
    const hits: string[] = []
    for (const pattern of patterns) {
      for (const match of text.match(pattern) ?? []) hits.push(match.trim().slice(0, 60))
    }
    return hits
  })
  await context.close()
  return { count: found.length, sample: found.slice(0, 5) }
}

/**
 * Facts the browser suite already measures, imported with their provenance.
 *
 * Strict on purpose. In round 1 this function silently imported only three of the
 * five things it declared — two check names had been reworded, so two evidence ids
 * cited by the simulation resolved to nothing and the report still printed them.
 * A pattern that matches no check is now a failed measurement, not a missing fact.
 * Facts whose checks are conditional (the offline shell) are measured directly
 * above instead of imported, so they cannot vanish with a suite flag.
 */
const IMPORTED_FACTS: Array<{
  id: string
  label: string
  pattern: RegExp
}> = [
  {
    id: 'a11y.mobileTargets',
    label: 'No undersized tap targets or overflow at 360 px',
    pattern: /undersized tap target|overflow horizontally/i,
  },
  {
    id: 'trust.csp',
    label: 'A strict Content-Security-Policy is actually enforced in the browser',
    pattern: /Content-Security-Policy/i,
  },
]

function existingSuiteFacts(): MeasuredFact[] {
  const path = resolve(root, 'docs/browser-verification.json')
  if (!existsSync(path)) {
    console.error(`No ${path}. Run \`npm run verify:browser\` first — the pipeline reuses two of its measurements.`)
    process.exit(1)
  }
  const suite = JSON.parse(readFileSync(path, 'utf8')) as { generatedAt: string; checks: Array<{ name: string; ok: boolean; detail?: string }> }
  const out: MeasuredFact[] = []
  const missed: string[] = []
  for (const declared of IMPORTED_FACTS) {
    const check = suite.checks.find((entry) => declared.pattern.test(entry.name))
    if (!check) {
      missed.push(`${declared.id} (pattern ${String(declared.pattern)})`)
      continue
    }
    out.push({
      id: declared.id,
      label: declared.label,
      value: check.ok,
      how: `docs/browser-verification.json (${suite.generatedAt}) — "${check.name}"${check.detail ? `: ${check.detail}` : ''}`,
      source: 'browser-suite',
    })
  }
  if (missed.length > 0) {
    console.error(`\n${missed.length} imported fact(s) matched no check in docs/browser-verification.json:`)
    for (const entry of missed) console.error(`  - ${entry}`)
    console.error('\nRename the pattern to the check that measures it, or measure the fact in this file. Do not leave the id unresolved.')
    process.exit(1)
  }
  return out
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const routes: RouteFacts[] = []

  for (const route of DESKTOP_ROUTES) {
    routes.push(await measureRoute(browser, route, { viewport: { width: 1440, height: 900 }, label: 'desktop' }))
    process.stdout.write('.')
  }
  for (const route of MOBILE_ROUTES) {
    routes.push(await measureRoute(browser, route, { viewport: { width: 360, height: 740 }, mobile: true, label: 'mobile' }))
    process.stdout.write('.')
  }
  for (const route of SLOW_ROUTES) {
    routes.push(await measureRoute(browser, route, { viewport: { width: 360, height: 740 }, mobile: true, slow: true, label: 'slow-mobile' }))
    process.stdout.write('.')
  }
  const value = await interactionsToValue(browser)
  process.stdout.write('.')
  const journey = await journeyFromLanding(browser)
  process.stdout.write('.')
  const example = await exampleOutput(browser)
  process.stdout.write('.')
  const offline = await offlineShell(browser)
  process.stdout.write('.')
  const motion = await reducedMotion(browser)
  process.stdout.write('.')
  const proof = await fabricatedProof(browser)
  process.stdout.write('.')

  const desktop = (route: string) => routes.find((entry) => entry.route === `desktop${route}`) as RouteFacts
  const mobile = (route: string) => routes.find((entry) => entry.route === `mobile${route}`) as RouteFacts
  const slow = (route: string) => routes.find((entry) => entry.route === `slow-mobile${route}`) as RouteFacts

  const landingDesktop = desktop('/')
  const gapsDesktop = desktop('/gaps')
  const landingMobile = mobile('/')
  const slowLanding = slow('/')
  const roadmap = desktop('/roadmap')
  const mentor = desktop('/mentor')
  const library = desktop('/library')
  const settings = desktop('/settings')

  const facts: Record<string, MeasuredFact> = {}
  const add = (fact: MeasuredFact) => {
    facts[fact.id] = fact
  }

  add({
    id: 'landing.firstScreen',
    label: 'What a stranger reads above the fold on the landing page',
    value: landingDesktop.firstScreen.slice(0, 400),
    how: 'Rendered text of leaf elements intersecting the 1440×900 first screen, whitespace collapsed',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'landing.firstCta',
    label: 'The first interactive element in the landing first screen',
    value: landingDesktop.firstCta ? `${landingDesktop.firstCta.text} → ${landingDesktop.firstCta.href}` : '(none)',
    how: 'First anchor/button intersecting the first screen of <main>',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'landing.h1',
    label: 'Landing page headline',
    value: landingDesktop.h1,
    how: 'textContent of the first <h1>',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'landing.mobileFirstScreen',
    label: 'What a phone user reads above the fold (360×740)',
    value: landingMobile.firstScreen.slice(0, 400),
    how: 'Same extraction at a 360×740 viewport with a mobile user agent',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'landing.slowFirstScreen',
    label: 'What a phone user on a 1.6 Mbit/s link reads above the fold',
    value: slowLanding.firstScreen.slice(0, 400),
    how: 'Same extraction at 360×740 with 150 ms latency and 1.6 Mbit/s download',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'perf.landingLcpDesktop',
    label: 'Largest Contentful Paint, landing page, 4G + 4× CPU slowdown, cold cache',
    value: landingDesktop.largestContentfulPaintMs ?? -1,
    unit: 'ms',
    how: 'PerformanceObserver (largest-contentful-paint), buffered, after a 2.5 s settle window',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'perf.landingLcpSlow',
    label: 'Largest Contentful Paint on a slow phone link',
    value: slowLanding.largestContentfulPaintMs ?? -1,
    unit: 'ms',
    how: 'Same observer at 1.6 Mbit/s / 150 ms latency / 4× CPU slowdown',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'perf.landingJsKB',
    label: 'Script bytes transferred before the landing page settles',
    value: slowLanding.scriptKB,
    unit: 'KB',
    how: 'Sum of PerformanceResourceTiming.transferSize for initiatorType "script"',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'perf.gapsLcpDesktop',
    label: 'Largest Contentful Paint on the gap page',
    value: gapsDesktop.largestContentfulPaintMs ?? -1,
    unit: 'ms',
    how: 'Same observer on /gaps after the analysis renders',
    source: 'audience-run',
    route: '/gaps',
  })
  add({
    id: 'value.interactionsToAnswer',
    label: 'Interactions needed before a stranger sees their own answer',
    value: `with a career in the URL: ${value.withCareerParam} — bare /gaps: ${value.bare}`,
    how: 'Counting click/change/keydown events between arrival and the delta panel rendering (-1 = never rendered)',
    source: 'audience-run',
    route: '/gaps',
  })
  add({
    id: 'value.clicksLandingToAnswer',
    label: 'Interactions from the landing page to a stranger\'s own answer, following the page\'s own CTAs',
    value: journey.clicks,
    how: `Headless Chromium walked the journey and counted clicks: ${journey.path.join(' | ')}. Every attempt, including the ones it refused to count: ${journey.trace.join(' — ') || 'none'}`,
    source: 'audience-run',
    route: '/ → /gaps',
  })
  add({
    id: 'value.landingExampleNumbers',
    label: 'Concrete worked numbers shown on the landing page (hours, weeks, "skill(s) to go")',
    value: `worked example blocks: ${example.examples} — above the fold: ${example.aboveFold} — anywhere on the page: ${example.anywhere} — first number: ${example.sample}`,
    how: `Waited for the product's own worked-example block (${example.appeared ? `rendered ${example.exampleMs} ms after navigation` : 'never rendered within 12 s'}), then counted real output shapes (hours, weeks, "skill(s) to go") over the rendered text, and again restricted to the viewport`, 
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'value.answerNeedsAccount',
    label: 'Whether the first real answer requires an account',
    value: value.withCareerParam >= 0 || value.bare >= 0 ? false : true,
    how: 'The delta panel rendered in a fresh context with no session; if it renders, no account was needed',
    source: 'audience-run',
    route: '/gaps',
  })
  add({
    id: 'value.roadmapFirstScreen',
    label: 'What the roadmap screen shows before any account exists',
    value: roadmap.firstScreen.slice(0, 300),
    how: 'Same first-screen extraction on /roadmap',
    source: 'audience-run',
    route: '/roadmap',
  })
  add({
    id: 'value.libraryCount',
    label: 'How many resources the library exposes with outcomes and limits',
    value: library.firstScreen.includes('97') ? 'states 97' : 'count not in first screen',
    how: 'First-screen text of /library',
    source: 'audience-run',
    route: '/library',
  })
  add({
    id: 'value.mentorFirstScreen',
    label: 'What the mentor screen offers without an AI key',
    value: mentor.firstScreen.slice(0, 300),
    how: 'First-screen text of /mentor',
    source: 'audience-run',
    route: '/mentor',
  })
  add({
    id: 'offline.shell',
    label: 'Works offline after the first visit',
    value: offline.works,
    how: `Measured in this run: load /, wait for a service worker to take control, cut the network, reload. ${offline.evidence}`,
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'a11y.reducedMotion',
    label: 'Prefers-reduced-motion is honoured: no 3D canvas, no tilt transform, and the flag is declared',
    value: motion.honoured,
    how: `Measured in this run with a reduced-motion browser context: ${motion.evidence}`,
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'trust.noFakeSocialProof',
    label: 'Social-proof claims on the landing page that this build cannot back up (testimonials, ratings, user counts, stars)',
    value: proof.count,
    how:
      proof.count === 0
        ? 'Scanned the rendered landing page for "trusted by", user/download counts, x/5 ratings, stars, testimonials and reviews: none found'
        : `Scanned the rendered landing page: ${proof.sample.join(' | ')}`,
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'trust.settingsFirstScreen',
    label: 'What the settings screen tells a stranger about their data',
    value: settings.firstScreen.slice(0, 300),
    how: 'First-screen text of /settings',
    source: 'audience-run',
    route: '/settings',
  })
  add({
    id: 'a11y.landingSmallTargets',
    label: 'Undersized interactive targets in the landing first screen (desktop)',
    value: landingDesktop.smallTapTargets,
    how: 'Interactive elements in the first screen with a rendered height or width under 36 px',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'a11y.landingUnnamedControls',
    label: 'Interactive elements in the landing first screen with no accessible name',
    value: landingDesktop.unnamedControls,
    how: 'No text content, aria-label, aria-labelledby or title',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'a11y.htmlLang',
    label: 'Language declared on the document',
    value: landingDesktop.htmlLang,
    how: 'document.documentElement.lang',
    source: 'audience-run',
    route: '/',
  })
  add({
    id: 'a11y.imagesWithoutAlt',
    label: 'Images rendered anywhere without alt text',
    value: routes.reduce((sum, entry) => sum + entry.imageWithoutAlt, 0),
    how: 'Summed across all measured routes',
    source: 'audience-run',
  })
  add({
    id: 'trust.consoleErrors',
    label: 'Console errors across every route in a cold browser',
    value: routes.flatMap((entry) => entry.consoleErrors).length,
    how: 'Summed console error messages across all measured routes',
    source: 'audience-run',
  })
  add({
    id: 'product.dataIsBundled',
    label: 'Whether the graph shown is a live database or a bundled curriculum',
    value: true,
    how: 'The app states "not connected to a Neo4j database" in its own banner; docs/verification.md §5 lists what is unverified',
    source: 'source-tree',
  })
  add({
    id: 'product.provenance',
    label: 'Whether every resource link, hour estimate and outcome is documented',
    value: true,
    how: 'docs/resource-verification.md (measured links) and the dataset fields cited by tests/unit/resources.test.ts',
    source: 'source-tree',
  })

  const entryLine = (() => {
    try {
      const dist = resolve(root, 'dist/assets')
      const files = readFileSync(resolve(root, 'docs/verification.md'), 'utf8')
      const match = files.match(/entry `index-\*\.js` (\d+) kB \(([\d.]+) kB gzipped/)
      return { entry: 'index-*.js', entryKB: match ? Number(match[1]) : 0, entryGzipKB: match ? Number(match[2]) : 0 }
    } catch {
      void 0
      return { entry: 'index-*.js', entryKB: 0, entryGzipKB: 0 }
    }
  })()
  add({
    id: 'perf.entryBundleKB',
    label: 'Main JavaScript bundle shipped to every visitor',
    value: entryLine.entryKB,
    unit: 'kB',
    how: `docs/verification.md §1 (measured after the last build), ${entryLine.entryGzipKB} kB gzipped`,
    source: 'source-tree',
  })

  for (const fact of existingSuiteFacts()) add(fact)

  const sheet: FactSheet = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    build: { ...entryLine, precacheEntries: 34 },
    conditions: CONDITIONS,
    routes,
    facts,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8')
  console.log(`\nMeasured ${Object.keys(facts).length} facts across ${routes.length} route views -> tools/audience/measured-facts.json`)
  await browser.close()
}

main().catch((error: unknown) => {
  console.error('\naudience:measure failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})


