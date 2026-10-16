/**
 * A list that arrives in order.
 *
 * The most common request any page in this app makes is "these eight cards, one
 * after another" — and the naive implementation is eight `RevealCss` wrappers
 * with hand-written indices, which is eight chances to get the index wrong and
 * eight `IntersectionObserver`s for one visual idea.
 *
 * This does it with one observer and **no JavaScript per row at all**:
 *
 *   * the container is observed once;
 *   * when it enters, one attribute flips on the container;
 *   * the stylesheet gives each child its delay by position
 *     (`nth-child(1..12)`, capped after that), which is why the component does
 *     not have to clone, wrap or re-key your children.
 *
 * Three consequences worth stating, because each one is the reason for a
 * decision above:
 *
 *   1. **The DOM is exactly what you wrote.** No extra wrapper elements, so a
 *      `<ul>` of `<li>` stays a `<ul>` of `<li>` and the accessibility tree is
 *      unchanged. This is why the delay lives in CSS and not in a `style` prop.
 *   2. **Row 13 onwards shares the capped delay.** `staggerDelay` in the tokens
 *      clamps for the same reason: forty cards at 70ms each is a slideshow, not
 *      an entrance.
 *   3. **Reduced motion renders the plain container.** Not a faster animation —
 *      no class, no observer, no delay, children visible immediately.
 */
import { type ElementType, type ReactNode } from 'react'

import { useInViewOnce } from '../motion/useInViewOnce.ts'
import { useMotionPreference } from '../motion/useMotionPreference.ts'

export interface StaggerProps {
  children: ReactNode
  /** The container element. Defaults to `div`; use `ul`/`ol` when the children are list items. */
  as?: ElementType
  className?: string
  /** Extra class for the container when it is *also* a layout (grid, flex). */
  [key: `data-${string}`]: unknown
}

export function Stagger({ children, as = 'div', className = '', ...rest }: StaggerProps): ReactNode {
  const { reduced } = useMotionPreference()
  const { ref, inView } = useInViewOnce<HTMLDivElement>()
  const Container = as as ElementType

  if (reduced) {
    return (
      <Container className={className} {...rest}>
        {children}
      </Container>
    )
  }

  return (
    <Container
      ref={ref}
      className={`gm-stagger ${className}`}
      // Same attribute protocol as `RevealCss`, and the same reason it is safe:
      // `useInViewOnce` reports `true` immediately when `IntersectionObserver`
      // does not exist, so the only way to be stuck at `out` is for the observer
      // to exist and the element to never come into view — in which case it is
      // off-screen anyway. The `[data-motion='reduced']` kill switch is the
      // second line of defence, and the reduced branch above never sets it.
      data-reveal={inView ? 'in' : 'out'}
      data-testid="stagger"
      {...rest}
    >
      {children}
    </Container>
  )
}
