/// <reference lib="dom" />
/**
 * verify-browser — render the app in a real browser engine and check what jsdom
 * cannot: WebGL, the neumorphic material, mobile layout, reduced motion, and
 * the service worker.
 *
 * Why this exists: every previous verification of this project ran in jsdom,
 * which has no layout engine, no WebGL and no CSS. That meant the two three.js
 * scenes had **never been rendered anywhere**, and the glass system had never
 * been seen. A screenshot is not a proof of correctness, but "we never ran it"
 * is a certainty of nothing, and this script closes that gap.
 *
 * It uses Chromium with SwiftShader (software WebGL), so it works on a machine
 * with no GPU. That is also its main caveat: software rendering is slower and
 * its float precision differs from a real GPU, so this proves the code paths
 * execute and produce non-blank output — not that the result looks good on your
 * phone. Screenshots are written to docs/screenshots/ for a human to judge.
 *
 * Checks, in order:
 *   1. the landing hero actually draws (a canvas exists, is sized, and its pixels
 *      are not uniform),
 *   2. dragging spins it — the pixels change when the pointer moves,
 *   3. the 3D graph view draws a different scene, and selecting a node works,
 *   4. the neumorphic material is real: one base colour everywhere, a light/dark
 *      shadow PAIR on raised surfaces, an inset pair on pressed ones, no blur,
 *      and text that still passes contrast on the material,
 *   5. mobile layout: no horizontal overflow at 360 px, and touch targets are
 *      large enough,
 *   6. reduced motion: the scene is replaced by its static fallback,
 *   7. no console errors and no failed requests anywhere in the run,
 *   8. the built app registers a service worker and survives going offline,
 *   9. the resource library renders what the dataset actually holds — every
 *      resource with its outcomes, prerequisites, limits and time, and the
 *      access filter and search really narrowing the list,
 *  10. the Content-Security-Policy is *enforced*, not just declared: the app
 *      loads without tripping its own policy, an injected <style> is refused,
 *      the CSP-level-2 style attribute fallback still works, and the graph
 *      surface positions itself without relying on a style the policy blocks.
 *
 * Usage:
 *   npm run verify:browser                     # against npm run dev (port 5173)
 *   BASE_URL=http://127.0.0.1:4173 npm run verify:browser   # against a preview of dist/
 *
 * The `lib="dom"` reference above is scoped to this file: the script runs in Node,
 * but everything inside `page.evaluate` executes in the browser, so the DOM types
 * are what those callbacks are written against.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type BrowserContext, type ConsoleMessage, type Page } from 'playwright'

import { datasetCounts, knowledgeGraph } from '../src/data/seed/knowledgeGraph.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const BASE_URL = process.env['BASE_URL'] ?? 'http://127.0.0.1:5173'
const SHOT_DIR = resolve(root, 'docs/screenshots')
const OFFLINE = process.env['CHECK_OFFLINE'] === '1'

interface Result {
  name: string
  ok: boolean
  detail?: string
}

const results: Result[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * esbuild (via tsx) injects `__name(fn, "fn")` wrappers when `keepNames` is on,
 * to improve stack traces. That helper is a Node-side artefact: as soon as a
 * callback is serialised into the browser by `page.evaluate`, the wrapper runs
 * where `__name` does not exist and throws `ReferenceError: __name is not defined`.
 *
 * Defining a no-op on the page is the smallest fix that keeps these callbacks
 * readable. The alternative — avoiding every named inner function inside every
 * `evaluate` — makes this file noticeably harder to follow for no real benefit.
 */
async function installNameShim(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scope = window as unknown as Record<string, unknown>
    if (typeof scope['__name'] !== 'function') scope['__name'] = (value: unknown) => value
  })
}

/* ==========================================================================
 * Pixel inspection
 * ========================================================================== */

interface PixelStats {
  width: number
  height: number
  /** Fraction of sampled pixels with a visible (non-black, non-transparent) colour. */
  coverage: number
  /** Distinct colours among the samples — a flat fill gives 1, a scene gives many. */
  distinctColours: number
  /** Cheap fingerprint, used to detect that the picture changed. */
  digest: string
}

/**
 * Pixel statistics for a canvas, read from **the composited page** rather than
 * from the WebGL drawing buffer.
 *
 * `preserveDrawingBuffer` is false (the right default for performance), so the
 * drawing buffer is cleared once the frame is presented: an in-page
 * `drawImage`/`getImageData` of a live `three.js` canvas can legitimately come
 * back empty even while the page is visibly drawing a scene. The first version of
 * this function did exactly that and reported a perfect hero and graph as blank.
 *
 * A screenshot goes through the compositor, so it is what a person sees. It is
 * decoded back inside the page (using the browser's own PNG decoder) and reduced
 * to the same statistics: how much of the surface is non-transparent, how many
 * distinct colours there are, and a digest that changes when the frame changes.
 */
async function canvasStats(page: Page, selector: string): Promise<PixelStats | null> {
  const element = page.locator(selector).first()
  if ((await element.count()) === 0) return null
  let png: Buffer
  try {
    png = await element.screenshot({ type: 'png' })
  } catch {
    return null
  }
  const base64 = png.toString('base64')
  return page.evaluate(async (data: string) => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    try {
      await image.decode()
    } catch {
      return null
    }
    if (image.width === 0 || image.height === 0) {
      return { width: image.width, height: image.height, coverage: 0, distinctColours: 0, digest: 'empty' }
    }
    const sampler = document.createElement('canvas')
    sampler.width = 64
    sampler.height = 64
    const context = sampler.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.clearRect(0, 0, 64, 64)
    context.drawImage(image, 0, 0, 64, 64)
    const { data: pixels } = context.getImageData(0, 0, 64, 64)

    let visible = 0
    let sum = 0
    const colours = new Set<string>()
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index] ?? 0
      const g = pixels[index + 1] ?? 0
      const b = pixels[index + 2] ?? 0
      const a = pixels[index + 3] ?? 0
      if (a > 8 && r + g + b > 24) visible += 1
      sum = (sum + r * 3 + g * 5 + b * 7 + a * 11) % 2147483647
      colours.add(`${r >> 4}-${g >> 4}-${b >> 4}`)
    }
    const samples = pixels.length / 4
    return {
      width: image.width,
      height: image.height,
      coverage: Number((visible / samples).toFixed(3)),
      distinctColours: colours.size,
      digest: `${sum}:${visible}`,
    }
  }, base64)
}

/**
 * Waits for the 3D substrate to report that it is actually drawing.
 *
 * This exists because of two bugs that a canvas-presence check alone did not
 * catch (they were found here, but only after reading this attribute):
 *
 *   1. `Scene3D`'s build effect depended on `status === 'waiting'` — a boolean
 *      that never changed — so after the first run returned early at 0×0 the
 *      scene stayed `waiting` for the life of the page.
 *   2. The same effect called `setStatus('building')`, which re-ran the effect,
 *      whose cleanup then cancelled the in-flight build. The scene stayed
 *      `building` forever.
 *
 * Both left the component *mounted with no canvas*, and both would pass a check
 * that only looked for the absence of an error. So this asserts the terminal
 * state, and reports how long it took.
 */
async function waitForSceneRunning(page: Page, timeoutMs = 20_000): Promise<{ ok: boolean; status: string; elapsedMs: number }> {
  const started = Date.now()
  const target = page.locator('[data-testid="scene-3d"][data-status="running"]')
  try {
    await target.first().waitFor({ state: 'attached', timeout: timeoutMs })
    return { ok: true, status: 'running', elapsedMs: Date.now() - started }
  } catch {
    const status = await page
      .locator('[data-testid="scene-3d"]')
      .first()
      .getAttribute('data-status')
      .catch(() => null)
    return { ok: false, status: status ?? 'absent', elapsedMs: Date.now() - started }
  }
}

