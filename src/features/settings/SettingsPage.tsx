/**
 * Settings: accessibility, profile, account, data rights and diagnostics.
 *
 * The data-rights section is deliberately blunt about what is stored where, and
 * gives working erase controls for both copies (device and account).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Download, Flag, LogOut, Mail, ShieldCheck, Trash2, UserRound } from 'lucide-react'

import {
  Button,
  Callout,
  Card,
  Checkbox,
  Chip,
  Field,
  Grid,
  LinkButton,
  List,
  PageHeader,
  SectionTitle,
  Select,
  Stat,
  TextArea,
  TextInput,
} from '@/components/ui.tsx'
import type { Difficulty } from '@core/types.ts'
import { config, hasBackend } from '@/core/env.ts'
import { resetWebGLCache } from '@/components/three/webgl.ts'
import { api, refreshHealth, sourceStatus, subscribeSession, type SessionState } from '@/core/session.ts'
import { ApiError } from '@/core/api.ts'
import { probeAccounts, type AccountsProbe } from '@/core/authApi.ts'
import { sendMagicLink, signOut, signOutEverywhere } from '@/core/auth.ts'
import { formatDate, formatNumber } from '@/core/format.ts'
import { saveLocalRoadmaps } from '@/core/persistence.ts'
import { useAppStore } from '@/state/store.ts'

/* ==========================================================================
 * Small helpers for the data-rights controls
 * ========================================================================== */

/**
 * Turns a definition into a file the user owns.
 *
 * `URL.revokeObjectURL` matters here: without it the blob stays alive for the
 * lifetime of the document, which for a data export means a copy of the user's
 * data sitting in memory that nothing can release.
 */
function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload ?? {}, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * A message a person can act on, without a stack trace.
 *
 * `ApiError` messages are written for users and already redacted server-side;
 * anything else is described generically, because an unexpected error string can
 * contain a URL, a token fragment or an internal path.
 */
function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'unauthorized') return 'Your session expired. Sign in again and retry.'
    if (error.code === 'rate_limited') {
      return `Too many requests just now. Try again in ${error.retryAfterSeconds ?? 60} seconds.`
    }
    if (error.code === 'not_configured') return error.message
    return error.message
  }
  if (error instanceof TypeError) return 'Could not reach the server. Check your connection and retry.'
  return 'The request failed. Nothing was changed.'
}

/**
 * After account data is deleted, the local links that map this device's saved
 * plans to server row ids point at rows that no longer exist. Clearing them
 * stops the app from trying to sync into the void. Device-only data is left
 * alone: erasing that is a separate, explicit action in the same card.
 */
function clearLocalAccountMirror(): void {
  saveLocalRoadmaps([])
}

