/**
 * The scroll maths behind every pinned scene.
 *
 * Why this file exists: a pinned scene is the easiest thing in a front end to
 * ship broken and the hardest to notice. On a large monitor with a short element
 * it looks perfect; on a phone, or with an element taller than the viewport, the
 * progress value wanders off 0..1 and the scene either freezes half-drawn or
 * snaps. None of that is visible in a screenshot, so the maths is a pure function
 * and this file is a table of the awkward cases.
 *
 * The hook itself is deliberately not tested here: everything interesting about
 * it is in `scrollProgressFromRect` and `quantise`, and asserting on
 * `requestAnimationFrame` scheduling would test the browser, not the product.
 */
import { describe, expect, it } from 'vitest'

import { clamp01, mapRange, mix, staggerDelay } from '@/skiper/motion/tokens.ts'
import { quantise, scrollProgressFromRect } from '@/skiper/motion/useScrollProgress.ts'
import { easeOutCubic, formatGrouped } from '@/skiper/motion/useCountUp.ts'
import { readMotionTier } from '@/skiper/motion/useMotionPreference.ts'

const VIEWPORT = 800

describe('scrollProgressFromRect', () => {
  it('runs 0 to 1 as a pinned element travels from the fold to the top', () => {
    expect(scrollProgressFromRect({ top: VIEWPORT, bottom: VIEWPORT + 600, height: 600 }, VIEWPORT, 'pin')).toBe(0)
    expect(scrollProgressFromRect({ top: VIEWPORT / 2, bottom: VIEWPORT / 2 + 600, height: 600 }, VIEWPORT, 'pin')).toBeCloseTo(0.5, 5)
    expect(scrollProgressFromRect({ top: 0, bottom: 600, height: 600 }, VIEWPORT, 'pin')).toBe(1)
  })

  it('clamps instead of running past the ends', () => {
    // Still below the fold: 0, not a negative number a scene would multiply by.
    expect(scrollProgressFromRect({ top: VIEWPORT * 3, bottom: VIEWPORT * 3 + 600, height: 600 }, VIEWPORT, 'pin')).toBe(0)
    // Already scrolled far past: 1, not 4.
    expect(scrollProgressFromRect({ top: -VIEWPORT * 3, bottom: -VIEWPORT * 3 + 600, height: 600 }, VIEWPORT, 'pin')).toBe(1)
  })

  it('handles an element taller than the viewport without stalling', () => {
    const height = VIEWPORT * 3
    const start = scrollProgressFromRect({ top: VIEWPORT, bottom: VIEWPORT + height, height }, VIEWPORT, 'pin')
    const middle = scrollProgressFromRect({ top: VIEWPORT * 0.4, bottom: VIEWPORT * 0.4 + height, height }, VIEWPORT, 'pin')
    const end = scrollProgressFromRect({ top: 0, bottom: height, height }, VIEWPORT, 'pin')
    expect([start, end]).toEqual([0, 1])
    expect(middle).toBeGreaterThan(0.5)
    expect(middle).toBeLessThan(0.7)
  })

  it('returns 0 for an element that has not been laid out yet', () => {
    // jsdom, a hidden tab, a display:none ancestor — all produce the same rect.
    expect(scrollProgressFromRect({ top: 0, bottom: 0, height: 0 }, VIEWPORT, 'pin')).toBe(0)
    expect(scrollProgressFromRect({ top: 0, bottom: 0, height: 0 }, 0, 'cover')).toBe(0)
    expect(scrollProgressFromRect({ top: 10, bottom: 20, height: 10 }, Number.NaN, 'through')).toBe(0)
  })

  it("'cover' and 'through' describe the same travel from opposite ends", () => {
    const cover = scrollProgressFromRect({ top: VIEWPORT, bottom: VIEWPORT + 400, height: 400 }, VIEWPORT, 'cover')
    expect(cover).toBe(0)
    const throughStart = scrollProgressFromRect({ top: 0, bottom: 400, height: 400 }, VIEWPORT, 'through')
    expect(throughStart).toBeCloseTo(VIEWPORT / (VIEWPORT + 400), 5)
    const coverEnd = scrollProgressFromRect({ top: -400, bottom: 0, height: 400 }, VIEWPORT, 'cover')
    expect(coverEnd).toBe(1)
  })
})

describe('quantise', () => {
  it('snaps to even steps so a scene has discrete states to render', () => {
    expect(quantise(0.1, 4)).toBe(0)
    expect(quantise(0.4, 4)).toBeCloseTo(1 / 3, 5)
    expect(quantise(0.9, 4)).toBe(1)
  })

  it('is a plain threshold when there are only two states', () => {
    expect(quantise(0.49, 2)).toBe(0)
    expect(quantise(0.5, 2)).toBe(1)
    expect(quantise(0.9, 1)).toBe(1)
  })

  it('never returns a value outside 0..1 even if it is handed nonsense', () => {
    expect(quantise(-5, 4)).toBe(0)
    expect(quantise(12, 4)).toBe(1)
  })
})

describe('tokens', () => {
  it('clamps, mixes and maps without leaving the range', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0)
    expect(mix(10, 20, 0.5)).toBe(15)
    expect(mix(10, 20, 4)).toBe(20)
    expect(mapRange(5, 0, 10, 0, 100)).toBe(50)
    // A degenerate input range must not produce Infinity: an edge with zero
    // length would otherwise draw as a NaN path and take the whole SVG with it.
    expect(mapRange(5, 3, 3, 0, 100)).toBe(0)
  })

  it('clamps a stagger so a long list is not a slideshow', () => {
    expect(staggerDelay(0)).toBe(0)
    expect(staggerDelay(3, 100)).toBe(300)
    // Sixty items at 70ms would be four seconds; the cap keeps it under half.
    expect(staggerDelay(59)).toBe(480)
  })

  it('eases out and lands exactly on the target', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(2)).toBe(1)
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })

  it('groups thousands the same way regardless of the host locale', () => {
    expect(formatGrouped(0)).toBe('0')
    expect(formatGrouped(999)).toBe('999')
    expect(formatGrouped(1000)).toBe('1,000')
    expect(formatGrouped(1234567)).toBe('1,234,567')
  })
})

describe('the motion preference reader', () => {
  it('treats an unset attribute as "ask the OS", and a reduced OS as reduced', () => {
    delete document.documentElement.dataset.motion
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      expect(readMotionTier()).toBe('reduced')
    } finally {
      window.matchMedia = original
      document.documentElement.dataset.motion = 'full'
    }
  })

  it('honours the attribute over the media query, in both directions', () => {
    document.documentElement.dataset.motion = 'reduced'
    expect(readMotionTier()).toBe('reduced')
    document.documentElement.dataset.motion = 'full'
    expect(readMotionTier()).toBe('full')
  })
})
