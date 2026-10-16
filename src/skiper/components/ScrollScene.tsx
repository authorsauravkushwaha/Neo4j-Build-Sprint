/**
 * The pinned scroll scene — the load-bearing component of the story page.
 *
 * How it works: the scene is `1 + height` viewport-heights tall. The visual
 * panel inside it is `position: sticky`, so it stays on screen while the reader
 * scrolls the scene's own height, and an `IntersectionObserver` decides which
 * step's copy is current. The reader scrolls; the panel shows.
 *
 * Four decisions worth writing down, because each of them is a bug avoided:
 *
 *   1. **All the copy is in the DOM at all times.** Steps are never mounted and
 *      unmounted by scroll. Content that appears only after a scroll is content
 *      that a screen reader, a search engine, a text-mode browser and the project
 *      own honesty tests cannot see.
 *   2. **Reduced motion gets the stacked version.** Not a slower pin — no pin.
 *      The steps become ordinary sections, the visuals sit beside their own copy,
 *      and the page scrolls like a document. Same content, same order, no
 *      scroll-jacking.
 *   3. **Small screens get the stacked version too.** Pinning a phone screen
 *      leaves roughly 300px for copy, and it fights the browser's own URL-bar
 *      collapse. Below `lg` the scene is simply a sequence of sections.
 *   4. **The panel is decoration and says so.** It is `aria-hidden`, because the
 *      accessible statement of the same fact is the copy beside it. Nothing
 *      important is drawn only there.
 *
 * A scene also renders its own step rail: real buttons, keyboard reachable, with
 * `aria-current` marking the active step, and each one scrolls the reader to that
 * step. That is what makes a long scene navigable rather than merely scrollable.
 */
import { type ReactNode } from 'react'

import { DURATION, EASE, SCENE as SCENE_TOKENS } from '../motion/tokens.ts'
import { useScrollProgress } from '../motion/useScrollProgress.ts'
import { useScrollSpy, scrollToSection, type ScrollSpyEntry } from '../motion/useScrollSpy.ts'
import { useMotionPreference } from '../motion/useMotionPreference.ts'

export interface SceneStep {
  /** Stable, URL-safe id. Becomes the fragment a reader can link to. */
  id: string
  /** The small label above the title. */
  kicker: string
  /** The step's heading. */
  title: string
  /** The step's paragraph(s). Real text, kept in the document. */
  body: ReactNode
  /** Drawn in the sticky panel while this step is current. Decorative. */
  visual: ReactNode
}

export interface ScrollSceneProps {
  /** Section id. Must be unique: the reading rail and the anchor links use it. */
  id: string
  /** Heading rendered above the scene. */
  heading: string
  /** Small line under the heading, for a qualifying note. */
  hint?: string
  steps: SceneStep[]
  /** Scroll length in viewport heights. Defaults to the shared `normal` step. */
  length?: number
  /** Rendered under the copy column — usually the next action. */
  footer?: ReactNode
  className?: string
}

export function ScrollScene({
  id,
  heading,
  hint,
  steps,
  length = SCENE_TOKENS.normal,
  footer,
  className = '',
}: ScrollSceneProps): ReactNode {
  const { reduced } = useMotionPreference()
  const stepIds = steps.map((step) => ({ id: `${id}--${step.id}`, label: step.title }))
  const activeStepId = useScrollSpy(stepIds)
  const { ref, progress } = useScrollProgress({ mode: 'cover' })
  const activeIndex = Math.max(
    0,
    stepIds.findIndex((entry) => entry.id === activeStepId),
  )

  const stepEntries: readonly ScrollSpyEntry[] = stepIds

  // ---------------------------------------------------------------- stacked
  // One code path for reduced motion and for small screens. Rendered as plain
  // sections: no sticky, no progress bar, no listeners beyond lazy images.
  const stacked = (
    <div className="gm-scene-stacked" data-testid="scene-stacked">
      {steps.map((step) => (
        <section key={step.id} id={`${id}--${step.id}`} className="gm-scene-step-static" aria-label={step.title}>
          <div className="gm-scene-visual-static" aria-hidden="true">
            {step.visual}
          </div>
          <div>
            <p className="gm-label">{step.kicker}</p>
            <h3 className="mt-1 text-lg font-semibold tracking-tight text-ink">{step.title}</h3>
            <div className="mt-2 text-sm text-muted">{step.body}</div>
          </div>
        </section>
      ))}
    </div>
  )

  return (
    <section id={id} className={`gm-scene ${className}`} aria-labelledby={`${id}-heading`}>
      <header className="gm-scene-head">
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {heading}
        </h2>
        {hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
      </header>

      {/* Below `lg`, or whenever motion is reduced, the scene is a document. */}
      <div className="lg:hidden">{stacked}</div>
      {reduced ? <div className="hidden lg:block">{stacked}</div> : null}

      {!reduced ? (
        <div
          ref={ref}
          data-testid="scene-pinned"
          className="gm-scene-pinned hidden lg:block" style={{ ['--gm-scene-length' as string]: String(length) }}>
          <div className="gm-scene-sticky">
            <div className="gm-scene-visual" aria-hidden="true">
              {steps.map((step, index) => (
                <div
                  key={step.id}
                  className="gm-scene-visual-layer"
                  data-active={index === activeIndex}
                  style={{ transitionDuration: `${DURATION.slow}ms`, transitionTimingFunction: `cubic-bezier(${EASE.out.join(',')})` }}
                >
                  {step.visual}
                </div>
              ))}
            </div>

            <div className="gm-scene-panel">
              <div className="gm-scene-progress" aria-hidden="true">
                <span className="gm-scene-progress-fill" style={{ transform: `scaleX(${Math.max(0.02, progress).toFixed(3)})` }} />
              </div>
              <ol className="gm-scene-rail">
                {stepEntries.map((entry, index) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="gm-scene-rail-item"
                      data-active={index === activeIndex}
                      aria-current={index === activeIndex ? 'step' : undefined}
                      onClick={() => scrollToSection(entry.id, false)}
                    >
                      <span className="gm-scene-rail-index">{String(index + 1).padStart(2, '0')}</span>
                      <span className="gm-scene-rail-label">{entry.label}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="gm-scene-copy">
            {steps.map((step, index) => (
              <div key={step.id} id={`${id}--${step.id}`} className="gm-scene-copy-step" data-active={index === activeIndex}>
                <p className="gm-label">{step.kicker}</p>
                <h3 className="mt-1 text-lg font-semibold tracking-tight text-ink">{step.title}</h3>
                <div className="mt-2 text-sm text-muted">{step.body}</div>
              </div>
            ))}
            {footer ? <div className="gm-scene-copy-foot">{footer}</div> : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
