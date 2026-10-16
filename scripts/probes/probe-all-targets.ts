/** One-off: how many interactive controls are under the project's 36 px floor on
 *  every route, at 1440×900 and 360×740. Deleted after use. */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const ROUTES = ['/', '/onboarding', '/careers', '/gaps', '/roadmap', '/mentor', '/graph', '/library', '/projects', '/progress', '/settings', '/login', '/about', '/privacy', '/skills/programming-fundamentals', '/careers/software-engineer']

const browser = await chromium.launch()
for (const viewport of [{ width: 1440, height: 900 }, { width: 360, height: 740 }]) {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(() => {
    ;(window as any).__name = (fn: unknown) => fn
  })
  const page = await context.newPage()
  for (const route of ROUTES) {
    await page.goto(`${BASE}/`.replace(/\/$/, '') + route, { waitUntil: 'load' })
    await page.waitForTimeout(1400)
    const result = await page.evaluate(() => {
      const small: string[] = []
      for (const element of Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]'))) {
        const rect = element.getBoundingClientRect()
        if (!(rect.width > 0 && rect.height > 0)) continue
        if ((element as HTMLElement).checkVisibility && !(element as HTMLElement).checkVisibility()) continue
        if (rect.height >= 36 && rect.width >= 36) continue
        small.push(`${Math.round(rect.width)}x${Math.round(rect.height)} "${(element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 26)}"`)
      }
      return small
    })
    console.log(`${viewport.width}px ${route.padEnd(34)} ${result.length === 0 ? 'ok' : `${result.length} small: ${result.slice(0, 6).join(' | ')}`}`)
  }
  await context.close()
}
await browser.close()


