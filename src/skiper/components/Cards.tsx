/**
 * The card stack.
 *
 * Thirteen careers is too many for a wall of cards and too few for a search box,
 * so they are stacked: one card at a time, with prev/next controls, arrow-key
 * support, and a position read-out that says "4 of 13" in words. The stack is
 * the *browsing* affordance; it is never the only way to reach a career, because
 * every card links to its own page and the reduced-motion branch renders the
 * whole set as a plain grid.
 *
 * The deck is not swipe-only (a drag gesture with no button equivalent is
 * unusable with a keyboard, a switch, or a screen reader), and it does not
 * animate on a timer (a carousel that advances while you read is a carousel that
 * takes the page away from you). It moves when the reader says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { DURATION, EASE } from '../motion/tokens.ts'
import { useMotionPreference } from '../motion/useMotionPreference.ts'

export interface StackItem {
  key: string
  /** The card body. A link to the item's own page belongs in here. */
  content: ReactNode
  /** Short label used by the position read-out. */
  label: string
}

export interface CardStackProps {
  items: readonly StackItem[]
  /** Accessible name for the group. */
  label: string
  /** How many cards to show at once on a wide screen. */
  visible?: number
  className?: string
}

export function CardStack({ items, label, visible = 1, className = '' }: CardStackProps): ReactNode {
  const { reduced } = useMotionPreference()
  const [index, setIndex] = useState(0)
  const region = useRef<HTMLDivElement | null>(null)

  const maxIndex = Math.max(0, items.length - visible)
  const clamp = useCallback((next: number) => Math.max(0, Math.min(maxIndex, next)), [maxIndex])

  useEffect(() => {
    setIndex((current) => Math.max(0, Math.min(maxIndex, current)))
  }, [maxIndex])

  const move = useCallback(
    (delta: number) => {
      setIndex((current) => clamp(current + delta))
    },
    [clamp],
  )

  const current = useMemo(() => items[index], [index, items])

  // Reduced motion: the whole set, as a grid. Not a stack that jumps.
  if (reduced) {
    return (
      <div className={`gm-stack-static ${className}`} aria-label={label}>
        {items.map((item) => (
          <div key={item.key}>{item.content}</div>
        ))}
      </div>
    )
  }

  return (
    <div className={`gm-stack ${className}`} role="group" aria-label={label}>
      <div
        ref={region}
        className="gm-stack-viewport"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'PageDown') {
            event.preventDefault()
            move(1)
          }
          if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
            event.preventDefault()
            move(-1)
          }
        }}
      >
        <div className="gm-stack-track" style={{ transform: `translate3d(-${index * (100 / visible)}%, 0, 0)`, transitionDuration: `${DURATION.normal}ms`, transitionTimingFunction: `cubic-bezier(${EASE.out.join(',')})` }}>
          {items.map((item, position) => (
            <div
              key={item.key}
              className="gm-stack-card"
              data-active={position >= index && position < index + visible}
              style={{ flexBasis: `${100 / visible}%` }}
              aria-hidden={position < index || position >= index + visible}
              // React 19 types `inert` as a boolean; `true` removes the card from
              // focus and from the accessibility tree, which is what an off-screen
              // carousel slide needs.
              {...(position < index || position >= index + visible ? { inert: true } : {})}
            >
              {item.content}
            </div>
          ))}
        </div>
      </div>

      <div className="gm-stack-controls">
        <button type="button" className="gm-btn gm-btn-secondary" onClick={() => move(-1)} disabled={index === 0} aria-label="Previous">
          ←
        </button>
        <p className="gm-stack-position" aria-live="polite">
          <span className="gm-sr-only">{label}: </span>
          {index + 1} of {items.length}
          {current ? <span className="gm-stack-current"> · {current.label}</span> : null}
        </p>
        <button
          type="button"
          className="gm-btn gm-btn-secondary"
          onClick={() => move(1)}
          disabled={index >= maxIndex}
          aria-label="Next"
        >
          →
        </button>
      </div>
    </div>
  )
}