export function SettingsPage(): ReactNode {
  const profile = useAppStore((state) => state.profile)
  const setProfile = useAppStore((state) => state.setProfile)
  const ui = useAppStore((state) => state.ui)
  const setUi = useAppStore((state) => state.setUi)
  const ratings = useAppStore((state) => state.ratings)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const progress = useAppStore((state) => state.progress)
  const exportLocalData = useAppStore((state) => state.exportLocalData)
  const eraseLocalData = useAppStore((state) => state.eraseLocalData)
  const setSession = useAppStore((state) => state.setSession)
  const session = useAppStore((state) => state.session)
  const pushToast = useAppStore((state) => state.pushToast)
  const storageOk = useAppStore((state) => state.storageOk)

  const [accounts, setAccounts] = useState<AccountsProbe | null>(null)
  useEffect(() => {
    if (hasBackend) return
    let active = true
    void probeAccounts().then((result) => { if (active) setAccounts(result) })
    return () => { active = false }
  }, [])

  const [email, setEmail] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [eraseConfirm, setEraseConfirm] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [sessionInfo, setSessionInfo] = useState<SessionState | null>(null)
  const [feedbackKind, setFeedbackKind] = useState<'bug' | 'content' | 'resource-link' | 'accessibility' | 'other'>('bug')
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [feedbackContact, setFeedbackContact] = useState('')
  const [sendingFeedback, setSendingFeedback] = useState(false)

  useEffect(() => subscribeSession(setSessionInfo), [])

  const downloadLocal = (): void => {
    const blob = new Blob([JSON.stringify(exportLocalData(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `graphmentor-local-data-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <PageHeader
        eyebrow="Settings"
        title="Accessibility, account and your data"
        description="Nothing here is required to use the app. Every control works offline and takes effect immediately."
      />

      <div className="space-y-5">
        <Card>
          <SectionTitle hint="applies to the whole app">Appearance and motion</SectionTitle>
          <Grid cols={3}>
            <Field label="Theme" htmlFor="theme" hint="System follows your operating system setting.">
              <Select id="theme" value={ui.theme} onChange={(event) => setUi({ theme: event.target.value as typeof ui.theme })}>
                <option value="system">Follow system</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <p className="gm-label">Motion and graph behaviour</p>
              <Checkbox
                id="reduced-motion"
                checked={ui.reducedMotion}
                onChange={(value) => setUi({ reducedMotion: value })}
                label="Reduce motion"
                hint="Removes graph layout animation and transition effects. Also respected when your operating system asks for it."
              />
              <Checkbox
                id="graph-animations"
                checked={ui.graphAnimations}
                onChange={(value) => setUi({ graphAnimations: value })}
                label="Animate graph layouts"
                hint="Turn off on low-powered devices; the layout is identical, it just appears at once."
              />
              <Checkbox
                id="graph-labels"
                checked={ui.graphLabels}
                onChange={(value) => setUi({ graphLabels: value })}
                label="Show inline hints"
                hint="Small explanatory notes next to controls and ratings."
              />
              <Checkbox
                id="force-3d"
                checked={ui.force3d}
                onChange={(value) => {
                  // Drop the cached probe so the preference takes effect at once
                  // rather than after a reload.
                  resetWebGLCache()
                  setUi({ force3d: value })
                }}
                label="Try the 3D views on this device anyway"
                hint="The app skips 3D when the browser reports a slow or software-only GPU. That check is a guess about your hardware — this overrides it. If the scenes stutter, turn it back off; the 2D canvas and the list view are identical in content."
              />
            </div>
          </Grid>
          <p className="mt-2 text-xs text-muted">
            Contrast, focus outlines and minimum tap sizes come from the shared stylesheet and cannot be switched off — they are
            accessibility requirements, not preferences.
          </p>
        </Card>

        <Card>
          <SectionTitle hint="used to size plans and rank skills">Study profile</SectionTitle>
          <Grid cols={2}>
            <Field label="Study stage" htmlFor="settings-stage">
              <Select id="settings-stage" value={profile.educationLevel} onChange={(event) => setProfile({ educationLevel: event.target.value })}>
                <option value="">Prefer not to say</option>
                <option value="school">In school</option>
                <option value="diploma">Diploma or polytechnic</option>
                <option value="undergraduate">Undergraduate degree</option>
                <option value="postgraduate">Postgraduate degree</option>
                <option value="self-taught">Self-taught or career changer</option>
                <option value="other">Something else</option>
              </Select>
            </Field>
            <Field label="Branch or specialisation" htmlFor="settings-branch">
              <TextInput
                id="settings-branch"
                value={profile.branch}
                maxLength={80}
                onChange={(event) => setProfile({ branch: event.target.value.slice(0, 80) })}
              />
            </Field>
            <Field label="Hours per week" htmlFor="settings-hours" hint="Used by the roadmap scheduler.">
              <Select id="settings-hours" value={profile.weeklyHours} onChange={(event) => setProfile({ weeklyHours: Number(event.target.value) })}>
                {[3, 5, 8, 10, 15, 20, 30, 40].map((hours) => (
                  <option key={hours} value={hours}>
                    {hours} h
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Starting comfort level" htmlFor="settings-difficulty">
              <Select
                id="settings-difficulty"
                value={profile.difficultyComfort}
                onChange={(event) => setProfile({ difficultyComfort: event.target.value as Difficulty })}
              >
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </Select>
            </Field>
            <Field label="Preferred pace" htmlFor="settings-pace">
              <Select
                id="settings-pace"
                value={profile.preferredPace}
                onChange={(event) => setProfile({ preferredPace: event.target.value as typeof profile.preferredPace })}
              >
                <option value="relaxed">Relaxed</option>
                <option value="steady">Steady</option>
                <option value="intensive">Intensive</option>
              </Select>
            </Field>
            <Field label="Learning style" htmlFor="settings-style">
              <Select
                id="settings-style"
                value={profile.learningStyle}
                onChange={(event) => setProfile({ learningStyle: event.target.value as typeof profile.learningStyle })}
              >
                <option value="mixed">A mix</option>
                <option value="video">Video-first</option>
                <option value="reading">Reading and documentation</option>
                <option value="hands-on">Hands-on building</option>
              </Select>
            </Field>
          </Grid>
          <Field label="Goal note" htmlFor="settings-note" hint="Up to 200 characters, shown on the dashboard.">
            <TextArea
              id="settings-note"
              rows={2}
              value={profile.goalNote}
              maxLength={200}
              onChange={(event) => setProfile({ goalNote: event.target.value.slice(0, 200) })}
            />
          </Field>
        </Card>

        <Card>
          <SectionTitle hint={hasBackend || accounts?.available ? 'database-backed accounts — guest mode is still available' : 'account connection'}>
            Account
          </SectionTitle>
          {!hasBackend ? (
            accounts === null ? (
              <p role="status" className="text-sm text-muted">Checking the account database…</p>
            ) : accounts.available ? (
              <div className="space-y-3">
                <Callout kind="success" title="Account database connected">
                  {accounts.user
                    ? `Signed in as ${accounts.user.email}. Your account uses this website’s database.`
                    : 'This website has its own PostgreSQL database. Create an account or sign in to save your data beyond this browser.'}
                  {' '}Use Account to upload or download your bookmarks, skill ratings, profile and roadmap task progress.
                  Device data stays separate until you choose to sync it.
                </Callout>
                <LinkButton to={accounts.user ? '/account' : '/login'} variant="primary">
                  {accounts.user ? 'Account and database sync' : 'Sign in or create account'}
                </LinkButton>
              </div>
            ) : (
              <Callout kind="warning" title="Account database unreachable">
                The account service could not be reached. Your device data is safe and guest mode still works.
                Start the database-backed website with npm run dev, or npm start for a production build.
                Static-only hosting needs a separately hosted backend.
                <div className="mt-3">
                  <Button variant="secondary" onClick={() => { setAccounts(null); void probeAccounts().then(setAccounts) }}>Retry connection</Button>
                </div>
              </Callout>
            )
          ) : session ? (
            <div className="space-y-3">
              <p className="text-sm">
                Signed in{session.user?.email ? ` as ${session.user.email}` : ''}. Your roadmaps, ratings and bookmarks can be stored
                in your account and used on other devices.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  icon={<LogOut className="h-4 w-4" />}
                  onClick={async () => {
                    await signOut()
                    setSession(null)
                    pushToast({ kind: 'info', message: 'Signed out.', detail: 'Local data on this device is untouched.' })
                  }}
                >
                  Sign out
                </Button>
                <Button
                  variant="secondary"
                  icon={<ShieldCheck className="h-4 w-4" />}
                  onClick={async () => {
                    const result = await signOutEverywhere()
                    pushToast({ kind: result.ok ? 'warning' : 'error', message: result.message })
                  }}
                >
                  Sign out everywhere
                </Button>
                <LinkButton to="/account" variant="ghost">
                  <UserRound className="mr-1 inline h-4 w-4" aria-hidden="true" /> Account and password
                </LinkButton>
                <LinkButton to="/progress" variant="ghost">
                  Review my data
                </LinkButton>
              </div>
            </div>
          ) : (
            <div className="max-w-md">
              <Field
                label="Email for a sign-in link"
                htmlFor="settings-email"
                hint="A one-time link is emailed to you. No password is created or stored by this app."
              >
                <TextInput
                  id="settings-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  icon={<Mail className="h-4 w-4" />}
                  loading={signingIn}
                  onClick={async () => {
                    setSigningIn(true)
                    try {
                      const result = await sendMagicLink(email.trim())
                      pushToast({ kind: result.ok ? 'success' : 'error', message: result.ok ? 'Check your inbox.' : 'Could not send the link.', detail: result.message })
                    } finally {
                      setSigningIn(false)
                    }
                  }}
                  disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())}
                >
                  Send sign-in link
                </Button>
                <LinkButton to="/login" variant="secondary">
                  Password or create account
                </LinkButton>
              </div>
              <p className="mt-2 text-xs text-muted">
                Signing in is never required. Guest data stays on this device; signing in does not silently upload it. Attempts
                are rate limited per address and per network, and the email is hashed before any counter sees it.
              </p>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle hint="both copies, clearly separated">Your data</SectionTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Skills rated" value={formatNumber(ratings.length)} />
            <Stat label="Bookmarks" value={formatNumber(bookmarks.length)} />
            <Stat label="Plans tracked" value={formatNumber(Object.keys(progress).length)} />
            <Stat label="Local storage" value={storageOk ? 'available' : 'blocked'} hint={storageOk ? 'Preferences persist' : 'Data is in memory only'} />
          </div>

          <div className="mt-4">
            <h3 className="text-sm font-semibold">On this device</h3>
            <List
              items={[
                'Onboarding answers, self-reported skill levels, roadmap task statuses, logged hours, bookmarks and display preferences.',
                'No tokens, no chat transcripts and no passwords are stored here.',
                'This data is readable by anyone who can inspect this browser profile. On a shared computer, erase it when you finish.',
              ]}
            />
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={downloadLocal}>
                Export device data (JSON)
              </Button>
              <div className="min-w-[220px]">
                <Field label="Type ERASE to confirm" htmlFor="erase-local">
                  <TextInput id="erase-local" value={eraseConfirm} onChange={(event) => setEraseConfirm(event.target.value)} placeholder="ERASE" />
                </Field>
              </div>
              <Button
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                disabled={eraseConfirm.trim().toUpperCase() !== 'ERASE'}
                onClick={() => {
                  const removed = eraseLocalData()
                  setEraseConfirm('')
                  pushToast({
                    kind: 'warning',
                    message: `Local data erased (${removed.length} key${removed.length === 1 ? '' : 's'}).`,
                    detail: 'The app is back to a first-run state on this device.',
                  })
                }}
              >
                Erase device data
              </Button>
            </div>
          </div>

          {session ? (
            <div className="mt-5">
              <h3 className="text-sm font-semibold">In your account</h3>
              <List
                items={[
                  'Also stored: the same preferences plus saved roadmaps and their task rows, so you can continue on another device.',
                  'Not stored: the mentor conversation, your email contents, any credential used by this app.',
                  'Access is limited to your own rows by row-level security policies in the database, and every API call is scoped to the verified account id.',
                ]}
              />
              <div className="mt-2 flex flex-wrap gap-3">
                <Button
                  variant="secondary"
                  icon={<ShieldCheck className="h-4 w-4" />}
                  onClick={async () => {
                    try {
                      const result = await api().manageAccount({ action: 'export' })
                      downloadJson(`graphmentor-account-${new Date().toISOString().slice(0, 10)}.json`, result.data)
                      pushToast({ kind: 'success', message: 'Account data exported.', detail: result.data.detail })
                    } catch (error) {
                      pushToast({
                        kind: 'error',
                        message: 'Could not export account data.',
                        detail: describeApiError(error),
                      })
                    }
                  }}
                >
                  Export account data
                </Button>
                <div className="min-w-[220px]">
                  <Field label="Type DELETE to confirm" htmlFor="delete-account-data">
                    <TextInput id="delete-account-data" value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder="DELETE" />
                  </Field>
                </div>
                <Button
                  variant="danger"
                  icon={<Trash2 className="h-4 w-4" />}
                  disabled={deleteConfirm.trim().toUpperCase() !== 'DELETE'}
                  onClick={async () => {
                    try {
                      const result = await api().manageAccount({ action: 'delete-account-data', confirm: 'DELETE' })
                      setDeleteConfirm('')
                      clearLocalAccountMirror()
                      pushToast({
                        kind: 'warning',
                        message: 'Account data deleted.',
                        detail: `${result.data.detail} The stale link between this device’s saved plans and the deleted rows was cleared; device-only copies stay until you erase them below.`,
                      })
                    } catch (error) {
                      pushToast({ kind: 'error', message: 'Could not delete account data.', detail: describeApiError(error) })
                    }
                  }}
                >
                  Delete account data
                </Button>
              </div>
            </div>
          ) : null}
        </Card>

        <Card>
          <SectionTitle hint="for bug reports and support">Diagnostics</SectionTitle>
          <Grid cols={2}>
            <div>
              <p className="gm-label">Build</p>
              <ul className="space-y-1 text-sm">
                <li>Version: {config.appVersion}</li>
                <li>Data source: {sessionInfo?.mode === 'live' ? 'live backend' : 'bundled sample dataset in this browser'}</li>
                <li>
                  Graph: {sessionInfo?.health?.graph ?? 'checking'}
                  {sessionInfo?.health?.graphDetail ? ` — ${sessionInfo.health.graphDetail}` : ''}
                </li>
                <li>AI provider: {sessionInfo?.health?.aiConfigured ? sessionInfo.health.aiProvider : 'none (rules engine)'}</li>
                <li>Request signing required: {sessionInfo?.health?.requestSigningRequired ? 'yes' : 'no'}</li>
                <li>Backend configured: {hasBackend ? 'yes' : 'no'}</li>
                <li>Accounts: {hasBackend ? (session ? 'signed in' : 'available, not signed in') : 'not configured'}</li>
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const health = await refreshHealth()
                    pushToast({
                      kind: health ? 'info' : 'error',
                      message: health ? `Graph status: ${health.graph}` : 'Health check failed.',
                      detail: health ? health.graphDetail : 'The backend did not answer.',
                    })
                  }}
                >
                  Re-check status
                </Button>
                <LinkButton to="/about" variant="ghost">
                  Features and limitations
                </LinkButton>
                <LinkButton to="/privacy" variant="ghost">
                  Privacy and terms
                </LinkButton>
              </div>
            </div>
            <div>
              <p className="gm-label">Data provenance</p>
              <p className="text-sm text-muted">
                {sessionInfo ? `${sourceStatus(sessionInfo)} — ${sessionInfo.verifiedSource === 'neo4j-live'
                  ? 'confirmed by the most recent successful API data response.'
                  : sessionInfo.verifiedSource === 'postgres-live'
                    ? 'confirmed by the most recent successful API data response.'
                    : sessionInfo.health?.graphDetail ?? sessionInfo.fallbackReason ?? 'No graph-data response has confirmed its source.'}`
                  : 'Checking which data source is currently serving graph data.'}
              </p>
              <p className="mt-2 text-xs text-muted">
                Last health check: {formatDate(sessionInfo?.health ? new Date().toISOString() : null)}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone="accent">No telemetry</Chip>
                <Chip>No third-party analytics</Chip>
                <Chip>No affiliate links</Chip>
              </div>
            </div>
          </Grid>
        </Card>

        <Card>
          <SectionTitle hint="goes to the maintainers, never to a marketing list">Report a problem or suggest a fix</SectionTitle>
          <p className="text-sm text-muted">
            Broken resource link, a mistake in the curriculum, something unusable on your device, or an accessibility barrier — describe
            what you saw and what you expected. Please do not include passwords or personal data.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="What kind of report is this?" htmlFor="feedback-kind">
              <Select
                id="feedback-kind"
                value={feedbackKind}
                onChange={(event) => setFeedbackKind(event.target.value as typeof feedbackKind)}
              >
                <option value="bug">Something is broken</option>
                <option value="content">The curriculum is wrong or unclear</option>
                <option value="resource-link">A resource link is dead or wrong</option>
                <option value="accessibility">An accessibility barrier</option>
                <option value="other">Something else</option>
              </Select>
            </Field>
            <Field label="Contact email (optional)" htmlFor="feedback-contact" hint="Only used to answer you.">
              <TextInput
                id="feedback-contact"
                type="email"
                value={feedbackContact}
                onChange={(event) => setFeedbackContact(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="What happened?" htmlFor="feedback-message" hint={`${feedbackMessage.length}/1500 characters`}>
              <TextArea
                id="feedback-message"
                rows={4}
                value={feedbackMessage}
                onChange={(event) => setFeedbackMessage(event.target.value)}
                placeholder="On the graph page, opening the embedded systems career showed…"
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              icon={<Flag className="h-4 w-4" />}
              disabled={feedbackMessage.trim().length < 10 || sendingFeedback}
              onClick={() => {
                const run = async (): Promise<void> => {
                  setSendingFeedback(true)
                  try {
                    const contact = feedbackContact.trim()
                    const result = await api().submitFeedback({
                      kind: feedbackKind,
                      message: feedbackMessage.trim(),
                      ...(contact ? { contact } : {}),
                      ...(typeof window !== 'undefined' ? { pageUrl: window.location.pathname.slice(0, 300) } : {}),
                    })
                    setFeedbackMessage('')
                    setFeedbackContact('')
                    pushToast({ kind: 'success', message: 'Report received.', detail: result.data.note })
                  } catch (error) {
                    pushToast({
                      kind: 'warning',
                      message: 'Could not send that report.',
                      detail: error instanceof Error ? error.message : 'The request failed.',
                    })
                  } finally {
                    setSendingFeedback(false)
                  }
                }
                void run()
              }}
            >
              {sendingFeedback ? 'Sending…' : 'Send report'}
            </Button>
            <span className="text-xs text-muted">
              Reports are rate limited. In the browser demo there is no backend, so the report stays on this device and appears in your
              export instead of being sent to anyone.
            </span>
          </div>
        </Card>
      </div>
    </div>
  )
}


