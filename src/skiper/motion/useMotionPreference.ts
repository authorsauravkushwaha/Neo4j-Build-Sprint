/**
 * "Should this animate at all?"
 *
 * Every Skiper-style component asks this hook and none of them asks anything
 * else. That matters because there are two independent sources for the answer
 * and they must not disagree:
 *
 *   * the operating system (`prefers-reduced-motion`),
 *   * the in-app switch in Settings (`state.store.ts`, which writes it to
 *     `data-motion`).
 *
 * The app already normalises both into one attribute — `<html data-motion>` —
 * and the stylesheet's kill switch, the WebGL gate and the audit suite all read
 * that attribute. This hook reads the same attribute rather than re-deriving the
 * question, so a scroll-linked animation cannot be the one thing on the page
 * that keeps moving after a user asks everything to stop. It watches the
 * attribute, so flipping the switch mid-session takes effect immediately instead
 * of on the next navigation.
 */
import { useEffect, useState } from 'react'

export type MotionTier = 'full' | 'reduced'

/** The attribute `applyTheme()` writes and the stylesheet matches. */
const ATTRIBUTE = 'data-motion'

/** A media-query list, guarded: jsdom and older browsers may not implement it. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/**
 * The current answer, read straight off the document.
 *
 * Defaults to `reduced` when there is no document (a server render, a script, a
 * unit test): an unknown environment is not a licence to move things. The page
 * upgrades to `full` on mount if the attribute says so — which means the very
 * first painted frame is always the still one, never a flash of motion.
 */
export function readMotionTier(): MotionTier {
  if (typeof document === 'undefined') return 'reduced'
  const declared = document.documentElement.dataset['motion']
  if (declared === 'full') return 'full'
  if (declared === 'reduced') return 'reduced'
  // Attribute not set yet (very early in boot): fall back to the OS answer.
  return prefersReducedMotion() ? 'reduced' : 'full'
}

/** Non-reactive read, for event handlers and imperative code. */
export function motionIsReduced(): boolean {
  return readMotionTier() === 'reduced'
}

/**
 * Subscribes to the preference.
 *
 * Note the initial state is the *read* value, not `false` — a component must
 * never render its animated branch for one frame before discovering that motion
 * is reduced, or a reduced-motion user sees exactly the flicker they asked to be
 * spared.
 */
export function useMotionPreference(): { reduced: boolean; tier: MotionTier; duration: (ms: number) => number } {
  const [tier, setTier] = useState<MotionTier>(readMotionTier)

  useEffect(() => {
    const sync = (): void => setTier(readMotionTier())
    // The app switch and the theme bootstrap both write <html data-motion>.
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [ATTRIBUTE] })

    // The OS preference can change while the page is open, and it does not touch
    // the attribute on its own — `main.tsx` re-runs `applyTheme()` for that, but
    // this hook must be correct even if it is the only thing listening.
    let media: MediaQueryList | null = null
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      try {
        media = window.matchMedia('(prefers-reduced-motion: reduce)')
        media.addEventListener?.('change', sync)
      } catch {
        media = null
      }
    }

    sync()
    return () => {
      observer.disconnect()
      media?.removeEventListener?.('change', sync)
    }
  }, [])

  const reduced = tier === 'reduced'
  return {
    reduced,
    tier,
    /**
     * A duration that collapses to 0 when motion is reduced, so a component can
     * compute one number and pass it on without branching at every call site.
     */
    duration: (ms: number) => (reduced ? 0 : ms),
  }
}
