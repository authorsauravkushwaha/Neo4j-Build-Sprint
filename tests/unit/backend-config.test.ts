// @vitest-environment node
/**
 * The backend URL a build embeds is the difference between a live site and a
 * demo site, so the rules that decide it are pinned here: which source wins,
 * what a valid URL looks like, and what a production build must refuse.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveApiBase, type BackendConfigFile } from '../../scripts/resolve-api-base.ts'

const root = resolve(__dirname, '../..')

const file = (apiBaseUrl: string, kind: BackendConfigFile['kind'] = 'none'): BackendConfigFile => ({ apiBaseUrl, kind })

describe('the API base resolver', () => {
  it('prefers the environment variable over the committed file', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: 'https://api.example.com/functions/v1' },
      readConfigFile: () => file('https://other.example.com/functions/v1', 'node'),
    })
    expect(resolution.apiBaseUrl).toBe('https://api.example.com/functions/v1')
    expect(resolution.source).toBe('env')
  })

  it('falls back to the committed file when the environment is empty', () => {
    const resolution = resolveApiBase({
      env: {},
      readConfigFile: () => file('https://api.example.com/functions/v1', 'node'),
    })
    expect(resolution.apiBaseUrl).toBe('https://api.example.com/functions/v1')
    expect(resolution.source).toBe('config-file')
    expect(resolution.problems).toEqual([])
  })

  it('reports a disagreement between the environment and the committed file', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: 'https://a.example.com/functions/v1' },
      readConfigFile: () => file('https://b.example.com/functions/v1', 'node'),
    })
    expect(resolution.problems.join(' ')).toContain('disagree')
  })

  it('treats an empty configuration as a legitimate demo build', () => {
    const resolution = resolveApiBase({ env: {}, readConfigFile: () => file('') })
    expect(resolution.apiBaseUrl).toBe('')
    expect(resolution.kind).toBe('none')
    expect(resolution.problems).toEqual([])
  })

  it('requires the function contract both backends serve', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: 'https://api.example.com' },
      readConfigFile: () => file(''),
      production: true,
    })
    expect(resolution.problems.join(' ')).toContain('/functions/v1')
  })

  it('refuses a plain-http production backend', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: 'http://api.example.com/functions/v1' },
      readConfigFile: () => file(''),
      production: true,
    })
    expect(resolution.problems.join(' ')).toContain('https://')
  })

  it('refuses a production backend on localhost', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: 'http://127.0.0.1:3000/functions/v1' },
      readConfigFile: () => file(''),
      production: true,
    })
    expect(resolution.problems.join(' ')).toContain('localhost')
  })

  it('allows a same-origin relative base outside a production build', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: '/functions/v1' },
      readConfigFile: () => file(''),
    })
    expect(resolution.apiBaseUrl).toBe('/functions/v1')
    expect(resolution.problems).toEqual([])
  })

  it('refuses a same-origin relative base in a production build without an explicit opt-in', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: '/functions/v1' },
      readConfigFile: () => file(''),
      production: true,
    })
    expect(resolution.problems.join(' ')).toContain('GM_ALLOW_SAME_ORIGIN_API_BASE')
  })

  it('allows a same-origin relative base in a production build when the operator says so', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: '/functions/v1', GM_ALLOW_SAME_ORIGIN_API_BASE: 'true' },
      readConfigFile: () => file(''),
      production: true,
    })
    expect(resolution.apiBaseUrl).toBe('/functions/v1')
    expect(resolution.kind).toBe('node')
    expect(resolution.problems).toEqual([])
  })

  it('allows a local integration backend in a production build only with the same opt-in', () => {
    const refused = resolveApiBase({
      env: { VITE_API_BASE_URL: 'http://127.0.0.1:3000/functions/v1' },
      readConfigFile: () => file(''),
      production: true,
    })
    expect(refused.problems.join(' ')).toContain('localhost')
    const allowed = resolveApiBase({
      env: {
        VITE_API_BASE_URL: 'http://127.0.0.1:3000/functions/v1',
        GM_ALLOW_SAME_ORIGIN_API_BASE: 'true',
      },
      readConfigFile: () => file(''),
      production: true,
    })
    expect(allowed.problems).toEqual([])
    expect(allowed.apiBaseUrl).toBe('http://127.0.0.1:3000/functions/v1')
  })

  it('refuses credentials in the URL', () => {
    const resolution = resolveApiBase({
      env: { VITE_API_BASE_URL: 'https://user:secret@api.example.com/functions/v1' },
      readConfigFile: () => file(''),
    })
    expect(resolution.problems.join(' ')).toContain('credentials')
  })

  it('recognises a Supabase deployment and a self-hosted one', () => {
    expect(resolveApiBase({
      env: { VITE_API_BASE_URL: 'https://abcdefghijkl.supabase.co/functions/v1' },
      readConfigFile: () => file(''),
    }).kind).toBe('supabase')
    expect(resolveApiBase({
      env: { VITE_API_BASE_URL: 'https://graphmentor.onrender.com/functions/v1' },
      readConfigFile: () => file(''),
    }).kind).toBe('node')
  })
})

describe('the committed backend configuration', () => {
  const committed = JSON.parse(readFileSync(resolve(root, 'config/production-backend.json'), 'utf8')) as BackendConfigFile

  it('is a valid, credential-free configuration', () => {
    expect(typeof committed.apiBaseUrl).toBe('string')
    expect(committed.apiBaseUrl).not.toMatch(/@/)
    expect(committed.note).toBeTruthy()
  })

  it('passes the same validation as a build would apply', () => {
    const resolution = resolveApiBase({ env: {}, readConfigFile: () => committed, production: true })
    expect(resolution.problems).toEqual([])
  })
})
