/**
 * Dashboard — the "what now?" screen.
 *
 * It answers three questions in order: what am I aiming at, what is genuinely
 * next (in dependency order), and what should I do in the next hour. Everything
 * is derived from the graph and the learner's own self-ratings; nothing here is
 * a streak, a score or an engagement metric.
 */
import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, GitBranch, Route, Sparkles, Target } from 'lucide-react'

import { Button, Callout, Card, Chip, DifficultyBadge, EmptyState, ErrorNotice, Grid, LinkButton, Loading, PageHeader, ProgressBar, SectionTitle, Stat } from '@/components/ui.tsx'
import { api } from '@/core/session.ts'
import { formatHours, formatNumber, formatWeeks, percent } from '@/core/format.ts'
import { useAppStore, ratingPayload } from '@/state/store.ts'
import { useClientQuery } from '@/features/shared/hooks.ts'
import { loadRecentViews } from '@/core/persistence.ts'

export function DashboardPage(): ReactNode {
  const profile = useAppStore((state) => state.profile)
  const ratings = useAppStore((state) => state.ratings)
  const progress = useAppStore((state) => state.progress)
  const bookmarks = useAppStore((state) => state.bookmarks)

  const careers = useClientQuery(() => api().listCareers({}), [], 'the career list')
  const goalId = profile.careerGoalId ?? careers.data?.careers[0]?.id ?? null

  const gaps = useClientQuery(
    () =>
      goalId
        ? api().analyzeGaps({
            careerId: goalId,
            ratings: ratingPayload(),
            interests: profile.interestIds,
            weeklyHours: profile.weeklyHours,
            difficultyComfort: profile.difficultyComfort,
          })
        : Promise.resolve({ data: null as never, meta: { source: 'unavailable' as const } }),
    [goalId, ratings.length, profile.weeklyHours],
    'your skill gaps',
  )

  const nextSkills = useMemo(() => {
    const items = gaps.data?.report.items ?? []
    const order = { 'missing-prerequisite': 0, 'recommended-next': 1, 'ready-to-practice': 2, 'optional-specialization': 3, 'already-familiar': 4 }
    return [...items]
      .sort((a, b) => (order[a.category] - order[b.category]) || a.score - b.score)
      .filter((item) => item.category !== 'already-familiar')
      .slice(0, 3)
  }, [gaps.data])

  // Device-local history (Settings can erase it with everything else). Read
  // once per mount: it answers "where was I?" without any server round-trip.
  const recentViews = useMemo(() => loadRecentViews(), [])

  const totals = useMemo(() => {
    const tasks = Object.values(progress).flatMap((entry) => Object.values(entry.tasks))
    const done = tasks.filter((task) => task.status === 'completed').length
    const hours = tasks.reduce((sum, task) => sum + (task.actualHours ?? 0), 0)
    return { tasks: tasks.length, done, hours }
  }, [progress])

  const goal = careers.data?.careers.find((career) => career.id === goalId) ?? null
  const estimate = gaps.data?.report ? estimateFromGaps(gaps.data.report.items.map((item) => item.difficulty)) : null

  return (
    <div>
      <PageHeader
        eyebrow="Your dashboard"
        title={goal ? `Working towards: ${goal.name}` : 'Start by choosing a direction'}
        description={
          goal
            ? 'Everything below comes from the knowledge graph and your own self-ratings. Change the goal at any time — nothing is locked in.'
            : 'Pick a career goal and this dashboard fills in with what to learn next, in dependency order.'
        }
        actions={
          <>
            <LinkButton to="/careers" variant="secondary" icon={<Target className="h-4 w-4" />}>
              {goal ? 'Change goal' : 'Choose a goal'}
            </LinkButton>
            {goal ? (
              <LinkButton to={`/roadmap?career=${encodeURIComponent(goal.id)}`} variant="primary" icon={<Route className="h-4 w-4" />}>
                Open roadmap
              </LinkButton>
            ) : null}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Skills rated" value={formatNumber(ratings.length)} hint="Self-reported" />
        <Stat label="Tasks tracked" value={formatNumber(totals.tasks)} hint={`${totals.done} completed`} />
        <Stat label="Hours logged" value={`${formatNumber(Math.round(totals.hours))} h`} hint="From your own notes" />
        <Stat label="Bookmarks" value={formatNumber(bookmarks.length)} hint="Skills, projects, resources" />
      </div>

      {careers.status === 'error' ? (
        <div className="mb-4">
          <ErrorNotice message={careers.error?.message ?? 'Could not load careers'} detail={careers.error?.detail} onRetry={careers.reload} />
        </div>
      ) : null}

      {recentViews.length > 0 ? (
        <Card className="mb-5">
          <SectionTitle hint="on this device only — erase it in Settings">Recently viewed</SectionTitle>
          <ul className="flex flex-wrap gap-2">
            {recentViews.map((view) => (
              <li key={view.to}>
                <Link
                  to={view.to}
                  className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm no-underline hover:underline"
                >
                  <span className="font-medium">{view.name}</span>
                  <Chip>{view.kind}</Chip>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {!goal ? (
        <EmptyState
          title="No career goal selected"
          action={<LinkButton to="/careers" variant="primary">Browse the 17 careers</LinkButton>}
        >
          Recommendations need a target: the graph ranks skills by how much a specific career needs them. Pick one, and you can
          change it whenever you like.
        </EmptyState>
      ) : null}

      {goal && gaps.status === 'loading' ? <Loading label="Calculating your gaps from the graph…" /> : null}
      {goal && gaps.status === 'error' ? (
        <ErrorNotice message={gaps.error?.message ?? 'The gap analysis failed'} detail={gaps.error?.detail} onRetry={gaps.reload} />
      ) : null}

      {goal && gaps.data ? (
        <div className="space-y-5">
          <Card lift sheen>
            <SectionTitle hint="dependency order, prerequisites first">Next up</SectionTitle>
            {nextSkills.length === 0 ? (
              <Callout kind="success" title="Nothing outstanding for this goal">
                Every skill this career requires is already marked as familiar or practised. Consider the optional
                specialisations, or pick a second goal and compare.
              </Callout>
            ) : (
              <ol className="space-y-3">
                {nextSkills.map((item, index) => (
                  <li key={item.skillId} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-[var(--gm-accent-soft)] text-xs font-semibold text-accent">
                        {index + 1}
                      </span>
                      <Link to={`/skills/${item.skillId}`} className="font-medium no-underline hover:underline">
                        {item.name}
                      </Link>
                      <DifficultyBadge difficulty={item.difficulty} />
                      {item.isEssential ? <Chip tone="accent">Essential</Chip> : <Chip>Optional</Chip>}
                      {item.blockedBy.length > 0 ? <Chip tone="danger">{item.blockedBy.length} prerequisite(s) first</Chip> : null}
                    </div>
                    <p className="mt-1 text-sm text-muted">{item.reason}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <LinkButton to={`/skills/${item.skillId}`} variant="ghost">
                        Open skill
                      </LinkButton>
                      <LinkButton to={`/graph?seed=${encodeURIComponent(item.skillId)}`} variant="ghost" icon={<GitBranch className="h-3.5 w-3.5" />}>
                        See it in the graph
                      </LinkButton>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Grid cols={2}>
            <Card>
              <SectionTitle hint="how much of the goal is left">Progress towards {goal.name}</SectionTitle>
              {estimate ? (
                <div className="space-y-3">
                  <div>
                    <div className="mb-1 flex items-baseline justify-between text-sm">
                      <span className="text-muted">Skills already familiar</span>
                      <span className="font-medium">
                        {formatNumber(estimate.familiar)} of {formatNumber(estimate.total)}
                      </span>
                    </div>
                    <ProgressBar value={estimate.familiar} max={estimate.total} label="Skills already familiar" />
                  </div>
                  <div className="text-sm text-muted">
                    Remaining estimate: <strong className="text-ink">{formatHours(estimate.hours)}</strong> of study, which at{' '}
                    {profile.weeklyHours} h/week is {formatWeeks(estimate.hours, profile.weeklyHours)}. These are curriculum
                    averages, not a measurement of your pace.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <LinkButton to={`/gaps?career=${encodeURIComponent(goal.id)}`} variant="secondary" icon={<Sparkles className="h-4 w-4" />}>
                      Full gap analysis
                    </LinkButton>
                    <LinkButton to={`/roadmap?career=${encodeURIComponent(goal.id)}`} variant="secondary">
                      Week-by-week plan
                    </LinkButton>
                  </div>
                </div>
              ) : null}
            </Card>

            <Card>
              <SectionTitle hint="worth doing next, but not required yet">Suggested projects</SectionTitle>
              {gaps.data.projects.length === 0 ? (
                <p className="text-sm text-muted">No project matched this goal in the catalogue yet.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {gaps.data.projects.slice(0, 3).map((project) => (
                    <li key={project.id} className="rounded-lg border border-line p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{project.name}</span>
                        <DifficultyBadge difficulty={project.difficulty} />
                        <Chip tone="violet">{percent(project.coverage, 1)}% gap coverage</Chip>
                      </div>
                      <p className="mt-1 text-muted">{project.matchReason}</p>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3">
                <LinkButton to="/projects" variant="ghost">
                  All projects <ArrowRight aria-hidden="true" className="ml-1 h-3.5 w-3.5" />
                </LinkButton>
              </div>
            </Card>
          </Grid>

          {gaps.data.report.caveats.length > 0 ? (
            <Card>
              <SectionTitle hint="read before you plan around these numbers">Honest limits of this analysis</SectionTitle>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {gaps.data.report.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}

      {goal ? (
        <div className="mt-5 flex flex-wrap gap-2">
          <LinkButton to="/graph" variant="secondary" icon={<GitBranch className="h-4 w-4" />}>
            Explore the graph around {goal.name}
          </LinkButton>
          <Button
            variant="ghost"
            onClick={() => {
              window.location.hash = ''
              document.getElementById('main-content')?.scrollTo({ top: 0 })
            }}
          >
            Back to top
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** Rough remaining-effort estimate from the gap items' difficulties. */
function estimateFromGaps(difficulties: string[]): { total: number; familiar: number; hours: [number, number] } | null {
  if (difficulties.length === 0) return null
  const hoursFor = (difficulty: string): [number, number] =>
    difficulty === 'advanced' ? [18, 40] : difficulty === 'intermediate' ? [10, 24] : [5, 12]
  const remaining = difficulties.filter((difficulty) => difficulty !== 'already-familiar')
  const low = remaining.reduce((sum, difficulty) => sum + hoursFor(difficulty)[0], 0)
  const high = remaining.reduce((sum, difficulty) => sum + hoursFor(difficulty)[1], 0)
  return { total: difficulties.length, familiar: difficulties.length - remaining.length, hours: [low, high] }
}


