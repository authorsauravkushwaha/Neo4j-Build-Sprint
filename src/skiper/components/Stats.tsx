/**
 * Numbers that arrive, and meters that hold a value.
 *
 * The dataset tiles used to be static text, which is honest but easy to scroll
 * past. Counting up gives them a moment of attention — while keeping the two
 * rules that matter for a product whose whole pitch is honesty:
 *
 *   * the counter ends on the dataset's own number, exactly (no rounding to a
 *     rounder-looking figure);
 *   * the accessible name is the final number, not the animated one, so a screen
 *     reader never hears "1,204" on its way to 1,248 — see `aria-label` below.
 */
import { type ReactNode } from 'react'

import { formatGrouped, useCountUp } from '../motion/useCountUp.ts'

export interface CountUpStatProps {
  value: number
  label: string
  /** Optional qualifier under the number, e.g. "in the bundled dataset". */
  note?: string
  decimals?: number
  className?: string
  testId?: string
}

export function CountUpStat({ value, label, note, decimals = 0, className = '', testId }: CountUpStatProps): ReactNode {
  const counter = useCountUp(value, { decimals })
  const shown = decimals === 0 ? formatGrouped(counter.value) : counter.value.toFixed(decimals)

  return (
    <div ref={counter.ref} className={`gm-stat ${className}`} data-testid={testId}>
      <div className="gm-stat-value">
        {/* The animated digits are decorative; the exact value is what the
            accessibility tree announces. */}
        <span aria-hidden="true">{shown}</span>
        <span className="gm-sr-only">{decimals === 0 ? formatGrouped(value) : value.toFixed(decimals)}</span>
      </div>
      <div className="gm-stat-label">{label}</div>
      {note ? <div className="gm-stat-note">{note}</div> : null}
    </div>
  )
}

export interface MeterProps {
  /** 0..1. Rendered as a bar and announced as a percentage. */
  value: number
  label: string
  /** What the value means, in words, for the note beside the bar. */
  note?: string
  tone?: 'accent' | 'muted'
}

export function Meter({ value, label, note, tone = 'accent' }: MeterProps): ReactNode {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  return (
    <div className="gm-meter" data-tone={tone}>
      <div className="gm-meter-head">
        <span className="gm-meter-label">{label}</span>
        <span className="gm-meter-value">{Math.round(clamped * 100)}%</span>
      </div>
      <div
        className="gm-meter-track"
        role="meter"
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span className="gm-meter-fill" style={{ transform: `scaleX(${clamped.toFixed(3)})` }} />
      </div>
      {note ? <p className="gm-meter-note">{note}</p> : null}
    </div>
  )
}
