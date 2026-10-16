/**
 * The command palette — Cmd/Ctrl+K from anywhere.
 *
 * Why this exists, and why it is not a search box bolted onto a page: this app
 * has thirteen careers, sixty skills and concepts, twenty projects and ninety-
 * seven resources, and the fastest way to reach any of them should not be
 * "remember which screen it lives on". One keystroke, type three letters, Enter.
 * It works offline because every entry comes from data the app can already
 * enumerate, and it does not depend on the AI provider being configured.
 *
 * Behaviour that is deliberately specified:
 *   - Cmd+K / Ctrl+K toggles it, Escape closes it, Arrow/Home/End move, Enter
 *     opens. A click on a row works exactly like Enter.
 *   - Focus moves into the search field and returns to whatever had it before
 *     the palette opened, so keyboard users are never dropped at the top of the
 *     document.
 *   - It is a real dialog: role=dialog + aria-modal, the list is a listbox, the
 *     field is a combobox driven by aria-activedescendant, and the result count
 *     is announced through a polite live region.
 *   - The index is built on first open and then kept, so the second open is
 *     instant. If the data cannot be loaded it says so in the palette instead of
 *     pretending the app has nothing in it.
 *
 * What it deliberately is NOT: a place where anything is decided. It navigates.
 * Every destination still explains itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CornerDownLeft, Search } from 'lucide-react'

import { api } from '@/core/session.ts'
import { rankEntries, type PaletteEntry } from '@/core/paletteSearch.ts'

/** The shortcut hint differs per platform; showing the wrong one is a small lie. */
function shortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K'
  const platform = `${navigator.userAgent}`
  return /Mac|iPhone|iPad/i.test(platform) ? '⌘K' : 'Ctrl K'
}

/** Pages come first so an empty query offers navigation, not a data dump. */
const PAGES: PaletteEntry[] = [
  { id: 'page:dashboard', kind: 'Page', title: 'Dashboard', subtitle: 'What to do next', to: '/dashboard', keywords: ['home', 'next', 'overview'] },
  { id: 'page:careers', kind: 'Page', title: 'Career explorer', subtitle: 'All careers and what they need', to: '/careers', keywords: ['jobs', 'roles', 'browse'] },
  { id: 'page:graph', kind: 'Page', title: 'Knowledge graph', subtitle: 'Explore prerequisites and unlocks', to: '/graph', keywords: ['graph', 'prerequisites', 'nodes', '3d'] },
  { id: 'page:pathway', kind: 'Page', title: 'Career pathway builder', subtitle: 'Trace a route between two points', to: '/pathway', keywords: ['path', 'route', 'trace'] },
  { id: 'page:gaps', kind: 'Page', title: 'Skill-gap analyser', subtitle: 'What you are missing for a goal', to: '/gaps', keywords: ['gap', 'missing', 'analyse'] },
  { id: 'page:roadmap', kind: 'Page', title: 'My roadmap', subtitle: 'Your weekly plan', to: '/roadmap', keywords: ['plan', 'schedule', 'weekly'] },
  { id: 'page:projects', kind: 'Page', title: 'Project recommender', subtitle: 'Portfolio projects with safety notes', to: '/projects', keywords: ['build', 'portfolio', 'hands-on'] },
  { id: 'page:resources', kind: 'Page', title: 'Free resource library', subtitle: 'Verified free learning material', to: '/resources', keywords: ['courses', 'books', 'free', 'library'] },
  { id: 'page:mentor', kind: 'Page', title: 'AI mentor', subtitle: 'Graph-grounded answers with citations', to: '/mentor', keywords: ['ask', 'help', 'chat', 'tutor'] },
  { id: 'page:progress', kind: 'Page', title: 'Progress', subtitle: 'Hours and completion from your log', to: '/progress', keywords: ['stats', 'hours', 'track'] },
  { id: 'page:settings', kind: 'Page', title: 'Settings and accessibility', subtitle: 'Theme, motion, data, account', to: '/settings', keywords: ['preferences', 'theme', 'dark', 'export', 'erase'] },
  { id: 'page:about', kind: 'Page', title: 'Features and limitations', subtitle: 'What this app does and does not do', to: '/about', keywords: ['limits', 'honesty', 'docs'] },
]

interface PaletteIndex {
  entries: PaletteEntry[]
  counts: Partial<Record<PaletteEntry['kind'], number>>
}

/**
 * Build the searchable index from everything the client can enumerate in the
 * current mode (demo bundle or live backend — same call, same shape).
 *
 * Skills and concepts come from `GET /get-skills`, the dedicated index endpoint
 * — not from a client-side scan of resource links. That was the first design and
 * it had a hole: concepts a resource never links (PID control among them) were
 * unsearchable, which is exactly the thing a learner types when they are stuck.
 */
