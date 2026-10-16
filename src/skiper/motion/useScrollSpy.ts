/**
 * Which section am I in?
 *
 * Drives the reading rail: the small list of section names that tracks the story
 * as it scrolls. Built on `IntersectionObserver` rather than scroll maths for a
 * reason that matters at the top of a page — an observer reports the sections
 * that are actually on screen, including two at once during a transition, where
 * a "topmost section by scroll offset" formula has to guess and sometimes
 * flickers between the hero and the section after it.
 *
 * The returned list is also the accessible navigation: the rail renders as a
 * real `<nav>` with real links, so a keyboard or screen-reader visitor can jump
 * between sections instead of scrolling blindly through animation.
 */
import { useEffect, useState } from 'react'

export interface ScrollSpyEntry {
  id: string
  /** Human label for the rail and for the screen-reader announcement. */
  label: string
}

/**
 * Tracks the section currently occupying the upper part of the viewport.
 *
 * `rootMargin` is deliberately asymmetric: a section counts as "current" once
 * its top has passed ~35% of the viewport, which matches where a reader's
 * attention actually sits and avoids the rail flipping the instant a new section
 * peeks in at the bottom.
 */
export function useScrollSpy(entries: readonly ScrollSpyEntry[], options: { offsetRatio?: number } = {}): string {
  const { offsetRatio = 0.35 } = options
  const [activeId, setActiveId] = useState(() => entries[0]?.id ?? '')

  useEffect(() => {
    if (entries.length === 0) return
    if (typeof IntersectionObserver === 'undefined') return

    const visible = new Map<string, number>()
    const topMargin = -Math.round(offsetRatio * 100)

    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const id = record.target.id
          if (!id) continue
          if (record.isIntersecting) visible.set(id, record.intersectionRatio)
          else visible.delete(id)
        }
        if (visible.size === 0) return
        // Whichever tracked section is furthest down the reading order wins,
        // so scrolling backwards hands the rail back to the earlier section.
        const order = entries.map((entry) => entry.id)
        const next = [...visible.keys()].sort((a, b) => order.indexOf(b) - order.indexOf(a))[0]
        if (next) setActiveId(next)
      },
      { rootMargin: `${topMargin}% 0px -${100 - topMargin - 30}% 0px`, threshold: [0, 0.5, 1] },
    )

    for (const entry of entries) {
      const element = document.getElementById(entry.id)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [entries, offsetRatio])

  return activeId
}

/** Smoothly scrolls to a section, honouring the reduced-motion preference. */
export function scrollToSection(id: string, reduced: boolean): void {
  if (typeof document === 'undefined') return
  const element = document.getElementById(id)
  if (!element) return
  element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  // Move focus to the section so keyboard users continue from where the page
  // visually moved to, rather than from the link they just used.
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1')
  element.focus({ preventScroll: true })
}
