/**
 * The one frame between two screens.
 *
 * A route change in a single-page app is instant, which reads as a flicker: the
 * old screen's content is replaced by the new screen's content in the same paint,
 * and the eye — which was looking at a heading two lines further down — has to
 * find its place again. A short rise-and-fade on the incoming screen is not
 * decoration; it is the visual equivalent of a paragraph break, and it is why
 * every native platform animates this push.
 *
 * What keeps it from being a nuisance:
 *
 *   * **It is a CSS animation, not a Motion component.** The keyframes run on the
 *     compositor; React is not involved, there is no per-frame state and no
 *     timer. Mounting it costs one class name.
 *   * **It never animates out.** There is no exit animation, because an exit
 *     animation delays the screen the user just asked for. The new screen arrives;
 *     the old one is already gone.
 *   * **`key` is the pathname, not the location.** Keying on the whole location
 *     would remount the screen when only a query parameter changed — `/roadmap?
 *     career=x` → `career=y` is the same screen with a different goal, and
 *     remounting it would throw away scroll position and re-run every query.
 *   * **Reduced motion renders a plain fragment** — no class, no animation, not a
 *     fast one.
 *
 * The animation is short (200ms) and moves 8px. Above roughly 300ms a route
 * transition stops feeling like responsiveness and starts feeling like latency,
 * which is a real cost to pay for a visual nicety.
 */
import { type ReactNode } from 'react'

import { useMotionPreference } from '../motion/useMotionPreference.ts'

export interface PageTransitionProps {
  /** Route identity. Pass `location.pathname` — not the search string. */
  routeKey: string
  children: ReactNode
}

export function PageTransition({ routeKey, children }: PageTransitionProps): ReactNode {
  const { reduced } = useMotionPreference()
  if (reduced) return <>{children}</>
  return (
    <div key={routeKey} className="gm-page-enter" data-testid="page-enter">
      {children}
    </div>
  )
}
