/**
 * The scroll chrome the whole app sits inside.
 *
 * The landing page used to own the only reading rail on the site, which was
 * backwards: the landing page is a story you can read in one sitting, and the
 * *app* is where a learner scrolls through a roadmap of forty tasks, a resource
 * library and a skill index. These two pieces are what make that scroll
 * navigable, and they are mounted once in `app/Layout.tsx` so every screen gets
 * them.
 *
 * `AppScrollRail` — the hairline across the top of the viewport.
 *   Decorative (`aria-hidden`): a percentage of a scrollbar is not information a
 *   screen reader needs. Not rendered at all under reduced motion, because a bar
 *   frozen at 0% is worse than no bar.
 *
 * `BackToTop` — a real button, not a link to `#`.
 *   Appears once the reader is past three viewports, which on this app's long
 *   pages is when "where is the top of this?" becomes a real question. It is
 *   **not** hidden under reduced motion (see `useScrollFlag`): wanting less
 *   motion is not wanting fewer controls. What reduced motion changes is the
 *   scroll itself — `behavior: 'auto'` instead of `'smooth'` — and focus is moved
 *   to the main region either way, so a keyboard user arrives at the top of the
 *   content rather than at the button they pressed.
 *
 * Both read position from `useScrollFlag`, which is the non-motion-gated hook;
 * neither adds a listener when the reader has asked for no motion and the
 * element is therefore decorative.
 */
import { type ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'

import { useMotionPreference } from '../motion/useMotionPreference.ts'
import { usePageScrollProgress } from '../motion/useScrollProgress.ts'
import { useScrollFlag } from '../motion/useScrollFlag.ts'

export function AppScrollRail(): ReactNode {
  const { reduced } = useMotionPreference()
  const progress = usePageScrollProgress()
  if (reduced) return null
  return (
    <div className="gm-scrollbar-track" aria-hidden="true" data-testid="scroll-progress">
      <span className="gm-scrollbar-fill" style={{ transform: `scaleX(${progress.toFixed(4)})` }} />
    </div>
  )
}

/** Three viewports: low enough to help, high enough not to hover over a two-screen page. */
export const BACK_TO_TOP_VIEWPORTS = 3

export function BackToTop(): ReactNode {
  const { reduced } = useMotionPreference()
  const past = useScrollFlag({
    threshold: () => BACK_TO_TOP_VIEWPORTS * (window.innerHeight || 0),
  })

  if (!past) return null

  return (
    <button
      type="button"
      className="gm-backtotop gm-no-print"
      data-testid="back-to-top"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
        const main = document.getElementById('main-content')
        main?.focus({ preventScroll: true })
      }}
    >
      <ArrowUp aria-hidden="true" className="h-4 w-4" />
      <span>Back to top</span>
    </button>
  )
}
