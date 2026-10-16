import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { localSignOut } from '../../src/core/authApi.ts'

afterEach(() => vi.unstubAllGlobals())

describe('honest server sign-out', () => {
  it('does not report success when revocation cannot reach the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await localSignOut()).toMatchObject({ ok: false })
  })
  it('does not report success when the server rejects revocation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, message: 'Try again.' }), { status: 500 })))
    expect(await localSignOut()).toMatchObject({ ok: false })
  })
  it('reports success only after the server acknowledges revocation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, message: 'Signed out.' }), { status: 200 })))
    expect(await localSignOut()).toMatchObject({ ok: true })
  })
})

describe('service worker does not override API cache policy', () => {
  it('has no API runtime cache and purges the old named cache on activation', () => {
    const config = readFileSync('vite.config.ts', 'utf8')
    expect(config).not.toContain("handler: 'NetworkFirst'")
    expect(config).not.toContain("cacheName: 'gm-public-api-v1'")
    expect(config).toContain('importScripts: [`${base}sw-privacy.js`]')
    const migration = readFileSync('public/sw-privacy.js', 'utf8')
    expect(migration).toContain("self.addEventListener('activate'")
    expect(migration).toContain("caches.delete('gm-public-api-v1')")
  })
})
