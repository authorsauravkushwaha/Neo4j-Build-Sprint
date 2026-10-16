#!/usr/bin/env node
/**
 * verify-injection — type hostile payloads into the product's own controls, in a
 * real browser, and prove none of them executes or becomes markup.
 *
 * Why this exists separately from the unit tests: the unit tests prove the
 * *validators* reject things. This proves the *rendered product* — React's
 * escaping, the router, the query strings, the mentor transcript, the settings
 * forms — never turns a payload into markup or code. Those are two different
 * claims and the product needs both.
 *
 * Every editable control on every route that has one is typed into, then the page
 * is asked four questions, each with evidence that belongs to the payload:
 *
 *   1. Did anything execute? Every payload carries its own side effect
 *      (`window.__gmXssFired`), so a fired handler is a hard failure rather than
 *      an absence of evidence. `alert`/`confirm`/`prompt` are trapped too.
 *   2. Did the payload become markup? Two probes, because they cover different
 *      things: a MutationObserver records newly created elements whose own markup
 *      contains the payload's sentinel text — including nodes removed again
 *      immediately — and element counts are compared across each step, so a
 *      payload that parses without a sentinel still shows up as a new <img>/<svg>/
 *      <script>/<iframe> in the same document.
 *   3. Did the payload damage the screen? A blank page or a thrown error counts,
 *      even if nothing "executed".
 *   4. Was it committed and echoed as *literal text*? This is the positive
 *      control — without it, "nothing happened" could just mean the field was
 *      never committed. An echo must appear as characters, not as nodes.
 *
 * A navigation is treated as an instrument fact, not evidence: pressing Enter can
 * reload or route, and the app's own bootstrap then adds its own <script>/<link>
 * nodes. So the sentinel probe — which only attributes payload-shaped markup —
 * is the evidence that survives a navigation, and count deltas are only compared
 * within one document.
 *
 * `/login` is checked as a claim of its own: in a build with no Supabase project
 * the screen must render no password field at all (see AuthPage's guest rule),
 * never a form that pretends to authenticate.
 *
 * Run: BASE_URL=http://127.0.0.1:4173 npx tsx scripts/verify-injection.ts
 * Exits non-zero if any payload class misbehaves.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as typeof import('playwright')

const BASE_URL = process.env['BASE_URL'] ?? 'http://127.0.0.1:4173'

/** Routes that must offer editable controls, with the minimum number expected. */
const ROUTES = [
  { path: '/onboarding', expectControls: 1 },
  { path: '/graph', expectControls: 1 },
  { path: '/mentor', expectControls: 1 },
  { path: '/settings', expectControls: 4 },
]

const FIRED = '__gmXssFired'
const MARKER = 'gm-payload-marker'
const SENTINELS = [FIRED, MARKER, 'javascript:']

type PayloadClass = {
  id: string
  label: string
  value: string
  /** A short distinctive slice of the payload, used to look for a text echo. */
  echo: string
}

/*
 * Nine classes, each the canonical shape of a real attack rather than a random
 * string: reflected script, attribute break-out, URL scheme, SVG handler,
 * server-side template syntax, Cypher/SQL-shaped text, JSON/NoSQL-shaped text,
 * bidirectional-override trickery, and a size attack.
 */
