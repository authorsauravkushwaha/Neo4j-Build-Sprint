/**
 * CORS is a security boundary that is easy to spell wrongly and silent when it
 * is wrong: a permissive header produces no error anywhere, it just lets another
 * site read the answer. `corsHeaders` shipped with no tests at all until this
 * file existed, and reading it closely showed one genuine fail-open — a bare `*`
 * in the allow-list was echoed back as the requesting origin together with
 * `access-control-allow-credentials: true`, which is the one combination that
 * makes a public endpoint credentialed for every origin on the web.
 *
 * These tests state the contract in the terms an operator thinks in.
 */
import { describe, expect, it } from 'vitest'

import { corsHeaders } from '@core/http.ts'

const LOCAL = { allowedOrigins: ['http://localhost:5173', 'https://app.example.com'] }

describe('corsHeaders', () => {
  it('returns no headers at all for a request without an Origin', () => {
    expect(corsHeaders(null, LOCAL)).toEqual({})
  })

  it('refuses an origin that is not on the list, by returning nothing', () => {
    // `null` is the contract: the caller answers anyway, without CORS headers,
    // which is what makes a browser refuse to hand the body to the other site.
    expect(corsHeaders('https://evil.example.net', LOCAL)).toBeNull()
  })

  it('echoes an allowed origin, with credentials, and varies on Origin', () => {
    const headers = corsHeaders('https://app.example.com', LOCAL)
    expect(headers).not.toBeNull()
    expect(headers?.['access-control-allow-origin']).toBe('https://app.example.com')
    expect(headers?.['access-control-allow-credentials']).toBe('true')
    expect(headers?.['vary']).toBe('Origin')
  })

  it('normalises the comparison: trailing slash and case do not decide access', () => {
    expect(corsHeaders('https://APP.EXAMPLE.COM/', LOCAL)).not.toBeNull()
    expect(corsHeaders('https://app.example.com', { allowedOrigins: ['https://app.example.com/'] })).not.toBeNull()
  })

  it('allows a subdomain pattern for its subdomains, and refuses the apex', () => {
    const options = { allowedOrigins: ['https://*.example.com'] }
    expect(corsHeaders('https://admin.example.com', options)).not.toBeNull()
    expect(corsHeaders('https://example.com', options)).toBeNull()
  })

  it('is not fooled by a suffix that only looks like the pattern', () => {
    const options = { allowedOrigins: ['https://*.example.com'] }
    for (const hostile of [
      'https://example.com.attacker.test',
      'https://not-example.com',
      'https://evil.app.example.com.attacker.test',
      'http://app.example.com',
    ]) {
      expect(corsHeaders(hostile, options), hostile).toBeNull()
    }
  })

  it('treats a bare "*" as any origin, and never as any credentialed origin', () => {
    const headers = corsHeaders('https://anything.example.net', { allowedOrigins: ['*'] })
    expect(headers).not.toBeNull()
    expect(headers?.['access-control-allow-origin']).toBe('*')
    expect(headers?.['access-control-allow-credentials']).toBeUndefined()
  })

  it('never pairs a wildcard with credentials, for any input', () => {
    const inputs = [null, 'https://a.test', 'http://localhost:5173', 'https://app.example.com']
    for (const allowedOrigins of [['*'], ['*', 'https://app.example.com'], LOCAL.allowedOrigins]) {
      for (const origin of inputs) {
        const headers = corsHeaders(origin, { allowedOrigins })
        if (!headers || headers['access-control-allow-origin'] !== '*') continue
        expect(headers['access-control-allow-credentials'], `${origin} with ${allowedOrigins.join(',')}`).toBeUndefined()
      }
    }
  })

  it('ignores blank entries rather than treating them as a match', () => {
    expect(corsHeaders('https://app.example.com', { allowedOrigins: ['', '   '] })).toBeNull()
  })
})


