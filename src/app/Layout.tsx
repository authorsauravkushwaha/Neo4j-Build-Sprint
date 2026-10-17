/**
 * Application shell: skip link, header, navigation, data-source banner, footer.
 *
 * Navigation requirements that shaped this file:
 *   - it works with a keyboard alone (skip link, real links, visible focus),
 *   - the mobile layout uses a scrollable bottom bar with 44px targets rather
 *     than a hamburger that hides the whole app behind one control,
 *   - every screen states which data source it is showing, right under the header,
 *     so sample data is never mistaken for live graph data.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  BookMarked,
  Compass,
  FolderKanban,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  ListTree,
  MessageSquare,
  Plug,
  Route as RouteIcon,
  Settings as SettingsIcon,
  Sparkles,
  Target,
  UserRound,
  Workflow,
} from 'lucide-react'

import { Toasts } from '@/components/ui.tsx'
import { subscribeSession, refreshHealth, type SessionState } from '@/core/session.ts'
import { onAuthChange } from '@/core/supabase.ts'
import { config } from '@/core/env.ts'
import { useAppStore } from '@/state/store.ts'
import { CommandPalette, PaletteTrigger } from '@/components/CommandPalette.tsx'
import { AppScrollRail, BackToTop } from '@/skiper/components/ScrollChrome.tsx'
import { PageTransition } from '@/skiper/components/PageTransition.tsx'
import { useScrollFlag } from '@/skiper/motion/useScrollFlag.ts'

interface NavItem {
  to: string
  label: string
  short: string
  icon: ReactNode
  /** Shown in the desktop sidebar only; keeps the mobile bar to six entries. */
  primary?: boolean
}

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', short: 'Home', icon: <LayoutDashboard aria-hidden="true" className="h-4 w-4" />, primary: true },
  { to: '/careers', label: 'Career explorer', short: 'Careers', icon: <Compass aria-hidden="true" className="h-4 w-4" />, primary: true },
  { to: '/skills', label: 'Skill index', short: 'Skills', icon: <ListTree aria-hidden="true" className="h-4 w-4" /> },
  { to: '/graph', label: 'Knowledge graph', short: 'Graph', icon: <GitBranch aria-hidden="true" className="h-4 w-4" />, primary: true },
  { to: '/roadmap', label: 'My roadmap', short: 'Roadmap', icon: <RouteIcon aria-hidden="true" className="h-4 w-4" />, primary: true },
  { to: '/mentor', label: 'AI mentor', short: 'Mentor', icon: <MessageSquare aria-hidden="true" className="h-4 w-4" />, primary: true },
  { to: '/progress', label: 'Progress', short: 'Progress', icon: <ListChecks aria-hidden="true" className="h-4 w-4" />, primary: true },
  { to: '/pathway', label: 'Career pathway builder', short: 'Pathway', icon: <Target aria-hidden="true" className="h-4 w-4" /> },
  { to: '/gaps', label: 'Skill-gap analyzer', short: 'Gaps', icon: <Sparkles aria-hidden="true" className="h-4 w-4" /> },
  { to: '/projects', label: 'Project recommender', short: 'Projects', icon: <FolderKanban aria-hidden="true" className="h-4 w-4" /> },
  { to: '/resources', label: 'Free resource library', short: 'Resources', icon: <BookMarked aria-hidden="true" className="h-4 w-4" /> },
  { to: '/workflows', label: 'Workflows and integrations', short: 'Workflows', icon: <Workflow aria-hidden="true" className="h-4 w-4" /> },
  { to: '/public-apis', label: 'Public APIs to practise on', short: 'APIs', icon: <Plug aria-hidden="true" className="h-4 w-4" /> },
  { to: '/settings', label: 'Settings and accessibility', short: 'Settings', icon: <SettingsIcon aria-hidden="true" className="h-4 w-4" /> },
]

/** Offline state, stated where the person can see it. The app is installed as a
 * PWA and keeps working without a network; this banner exists so a learner on a
 * train is told that plainly instead of wondering why a link is slow. It says
 * nothing the browser does not already know — it just does not hide it. */