async function buildIndex(): Promise<PaletteIndex> {
  const client = api()
  const [careers, projects, resources, skills] = await Promise.all([
    client.listCareers({}),
    client.listProjects({ limit: 200 }),
    client.listResources({ limit: 200 }),
    client.listSkills({ limit: 400 }),
  ])

  const entries: PaletteEntry[] = [...PAGES]
  const counts: PaletteIndex['counts'] = { Page: PAGES.length }

  const careerItems = careers.data?.careers ?? []
  for (const career of careerItems) {
    entries.push({ id: `career:${career.id}`, kind: 'Career', title: career.name, subtitle: 'Career', to: `/careers/${career.id}`, keywords: [career.id] })
  }
  counts.Career = careerItems.length

  const skillItems = skills.data?.skills ?? []
  const projectItems = projects.data?.projects ?? []
  for (const project of projectItems) {
    entries.push({
      id: `project:${project.id}`,
      kind: 'Project',
      title: project.name,
      subtitle: `${project.difficulty} · ${project.estimatedHours[0]}–${project.estimatedHours[1]} h`,
      // Deep-link the filtered list: projects have no detail route, and the
      // filtered list is the closest honest destination.
      to: `/projects?q=${encodeURIComponent(project.name)}`,
      keywords: [...project.tools, ...project.skillIds],
    })
  }
  counts.Project = projectItems.length

  for (const skill of skillItems) {
    entries.push({
      id: `skill:${skill.id}`,
      kind: 'Skill',
      title: skill.name,
      subtitle: skill.parentName ? `${skill.kind} · ${skill.parentName}` : skill.kind,
      to: `/skills/${skill.id}`,
      keywords: [skill.id, skill.difficulty],
    })
  }
  counts.Skill = skillItems.length

  const resourceItems = resources.data?.resources ?? []
  for (const resource of resourceItems) {
    entries.push({
      id: `resource:${resource.id}`,
      kind: 'Resource',
      title: resource.name,
      subtitle: `${resource.provider} · ${resource.format}`,
      to: `/resources?q=${encodeURIComponent(resource.name)}`,
      keywords: [resource.provider, ...resource.covers.map((skill) => skill.name)],
    })
  }
  counts.Resource = resourceItems.length

  return { entries, counts }
}

/** Small helper: the open event the app bar button dispatches. */
export const PALETTE_OPEN_EVENT = 'gm:open-palette'

