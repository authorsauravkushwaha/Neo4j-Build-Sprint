/**
 * Accounts: sign in, create an account, magic link, reset, and the account
 * screen for someone already signed in.
 *
 * Rules this screen follows, because auth screens are where good intentions
 * usually get dropped:
 *
 *   - **Guest mode stays first-class.** If this build has no Supabase project,
 *     the form is not rendered at all: pretending to accept a password that goes
 *     nowhere would be worse than saying "accounts are not configured here".
 *   - **The password is never stored.** It lives in component state for the
 *     duration of one submit, is cleared in a `finally`, and is never logged,
 *     never put in a URL, and never written to storage. The password inputs are
 *     `type="password"` with the correct `autocomplete` hints so password
 *     managers work and the browser does not offer to save a mangled value.
 *   - **The policy is the server's policy.** The checklist is driven by
 *     `checkPassword()` from `@core/security.ts` — the same function the Edge
 *     Function runs — so nothing can be "valid here, rejected there".
 *   - **Failure messages do not discriminate.** One wording for a wrong password,
 *     one for a wrong address, and never a hint about whether an account exists.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Eye, EyeOff, KeyRound, LogOut, Mail, ShieldCheck, Sparkles, TriangleAlert, UserRound } from 'lucide-react'

import {
  Button,
  Callout,
  Card,
  Chip,
  Field,
  Grid,
  LinkButton,
  List,
  Loading,
  PageHeader,
  SectionTitle,
  Stat,
  TextInput,
} from '@/components/ui.tsx'
import { useTilt } from '@/components/three/useTilt.ts'
import {
  authAvailable,
  checkPassword,
  describeSession,
  sendMagicLink,
  sendPasswordReset,
  signInWithPassword,
  signOut,
  signOutEverywhere,
  signUpWithPassword,
  strengthBand,
  updatePassword,
  type AuthResult,
} from '@/core/auth.ts'
import { onAuthChange } from '@/core/supabase.ts'
import {
  getSyncState,
  type SyncState,
  localChangePassword,
  localDeleteAccount,
  localSignIn,
  localSignOut,
  localSignUp,
  probeAccounts,
  putSyncState,
  type LocalUser,
} from '@/core/authApi.ts'
import type { Session } from '@supabase/supabase-js'
import { useAppStore } from '@/state/store.ts'
import { formatDate } from '@/core/format.ts'

type Mode = 'sign-in' | 'sign-up' | 'magic-link' | 'reset'

const MODE_LABELS: Record<Mode, string> = {
  'sign-in': 'Sign in',
  'sign-up': 'Create account',
  'magic-link': 'Email link',
  reset: 'Reset password',
}

export function AuthPage(): ReactNode {
  const [session, setSession] = useState<Session | null>(null)
  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AuthResult | null>(null)
  const pushToast = useAppStore((state) => state.pushToast)
  const setSessionInStore = useAppStore((state) => state.setSession)

  useEffect(
    () =>
      onAuthChange((next) => {
        setSession(next)
        setSessionInStore(next)
      }),
    [setSessionInStore],
  )

  // Our own account server (server/server.ts, on this project's database) is
  // the fallback when no Supabase project is configured. `null` = still asking.
  const [localUser, setLocalUser] = useState<LocalUser | null>(null)
  const [localAvailable, setLocalAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    if (authAvailable()) return
    let cancelled = false
    void probeAccounts().then((probe) => {
      if (cancelled) return
      setLocalAvailable(probe.available)
      setLocalUser(probe.user)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const band = useMemo(() => strengthBand(password), [password])
  const serverCheck = useMemo(() => checkPassword(password), [password])
  const matches = password.length > 0 && password === confirm
  const canSubmit =
    !busy &&
    /.+@.+\..+/.test(email.trim()) &&
    (mode === 'magic-link' || mode === 'reset'
      ? true
      : mode === 'sign-in'
        ? password.length > 0
        : serverCheck.ok && matches)

  const localSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmit || (mode !== 'sign-in' && mode !== 'sign-up')) return
    setBusy(true)
    setResult(null)
    try {
      const outcome = mode === 'sign-in' ? await localSignIn(email, password) : await localSignUp(email, password)
      setResult(outcome)
      if (outcome.ok) {
        setPassword('')
        setConfirm('')
        if (outcome.user) setLocalUser(outcome.user)
        else if (mode === 'sign-up') setMode('sign-in')
        pushToast({ kind: 'success', message: outcome.message })
      }
    } catch {
      setResult({ ok: false, message: 'Sign-in did not complete. Please try again.' })
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setResult(null)
    try {
      const outcome =
        mode === 'sign-in'
          ? await signInWithPassword(email, password)
          : mode === 'sign-up'
            ? await signUpWithPassword(email, password)
            : mode === 'magic-link'
              ? await sendMagicLink(email)
              : await sendPasswordReset(email)
      setResult(outcome)
      if (outcome.ok) {
        setPassword('')
        setConfirm('')
        pushToast({ kind: 'success', message: outcome.message })
      }
    } catch (error) {
      // Last-resort net: nothing from the provider reaches the user raw.
      setResult({ ok: false, message: 'Sign-in did not complete. Please try again.' })
      void error
    } finally {
      // The password exists in state only for the length of this call.
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow="Accounts"
        title={session ? 'Your account' : 'Sign in, or keep working as a guest'}
        description={
          session
            ? 'Your plan, progress and bookmarks can follow you between devices. Nothing about the app is locked behind this screen.'
            : 'An account is optional. It adds one thing: your roadmap and progress stored on the server so another device can pick them up. Everything else works as a guest.'
        }
      />

      {!authAvailable() && localAvailable === false ? <NotConfigured /> : null}

      {authAvailable() && session ? <SignedIn session={session} /> : null}

      {!authAvailable() && localAvailable && localUser ? (
        <LocalSignedIn
          user={localUser}
          onSignedOut={() => setLocalUser(null)}
          onDeleted={() => setLocalUser(null)}
        />
      ) : null}

      {(authAvailable() && !session) || (!authAvailable() && localAvailable && !localUser) ? (
        <div className="gm-stage">
          <AuthCard
            {...(!authAvailable() ? { modes: ['sign-in', 'sign-up'] as Mode[] } : {})}
            mode={mode}
            onMode={setMode}
            email={email}
            onEmail={setEmail}
            password={password}
            onPassword={setPassword}
            confirm={confirm}
            onConfirm={setConfirm}
            showPassword={showPassword}
            onToggleShow={() => setShowPassword((value) => !value)}
            result={result}
            busy={busy}
            canSubmit={canSubmit}
            band={band}
            serverCheck={serverCheck}
            matches={matches}
            onSubmit={authAvailable() ? submit : localSubmit}
          />
        </div>
      ) : null}

      {!authAvailable() && localAvailable === null ? <Loading label="Checking whether accounts are enabled…" /> : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function NotConfigured(): ReactNode {
  return (
    <Card>
      <SectionTitle hint="this build, right now">Accounts are not enabled on this deployment</SectionTitle>
      <p className="text-sm text-muted">
        No account service is answering behind this build — neither the project&apos;s own sign-in server nor a configured
        Supabase project — so the sign-in form is deliberately not shown: a password box that goes nowhere would be theatre.
        Nothing is missing from the app: guest mode uses the same engine over the bundled dataset, and your progress is kept
        in this browser.
      </p>
      <div className="mt-3">
        <List
          items={[
            'Your plan, skill ratings, progress and bookmarks are stored on this device and can be exported or erased in Settings.',
            'When the operator runs the sign-in server (`npm run server`, backed by the database in `db/`) or configures Supabase, this page becomes a working sign-in — no other screen changes.',
            'Deployment steps are in docs/deployment.md; the security design is in docs/security.md.',
          ]}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <LinkButton to="/dashboard" variant="primary">
          Continue as a guest
        </LinkButton>
        <LinkButton to="/settings" variant="secondary">
          Open Settings
        </LinkButton>
      </div>
    </Card>
  )
}

interface AuthCardProps {
  mode: Mode
  /** Which account options to offer. Our own server offers sign-in/sign-up only. */
  modes?: Mode[]
  onMode: (mode: Mode) => void
  email: string
  onEmail: (value: string) => void
  password: string
  onPassword: (value: string) => void
  confirm: string
  onConfirm: (value: string) => void
  showPassword: boolean
  onToggleShow: () => void
  result: AuthResult | null
  busy: boolean
  canSubmit: boolean
  band: ReturnType<typeof strengthBand>
  serverCheck: ReturnType<typeof checkPassword>
  matches: boolean
  onSubmit: (event: FormEvent) => Promise<void>
}

