/** One-off probe: list every interactive element in the landing first screen that is
 *  under the project's own 36 px floor. Deleted after use. */
import { createRequire } from 'node:module'
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

const rows = await page.evaluate(() => {
  const vh = window.innerHeight
  const out: Array<Record<string, unknown>> = []
  for (const element of Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]'))) {
    const rect = element.getBoundingClientRect()
    const onScreen = rect.top < vh && rect.bottom > 0 && rect.width > 0 && rect.height > 0
    if (!onScreen) continue
    if (!(rect.height < 36 || rect.width < 36)) continue
    const region = element.closest('header') ? 'header' : element.closest('footer') ? 'footer' : element.closest('main') ? 'main' : 'other'
    out.push({
      region,
      tag: element.tagName.toLowerCase(),
      h: Math.round(rect.height),
      w: Math.round(rect.width),
      text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 34),
      cls: (element.className || '').toString().split(/\s+/).slice(0, 6).join(' ').slice(0, 90),
      testid: element.getAttribute('data-testid') ?? '',
      href: element.getAttribute('href') ?? '',
    })
  }
  return out
})

console.log(`undersized in first screen: ${rows.length}`)
for (const row of rows) {
  console.log(`${row.region.padEnd(7)} ${String(row.tag).padEnd(7)} ${String(row.w).padStart(4)}x${String(row.h).padEnd(3)} "${row.text}" ${row.testid ? `[${row.testid}] ` : ''}${row.cls}`)
}
await browser.close()


