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
| `useScrollFlag({ threshold })` | `boolean` | "Is the reader past this point?" A boolean, and deliberately **not** motion-gated: the back-to-top control is a control, and wanting less motion is not wanting fewer features. `threshold` may be a function, so `() => 3 * innerHeight` survives a resize. Pure boundary test: `isPastScrollThreshold`. |

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
| `Stagger` | A list that arrives in order. | No per-row JavaScript and no extra elements: one observer on the container, one attribute, and the stylesheet gives each child its delay by `nth-child` (capped at twelve, matching the token clamp). Children are never cloned or wrapped, so a `<ul>` of `<li>` stays one. |
| `AppScrollRail` | The hairline document progress bar, mounted once in `Layout` for every route. | Decorative (`aria-hidden`) and not rendered at all under reduced motion — a bar frozen at 0% is worse than no bar. |
| `BackToTop` | A real button that appears past three viewports and returns focus to the main region. | Never a link to `#`, never hidden under reduced motion (it is a control), and only smooth-scrolls when motion is allowed. |
| `PageTransition` | The incoming screen rises 8px and fades in over 200ms. | CSS animation only — no exit twin (an exit delays the screen the user just asked for), keyed on `pathname` so a query change does not remount the screen, and a plain fragment under reduced motion. |
| `SectionTitle sticky` (in `components/ui.tsx`) | Pins a group heading to the top while its own group scrolls past. | Not switched off under reduced motion: pinning is not movement. Requires no transformed ancestor. |
| `GraphConstellation` | Draws the prerequisite graph from the frontier engine's own output. | Never hand-placed: x is dependency depth, y is ordering, edges come from `needsNow`. Node positions never imply a value they do not have. |

## Where the scroll layer is used

The landing page is a story; the **app** is where the scrolling actually happens, so
the layer is site-wide and the shell owns most of it:

| Where | What moves |
| --- | --- |
| `app/Layout.tsx` (every route) | The rail, the back-to-top button, the app bar condensing past 8px, and the entrance on the incoming screen. |
| Dashboard | The four counters, and the "Next up" list in dependency order. |
| Career explorer | The result grid. |
| Career detail | Each tab panel re-enters when the tab changes (`key={tab}`), because the instance would otherwise be reused and never re-run. |
| Skill index, projects, resources | The result list. |
| Progress, About | The summary grids. |
| Pathway | The ordered steps, staggered *in order* — here the sequence is the engine's dependency order, so arriving in sequence is information rather than decoration. |
| Roadmap | The weekly cards, plus a **sticky week heading** that pins while its own week scrolls past. |
| Gaps, workflows | The category groups and the run's node list. |
| Deliberately still | Filter cards, form fields, the mentor transcript (a chat that re-animates re-animates history), the graph canvases and every 3D scene's own control surface. |

`tests/unit/scroll-coverage.test.ts` asserts both halves of that table, so neither a
page losing its entrance nor a filter bar gaining one can pass review.

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
| `tests/integration/scroll-chrome.test.tsx` | The shell, driven: the rail exists on every route and is absent under reduced motion, the bar condenses on a real scroll and relaxes again, the back-to-top button appears past three viewports and moves focus to the main region, reduced motion keeps the button but drops the entrance, and a route change re-enters the screen. |
| `tests/unit/scroll-coverage.test.ts` | The two claims above: every content page imports the layer and stages something; every animated class has a `[data-motion='reduced']` kill switch that forces the finished state; the barrel exports every file; filter cards stay plain `Grid`s; no page hand-rolls `transition-all`. |
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
* **Sticky headings need a scroll container that is not transformed.** The reveal
  is applied to a section's body and never to the section itself, because a
  transform on an ancestor moves the box the heading pins against. Any future
  component that wraps a pinned heading must respect the same rule.
* **The positional stagger is capped at twelve children in CSS** (every row after
  that shares the last delay). The cap is deliberate — forty rows at 70ms each is
  a slideshow — but it means a list longer than twelve does not "arrive one by
  one" all the way down, and the stylesheet, not the component, is where that is
  decided.
* **Back-to-top does not appear on a page shorter than three viewports**, which is
  most of them. That is the point (there is nothing to go back to), and it means
  the control is not a place to hang any other behaviour.
* There is no `prefers-reduced-transparency` or `prefers-contrast` handling here.
  The material already avoids translucent surfaces — this layer only adds motion.
