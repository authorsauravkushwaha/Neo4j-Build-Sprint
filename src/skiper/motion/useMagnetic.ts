/**
 * Pointer attraction, and the parallax it powers.
 *
 * The effect: a control leans a few pixels towards the cursor, then springs back
 * when the pointer leaves. It is decoration, so it is written to be safe to
 * ignore:
 *
 *   * it writes CSS custom properties, so the compositor does the work and React
 *     never re-renders during a pointer move;
 *   * it ignores touch (a tap has no "towards", and a button that slides away
 *     from a finger is a bug);
 *   * it ignores reduced motion, because a lean is movement whether or not it is
 *     called an animation;
 *   * it never moves the element's hit box enough to matter (capped at 12px), so
 *     the click lands on the control the user aimed at.
 */
import { useCallback, useEffect, useRef } from 'react'

import { useMotionPreference } from './useMotionPreference.ts'

export interface MagneticOptions {
  /** Maximum translation, in pixels. Above ~14 it reads as the button running away. */
  strength?: number
  /** Also tilt slightly towards the pointer, in degrees. 0 disables. */
  tilt?: number
}

export interface Magnetic<T extends HTMLElement = HTMLElement> {
  ref: React.RefObject<T | null>
  /** Spread onto the element. */
  magneticProps: {
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
    onPointerLeave: () => void
    onPointerCancel: () => void
    onBlur: () => void
  }
}

/**
 * The reusable core: whatever element the ref is on gains `--gm-magnet-x`,
 * `--gm-magnet-y` and (optionally) `--gm-magnet-tilt`, which the `.gm-magnet`
 * class in the stylesheet consumes.
 */
export function useMagnetic<T extends HTMLElement = HTMLElement>(options: MagneticOptions = {}): Magnetic<T> {
  const { strength = 10, tilt = 0 } = options
  const { reduced } = useMotionPreference()
  const ref = useRef<T | null>(null)
  const frame = useRef<number | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const apply = useCallback(() => {
    frame.current = null
    const element = ref.current
    const position = pointer.current
    if (!element || !position) return
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const px = (position.x - (rect.left + rect.width / 2)) / (rect.width / 2)
    const py = (position.y - (rect.top + rect.height / 2)) / (rect.height / 2)
    element.style.setProperty('--gm-magnet-x', `${(px * strength).toFixed(2)}px`)
    element.style.setProperty('--gm-magnet-y', `${(py * strength).toFixed(2)}px`)
    if (tilt !== 0) element.style.setProperty('--gm-magnet-tilt', `${(-py * tilt).toFixed(2)}deg`)
  }, [strength, tilt])

  const reset = useCallback(() => {
    pointer.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    const element = ref.current
    if (!element) return
    element.style.removeProperty('--gm-magnet-x')
    element.style.removeProperty('--gm-magnet-y')
    element.style.removeProperty('--gm-magnet-tilt')
  }, [])

  useEffect(() => reset, [reset])

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (reduced || event.pointerType === 'touch') return
      pointer.current = { x: event.clientX, y: event.clientY }
      frame.current ??= requestAnimationFrame(apply)
    },
    [apply, reduced],
  )

  return { ref, magneticProps: { onPointerMove, onPointerLeave: reset, onPointerCancel: reset, onBlur: reset } }
}

/**
 * Scroll parallax for a decorative layer.
 *
 * Reads the element's own position each frame and writes a translate. Never used
 * on text: parallaxed text is a readability cost with no information in it. Put
 * it on the glows and grid lines behind the copy, and hide them from assistive
 * technology with `aria-hidden`.
 */
export function useParallax<T extends HTMLElement = HTMLDivElement>(options: { distance?: number; axis?: 'y' | 'x' } = {}) {
  const { distance = 40, axis = 'y' } = options
  const { reduced } = useMotionPreference()
  const ref = useRef<T | null>(null)

  useEffect(() => {
    // The property name is chosen instead of a second CSS rule: an element that
    // used to be a Y-parallax and becomes an X-parallax keeps a stale `--gm-parallax-y`
    // otherwise, and `.gm-parallax` applies both.
    const property = axis === 'x' ? '--gm-parallax-x' : '--gm-parallax-y'

    if (reduced) {
      ref.current?.style.removeProperty('--gm-parallax-x')
      ref.current?.style.removeProperty('--gm-parallax-y')
      return
    }
    const element = ref.current
    if (!element) return

    let frame: number | null = null
    const read = (): void => {
      frame = null
      const rect = element.getBoundingClientRect()
      const viewportHeight = window.innerHeight || 1
      // -1 when the element sits below the fold, +1 when it has passed above it.
      const position = 1 - (2 * (rect.top + rect.height / 2)) / (viewportHeight + rect.height)
      element.style.setProperty(property, `${(position * distance).toFixed(2)}px`)
    }
    const schedule = (): void => {
      frame ??= requestAnimationFrame(read)
    }
    read()
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule, { passive: true })
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      element.style.removeProperty('--gm-parallax-x')
      element.style.removeProperty('--gm-parallax-y')
    }
  }, [axis, distance, reduced])

  return ref
}
