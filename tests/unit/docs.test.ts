/**
 * Documentation references must resolve.
 *
 * A comment that points at a file which does not exist is worse than no comment:
 * it tells a reader the evidence is somewhere, and wastes their time proving it
 * is not. This repository shipped three such references once (`docs/SECURITY.md`,
 * `docs/RECOMMENDATION-ENGINE.md`, `docs/MENTOR.md`) and this test is the reason
 * it cannot happen again quietly.
 *
 * It checks the shipped source only — code comments, user-facing copy and the
 * Supabase functions — plus a small allow-list of files this test should not
 * police: historical logs, where a stale path is part of the record.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')

/** Every `docs/something.md` reference, with the file it appeared in. */
function collectReferences(dir: string, found: Array<{ file: string; ref: string }> = []): Array<{ file: string; ref: string }> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      collectReferences(full, found)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    const text = readFileSync(full, 'utf8')
    for (const match of text.matchAll(/docs\/[A-Za-z0-9._-]+\.md/g)) {
      found.push({ file: relative(root, full), ref: match[0] })
    }
  }
  return found
}

describe('documentation references', () => {
  it('points only at documents that exist', () => {
    const references = [...collectReferences(join(root, 'src')), ...collectReferences(join(root, 'supabase'))]
    expect(references.length).toBeGreaterThan(0)

    const docsDir = join(root, 'docs')
    const shrink = readdirSync(docsDir)
    const missing = references.filter(({ ref }) => !shrink.includes(ref.replace('docs/', '')))
    expect(missing).toEqual([])
  })

  it('does not reference a document with the wrong capitalisation', () => {
    // Case matters on Linux and in a fresh clone even when it does not on macOS.
    const references = [...collectReferences(join(root, 'src')), ...collectReferences(join(root, 'supabase'))]
    const upperCased = references.filter(({ ref }) => ref !== ref.toLowerCase())
    expect(upperCased).toEqual([])
  })

  it('references the two documents the app tells users the weights and prompt live in', () => {
    const references = collectReferences(join(root, 'src')).map((entry) => entry.ref)
    // The landing page and the gap analyser both promise these exist.
    expect(references).toContain('docs/recommendation-engine.md')
    expect(references).toContain('docs/security.md')
  })
})


