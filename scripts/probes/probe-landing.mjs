import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)) })
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load' })
await page.waitForTimeout(3000)
const text = await page.evaluate(() => (document.querySelector('main')?.innerText ?? '').replace(/\n{2,}/g, '\n'))
console.log('--- main innerText (first 1800 chars)')
console.log(text.slice(0, 1800))
console.log('--- errors:', errors.slice(0, 5))
console.log('--- worked example present:', await page.locator('[data-testid="worked-example"]').count())
await browser.close()


