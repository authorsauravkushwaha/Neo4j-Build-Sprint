/**
 * Small, dependency-free UI primitives.
 *
 * They exist so that accessibility behaviour is implemented once: real buttons
 * and links, visible focus (from the global stylesheet), aria attributes on
 * state, no icon-only controls without an accessible name, and no colour-only
 * meaning. Tailwind classes come from the shared theme in src/styles/index.css.
 */
import type {
  ReactNode,
  ComponentType,
  HTMLAttributes,
  Ref,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
} from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  X,
  XCircle,
} from 'lucide-react'

import { useTilt } from '@/components/three/useTilt.ts'

/* ------------------------------------------------------------------ layout */

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  eyebrow?: string
}): ReactNode {
  return (
    <header className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="text-xs font-semibold uppercase tracking-wide text-accent">{eyebrow}</p> : null}
        <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/**
 * A sheet of glass.
 *
 * `lift` adds the pointer-tracked tilt used on showcase surfaces; the default is
 * the cheaper CSS-only depth (`.gm-card-3d`), which costs nothing per frame and
 * is what most pages want. `sheen` adds the diagonal specular sweep on hover —
 * decorative, so it is suppressed by the reduced-motion rules in index.css.
 */
export function Card({
  children,
  className = '',
  as: Tag = 'section',
  lift = false,
  sheen = false,
}: {
  children: ReactNode
  className?: string
  as?: 'section' | 'article' | 'div'
  /** Opt in to the pointer-tracked 3D tilt. Reserve it for focal surfaces. */
  lift?: boolean
  /** Opt in to the hover sheen sweep. */
  sheen?: boolean
}): ReactNode {
  const tilt = useTilt<HTMLElement>({ max: 4, scale: 1.004, lift: 6 })
  /*
   * `Tag` is a union of three intrinsic elements (section | article | div), and
   * TypeScript cannot accept one ref type for a union of refs. Narrowing it in
   * one place is clearer than three near-identical branches, and this is the only
   * place the union touches a ref at all.
   */
  const Tagged = Tag as unknown as ComponentType<HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> }>
  return (
    <Tagged
      ref={lift ? (tilt.ref as Ref<HTMLElement>) : undefined}
      {...(lift ? tilt.tiltProps : {})}
      className={`gm-card ${sheen ? 'gm-sheen' : ''} ${lift ? 'gm-card-3d gm-tilt' : 'gm-card-static'} p-4 sm:p-5 ${className}`}
    >
      {children}
    </Tagged>
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={`gm-panel gm-card-static p-4 sm:p-5 ${className}`}>{children}</div>
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }): ReactNode {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-lg font-semibold">{children}</h2>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  )
}

export function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }): ReactNode {
  const map = { 1: 'grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3' } as const
  return <div className={`grid grid-cols-1 gap-3 sm:gap-4 ${map[cols]}`}>{children}</div>
}

