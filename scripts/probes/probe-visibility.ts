/** One-off: are the undersized controls actually visible, and where do they live? */
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

const out = await page.evaluate(() => {
  const describe = (element: Element): string => {
    const parts: string[] = []
    let node: Element | null = element
    for (let depth = 0; depth < 4 && node; depth += 1) {
      parts.push(
        `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.getAttribute('data-testid') ? `[${node.getAttribute('data-testid')}]` : ''}${node.className ? `.${String(node.className).split(/\s+/).slice(0, 3).join('.')}` : ''}`,
      )
      node = node.parentElement
    }
    return parts.join(' < ')
  }
  const rows: string[] = []
  for (const element of Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]'))) {
    const rect = element.getBoundingClientRect()
    if (!(rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0)) continue
    if (!(rect.height < 36 || rect.width < 36)) continue
    const visible = (element as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true
    const style = getComputedStyle(element)
    rows.push(
      `${visible ? 'VISIBLE' : 'hidden '} ${Math.round(rect.width)}x${Math.round(rect.height)} op=${style.opacity} vis=${style.visibility} disp=${style.display} :: ${describe(element)} :: "${(element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24)}"`,
    )
  }
  return rows
})
for (const row of out) console.log(row)
console.log('total', out.length)
await browser.close()


