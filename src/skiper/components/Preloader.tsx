/**
 * The preloader.
 *
 * A preloader is the most user-hostile component in a modern front end if it is
 * written carelessly: it delays the content the reader asked for in order to show
 * them a percentage of nothing. This one is written to be harmless:
 *
 *   * **It never blocks.** `pointer-events: none` from the first frame, and the
 *     page renders underneath it — the app is already interactive; the overlay is
 *     a curtain over a stage that is set.
 *   * **It is bounded.** The whole sequence is ~900ms and it is cancelled by its
 *     own timer, not by "content loaded", so a slow network cannot turn it into a
 *     white screen. There is no code path where it stays up.
 *   * **It shows once per session.** `sessionStorage` remembers; a reader
 *     navigating back to the landing page does not watch it again.
 *   * **It does not run under reduced motion.** The preference exists to stop
 *     exactly this kind of choreography, and an overlay that fades is movement.
 *   * **It is silent to assistive technology.** `aria-hidden`, no live region: a
 *     screen reader user should hear the page, not a decoration.
 *
 * The words it displays are section names from this page, so even the decoration
 * is telling the reader where they are going.
 */
import { useEffect, useRef, useState } from 'react'

import { motion } from 'motion/react'

import { DURATION, EASE } from '../motion/tokens.ts'
import { useMotionPreference } from '../motion/useMotionPreference.ts'

const STORAGE_KEY = 'gm.story.intro-played'

/** Total time on screen, milliseconds. The ceiling, not a target. */
const LIFETIME = 900

export interface StoryPreloaderProps {
  /** Words shown in sequence. Keep to three or four short ones. */
  words?: readonly string[]
  /** Set false to disable entirely (e.g. inside a test or a screenshot run). */
  enabled?: boolean
}

export function StoryPreloader({
  words = ['Career', 'Prerequisites', 'Order', 'Time'],
  enabled = true,
}: StoryPreloaderProps): React.ReactNode {
  const { reduced } = useMotionPreference()
  const [visible, setVisible] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (!enabled || reduced || started.current) return
    started.current = true

    let played = false
    try {
      played = window.sessionStorage.getItem(STORAGE_KEY) === '1'
      if (!played) window.sessionStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // Private mode, or storage disabled: play it, but never depend on the flag.
      played = false
    }
    if (played) return

    setVisible(true)
    const timer = window.setTimeout(() => setVisible(false), LIFETIME)
    return () => window.clearTimeout(timer)
  }, [enabled, reduced])

  // Nothing renders for the majority of visitors and for every reduced-motion
  // visitor: not an empty overlay, not a hidden overlay, nothing at all.
  if (!visible) return null

  return (
    <motion.div
      aria-hidden="true"
      data-testid="story-preloader"
      className="gm-preloader"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{ pointerEvents: 'none' }}
    >
      <div className="gm-preloader-words">
        {words.map((word, index) => (
          <motion.span
            key={word}
            className="gm-preloader-word"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: [0, 1, 1, 0], y: [8, 0, 0, -8] }}
            transition={{ duration: LIFETIME / 1000, times: [0, 0.18, 0.72, 1], delay: (index * LIFETIME) / 1000 / (words.length * 2), ease: EASE.out }}
          >
            {word}
          </motion.span>
        ))}
      </div>
      <motion.div
        className="gm-preloader-bar"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: LIFETIME / 1000, ease: EASE.inOut }}
      />
      <motion.div
        className="gm-preloader-curtain"
        initial={{ y: '100%' }}
        animate={{ y: '0%' }}
        transition={{ duration: DURATION.scene / 1000, delay: (LIFETIME - DURATION.scene) / 1000, ease: EASE.out }}
      />
    </motion.div>
  )
}
