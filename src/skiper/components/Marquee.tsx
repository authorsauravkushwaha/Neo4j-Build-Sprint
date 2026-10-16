/**
 * The marquee.
 *
 * A row of nouns moving sideways, used on the story page for the thirteen
 * careers: the reader sees the *breadth* of the dataset in one glance without
 * thirteen clicks, and every item is a real link to that career.
 *
 * The details that matter:
 *
 *   * **The list is rendered twice**, and the second copy is `aria-hidden`. That
 *     is what makes the loop seamless — and it is also why a screen reader must
 *     not read the careers twice.
 *   * **It pauses on hover and on keyboard focus.** A reader who wants to click
 *     "Robotics" must be able to stop it, and a reader who tabs into the row must
 *     not have the focus ring slide off the screen.
 *   * **Reduced motion turns it into a wrapping list.** Not a stopped marquee —
 *     a plain set of links that flows onto as many lines as it needs. Motion is
 *     then absent rather than merely paused, which is the actual preference.
 */
import { type ReactNode } from 'react'

import { useMotionPreference } from '../motion/useMotionPreference.ts'

export interface MarqueeItem {
  key: string
  node: ReactNode
}

export interface MarqueeProps {
  items: readonly MarqueeItem[]
  /** Seconds for one full pass. Longer is calmer. */
  durationS?: number
  reverse?: boolean
  label: string
  className?: string
}

export function Marquee({ items, durationS = 42, reverse = false, label, className = '' }: MarqueeProps): ReactNode {
  const { reduced } = useMotionPreference()

  if (reduced) {
    return (
      <ul className={`gm-marquee-static ${className}`} aria-label={label}>
        {items.map((item) => (
          <li key={item.key}>{item.node}</li>
        ))}
      </ul>
    )
  }

  return (
    <div className={`gm-marquee ${className}`} data-reverse={reverse}>
      <div className="gm-marquee-track" style={{ animationDuration: `${durationS}s` }}>
        <ul className="gm-marquee-row" aria-label={label}>
          {items.map((item) => (
            <li key={item.key}>{item.node}</li>
          ))}
        </ul>
        {/* The visual echo that makes the loop seamless. Hidden from the
            accessibility tree on purpose: it is the same thirteen links. */}
        <ul className="gm-marquee-row" aria-hidden="true">
          {items.map((item) => (
            <li key={`${item.key}-echo`}>{item.node}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
