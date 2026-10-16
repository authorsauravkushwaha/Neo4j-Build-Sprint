/**
 * Project recommender.
 *
 * Ranking is transparent (`coverage` = share of your current gap the project
 * builds) and every hardware project carries its safety notes in full, because a
 * portfolio suggestion that gets somebody hurt is not a recommendation.
 */
import { useState, type ReactNode } from 'react'
import { Bookmark, ExternalLink } from 'lucide-react'

import {
  Button,
  Callout,
  Card,
  Chip,
  DifficultyBadge,
  EmptyState,
  ErrorNotice,
  Field,
  Grid,
  LinkButton,
  List,
  Loading,
  PageHeader,
  Select,
  TextInput,
} from '@/components/ui.tsx'
import { api } from '@/core/session.ts'
import { formatHours, formatNumber, percent } from '@/core/format.ts'
import { ratingPayload, useAppStore } from '@/state/store.ts'
import { useCareerParam, useClientQuery, useTextParam } from '@/features/shared/hooks.ts'
import { Stagger } from '@/skiper/components/Stagger.tsx'

export function ProjectsPage(): ReactNode {
  const { careerId, setCareerId } = useCareerParam()
  const profile = useAppStore((state) => state.profile)
  const ratings = useAppStore((state) => state.ratings)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const toggleBookmark = useAppStore((state) => state.toggleBookmark)
  const pushToast = useAppStore((state) => state.pushToast)
  const [difficulty, setDifficulty] = useState('')
  // `?q=` — a filtered project list is a link you can keep or share.
  const [search, setSearch] = useTextParam('q')

  const careers = useClientQuery(() => api().listCareers({}), [], 'the career list')

  // The gap analysis supplies the skill ids the ranking should favour.
  const gaps = useClientQuery(
    () =>
      careerId
        ? api().analyzeGaps({
            careerId,
            ratings: ratingPayload(),
            interests: profile.interestIds,
            weeklyHours: profile.weeklyHours,
            difficultyComfort: profile.difficultyComfort,
          })
        : Promise.resolve({ data: null as never, meta: { source: 'unavailable' as const } }),
    [careerId, ratings.length],
    'your gaps',
  )

  const focusSkills = (gaps.data?.report.items ?? [])
    .filter((item) => item.category === 'missing-prerequisite' || item.category === 'recommended-next')
    .map((item) => item.skillId)
    .slice(0, 20)

  const projects = useClientQuery(
    () =>
      api().listProjects({
        ...(careerId ? { careerId } : {}),
        ...(focusSkills.length > 0 ? { skillIds: focusSkills } : {}),
        ...(difficulty ? { difficulty } : {}),
        limit: 40,
      }),
    [careerId, focusSkills.join(','), difficulty],
    'the project catalogue',
  )

  const filtered = (projects.data?.projects ?? []).filter((project) =>
    search.trim().length < 2
      ? true
      : `${project.name} ${project.summary} ${project.tools.join(' ')} ${project.skillIds.join(' ')}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
  )

  const sorted = [...filtered].sort((a, b) => b.coverage - a.coverage)

  return (
    <div>
      <PageHeader
        eyebrow="Project recommender"
        title="Build the thing that proves the skill"
        description="Projects are ranked by how much of your current gap they build, not by popularity. Every hardware project lists its safety notes in full."
        actions={
          <LinkButton to="/gaps" variant="secondary">
            Check my gaps first
          </LinkButton>
        }
      />

      <Card className="mb-5">
        <Grid cols={3}>
          <Field label="Career context" htmlFor="projects-career" hint="Optional: ranks projects by that career's gaps.">
            <Select id="projects-career" value={careerId ?? ''} onChange={(event) => setCareerId(event.target.value || null)}>
              <option value="">Whole catalogue</option>
              {(careers.data?.careers ?? []).map((career) => (
                <option key={career.id} value={career.id}>
                  {career.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Difficulty" htmlFor="projects-difficulty">
            <Select id="projects-difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option value="">Any</option>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </Select>
          </Field>
          <Field label="Search" htmlFor="projects-search">
            <TextInput
              id="projects-search"
              value={search}
              maxLength={60}
              placeholder="e.g. robot, dashboard, PCB"
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
        </Grid>
        <p className="mt-2 text-xs text-muted">
          {careerId && focusSkills.length > 0
            ? `Ranking favours the ${focusSkills.length} skills currently in your gap list.`
            : 'No career selected, so projects are listed in catalogue order with no personalised ranking.'}
        </p>
      </Card>

      {projects.status === 'loading' ? <Loading label="Loading projects…" /> : null}
      {projects.status === 'error' ? (
        <ErrorNotice
          message={projects.error?.message ?? 'Projects could not be loaded'}
          detail={projects.error?.detail}
          onRetry={projects.reload}
        />
      ) : null}

      {projects.status === 'ready' && sorted.length === 0 ? (
        <EmptyState title="No project matches those filters">
          Clear the search or the difficulty filter, or open the whole catalogue. The dataset is curated and small on purpose.
        </EmptyState>
      ) : null}

      <Stagger className="space-y-4">
        {sorted.map((project) => {
          const bookmarked = bookmarks.some((bookmark) => bookmark.targetId === project.id)
          return (
            <Card key={project.id} as="article">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{project.name}</h2>
                    <DifficultyBadge difficulty={project.difficulty} />
                    {project.coverage > 0 ? (
                      <Chip tone="violet" title="Share of your current gap this project builds">
                        {percent(project.coverage, 1)}% gap coverage
                      </Chip>
                    ) : null}
                    <Chip>{formatHours(project.estimatedHours)}</Chip>
                  </div>
                  <p className="mt-1 text-sm text-muted">{project.summary}</p>
                  <p className="mt-1 text-xs text-accent">{project.matchReason}</p>
                </div>
                <Button
                  size="sm"
                  variant={bookmarked ? 'secondary' : 'ghost'}
                  icon={<Bookmark className="h-3.5 w-3.5" />}
                  onClick={() => {
                    const added = toggleBookmark({ targetType: 'project', targetId: project.id })
                    pushToast({ kind: 'success', message: added ? 'Project bookmarked.' : 'Bookmark removed.' })
                  }}
                >
                  {bookmarked ? 'Saved' : 'Save'}
                </Button>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold">Objectives</h3>
                  <List items={project.objectives.slice(0, 4)} />
                  <h3 className="mt-2 text-sm font-semibold">Milestones</h3>
                  <List items={project.milestones.slice(0, 4)} ordered />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Deliverables</h3>
                  <List items={project.deliverables.slice(0, 4)} />
                  <h3 className="mt-2 text-sm font-semibold">How to test it</h3>
                  <List items={project.testingIdeas.slice(0, 4)} />
                </div>
              </div>

              {project.safetyNotes.length > 0 ? (
                <div className="mt-3">
                  <Callout kind="warning" title="Safety notes — read before you start">
                    <List items={project.safetyNotes} />
                  </Callout>
                </div>
              ) : null}

              {project.skillIds.length > 0 ? (
                <div className="mt-3">
                  <h3 className="text-sm font-semibold">Skills this builds</h3>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {project.skillIds.slice(0, 10).map((skillId) => (
                      <LinkButton key={skillId} to={`/skills/${skillId}`} size="sm" variant="ghost">
                        {skillId.replace(/^skill:/, '').replace(/-/g, ' ')}
                      </LinkButton>
                    ))}
                  </div>
                </div>
              ) : null}

              {project.tools.length > 0 ? (
                <p className="mt-3 text-xs text-muted">
                  <strong>Tools and materials:</strong> {project.tools.join(', ')}
                </p>
              ) : null}

              {project.extensions.length > 0 ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-accent">Extensions when you finish early</summary>
                  <List items={project.extensions} className="mt-1" />
                </details>
              ) : null}
            </Card>
          )
        })}
      </Stagger>

      <div className="mt-6">
        <Callout kind="info" title="Why the numbers are small">
          {formatNumber(projects.data?.total ?? 0)} projects are in the catalogue, each with objectives, deliverables,
          milestones, testing ideas and safety notes. Every project here is buildable with free tools, simulation or
          low-cost hardware; nothing requires a lab you do not have.
        </Callout>
      </div>

      <p className="mt-4 text-xs text-muted">
        Buying hardware? Check local availability and prices yourself — this app has no affiliate links and no commercial
        relationships. <ExternalLink aria-hidden="true" className="inline h-3 w-3" />
      </p>
    </div>
  )
}


