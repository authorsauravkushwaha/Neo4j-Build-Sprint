# The Skiper-style motion layer

The landing page is a scroll story. This document describes the component library
it is built from — what each piece is for, what it guarantees, and what it
deliberately refuses to do. It is written for the next person who has to change
it, and for the reviewer who has to decide whether a new animation belongs here.

The directory is `src/skiper/`. The name is a nod to [Skiper UI](https://skiper-ui.com),
the animated-component collection for shadcn/ui whose idiom — scroll scenes,
kinetic type, preloaders, card stacks, marquees — shaped this layer. This is not
a port and not a dependency: Skiper UI is a copy-paste library distributed through
the shadcn registry under a paid licence, and this project cannot depend on a
private registry at build time. What is shared is the *vocabulary*. Every
component here is first-party, Tailwind-native, and written against this
product's own material and accessibility rules.

## The contract

Every component in this directory obeys all four rules. A pull request that
breaks one of them is a bug, not a taste disagreement.

1. **Motion is optional.** The preference comes from `<html data-motion>`, read by
   `useMotionPreference()`. That attribute is written by `applyTheme()` from both
   the OS media query and the in-app switch, and
   `tests/unit/motion-preference.test.ts` pins all three spellings. When it is
   `reduced`, components render the finished state and attach no scroll listeners.
2. **Decoration is `aria-hidden`.** Anything that exists only to move is hidden
   from assistive technology, and the fact it illustrates is stated in the copy
   beside it as real text. The constellation is the clearest example: the SVG is
   hidden, the chain it draws is written out in the step body.
3. **Nothing depends on a pointer.** Every interactive component has a keyboard
   path, and the scroll scenes have a real navigation list (`StoryNavBar`) so a
   reader can skip the animation entirely.
4. **React is not in the scroll path.** Scroll-linked work is throttled to one
   `requestAnimationFrame` per frame and writes CSS custom properties; the
   compositor does the rest.

## Motion tokens

`motion/tokens.ts` holds every duration, easing curve, distance and stagger in
one place.

| Token | Value | Used for |
| --- | --- | --- |
| `DURATION.quick` | 160ms | hairlines, colour changes |
| `DURATION.normal` | 240ms | the default fade/rise |
| `DURATION.slow` | 420ms | cards and panels |
| `DURATION.scene` | 720ms | headline choreography |
| `EASE.out` | `cubic-bezier(.16,1,.3,1)` | arrivals |
| `EASE.inOut` | `cubic-bezier(.65,0,.35,1)` | things that cross the screen |
| `DISTANCE.small` | 16px | the default reveal rise |
| `STAGGER.normal` | 70ms | between siblings, clamped by `staggerDelay()` |
| `SCENE.normal` | 1.8 viewport-heights | a three-to-four step pinned scene |

Entrances are slower than exits and nothing except the preloader exceeds 1.2s. A
scroll-linked animation still playing when the reader has scrolled past it is
experienced as jank, so the ceilings matter more than the values.

## Hooks

| Hook | Returns | Notes |
| --- | --- | --- |
| `useMotionPreference()` | `{ reduced, tier, duration(ms) }` | Subscribes to the attribute *and* the media query. `duration(ms)` collapses to 0 when reduced, so call sites do not branch. |
| `useScrollProgress(options)` | `{ ref, progress, step, reduced }` | Modes: `pin` (top travels to the top of the viewport), `cover` (element enters and leaves), `through` (element crosses). Pure maths lives in `scrollProgressFromRect`, which is unit-tested with a table of cases. |
| `usePageScrollProgress()` | `number` | Document progress for the reading rail. |
| `useInViewOnce(options)` | `{ ref, inView }` | Fires once. Reports `true` immediately when `IntersectionObserver` is missing, so content can never be stuck invisible. |
| `useCountUp(target)` | `{ ref, value, target, done }` | Ends on the exact value; instant under reduced motion. |
| `useScrollSpy(entries)` | active id | Backs both the chapter bar and the pinned scene's step rail. |
| `useMagnetic(options)` | `{ ref, magneticProps }` | Writes `--gm-magnet-x/y/tilt`. Skips touch and reduced motion. |
| `useParallax(options)` | ref | Decorative layer only — never text. |

## Components

| Component | What it does | What it refuses to do |
| --- | --- | --- |
| `StoryPreloader` | Four words, a hairline, a curtain. | Never blocks the pointer (`pointer-events: none`), never outlives its own 900ms timer, never renders at all under reduced motion or after the first play in a session. |
| `KineticHeadline` | Assembles a headline word by word with a small blur. | Word-level only, so `textContent` stays byte-identical to the sentence. No per-letter effects. |
| `WordCycle` | One slot cycling through alternatives. | Renders every alternative into the DOM; under reduced motion it prints them all instead of picking one. |
| `MaskLine` | A line rising out of a clipped box. | Never moves content that has already been read. |
| `Reveal` / `RevealCss` | Entrance reveal, Motion or CSS. | Uses transform and opacity only. `RevealCss` is preferred in lists: no Motion, no rAF. |
| `ScrollScene` | Pinned scene: sticky visual, scrolling copy, step rail. | Never mounts copy on scroll — all steps are in the DOM. Reduced motion and small screens get the stacked document form. |
| `StoryNavBar` / `StoryChapters` | Real `<nav>` of real anchors with `aria-current`. | Never a decorative dot-strip: this is the keyboard path past the animation. |
| `ScrollProgressBar` | Hairline document progress. | Not rendered under reduced motion — better absent than frozen. |
| `Marquee` | The thirteen careers, moving. | Duplicate row is `aria-hidden`; pauses on hover and focus; reduced motion renders a wrapping list. |
| `CardStack` | One career card at a time, prev/next, arrow keys, "4 of 13". | Never auto-advances. Never swipe-only. Reduced motion renders a grid. |
| `CountUpStat` | A dataset number that arrives. | Ends on the exact value; the accessibility tree hears the final number, not the animation. |
| `Meter` | A bar with a real `role="meter"`. | Only ever fed a computed value — never a decorative percentage. |
| `MagneticLink` / `MagneticButton` | Buttons that lean towards the pointer, with a sheen. | Movement is capped at 8px so the hit box never moves away from the click. |
| `SpotlightCard` | Pointer-follow highlight on a card surface. | Highlight is a pseudo-element; content and contrast are untouched. |
| `GraphConstellation` | Draws the prerequisite graph from the frontier engine's own output. | Never hand-placed: x is dependency depth, y is ordering, edges come from `needsNow`. Node positions never imply a value they do not have. |

## Where the data comes from

The story's scenes are not written for the page. `features/landing/storyGraph.ts`
turns a `FrontierReport` into coordinates:

* **x** ← `depths` (the engine's dependency depth),
* **y** ← position within the depth, ordered by `compareCodeUnits` — the engine's
  own comparator, which is locale-independent because `tools/oracle/FrontierOracle.java`
  recomputes the same lists in Java and the two must agree,
* **edges** ← `needsNow`, so every drawn line is a `requires` relationship,
* **colour and label** ← `criticalChain`, `frontier` and `meetsTarget`.

If the dataset changes, the drawing changes. There is no second source of truth,
and no number in the front end to keep in step with the graph.

## Testing

| Suite | What it pins |
| --- | --- |
| `tests/unit/skiper-motion.test.ts` | `scrollProgressFromRect` and `quantise` across the awkward cases (element taller than the viewport, zero-height element, element already scrolled past), plus `staggerDelay` clamping and `easeOutCubic` landing exactly on 1. |
| `tests/unit/story-graph.test.ts` | The constellation is derived, deterministic and complete: every node has coordinates inside the viewBox, every drawn edge has both ends on the canvas, and the caption states the total it sampled from. |
| `tests/integration/story-landing.test.tsx` | The chapters all exist as sections; every scene step's copy is in the document; reduced motion renders the stacked document form with the same text. |
| `tests/unit/motion-preference.test.ts` | (existing) the attribute spelling shared by the store, the WebGL gate and the stylesheet. |
| `scripts/verify-browser.ts` | (existing, needs a browser) hero reachable by a real pointer at 1440×900 and 360×667, no `backdrop-filter` anywhere, the material's shadow pair intact, and the reduced-motion screenshot. |

## Adding a component

1. Read the contract at the top of this file. If the component needs an exception
   to one of the four rules, the honest answer is usually that it belongs in the
   feature that needs it, not here.
2. Take motion tokens from `motion/tokens.ts`; do not write a duration literal.
3. Add rules to `src/styles/index.css` under the "Skiper-style motion layer"
   banner, and add the matching `[data-motion='reduced']` kill switch in the same
   commit — a component whose animation is not neutralised is not finished.
4. Add a unit test for any maths, and an integration test asserting the
   reduced-motion branch renders the same *content*.
5. Export it from `src/skiper/index.ts` and add a row to the table above.

## Known limitations

* The pinned scenes are `lg` and up only. On a phone, the same steps are stacked
  sections. This is a deliberate simplification, not a missing feature: pinning a
  360×667 viewport leaves too little room for the copy, and it fights the
  browser's own URL-bar collapse.
* The marquee's seamless loop depends on the duplicated row being at least as
  wide as the viewport. With very few items it will show a gap; the component is
  not used with fewer than ten.
* `ScrollScene` measures with `getBoundingClientRect` inside a rAF, which is
  correct but not free. A page with more than roughly ten pinned scenes would
  need an `IntersectionObserver` gate around the measurement loop.
* There is no `prefers-reduced-transparency` or `prefers-contrast` handling here.
  The material already avoids translucent surfaces — this layer only adds motion.
