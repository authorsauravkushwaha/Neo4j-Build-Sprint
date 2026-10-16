/**
 * Kinetic type.
 *
 * Three treatments, chosen because each one carries a different kind of meaning:
 *
 *   * `KineticHeadline` — a headline that assembles word by word. Used once, on
 *     the hero, where the reader has just arrived and the words are the point.
 *   * `WordCycle` — a single slot cycling through alternatives ("careers",
 *     "roles", "routes"). Used where the sentence is a template and the slot is
 *     the variable. It is a `<span>` inside the real sentence, so the sentence
 *     still reads correctly in a text extraction.
 *   * `MaskLine` — a line that rises out of a clipped box. The quiet one, for
 *     section titles.
 *
 * All three are typographic only: no letter-spacing changes, no per-letter
 * transforms, nothing that reflows mid-sentence. Word-level is the finest grain
 * that stays legible while moving, and it is also the finest grain that keeps
 * `textContent` intact — which the honesty tests and the search engines both
 * read.
 */
import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'

import { DURATION, EASE, STAGGER, staggerDelay } from '../motion/tokens.ts'
import { useInViewOnce } from '../motion/useInViewOnce.ts'
import { useMotionPreference } from '../motion/useMotionPreference.ts'

export interface KineticHeadlineProps {
  /** The sentence. Rendered verbatim; splitting is invisible to the DOM's text. */
  text: string
  /** Words (by value, case-insensitive, punctuation-tolerant) rendered in the accent colour. */
  accent?: string[]
  /**
   * Rendered element. `span` and `div` are allowed so a headline can be split
   * across two elements for a responsive layout while staying one `<h1>` — the
   * projection the browser accessibility tree and a text extraction both read.
   */
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div'
  className?: string
  /** Milliseconds between words. */
  step?: number
  /** Play on scroll into view (the default) or immediately. */
  immediate?: boolean
}

export function KineticHeadline({
  text,
  accent = [],
  as = 'h2',
  className = '',
  step = STAGGER.normal,
  immediate = false,
}: KineticHeadlineProps): React.ReactNode {
  const { reduced } = useMotionPreference()
  const { ref, inView } = useInViewOnce<HTMLDivElement>({ rootMargin: '0px 0px -8% 0px', threshold: 0.1 })
  const Component = as
  const words = text.split(' ')
  const accentSet = new Set(accent.map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, '')))

  // Reduced motion, or a headline that has not entered the viewport yet: plain
  // text, whole, on the first frame.
  if (reduced) {
    return (
      <Component className={className} ref={ref}>
        {text}
      </Component>
    )
  }

  const start = immediate || inView
  // A word that must never wrap away from its neighbour keeps its trailing space
  // inside the same span, so `textContent` is byte-for-byte the sentence.
  return (
    <Component className={className} ref={ref}>
      {words.map((word, index) => {
        const key = word.toLowerCase().replace(/[^a-z0-9]/g, '')
        const isAccent = accentSet.has(key)
        return (
          <motion.span
            key={`${word}-${index}`}
            className={isAccent ? 'gm-kinetic-word gm-kinetic-accent' : 'gm-kinetic-word'}
            initial={{ opacity: 0, y: '0.4em', filter: 'blur(6px)' }}
            animate={start ? { opacity: 1, y: '0em', filter: 'blur(0px)' } : { opacity: 0, y: '0.4em', filter: 'blur(6px)' }}
            transition={{
              duration: DURATION.scene / 1000,
              delay: staggerDelay(index, step, 700) / 1000,
              ease: EASE.out,
            }}
          >
            {word}
            {index < words.length - 1 ? ' ' : ''}
          </motion.span>
        )
      })}
    </Component>
  )
}

export interface WordCycleProps {
  /** The alternatives, in the order they should be read. */
  words: readonly string[]
  /** Milliseconds each word holds. */
  intervalMs?: number
  className?: string
}

/**
 * A word slot that cycles.
 *
 * The whole list is rendered as a stacked set of spans; only the active one is
 * visible. That means every alternative is in the DOM (so a text extractor, a
 * translation tool or a test sees the complete claim) and none of them cause a
 * layout shift, because the widest one reserves the space.
 */
export function WordCycle({ words, intervalMs = 2600, className = '' }: WordCycleProps): React.ReactNode {
  const { reduced } = useMotionPreference()
  const [index, setIndex] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (reduced || words.length < 2) return
    timer.current = setInterval(() => setIndex((previous) => (previous + 1) % words.length), intervalMs)
    return () => {
      if (timer.current !== null) clearInterval(timer.current)
      timer.current = null
    }
  }, [intervalMs, reduced, words.length])

  if (reduced || words.length < 2) {
    // Static, and it says all of them rather than picking one arbitrarily.
    return <span className={className}>{words.join(' · ')}</span>
  }

  return (
    <span className={`gm-wordcycle ${className}`}>
      {words.map((word, position) => (
        <span key={word} aria-hidden={position !== index} className="gm-wordcycle-word" data-active={position === index}>
          {word}
        </span>
      ))}
    </span>
  )
}

export interface MaskLineProps {
  children: React.ReactNode
  as?: 'h2' | 'h3' | 'p' | 'div'
  className?: string
}

/** A line that rises out of a clipped box when it enters view. The quiet one. */
export function MaskLine({ children, as = 'h2', className = '' }: MaskLineProps): React.ReactNode {
  const { reduced } = useMotionPreference()
  const { ref, inView } = useInViewOnce<HTMLDivElement>({ rootMargin: '0px 0px -10% 0px', threshold: 0.25 })
  const Component = as

  if (reduced) return <Component className={className}>{children}</Component>

  return (
    <span className="gm-mask">
      <motion.span
        ref={ref}
        className={`gm-mask-inner ${className}`}
        initial={{ y: '110%', opacity: 0 }}
        animate={inView ? { y: '0%', opacity: 1 } : { y: '110%', opacity: 0 }}
        transition={{ duration: DURATION.scene / 1000, ease: EASE.out }}
      >
        <Component className="m-0">{children}</Component>
      </motion.span>
    </span>
  )
}
