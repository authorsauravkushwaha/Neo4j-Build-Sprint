/**
 * The reading rail.
 *
 * Two pieces of chrome, both of them answering "how much of this is left?":
 *
 *   * `ScrollProgressBar` — a hairline across the top of the viewport, driven by
 *     document progress. Decorative (`aria-hidden`), because a screen reader
 *     needs a position, not a percentage of a scrollbar.
 *   * `StoryChapters` — the section list, rendered as a real `<nav>` of real
 *     links with `aria-current` on the active one. This is the piece that makes
 *     the animation *optional*: a reader who does not want to scroll through a
 *     story can jump straight to the chapter they came for, with the keyboard,
 *     in one press. It is the accessibility feature and the navigation at once.
 *
 * Under reduced motion the progress bar is not rendered at all rather than
 * frozen at 0% (a bar that never moves is worse than no bar) and the chapter
 * list stays, because it was never decoration.
 */
import { type ReactNode } from 'react'

import { usePageScrollProgress } from '../motion/useScrollProgress.ts'
import { useMotionPreference } from '../motion/useMotionPreference.ts'
import { scrollToSection, useScrollSpy, type ScrollSpyEntry } from '../motion/useScrollSpy.ts'
// Re-exported so a page can describe its own chapters without reaching into the
// motion layer for the type of a list it already has.
export type { ScrollSpyEntry } from '../motion/useScrollSpy.ts'

export function ScrollProgressBar(): ReactNode {
  const { reduced } = useMotionPreference()
  const progress = usePageScrollProgress()
  if (reduced) return null
  return (
    <div className="gm-scrollbar-track" aria-hidden="true" data-testid="scroll-progress">
      <span className="gm-scrollbar-fill" style={{ transform: `scaleX(${progress.toFixed(4)})` }} />
    </div>
  )
}

/**
 * The story's chapter bar.
 *
 * A horizontal sibling of `StoryChapters`, for pages that have no room for a
 * second vertical column (the story page already sits beside the app's own
 * navigation). It is the same navigation, laid out differently: a real `<nav>`
 * with real anchors, `aria-current` on the active chapter, and the same
 * smooth-scroll upgrade that degrades to the browser's own anchor jump when
 * motion is reduced.
 */
export function StoryNavBar({ chapters, title = 'Chapters' }: StoryChaptersProps): ReactNode {
  const { reduced } = useMotionPreference()
  const activeId = useScrollSpy(chapters)

  return (
    <nav className="gm-storynav" aria-label={title}>
      <p className="gm-storynav-label gm-label">{title}</p>
      <ol className="gm-storynav-list">
        {chapters.map((chapter, index) => {
          const current = chapter.id === activeId
          return (
            <li key={chapter.id}>
              <a
                href={`#${chapter.id}`}
                className="gm-storynav-link"
                data-active={current}
                aria-current={current ? 'true' : undefined}
                onClick={(event) => {
                  if (reduced) return
                  event.preventDefault()
                  scrollToSection(chapter.id, false)
                }}
              >
                <span className="gm-storynav-index">{String(index + 1).padStart(2, '0')}</span>
                <span>{chapter.label}</span>
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export interface StoryChaptersProps {
  chapters: readonly ScrollSpyEntry[]
  /** Rendered above the list. */
  title?: string
}

export function StoryChapters({ chapters, title = 'On this page' }: StoryChaptersProps): ReactNode {
  const { reduced } = useMotionPreference()
  const activeId = useScrollSpy(chapters)

  return (
    <nav className="gm-chapters" aria-label={title}>
      <p className="gm-label">{title}</p>
      <ol className="gm-chapters-list">
        {chapters.map((chapter, index) => {
          const current = chapter.id === activeId
          return (
            <li key={chapter.id}>
              <a
                href={`#${chapter.id}`}
                className="gm-chapters-link"
                data-active={current}
                aria-current={current ? 'true' : undefined}
                onClick={(event) => {
                  // A real href, upgraded to a smooth scroll where motion is
                  // allowed. With JavaScript off, or reduced motion on, the
                  // browser's own anchor behaviour is already correct.
                  if (reduced) return
                  event.preventDefault()
                  scrollToSection(chapter.id, false)
                }}
              >
                <span className="gm-chapters-index">{String(index + 1).padStart(2, '0')}</span>
                <span>{chapter.label}</span>
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
