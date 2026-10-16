/**
 * Scroll progress, measured rather than guessed.
 *
 * This is the engine behind every pinned scene on the site: the section stays
 * still while the reader scrolls through it, and its progress drives one visual
 * step at a time. Three things make it behave:
 *
 *   1. **It only reads.** The hook never sets a style or a class itself; it
 *      returns a number, and the scene decides what that number means. That is
 *      what lets the same 0..1 value drive a CSS variable, an SVG `pathLength`,
 *      a canvas rotation or a step index.
 *   2. **It is throttled to one write per frame.** A scroll event can fire more
 *      often than the display refreshes; a scene that recomputes on every event
 *      burns the whole frame budget and stutters on exactly the mid-range phone
 *      the audience study measures against.
 *   3. **It is disabled under reduced motion**, which is not an optimisation but
 *      the accessibility contract: a reduced-motion reader gets a fixed, final
 *      state and no scroll listener at all.
 *
 * The maths lives in `scrollProgressFromRect`, a pure function, so it can be
 * tested without a browser — a pinned scene is otherwise the hardest thing in a
 * front end to test and the easiest to get subtly wrong.
 */
import { useEffect, useRef, useState } from 'react'

import { clamp01 } from './tokens.ts'
import { useMotionPreference } from './useMotionPreference.ts'

export type ScrollProgressMode =
  /** 0 when the element's top edge reaches the viewport bottom, 1 when its bottom edge leaves the top. Whole-element coverage. */
  | 'cover'
  /** 0 when the element's top edge reaches the viewport bottom, 1 when the top edge reaches the viewport top. Use for pinned scenes. */
  | 'pin'
  /** 0 when the element's top edge passes the viewport top, 1 when its bottom reaches the viewport bottom. Use for a scene already in view. */
  | 'through'

export interface ScrollProgressOptions {
  mode?: ScrollProgressMode
  /** Value returned while motion is reduced. Defaults to 1: the finished state. */
  reducedValue?: number
  /** Snap the reported progress to this many even steps (e.g. 4 steps -> 0, .25, .5, .75, 1). */
  steps?: number
  /** Skip the listener entirely. Useful for scenes that are conditionally rendered. */
  enabled?: boolean
}

/**
 * The pure part: progress for a rect and a viewport height.
 *
 * Kept separate from the hook because this is where the interesting bugs live
 * (an element taller than the viewport, an element that starts above the fold,
 * a zero-height element on a screen that has not laid out yet), and a pure
 * function can be pinned with a table of cases instead of a browser.
 */
export function scrollProgressFromRect(
  rect: { top: number; bottom: number; height: number },
  viewportHeight: number,
  mode: ScrollProgressMode = 'pin',
): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0
  if (rect.height <= 0) return 0

  if (mode === 'pin') {
    // The element's top travels from the bottom of the viewport to its top.
    const travel = viewportHeight
    return clamp01((viewportHeight - rect.top) / travel)
  }

  if (mode === 'through') {
    // Progress starts once the element's top is above the fold and finishes when
    // its bottom arrives at the bottom of the screen.
    const entered = viewportHeight - rect.top
    const total = viewportHeight + rect.height
    return clamp01(entered / total)
  }

  // 'cover': the element enters from below and leaves above.
  const total = viewportHeight + rect.height
  const travelled = viewportHeight - rect.top
  return clamp01(travelled / total)
}

/** Even steps: 0, 1/steps, 2/steps … 1. */
export function quantise(progress: number, steps: number): number {
  if (steps <= 1) return progress >= 0.5 ? 1 : 0
  return Math.round(clamp01(progress) * (steps - 1)) / (steps - 1)
}

export interface ScrollProgress {
  /** Attach to the element being measured. */
  ref: React.RefObject<HTMLDivElement | null>
  /** 0..1, quantised if `steps` was given. */
  progress: number
  /** `Math.round(progress * steps)`, for a scene with N steps. */
  step: number
  /** True when motion is reduced and the value is therefore fixed. */
  reduced: boolean
}

/**
 * Measures an element's progress through the viewport.
 *
 * Implementation notes that are not obvious from the signature:
 *
 *   * listeners are attached in the capture phase, so a scene inside a scrolling
 *     container (`overflow: auto`) is measured against that container rather
 *     than only against `window`, which would silently freeze it;
 *   * a `ResizeObserver` re-measures on layout change (font swap, image load,
 *     orientation change) without waiting for a scroll that may never come;
 *   * state is only written when the value actually moved by more than the
 *     threshold, so a 60fps scroll does not cause 60 React renders per second of
 *     identical numbers.
 */
export function useScrollProgress(options: ScrollProgressOptions = {}): ScrollProgress {
  const { mode = 'pin', reducedValue = 1, steps, enabled = true } = options
  const { reduced } = useMotionPreference()
  const ref = useRef<HTMLDivElement | null>(null)
  const [progress, setProgress] = useState(() => (reduced ? reducedValue : 0))
  const lastWritten = useRef<number>(reduced ? reducedValue : -1)

  useEffect(() => {
    if (reduced || !enabled) {
      // One write, then nothing: no listener, no rAF, no layout read per frame.
      if (lastWritten.current !== reducedValue) {
        lastWritten.current = reducedValue
        setProgress(reducedValue)
      }
      return
    }

    const element = ref.current
    if (!element) return

    let frame: number | null = null
    const read = (): void => {
      frame = null
      const rect = element.getBoundingClientRect()
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
      const next = scrollProgressFromRect({ top: rect.top, bottom: rect.bottom, height: rect.height }, viewportHeight, mode)
      const value = steps === undefined ? next : quantise(next, steps)
      // 1/1000 of the range: below this, the difference is invisible and the
      // render is not.
      if (Math.abs(value - lastWritten.current) < 0.001) return
      lastWritten.current = value
      setProgress(value)
    }

    const schedule = (): void => {
      frame ??= requestAnimationFrame(read)
    }

    read()
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule, { passive: true })

    // The element may be inside a scroller; measuring is cheap, so the same
    // scheduler serves both.
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(element)
    }

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
    }
  }, [mode, reduced, reducedValue, steps, enabled])

  const step = steps === undefined ? Math.round(progress) : Math.round(progress * (steps - 1))
  return { ref, progress, step, reduced }
}

/**
 * Progress through the whole document, for the reading rail.
 *
 * Deliberately separate from the element version above: it is the one case where
 * measuring the document is correct, and it is used by exactly one component.
 */
export function usePageScrollProgress(): number {
  const { reduced } = useMotionPreference()
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (reduced) {
      setProgress(0)
      return
    }
    let frame: number | null = null
    const read = (): void => {
      frame = null
      const document_ = document.documentElement
      const scrollable = document_.scrollHeight - window.innerHeight
      const next = scrollable <= 0 ? 0 : clamp01(window.scrollY / scrollable)
      setProgress((previous) => (Math.abs(previous - next) < 0.002 ? previous : next))
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
  }, [reduced])

  return progress
}