function OfflineBanner(): ReactNode {
  const [offline, setOffline] = useState<boolean>(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  useEffect(() => {
    const update = (): void => setOffline(navigator.onLine === false)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  if (!offline) return null
  return (
    <div role="status" className="gm-no-print border-b border-line bg-[var(--gm-warning-soft)] px-3 py-2 text-center text-xs text-ink">
      You are offline. Everything in this app — careers, skills, your roadmap and progress — keeps working; only opening
      external resource links needs a connection.
    </div>
  )
}

/**
 * Header identity chip.
 *
 * Signed out it is a single "Sign in" link — the app is fully usable without an
 * account, so this must never look like a locked door. Signed in it shows the
 * account address and links to the account screen. It reads the session from
 * `onAuthChange`, so a token refresh or a sign-out in another tab updates it
 * immediately rather than leaving a stale email on screen.
 */
function AccountChip(): ReactNode {
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => onAuthChange((session) => setEmail(session?.user.email ?? null)), [])

  if (!email) {
    return (
      <NavLink
        to="/login"
        className="gm-navkey flex min-h-9 items-center gap-1.5 whitespace-nowrap px-2.5 text-sm no-underline hover:text-accent"
      >
        <UserRound aria-hidden="true" className="h-4 w-4" />
        <span className="hidden sm:inline">Sign in</span>
        <span className="sr-only sm:hidden">Sign in</span>
      </NavLink>
    )
  }

  return (
    <NavLink
      to="/login"
      className="gm-navkey flex min-h-9 max-w-[11rem] items-center gap-1.5 whitespace-nowrap px-2.5 text-sm no-underline hover:text-accent"
      title={email}
    >
      <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--gm-accent)] text-[10px] font-bold text-[var(--gm-accent-contrast)]">
        {email.slice(0, 1).toUpperCase()}
      </span>
      <span className="truncate">
        <span className="sr-only">Signed in as </span>
        {email}
      </span>
    </NavLink>
  )
}

function DataSourceBanner(): ReactNode {
  const [session, setSession] = useState<SessionState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => subscribeSession(setSession), [])

  if (!session?.ready) {
    return (
      <p role="status" className="border-b border-line bg-[var(--gm-surface-2)] px-3 py-1.5 text-center text-xs text-muted">
        Checking which data source is available…
      </p>
    )
  }

  if (session.mode === 'live' && !session.graphWarning && !session.fallbackReason) {
    return (
      <p className="border-b border-line bg-[var(--gm-surface-2)] px-3 py-1.5 text-center text-xs text-muted">
        {session.health?.graph === 'postgres-live'
          ? 'Live data: reading the knowledge graph from this deployment’s own PostgreSQL database.'
          : session.health?.graph === 'neo4j-live'
            ? 'Live data: reading the Neo4j knowledge graph through the deployed backend.'
            : 'Live data: reading the knowledge graph through the deployed backend.'}
      </p>
    )
  }

  return (
    <div className="border-b border-line bg-[var(--gm-accent-soft)] px-3 py-2 text-xs">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center">
        {/* Two lengths of the same disclosure. On a 360px phone the full
            sentence and its button cost 117px of the first screen — the most
            valuable strip of a phone viewport — so the phone gets the same
            claim in a line, and the re-check control still follows it. */}
        <span className="hidden sm:inline">
          <strong className="font-semibold">Sample data in use.</strong>{' '}
          {session.fallbackReason ?? session.graphWarning ?? 'This build is not connected to a Neo4j database.'}{' '}
          Everything here is real curriculum content bundled with the app — it is simply not live graph data.
        </span>
        <span className="sm:hidden">
          <strong className="font-semibold">Sample data.</strong> Bundled curriculum, not live graph data.
        </span>
        <button
          type="button"
          className="gm-btn gm-btn-ghost min-h-9 px-2.5 text-xs"
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            await refreshHealth()
            setChecking(false)
          }}
        >
          {checking ? 'Re-checking…' : 'Re-check connection'}
        </button>
      </div>
    </div>
  )
}