export function CommandPalette(): ReactNode {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [index, setIndex] = useState<PaletteIndex | null>(null)
  const [indexError, setIndexError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef<Element | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setCursor(0)
    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous instanceof HTMLElement && document.contains(previous)) previous.focus()
  }, [])

  const show = useCallback(() => {
    restoreFocusRef.current = document.activeElement
    setOpen(true)
  }, [])

  /* The open flag is mirrored into a ref so the window listener can stay
     registered once for the life of the app without stale state. */
  const openRef = useRef(false)
  openRef.current = open

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (openRef.current) close()
        else show()
        return
      }
      if (event.key === 'Escape' && openRef.current) {
        event.preventDefault()
        close()
      }
    }
    const onOpenEvent = (): void => show()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(PALETTE_OPEN_EVENT, onOpenEvent)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpenEvent)
    }
  }, [close, show])

  /* Build the index the first time the palette is opened, then keep it. A
     failed build is retried on the next open rather than cached forever. */
  useEffect(() => {
    if (!open || index) return
    let cancelled = false
    setIndexError(null)
    buildIndex()
      .then((built) => {
        if (!cancelled) setIndex(built)
      })
      .catch((error: unknown) => {
        if (!cancelled) setIndexError(error instanceof Error ? error.message : 'The index could not be built.')
      })
    return () => {
      cancelled = true
    }
  }, [open, index, indexError])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    inputRef.current?.focus()
    const { overflow } = document.documentElement.style
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.overflow = overflow
    }
  }, [open])

  const groups = useMemo(() => rankEntries(index?.entries ?? [], query), [index, query])
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])

  useEffect(() => {
    if (cursor > flat.length - 1) setCursor(flat.length === 0 ? 0 : flat.length - 1)
  }, [cursor, flat.length])

  const choose = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry) return
      close()
      navigate(entry.to)
    },
    [close, navigate],
  )

  const onFieldKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor((current) => (flat.length === 0 ? 0 : (current + 1) % flat.length))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor((current) => (flat.length === 0 ? 0 : (current - 1 + flat.length) % flat.length))
      } else if (event.key === 'Home') {
        event.preventDefault()
        setCursor(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setCursor(Math.max(0, flat.length - 1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        choose(flat[cursor])
      } else if (event.key === 'Tab') {
        // The dialog holds one focusable control; keep Tab inside it.
        event.preventDefault()
      }
    },
    [choose, cursor, flat],
  )

  if (!open) return null

  const activeId = flat[cursor] ? `gm-cmd-option-${flat[cursor].id}` : undefined
  const countText = index
    ? `${flat.length} result${flat.length === 1 ? '' : 's'}`
    : indexError
      ? 'The search index is unavailable'
      : 'Building the search index'

  let optionIndex = -1

  return (
    <div
      className="gm-cmd-overlay gm-no-print"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="gm-panel gm-cmd-panel" role="dialog" aria-modal="true" aria-label="Search GraphMentor">
        <div className="flex items-center gap-2 border-b border-[var(--gm-border)] px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            id="gm-cmd-field"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="gm-cmd-list"
            aria-autocomplete="list"
            {...(activeId ? { 'aria-activedescendant': activeId } : {})}
            aria-label="Search pages, careers, skills, projects and resources"
            className="gm-cmd-field"
            placeholder="Search careers, skills, projects, resources…"
            value={query}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value)
              setCursor(0)
            }}
            onKeyDown={onFieldKeyDown}
          />
          <kbd className="gm-chip hidden shrink-0 px-1.5 text-[0.7rem] sm:inline-flex">Esc</kbd>
        </div>

        <p className="sr-only" role="status" aria-live="polite">
          {countText}
        </p>

        <div id="gm-cmd-list" role="listbox" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {indexError ? (
            <p className="px-3 py-6 text-sm text-muted">
              {indexError} — the palette needs the dataset to be readable. Everything else still works; reload to try again.
            </p>
          ) : !index ? (
            <p className="px-3 py-6 text-sm text-muted">Loading the index…</p>
          ) : flat.length === 0 ? (
            <p className="px-3 py-6 text-sm text-muted">
              Nothing matches “{query}”. Try a skill (“PID”), a career, a tool (“KiCad”) or a page name.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className="mb-1">
                <p className="px-2 py-1 text-[0.7rem] font-semibold tracking-wide text-muted uppercase">{group.label}</p>
                {group.items.map((entry) => {
                  optionIndex += 1
                  const isActive = optionIndex === cursor
                  return (
                    <button
                      key={entry.id}
                      id={`gm-cmd-option-${entry.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-active={isActive ? 'true' : 'false'}
                      className="gm-cmd-row"
                      onMouseMove={() => setCursor(optionIndex)}
                      onClick={() => choose(entry)}
                    >
                      <span className="gm-chip shrink-0 px-1.5 text-[0.65rem]">{entry.kind}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{entry.title}</span>
                        {entry.subtitle ? <span className="block truncate text-xs text-muted">{entry.subtitle}</span> : null}
                      </span>
                      {isActive ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" /> : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--gm-border)] px-3 py-2 text-xs text-muted">
          <span>
            {index
              ? `Searching ${index.counts.Career ?? 0} careers, ${index.counts.Skill ?? 0} skills, ${index.counts.Project ?? 0} projects, ${index.counts.Resource ?? 0} resources`
              : countText}
          </span>
          <span className="hidden items-center gap-2 sm:flex">
            <span>↑↓ move</span>
            <span className="inline-flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" aria-hidden="true" /> open
            </span>
            <span>
              <ArrowRight className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
              {shortcutLabel()} toggles
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}

/** The app-bar trigger. Kept here so the label and the shortcut cannot drift apart. */
export function PaletteTrigger(): ReactNode {
  const [isMac, setIsMac] = useState(false)
  useEffect(() => setIsMac(shortcutLabel() === '⌘K'), [])
  return (
    <button
      type="button"
      // Same padding and minimum height as the nav keys beside it: the browser
      // suite checks every interactive element is at least 24 px, and a bare
      // icon button came in under that (it caught this the first time it ran).
      className="gm-navkey gm-no-print inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap px-2.5 py-1.5 text-sm"
      onClick={() => window.dispatchEvent(new Event(PALETTE_OPEN_EVENT))}
      aria-label={`Search everything (${isMac ? 'Command K' : 'Control K'})`}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      {/* The label and the shortcut are progressive: at narrow widths the icon
          alone is the trigger, so the primary nav never has to wrap. */}
      <span className="hidden lg:inline">Search</span>
      <kbd className="hidden whitespace-nowrap text-[0.7rem] text-muted xl:inline">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  )
}


