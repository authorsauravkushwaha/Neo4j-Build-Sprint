/**
 * Skill-gap analyzer.
 *
 * The categories are the product: separating "you are missing a prerequisite"
 * from "this is optional specialisation" is what stops people from drowning in
 * a list of a hundred unrelated courses.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Compass, Sparkles } from 'lucide-react'

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
  ProgressBar,
  SectionTitle,
  Select,
  Stat,
} from '@/components/ui.tsx'
import type { GapCategory } from '@core/types.ts'
import { api } from '@/core/session.ts'
import { GAP_CATEGORY_LABELS, GAP_CATEGORY_TONES, formatHours, formatNumber, formatWeeks, percent } from '@/core/format.ts'
import { ratingPayload, useAppStore } from '@/state/store.ts'
import { useCareerParam, useClientQuery } from '@/features/shared/hooks.ts'
import { SelfRating } from '@/features/shared/SelfRating.tsx'
import { FrontierPanel } from '@/features/gaps/FrontierPanel.tsx'
import { Stagger } from '@/skiper/components/Stagger.tsx'

const CATEGORY_ORDER: GapCategory[] = [
  'missing-prerequisite',
  'recommended-next',
  'ready-to-practice',
  'already-familiar',
  'optional-specialization',
]

export function GapsPage(): ReactNode {
  const { careerId, setCareerId } = useCareerParam()
  const profile = useAppStore((state) => state.profile)
  const ratings = useAppStore((state) => state.ratings)
  const resetRatings = useAppStore((state) => state.setRatingMap)
  const pushToast = useAppStore((state) => state.pushToast)
  const [interestOnly, setInterestOnly] = useState(false)

  const careers = useClientQuery(() => api().listCareers({}), [], 'the career list')
  const selected = careerId ?? profile.careerGoalId ?? careers.data?.careers[0]?.id ?? null

  const analysis = useClientQuery(
    () =>
      selected
        ? api().analyzeGaps({
            careerId: selected,
            ratings: ratingPayload(),
            interests: profile.interestIds,
            weeklyHours: profile.weeklyHours,
            difficultyComfort: profile.difficultyComfort,
          })
        : Promise.resolve({ data: null as never, meta: { source: 'unavailable' as const } }),
    [selected, ratings.length, profile.weeklyHours],
    'your skill gaps',
  )

  const report = analysis.data?.report ?? null
  /**
   * The same analysis, read as a delta. Computed by the engine from the same
   * inputs as the report above, so the two sections of this page cannot disagree
   * about what is missing.
   */
  const frontier = analysis.data?.frontier ?? null
  const items = useMemo(() => report?.items ?? [], [report])

  const visible = useMemo(
    () => (interestOnly ? items.filter((item) => item.scoreParts.goalRelevance > 0) : items),
    [items, interestOnly],
  )

  /**
   * Remaining effort, from the dataset's own per-skill hour ranges.
   *
   * This used to be a local heuristic (18–40 h per "advanced" skill, and so on),
   * which is how the same page managed to say "100–240 h" in the stat row while
   * the frontier panel said "410–1,030 h" from the same ratings: two hour models,
   * one screen, no way for a reader to tell which to believe. The dataset figure
   * is the honest one — it is per-skill, reviewable, and it includes the
   * prerequisites the career never lists. The heuristic survives only as a
   * fallback for a response that predates the frontier.
   */
  const totalHours = useMemo<[number, number]>(() => {
    if (frontier) return [frontier.hours.low, frontier.hours.high]
    const hoursFor = (difficulty: string): [number, number] =>
      difficulty === 'advanced' ? [18, 40] : difficulty === 'intermediate' ? [10, 24] : [5, 12]
    const relevant = items.filter((item) => item.category !== 'already-familiar')
    return relevant.reduce<[number, number]>(
      (sum, item) => [sum[0] + hoursFor(item.difficulty)[0], sum[1] + hoursFor(item.difficulty)[1]],
      [0, 0],
    )
  }, [frontier, items])

  const familiarCount = items.filter((item) => item.category === 'already-familiar').length

  return (
    <div>
      <PageHeader
        eyebrow="Skill-gap analyzer"
        title="What is actually missing — and what is not required"
        description="Rate your current level for the skills this career needs. The engine separates genuine prerequisites you are missing from optional specialisations you may never need."
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Sparkles className="h-4 w-4" />}
              onClick={() => {
                resetRatings([])
                pushToast({ kind: 'warning', message: 'All self-ratings cleared.', detail: 'The analysis is now from a clean slate.' })
              }}
              disabled={ratings.length === 0}
            >
              Clear my ratings
            </Button>
            {selected ? (
              <LinkButton to={`/roadmap?career=${encodeURIComponent(selected)}`} variant="primary">
                Plan this gap
              </LinkButton>
            ) : null}
          </>
        }
      />

      <Card className="mb-5">
        <Grid cols={2}>
          <Field label="Career" htmlFor="gaps-career">
            <Select id="gaps-career" value={selected ?? ''} onChange={(event) => setCareerId(event.target.value || null)}>
              {(careers.data?.careers ?? []).map((career) => (
                <option key={career.id} value={career.id}>
                  {career.name}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <p className="gm-label">Display</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--gm-accent)]"
                checked={interestOnly}
                onChange={(event) => setInterestOnly(event.target.checked)}
              />
              Only show skills the career actually requires
            </label>
            <p className="mt-1 text-xs text-muted">
              Optional skills stay in the list when this is off, clearly labelled — they are breadth, not requirements.
            </p>
          </div>
        </Grid>
      </Card>

      {analysis.status === 'loading' ? <Loading label="Comparing your ratings with the graph…" /> : null}
      {analysis.status === 'error' ? (
        <ErrorNotice message={analysis.error?.message ?? 'The analysis failed'} detail={analysis.error?.detail} onRetry={analysis.reload} />
      ) : null}

      {report ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Skills assessed" value={formatNumber(items.length)} hint={`${familiarCount} already familiar`} />
            <Stat label="Missing prerequisites" value={formatNumber(report.counts['missing-prerequisite'] ?? 0)} hint="Must come first" />
            <Stat label="Recommended next" value={formatNumber(report.counts['recommended-next'] ?? 0)} hint="Ready once prerequisites are met" />
            <Stat
              label="Remaining effort"
              value={formatHours(totalHours)}
              hint={`≈ ${formatWeeks(totalHours, profile.weeklyHours)} at ${profile.weeklyHours} h/week, including prerequisites the career does not list`}
            />
          </div>

          {/* The answer both audiences asked for: start here, and here is your delta. */}
          {frontier ? <FrontierPanel report={frontier} weeklyHours={profile.weeklyHours} /> : null}

          <Card>
            <SectionTitle hint="how much of the route is already covered">Coverage</SectionTitle>
            <ProgressBar value={familiarCount} max={Math.max(1, items.length)} label="Skills already familiar" />
            <p className="mt-2 text-xs text-muted">
              {percent(familiarCount, items.length)}% of the skills in the route are marked familiar or better in your own
              self-assessment. Self-ratings are estimates: the graph cannot verify them.
            </p>
          </Card>

          <Stagger className="space-y-4">
            {CATEGORY_ORDER.map((category) => {
              const categoryItems = visible.filter((item) => item.category === category)
              if (categoryItems.length === 0) return null
              return (
                <Card key={category}>
                  <SectionTitle hint={`${categoryItems.length} skill(s)`}>
                    <span className="inline-flex items-center gap-2">
                      {category === 'missing-prerequisite' ? (
                        <AlertTriangle aria-hidden="true" className="h-4 w-4 text-[var(--gm-danger)]" />
                      ) : category === 'already-familiar' ? (
                        <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-[var(--gm-success)]" />
                      ) : (
                        <Compass aria-hidden="true" className="h-4 w-4 text-accent" />
                      )}
                      {GAP_CATEGORY_LABELS[category]}
                    </span>
                  </SectionTitle>

                  <ul className="space-y-2">
                    {categoryItems.map((item) => (
                      <li key={item.skillId} className="rounded-lg border border-line p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={`/skills/${item.skillId}`} className="font-medium no-underline hover:underline">
                            {item.name}
                          </Link>
                          <DifficultyBadge difficulty={item.difficulty} />
                          <Chip tone={GAP_CATEGORY_TONES[item.category]}>{GAP_CATEGORY_LABELS[item.category]}</Chip>
                          {item.isEssential ? <Chip tone="accent">Essential</Chip> : <Chip>Optional</Chip>}
                          <Chip title="Transparent blend of the five scoring factors">score {Math.round(item.score)}</Chip>
                          {item.blockedBy.length > 0 ? <Chip tone="danger">{item.blockedBy.length} blocked by prerequisites</Chip> : null}
                        </div>
                        <p className="mt-1 text-sm text-muted">{item.reason}</p>
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-accent">Why this score</summary>
                          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted sm:grid-cols-3">
                            <div>
                              <dt className="inline">Goal relevance: </dt>
                              <dd className="inline font-medium">{Math.round(item.scoreParts.goalRelevance * 100)}%</dd>
                            </div>
                            <div>
                              <dt className="inline">Unlocks: </dt>
                              <dd className="inline font-medium">{Math.round(item.scoreParts.prerequisiteCentrality * 100)}%</dd>
                            </div>
                            <div>
                              <dt className="inline">Your gap: </dt>
                              <dd className="inline font-medium">{Math.round(item.scoreParts.gap * 100)}%</dd>
                            </div>
                            <div>
                              <dt className="inline">Interest fit: </dt>
                              <dd className="inline font-medium">{Math.round(item.scoreParts.interestFit * 100)}%</dd>
                            </div>
                            <div>
                              <dt className="inline">Effort penalty: </dt>
                              <dd className="inline font-medium">{Math.round(item.scoreParts.effortPenalty * 100)}%</dd>
                            </div>
                          </dl>
                          <p className="mt-1 text-xs text-muted">
                            Weights 0.35 goal relevance, 0.25 prerequisite centrality, 0.20 gap, 0.10 interest fit,
                            minus a 0.20 effort penalty — as documented in docs/recommendation-engine.md. Lower score = do it
                            sooner.
                          </p>
                        </details>
                        <div className="mt-2">
                          <SelfRating skillId={item.skillId} skillName={item.name} compact />
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )
            })}
          </Stagger>

          {analysis.data && analysis.data.projects.length > 0 ? (
            <Card>
              <SectionTitle hint="portfolio evidence that closes the most gap at once">Projects that fit this gap</SectionTitle>
              <ul className="space-y-2">
                {analysis.data.projects.map((project) => (
                  <li key={project.id} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{project.name}</span>
                      <DifficultyBadge difficulty={project.difficulty} />
                      <Chip tone="violet">{percent(project.coverage, 1)}% gap coverage</Chip>
                    </div>
                    <p className="mt-1 text-sm text-muted">{project.matchReason}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <LinkButton to={`/projects?career=${encodeURIComponent(selected ?? '')}`} variant="ghost">
                  All projects
                </LinkButton>
              </div>
            </Card>
          ) : null}

          {report.optionalPaths.length > 0 ? (
            <Card>
              <SectionTitle hint="not required by this career, but often seen in job adverts">Optional directions</SectionTitle>
              <ul className="space-y-1 text-sm">
                {report.optionalPaths.map((path) => (
                  <li key={path.skillId}>
                    <Link to={`/skills/${path.skillId}`} className="no-underline hover:underline">
                      {path.name}
                    </Link>{' '}
                    <span className="text-muted">— {path.reason}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <SectionTitle hint="the analysis says what it cannot know">Caveats</SectionTitle>
            <List items={report.caveats} />
          </Card>
        </div>
      ) : null}

      {!report && analysis.status !== 'loading' ? (
        <EmptyState title="Choose a career to analyse" action={<LinkButton to="/careers" variant="primary">Browse careers</LinkButton>}>
          Gap analysis needs a target: "missing" only means anything relative to a specific direction.
        </EmptyState>
      ) : null}

      <div className="mt-5">
        <Callout kind="info" title="Scoring is deterministic and documented">
          No AI model scores your skills. The five weighted terms, the two category thresholds (0.7 familiar, 0.6 prerequisite
          met) and the pace multipliers live in docs/recommendation-engine.md and in
          supabase/functions/_shared/core/recommend.ts. You can read the exact formula and check the arithmetic yourself.
        </Callout>
      </div>
    </div>
  )
}


