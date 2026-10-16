/**
 * Free-resource library.
 *
 * Every row states its access model in words ("free", "free to audit",
 * "free tier with limits", "paid") plus the note written when the link was last
 * checked. Nothing is labelled "free" without that note, and the report in
 * docs/resource-verification.md records what the checker actually measured.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Bookmark, ExternalLink, ShieldCheck, ShieldQuestion } from 'lucide-react'

import {
  Button,
  Callout,
  Card,
  Checkbox,
  Chip,
  DifficultyBadge,
  EmptyState,
  ErrorNotice,
  Field,
  Grid,
  LinkButton,
  Loading,
  PageHeader,
  SectionTitle,
  Select,
  TextInput,
} from '@/components/ui.tsx'
import { datasetCounts } from '@/data/seed/knowledgeGraph.ts'
import { api } from '@/core/session.ts'
import { accessTone, formatNumber, formatRelative } from '@/core/format.ts'
import { useAppStore } from '@/state/store.ts'
import { useClientQuery, useTextParam } from '@/features/shared/hooks.ts'
import { Stagger } from '@/skiper/components/Stagger.tsx'

export function ResourcesPage(): ReactNode {
  // `?q=` — the library is shareable: a filtered view survives a reload and can
  // be sent to someone else, and the command palette links straight into it.
  const [search, setSearch] = useTextParam('q')
  const [format, setFormat] = useState('')
  const [accessModel, setAccessModel] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [sort, setSort] = useState('curated')
  const [onlyBookmarked, setOnlyBookmarked] = useState(false)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const toggleBookmark = useAppStore((state) => state.toggleBookmark)
  const pushToast = useAppStore((state) => state.pushToast)

  const resources = useClientQuery(
    () =>
      api().listResources({
        ...(search ? { q: search } : {}),
        ...(format ? { format } : {}),
        ...(accessModel ? { accessModel } : {}),
        ...(difficulty ? { difficulty } : {}),
        // The whole library is bundled with the app, so ask for exactly as many
        // as the dataset holds. A literal here silently truncated the list once
        // (80 of 97 rows) — the browser check now fails if that happens again.
        limit: datasetCounts.resources,
      }),
    [search, format, accessModel, difficulty],
    'the resource library',
  )

  const rows = resources.data?.resources ?? []

  // Presentation only: sorting and the bookmarked-only view never change what
  // the server returned, so the counts above stay honest about filtering.
  const displayed = useMemo(() => {
    const difficultyRank: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 }
    const list = onlyBookmarked ? rows.filter((resource) => bookmarks.some((bookmark) => bookmark.targetId === resource.id)) : [...rows]
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'verified') list.sort((a, b) => String(b.lastVerified ?? '').localeCompare(String(a.lastVerified ?? '')))
    else if (sort === 'beginner') list.sort((a, b) => (difficultyRank[a.difficulty] ?? 3) - (difficultyRank[b.difficulty] ?? 3))
    return list
  }, [rows, sort, onlyBookmarked, bookmarks])

  return (
    <div>
      <PageHeader
        eyebrow="Free resource library"
        title="Material you can start tonight, with honest labels"
        description="Curated free and free-to-audit resources: documentation, courses, books, practice sites and repositories. Each one says what access really means before you click."
        actions={
          <LinkButton to="/pathway" variant="secondary">
            Attach resources to a pathway
          </LinkButton>
        }
      />

      <Card className="mb-5">
        <Grid cols={3}>
          <Field label="Search" htmlFor="resource-search">
            <TextInput
              id="resource-search"
              value={search}
              maxLength={60}
              placeholder="e.g. docker, calculus, OWASP"
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          <Field label="Format" htmlFor="resource-format">
            <Select id="resource-format" value={format} onChange={(event) => setFormat(event.target.value)}>
              <option value="">Any format</option>
              <option value="course">Course</option>
              <option value="video">Video</option>
              <option value="docs">Documentation</option>
              <option value="book">Book</option>
              <option value="tutorial">Tutorial</option>
              <option value="practice">Practice</option>
              <option value="repository">Repository</option>
              <option value="reference">Reference</option>
            </Select>
          </Field>
          <Field label="Access" htmlFor="resource-access">
            <Select id="resource-access" value={accessModel} onChange={(event) => setAccessModel(event.target.value)}>
              <option value="">Any access model</option>
              <option value="free-open">Free, no account</option>
              <option value="free-account">Free with an account</option>
              <option value="free-audit">Free to audit (certificate paid)</option>
              <option value="free-with-limits">Free tier with a documented ceiling</option>
            </Select>
          </Field>
        </Grid>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Difficulty" htmlFor="resource-difficulty">
            <Select id="resource-difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option value="">Any difficulty</option>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </Select>
          </Field>
          <div className="sm:col-span-2 flex items-end">
            <p aria-live="polite" className="text-xs text-muted">
              {resources.status === 'ready'
                ? `${formatNumber(displayed.length)} of ${formatNumber(datasetCounts.resources)} resources shown.`
                : 'Loading…'}{' '}
              Links open in a new tab; this app does not track which ones you open.
            </p>
          </div>
        </div>
      </Card>

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Sort by" htmlFor="resource-sort">
            <Select id="resource-sort" value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="curated">Curated order</option>
              <option value="name">Name (A–Z)</option>
              <option value="verified">Most recently link-checked</option>
              <option value="beginner">Beginner first</option>
            </Select>
          </Field>
          <Checkbox
            id="resource-bookmarked-only"
            label={`Bookmarked only${bookmarks.length > 0 ? ` (${formatNumber(bookmarks.length)})` : ''}`}
            checked={onlyBookmarked}
            onChange={(next) => setOnlyBookmarked(next)}
          />
        </div>
      </Card>

      {resources.status === 'loading' ? <Loading label="Loading the library…" /> : null}
      {resources.status === 'error' ? (
        <ErrorNotice
          message={resources.error?.message ?? 'The library could not be loaded'}
          detail={resources.error?.detail}
          onRetry={resources.reload}
        />
      ) : null}

      {resources.status === 'ready' && displayed.length === 0 ? (
        <EmptyState title="Nothing matches those filters">
          Clear the search or widen the access filter{onlyBookmarked ? ', or turn off “Bookmarked only”' : ''}. The library lists{' '}
          {formatNumber(datasetCounts.resources)} curated resources; it is not a link farm.
        </EmptyState>
      ) : null}

      <Stagger className="space-y-3">
        {displayed.map((resource) => {
          const bookmarked = bookmarks.some((bookmark) => bookmark.targetId === resource.id)
          const verifiedRecently = resource.verification === 'verified'
          return (
            <Card key={resource.id} as="article">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{resource.name}</h2>
                    <Chip tone={accessTone(resource.accessModel)}>{resource.accessBadge}</Chip>
                    <DifficultyBadge difficulty={resource.difficulty} />
                    <Chip>{resource.format}</Chip>
                    {resource.language !== 'en' ? <Chip>{resource.language}</Chip> : null}
                  </div>
                  <p className="mt-1 text-sm text-muted">{resource.summary}</p>
                  <p className="mt-1 text-xs text-muted">
                    <strong>{resource.provider}</strong> — {resource.accessNote}
                  </p>
                  {resource.outcomes.length > 0 ? (
                    <>
                      <h3 className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted">What you can do after this</h3>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                        {resource.outcomes.map((outcome) => (
                          <li key={outcome}>{outcome}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                    {resource.assumes ? (
                      <>
                        <dt className="font-semibold text-muted">Assumes</dt>
                        <dd className="sm:col-span-2">
                          {resource.assumes}
                          {resource.assumesSkills.length > 0 ? (
                            <span className="mt-1 flex flex-wrap items-center gap-1.5">
                              <span className="text-muted">Curriculum prerequisites:</span>
                              {resource.assumesSkills.map((skill) => (
                                <LinkButton key={skill.id} to={`/skills/${skill.id}`} size="sm" variant="ghost">
                                  {skill.name}
                                </LinkButton>
                              ))}
                            </span>
                          ) : null}
                        </dd>
                      </>
                    ) : null}
                    {resource.limits ? (
                      <>
                        <dt className="font-semibold text-muted">Where it stops</dt>
                        <dd className="sm:col-span-2">{resource.limits}</dd>
                      </>
                    ) : null}
                    {resource.commitment ? (
                      <>
                        <dt className="font-semibold text-muted">Time involved</dt>
                        <dd className="sm:col-span-2">
                          {resource.estimatedHours[1] > 0
                            ? `≈ ${formatNumber(resource.estimatedHours[0])}–${formatNumber(resource.estimatedHours[1])} hours. `
                            : ''}
                          {resource.commitment}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </div>
                <Button
                  size="sm"
                  variant={bookmarked ? 'secondary' : 'ghost'}
                  icon={<Bookmark className="h-3.5 w-3.5" />}
                  onClick={() => {
                    const added = toggleBookmark({ targetType: 'resource', targetId: resource.id })
                    pushToast({ kind: 'success', message: added ? 'Resource bookmarked.' : 'Bookmark removed.' })
                  }}
                >
                  {bookmarked ? 'Saved' : 'Save'}
                </Button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className={`inline-flex items-center gap-1 ${verifiedRecently ? 'text-[var(--gm-success)]' : 'text-muted'}`}>
                  {verifiedRecently ? (
                    <>
                      <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" /> link checked {formatRelative(resource.lastVerified)}
                    </>
                  ) : (
                    <>
                      <ShieldQuestion aria-hidden="true" className="h-3.5 w-3.5" /> not re-checked recently
                    </>
                  )}
                </span>
                <a
                  href={resource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-accent no-underline hover:underline"
                >
                  Open on {resource.provider} <ExternalLink aria-hidden="true" className="h-3 w-3" />
                </a>
              </div>

              {resource.covers.length > 0 ? (
                <div className="mt-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Covers</h3>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {resource.covers.slice(0, 8).map((item) => (
                      <LinkButton key={item.id} to={`/skills/${item.id}`} size="sm" variant="ghost">
                        {item.name}
                      </LinkButton>
                    ))}
                    {resource.covers.length > 8 ? (
                      <span className="self-center text-muted">and {formatNumber(resource.covers.length - 8)} more</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </Card>
          )
        })}
      </Stagger>

      <div className="mt-6 space-y-3">
        <Callout kind="info" title="How the access labels are decided">
          "Free" means you can read or use the material without paying and without a trial. "Free to audit" means the content is
          readable for free but the certificate or graded work is paid. "Free tier with limits" means there is a real free tier
          and a real ceiling. If a provider changes its terms, the label is stale — the note is what was true when it was checked.
        </Callout>
        <Card>
          <SectionTitle hint="run it yourself">Check the links on your own machine</SectionTitle>
          <p className="text-sm text-muted">
            <code className="rounded bg-[var(--gm-surface-2)] px-1">npm run verify:resources</code> checks every URL and writes
            what it measured to <code className="rounded bg-[var(--gm-surface-2)] px-1">docs/resource-verification.md</code>.
            Failures are recorded as failures; the script never turns an unreachable link into a pass.
          </p>
        </Card>
      </div>
    </div>
  )
}


