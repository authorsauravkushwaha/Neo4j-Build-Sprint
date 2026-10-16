/**
 * Motion tokens for the Skiper-style layer.
 *
 * Why tokens and not literals: this layer is used by roughly twenty components,
 * and the fastest way to make an interface feel cheap is to have twenty slightly
 * different easings. Everything animated here reads from this file, so retuning
 * the whole product's motion is one edit.
 *
 * Two rules the numbers encode:
 *
 *   1. Entrances are slower than exits. A thing arriving is information; a thing
 *      leaving is already understood. 240ms in, 160ms out.
 *   2. Nothing here exceeds 1.2s except the deliberate set pieces (the preloader
 *      and the pinned scenes), because a scroll-linked animation that is still
 *      playing when the user scrolls past it is a bug the user sees as jank.
 *
 * These are durations, not decisions: the decision to animate at all is made by
 * `useMotionPreference`, which every component consults. Under `reduced`, the
 * durations below are irrelevant because the transitions are never created.
 */

/** Entrances. */
export const DURATION = {
  /** Hairlines, dots, colour changes. */
  quick: 160,
  /** The default: fades, small rises, chip reveals. */
  normal: 240,
  /** Cards and panels that move a meaningful distance. */
  slow: 420,
  /** Headline choreography and scene set pieces. */
  scene: 720,
  /** Ceiling for anything that is not the preloader. */
  max: 1200,
} as const

/** Easing curves, as `cubic-bezier` control points so CSS and JS agree. */
export const EASE = {
  /** Decelerating: arrivals. Fast at the start, settled at the end. */
  out: [0.16, 1, 0.3, 1],
  /** Accelerating: departures. */
  in: [0.7, 0, 0.84, 0],
  /** Symmetric: things that move across the screen and keep going. */
  inOut: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>

/** CSS-ready strings for the same curves, for the places that use style props. */
export const EASE_CSS = {
  out: `cubic-bezier(${EASE.out.join(', ')})`,
  in: `cubic-bezier(${EASE.in.join(', ')})`,
  inOut: `cubic-bezier(${EASE.inOut.join(', ')})`,
} as const

/** Distances, in pixels. Small: this is a focused product page, not a theme park. */
export const DISTANCE = {
  /** Barely-there nudge used for stagger and hover. */
  tiny: 6,
  /** Default rise for reveals. */
  small: 16,
  /** Cards and panels. */
  medium: 32,
  /** Scene-level movement. */
  large: 64,
} as const

/** Stagger between siblings. Above ~90ms a list reads as broken, not deliberate. */
export const STAGGER = {
  tight: 40,
  normal: 70,
  loose: 110,
} as const

/** Scroll-linked scenes: how much extra scroll distance a pinned scene consumes. */
export const SCENE = {
  /** Viewport-heights of scroll a two-step scene is given. */
  short: 1.2,
  /** The default for a three-to-four step scene. */
  normal: 1.8,
  /** Long walkthroughs (the graph anatomy scene). */
  long: 2.6,
} as const

/** A spring description for `motion`, tuned to the curves above. */
export const SPRING = {
  /** Follows a pointer or a scroll value without visible lag. */
  follow: { stiffness: 260, damping: 30, mass: 0.6 },
  /** Settles into place with one small overshoot. */
  settle: { stiffness: 190, damping: 22, mass: 0.9 },
  /** No overshoot at all: used for anything text-sized, where bounce reads as a glitch. */
  flat: { stiffness: 320, damping: 40, mass: 1 },
} as const

/**
 * The stagger multiplier for a group of `count` items.
 *
 * A fixed stagger is fine for four cards and unbearable for forty, so the delay
 * is clamped: the last item never waits more than `capMs`, however long the list
 * is. Without the clamp, a reveal on a long list becomes a slideshow.
 */
export function staggerDelay(index: number, step: number = STAGGER.normal, capMs = 480): number {
  return Math.min(index * step, capMs)
}

/** True when the value is inside the closed 0..1 range. */
export function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/** Clamp to 0..1. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Linear interpolation, clamped. */
export function mix(from: number, to: number, t: number): number {
  return from + (to - from) * clamp01(t)
}

/** Maps `value` from `[inMin, inMax]` onto `[outMin, outMax]`, clamped. */
export function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin
  return mix(outMin, outMax, clamp01((value - inMin) / (inMax - inMin)))
}
