/**
 * Entrance reveals.
 *
 * The single most common animation on the page, so it is the one worth getting
 * exactly right:
 *
 *   * the element is in the DOM from the first render (never "appears later", so
 *     a screen reader's buffer, a text search or a `curl` sees the whole page);
 *   * only transform and opacity move, so the browser can composite it without
 *     laying the page out again;
 *   * reduced motion renders the same markup with no transition at all — not a
 *     faster animation, *no* animation, which is what the preference asks for.
 *
 * `Reveal` uses Motion for the timing curve; where a reveal is purely a fade-up
 * with no choreography, `RevealCss` does the same job with one class and no
 * JavaScript in the scroll path. Prefer `RevealCss` in lists.
 */
import { type ElementType, type ReactNode } from 'react'
import { motion } from 'motion/react'

import { DISTANCE, DURATION, EASE, staggerDelay } from '../motion/tokens.ts'
import { useInViewOnce } from '../motion/useInViewOnce.ts'
import { useMotionPreference } from '../motion/useMotionPreference.ts'

export type RevealDirection = 'up' | 'down' | 'left' | 'right' | 'none'

export interface RevealProps {
  children: ReactNode
  /** Rendered element. Defaults to a plain `div`; use `li`, `article`, `section` where the meaning calls for it. */
  as?: ElementType
  direction?: RevealDirection
  /** Distance in pixels. Defaults to the shared `small` step. */
  distance?: number
  /** Delay in milliseconds, added to any `index`-derived stagger. */
  delay?: number
  /** Position in a group, used to derive a clamped stagger delay. */
  index?: number
  durationMs?: number
  className?: string
  /** Pass through for `id`, `role` and data attributes. */
  [key: `data-${string}`]: unknown
}

const OFFSET: Record<RevealDirection, { x: number; y: number }> = {
  up: { x: 0, y: DISTANCE.small },
  down: { x: 0, y: -DISTANCE.small },
  left: { x: DISTANCE.small, y: 0 },
  right: { x: -DISTANCE.small, y: 0 },
  none: { x: 0, y: 0 },
}

export function Reveal({
  children,
  as = 'div',
  direction = 'up',
  distance,
  delay = 0,
  index,
  durationMs = DURATION.slow,
  className,
  ...rest
}: RevealProps): ReactNode {
  const { reduced } = useMotionPreference()
  const { ref, inView } = useInViewOnce<HTMLDivElement>()
  const offset = OFFSET[direction]
  const scale = distance === undefined ? 1 : distance / DISTANCE.small
  const total = delay + (index === undefined ? 0 : staggerDelay(index))

  const Component = motion[as as 'div'] ?? motion.div

  // Reduced motion, or a reveal that has not been triggered yet and would
  // otherwise be invisible: the element is simply present.
  if (reduced) {
    const Static = as as ElementType
    return (
      <Static className={className} {...rest}>
        {children}
      </Static>
    )
  }

  return (
    <Component
      ref={ref}
      className={className}
      initial={{ opacity: 0, x: offset.x * scale, y: offset.y * scale }}
      animate={inView ? { opacity: 1, x: 0, y: 0 } : { opacity: 0, x: offset.x * scale, y: offset.y * scale }}
      transition={{
        duration: durationMs / 1000,
        delay: total / 1000,
        ease: [...EASE.out] as [number, number, number, number],
      }}
      {...rest}
    >
      {children}
    </Component>
  )
}

/**
 * The CSS-only reveal.
 *
 * `useInViewOnce` toggles one attribute; the stylesheet does the rest. Cheaper
 * than a Motion component for the ninety-percent case, and identical under
 * reduced motion because the stylesheet's kill switch already neutralises it.
 */
export function RevealCss({
  children,
  as = 'div',
  index,
  className = '',
  delay,
  ...rest
}: {
  children: ReactNode
  as?: ElementType
  index?: number
  className?: string
  delay?: number
} & Record<`data-${string}`, unknown>): ReactNode {
  const { ref, inView } = useInViewOnce<HTMLDivElement>()
  const Component = as as ElementType
  const style =
    delay !== undefined || index !== undefined
      ? { '--gm-reveal-delay': `${delay ?? 0 + (index === undefined ? 0 : staggerDelay(index))}ms` }
      : undefined

  return (
    <Component
      ref={ref}
      data-reveal={inView ? 'in' : 'out'}
      className={`gm-reveal ${className}`}
      style={style as React.CSSProperties | undefined}
      {...rest}
    >
      {children}
    </Component>
  )
}
