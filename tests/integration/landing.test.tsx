/**
 * Landing page tests.
 *
 * A landing page is where honesty is easiest to lose: it is the one screen
 * written to persuade. These tests hold it to the claims the rest of the code
 * can actually support, and to the promise that the 3D hero is labelled as what
 * it is.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { LandingPage } from '@/features/landing/LandingPage.tsx'
import { detectWebGL } from '@/components/three/webgl.ts'

function renderLanding(): string {
  render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  )
  return document.body.textContent ?? ''
}

describe('landing page honesty', () => {
  it('labels the hero scene as a fixed composition rather than live data', () => {
    const text = renderLanding()
    expect(text).toMatch(/fixed composition/i)
    expect(text).toMatch(/not live data/i)
    // The label must not be hidden behind a claim that it *is* live.
    expect(text).not.toMatch(/live data from your graph/i)
  })

  it('carries no fabricated social proof', () => {
    const text = renderLanding()
    // No invented counts, ratings, testimonials or outcome promises anywhere.
    expect(text).not.toMatch(/\b\d[\d,.]*\s*(students|learners|users|downloads|reviews|ratings|stars)\b/i)
    expect(text).not.toMatch(/testimonial|rated \d|trusted by|join \d/i)
    expect(text).not.toMatch(/average salary increase/i)
    // "guarantee" may appear only in a denial. Every mention must be a
    // disavowal, which is how the page says it will not promise outcomes.
    const mentions = text.match(/guarantee\w*/gi) ?? []
    const disavowals = text.match(/not guarantee\w*|no guarantee\w*/gi) ?? []
    expect(mentions.length).toBe(disavowals.length)
    expect(disavowals.length).toBeGreaterThan(0)
  })

  it('describes security controls that exist in the codebase', () => {
    const text = renderLanding()
    expect(text).toMatch(/parameterised|parameterized/i)
    expect(text).toMatch(/row ownership|row-level security/i)
    expect(text).toMatch(/rate limit/i)
    expect(text).toMatch(/replay protection/i)
    expect(text).toMatch(/rehash|ReDoS|catastrophic backtracking/i)
    // And it points at the file that maps each control to its test.
    expect(text).toMatch(/docs\/security\.md/i)
  })

  it('promises nothing about the clipboard or uploads, because neither exists', () => {
    const text = renderLanding()
    expect(text).toMatch(/will not read your clipboard/i)
    expect(text).toMatch(/no upload endpoint|will not ask for a file upload/i)
  })

  it('mentions sign-in protections without overclaiming them', () => {
    const text = renderLanding()
    expect(text).toMatch(/hashed/i)
    expect(text).toMatch(/revoked on every device/i)
    expect(text).not.toMatch(/unhackable|bank-level|military-grade|100% secure/i)
  })

  it('renders a usable stage when WebGL is unavailable instead of an empty box', () => {
    // jsdom has no WebGL, so this is the branch a screen-reader, low-power or
    // reduced-motion visitor on a real device would also get.
    expect(detectWebGL().supported).toBe(false)
    const text = renderLanding()
    // The page still reads completely without the canvas.
    expect(text.length).toBeGreaterThan(500)
    expect(text).toMatch(/career/i)
  })
})


