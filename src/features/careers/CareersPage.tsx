/**
 * Career explorer — the entry point into the graph.
 *
 * Search and filters run against the same reader the rest of the app uses, so
 * the list can never disagree with the career pages. Each card links into the
 * graph view and into the analysis screens with the career already selected.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { GitBranch, Search } from 'lucide-react'

import { Button, Callout, Card, Chip, DifficultyBadge, EmptyState, ErrorNotice, Grid, LinkButton, Loading, PageHeader, SectionTitle, Select, TextInput } from '@/components/ui.tsx'
import { api } from '@/core/session.ts'
import { formatNumber } from '@/core/format.ts'
import { useAppStore } from '@/state/store.ts'
import { useClientQuery } from '@/features/shared/hooks.ts'

export function CareersPage(): ReactNode {
  const [query, setQuery] = useState('')
  const [branch, setBranch] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const setProfile = useAppStore((state) => state.setProfile)
  const goalId = useAppStore((state) => state.profile.careerGoalId)

  const careers = useClientQuery(
    () => api().listCareers({ ...(query ? { q: query } : {}), ...(branch ? { branchId: branch } : {}), ...(difficulty ? { difficulty } : {}) }),
    [query, branch, difficulty],
    'careers',
  )

  const branches = useMemo(() => careers.data?.branches ?? [], [careers.data])
  const results = careers.data?.careers ?? []

  // Side-by-side comparison: two careers, the same honest fields for both.
  const [compareIds, setCompareIds] = useState<string[]>([])
  const toggleCompare = (id: string): void =>
    setCompareIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current.slice(-1), id]))
  const compared = compareIds
    .map((id) => (careers.data?.careers ?? []).find((career) => career.id === id))
    .filter((career) => career !== undefined)

  return (
    <div>
      <PageHeader
        eyebrow="Career explorer"
        title="Engineering directions you can build towards"
        description="Each career lists the skills the curriculum treats as essential, the ones that are optional, the branches it sits in, and projects that prove the skills."
        actions={
          <LinkButton to="/graph" variant="secondary" icon={<GitBranch className="h-4 w-4" />}>
            Open the graph explorer
          </LinkButton>
        }
      />

      <Card className="mb-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="gm-label" htmlFor="career-search">
              Search
            </label>
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted" />
              <TextInput
                id="career-search"
                className="pl-8"
                placeholder="e.g. robot, solar, security"
                value={query}
                maxLength={60}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="gm-label" htmlFor="career-branch">
              Branch
            </label>
            <Select id="career-branch" value={branch} onChange={(event) => setBranch(event.target.value)}>
              <option value="">All branches</option>
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.careerCount})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="gm-label" htmlFor="career-difficulty">
              Curriculum level
            </label>
            <Select id="career-difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option value="">Any level</option>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </Select>
          </div>
        </div>
        <p aria-live="polite" className="mt-3 text-xs text-muted">
          {careers.status === 'ready' ? `${formatNumber(results.length)} career${results.length === 1 ? '' : 's'} match.` : 'Searching…'}
          {goalId ? ' Your current goal is highlighted.' : ''}
        </p>
        {(query || branch || difficulty) && (
          <div className="mt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery('')
                setBranch('')
                setDifficulty('')
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      {careers.status === 'loading' ? <Loading label="Loading careers from the graph…" /> : null}
      {careers.status === 'error' ? (
        <ErrorNotice message={careers.error?.message ?? 'Could not load careers'} detail={careers.error?.detail} onRetry={careers.reload} />
      ) : null}
      {careers.status === 'ready' && results.length === 0 ? (
        <EmptyState title="No career matches those filters">
          Try a different word, or clear the filters. The catalogue is deliberately small: {formatNumber(branches.length)} branches,
          each with a few well-described directions rather than hundreds of thin entries.
        </EmptyState>
      ) : null}

      <Grid cols={2}>
        {results.map((career) => {
          const isGoal = goalId === career.id
          const branchNames = career.branchIds
            .map((id) => branches.find((item) => item.id === id)?.name ?? id.replace('branch:', '').replace(/-/g, ' '))
            .slice(0, 2)
          return (
            <Card key={career.id} as="article" className={isGoal ? 'border-accent' : ''}>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">
                  <Link to={`/careers/${career.id}`} className="no-underline hover:underline">
                    {career.name}
                  </Link>
                </h2>
                <DifficultyBadge difficulty={career.difficulty} />
                {isGoal ? <Chip tone="accent">Your goal</Chip> : null}
              </div>
              <p className="text-sm text-muted">{career.summary}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {branchNames.map((name) => (
                  <Chip key={name}>{name}</Chip>
                ))}
                <Chip title="Skills the graph links to this career">{formatNumber(career.skillCount)} skills</Chip>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <LinkButton to={`/careers/${career.id}`} variant="secondary" size="sm">
                  Details
                </LinkButton>
                <LinkButton to={`/graph?career=${encodeURIComponent(career.id)}`} variant="ghost" size="sm">
                  Graph
                </LinkButton>
                <LinkButton to={`/gaps?career=${encodeURIComponent(career.id)}`} variant="ghost" size="sm">
                  Gap analysis
                </LinkButton>
                {!isGoal ? (
                  <Button size="sm" variant="ghost" onClick={() => setProfile({ careerGoalId: career.id })}>
                    Set as goal
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant={compareIds.includes(career.id) ? 'secondary' : 'ghost'}
                  aria-pressed={compareIds.includes(career.id)}
                  onClick={() => toggleCompare(career.id)}
                >
                  {compareIds.includes(career.id) ? 'Comparing ✓' : 'Compare'}
                </Button>
              </div>
            </Card>
          )
        })}
      </Grid>

      {compared.length === 2 ? (
        <Card className="mt-5" as="section">
          <SectionTitle hint="same fields, both careers — no ranking, no winner declared">Side by side</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            {compared.map((career) => (
              <div key={career.id}>
                <h3 className="text-sm font-semibold">
                  <Link to={`/careers/${career.id}`} className="no-underline hover:underline">
                    {career.name}
                  </Link>
                </h3>
                <p className="mt-1 text-sm text-muted">{career.summary}</p>
                <dl className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Curriculum level</dt>
                    <dd>
                      <DifficultyBadge difficulty={career.difficulty} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Skills in the graph</dt>
                    <dd>{formatNumber(career.skillCount)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Branches</dt>
                    <dd className="text-right">
                      {career.branchIds
                        .map((id) => branches.find((item) => item.id === id)?.name ?? id.replace('branch:', '').replace(/-/g, ' '))
                        .join(', ')}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3">
                  <LinkButton to={`/careers/${career.id}`} variant="secondary" size="sm">
                    Open the full page
                  </LinkButton>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            {compared[0] && compared[1]
              ? compared[0].skillCount === compared[1].skillCount
                ? 'Both directions rest on the same number of graph skills — the difference is which ones, and the pages above list them.'
                : `${compared[0].name} rests on ${formatNumber(Math.abs(compared[0].skillCount - compared[1].skillCount))} ${
                    compared[0].skillCount > compared[1].skillCount ? 'more' : 'fewer'
                  } graph skills than ${compared[1].name}. More skills is a longer path, not a better career.`
              : null}{' '}
            Skill counts come from the curriculum graph, not from job-market data.
          </p>
          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={() => setCompareIds([])}>
              Clear comparison
            </Button>
          </div>
        </Card>
      ) : compareIds.length === 1 ? (
        <p aria-live="polite" className="mt-3 text-xs text-muted">
          Pick one more career&apos;s Compare button to see them side by side.
        </p>
      ) : null}

      <div className="mt-6">
        <Callout kind="info" title="How these careers were chosen">
          This is a curated sample curriculum, not a labour-market database. Career descriptions describe typical work and
          common foundations; entry requirements differ between countries, employers and years. Nothing here is a hiring bar or
          a guarantee.
        </Callout>
      </div>
    </div>
  )
}


