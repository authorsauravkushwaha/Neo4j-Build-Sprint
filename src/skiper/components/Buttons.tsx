/**
 * Buttons and other things you press.
 *
 * These wrap the product's existing `gm-btn` classes rather than restating them:
 * the depth language, the focus ring, the pressed state and the reduced-motion
 * kill switch for the lift all live in the stylesheet, and a second button
 * implementation would be a second set of bugs (the browser suite checks the
 * accent button's shadow recipe by name).
 *
 * What the Skiper layer adds is a light sweep across the surface on hover, and a
 * few pixels of pointer attraction. Both are strictly additive: remove the
 * class and the control still works, still looks correct and still has its
 * focus ring. That is the test for decoration — it must be removable.
 */
import { forwardRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { useMagnetic } from '../motion/useMagnetic.ts'

export interface MagneticLinkProps {
  to: string
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost'
  className?: string
  icon?: ReactNode
  /** 0 disables attraction (use for a row of small controls). */
  strength?: number
  sheen?: boolean
  'data-testid'?: string
}

/**
 * A router link that leans towards the pointer.
 *
 * `draggable={false}` and the `gm-btn` classes are carried over from
 * `ui.tsx`'s `LinkButton` for the reasons documented there: Chrome starts a
 * native link drag on mousedown, which cancels `:active`, and the pressed state
 * then never appears.
 */
export const MagneticLink = forwardRef<HTMLAnchorElement, MagneticLinkProps>(function MagneticLink(
  { to, children, variant = 'primary', className = '', icon, strength = 8, sheen = true, ...rest },
  _forwarded,
): ReactNode {
  const { ref, magneticProps } = useMagnetic<HTMLAnchorElement>({ strength, tilt: 1.5 })
  const base = variant === 'primary' ? 'gm-btn-primary' : variant === 'ghost' ? 'gm-btn-ghost' : 'gm-btn-secondary'
  return (
    <Link
      ref={ref}
      to={to}
      draggable={false}
      className={`gm-btn ${base} gm-magnet ${sheen ? 'gm-sheen' : ''} no-underline ${className}`}
      {...magneticProps}
      {...rest}
    >
      {icon ? <span className="mr-1.5 inline-flex h-4 w-4 items-center">{icon}</span> : null}
      {children}
    </Link>
  )
})

export interface MagneticButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost'
  className?: string
  icon?: ReactNode
  type?: 'button' | 'submit'
  disabled?: boolean
  strength?: number
  'aria-label'?: string
  'data-testid'?: string
}

export function MagneticButton({
  children,
  onClick,
  variant = 'secondary',
  className = '',
  icon,
  type = 'button',
  disabled = false,
  strength = 6,
  ...rest
}: MagneticButtonProps): ReactNode {
  const { ref, magneticProps } = useMagnetic<HTMLButtonElement>({ strength })
  const base = variant === 'primary' ? 'gm-btn-primary' : variant === 'ghost' ? 'gm-btn-ghost' : 'gm-btn-secondary'
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`gm-btn ${base} gm-magnet ${className}`}
      {...magneticProps}
      {...rest}
    >
      {icon ? <span className="mr-1.5 inline-flex h-4 w-4 items-center">{icon}</span> : null}
      {children}
    </button>
  )
}

/**
 * A surface with a light sweep and a pointer spotlight.
 *
 * The spotlight is a radial gradient positioned by two custom properties, so the
 * pointer drives the compositor and never React. Both effects live on
 * `aria-hidden` pseudo-elements: the surface's *content* is untouched.
 */
export function SpotlightCard({
  children,
  className = '',
  as: Component = 'div',
  testId,
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'article' | 'li' | 'section'
  testId?: string
}): ReactNode {
  const { ref, magneticProps } = useMagnetic<HTMLElement>({ strength: 4 })
  const As = Component as 'div'
  return (
    <As
      ref={ref as React.RefObject<HTMLDivElement | null>}
      className={`gm-card gm-spotlight gm-sheen g-pad ${className}`}
      data-testid={testId}
      onPointerMove={(event) => {
        const element = event.currentTarget
        const rect = element.getBoundingClientRect()
        element.style.setProperty('--gm-spot-x', `${((event.clientX - rect.left) / rect.width) * 100}%`)
        element.style.setProperty('--gm-spot-y', `${((event.clientY - rect.top) / rect.height) * 100}%`)
        magneticProps.onPointerMove(event)
      }}
      onPointerLeave={(event) => {
        event.currentTarget.style.removeProperty('--gm-spot-x')
        event.currentTarget.style.removeProperty('--gm-spot-y')
        magneticProps.onPointerLeave()
      }}
    >
      {children}
    </As>
  )
}
