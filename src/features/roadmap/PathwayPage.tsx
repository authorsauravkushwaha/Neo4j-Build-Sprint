/**
 * Career pathway builder.
 *
 * This is the *reasoning* view: it shows the dependency-ordered route to a
 * career, why each step is where it is, which steps are essential, what each
 * step unlocks, and the alternative routes the graph offers. The week-by-week
 * schedule lives in the roadmap screen.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, GitBranch } from 'lucide-react'

import {
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
  SectionTitle,
  Select,
  Stat,
} from '@/components/ui.tsx'
import { api } from '@/core/session.ts'
import { formatHours, formatNumber, formatWeeks } from '@/core/format.ts'
import { ratingPayload, useAppStore } from '@/state/store.ts'
import { useCareerParam, useClientQuery } from '@/features/shared/hooks.ts'
import { Stagger } from '@/skiper/components/Stagger.tsx'

export function PathwayPage(): ReactNode {
  const { careerId, setCareerId } = useCareerParam()
  const profile = useAppStore((state) => state.profile)
  const setProfile = useAppStore((state) => state.setProfile)
  const ratings = useAppStore((state) => state.ratings)
  const [pace, setPace] = useState(profile.preferredPace)
  const [weeklyHours, setWeeklyHours] = useState(profile.weeklyHours)

  const careers = useClientQuery(() => api().listCareers({}), [], 'the career list')
  const selected = careerId ?? profile.careerGoalId ?? careers.data?.careers[0]?.id ?? null

  const pathway = useClientQuery(
    () =>
      selected
        ? api().getCareerPath({
            careerId: selected,
            ratings: ratingPayload(),
            interests: profile.interestIds,
            weeklyHours,
            pace,
            learningStyle: profile.learningStyle,
            difficultyComfort: profile.difficultyComfort,
          })
        : Promise.resolve({ data: null as never, meta: { source: 'unavailable' as const } }),
    [selected, ratings.length, weeklyHours, pace],
    'this pathway',
  )

  const steps = pathway.data?.pathway.steps ?? []
  const essentialSteps = useMemo(() => steps.filter((step) => step.essential), [steps])
  const optionalSteps = useMemo(() => steps.filter((step) => !step.essential), [steps])

  return (
    <div>
      <PageHeader
        eyebrow="Career pathway builder"
        title="The route to a career, in dependency order"
        description="Each step appears only after the skills it depends on. Where the graph offers more than one route, both are shown with their trade-offs rather than hidden."
        actions={
          selected ? (
            <LinkButton to={`/roadmap?career=${encodeURIComponent(selected)}`} variant="primary" icon={<ArrowRight className="h-4 w-4" />}>
              Turn this into a weekly roadmap
            </LinkButton>
          ) : null
        }
      />

      <Card className="mb-5">
        <Grid cols={2}>
          <Field label="Career" htmlFor="pathway-career">
            <Select id="pathway-career" value={selected ?? ''} onChange={(event) => setCareerId(event.target.value || null)}>
              {(careers.data?.careers ?? []).map((career) => (
                <option key={career.id} value={career.id}>
                  {career.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hours per week" htmlFor="pathway-hours">
              <Select
                id="pathway-hours"
                value={weeklyHours}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setWeeklyHours(value)
                  setProfile({ weeklyHours: value })
                }}
              >
                {[3, 5, 8, 10, 15, 20, 30].map((hours) => (
                  <option key={hours} value={hours}>
                    {hours} h
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pace" htmlFor="pathway-pace">
              <Select
                id="pathway-pace"
                value={pace}
                onChange={(event) => {
                  const value = event.target.value as typeof pace
                  setPace(value)
                  setProfile({ preferredPace: value })
                }}
              >
                <option value="relaxed">Relaxed</option>
                <option value="steady">Steady</option>
                <option value="intensive">Intensive</option>
              </Select>
            </Field>
          </div>
        </Grid>
        <p className="mt-2 text-xs text-muted">
          Pace scales the weekly capacity (relaxed ×0.75, steady ×1, intensive ×1.35). Changing it re-plans the schedule; it never
          changes what the graph says is required.
        </p>
      </Card>

      {pathway.status === 'loading' ? <Loading label="Ordering the pathway by dependencies…" /> : null}
      {pathway.status === 'error' ? (
        <ErrorNotice message={pathway.error?.message ?? 'The pathway could not be built'} detail={pathway.error?.detail} onRetry={pathway.reload} />
      ) : null}

      {pathway.status === 'ready' && pathway.data ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Steps" value={formatNumber(steps.length)} hint={`${essentialSteps.length} essential`} />
            <Stat label="Optional" value={formatNumber(optionalSteps.length)} hint="Not universally required" />
            <Stat label="Estimated effort" value={formatHours(pathway.data.pathway.estimatedHours)} hint="Curriculum range" />
            <Stat
              label="At your pace"
              value={formatWeeks(pathway.data.pathway.estimatedHours, weeklyHours)}
              hint={`${weeklyHours} h/week`}
            />
          </div>

          <Callout kind="info" title="How this order was produced">
            The engine built a prerequisite graph from the REQUIRES relationships, ran a topological sort with a deterministic
            tie-break, and then ranked ready steps by career relevance, how much they unlock, and your self-ratings. Nothing was
            asked of a language model, so the same inputs always produce the same plan.
          </Callout>

          {steps.length === 0 ? (
            <EmptyState title="Nothing left to plan for this career">
              Every skill in the graph for this career is already marked as familiar or practised in your self-ratings. Raise the
              target, or try another direction.
            </EmptyState>
          ) : null}

          <Card>
            <SectionTitle hint="prerequisites always come earlier">Ordered steps</SectionTitle>
            <Stagger as="ol" className="space-y-3">
              {steps.map((step, index) => (
                <li key={step.skillId} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="grid h-6 w-6 place-items-center rounded-full bg-[var(--gm-accent-soft)] text-xs font-semibold text-accent"
                    >
                      {index + 1}
                    </span>
                    <Link to={`/skills/${step.skillId}`} className="font-medium no-underline hover:underline">
                      {step.name}
                    </Link>
                    <DifficultyBadge difficulty={step.difficulty} />
                    <Chip tone={step.essential ? 'accent' : 'default'}>{step.essential ? 'Essential' : 'Optional'}</Chip>
                    <Chip>{formatHours(step.estimatedHours)}</Chip>
                  </div>
                  <p className="mt-1 text-sm text-muted">{step.reason}</p>
                  {step.dependsOn.length > 0 ? (
                    <p className="mt-1 text-xs text-muted">
                      Depends on:{' '}
                      {step.dependsOn
                        .map((id) => steps.find((entry) => entry.skillId === id)?.name ?? id.replace(/^skill:/, '').replace(/-/g, ' '))
                        .join(', ')}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted">No prerequisites in the graph — a valid entry point.</p>
                  )}
                  {step.milestoneProject ? (
                    <p className="mt-2 rounded-md border border-dashed border-line p-2 text-xs">
                      <strong>Milestone build:</strong> {step.milestoneProject.name} — {step.milestoneProject.why}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <LinkButton to={`/skills/${step.skillId}`} size="sm" variant="ghost">
                      Open skill
                    </LinkButton>
                    <LinkButton to={`/graph?seed=${encodeURIComponent(step.skillId)}`} size="sm" variant="ghost" icon={<GitBranch className="h-3.5 w-3.5" />}>
                      Graph
                    </LinkButton>
                  </div>
                </li>
              ))}
            </Stagger>
          </Card>

          {pathway.data.pathway.alternatives.length > 0 ? (
            <Card>
              <SectionTitle hint="same goal, different trade-offs">Alternative routes</SectionTitle>
              <div className="space-y-3">
                {pathway.data.pathway.alternatives.map((alternative) => (
                  <div key={alternative.id} className="rounded-lg border border-line p-3">
                    <h3 className="text-sm font-semibold">{alternative.title}</h3>
                    <p className="mt-1 text-sm text-muted">{alternative.description}</p>
                    <p className="mt-1 text-xs text-muted">
                      {formatHours(alternative.estimatedHours)} · {alternative.steps.length} steps
                    </p>
                    <p className="mt-1 text-xs">{alternative.tradeoff}</p>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-accent">Show the steps</summary>
                      <List items={alternative.steps} className="mt-1" />
                    </details>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <SectionTitle hint="applies to every plan this app produces">Caveats</SectionTitle>
            <List items={pathway.data.pathway.caveats} />
          </Card>
        </div>
      ) : null}

      {!selected ? (
        <EmptyState title="Pick a career to build a pathway" action={<LinkButton to="/careers" variant="primary">Browse careers</LinkButton>}>
          A pathway is always relative to a target role.
        </EmptyState>
      ) : null}
    </div>
  )
}