/* ----------------------------------------------------------------- controls */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps): ReactNode {
  const base = variant === 'primary' ? 'gm-btn-primary' : variant === 'ghost' ? 'gm-btn-ghost' : variant === 'danger' ? 'gm-btn gm-btn-danger' : 'gm-btn-secondary'
  const sizing = size === 'sm' ? 'px-2.5 py-1.5 text-sm' : ''
  return (
    <button
      type="button"
      className={`gm-btn ${base} ${sizing} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden="true" className="mr-1.5 h-4 w-4 animate-spin" /> : icon ? <span className="mr-1.5 inline-flex h-4 w-4 items-center">{icon}</span> : null}
      {children}
    </button>
  )
}

export function LinkButton({
  to,
  children,
  variant = 'primary',
  size = 'md',
  icon,
  className = '',
}: {
  to: string
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
  icon?: ReactNode
  className?: string
}): ReactNode {
  const base = variant === 'primary' ? 'gm-btn-primary' : variant === 'ghost' ? 'gm-btn-ghost' : 'gm-btn-secondary'
  const sizing = size === 'sm' ? 'px-2.5 py-1.5 text-sm' : ''
  return (
    // `draggable={false}`: these are navigation controls, not content links.
    // Chrome starts a native link drag on mousedown, which cancels `:active`,
    // so without this the button never shows its pressed state.
    <Link to={to} draggable={false} className={`gm-btn ${base} ${sizing} no-underline ${className}`}>
      {icon ? <span className="mr-1.5 inline-flex h-4 w-4 items-center">{icon}</span> : null}
      {children}
    </Link>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
  htmlFor: string
}): ReactNode {
  return (
    <div className="mb-3">
      <label className="gm-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }): ReactNode {
  const { invalid, className = '', ...rest } = props
  return <input className={`gm-input ${className}`} aria-invalid={invalid ? true : undefined} {...rest} />
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }): ReactNode {
  const { invalid, className = '', ...rest } = props
  return <textarea className={`gm-textarea ${className}`} aria-invalid={invalid ? true : undefined} {...rest} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  const { className = '', children, ...rest } = props
  return (
    <select className={`gm-select ${className}`} {...rest}>
      {children}
    </select>
  )
}

export function Checkbox({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
}): ReactNode {
  return (
    <div className="flex items-start gap-2 py-1">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-[var(--gm-accent)]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <div>
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- badges */

const DIFFICULTY_LABEL: Record<string, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
}

export function DifficultyBadge({ difficulty }: { difficulty?: string }): ReactNode {
  if (!difficulty) return null
  const tone =
    difficulty === 'beginner'
      ? 'border-[var(--gm-success)] text-[var(--gm-success)]'
      : difficulty === 'advanced'
        ? 'border-[var(--gm-warning)] text-[var(--gm-warning)]'
        : 'border-[var(--gm-border-strong)] text-muted'
  return (
    <span className={`gm-chip ${tone}`} title={`Curriculum difficulty: ${difficulty}`}>
      {DIFFICULTY_LABEL[difficulty] ?? difficulty}
    </span>
  )
}

/**
 * A skill rendered as a link to its page. Shared by the gap panel and the
 * landing page's worked example, so the two can never drift into looking like
 * two different products.
 */
export function SkillLink({ skillId, name, difficulty }: { skillId: string; name: string; difficulty: string }): ReactNode {
  return (
    <Link
      to={`/skills/${encodeURIComponent(skillId)}`}
      className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm no-underline hover:underline"
    >
      <span className="font-medium">{name}</span>
      <DifficultyBadge difficulty={difficulty} />
    </Link>
  )
}

export function Chip({
  children,
  tone = 'default',
  title,
}: {
  children: ReactNode
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'violet'
  title?: string
}): ReactNode {
  const map = {
    default: '',
    accent: 'border-accent text-accent',
    success: 'border-[var(--gm-success)] text-[var(--gm-success)]',
    warning: 'border-[var(--gm-warning)] text-[var(--gm-warning)]',
    danger: 'border-[var(--gm-danger)] text-[var(--gm-danger)]',
    violet: 'border-[var(--gm-violet)] text-[var(--gm-violet)]',
  } as const
  return (
    <span className={`gm-chip ${map[tone]}`} title={title}>
      {children}
    </span>
  )
}

export function ProgressBar({
  value,
  max = 100,
  label,
}: {
  value: number
  max?: number
  label: string
}): ReactNode {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((value / max) * 100)))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="gm-progress h-2 w-full overflow-hidden rounded-full"
    >
      <div className="h-full rounded-full bg-[var(--gm-accent)] transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }): ReactNode {
  return (
    <div className="gm-glass-raw gm-card-static rounded-lg px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {hint ? <div className="text-xs text-muted">{hint}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------ states/notices */

export function Callout({
  kind,
  title,
  children,
}: {
  kind: 'info' | 'warning' | 'success' | 'danger'
  title?: string
  children: ReactNode
}): ReactNode {
  const icon =
    kind === 'warning' ? (
      <AlertTriangle aria-hidden="true" className="h-4 w-4" />
    ) : kind === 'success' ? (
      <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
    ) : kind === 'danger' ? (
      <XCircle aria-hidden="true" className="h-4 w-4" />
    ) : (
      <Info aria-hidden="true" className="h-4 w-4" />
    )
  const tone =
    kind === 'warning'
      ? 'border-[var(--gm-warning)]'
      : kind === 'success'
        ? 'border-[var(--gm-success)]'
        : kind === 'danger'
          ? 'border-[var(--gm-danger)]'
          : 'border-line-strong'
  return (
    <div className={`flex gap-2 rounded-lg border ${tone} bg-[var(--gm-surface-2)] px-3 py-2 text-sm`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        <div className="text-muted">{children}</div>
      </div>
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }): ReactNode {
  return (
    <div role="status" className="flex items-center gap-2 p-4 text-sm text-muted">
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}): ReactNode {
  return (
    <div className="rounded-lg border border-dashed border-line-strong p-6 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  )
}

export function ErrorNotice({
  message,
  detail,
  onRetry,
}: {
  message: string
  detail?: string
  onRetry?: () => void
}): ReactNode {
  return (
    <div className="rounded-lg border border-[var(--gm-danger)] bg-[var(--gm-surface-2)] p-4">
      <p className="flex items-center gap-2 font-medium text-[var(--gm-danger)]">
        <XCircle aria-hidden="true" className="h-4 w-4" /> {message}
      </p>
      {detail ? <p className="mt-1 text-sm text-muted">{detail}</p> : null}
      {onRetry ? (
        <div className="mt-3">
          <Button onClick={onRetry} size="sm">
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Array<{ id: string; kind: 'info' | 'success' | 'warning' | 'error'; message: string; detail?: string }>
  onDismiss: (id: string) => void
}): ReactNode {
  if (toasts.length === 0) return null
  return (
    <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-96">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto rounded-lg border border-line bg-[var(--gm-bg-elevated)] p-3 shadow-lg"
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{toast.message}</p>
              {toast.detail ? <p className="mt-0.5 text-xs text-muted">{toast.detail}</p> : null}
            </div>
            <button
              type="button"
              className="gm-btn gm-btn-ghost min-h-9 min-w-9 px-1.5"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss message"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

export function List({
  items,
  ordered = false,
  className = '',
}: {
  items: ReactNode[]
  ordered?: boolean
  className?: string
}): ReactNode {
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5 text-sm ${className}`}>
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </Tag>
  )
}


