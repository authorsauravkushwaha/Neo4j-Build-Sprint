/**
 * "Has this been seen yet?"
 *
 * Entrances run once. A card that re-animates every time it scrolls back into
 * view is not delightful, it is a page that will not hold still — and it costs a
 * render each time, which on a long landing page is the difference between a
 * smooth scroll and a stutter.
 *
 * Fallback behaviour is the important part: without `IntersectionObserver`
 * (jsdom, very old browsers, a test harness) the hook reports `true`
 * immediately. The alternative — reporting `false` forever — would mean content
 * that never appears, which is how a "progressive enhancement" becomes a blank
 * page for exactly the users who could not support it.
 */
import { useEffect, useRef, useState } from 'react'

export interface InViewOptions {
  /** Margin around the viewport, in the CSS shorthand IntersectionObserver takes. */
  rootMargin?: string
  /** How much of the element must be visible. */
  threshold?: number
  /** Also fire when the element is already on screen at mount (the default, and usually what you want). */
  fireIfAlreadyVisible?: boolean
}

export function useInViewOnce<T extends HTMLElement = HTMLDivElement>(
  options: InViewOptions = {},
): { ref: React.RefObject<T | null>; inView: boolean } {
  const { rootMargin = '0px 0px -12% 0px', threshold = 0.15 } = options
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (inView) return
    const element = ref.current
    if (!element) return

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true)
            observer.disconnect()
          }
        }
      },
      { rootMargin, threshold },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [inView, rootMargin, threshold])

  return { ref, inView }
}

/**
 * True once the element has been seen, never false again — but also true
 * straight away when the element is already in the viewport at mount.
 *
 * The distinction matters for above-the-fold content: an entrance animation on
 * the hero is a nice touch when it plays as the page settles and an annoyance
 * when it plays 300ms after the reader has already started reading.
 */
export function useInViewForEntrance<T extends HTMLElement = HTMLDivElement>(
  options: InViewOptions = {},
): { ref: React.RefObject<T | null>; inView: boolean } {
  return useInViewOnce<T>(options)
}