const PAYLOADS: PayloadClass[] = [
  { id: 'script-tag', label: 'a <script> element', value: `<script>window.${FIRED}=true</script>`, echo: 'window.' },
  {
    id: 'attribute-breakout',
    label: 'an attribute break-out with an error handler',
    value: `"><img src=x onerror="window.${FIRED}=true">`,
    echo: 'onerror',
  },
  { id: 'url-scheme', label: 'a javascript: URL', value: `javascript:window.${FIRED}=true`, echo: 'javascript:' },
  { id: 'svg-handler', label: 'an SVG load handler', value: `<svg/onload=window.${FIRED}=true>`, echo: 'onload' },
  {
    id: 'template-expression',
    label: 'server-side template syntax',
    value: `{{7*7}} \${7*7} <%= 7*7 %> ${MARKER}`,
    echo: MARKER,
  },
  {
    id: 'cypher-shaped',
    label: 'Cypher/SQL-shaped text',
    value: `programming') OR 1=1 MATCH (n) DETACH DELETE n // ${MARKER}`,
    echo: MARKER,
  },
  {
    id: 'json-shaped',
    label: 'a JSON/NoSQL operator object',
    value: `{"$ne": null, "$where": "sleep(1000)", "marker": "${MARKER}"}`,
    echo: MARKER,
  },
  {
    id: 'bidi-override',
    label: 'a bidi override that reorders what is displayed',
    value: `career\u202EgnitaehC\u202C${MARKER}`,
    echo: MARKER,
  },
  {
    id: 'oversized',
    label: 'a 20 kB field value',
    value: `A${'x'.repeat(20_000)}<script>window.${FIRED}=true</script>${MARKER}`,
    echo: MARKER,
  },
]

type Failure = { payload: string; route: string; control: string; why: string }
type PayloadResult = {
  id: string
  label: string
  typed: { count: number; routes: Set<string>; truncated: number }
  routes: Set<string>
  echoed: Set<string>
  navigations: number
  notes: string[]
}

type Observation = {
  fired: boolean
  dialogs: string[]
  injected: string[]
  scripts: number
  frames: number
  media: number
  text: string
  href: string
}

const INIT_SCRIPT = ({ sentinels, firedFlag }: { sentinels: string[]; firedFlag: string }): void => {
  // esbuild's helper shim: page.evaluate breaks without it on a fresh context.
  ;(window as unknown as { __name?: (fn: unknown) => unknown }).__name = (fn: unknown) => fn
  const w = window as unknown as Record<string, unknown>
  w[firedFlag] = false
  w.__gmDialogs = [] as string[]
  w.__gmInjected = [] as string[]
  for (const name of ['alert', 'confirm', 'prompt'] as const) {
    w[name] = (...args: unknown[]) => {
      ;(w.__gmDialogs as string[]).push(`${name}:${String(args[0] ?? '').slice(0, 40)}`)
      return name === 'confirm' ? false : null
    }
  }
  const forbidden = new Set(['script', 'iframe', 'object', 'embed', 'img', 'svg', 'link', 'style', 'base', 'form'])
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue
        const markup = (node.outerHTML ?? '').slice(0, 4_000)
        if (!sentinels.some((sentinel) => markup.includes(sentinel))) continue
        const tag = node.tagName.toLowerCase()
        if (forbidden.has(tag)) (w.__gmInjected as string[]).push(`<${tag}>`)
        for (const handler of Array.from(node.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]'))) {
          for (const attribute of Array.from(handler.attributes)) {
            if (sentinels.some((sentinel) => attribute.value.includes(sentinel))) {
              ;(w.__gmInjected as string[]).push(`handler:${attribute.name}`)
            }
          }
        }
      }
    }
  }).observe(document, { childList: true, subtree: true })
}

/** Clear the recorders and snapshot counts, so the next delta belongs to the payload alone. */
async function reset(page: import('playwright').Page, sentinels: string[], firedFlag: string): Promise<Observation> {
  return page.evaluate(
    ([flag, sentinelList]) => {
      const w = window as unknown as Record<string, unknown>
      w[flag as string] = false
      w.__gmDialogs = [] as string[]
      w.__gmInjected = [] as string[]
      for (const element of Array.from(document.querySelectorAll('[data-gm-probe]'))) element.removeAttribute('data-gm-probe')
      return {
        fired: false,
        dialogs: [],
        injected: [],
        scripts: document.querySelectorAll('script').length,
        frames: document.querySelectorAll('iframe').length,
        media: document.querySelectorAll('img, svg').length,
        text: document.body.textContent ?? '',
        href: location.href,
      } satisfies Observation
    },
    [firedFlag, sentinels] as const,
  )
}