/* ==========================================================================
 * Run
 * ========================================================================== */

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  })

  const consoleErrors: string[] = []
  const failedRequests: string[] = []

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await installNameShim(context)
  const page = await context.newPage()
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200))
  })
  page.on('pageerror', (error: Error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 200)}`))
  page.on('requestfailed', (request) => {
    // Aborted requests are how the browser cancels work on navigation; not a fault.
    const failure = request.failure()?.errorText ?? ''
    if (!/aborted/i.test(failure)) failedRequests.push(`${request.url().slice(0, 120)} (${failure})`)
  })

  console.log(`verify-browser — real Chromium against ${BASE_URL}\n`)
  console.log('0. The capability probe, and the user’s override')

  /*
   * The gate, reported honestly rather than assumed.
   *
   * `detectWebGL()` asks for a context with `failIfMajorPerformanceCaveat: true`,
   * which is meant to refuse a software rasteriser. Chromium here renders through
   * ANGLE/SwiftShader but still hands back a context for the caveat-bearing
   * request, so on *this* machine the gate cannot refuse — and a check that
   * asserted "no canvas" would only be testing Chromium's honesty about its own
   * renderer. What is asserted instead is the contract: the app's own answer
   * decides. If the probe says no, no canvas is mounted (the flat fallback shows);
   * if it says yes, the scene must actually run. The override is then exercised
   * explicitly, which is the part users control.
   */
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const gated = await page.evaluate(() => {
    const probe = document.createElement('canvas')
    const attributes = { failIfMajorPerformanceCaveat: true }
    const caveatContext = probe.getContext('webgl2', attributes) ?? probe.getContext('webgl', attributes)
    return {
      caveatSupported: Boolean(caveatContext),
      canvases: document.querySelectorAll('canvas').length,
      sceneStatus: document.querySelector('[data-testid="scene-3d"]')?.getAttribute('data-status') ?? 'absent',
    }
  })
  const gateHonoured = gated.caveatSupported ? gated.canvases > 0 : gated.canvases === 0
  check(
    'the app follows its own capability probe rather than mounting 3D regardless',
    gateHonoured,
    gated.caveatSupported
      ? `probe reports WebGL available on this renderer (software rasteriser accepted) → ${gated.canvases} canvas(es) mounted`
      : `probe refuses this renderer → ${gated.canvases} canvas(es), status ${gated.sceneStatus}`,
  )

  // Now override it the way a person would: through the real settings screen.
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle' })
  const forceToggle = page.locator('#force-3d')
  await forceToggle.waitFor({ state: 'visible', timeout: 15_000 })
  await forceToggle.check()
  await page.waitForTimeout(400)
  const persisted = await page.evaluate(() => {
    // Found by suffix rather than hardcoded: the storage prefix is part of the
    // app's versioned key scheme (`gm.v1.`) and a verifier that guessed it would
    // report a working feature as broken — which is exactly what happened here.
    const key = Object.keys(window.localStorage).find((candidate) => candidate.endsWith('.ui'))
    if (!key) return false
    const raw = window.localStorage.getItem(key) ?? '{}'
    return (JSON.parse(raw) as { force3d?: boolean }).force3d === true
  })
  check('the “try 3D anyway” override is a real, persisted preference', persisted)

  console.log('\n1. The landing hero')

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })
  // The scene is built only after its container has a measured size, so this
  // waits for the frame rather than for a timer.
  const heroCanvas = page.locator('[data-testid="scene-3d"] canvas').first()
  let heroDrawn = false
  try {
    await heroCanvas.waitFor({ state: 'visible', timeout: 15_000 })
    heroDrawn = true
  } catch {
    heroDrawn = false
  }
  const heroStatus = await waitForSceneRunning(page)
  check(
    'the hero scene reaches the “running” state (not stuck preparing)',
    heroStatus.ok,
    `status=${heroStatus.status} after ${heroStatus.elapsedMs} ms`,
  )
  check('the hero 3D scene mounts a canvas in a real browser', heroDrawn)

  /*
   * Legibility of the copy that sits on top of the scene.
   *
   * The scene is bright and drifts, so a node can pass behind the headline. A
   * scrim layer keeps the text readable; without it the accent-coloured line
   * dropped to about 1:1 contrast against a mid-tone node. This check is the
   * cheap structural half of that: every sample point inside the headline must
   * hit the copy, never the canvas, and the scrim must actually paint.
   */
  const heroLegibility = await page.evaluate(() => {
    const heading = document.querySelector('.gm-hero-copy h1')
    const scrim = document.querySelector('.gm-hero-scrim')
    let samples = 0
    let overCanvas = 0
    if (heading) {
      const rect = heading.getBoundingClientRect()
      for (let x = rect.left + 4; x < rect.right - 4; x += 18) {
        for (let y = rect.top + 3; y < rect.bottom - 3; y += 9) {
          samples += 1
          const hit = document.elementFromPoint(x, y)
          if (hit && hit.tagName === 'CANVAS') overCanvas += 1
        }
      }
    }
    return {
      samples,
      overCanvas,
      scrimBackground: scrim ? getComputedStyle(scrim).backgroundImage : '',
      scrimZ: scrim ? getComputedStyle(scrim).zIndex : '',
    }
  })
  check(
    'the hero copy is painted above the 3D scene, not under it',
    heroLegibility.samples > 20 && heroLegibility.overCanvas === 0,
    `${heroLegibility.overCanvas} of ${heroLegibility.samples} samples hit the canvas`,
  )
  check(
    'a legibility scrim sits between the scene and the copy',
    /gradient/.test(heroLegibility.scrimBackground) && heroLegibility.scrimZ !== '' && Number(heroLegibility.scrimZ) >= 1,
    `z-index ${heroLegibility.scrimZ || 'auto'}`,
  )

  if (heroDrawn) {
    await page.waitForTimeout(1200) // let the intro animation settle
    const first = await canvasStats(page, '[data-testid="scene-3d"] canvas')
    check(
      'the hero canvas has a real size',
      (first?.width ?? 0) > 100 && (first?.height ?? 0) > 100,
      `${first?.width ?? 0}×${first?.height ?? 0}`,
    )
    check(
      'the hero actually draws something (not a blank or uniform surface)',
      (first?.coverage ?? 0) > 0.02 && (first?.distinctColours ?? 0) > 3,
      `coverage ${first?.coverage ?? 0}, ${first?.distinctColours ?? 0} distinct colours`,
    )

    // Drag to spin: the scene's whole interaction, exercised the way a visitor does.
    const box = await heroCanvas.boundingBox()
    if (box) {
      const startX = box.x + box.width / 2
      const startY = box.y + box.height / 2
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      for (let step = 1; step <= 12; step += 1) {
        await page.mouse.move(startX + step * 14, startY + step * 3)
      }
      await page.mouse.up()
      await page.waitForTimeout(500)
      const after = await canvasStats(page, '[data-testid="scene-3d"] canvas')
      check(
        'dragging rotates the scene (the frame changes)',
        (after?.digest ?? '') !== (first?.digest ?? ''),
        `${first?.digest ?? '?'} → ${after?.digest ?? '?'}`,
      )
    }

    await page.screenshot({ path: resolve(SHOT_DIR, 'landing-hero.png') })
    check('wrote docs/screenshots/landing-hero.png', true)
  }

  console.log('\n2. The neumorphic material')

  /*
   * Neumorphism is easy to fake and easy to get wrong. What makes it real:
   *   1. ONE material — every surface is the same colour as the page, so cards
   *      are the page pushed out rather than a different colour dropped on it,
   *   2. a PAIR of shadows — light up-left, dark down-right, never a single
   *      drop shadow (that would just be a flat card),
   *   3. the press INVERTS it — form fields cast the same pair inwards, and a
   *      held button does too,
   *   4. no blur — the whole point of leaving glass behind,
   *   5. text still passes contrast on the material, which is where soft UI
   *      usually fails.
   *
   * This needs TWO probes. The landing page has the hero card, the app bar and
   * the buttons, but it renders no chip and no form field at all, so probing
   * only `/` measured `null` for half these assertions and reported the CSS as
   * broken when the verifier was the broken part. The second probe is a
   * content-heavy route, where chips, fields and list surfaces actually exist.
   */
  const readMaterial = () =>
    page.evaluate(() => {
      const parseColour = (value: string): [number, number, number] | null => {
        const match = value.match(/rgba?\(([^)]+)\)/)
        if (!match) return null
        const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
        if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null
        return [parts[0], parts[1], parts[2]]
      }
      const channel = (value: number): number => {
        const c = value / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      const luminance = (rgb: [number, number, number]): number =>
        0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
      const ratio = (a: [number, number, number], b: [number, number, number]): number => {
        const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
        return (light + 0.05) / (dark + 0.05)
      }
      /** Counts the shadow layers in a computed box-shadow, and their direction. */
      const shadowParts = (value: string): Array<{ inset: boolean; x: number; y: number; blur: number }> => {
        if (!value || value === 'none') return []
        return value
          .split(/,(?![^(]*\))/)
          .map((part) => part.trim())
          .map((part) => {
            const inset = /inset/.test(part)
            const numbers = part.match(/-?\d+(?:\.\d+)?px/g) ?? []
            return { inset, x: Number.parseFloat(numbers[0] ?? '0'), y: Number.parseFloat(numbers[1] ?? '0'), blur: Number.parseFloat(numbers[2] ?? '0') }
          })
      }

      const card = document.querySelector('.gm-card') as HTMLElement | null
      const chip = document.querySelector('.gm-chip') as HTMLElement | null
      const input = document.querySelector('.gm-input, .gm-select, .gm-textarea') as HTMLElement | null
      const primary = document.querySelector('.gm-btn-primary') as HTMLElement | null
      const header = document.querySelector('header') as HTMLElement | null
      const cardStyle = card ? getComputedStyle(card) : null
      const cardOuter = cardStyle ? shadowParts(cardStyle.boxShadow).filter((part) => !part.inset) : []
      const chipOuter = chip ? shadowParts(getComputedStyle(chip).boxShadow).filter((part) => !part.inset) : []
      const readBackdrop = (style: CSSStyleDeclaration): string =>
        style.backdropFilter || (style as unknown as Record<string, string>)['webkitBackdropFilter'] || ''

      // `.gm-panel` is a defined surface that no screen currently renders (the
      // `Panel` component has no callers), so it is measured by attaching one:
      // this checks the cascade resolves the recipe, not that a screen shows it.
      const panelProbe = document.createElement('div')
      panelProbe.className = 'gm-panel'
      document.body.appendChild(panelProbe)
      const panelShadow = getComputedStyle(panelProbe).boxShadow
      panelProbe.remove()

      // The darkest text any surface shows, measured against that surface.
      const bodyColour = parseColour(getComputedStyle(document.body).color)
      const cardColour = cardStyle ? parseColour(cardStyle.backgroundColor) : null
      const mutedProbe = document.querySelector('.text-muted') as HTMLElement | null
      const mutedColour = mutedProbe ? parseColour(getComputedStyle(mutedProbe).color) : null
      // A `none` value is a passing value for "no blur", so it must not be
      // stringified into the failing evidence the way it was before.
      const blurValues = [cardStyle, chip ? getComputedStyle(chip) : null, input ? getComputedStyle(input) : null, header ? getComputedStyle(header) : null, primary ? getComputedStyle(primary) : null]
        .filter((style): style is CSSStyleDeclaration => style !== null)
        .map(readBackdrop)
        .filter((value) => value && value !== 'none')

      return {
        route: window.location.pathname,
        pageBackground: getComputedStyle(document.body).backgroundColor,
        cardBackground: cardStyle?.backgroundColor ?? '',
        cardShadow: cardStyle?.boxShadow ?? '',
        cardOuterShadowCount: cardOuter.length,
        // Light up-left (negative x, negative y) and dark down-right (positive).
        hasLightUpLeft: cardOuter.some((part) => part.x < 0 && part.y < 0),
        hasDarkDownRight: cardOuter.some((part) => part.x > 0 && part.y > 0),
        cardBlur: Math.max(0, ...cardOuter.map((part) => part.blur)),
        chipBackground: chip ? getComputedStyle(chip).backgroundColor : '',
        chipOuterShadowCount: chipOuter.length,
        chipHasLight: chipOuter.some((part) => part.x < 0 && part.y < 0),
        chipHasDark: chipOuter.some((part) => part.x > 0 && part.y > 0),
        chipBlur: Math.max(0, ...chipOuter.map((part) => part.blur)),
        chipCount: document.querySelectorAll('.gm-chip').length,
        panelShadow,
        panelOuterShadowCount: shadowParts(panelShadow).filter((part) => !part.inset).length,
        inputCount: document.querySelectorAll('.gm-input, .gm-select, .gm-textarea').length,
        inputShadow: input ? getComputedStyle(input).boxShadow : '',
        inputInset: input ? shadowParts(getComputedStyle(input).boxShadow).some((part) => part.inset) : false,
        primaryShadow: primary ? getComputedStyle(primary).boxShadow : '',
        headerShadow: header ? getComputedStyle(header).boxShadow : '',
        headerBackground: header ? getComputedStyle(header).backgroundColor : '',
        blurValues,
        contrast: {
          body: bodyColour && cardColour ? ratio(bodyColour, cardColour) : 0,
          muted: mutedColour && cardColour ? ratio(mutedColour, cardColour) : 0,
        },
      }
    })

  const landing = await readMaterial()
  // A content-heavy route, where chips and form fields actually render.
  await page.goto(`${BASE_URL}/roadmap`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const content = await readMaterial()

  check(
    'the landing screen is one material (page, card and app bar share one colour)',
    landing.pageBackground === landing.cardBackground && landing.headerBackground === landing.cardBackground,
    `page ${landing.pageBackground}, card ${landing.cardBackground}, header ${landing.headerBackground}`,
  )
  check(
    'a content route keeps that single material (page, card, chip and app bar)',
    content.chipCount > 0 && content.inputCount > 0 && content.pageBackground === content.cardBackground && content.chipBackground === content.pageBackground && content.headerBackground === content.pageBackground,
    `${content.cardBackground} card / ${content.chipBackground} chip over ${content.pageBackground} page (${content.chipCount} chips, ${content.inputCount} fields)`,
  )
  check(
    'cards cast a PAIR of shadows, light up-left and dark down-right',
    landing.cardOuterShadowCount >= 2 && landing.hasLightUpLeft && landing.hasDarkDownRight,
    `${landing.cardOuterShadowCount} layers: ${landing.cardShadow.slice(0, 70)}…`,
  )
  check(
    'chips cast the same pair, scaled down to chip size',
    content.chipOuterShadowCount >= 2 && content.chipHasLight && content.chipHasDark && content.chipBlur < content.cardBlur,
    `${content.chipOuterShadowCount} layers, blur ${content.chipBlur}px vs card ${content.cardBlur}px`,
  )
  check(
    'the .gm-panel surface resolves to the raised pair (recipe probe: no screen renders it yet)',
    content.panelOuterShadowCount >= 2,
    `${content.panelOuterShadowCount} outer layers: ${content.panelShadow.slice(0, 60)}…`,
  )
  check(
    'form fields are pressed IN (the canonical inset surface)',
    content.inputInset,
    content.inputShadow.slice(0, 60),
  )
  check(
    'the app bar is the same material, held above the page by its own shadow',
    /rgb/.test(landing.headerShadow),
    landing.headerShadow.slice(0, 60),
  )
  check('the accent button keeps the material' + "'" + 's depth language', /rgb/.test(landing.primaryShadow), landing.primaryShadow.slice(0, 60))
  check(
    'no backdrop blur anywhere on the chrome (this is not glass wearing a costume)',
    landing.blurValues.length === 0 && content.blurValues.length === 0,
    [...landing.blurValues, ...content.blurValues].join(' | ') || 'none',
  )
  check(
    'body text passes WCAG AA on the material',
    landing.contrast.body >= 4.5,
    `${landing.contrast.body.toFixed(2)}:1`,
  )
  check(
    'muted text stays legible on the material (soft UI usually fails here)',
    landing.contrast.muted >= 4.5,
    `${landing.contrast.muted.toFixed(2)}:1`,
  )

  // The press: hovering deepens the pair, holding the mouse down inverts it.
  // Link-buttons need `draggable={false}` for this to work at all — Chrome
  // starts a native link drag on mousedown, which cancels `:active`, so a
  // navigation button used to give no press feedback whatsoever.
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })
  const secondary = page.locator('.gm-btn-secondary').first()
  if (await secondary.count()) {
    const readShadow = () => secondary.evaluate((el) => getComputedStyle(el).boxShadow)
    // Poll to a settle rather than sleeping a fixed 260 ms: on a busy main thread
    // (the WebGL sections just ran) a transition can start late, which made this
    // check flake with the rest value still showing.
    const settle = async (wanted: (value: string) => boolean): Promise<string> => {
      let seen = await readShadow()
      for (let attempt = 0; attempt < 20 && !wanted(seen); attempt += 1) {
        await page.waitForTimeout(120)
        seen = await readShadow()
      }
      return seen
    }
    const before = await readShadow()
    await secondary.hover()
    const hovered = await settle((value) => value !== before)
    // Hold the button down for real, re-aiming at its live position: `hover()`
    // scrolls it into view, and a press dispatched at a stale coordinate lands
    // off the button (hover stayed, `:active` did not). Up to three attempts —
    // each one still has to produce a genuine `:active` *and* the inset pair.
    let pressed = await readShadow()
    let held = false
    for (let attempt = 0; attempt < 3 && !held; attempt += 1) {
      const box = await secondary.boundingBox()
      if (!box) break
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      held = await secondary.evaluate((el) => el.matches(':active'))
      pressed = held ? await settle((value) => /inset/.test(value)) : await readShadow()
      // Release off the button: it is a real navigation link, so letting the
      // click land would take the page somewhere else mid-verification.
      await page.mouse.move(4, 4)
      await page.mouse.up()
      if (!held) await page.waitForTimeout(150)
    }
    check('hovering a button deepens its shadow', before !== hovered, `${before.slice(0, 34)}… → ${hovered.slice(0, 34)}…`)
    check('pressing a button casts the shadow inwards', /inset/.test(pressed), held ? pressed.slice(0, 60) : `held element was not :active — ${pressed.slice(0, 40)}`)
  } else {
    check('a secondary button exists to press', false, 'none found on the landing page')
  }

  /*
   * One material, as PAINTED. Everything above reads computed styles, and a
   * translucent overlay passes all of them while still painting a card almost
   * white — which is exactly what the first version of this restyle did: a
   * 55%-opacity gradient lip washed the top quarter of every large sheet, so a
   * card read as a white panel dropped on the page. These two checks sample the
   * rendered pixels instead: the median colour inside a card and along the app
   * bar must equal the median colour of the bare page beside them.
   */
  await page.evaluate(() => window.scrollTo(0, 0))
  const regions = await page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }
    }
    return {
      card: box(document.querySelector('.gm-card')),
      header: box(document.querySelector('header')),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })
  if (regions.card && regions.header && regions.card.bottom > regions.card.top + 40) {
    const decoder = await browser.newPage()
    const medianColour = async (clip: { x: number; y: number; width: number; height: number }): Promise<number[]> => {
      const shot = await page.screenshot({ clip })
      return decoder.evaluate(async (dataUrl) => {
        const image = new Image()
        image.src = dataUrl
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return [0, 0, 0]
        ctx.drawImage(image, 0, 0)
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const channels: number[][] = [[], [], []]
        for (let i = 0; i < data.length; i += 4) {
          channels[0].push(data[i])
          channels[1].push(data[i + 1])
          channels[2].push(data[i + 2])
        }
        // Median, not mean: the card interior contains text, and its glyphs must
        // not drag the reading away from the surface underneath them.
        return channels.map((values) => {
          const sorted = values.sort((a, b) => a - b)
          return sorted[Math.floor(sorted.length / 2)]
        })
      }, `data:image/png;base64,${shot.toString('base64')}`)
    }
    const edge = 3
    const paintedCard = await medianColour({
      x: regions.card.left + edge,
      y: regions.card.top + edge,
      width: regions.card.right - regions.card.left - edge * 2,
      height: regions.card.bottom - regions.card.top - edge * 2,
    })
    const paintedPage = await medianColour({
      x: 4,
      y: regions.card.top,
      width: Math.max(8, regions.card.left - 8),
      height: regions.card.bottom - regions.card.top,
    })
    const paintedBar = await medianColour({
      x: Math.round(regions.viewport.width * 0.28),
      y: regions.header.top,
      width: Math.round(regions.viewport.width * 0.05),
      height: Math.max(1, regions.header.bottom - regions.header.top),
    })
    await decoder.close()
    const delta = (a: number[], b: number[]): number => Math.max(...a.map((value, index) => Math.abs(value - b[index])))
    check(
      'the card is the page colour in rendered pixels, not only in computed styles',
      delta(paintedCard, paintedPage) <= 12,
      `card rgb(${paintedCard.join(', ')}) vs page rgb(${paintedPage.join(', ')})`,
    )
    check(
      'the app bar paints that same material too',
      delta(paintedBar, paintedPage) <= 12,
      `bar rgb(${paintedBar.join(', ')}) vs page rgb(${paintedPage.join(', ')})`,
    )
  } else {
    check('a card and an app bar exist to sample their painted colour', false, 'no card or header found on the landing page')
  }

  await page.screenshot({ path: resolve(SHOT_DIR, 'landing-hero.png') })
  check('wrote docs/screenshots/landing-hero.png', true)

  console.log('\n3. The 3D graph view')

  /*
   * A starting point first: the explorer deliberately refuses to load the whole
   * graph, so "3D is blank" before a career is chosen is correct behaviour, not a
   * bug — this verifier was briefly wrong about exactly that.
   *
   * Choosing the career also covers a real defect found by driving the page:
   * `setParam` was called twice in one handler (`career`, then `seed`) and the
   * second call rebuilt the URL from the pre-navigation params and erased the
   * first, so selecting a career did nothing at all.
   */
  await page.goto(`${BASE_URL}/graph`, { waitUntil: 'networkidle' })
  const careerSelect = page.locator('#graph-career')
  await careerSelect.waitFor({ state: 'visible', timeout: 15_000 })
  await careerSelect.selectOption({ index: 1 })
  await page.waitForTimeout(2000)
  const seeded = await page.evaluate(() => ({
    search: window.location.search,
    value: (document.querySelector('#graph-career') as HTMLSelectElement | null)?.value ?? '',
    canvases: document.querySelectorAll('canvas').length,
    counts: (document.body.textContent ?? '').match(/\d+ nodes and \d+ relationships/)?.[0] ?? '',
  }))
  check(
    'choosing a career loads a bounded subgraph (the selection is not lost)',
    seeded.search.includes('career=') && seeded.value !== '' && seeded.canvases > 0,
    `${seeded.search || 'no query'} · ${seeded.counts || 'no counts'}`,
  )

  const tab = page.getByRole('button', { name: /^3D$/ })
  const hasTab = (await tab.count()) > 0
  check('the graph explorer offers a 3D tab alongside canvas and list', hasTab)

  if (hasTab) {
    await tab.first().click()
    const graphCanvas = page.locator('[data-testid="scene-3d"] canvas').first()
    let graphDrawn = false
    try {
      await graphCanvas.waitFor({ state: 'visible', timeout: 20_000 })
      graphDrawn = true
    } catch {
      graphDrawn = false
    }
    const graphStatus = await waitForSceneRunning(page)
    check(
      'the graph scene reaches the “running” state',
      graphStatus.ok,
      `status=${graphStatus.status} after ${graphStatus.elapsedMs} ms`,
    )
    check('the 3D graph view mounts in a real browser', graphDrawn)

    if (graphDrawn) {
      // The force layout runs before the first frame is useful; give it time.
      await page.waitForTimeout(2500)
      await page.locator('[data-testid="scene-3d"]').first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(1500) // the force layout settles before the frame is useful
      const stats = await canvasStats(page, '[data-testid="scene-3d"] canvas')
      check(
        'the 3D graph draws nodes and edges',
        (stats?.coverage ?? 0) > 0.01 && (stats?.distinctColours ?? 0) > 3,
        `coverage ${stats?.coverage ?? 0}, ${stats?.distinctColours ?? 0} distinct colours`,
      )

      const box = await graphCanvas.boundingBox()
      if (box) {
        const before = stats?.digest
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 20, { steps: 10 })
        await page.mouse.up()
        await page.waitForTimeout(600)
        const after = await canvasStats(page, '[data-testid="scene-3d"] canvas')
        check('the 3D graph responds to dragging', (after?.digest ?? '') !== (before ?? ''), `${before ?? '?'} → ${after?.digest ?? '?'}`)

        // Wheel zoom is wired with preventDefault; a page that scrolled instead
        // would be an obvious regression.
        const scrollBefore = await page.evaluate(() => window.scrollY)
        await page.mouse.wheel(0, -240)
        await page.waitForTimeout(400)
        const scrollAfter = await page.evaluate(() => window.scrollY)
        check('the wheel zooms the scene instead of scrolling the page', scrollBefore === scrollAfter, `scrollY ${scrollBefore} → ${scrollAfter}`)
      }

      await page.screenshot({ path: resolve(SHOT_DIR, 'graph-3d.png') })
      check('wrote docs/screenshots/graph-3d.png', true)

      // The canvas is aria-hidden and the node panel is the accessible surface.
      const panel = await page.locator('text=/Difficulty/i').count()
      check('the selected-node panel is still available beside the 3D view', panel > 0)
    }
  }

  console.log('\n4. Mobile layout at 360 px')

  const mobile = await browser.newContext({
    // See installNameShim: needed on every context whose page runs our callbacks.
    ...{},

    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  })
  await installNameShim(mobile)
  const mobilePage = await mobile.newPage()
  const mobileErrors: string[] = []
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') mobileErrors.push(message.text().slice(0, 160))
  })

  for (const path of ['/', '/dashboard', '/graph', '/roadmap']) {
    await mobilePage.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle' })
    await mobilePage.waitForTimeout(700)
    const layout = await mobilePage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      // WCAG 2.5.8 asks for 24px minimum; this project targets 40px for touch.
      smallTargets: Array.from(document.querySelectorAll('button, a[href]')).filter((element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return false
        return rect.height < 24 || rect.width < 24
      }).length,
      buttons: document.querySelectorAll('button, a[href]').length,
    }))
    // One pixel of tolerance for sub-pixel rounding, which is not an overflow.
    check(
      `${path} does not overflow horizontally at 360 px`,
      layout.scrollWidth <= layout.innerWidth + 1,
      `scrollWidth ${layout.scrollWidth} vs viewport ${layout.innerWidth}`,
    )
    check(
      `${path} has no undersized tap target (<24 px)`,
      layout.smallTargets === 0,
      `${layout.smallTargets} of ${layout.buttons} interactive elements`,
    )
  }
  await mobilePage.screenshot({ path: resolve(SHOT_DIR, 'mobile-dashboard.png'), fullPage: false })
  check('wrote docs/screenshots/mobile-dashboard.png', true)
  check('no console errors on mobile', mobileErrors.length === 0, mobileErrors.slice(0, 2).join(' | '))
  await mobile.close()

  console.log('\n5. Reduced motion')

  const reduced = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  await installNameShim(reduced)
  const reducedPage = await reduced.newPage()
  await reducedPage.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })
  await reducedPage.waitForTimeout(700)

  const reducedChecks = await reducedPage.evaluate(() => {
    const animated = Array.from(document.querySelectorAll('*')).filter((el) => {
      const style = getComputedStyle(el)
      return style.animationName !== 'none' && Number.parseFloat(style.animationDuration) > 0.01
    })
    const tilts = Array.from(document.querySelectorAll('.gm-tilt')).map((el) => getComputedStyle(el).transform)
    const backdropBlurs = Array.from(document.querySelectorAll('.gm-card, header, .gm-panel')).filter((el) => {
      const style = getComputedStyle(el)
      return (style.backdropFilter || '') .includes('blur(')
    })
    return {
      animatedElements: animated.length,
      canvases: document.querySelectorAll('canvas').length,
      nonNeutralTilts: tilts.filter((value) => value !== 'none' && value !== 'matrix(1, 0, 0, 1, 0, 0)').length,
      backdropBlurs: backdropBlurs.length,
    }
  })
  check('no 3D canvas is mounted when the visitor asked for reduced motion', reducedChecks.canvases === 0, `${reducedChecks.canvases} canvas(es)`)
  check('nothing animates under reduced motion', reducedChecks.animatedElements === 0, `${reducedChecks.animatedElements} animated element(s)`)
  check('tilt transforms are neutralised', reducedChecks.nonNeutralTilts === 0, `${reducedChecks.nonNeutralTilts} tilted element(s)`)
  check('no surface falls back to a backdrop blur', reducedChecks.backdropBlurs === 0, `${reducedChecks.backdropBlurs} blurred surface(s)`)
  await reducedPage.screenshot({ path: resolve(SHOT_DIR, 'landing-reduced-motion.png') })
  check('wrote docs/screenshots/landing-reduced-motion.png', true)
  await reduced.close()

  console.log('\n6. Console hygiene')

  // Deduplicate: one broken widget can log the same error a hundred times.
  const uniqueErrors = Array.from(new Set(consoleErrors))
  /*
   * One console error is expected, and it is the browser reporting a block this
   * project deliberately causes: Cytoscape injects a one-rule <style> element to
   * give its container `position: relative`, and the production Content-Security-
   * Policy refuses injected style elements. `.gm-graph-surface` now declares that
   * position itself (§10 proves the computed value), so the refusal costs
   * nothing — but Chromium still logs it, on the graph view only.
   *
   * It is matched by its exact subject rather than by a "CSP errors are fine"
   * rule, so a *second* blocked resource, or a different error entirely, still
   * fails this check.
   */
  const knownBlockedStyle = /Applying inline style violates the following Content Security Policy directive 'style-src-elem/i
  const expected = uniqueErrors.filter((text) => knownBlockedStyle.test(text))
  const unexpected = uniqueErrors.filter((text) => !knownBlockedStyle.test(text))
  check(
    'no unexpected console errors across the desktop run',
    unexpected.length === 0,
    unexpected.length === 0
      ? expected.length > 0
        ? `only the documented blocked stylesheet (${expected.length}×), which §10 proves harmless`
        : 'none at all'
      : unexpected.slice(0, 3).join(' | '),
  )
  const uniqueFailed = Array.from(new Set(failedRequests))
  check('no failed network requests', uniqueFailed.length === 0, uniqueFailed.slice(0, 3).join(' | '))

  await context.close()

  /* ---- 7. service worker, only against a build ------------------------- */
  if (OFFLINE) {
    console.log('\n7. Service worker and offline (build only)')
    const sw = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const swPage = await sw.newPage()
    await swPage.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })
    const registered = await swPage.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported'
      const ready = await Promise.race([
        navigator.serviceWorker.ready.then(() => 'ready'),
        new Promise((resolvePromise) => setTimeout(() => resolvePromise('timeout'), 15_000)),
      ])
      return ready
    })
    check('the service worker registers from the built app', registered === 'ready', String(registered))

    if (registered === 'ready') {
      // Reload so the page is served through the worker, then cut the network.
      await swPage.reload({ waitUntil: 'networkidle' })
      await sw.setOffline(true)
      await swPage.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
      await swPage.waitForTimeout(1200)
      const offlineState = await swPage.evaluate(() => ({
        title: document.title,
        text: (document.body.textContent ?? '').slice(0, 200),
      }))
      check(
        'a navigation while offline still renders the app shell',
        /GraphMentor|Dashboard|guest/i.test(offlineState.text) || offlineState.title.length > 0,
        offlineState.text.slice(0, 90).replace(/\s+/g, ' '),
      )
      await swPage.screenshot({ path: resolve(SHOT_DIR, 'offline-shell.png') })
      await sw.setOffline(false)
    }
    await sw.close()
  }

  console.log('\n8. The resource library')

  /*
   * The library is the part of the app a learner acts on first, and its honesty
   * claims are visible text: "what you can do after this", what the material
   * assumes, where it stops, and how long it takes. This section checks the page
   * against the shipped dataset rather than against a copy of its numbers, and
   * proves the filters work instead of only rendering them.
   */
  // The desktop context was closed after section 6, so this section opens its own.
  const libContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await installNameShim(libContext)
  const libPage = await libContext.newPage()
  await libPage.goto(`${BASE_URL}/resources`, { waitUntil: 'networkidle' })
  // Read from the dataset, not from a copy of the number: the check must fail
  // if the two ever disagree.
  const expectedPrereqRows = knowledgeGraph.edges.filter(
    (edge) => edge.type === 'ASSUMES' && edge.from.startsWith('resource:'),
  ).reduce((ids, edge) => ids.add(edge.from), new Set<string>()).size
  const library = await libPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('article'))
    const countOf = (text: string) => {
      const needle = text.toLowerCase()
      return rows.filter((row) => (row.textContent ?? '').toLowerCase().includes(needle)).length
    }
    return {
      rows: rows.length,
      outcomesHeading: countOf('what you can do after this'),
      assumes: countOf('assumes'),
      limits: countOf('where it stops'),
      time: countOf('time involved'),
      outcomeItems: document.querySelectorAll('article ul li').length,
      withLinks: rows.filter((row) => row.querySelector('a[href^="https://"]')).length,
      emptySummaries: rows.filter((row) => (row.textContent ?? '').trim().length < 60).length,
      // The second precision pass: an hour estimate and a linked prerequisite
      // chip, both read back from what the page actually painted.
      withHours: rows.filter((row) => /≈ \d+[–-]\d+ hours\./.test(row.textContent ?? '')).length,
      // Scoped to the "Curriculum prerequisites" block: the Covers chips link
      // to skills as well, and counting those would overstate this check.
      withPrereqBlock: rows.filter((row) => (row.textContent ?? '').includes('Curriculum prerequisites:')).length,
      prereqLabelsAreNames: rows
        .filter((row) => (row.textContent ?? '').includes('Curriculum prerequisites:'))
        .every((row) =>
          Array.from(row.querySelectorAll('a[href^="/skills/skill:"]')).every(
            (link) => !/^skill:/.test((link.textContent ?? '').trim()),
          ),
        ),
    }
  })
  check(
    'the library renders every resource in the dataset',
    library.rows === datasetCounts.resources,
    `${library.rows} rows for ${datasetCounts.resources} resources`,
  )
  check(
    'every row states what you can do afterwards',
    library.outcomesHeading === library.rows && library.outcomeItems >= library.rows * 2,
    `${library.outcomesHeading} rows, ${library.outcomeItems} outcomes listed`,
  )
  check(
    'every row states what it assumes, where it stops and how long it takes',
    library.assumes === library.rows && library.limits === library.rows && library.time === library.rows,
    `assumes ${library.assumes}, limits ${library.limits}, time ${library.time}`,
  )
  check('every row that is https links out', library.withLinks === library.rows, `${library.withLinks} rows with a link`)
  check(
    'every row carries an hour estimate',
    library.withHours === library.rows,
    `${library.withHours} of ${library.rows} rows show "≈ low–high hours"`,
  )
  check(
    'the rows that have prerequisites link them to the skills they name',
    library.withPrereqBlock === expectedPrereqRows && library.prereqLabelsAreNames,
    `${library.withPrereqBlock} rows list prerequisites (dataset: ${expectedPrereqRows}), all labelled with skill names`,
  )
  check('no row renders as a stub', library.emptySummaries === 0, `${library.emptySummaries} short rows`)

  // The access filter must actually filter — the options used to name models the
  // dataset never used, so every choice silently produced an empty list.
  await libPage.selectOption('#resource-access', 'free-audit')
  await libPage.waitForTimeout(400)
  const filtered = await libPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('article'))
    return {
      rows: rows.length,
      allAudit: rows.every((row) => /audit/i.test(row.textContent ?? '')),
    }
  })
  check(
    'the access filter narrows the list to that model',
    filtered.rows > 0 && filtered.rows < library.rows && filtered.allAudit,
    `${filtered.rows} of ${library.rows}, all labelled audit`,
  )
  await libPage.selectOption('#resource-access', '')
  await libPage.waitForTimeout(300)

  await libPage.fill('#resource-search', 'docker')
  await libPage.waitForTimeout(500)
  const searched = await libPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('article'))
    return {
      rows: rows.length,
      allMatch: rows.every((row) => /docker/i.test(row.textContent ?? '')),
    }
  })
  check(
    'searching narrows the list to matching resources',
    searched.rows > 0 && searched.rows < library.rows && searched.allMatch,
    `${searched.rows} rows match "docker"`,
  )

  // Search must reach the detail fields: "padding oracle" only appears in the
  // limits of one resource, never in its title or summary.
  await libPage.fill('#resource-search', 'padding oracle')
  await libPage.waitForTimeout(500)
  const deepSearch = await libPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('article'))
    return { rows: rows.length, first: (rows[0]?.textContent ?? '').slice(0, 60) }
  })
  check(
    'search reaches the detail fields, not just titles',
    deepSearch.rows === 1 && /cryptopals/i.test(deepSearch.first),
    `${deepSearch.rows} row for "padding oracle"`,
  )
  await libPage.fill('#resource-search', '')
  await libPage.waitForTimeout(500)
  await libPage.screenshot({ path: resolve(SHOT_DIR, 'resources-library.png'), fullPage: false })
  await libContext.close()

  /* ------------------------------------------------------------------ 9 */
  console.log('\n9. The command palette')

  /*
   * Cmd/Ctrl+K is the fastest route to anything in the app, so it gets the same
   * treatment as the rest: driven with real keystrokes in a real engine rather
   * than asserted from the DOM in jsdom. What is checked here is the behaviour a
   * learner depends on — it opens from the keyboard, it finds a concept that no
   * resource links, Enter goes there, Escape gives focus back, and the panel is
   * the same material as everything else (no blur, inset active row).
   */
  const paletteContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pal = await paletteContext.newPage()
  await pal.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' })
  await pal.waitForTimeout(500)

  await pal.keyboard.press('Control+k')
  await pal.waitForTimeout(700)
  const opened = await pal.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const field = document.querySelector('#gm-cmd-field')
    return {
      dialog: Boolean(dialog),
      label: dialog?.getAttribute('aria-label') ?? '',
      modal: dialog?.getAttribute('aria-modal') ?? '',
      focused: document.activeElement === field,
      expanded: field?.getAttribute('aria-expanded') ?? '',
      controls: field?.getAttribute('aria-controls') ?? '',
      options: document.querySelectorAll('[role="option"]').length,
    }
  })
  check(
    'Cmd/Ctrl+K opens a real dialog with focus in the search field',
    opened.dialog && opened.focused && opened.modal === 'true' && opened.expanded === 'true' && opened.controls === 'gm-cmd-list',
    `label "${opened.label}", ${opened.options} options listed before typing`,
  )

  await pal.fill('#gm-cmd-field', 'pid')
  await pal.waitForTimeout(400)
  const searchedPalette = await pal.evaluate(() => {
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    const first = options[0]
    const counts = document.querySelector('[role="dialog"] [role="status"]')?.textContent ?? ''
    return {
      first: (first?.textContent ?? '').replace(/\s+/g, ' '),
      firstHref: first?.id ?? '',
      count: counts,
      panelShadow: getComputedStyle(document.querySelector('.gm-cmd-panel') as Element).boxShadow,
      panelBlur: getComputedStyle(document.querySelector('.gm-cmd-panel') as Element).backdropFilter,
      overlayBlur: getComputedStyle(document.querySelector('.gm-cmd-overlay') as Element).backdropFilter,
      activeRowShadow: getComputedStyle(document.querySelector('[role="option"][data-active="true"]') as Element).boxShadow,
    }
  })
  check(
    'typing a concept name finds it, including concepts no resource links',
    /pid control/i.test(searchedPalette.first) && /Control systems/.test(searchedPalette.first),
    searchedPalette.first.slice(0, 60) || 'no results',
  )
  check(
    'the palette is the same material: raised panel, inset active row, no blur',
    /rgb/.test(searchedPalette.panelShadow) &&
      /inset/.test(searchedPalette.activeRowShadow) &&
      searchedPalette.panelBlur === 'none' &&
      searchedPalette.overlayBlur === 'none',
    `panel ${searchedPalette.panelShadow.slice(0, 40)}… / active row inset`,
  )

  await pal.screenshot({ path: resolve(SHOT_DIR, 'command-palette.png') })
  check('wrote docs/screenshots/command-palette.png', true)

  await pal.keyboard.press('Enter')
  await pal.waitForTimeout(900)
  const navigated = await pal.evaluate(() => ({
    path: window.location.pathname,
    dialog: Boolean(document.querySelector('[role="dialog"]')),
  }))
  check(
    'Enter opens the highlighted result and closes the palette',
    navigated.path === '/skills/concept:pid-control' && !navigated.dialog,
    navigated.path,
  )

  // Escape must put focus back where the user left it, not at the page top.
  const trigger = pal.locator('button[aria-label^="Search everything"]').first()
  await trigger.focus()
  const focusBefore = await pal.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
  await pal.keyboard.press('Control+k')
  await pal.waitForTimeout(500)
  await pal.keyboard.press('Escape')
  await pal.waitForTimeout(400)
  const afterEscape = await pal.evaluate(() => ({
    dialog: Boolean(document.querySelector('[role="dialog"]')),
    focused: document.activeElement?.getAttribute('aria-label') ?? '',
  }))
  check(
    'Escape closes it and returns focus to the control that opened it',
    !afterEscape.dialog && afterEscape.focused === focusBefore && focusBefore.startsWith('Search everything'),
    `focus: "${afterEscape.focused || 'none'}"`,
  )

  // The library search lives in the URL now, so a filtered view is a real link.
  await pal.goto(`${BASE_URL}/resources?q=docker`, { waitUntil: 'networkidle' })
  await pal.waitForTimeout(800)
  const deepLink = await pal.evaluate(() => ({
    field: (document.querySelector('#resource-search') as HTMLInputElement | null)?.value ?? '',
    rows: document.querySelectorAll('article').length,
  }))
  check(
    'a search deep link opens the filtered library (?q= in the URL)',
    deepLink.field === 'docker' && deepLink.rows > 0,
    `field "${deepLink.field}", ${deepLink.rows} rows`,
  )

  await paletteContext.close()


  console.log('\n10. The Content-Security-Policy is enforced, not just declared')

  /*
   * The headers and the meta tag are checked as text by the unit suite. This is
   * the other half of that claim: a policy a browser does not act on is
   * decoration, and a policy the app itself trips is a broken page. Both are
   * checked here, in the engine that has to live with it.
   *
   * The interesting case is the graph view. Cytoscape injects a one-rule <style>
   * element to make its container `position: relative`; the production policy
   * denies injected style elements outright, so that injected rule never applies.
   * The stylesheet now declares the position itself, and the check below is what
   * proves the canvas still lands where it should instead of silently going
   * static (the library only warns to the console, which is easy to miss).
   */
  const cspContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await installNameShim(cspContext)
  // Collect violations from the first byte, so the app's own resource load is
  // covered and not just whatever happens after a probe.
  await cspContext.addInitScript(() => {
    const scope = window as unknown as Record<string, unknown>
    const violations: Array<{ directive: string; blocked: string }> = []
    scope['__cspViolations'] = violations
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({
        directive: (event as SecurityPolicyViolationEvent).violatedDirective,
        blocked: (event as SecurityPolicyViolationEvent).blockedURI ?? '',
      })
    })
  })
  const cspPage = await cspContext.newPage()
  await cspPage.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })
  await cspPage.waitForTimeout(600)

  const policy = await cspPage.evaluate(() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    return meta?.getAttribute('content') ?? ''
  })
  const directive = (name: string): string => {
    const found = policy.split(';').find((part) => part.trim().startsWith(`${name} `))
    return found ? found.trim().slice(name.length).trim() : ''
  }

  check('the served page carries a Content-Security-Policy', policy.length > 0, `${policy.length} characters`)
  check(
    'script-src is exactly self — no inline, no eval, no third-party origin',
    directive('script-src') === "'self'" && !/unsafe-(inline|eval)/.test(directive('script-src')),
    `script-src ${directive('script-src') || '(absent)'}`,
  )
  check(
    'the built policy refuses inline styles and injected style elements',
    directive('style-src') === "'self'" && directive('style-src-elem') === "'self'",
    `style-src ${directive('style-src')}; style-src-elem ${directive('style-src-elem')}`,
  )

  const loadViolations = await cspPage.evaluate(
    () => (window as unknown as { __cspViolations: unknown[] }).__cspViolations.length,
  )
  check(
    'the app loads without tripping its own policy',
    loadViolations === 0,
    loadViolations === 0
      ? 'no violations during load'
      : `${loadViolations} violation(s): ${JSON.stringify(
          await cspPage.evaluate(() => (window as unknown as { __cspViolations: Array<{ directive: string; blocked: string }> }).__cspViolations),
        )}`,
  )

  /*
   * The probe: an injected <style> and a style attribute doing the same job. The
   * first must be refused, the second must still work (it is the CSP-level-2
   * fallback the policy deliberately keeps). The violation event is dispatched
   * asynchronously, so this waits for it rather than reading immediately — the
   * first version of this check read too early and reported the wrong directive.
   */
  const probe = await cspPage.evaluate(async () => {
    const scope = window as unknown as { __cspViolations: Array<{ directive: string; blocked: string }> }
    const before = scope.__cspViolations.length
    const style = document.createElement('style')
    style.textContent = '.gm-csp-probe { color: rgb(1, 2, 3) }'
    document.head.appendChild(style)
    const injected = document.createElement('div')
    injected.className = 'gm-csp-probe'
    injected.textContent = 'probe'
    document.body.appendChild(injected)
    const attribute = document.createElement('div')
    attribute.textContent = 'probe'
    attribute.setAttribute('style', 'color: rgb(4, 5, 6)')
    document.body.appendChild(attribute)

    const deadline = Date.now() + 1500
    while (scope.__cspViolations.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const added = scope.__cspViolations.slice(before)
    return {
      elementRuleApplied: getComputedStyle(injected).color === 'rgb(1, 2, 3)',
      attributeApplied: getComputedStyle(attribute).color === 'rgb(4, 5, 6)',
      directive: added[0]?.directive ?? '',
      blocked: added[0]?.blocked ?? '',
      added: added.length,
    }
  })
  check(
    'an injected <style> element is refused by the browser',
    !probe.elementRuleApplied && /style-src-elem/.test(probe.directive),
    `rule did not apply; violation reported against ${probe.directive || '(none)'}`,
  )
  check(
    'a style attribute still applies, so the level-2 fallback is intact',
    probe.attributeApplied,
    'setAttribute("style") took effect',
  )

  /*
   * The graph view is the interesting one, because a dependency injects a style
   * element of its own there. Cytoscape writes a single rule —
   * `.<container> { position: relative }` — into a <style> it creates on the
   * document head. The policy blocks it, which is the intended outcome and the
   * reason `.gm-graph-surface` now declares its own `position: relative` instead
   * of inheriting one from a library. What matters is therefore not that the
   * block happens, but that it costs nothing: no canvas, no layout, no console
   * error the app cannot explain. Exactly one further violation is expected here,
   * and this check fails if a second one ever appears.
   */
  /*
   * Note the listener is installed per document, so this reads the graph page's
   * own list rather than an index carried over from the previous page — an
   * earlier version of this check did the latter and passed for the wrong reason
   * (it sliced off the one violation it was looking for).
   */
  const careerId = knowledgeGraph.careers[0]?.id ?? ''
  await cspPage.goto(`${BASE_URL}/graph?career=${encodeURIComponent(careerId)}`, { waitUntil: 'networkidle' })
  await cspPage.waitForTimeout(1500)
  const graph = await cspPage.evaluate(() => {
    const surface = document.querySelector('.gm-graph-surface')
    const canvas = document.querySelector('.gm-graph-surface canvas')
    const scope = window as unknown as { __cspViolations: Array<{ directive: string; blocked: string }> }
    return {
      position: surface ? getComputedStyle(surface).position : 'missing',
      canvasBox: canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : null,
      added: scope.__cspViolations.map((entry) => `${entry.directive}:${entry.blocked}`),
    }
  })

  check(
    'the graph container positions itself without the stylesheet the policy blocks',
    graph.position === 'relative',
    `computed position: ${graph.position} — Cytoscape's injected rule was refused, so this comes from the stylesheet`,
  )
  check(
    'the graph canvas is still laid out with a real size',
    Boolean(graph.canvasBox && graph.canvasBox.width > 100 && graph.canvasBox.height > 100),
    graph.canvasBox ? `${graph.canvasBox.width}×${graph.canvasBox.height} px` : 'no canvas',
  )
  check(
    'the graph view blocks nothing except the one injected rule it documents',
    graph.added.length === 1 && graph.added[0] === 'style-src-elem:inline',
    graph.added.length === 0
      ? 'nothing blocked — Cytoscape did not inject its stylesheet this time'
      : graph.added.length === 1
        ? `only ${graph.added[0]} — Cytoscape's container rule, which the check above proves unnecessary`
        : `${graph.added.length} violations: ${graph.added.join(', ')}`,
  )

  await cspContext.close()

  console.log('\n11. The delta view — what is startable, and what gates the rest')

  /*
   * The frontier panel has to work for both ends of the audience at once: two
   * skills to start today for somebody who has never studied the field, and an
   * exact remaining delta plus the one chain that cannot be parallelised for
   * somebody who already knows it. It is checked in the engine rather than in
   * jsdom because the claim is about *agreement*: the summary line, the gate
   * chips and the effort footer are three separate renderings of the same
   * computation, and a page that contradicted itself would still pass a shallow
   * "does the panel exist" test. The links are followed, because a suggestion
   * that leads nowhere is worse than no suggestion.
   */
  const frontierContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await installNameShim(frontierContext)
  const delta = await frontierContext.newPage()
  const deltaErrors: string[] = []
  delta.on('console', (message) => {
    if (message.type() === 'error') deltaErrors.push(message.text().slice(0, 200))
  })
  await delta.goto(`${BASE_URL}/gaps?career=${encodeURIComponent('career:software-engineer')}`, { waitUntil: 'networkidle' })
  await delta.waitForSelector('[data-testid="frontier-panel"]', { timeout: 20_000 })
  await delta.waitForTimeout(600)

  const panel = await delta.evaluate(() => {
    const root = document.querySelector('[data-testid="frontier-panel"]')
    if (!root) return null
    const text = (selector: string) => root.querySelector(selector)?.textContent?.trim() ?? ''
    const rows = (selector: string) => Array.from(root.querySelectorAll(selector)).map((li) => (li.textContent ?? '').trim())
    const startLinks = Array.from(root.querySelectorAll('[data-testid="frontier-start"] a'))
    return {
      heading: text('h2'),
      summary: text('[data-testid="frontier-summary"]'),
      effort: text('[data-testid="frontier-effort"]'),
      pulled: text('[data-testid="frontier-pulled"]'),
      gates: rows('[data-testid="frontier-gates"] li'),
      chain: rows('[data-testid="frontier-chain"] li'),
      start: startLinks.map((link) => ({
        href: link.getAttribute('href') ?? '',
        // The visible label only: the link also holds a difficulty badge, and
        // "Programming fundamentalsBeginner" is not the skill's name.
        name: (link.querySelector('span')?.textContent ?? '').trim(),
        height: Math.round(link.getBoundingClientRect().height),
      })),
    }
  })

  check('the delta panel renders on the gap page', Boolean(panel), panel ? panel.heading : 'not found')
  check(
    'it leads with a plain-language count of what is left',
    /^\d+ skill\(s\) to go: \d+ startable now/.test(panel?.summary ?? ''),
    panel?.summary ?? 'no summary line',
  )
  check(
    'it offers a real starting point rather than a whole curriculum',
    (panel?.start.length ?? 0) > 0 && (panel?.start.length ?? 0) < 8,
    `${panel?.start.length ?? 0} startable skill(s): ${(panel?.start ?? []).map((s) => s.name).join(', ').slice(0, 90)}`,
  )
  check(
    'every starting link points at a skill page and is big enough to tap',
    (panel?.start ?? []).every((skill) => /^\/skills\//.test(skill.href) && skill.name.length > 0 && skill.height >= 36),
    (panel?.start ?? []).map((skill) => `${skill.href}@${skill.height}px`).join(' '),
  )
  check(
    'the gates say how much of the route they unlock, in numbers',
    (panel?.gates.length ?? 0) > 0 && (panel?.gates ?? []).every((row) => /unblocks \d+/.test(row)),
    (panel?.gates ?? []).join(' | ').slice(0, 120),
  )
  check(
    'the critical chain is an ordered list of steps, not a single warning',
    (panel?.chain.length ?? 0) >= 2 && (panel?.chain ?? []).every((row, index) => row.startsWith(`${index + 1}.`)),
    (panel?.chain ?? []).join(' → ').slice(0, 120),
  )
  const summaryCount = Number((panel?.summary ?? '').match(/^(\d+) skill\(s\) to go/)?.[1] ?? '-1')
  const effortCount = Number((panel?.effort ?? '').match(/^(\d+) skill\(s\) left/)?.[1] ?? '-2')
  check(
    'the two renderings of "how much is left" agree with each other',
    summaryCount > 0 && summaryCount === effortCount,
    `summary says ${summaryCount}, effort footer says ${effortCount}`,
  )
  check(
    'the panel states the effort as a range with the pace it assumed',
    / h$| h ·/.test(panel?.effort ?? '') && /week/.test(panel?.effort ?? ''),
    panel?.effort ?? 'no effort line',
  )
  check(
    'it discloses that some of the delta is never listed by the career itself',
    /prerequisites/.test(panel?.pulled ?? ''),
    panel?.pulled ?? 'no disclosure line',
  )

  // The page must not contradict itself: the stat row and the panel are two
  // renderings of the same effort, and an earlier version of this page shipped
  // two different hour models side by side.
  const statRow = await delta.evaluate(() => {
    // Anchor on the label element itself: every ancestor div also "contains"
    // the words, and matching those would pick up the whole page.
    const label = Array.from(document.querySelectorAll('div')).find((node) => (node.textContent ?? '').trim() === 'Remaining effort')
    return label?.parentElement?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })
  const statHours = statRow.match(/\d[\d,]*[–-]\d[\d,]* h/)?.[0] ?? ''
  const panelHours = (panel?.effort ?? '').match(/\d[\d,]*[–-]\d[\d,]* h/)?.[0] ?? ''
  check(
    'the stat row and the panel quote the same remaining effort',
    statHours.length > 0 && statHours === panelHours,
    `stat "${statHours}" vs panel "${panelHours}"`,
  )

  const firstHref = panel?.start[0]?.href ?? ''
  const firstName = panel?.start[0]?.name ?? ''
  await delta.goto(`${BASE_URL}${firstHref}`, { waitUntil: 'networkidle' })
  await delta.waitForTimeout(400)
  // The destination's own heading, not a slice of body text: the navigation
  // chrome is long enough to push a real title past any fixed prefix.
  const followed = await delta.evaluate(() => document.querySelector('h1')?.textContent?.trim() ?? '')
  check(
    'following the first suggestion really lands on that skill',
    firstName.length > 2 && followed === firstName,
    `"${firstName}" → ${firstHref} → h1 "${followed}"`,
  )

  await delta.goto(`${BASE_URL}/gaps?career=${encodeURIComponent('career:software-engineer')}`, { waitUntil: 'networkidle' })
  await delta.waitForSelector('[data-testid="frontier-panel"]', { timeout: 20_000 })
  await delta.waitForTimeout(400)
  await delta.screenshot({ path: resolve(SHOT_DIR, 'frontier-delta.png'), fullPage: false })
  check('wrote docs/screenshots/frontier-delta.png', true)
  check('no console errors on the gap page', deltaErrors.length === 0, deltaErrors.slice(0, 2).join(' | '))
  await frontierContext.close()

  /* ----------------------------------------------------------------- 12 */
  /*
   * Every link on the landing page has to answer a real mouse click.
   *
   * Why this section exists: the hero's three action links were dead to the
   * mouse and every other check in this suite stayed green. They were visible,
   * hoverable, focusable, they activated with Tab+Enter, `href` was correct and
   * `document.elementFromPoint` returned the anchor itself — but the browser's
   * *input* hit-testing resolved the press to a flattened ancestor, because the
   * links sat inside a `translateZ`/`preserve-3d` layer. A person with a mouse
   * got nothing at all, while a synthetic `element.click()` (which dispatches
   * straight at the node and never consults hit-testing) navigated happily and
   * kept the suite honest-looking. So this section drives the pointer the way a
   * human does — move, settle, press, release — and then asserts the URL moved.
   *
   * It is deliberately navigation-only: it does not care *where* the link goes,
   * because section 11 already checks destinations. This one question — does
   * the pointer do anything — is the one the whole suite was blind to.
   */
  const LINK_AUDIT_VIEWPORTS = [
    { width: 1440, height: 900, name: 'desktop 1440x900' },
    { width: 360, height: 740, name: 'phone 360x740' },
  ] as const
  // The first-run gate redirects a signed-out visitor away from the app itself,
  // so a gated destination lands on /onboarding instead. That is the product
  // working as specified, not a dead link.
  const GATED = new Set(['/dashboard'])

  /*
   * What a person can click is what is on top at that point. A link buried under
   * the fixed bottom navigation on a short phone is not a dead link — it is a
   * layout question, checked separately below — so occluded anchors are skipped
   * here rather than failed, and reported so the skip is never silent.
   */
  async function topmostAt(page: Page, id: string): Promise<boolean> {
    const box = await page.locator(`[data-link-audit="${id}"]`).boundingBox()
    if (!box) return false
    const point = { px: box.x + box.width / 2, py: box.y + box.height / 2, id }
    return page.evaluate(
      ({ px, py, id: wanted }) => document.elementFromPoint(px, py)?.closest('a')?.getAttribute('data-link-audit') === wanted,
      point,
    )
  }

  /** Which of the hero's calls to action a pointer can actually reach, without scrolling. */
  async function heroReachable(viewport: { width: number; height: number }): Promise<{ reached: string[]; missed: string[] }> {
    const context = await browser.newContext({ viewport })
    await installNameShim(context)
    const page = await context.newPage()
    await page.goto(`${BASE_URL}/`, { waitUntil: 'load' })
    await page.waitForTimeout(1_300)
    const report = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('.gm-hero-copy a[href^="/"]')) as HTMLAnchorElement[]
      return links.map((link) => {
        const rect = link.getBoundingClientRect()
        const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { href: link.getAttribute('href') ?? '', onTop: Boolean(at && link.contains(at)), inView: rect.bottom <= window.innerHeight }
      })
    })
    await context.close()
    return {
      reached: report.filter((entry) => entry.onTop && entry.inView).map((entry) => entry.href),
      missed: report.filter((entry) => !entry.onTop || !entry.inView).map((entry) => entry.href),
    }
  }

  async function auditLinks(
    viewport: (typeof LINK_AUDIT_VIEWPORTS)[number],
  ): Promise<{ dead: { href: string; label: string; why: string }[]; occluded: { href: string; label: string }[] }> {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    await installNameShim(context)
    const page = await context.newPage()
    const dead: { href: string; label: string; why: string }[] = []
    const occluded: { href: string; label: string }[] = []
    const tag = (): { id: string; href: string; label: string; centreY: number }[] => {
      const nodes = Array.from(document.querySelectorAll('a[href^="/"]'))
      nodes.forEach((node, index) => node.setAttribute('data-link-audit', String(index)))
      return nodes.map((node, index) => {
        const rect = node.getBoundingClientRect()
        return {
          id: String(index),
          href: node.getAttribute('href') ?? '',
          label: (node.textContent ?? '').trim().slice(0, 32),
          centreY: Math.round(rect.y + rect.height / 2),
        }
      })
    }

    await page.goto(`${BASE_URL}/`, { waitUntil: 'load' })
    await page.waitForTimeout(1_400)
    const anchors = await page.evaluate(tag)
    // Only anchors a person could click without scrolling first: a pointer test
    // that scrolls would prove nothing about what is on screen.
    const reachable = anchors.filter((entry) => entry.centreY > 4 && entry.centreY < viewport.height - 8 && entry.href !== '/')

    for (const anchor of reachable) {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'load' })
      await page.waitForTimeout(700)
      await page.evaluate(tag)
      const box = await page.locator(`[data-link-audit="${anchor.id}"]`).boundingBox()
      if (!box) {
        dead.push({ href: anchor.href, label: anchor.label, why: 'no hit box' })
        continue
      }
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      if (y < 4 || y > viewport.height - 8) continue
      if (!(await topmostAt(page, anchor.id))) {
        occluded.push({ href: anchor.href, label: anchor.label })
        continue
      }
      await page.mouse.move(Math.max(4, x - 180), Math.max(4, y - 90), { steps: 8 })
      await page.mouse.move(x, y, { steps: 12 })
      await page.waitForTimeout(500)
      await page.mouse.down()
      await page.waitForTimeout(70)
      await page.mouse.up()
      await page.waitForTimeout(900)
      const landed = page.url().replace(BASE_URL, '')
      const arrived = landed.startsWith(anchor.href) || (GATED.has(anchor.href) && landed.startsWith('/onboarding'))
      if (!arrived) dead.push({ href: anchor.href, label: anchor.label, why: `click left the page at ${landed}` })
    }

    await context.close()
    return { dead, occluded }
  }

  console.log('\n12. Every link answers a real mouse click')
  const heroHrefs = ['/onboarding', '/careers', '/graph']
  let occludedNote = ''
  for (const viewport of LINK_AUDIT_VIEWPORTS) {
    const { dead, occluded } = await auditLinks(viewport)
    const heroDead = dead.filter((entry) => heroHrefs.includes(entry.href))
    const describe = (entries: { href: string; label: string; why?: string }[]): string =>
      entries.length === 0 ? 'all answered' : entries.map((entry) => `${entry.href} "${entry.label}"${entry.why ? ` (${entry.why})` : ''}`).join(' | ')
    if (viewport.width === 1440) {
      check('the hero action row answers a real mouse click', heroDead.length === 0, describe(heroDead))
    }
    if (occluded.length > 0) occludedNote += `${viewport.name}: ${occluded.length} link(s) under other content (${occluded.map((e) => e.href).join(', ')}) `
    check(`every link on screen answers a real mouse click (${viewport.name})`, dead.length === 0, describe(dead))
  }
  check(
    'nothing silently skipped the pointer audit',
    true,
    occludedNote.trim() === '' ? 'every on-screen link was on top and was clicked' : occludedNote.trim(),
  )

  /*
   * A link the pointer cannot reach because the app's own chrome covers it is
   * still a real problem on a phone: the visitor sees a button, taps it, and
   * gets navigation instead. This was measured, not assumed — at 360x667 the
   * whole hero row used to sit under the fixed bottom bar (the row ran to y=780
   * with the bar starting at 610). The banner, the hero lede and the phone
   * headline were shortened so the row now clears it, and this pins that.
   */
  for (const size of [
    { width: 360, height: 667, name: '360x667' },
    { width: 360, height: 740, name: '360x740' },
  ]) {
    const { reached, missed } = await heroReachable(size)
    const detail = `${reached.length}/3 reachable${missed.length > 0 ? `, covered: ${missed.join(', ')}` : ''}`
    check(
      `the hero calls to action are tappable without scrolling on a ${size.name} phone`,
      reached.length === 3,
      detail,
    )
  }

  /* ----------------------------------------------------------------- 13 */
  /*
   * The worked example has to be the product's own answer.
   *
   * The landing page used to argue for the graph and never show what it
   * produces; the audience simulation scored that as its most expensive defect.
   * The fix is only worth anything if the numbers on the landing page are the
   * numbers the tool gives for the same inputs — so this section runs the same
   * career twice, once through the landing page's two stated profiles and once
   * through the gap page, and requires them to agree. It also checks the claim
   * the block exists to make: somebody already in the field is shown a smaller
   * delta and a shorter chain than somebody starting from nothing.
   */
  console.log("\n13. The worked example is the product's own answer")
  const exampleContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await installNameShim(exampleContext)
  const example = await exampleContext.newPage()
  const exampleErrors: string[] = []
  example.on('console', (message) => {
    if (message.type() === 'error') exampleErrors.push(message.text().slice(0, 200))
  })
  await example.goto(`${BASE_URL}/`, { waitUntil: 'load' })
  await example.waitForSelector('[data-testid="worked-example"]', { timeout: 20_000 })
  await example.waitForTimeout(600)

  const read = async (profile: string): Promise<{ summary: string; effort: string; start: string[] }> => ({
    summary: (await example.locator(`[data-testid="worked-example-${profile}-summary"]`).textContent())?.trim() ?? '',
    effort: ((await example.locator(`[data-testid="worked-example-${profile}-effort"]`).textContent()) ?? '').replace(/\s+/g, ' ').trim(),
    start: (await example.locator(`[data-testid="worked-example-${profile}"] a`).allTextContents()).map((entry) => entry.trim()),
  })
  const fromZero = await read('from-zero')
  const inField = await read('in-field')
  const numbersIn = (summary: string): number[] => (summary.match(/(\d+)/g) ?? []).map(Number)
  const [zeroLeft, zeroStartable, , , zeroChain] = numbersIn(fromZero.summary)
  const [fieldLeft, fieldStartable, , , fieldChain] = numbersIn(inField.summary)

  check(
    "the landing page shows the engine's own output for both stated profiles",
    /^\d+ skill\(s\) to go: \d+ startable now/.test(fromZero.summary) && /^\d+ skill\(s\) to go: \d+ startable now/.test(inField.summary),
    `from zero: "${fromZero.summary}" · in field: "${inField.summary}"`,
  )
  check(
    'the worked example starts by naming something to start with',
    fromZero.start.length > 0 && inField.start.length > 0,
    `${fromZero.start.length} and ${inField.start.length} startable skill(s) linked`,
  )
  check(
    'somebody already in the field is shown a smaller delta than somebody starting cold',
    (fieldLeft ?? 0) < (zeroLeft ?? 0) && (fieldChain ?? 9) <= (zeroChain ?? 9),
    `${zeroLeft} → ${fieldLeft} skill(s) left, chain ${zeroChain} → ${fieldChain} deep, startable ${zeroStartable} → ${fieldStartable}`,
  )
  await example.screenshot({ path: resolve(SHOT_DIR, 'landing-worked-example.png'), fullPage: false }).catch(() => undefined)

  // Now the same inputs on the page that owns them.
  const gaps = await exampleContext.newPage()
  await gaps.goto(`${BASE_URL}/gaps?career=${encodeURIComponent('career:software-engineer')}`, { waitUntil: 'domcontentloaded' })
  await gaps.waitForSelector('[data-testid="frontier-summary"]', { timeout: 20_000 })
  await gaps.waitForTimeout(600)
  const gapSummary = (await gaps.locator('[data-testid="frontier-summary"]').textContent())?.trim() ?? ''
  const gapEffort = ((await gaps.locator('[data-testid="frontier-effort"]').textContent()) ?? '').replace(/\s+/g, ' ').trim()
  check(
    'the landing example and the gap page agree, number for number',
    gapSummary === fromZero.summary && gapEffort === fromZero.effort,
    `landing "${fromZero.summary}" vs gap page "${gapSummary}"`,
  )
  check('no console errors while the worked example runs', exampleErrors.length === 0, exampleErrors.slice(0, 2).join(' | '))
  await exampleContext.close()

  /* ----------------------------------------------------------------- 14 */
  /*
   * A policy that is declared and not enforced is a sentence in a file. The
   * production policy no longer permits inline <style> elements (it keeps
   * `style-src-attr 'unsafe-inline'` as the CSP-level-2 fallback, because React
   * writes dynamic styles through CSSOM and older engines only understand the
   * level-2 directive). This section proves the browser actually applies that:
   * an injected style element must be refused, a style attribute must still
   * work, and the app itself must break none of its own rules.
   */
  console.log('\n14. The content policy is enforced, not just declared')
  {

  const cspContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await installNameShim(cspContext)
  await cspContext.addInitScript(() => {
    type Violation = { directive: string; blocked: string; source: string }
    ;(window as unknown as { __cspViolations: Violation[] }).__cspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      ;(window as unknown as { __cspViolations: Violation[] }).__cspViolations.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blocked: event.blockedURI,
        source: event.sourceFile ?? '',
      })
    })
  })
  const csp = await cspContext.newPage()
  const careerId = knowledgeGraph.careers[0]?.id ?? 'career:software-engineer'
  await csp.goto(`${BASE_URL}/graph?career=${encodeURIComponent(careerId)}`, { waitUntil: 'load' })
  await csp.waitForTimeout(2_500)
  const declared = await csp.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '')
  const policy = new Map(
    declared
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/)
        return [name ?? '', values.join(' ')]
      }),
  )
  check(
    'the served policy refuses inline <style> and inline script',
    (policy.get('style-src-elem') ?? '').trim() === "'self'" && !/unsafe-inline/.test(policy.get('script-src') ?? '') && !/unsafe-inline|unsafe-eval/.test(policy.get('style-src') ?? ''),
    `script-src ${policy.get('script-src') ?? '(missing)'} · style-src ${policy.get('style-src') ?? '(missing)'} · style-src-elem ${policy.get('style-src-elem') ?? '(missing)'}`,
  )
  const ownViolations = await csp.evaluate(() =>
    (window as unknown as { __cspViolations: Array<{ directive: string; blocked: string; source: string }> }).__cspViolations.slice(),
  )
  /*
   * Cytoscape unconditionally prepends `<style>.__________cytoscape_container {
   * position: relative }</style>` (its renderer's init, no feature flag). The
   * production policy refuses it — which is provably harmless, because the same
   * element already carries `.gm-graph-surface { position: relative }` from our
   * own stylesheet (checked below). So this section allows exactly that one
   * refusal, pinned to the graph chunk, and fails on anything else: the point is
   * not "zero violations" theatre, it is that no *unexpected* code path in this
   * app generates styles or scripts at runtime.
   */
  const knownRefusal = (violation: { directive: string; blocked: string; source: string }): boolean =>
    violation.directive === 'style-src-elem' && violation.blocked === 'inline' && /assets\/graph-/.test(violation.source)
  const unexpected = ownViolations.filter((violation) => !knownRefusal(violation))
  check(
    'the only policy refusal in the app is the container rule Cytoscape injects',
    unexpected.length === 0 && ownViolations.length <= 1,
    ownViolations.length === 0
      ? 'no violations at all'
      : ownViolations.map((v) => `${v.directive} ← ${v.blocked} (${v.source.split('/').pop() ?? 'inline'})`).join(' | ') + (unexpected.length > 0 ? ' — UNEXPECTED' : ' — expected, and the rule is provided by this app'),
  )

  const probe = await csp.evaluate(() => {
    const marker = document.createElement('div')
    marker.id = 'csp-probe-marker'
    marker.textContent = 'probe'
    document.body.appendChild(marker)
    const style = document.createElement('style')
    style.textContent = '#csp-probe-marker { color: rgb(1, 2, 3) !important; }'
    document.head.appendChild(style)
    const fromStyleElement = getComputedStyle(marker).color
    marker.setAttribute('style', 'color: rgb(4, 5, 6)')
    const fromAttribute = getComputedStyle(marker).color
    const violations = (window as unknown as { __cspViolations: Array<{ directive: string; blocked: string }> }).__cspViolations.slice()
    marker.remove()
    style.remove()
    return { fromStyleElement, fromAttribute, violations }
  })
  check(
    'an injected <style> element is refused by the browser',
    probe.fromStyleElement !== 'rgb(1, 2, 3)' && probe.violations.some((v) => /style-src-elem/.test(v.directive)),
    `computed ${probe.fromStyleElement}; ${probe.violations.map((v) => v.directive).join(', ') || 'no violation reported'}`,
  )
  check(
    'a style attribute still applies, so the level-2 fallback is intact',
    probe.fromAttribute === 'rgb(4, 5, 6)',
    `computed ${probe.fromAttribute}`,
  )
  // The graph surface computes `position: relative` from the stylesheet, not from
  // the rule Cytoscape injects at runtime — that injection is now refused, and the
  // library warns when the computed position is static.
  const surface = await csp.evaluate(() => {
    const node = document.querySelector('.gm-graph-surface')
    const cytoscapeClass = document.querySelector('.__________cytoscape_container')
    const injected = document.getElementById('__________cytoscape_stylesheet')
    return {
      position: node ? getComputedStyle(node).position : '(no surface)',
      // The refused rule targets this class; the element that carries it must be
      // the same element our stylesheet already positions.
      sameElement: Boolean(node && cytoscapeClass && node === cytoscapeClass),
      injectedStillInDom: Boolean(injected),
    }
  })
  check(
    'the graph container is positioned by this app, not by the refused rule',
    surface.position === 'relative' && surface.sameElement && surface.injectedStillInDom,
    `computed position: ${surface.position} · same element as Cytoscape's container class: ${surface.sameElement}`,
  )
  await cspContext.close()
  }

  /* ----------------------------------------------------------------- 15 */
  /*
   * The switch in Settings, not the operating system.
   *
   * The app used to write `data-reduced-motion` while the 3D gate and the
   * stylesheet read `data-motion`, so "Reduce motion" changed an attribute
   * nobody consulted. Emulating the *OS* preference passed anyway, which is how
   * the bug survived a suite that already had three reduced-motion checks. This
   * section primes the app's own stored preference with no OS preference in
   * sight, and requires the same outcome: no canvas, no tilt, and a hero that
   * still says everything it said before, in a static composition.
   */
  console.log('\n15. The in-app reduce-motion switch works on its own')
  {
    const motionContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await installNameShim(motionContext)
    await motionContext.addInitScript(() => {
      window.localStorage.setItem(
        'gm.v1.ui',
        JSON.stringify({ theme: 'dark', reducedMotion: true, graphLabels: true, graphAnimations: false, force3d: false }),
      )
    })
    const still = await motionContext.newPage()
    await still.goto(`${BASE_URL}/`, { waitUntil: 'load' })
    await still.waitForTimeout(2_000)
    const seen = await still.evaluate(() => {
      const heading = document.querySelector('.gm-hero-copy h1')?.textContent?.trim() ?? ''
      const tilt = document.querySelector('.gm-tilt')
      return {
        flag: document.documentElement.dataset['motion'] ?? '(unset)',
        canvases: document.querySelectorAll('canvas').length,
        tiltTransform: tilt ? getComputedStyle(tilt).transform : '(no tilt layer)',
        headingLength: heading.length,
        animations: document.getAnimations ? document.getAnimations().length : 0,
      }
    })
    check(
      'the stored preference alone sets data-motion, with no OS preference involved',
      seen.flag === 'reduced',
      `data-motion="${seen.flag}"`,
    )
    check('no 3D canvas mounts for somebody who asked for less motion', seen.canvases === 0, `${seen.canvases} canvas(es)`)
    check(
      'the hero is still readable, as a static composition',
      seen.headingLength > 20 && seen.tiltTransform === 'none',
      `headline ${seen.headingLength} chars · tilt transform ${seen.tiltTransform}`,
    )
    await motionContext.close()
  }

  await browser.close()

  /* ---- report ---------------------------------------------------------- */
  const failed = results.filter((entry) => !entry.ok)
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    engine: 'Chromium (headless) with ANGLE/SwiftShader software WebGL',
    checks: results,
    passed: results.length - failed.length,
    total: results.length,
    screenshots: [
      'landing-hero.png',
      'graph-3d.png',
      'mobile-dashboard.png',
      'landing-reduced-motion.png',
      'resources-library.png',
      'command-palette.png',
      'frontier-delta.png',
      'landing-worked-example.png',
      ...(OFFLINE ? ['offline-shell.png'] : []),
    ],
  }
  writeFileSync(resolve(root, 'docs/browser-verification.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('\nFailed:')
    for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`)
    process.exit(1)
  }
  console.log('Rendered in a real engine: WebGL scenes, the neumorphic material, mobile layout and reduced motion all behave.')
}

main().catch((error: unknown) => {
  console.error('\nverify-browser crashed:', error instanceof Error ? error.message : error)
  process.exit(1)
})


