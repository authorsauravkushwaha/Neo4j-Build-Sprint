/**
 * Career detail: what the work is, which skills the graph requires, what to
 * build, and where to read about it.
 *
 * The page keeps three things visually separate, because conflating them is how
 * career sites mislead people:
 *   - graph facts (skills, prerequisites, projects, resources),
 *   - the curriculum author's framing (responsibilities, typical roles),
 *   - the caveats (assumptions, estimates, what was not verified).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ExternalLink, GitBranch, Route, Target } from 'lucide-react'

import {
  Button,
  Callout,
  Card,
  Chip,
  DifficultyBadge,
  ErrorNotice,
  Grid,
  LinkButton,
  List,
  Loading,
  PageHeader,
  SectionTitle,
} from '@/components/ui.tsx'
import { api } from '@/core/session.ts'
import { accessTone, formatHours } from '@/core/format.ts'
import { useAppStore } from '@/state/store.ts'
import { useClientQuery } from '@/features/shared/hooks.ts'
import { SelfRating } from '@/features/shared/SelfRating.tsx'
import { ShareButton } from '@/components/ShareButton.tsx'
import { recordRecentView } from '@/core/persistence.ts'

type Tab = 'overview' | 'skills' | 'projects' | 'resources'

export function CareerDetailPage(): ReactNode {
  const { careerId = '' } = useParams()
  const [tab, setTab] = useState<Tab>('overview')
  const setProfile = useAppStore((state) => state.setProfile)
  const goalId = useAppStore((state) => state.profile.careerGoalId)
  const ratings = useAppStore((state) => state.ratings)

  const query = useClientQuery(() => api().getCareer(careerId), [careerId], 'this career')

  useEffect(() => {
    if (query.data) {
      recordRecentView({ to: `/careers/${query.data.career.id}`, name: query.data.career.name, kind: 'Career' })
    }
  }, [query.data])

  if (query.status === 'loading') return <Loading label="Loading this career from the graph…" />
  if (query.status === 'error' || !query.data) {
    return (
      <ErrorNotice
        message={query.error?.message ?? 'This career could not be loaded'}
        detail={query.error?.detail}
        onRetry={query.reload}
      />
    )
  }

  const { career, projects, resources, graphBasis, caveats } = query.data
  const essential = career.skills.filter((skill) => skill.essential)
  const optional = career.skills.filter((skill) => !skill.essential)
  const isGoal = goalId === career.id
  const ratedCount = career.skills.filter((skill) => ratings.some((rating) => rating.skillId === skill.id && rating.state !== 'unknown')).length

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'skills', label: 'Skills', count: career.skills.length },
    { id: 'projects', label: 'Projects', count: projects.length },
    { id: 'resources', label: 'Resources', count: resources.length },
  ]

  return (
    <div>
      <PageHeader
        eyebrow="Career"
        title={career.name}
        description={career.summary}
        actions={
          <>
            <Button
              variant={isGoal ? 'secondary' : 'primary'}
              icon={<Target className="h-4 w-4" />}
              onClick={() => setProfile({ careerGoalId: career.id })}
              disabled={isGoal}
            >
              {isGoal ? 'This is your goal' : 'Set as my goal'}
            </Button>
            <LinkButton to={`/graph?career=${encodeURIComponent(career.id)}`} variant="secondary" icon={<GitBranch className="h-4 w-4" />}>
              Show in graph
            </LinkButton>
            <LinkButton to={`/roadmap?career=${encodeURIComponent(career.id)}`} variant="secondary" icon={<Route className="h-4 w-4" />}>
              Build a roadmap
            </LinkButton>
            <ShareButton title={`${career.name} — GraphMentor AI`} />
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DifficultyBadge difficulty={career.difficulty} />
        <Chip tone="accent">{essential.length} essential skills</Chip>
        <Chip>{optional.length} optional skills</Chip>
        <Chip tone={ratedCount > 0 ? 'success' : 'default'}>
          {ratedCount === 0 ? 'Nothing self-rated yet' : `${ratedCount} self-rated by you`}
        </Chip>
        {career.branches.map((branch) => (
          <Chip key={branch.id}>{branch.name}</Chip>
        ))}
      </div>

      <div role="tablist" aria-label="Career sections" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
              const index = tabs.findIndex((entry) => entry.id === tab)
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length
              setTab(tabs[next].id)
              document.getElementById(`tab-${tabs[next].id}`)?.focus()
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === item.id ? 'border-accent font-medium text-accent' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {item.label}
            {item.count !== undefined ? <span className="ml-1 text-xs text-muted">{item.count}</span> : null}
          </button>
        ))}
      </div>

      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'overview' ? (
          <div className="space-y-4">
            <Card>
              <SectionTitle hint="curriculum description, not a job advert">What this work involves</SectionTitle>
              <p className="text-sm text-muted">{career.description}</p>
              <div className="mt-4">
                <h3 className="mb-1 text-sm font-semibold">Responsibilities commonly reported for this role</h3>
                <List items={career.responsibilities} />
              </div>
            </Card>

            <Grid cols={2}>
              <Card>
                <SectionTitle hint="examples, not a promise of employment">Common job titles</SectionTitle>
                <List items={career.typicalRoles} />
                <p className="mt-2 text-xs text-muted">
                  Titles and levels differ between employers and countries. Treat these as search terms for job boards, not as
                  a list of roles that will hire you.
                </p>
              </Card>
              <Card>
                <SectionTitle hint="what to show a mentor or employer">Portfolio ideas</SectionTitle>
                <List items={career.portfolioIdeas} />
              </Card>
            </Grid>

            <Card>
              <SectionTitle hint="written by the curriculum author">Assumptions behind this career entry</SectionTitle>
              <List items={career.assumptions} />
            </Card>

            {career.relatedCareers.length > 0 ? (
              <Card>
                <SectionTitle hint="related directions worth comparing">Related careers</SectionTitle>
                <div className="flex flex-wrap gap-2">
                  {career.relatedCareers.map((related) => (
                    <Link key={related.id} to={`/careers/${related.id}`} className="gm-chip no-underline hover:border-accent">
                      {related.name}
                    </Link>
                  ))}
                </div>
              </Card>
            ) : null}

            <Card>
              <SectionTitle hint="the exact relationships this page is built from">Graph basis</SectionTitle>
              <ul className="space-y-1 font-mono text-xs text-muted">
                {graphBasis.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Every entry above is one relationship in the graph. Open the graph explorer to see them rendered, or read
                neo4j/sample-queries.cypher to run them yourself.
              </p>
            </Card>

            <Card>
              <SectionTitle hint="kept short on purpose">Caveats</SectionTitle>
              <List items={caveats} />
            </Card>
          </div>
        ) : null}

        {tab === 'skills' ? (
          <div className="space-y-4">
            <Callout kind="info" title="Essential first, then optional">
              Essential skills are the ones the graph marks as required in practice. Optional skills are useful, career-dependent
              specialisations: no single employer expects all of them. Rate yourself only where you have real evidence.
            </Callout>

            <Card>
              <SectionTitle hint={`${essential.length} skills`}>Essential skills</SectionTitle>
              <ul className="space-y-2">
                {essential.map((skill) => (
                  <li key={skill.id} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/skills/${skill.id}`} className="font-medium no-underline hover:underline">
                        {skill.name}
                      </Link>
                      <DifficultyBadge difficulty={skill.difficulty} />
                      <Chip tone="accent">Essential</Chip>
                      <Chip title="Curriculum weight used by the scorer">{Math.round(skill.weight * 100)}% weight</Chip>
                    </div>
                    {skill.summary ? <p className="mt-1 text-sm text-muted">{skill.summary}</p> : null}
                    <div className="mt-2">
                      <SelfRating skillId={skill.id} skillName={skill.name} compact />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>

            {optional.length > 0 ? (
              <Card>
                <SectionTitle hint={`${optional.length} skills`}>Optional specialisations</SectionTitle>
                <ul className="space-y-2">
                  {optional.map((skill) => (
                    <li key={skill.id} className="rounded-lg border border-dashed border-line p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/skills/${skill.id}`} className="font-medium no-underline hover:underline">
                          {skill.name}
                        </Link>
                        <DifficultyBadge difficulty={skill.difficulty} />
                        <Chip>Optional</Chip>
                      </div>
                      {skill.summary ? <p className="mt-1 text-sm text-muted">{skill.summary}</p> : null}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        ) : null}

        {tab === 'projects' ? (
          <div className="space-y-3">
            {projects.length === 0 ? (
              <Callout kind="warning" title="No projects linked yet">
                The graph has no project connected to this career in the current dataset. Try the project recommender for the
                whole catalogue.
              </Callout>
            ) : (
              projects.map((project) => (
                <Card key={project.id} as="article">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">{project.name}</h3>
                    <DifficultyBadge difficulty={project.difficulty} />
                  </div>
                  <p className="mt-1 text-sm text-muted">{project.summary}</p>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <h4 className="text-sm font-semibold">Deliverables</h4>
                      <List items={project.deliverables} />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold">Safety and materials</h4>
                      {project.safetyNotes.length > 0 ? (
                        <List items={project.safetyNotes} />
                      ) : (
                        <p className="text-sm text-muted">No safety notes for this project (software-only or simulation).</p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <LinkButton to={`/projects?career=${encodeURIComponent(career.id)}`} variant="ghost" size="sm">
                      All projects for this career
                    </LinkButton>
                  </div>
                </Card>
              ))
            )}
          </div>
        ) : null}

        {tab === 'resources' ? (
          <div className="space-y-3">
            <Callout kind="info" title="Access labels are explicit">
              "Free" means no payment anywhere. "Free to audit" means the content is readable without paying, usually without a
              certificate. If a provider changes its model, the label is wrong — the note next to each link tells you what was
              true when it was last checked.
            </Callout>
            {resources.map((resource) => (
              <Card key={resource.id} as="article">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold">{resource.name}</h3>
                  <Chip tone={accessTone('unknown')}>{resource.provider}</Chip>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Chip>{resource.accessBadge}</Chip>
                  <a
                    href={resource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-accent no-underline hover:underline"
                  >
                    Open link <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  </a>
                </div>
                <p className="mt-2 text-xs text-muted">
                  Opened in a new tab. This app does not track which links you open.
                </p>
              </Card>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <LinkButton to={`/gaps?career=${encodeURIComponent(career.id)}`} variant="primary">
          Analyse my gaps for this career
        </LinkButton>
        <LinkButton to={`/pathway?career=${encodeURIComponent(career.id)}`} variant="secondary">
          Build a career pathway
        </LinkButton>
        <LinkButton to={`/careers`} variant="ghost">
          Back to all careers
        </LinkButton>
      </div>

      <p className="mt-4 text-xs text-muted">
        {essential.length} essential and {optional.length} optional skills ·{' '}
        {formatHours([essential.reduce((sum) => sum + 6, 0), essential.reduce((sum) => sum + 18, 0)])}{' '}
        rough curriculum range for the essential set — a planning aid, not a measurement.
      </p>
    </div>
  )
}


