/**
 * Pointer-follow 3D tilt for glass cards.
 *
 * Why a hook and not a library: the effect is three lines of maths, it has to
 * respect reduced motion, and it must not fire on touch devices (where a
 * "hover" is really a tap and a tilted card just looks broken).
 *
 * The rotation is written to CSS custom properties, so the compositor does the
 * work and React never re-renders during a pointer move.
 */
import { useCallback, useEffect, useRef } from 'react'

export interface TiltOptions {
  /** Maximum rotation in degrees. Above ~12 the text starts to shear. */
  max?: number
  /** Scale applied while hovered. */
  scale?: number
  /** Lift towards the viewer, in pixels. */
  lift?: number
}

export function useTilt<T extends HTMLElement>({ max = 7, scale = 1.015, lift = 10 }: TiltOptions = {}) {
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
    // -1..1 from the centre of the card.
    const px = (position.x - rect.left) / rect.width - 0.5
    const py = (position.y - rect.top) / rect.height - 0.5
    element.style.setProperty('--gm-tilt-y', `${(px * max * 2).toFixed(2)}deg`)
    element.style.setProperty('--gm-tilt-x', `${(-py * max * 2).toFixed(2)}deg`)
    element.style.setProperty('--gm-tilt-z', `${lift}px`)
    element.style.setProperty('--gm-tilt-scale', String(scale))
  }, [lift, max, scale])

  const onPointerMove = useCallback(
    (event: React.PointerEvent<T>) => {
      if (event.pointerType === 'touch') return
      pointer.current = { x: event.clientX, y: event.clientY }
      // Coalesce to one write per frame: a pointermove can fire 120x/second.
      frame.current ??= requestAnimationFrame(apply)
    },
    [apply],
  )

  const reset = useCallback(() => {
    pointer.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    const element = ref.current
    if (!element) return
    element.style.removeProperty('--gm-tilt-x')
    element.style.removeProperty('--gm-tilt-y')
    element.style.removeProperty('--gm-tilt-z')
    element.style.removeProperty('--gm-tilt-scale')
  }, [])

  useEffect(() => reset, [reset])

  return {
    ref,
    /** Spread onto the element that carries the `.gm-tilt` class. */
    tiltProps: {
      onPointerMove,
      onPointerLeave: reset,
      onPointerCancel: reset,
      onBlur: reset,
    },
  }
}


