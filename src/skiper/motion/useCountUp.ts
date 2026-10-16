/**
 * Counting up to a number.
 *
 * Used for the dataset size tiles. Two rules:
 *
 *   * the number is *this product's own data*, never a marketing figure, and
 *   * the animation ends on the exact value, because a counter that lands on
 *     "1,247" when the dataset holds 1,248 is a lie told by a rounding decision.
 *
 * Reduced motion gets the final value on the first frame. It is still a number;
 * it just does not travel.
 */
import { useEffect, useRef, useState } from 'react'

import { EASE } from './tokens.ts'
import { useInViewOnce } from './useInViewOnce.ts'
import { useMotionPreference } from './useMotionPreference.ts'

/** Cubic ease-out, matching `EASE.out` closely enough to be indistinguishable. */
export function easeOutCubic(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return 1 - (1 - clamped) ** 3
}

export interface CountUpOptions {
  durationMs?: number
  /** Decimal places to render. */
  decimals?: number
  /** Start the run only when scrolled into view (the default). */
  onView?: boolean
  /** Start immediately instead of waiting for the viewport. */
  autoStart?: boolean
}

export interface CountUp {
  ref: React.RefObject<HTMLDivElement | null>
  /** The current value: an integer when it is close enough to be one. */
  value: number
  /** The finished value, always exact — useful for tests and for `aria-label`s. */
  target: number
  /** True once the run has finished (or was skipped). */
  done: boolean
}

export function useCountUp(target: number, options: CountUpOptions = {}): CountUp {
  const { durationMs = 900, decimals = 0, autoStart = false } = options
  const { reduced, duration } = useMotionPreference()
  const { ref, inView } = useInViewOnce<HTMLDivElement>()
  const [value, setValue] = useState(() => (reduced ? target : 0))
  const started = useRef(false)
  const frame = useRef<number | null>(null)

  const shouldRun = reduced || autoStart || inView

  useEffect(() => {
    if (!shouldRun || started.current) return
    started.current = true

    const runFor = duration(durationMs)
    if (runFor <= 0) {
      setValue(target)
      return
    }

    const start = performance.now()
    const animate = (now: number): void => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / runFor)
      const eased = easeOutCubic(t)
      const next = target * eased
      setValue(t === 1 ? target : next)
      if (t < 1) frame.current = requestAnimationFrame(animate)
    }
    frame.current = requestAnimationFrame(animate)

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [duration, durationMs, shouldRun, target])

  // A reduced-motion visitor (or a test environment) gets the exact number.
  useEffect(() => {
    if (reduced && value !== target) setValue(target)
  }, [reduced, target, value])

  const rounded = decimals === 0 ? Math.round(value) : Number(value.toFixed(decimals))
  return { ref, value: rounded, target, done: started.current }
}

/** Formats a number with thin thousands separators, without pulling in a locale. */
export function formatGrouped(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Re-exported so a scene can reuse the same curve without importing tokens directly. */
export const COUNT_UP_EASING = EASE.out
