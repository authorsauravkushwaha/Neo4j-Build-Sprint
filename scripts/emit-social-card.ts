#!/usr/bin/env node
/**
 * emit-social-card — render `public/social-card.png` (1200×630).
 *
 * The numbers on the card are read from the dataset, not typed into the template,
 * so the card cannot drift away from the product the way a hand-drawn banner does.
 * It also says nothing the product cannot back up: no ratings, no user counts, no
 * logos of organisations that never endorsed anything.
 *
 * Run: npm run emit:social-card
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { datasetCounts } from '../src/data/seed/knowledgeGraph.ts'

const require = createRequire(import.meta.url)
/** Playwright is a dev dependency; resolved through Node so tsc stays happy. */
const { chromium } = require('playwright') as typeof import('playwright')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'public/social-card.png')

const stats: Array<[string, string]> = [
  [String(datasetCounts.careers), 'engineering careers'],
  [String(datasetCounts.skills), 'skills'],
  [String(datasetCounts.resources), 'free resources'],
  ['0', 'accounts required'],
]

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; background: #0b1220; color: #e8edf7;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         padding: 64px; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 16px; font-weight: 700; font-size: 28px; }
  .mark { width: 56px; height: 56px; border-radius: 16px; background: #1e7d97; display: grid; place-items: center; font-size: 30px; color: #04141a; }
  h1 { font-size: 66px; line-height: 1.06; font-weight: 700; max-width: 1010px; }
  .sub { font-size: 27px; color: #9fb0ca; max-width: 920px; line-height: 1.35; margin-top: 18px; }
  .row { display: flex; gap: 56px; align-items: flex-end; }
  .stat b { display: block; font-size: 40px; font-variant-numeric: tabular-nums; }
  .stat span { font-size: 20px; color: #9fb0ca; }
</style></head>
<body>
  <div class="brand"><span class="mark">◇</span> GraphMentor AI</div>
  <div>
    <h1>What to learn first, and how long the rest will take.</h1>
    <p class="sub">Engineering careers as a prerequisite graph: your skill gap, the skills that gate the rest, and the one chain that cannot be shortened.</p>
  </div>
  <div class="row">
    ${stats.map(([value, label]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('\n    ')}
  </div>
</body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'load' })
mkdirSync(dirname(out), { recursive: true })
await page.screenshot({ path: out })
await browser.close()
console.log(`social card written: ${out} (1200×630) — ${stats.map(([v, l]) => `${v} ${l}`).join(', ')}`)