export function Layout(): ReactNode {
  const location = useLocation()
  const toasts = useAppStore((state) => state.toasts)
  const dismissToast = useAppStore((state) => state.dismissToast)
  const primaryNav = NAV.filter((item) => item.primary)
  /* Past a few pixels, the bar is no longer "the top of the page" — it is
     chrome floating over content, and it says so. The body compresses inside a
     bar whose height never changes, so nothing below it moves by a pixel. */
  const scrolled = useScrollFlag({ threshold: 8 })

  useEffect(() => {
    // Move focus to the main region on navigation so screen-reader and keyboard
    // users are not left at the bottom of the previous page.
    const main = document.getElementById('main-content')
    if (main && document.activeElement !== document.body) {
      main.focus({ preventScroll: true })
    }
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [location.pathname])

  return (
    <div className="flex min-h-screen flex-col">
      {/* The ambient light the whole material sits in: two soft pools, one
          bright from the upper left and one shaded from the lower right, so the
          raised and inset surfaces have something to be lit by. Decorative only
          — fixed, pointer-events-none, aria-hidden, and static (see
          index.css). The three drifting blobs that used to live here were
          removed with the glass design. */}
      <div className="gm-aurora gm-no-print" aria-hidden="true" />

      <a href="#main-content" className="gm-skip-link">
        Skip to main content
      </a>

      {/* The bar is the page material pushed forward, so it must not be a
          different colour from the page behind it — border-only separation
          would read as a flat toolbar on top of the material rather than as a
          raised edge of it. */}
      <AppScrollRail />

      <header className="gm-appbar sticky top-0 z-30" data-scrolled={scrolled ? 'true' : 'false'}>
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
          <NavLink to="/" className="gm-appbar-identity flex min-h-9 items-center gap-2 no-underline">
            <span
              aria-hidden="true"
              className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--gm-accent)] text-[var(--gm-accent-contrast)]"
            >
              <GitBranch className="h-4 w-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold text-ink">GraphMentor AI</span>
              <span className="gm-appbar-tagline block text-[11px] text-muted">The engineering career navigator</span>
            </span>
          </NavLink>
          <div className="flex items-center gap-1.5">
            <PaletteTrigger />
            <div className="hidden items-center gap-1 md:flex">
              {primaryNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `inline-flex min-h-9 items-center whitespace-nowrap rounded-md px-2.5 text-sm no-underline ${
                      isActive ? 'gm-navkey-active text-accent font-medium' : 'text-muted hover:text-ink'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
            <AccountChip />
          </div>
        </div>
      </header>

      <DataSourceBanner />
      <OfflineBanner />

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-3 pb-24 pt-4 sm:px-4 md:pb-8">
        <nav aria-label="Sections" className="hidden w-56 shrink-0 md:block">
          <ul className="sticky top-24 space-y-0.5">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    `flex min-h-9 items-center gap-2 rounded-md px-2.5 text-sm no-underline ${
                      isActive ? 'bg-[var(--gm-accent-soft)] text-accent font-medium' : 'text-muted hover:bg-[var(--gm-surface-2)] hover:text-ink'
                    }`
                  }
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              </li>
            ))}
            <li className="pt-2">
              <NavLink to="/about" className="flex min-h-9 items-center rounded-md px-2.5 text-sm text-muted no-underline hover:text-ink">
                Features and limits
              </NavLink>
            </li>
            <li>
              <NavLink to="/privacy" className="flex min-h-9 items-center rounded-md px-2.5 text-sm text-muted no-underline hover:text-ink">
                Privacy and terms
              </NavLink>
            </li>
          </ul>
        </nav>

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus-visible:outline-none">
          {/* Keyed on the pathname, so a screen is re-entered when the route
              changes and *not* when only a query parameter does. */}
          <PageTransition routeKey={location.pathname}>
            <Outlet />
          </PageTransition>
        </main>
      </div>

      {/* Mounted once for the whole app: Cmd/Ctrl+K works on every screen,
          including the ones that are lazy-loaded, because this lives above the
          router outlet. */}
      <CommandPalette />

      <footer className="gm-no-print border-t border-line px-3 py-4 text-xs text-muted sm:px-4">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p>
            GraphMentor AI v{config.appVersion} · Curriculum estimates are planning aids, not promises of employment or salary.
          </p>
          {/* Footer navigation: `min-h` and padding, because these are standalone
              links rather than words inside a sentence — the WCAG 2.5.8 inline
              exception does not apply to them. */}
          <p className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
            <NavLink to="/about" className="inline-flex min-h-9 items-center rounded-md px-2 no-underline hover:text-ink">
              What this app can and cannot do
            </NavLink>
            <NavLink to="/privacy" className="inline-flex min-h-9 items-center rounded-md px-2 no-underline hover:text-ink">
              Privacy
            </NavLink>
            <a href="./offline.html" className="inline-flex min-h-9 items-center rounded-md px-2 no-underline hover:text-ink">
              Offline help
            </a>
          </p>
        </div>
      </footer>

      <nav aria-label="Primary" className="gm-no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-[var(--gm-bg-elevated)] md:hidden">
        <ul className="grid grid-cols-6">
          {primaryNav.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] no-underline ${
                    isActive ? 'text-accent' : 'text-muted'
                  }`
                }
              >
                {item.icon}
                {item.short}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <BackToTop />
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}


