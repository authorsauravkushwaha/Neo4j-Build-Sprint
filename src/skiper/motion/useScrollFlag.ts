/**
 * "Has the reader scrolled past here?"
 *
 * A boolean, not a progress value, and deliberately **not** gated on the motion
 * preference — which is the one thing that makes this hook different from
 * `usePageScrollProgress`.
 *
 * The distinction is not pedantry. Two very different questions get asked in this
 * app:
 *
 *   * *"How far down the page is the reader?"* — a progress bar, a parallax
 *     layer, a scene's step index. This is decoration. Under reduced motion the
 *     answer is meaningless and the hook that measures it returns a fixed value.
 *   * *"Is the reader past the point where this control becomes useful?"* — the
 *     app bar's condensed state, the back-to-top button. This is *behaviour*, and
 *     a reduced-motion reader needs the back-to-top button exactly as much as
 *     anybody else. A reduced-motion preference is not a request for fewer
 *     features.
 *
 * So this hook reads position and reports state, and the caller decides whether
 * the state change is animated. `usePageScrollProgress` remains the progress
 * measure, and it keeps its motion gate.
 *
 * Same implementation discipline as the progress hook: one rAF per frame,
 * listeners passive, state written only when the flag actually flips (a boolean
 * that changes on every scroll event would re-render the app bar sixty times a
 * second to say the same thing).
 */
import { useEffect, useState } from 'react'

/** Pure threshold test, so the boundary is testable without a DOM. */
export function isPastScrollThreshold(scrollY: number, threshold: number): boolean {
  // A non-finite position is not a position. Reporting "past" would reveal a
  // control on the strength of a number nobody measured.
  if (!Number.isFinite(scrollY)) return false
  if (!Number.isFinite(threshold)) return false
  return scrollY > Math.max(0, threshold)
}

export interface ScrollFlagOptions {
  /** Skip the listener entirely (a page that never scrolls, or a hidden panel). */
  enabled?: boolean
  /**
   * Threshold in pixels, or a function re-evaluated on every read so a value
   * that depends on the viewport (`3 * window.innerHeight`) survives a resize or
   * a device rotation instead of freezing at the height it was first measured
   * against.
   */
  threshold: number | (() => number)
}

export function useScrollFlag({ threshold, enabled = true }: ScrollFlagOptions): boolean {
  const [past, setPast] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setPast(false)
      return
    }

    let frame: number | null = null
    const read = (): void => {
      frame = null
      const scrollY = window.scrollY || document.documentElement.scrollTop || 0
      const limit = typeof threshold === 'function' ? threshold() : threshold
      const next = isPastScrollThreshold(scrollY, limit)
      // Identity check: only a real flip causes a render.
      setPast((previous) => (previous === next ? previous : next))
    }

    const schedule = (): void => {
      frame ??= requestAnimationFrame(read)
    }

    read()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [enabled, threshold])

  return past
}