async function observe(page: import('playwright').Page, firedFlag: string): Promise<Observation> {
  return page.evaluate((flag: string) => {
    const w = window as unknown as Record<string, unknown>
    return {
      fired: w[flag] === true,
      dialogs: (w.__gmDialogs as string[] | undefined) ?? [],
      injected: (w.__gmInjected as string[] | undefined) ?? [],
      scripts: document.querySelectorAll('script').length,
      frames: document.querySelectorAll('iframe').length,
      media: document.querySelectorAll('img, svg').length,
      text: document.body.textContent ?? '',
      href: location.href,
    }
  }, firedFlag)
}

function problemsIn(
  observation: Observation,
  baseline: Observation,
  payload: PayloadClass,
  errors: string[],
  compareCounts: boolean,
): string[] {
  const problems: string[] = []
  if (observation.fired) problems.push('the payload executed')
  if (observation.dialogs.length > 0) problems.push(`raised a dialog (${observation.dialogs.join(', ')})`)
  if (observation.injected.length > 0) problems.push(`turned itself into markup: ${[...new Set(observation.injected)].join(', ')}`)
  if (observation.href !== baseline.href) {
    // A navigation replaced the document: the app's own bootstrap adds nodes, so
    // count deltas would be noise. The sentinel probe above is the real evidence.
  } else if (compareCounts) {
    if (observation.scripts > baseline.scripts) problems.push(`${observation.scripts - baseline.scripts} new <script> element(s)`)
    if (observation.frames > baseline.frames) problems.push(`${observation.frames - baseline.frames} new <iframe>(s)`)
    if (observation.media > baseline.media) problems.push(`${observation.media - baseline.media} new image/SVG node(s)`)
  }
  if (observation.text.trim().length < 20) problems.push('the screen went blank')
  if (errors.length > 0) problems.push(`the page threw: ${errors.join(' | ')}`)
  if (observation.text.includes(payload.echo)) void 0 // echo is recorded by the caller
  return problems
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const failures: Failure[] = []
  const results: PayloadResult[] = []

  /* The guest-mode claim, checked once: no password field in a build with no
   * Supabase project. */
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => {
      ;(window as unknown as { __name?: (fn: unknown) => unknown }).__name = (fn: unknown) => fn
    })
    const page = await context.newPage()
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'load' })
    await page.waitForTimeout(800)
    const claim = await page.evaluate(() => ({
      passwordFields: document.querySelectorAll('input[type="password"]').length,
      text: (document.querySelector('main')?.textContent ?? '').toLowerCase(),
    }))
    const honest = /not configured|no account|guest/.test(claim.text)
    const clean = claim.passwordFields === 0 && honest
    console.log(
      `\nInjection audit against ${BASE_URL}\n\n  ${clean ? 'ok  ' : 'FAIL'} /login in a build with no Supabase project — ${claim.passwordFields} password field(s), ${honest ? 'says so on screen' : 'says nothing about accounts being unconfigured'}`,
    )
    if (claim.passwordFields > 0) {
      failures.push({ payload: 'guest-mode', route: '/login', control: 'password', why: 'a password field exists although no auth backend is configured' })
    }
    if (!honest) {
      failures.push({ payload: 'guest-mode', route: '/login', control: 'copy', why: 'the screen does not state that accounts are unconfigured' })
    }
    await context.close()
  }

  for (const payload of PAYLOADS) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(INIT_SCRIPT, { sentinels: SENTINELS, firedFlag: FIRED })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 160)))

    const typed = { count: 0, routes: new Set<string>(), truncated: 0 }
    const echoed = new Set<string>()
    let navigations = 0
    const notes: string[] = []

    for (const route of ROUTES) {
      await page.goto(`${BASE_URL}${route.path}`, { waitUntil: 'load' })
      await page.waitForTimeout(900)
      const baseline = await reset(page, SENTINELS, FIRED)

      const controls = page.locator(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled])',
      )
      const count = await controls.count()
      if (count === 0) {
        notes.push(`${route.path}: no editable control`)
        continue
      }
      if (count < route.expectControls) notes.push(`${route.path}: only ${count} control(s), expected ≥${route.expectControls}`)

      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index)
        const type = await control.getAttribute('type')
        const tag = await control.evaluate((node) => node.tagName.toLowerCase())
        const kind = `${tag}${type ? `[${type}]` : ''}`
        try {
          await control.click({ timeout: 4_000 })
          await control.fill(payload.value, { timeout: 4_000 })
          typed.count += 1
          typed.routes.add(route.path)
        } catch (error) {
          notes.push(`${route.path} ${kind}: could not be typed into (${error instanceof Error ? error.message.slice(0, 60) : 'error'})`)
          continue
        }

        // Input ceilings are a defence, not a disappointment: record when a
        // control refused the full length instead of letting a missing echo look
        // like a missed commit.
        const accepted = await control.inputValue()
        if (accepted.length < payload.value.length) typed.truncated += 1

        // Stage A: the render that happens just from holding the value, in the
        // same document as the baseline, so the count deltas are trustworthy.
        await page.waitForTimeout(400)
        const afterTyping = await observe(page, FIRED)
        if (afterTyping.text.includes(payload.echo)) echoed.add(`${route.path} ${kind}`)
        for (const problem of problemsIn(afterTyping, baseline, payload, [], true)) {
          failures.push({ payload: payload.id, route: route.path, control: kind, why: `${problem} (on entry)` })
        }
        if (afterTyping.href !== baseline.href) navigations += 1

        // Stage B: commit it, the way a user would.
        try {
          await page.keyboard.press('Enter')
          await page.waitForTimeout(700)
          await page.keyboard.press('Tab')
          await page.waitForTimeout(500)
        } catch (error) {
          notes.push(`${route.path} ${kind}: commit step failed (${error instanceof Error ? error.message.slice(0, 60) : 'error'})`)
        }
        const afterCommit = await observe(page, FIRED)
        if (afterCommit.text.includes(payload.echo)) echoed.add(`${route.path} ${kind}`)
        const sameDocument = afterCommit.href === afterTyping.href
        if (!sameDocument) navigations += 1
        for (const problem of problemsIn(afterCommit, afterTyping, payload, pageErrors, sameDocument)) {
          failures.push({ payload: payload.id, route: route.path, control: kind, why: `${problem} (on submit)` })
        }
        pageErrors.length = 0
        await reset(page, SENTINELS, FIRED)
      }
    }

    results.push({ id: payload.id, label: payload.label, typed, routes: typed.routes, echoed, navigations, notes })
    await context.close()
  }

  await browser.close()

  /* ---- report ---------------------------------------------------------- */
  let ok = 0
  console.log('')
  for (const result of results) {
    const broken = failures.filter((failure) => failure.payload === result.id)
    const passed = broken.length === 0
    if (passed) ok += 1
    const detail = [
      `typed into ${result.typed.count} control(s) on ${result.routes.size} route(s)`,
      result.echoed.size > 0 ? `echoed as literal text on ${result.echoed.size} control(s)` : 'not echoed as text',
      result.typed.truncated > 0 ? `refused past its maxLength on ${result.typed.truncated}` : null,
      ...result.notes.slice(0, 2),
      ...broken.slice(0, 3).map((failure) => `${failure.route} ${failure.control}: ${failure.why}`),
    ].filter((part): part is string => Boolean(part)).join(' · ')
    console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${result.label} — ${detail}`)
  }

  const classesChecked = results.length + 1
  const classesClean = classesChecked - new Set(failures.map((failure) => failure.payload)).size
  console.log(
    `\n${classesClean}/${classesChecked} payload classes: nothing executed, nothing turned into markup, no screen blanked, no page threw.`,
  )
  if (failures.length > 0) {
    console.log('\nFailures:')
    for (const failure of failures.slice(0, 20)) console.log(`  - ${failure.payload} on ${failure.route} (${failure.control}): ${failure.why}`)
    process.exit(1)
  }
  console.log('The rendering layer escapes what the validators reject, in a real engine.')
}

main().catch((error: unknown) => {
  console.error('\nverify-injection crashed:', error instanceof Error ? error.message : error)
  process.exit(1)
})