function AuthCard(props: AuthCardProps): ReactNode {
  const { ref: tiltRef, tiltProps } = useTilt<HTMLDivElement>({ max: 3, scale: 1.004, lift: 4 })
  const wantsPassword = props.mode === 'sign-in' || props.mode === 'sign-up'

  return (
    <div ref={tiltRef} {...tiltProps} className="gm-card gm-tilt grid gap-0 overflow-hidden p-0 md:grid-cols-[1.1fr_1fr]">
      {/* ------------------------------------------------------------- form */}
      <div className="p-5 sm:p-7">
        <div role="tablist" aria-label="Account options" className="mb-5 flex flex-wrap gap-1.5">
          {(props.modes ?? (Object.keys(MODE_LABELS) as Mode[])).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={props.mode === value}
              onClick={() => {
                props.onMode(value)
                props.onPassword('')
                props.onConfirm('')
              }}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                props.mode === value
                  ? 'gm-navkey-active font-medium text-accent'
                  : 'border border-transparent text-muted hover:text-ink'
              }`}
            >
              {MODE_LABELS[value]}
            </button>
          ))}
        </div>

        <form onSubmit={(event) => void props.onSubmit(event)} noValidate>
          <div className="space-y-3">
            <Field label="Email address" htmlFor="auth-email" hint="Used for sign-in links and nothing else.">
              <TextInput
                id="auth-email"
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                // `autoCapitalize="none"` stops iOS turning an address into a sentence.
                autoCapitalize="none"
                spellCheck={false}
                value={props.email}
                onChange={(event) => props.onEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </Field>

            {wantsPassword ? (
              <div>
                <Field
                  label={props.mode === 'sign-up' ? 'Choose a password' : 'Password'}
                  htmlFor="auth-password"
                  hint={props.mode === 'sign-up' ? 'At least 10 characters. A short phrase beats a scrambled word.' : undefined}
                  error={props.mode === 'sign-up' && props.password.length > 0 && !props.serverCheck.ok ? props.serverCheck.problems.join(' ') : undefined}
                >
                  <div className="relative">
                    <TextInput
                      id="auth-password"
                      type={props.showPassword ? 'text' : 'password'}
                      name="password"
                      autoComplete={props.mode === 'sign-up' ? 'new-password' : 'current-password'}
                      autoCapitalize="none"
                      spellCheck={false}
                      // A first-line guard against a paste accident (a file, an
                      // export dump). The real limit is the byte ceiling in
                      // auth.ts, which also covers multi-byte characters.
                      maxLength={512}
                      value={props.password}
                      onChange={(event) => props.onPassword(event.target.value)}
                      className="pr-16"
                      required
                    />
                    <button
                      type="button"
                      onClick={props.onToggleShow}
                      aria-pressed={props.showPassword}
                      aria-label={props.showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-1 top-1/2 flex min-h-9 min-w-9 -translate-y-1/2 items-center justify-center rounded-md px-2 text-xs text-muted hover:text-ink"
                    >
                      {props.showPassword ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>

                {props.mode === 'sign-up' ? (
                  <>
                    <Meter band={props.band} />
                    <Checklist password={props.password} check={props.serverCheck} />
                    <div className="mt-3">
                      <Field
                        label="Repeat password"
                        htmlFor="auth-confirm"
                        hint={props.confirm.length > 0 && !props.matches ? 'The two entries do not match yet.' : undefined}
                      >
                        <TextInput
                          id="auth-confirm"
                          type={props.showPassword ? 'text' : 'password'}
                          name="confirm-password"
                          autoComplete="new-password"
                          autoCapitalize="none"
                          spellCheck={false}
                          maxLength={512}
                          value={props.confirm}
                          onChange={(event) => props.onConfirm(event.target.value)}
                          invalid={props.confirm.length > 0 && !props.matches}
                          required
                        />
                      </Field>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={!props.canSubmit} icon={icon(props.mode)}>
              {props.busy ? 'Working…' : MODE_LABELS[props.mode]}
            </Button>
            <Link to="/dashboard" className="text-sm text-muted no-underline hover:text-ink">
              Not now — keep using it as a guest
            </Link>
          </div>
        </form>

        {props.result ? (
          <div className="mt-4">
            <Callout
              kind={props.result.ok ? 'success' : 'warning'}
              title={props.result.ok ? (props.result.needsEmailConfirmation ? 'Check your email' : 'Done') : 'That did not work'}
            >
              {props.result.message}
            </Callout>
          </div>
        ) : null}
      </div>

      {/* -------------------------------------------------------- explanation */}
      <ProtectionNotes />
    </div>
  )
}

/**
 * What the sign-in actually does, stated so it can be checked against the code.
 * Exported because it only renders when a backend is configured, and it deserves
 * a test of its own wording.
 */
export function ProtectionNotes(): ReactNode {
  return (
    <aside className="border-t border-[var(--gm-border)] p-5 sm:p-7 md:border-l md:border-t-0">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck aria-hidden="true" className="h-4 w-4 text-accent" />
        How this is protected
      </h2>
      <List
        items={[
          'Passwords are checked by the same code on both sides, so the rules you see are the rules enforced.',
          'Attempts are rate limited per address and per network before they reach the sign-in service.',
          'Your email is hashed before an attempt counter ever sees it. The guard cannot read your address.',
          'Failure messages do not reveal whether an address has an account here.',
          'Sessions can be revoked on every device at once, which is the button to use if you lose a device.',
        ]}
      />
      <p className="mt-3 text-xs text-muted">
        What this app will not do: store your password, put a password or token in a link, or ask for one over email. If you
        receive a message asking for your GraphMentor password, it is not from here.
      </p>
      <p className="mt-2 text-xs text-muted">
        The full mapping of threat to control to test is in <code>docs/security.md</code>, including the parts this app does
        not defend against.
      </p>
    </aside>
  )
}

function icon(mode: Mode): ReactNode {
  if (mode === 'magic-link') return <Mail className="h-4 w-4" />
  if (mode === 'reset') return <KeyRound className="h-4 w-4" />
  if (mode === 'sign-up') return <Sparkles className="h-4 w-4" />
  return <UserRound className="h-4 w-4" />
}

/** Strength is a hint, never a verdict — the checklist below is the rule. */
function Meter({ band }: { band: ReturnType<typeof strengthBand> }): ReactNode {
  const colours = ['var(--gm-border-strong)', 'var(--gm-danger)', 'var(--gm-warning)', 'var(--gm-accent)', 'var(--gm-success)']
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <div className="flex h-1.5 flex-1 gap-1" role="img" aria-label={`Password strength: ${band.label}`}>
          {[1, 2, 3, 4].map((step) => (
            <span
              key={step}
              className="h-full flex-1 rounded-full transition-colors"
              style={{ background: band.score >= step ? colours[band.score] : 'var(--gm-border)' }}
            />
          ))}
        </div>
        <span className="w-14 text-xs text-muted">{band.label}</span>
      </div>
      <p className="mt-1 text-xs text-muted">{band.hint}</p>
    </div>
  )
}

function Checklist({ password, check }: { password: string; check: ReturnType<typeof checkPassword> }): ReactNode {
  if (password.length === 0) return null
  const items = [
    { label: 'At least 10 characters', ok: password.length >= 10 },
    { label: 'At most 72 bytes (the hashing limit)', ok: check.problems.every((problem) => !problem.startsWith('Use at most')) },
    { label: 'Not a single repeated character or a keyboard run', ok: check.problems.every((problem) => !/repeated|sequence/i.test(problem)) },
    { label: 'Not on the common-password list', ok: check.problems.every((problem) => !/common password/i.test(problem)) },
  ]
  return (
    <ul className="mt-3 space-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2 text-xs">
          <span
            aria-hidden="true"
            className="grid h-4 w-4 place-items-center rounded-full text-[10px] font-bold"
            style={{
              background: item.ok ? 'var(--gm-success)' : 'var(--gm-border)',
              color: item.ok ? 'var(--gm-accent-contrast)' : 'var(--gm-text-muted)',
            }}
          >
            {item.ok ? '✓' : '•'}
          </span>
          <span className={item.ok ? 'text-muted' : 'text-ink'}>{item.label}</span>
          <span className="sr-only">{item.ok ? 'met' : 'not met yet'}</span>
        </li>
      ))}
      {/* Advice, not a gate. Composition rules are what produce "Password1!",
          so the checklist above states the only rules that are enforced and
          this line states what would help. */}
      {check.classes < 3 ? (
        <li className="flex items-start gap-2 text-xs text-muted">
          <span aria-hidden="true" className="gm-navkey mt-[2px] grid h-4 w-4 place-items-center rounded-full text-[10px]">
            i
          </span>
          <span>Optional: adding a capital, a digit or a symbol would make it harder to guess. Length matters more than any of them.</span>
        </li>
      ) : null}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Account sync for our own sign-in server: this device's bookmarks, skill
 * ratings and profile, copied to (or from) the account in the project
 * database. Both directions are explicit button presses with the counts
 * stated — nothing syncs silently, and download replaces this device's
 * copies only after a confirmation, because replace is the destructive
 * direction.
 */
function SyncPanel(): ReactNode {
  const bookmarks = useAppStore((state) => state.bookmarks)
  const ratings = useAppStore((state) => state.ratings)
  const profile = useAppStore((state) => state.profile)
  const ui = useAppStore((state) => state.ui)
  const replaceBookmarks = useAppStore((state) => state.replaceBookmarks)
  const replaceRatings = useAppStore((state) => state.replaceRatings)
  const progress = useAppStore((state) => state.progress)
  const replaceProgress = useAppStore((state) => state.replaceProgress)
  const setProfile = useAppStore((state) => state.setProfile)
  const setUi = useAppStore((state) => state.setUi)
  const pushToast = useAppStore((state) => state.pushToast)

  const [busy, setBusy] = useState(false)
  const [confirmDownload, setConfirmDownload] = useState(false)
  const [notice, setNotice] = useState<AuthResult | null>(null)
  const [accountCopy, setAccountCopy] = useState<SyncState | null | 'unknown'>(null)
  useEffect(() => {
    void getSyncState().then((state) => setAccountCopy(state ?? 'unknown'))
  }, [])
  const deviceTaskCount = Object.values(progress).reduce((sum, entry) => sum + Object.keys(entry.tasks).length, 0)
  const accountTaskCount =
    accountCopy !== null && accountCopy !== 'unknown'
      ? Object.values(accountCopy.progress).reduce((sum, entry) => sum + Object.keys(entry.tasks).length, 0)
      : 0

  const upload = (): void => {
    setBusy(true)
    void putSyncState({
      bookmarks: bookmarks.map((b) => ({ targetType: b.targetType, targetId: b.targetId, note: b.note, createdAt: b.createdAt })),
      ratings: ratings.map((r) => ({ skillId: r.skillId, state: r.state, ...(r.quizScore !== undefined ? { quizScore: r.quizScore } : {}) })),
      profile: {
        educationLevel: profile.educationLevel || null,
        branch: profile.branch || null,
        careerGoalId: profile.careerGoalId,
        interests: profile.interestIds,
        weeklyHours: profile.weeklyHours,
        preferredPace: profile.preferredPace,
        learningStyle: profile.learningStyle,
        goalNote: profile.goalNote || null,
        theme: ui.theme,
        reducedMotion: ui.reducedMotion,
      },
      progress,
    })
      .then((outcome) => {
        setNotice(outcome)
        if (outcome.ok) {
          pushToast({ kind: 'success', message: 'This device is synced to your account.' })
          void getSyncState().then((state) => setAccountCopy(state ?? 'unknown'))
        }
      })
      .finally(() => setBusy(false))
  }

  const download = (): void => {
    setBusy(true)
    void getSyncState()
      .then((server) => {
        if (!server) {
          setNotice({ ok: false, message: 'The account copy could not be read. Nothing on this device was changed.' })
          return
        }
        replaceBookmarks(
          server.bookmarks.map((b) => ({
            targetType: b.targetType as (typeof bookmarks)[number]['targetType'],
            targetId: b.targetId,
            note: b.note,
            createdAt: b.createdAt,
          })),
        )
        replaceProgress(server.progress)
        replaceRatings(
          server.ratings.map((r) => ({
            skillId: r.skillId,
            state: r.state as (typeof ratings)[number]['state'],
            ...(r.quizScore !== undefined ? { quizScore: r.quizScore } : {}),
            updatedAt: r.updatedAt ?? new Date().toISOString(),
          })),
        )
        if (server.profile) {
          setProfile({
            ...(server.profile.educationLevel ? { educationLevel: server.profile.educationLevel } : {}),
            ...(server.profile.branch ? { branch: server.profile.branch } : {}),
            ...(server.profile.careerGoalId ? { careerGoalId: server.profile.careerGoalId } : {}),
            ...(server.profile.interests.length > 0 ? { interestIds: server.profile.interests } : {}),
            ...(server.profile.weeklyHours ? { weeklyHours: server.profile.weeklyHours } : {}),
            ...(server.profile.preferredPace ? { preferredPace: server.profile.preferredPace as typeof profile.preferredPace } : {}),
            ...(server.profile.learningStyle ? { learningStyle: server.profile.learningStyle as typeof profile.learningStyle } : {}),
            ...(server.profile.goalNote ? { goalNote: server.profile.goalNote } : {}),
          })
          setUi({
            ...(server.profile.theme ? { theme: server.profile.theme as typeof ui.theme } : {}),
            ...(server.profile.reducedMotion !== null ? { reducedMotion: server.profile.reducedMotion } : {}),
          })
        }
        setConfirmDownload(false)
        setNotice({
          ok: true,
          message: `Downloaded ${server.bookmarks.length} bookmark(s), ${server.ratings.length} skill rating(s) and ${Object.values(server.progress).reduce((sum, entry) => sum + Object.keys(entry.tasks).length, 0)} task(s) from your account.`,
        })
        pushToast({ kind: 'success', message: 'Account copy applied to this device.' })
      })
      .finally(() => setBusy(false))
  }

  return (
    <Card className="mt-5">
      <SectionTitle hint="bookmarks, skill ratings, profile and roadmap task progress — in this project's own database">Sync this device with my account</SectionTitle>
      <p className="text-sm text-muted">
        This device currently holds {bookmarks.length} bookmark(s), {ratings.length} skill rating(s) and{' '}
        {deviceTaskCount} roadmap task(s). Upload replaces the account copy with this device's; download does the reverse.
        Nothing syncs silently — check the account copy below before you download over this device.
      </p>
      <p className="mt-2 text-sm text-muted" role="status">
        {accountCopy === null
          ? 'Reading your account copy…'
          : accountCopy === 'unknown'
            ? 'Your account copy could not be read just now. Nothing was changed.'
            : `Your account currently holds ${accountCopy.bookmarks.length} bookmark(s), ${accountCopy.ratings.length} skill rating(s) and ${accountTaskCount} roadmap task(s).`}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={upload}>
          Upload this device to my account
        </Button>
        {!confirmDownload ? (
          <Button variant="secondary" disabled={busy} onClick={() => setConfirmDownload(true)}>
            Download my account copy…
          </Button>
        ) : (
          <>
            <Button variant="danger" disabled={busy} onClick={download}>
              Replace this device's bookmarks and ratings
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmDownload(false)}>
              Keep this device's
            </Button>
          </>
        )}
      </div>
      {notice ? (
        <div className="mt-3">
          <Callout kind={notice.ok ? 'success' : 'warning'} title="Sync">
            {notice.message}
          </Callout>
        </div>
      ) : null}
    </Card>
  )
}

/** Signed-in view for accounts on the project's own database. */
function LocalSignedIn({
  user,
  onSignedOut,
  onDeleted,
}: {
  user: LocalUser
  onSignedOut: () => void
  onDeleted: () => void
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [deletePassword, setDeletePassword] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<AuthResult | null>(null)
  const pushToast = useAppStore((state) => state.pushToast)

  return (
    <>
    <Grid cols={2}>
      <Card>
        <SectionTitle hint="accounts live in this project's own database">Signed in</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Email" value={user.email} />
          <Stat label="Account created" value={formatDate(user.createdAt)} />
          <Stat label="Session" value="30 days" hint="An HttpOnly cookie; signing out deletes it on the server too" />
          <Stat label="Stored password" value="scrypt hash" hint="The password itself is never stored anywhere" />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            icon={<LogOut className="h-4 w-4" />}
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void localSignOut()
                .then((outcome) => {
                  if (!outcome.ok) { setNotice(outcome); return }
                  pushToast({ kind: 'info', message: 'Signed out. The session is deleted on the server.' })
                  onSignedOut()
                })
                .finally(() => setBusy(false))
            }}
          >
            Sign out
          </Button>
          <LinkButton to="/settings" variant="ghost">
            Export or erase device data
          </LinkButton>
        </div>

        <p className="mt-3 text-xs text-muted">
          Your roadmap and progress on this device stay as they are; the account adds a server copy of your identity,
          not a lock on the app. Changing your password below signs every other device out.
        </p>

        {notice ? (
          <div className="mt-3">
            <Callout kind={notice.ok ? 'success' : 'warning'} title="Account">
              {notice.message}
            </Callout>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle hint="the current password is required for both">Password and account</SectionTitle>
        <div className="space-y-3">
          <Field label="Current password" htmlFor="local-current-password">
            <TextInput
              id="local-current-password"
              type="password"
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={512}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label="New password" htmlFor="local-new-password" hint="At least 10 characters; the sign-up checklist applies.">
            <TextInput
              id="local-new-password"
              type="password"
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={512}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            disabled={busy || currentPassword.length === 0 || !checkPassword(newPassword).ok}
            onClick={() => {
              setBusy(true)
              void localChangePassword(currentPassword, newPassword)
                .then((outcome) => {
                  setNotice(outcome)
                  if (outcome.ok) {
                    setCurrentPassword('')
                    setNewPassword('')
                    pushToast({ kind: 'success', message: outcome.message })
                  }
                })
                .finally(() => setBusy(false))
            }}
          >
            Change password
          </Button>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <SectionTitle hint="permanent — the identity, credentials and sessions are deleted">Delete account</SectionTitle>
          {!confirmDelete ? (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete my account…
            </Button>
          ) : (
            <div className="space-y-3">
              <Field label="Confirm with your password" htmlFor="local-delete-password">
                <TextInput
                  id="local-delete-password"
                  type="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={512}
                  value={deletePassword}
                  onChange={(event) => setDeletePassword(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  disabled={busy || deletePassword.length === 0}
                  onClick={() => {
                    setBusy(true)
                    void localDeleteAccount(deletePassword)
                      .then((outcome) => {
                        setNotice(outcome)
                        if (outcome.ok) {
                          pushToast({ kind: 'warning', message: 'Account deleted.' })
                          onDeleted()
                        }
                      })
                      .finally(() => setBusy(false))
                  }}
                >
                  Permanently delete
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Keep my account
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </Grid>
    <SyncPanel />
    </>
  )
}

function SignedIn({ session }: { session: Session }): ReactNode {
  const facts = describeSession(session)
  const [busy, setBusy] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [notice, setNotice] = useState<AuthResult | null>(null)
  const pushToast = useAppStore((state) => state.pushToast)

  return (
    <Grid cols={2}>
      <Card>
        <SectionTitle hint="the only account data this app holds">Signed in</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Email" value={facts.email ?? 'unknown'} />
          <Stat label="Provider" value={facts.provider ?? 'email'} />
          <Stat
            label="Session expires"
            value={facts.expiresInSeconds !== null ? `${Math.max(0, Math.round(facts.expiresInSeconds / 60))} min` : 'unknown'}
            hint={facts.expiresAt ? formatDate(facts.expiresAt) : undefined}
          />
          <Stat label="Refresh" value="automatic" hint="The token is renewed while the tab is open" />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            icon={<LogOut className="h-4 w-4" />}
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void signOut()
                .then(() => pushToast({ kind: 'info', message: 'Signed out on this device.' }))
                .finally(() => setBusy(false))
            }}
          >
            Sign out
          </Button>
          <Button
            variant="danger"
            icon={<ShieldCheck className="h-4 w-4" />}
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void signOutEverywhere()
                .then((outcome) => {
                  setNotice(outcome)
                  pushToast({ kind: outcome.ok ? 'warning' : 'error', message: outcome.message })
                })
                .finally(() => setBusy(false))
            }}
          >
            Sign out everywhere
          </Button>
          <LinkButton to="/settings" variant="ghost">
            Export or delete data
          </LinkButton>
        </div>

        <p className="mt-3 text-xs text-muted">
          &ldquo;Sign out everywhere&rdquo; revokes every refresh token for this account, so a lost laptop cannot come back.
          Your roadmap and progress stay on the server until you delete them in Settings.
        </p>

        {notice ? (
          <div className="mt-3">
            <Callout kind={notice.ok ? 'success' : 'warning'} title="Session">
              {notice.message}
            </Callout>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle hint="changing it does not sign other devices out">Change password</SectionTitle>
        <Field label="New password" htmlFor="auth-new-password" hint="At least 10 characters; the checklist from sign-up applies.">
          <TextInput
            id="auth-new-password"
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={512}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Field>
        <div className="mt-2">
          <Meter band={strengthBand(newPassword)} />
        </div>
        <div className="mt-3">
          <Button
            variant="primary"
            disabled={busy || !checkPassword(newPassword).ok}
            onClick={() => {
              setBusy(true)
              void updatePassword(newPassword)
                .then((outcome) => {
                  setNotice(outcome)
                  if (outcome.ok) setNewPassword('')
                })
                .finally(() => setBusy(false))
            }}
          >
            Update password
          </Button>
        </div>

        <div className="mt-4">
          <Callout kind="info" title="About the session token in your browser">
            The sign-in library keeps a short-lived access token (and its refresh token) in this browser’s local storage under
            the key <code>gm.auth</code>. It is a credential: signing out clears it, and &ldquo;sign out everywhere&rdquo;
            invalidates it even if a copy was taken. <code>docs/security.md</code> says exactly what is stored where.
          </Callout>
        </div>
      </Card>
    </Grid>
  )
}

/** Exported for the router: `/login`, `/account` and the reset landing all use it. */
export function ResetLanding(): ReactNode {
  const [session, setSession] = useState<Session | null>(null)
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState<AuthResult | null>(null)
  useEffect(() => onAuthChange(setSession), [])
  const check = checkPassword(password)

  if (!session) {
    return (
      <div className="mx-auto max-w-xl">
        <Card>
          <SectionTitle hint="one use, short expiry">This reset link is no longer valid</SectionTitle>
          <p className="text-sm text-muted">
            Reset links expire quickly and can only be used once. Request a new one from the sign-in screen, or sign in with an
            email link instead.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <LinkButton to="/login" variant="primary">
              Back to sign in
            </LinkButton>
          </div>
          <p className="mt-3 inline-flex items-center gap-1 text-xs text-muted">
            <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
            If you did not request this, nothing has changed on your account.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <SectionTitle hint="you followed a single-use link">Set a new password</SectionTitle>
        <Field label="New password" htmlFor="reset-password">
          <TextInput
            id="reset-password"
            type="password"
            autoComplete="new-password"
            maxLength={512}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <div className="mt-2">
          <Meter band={strengthBand(password)} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="primary"
            disabled={!check.ok}
            onClick={() =>
              void updatePassword(password).then((outcome) => {
                setNotice(outcome)
                if (outcome.ok) setPassword('')
              })
            }
          >
            Save new password
          </Button>
          <Chip tone="accent">Single use</Chip>
        </div>
        {notice ? (
          <div className="mt-3">
            <Callout kind={notice.ok ? 'success' : 'warning'} title={notice.ok ? 'Saved' : 'Not saved'}>
              {notice.message}
            </Callout>
          </div>
        ) : null}
      </Card>
    </div>
  )
}


