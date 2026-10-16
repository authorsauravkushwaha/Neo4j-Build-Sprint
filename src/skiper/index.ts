/**
 * The Skiper-style motion layer: public surface.
 *
 * This directory is a small, first-party component library. It exists because
 * the alternative — sprinkling `transition-all` and a few keyframes through the
 * feature pages — produces the thing this product is explicitly against: motion
 * that is decorative in one place, informational in another, and unreviewable in
 * both.
 *
 * Every component here obeys the same contract, and it is short enough to state
 * in full:
 *
 *   1. **Motion is optional.** Reduced motion is read from `<html data-motion>`
 *      (see `motion/useMotionPreference.ts`); when it is `reduced`, components
 *      render the finished state and attach no listeners.
 *   2. **Decoration is hidden from assistive technology.** Anything that exists
 *      only to move carries `aria-hidden="true"`; anything that carries meaning
 *      is real text, in the document, in reading order.
 *   3. **Nothing moves content the reader needs.** No component here shifts text
 *      after it has been read, and none of them require a pointer: each one has a
 *      keyboard path or a static equivalent.
 *   4. **The frame budget is finite.** Scroll work is throttled to one write per
 *      frame and writes CSS custom properties, so React is not in the scroll
 *      path.
 *
 * The usage guide — including what each component is for and what it is not —
 * is `docs/skiper-ui.md`.
 */

export * from './motion/tokens.ts'
export * from './motion/useMotionPreference.ts'
export * from './motion/useScrollProgress.ts'
export * from './motion/useScrollFlag.ts'
export * from './motion/useInViewOnce.ts'
export * from './motion/useCountUp.ts'
export * from './motion/useScrollSpy.ts'
export * from './motion/useMagnetic.ts'

export * from './components/Reveal.tsx'
export * from './components/Kinetic.tsx'
export * from './components/Preloader.tsx'
export * from './components/ScrollScene.tsx'
export * from './components/Buttons.tsx'
export * from './components/Marquee.tsx'
export * from './components/Stats.tsx'
export * from './components/Cards.tsx'
export * from './components/GraphConstellation.tsx'
export * from './components/ScrollRail.tsx'
export * from './components/ScrollChrome.tsx'
export * from './components/PageTransition.tsx'
export * from './components/Stagger.tsx'
