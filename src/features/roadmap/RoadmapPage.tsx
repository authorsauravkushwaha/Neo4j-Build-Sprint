/**
 * Personalised roadmap: the weekly plan, with progress the learner controls.
 *
 * Working rules:
 *   - nothing is marked complete for you, and no streak or score is invented,
 *   - prerequisites are never scheduled after the skills that need them (the
 *     engine proves this, and the validator checks it for every career),
 *   - tasks larger than a week's capacity are flagged rather than split into fake
 *     sub-tasks,
 *   - progress is stored locally for guests, and can be exported or reset at any
 *     time; signing in adds a server copy.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { CalendarPlus, CloudUpload, Download, Printer, RefreshCw, Route, Trash2 } from 'lucide-react'

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
  TextInput,
} from '@/components/ui.tsx'
import type { RoadmapTask, TaskStatus } from '@core/types.ts'
import { api } from '@/core/session.ts'
import { TASK_STATUS_LABELS, formatHours, formatNumber, formatWeeks, percent } from '@/core/format.ts'
import { loadLocalRoadmaps, saveLocalRoadmaps, type LocalSavedRoadmap } from '@/core/persistence.ts'
import { ratingPayload, useAppStore } from '@/state/store.ts'
import { useCareerParam, useClientQuery } from '@/features/shared/hooks.ts'

const STATUS_ORDER: TaskStatus[] = ['not-started', 'in-progress', 'completed', 'needs-review']

export function RoadmapPage(): ReactNode {
  const { careerId, setCareerId } = useCareerParam()
  const profile = useAppStore((state) => state.profile)
  const ratings = useAppStore((state) => state.ratings)
  const progress = useAppStore((state) => state.progress)
  const setTaskStatus = useAppStore((state) => state.setTaskStatus)
  const resetRoadmapProgress = useAppStore((state) => state.resetRoadmapProgress)
  const pushToast = useAppStore((state) => state.pushToast)

  const [weeklyHours, setWeeklyHours] = useState(profile.weeklyHours)
  const [pace, setPace] = useState(profile.preferredPace)
  const [title, setTitle] = useState('')
  const [confirmReset, setConfirmReset] = useState('')
  const session = useAppStore((state) => state.session)
  /** Links this plan to its server copy, if one exists. */
  const [savedLinks, setSavedLinks] = useState<LocalSavedRoadmap[]>(() => loadLocalRoadmaps())
  const [saving, setSaving] = useState(false)

  const careers = useClientQuery(() => api().listCareers({}), [], 'the career list')
  const selected = careerId ?? profile.careerGoalId ?? careers.data?.careers[0]?.id ?? null

  const roadmap = useClientQuery(
    () =>
      selected
        ? api().generateRoadmap({
            careerId: selected,
            ratings: ratingPayload(),
            interests: profile.interestIds,
            weeklyHours,
            pace,
            learningStyle: profile.learningStyle,
            difficultyComfort: profile.difficultyComfort,
            ...(title ? { title } : {}),
          })
        : Promise.resolve({ data: null as never, meta: { source: 'unavailable' as const } }),
    [selected, ratings.length, weeklyHours, pace, title],
    'your roadmap',
  )

  const data = roadmap.data
  const roadmapKey = useMemo(
    () => data?.roadmap.id ?? `career:${selected ?? 'none'}`,
    [data?.roadmap.id, selected],
  )
  const localProgress = progress[roadmapKey]?.tasks ?? {}

  const tasks = useMemo(() => data?.roadmap.tasks ?? [], [data])
  const weeks = useMemo(() => {
    const map = new Map<number, RoadmapTask[]>()
    for (const task of tasks) {
      const list = map.get(task.scheduledWeek) ?? []
      list.push(task)
      map.set(task.scheduledWeek, list)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [tasks])

  const summary = useMemo(() => {
    const completed = tasks.filter((task) => (localProgress[task.taskKey]?.status ?? task.status) === 'completed').length
    const review = tasks.filter((task) => (localProgress[task.taskKey]?.status ?? task.status) === 'needs-review').length
    const hours = tasks.reduce((sum, task) => sum + (localProgress[task.taskKey]?.actualHours ?? 0), 0)
    const estimated: [number, number] = [0, 0]
    for (const task of tasks) {
      estimated[0] += task.estimatedHours[0]
      estimated[1] += task.estimatedHours[1]
    }
    return { completed, review, hours, estimated }
  }, [tasks, localProgress])

  const savedLink = useMemo(
    () => savedLinks.find((entry) => entry.roadmapId === roadmapKey) ?? null,
    [savedLinks, roadmapKey],
  )
  // Guests always work; only a signed-in learner with a live backend can keep a
  // server copy, and the button below is the only thing that creates one.
  const canSave = session !== null && api().mode === 'live'

  const saveToAccount = async (): Promise<void> => {
    if (!data || saving) return
    setSaving(true)
    try {
      const result = await api().saveRoadmap({
        careerId: data.roadmap.careerId,
        title: data.roadmap.title,
        weeklyHours,
        pace,
        tasks: data.roadmap.tasks.map((task) => ({
          skillId: task.skillId,
          name: task.name,
          order: task.order,
          scheduledWeek: task.scheduledWeek,
          estimatedHoursLow: task.estimatedHours[0],
          estimatedHoursHigh: task.estimatedHours[1],
          taskKey: task.taskKey,
          kind: task.kind,
          essential: task.essential,
          status: localProgress[task.taskKey]?.status ?? task.status,
          difficulty: task.difficulty,
        })),
      })
      const entry: LocalSavedRoadmap = {
        roadmapId: result.data.roadmapId,
        title: data.roadmap.title,
        careerId: data.roadmap.careerId,
        weeklyHours,
        pace,
        taskCount: result.data.taskCount,
        taskIds: result.data.taskIds,
        tasks: data.roadmap.tasks.map((task) => ({
          skillId: task.skillId,
          name: task.name,
          order: task.order,
          scheduledWeek: task.scheduledWeek,
          estimatedHoursLow: task.estimatedHours[0],
          estimatedHoursHigh: task.estimatedHours[1],
          taskKey: task.taskKey,
          kind: task.kind,
        })),
        savedAt: new Date().toISOString(),
        storedOn: 'account',
      }
      const next = [entry, ...savedLinks.filter((item) => item.roadmapId !== entry.roadmapId)]
      saveLocalRoadmaps(next)
      setSavedLinks(next)
      pushToast({
        kind: 'success',
        message: 'Saved to your account.',
        detail: `${result.data.taskCount} task rows stored. This plan now follows you to another device.`,
      })
    } catch (error) {
      pushToast({
        kind: 'warning',
        message: 'Could not save this plan to your account.',
        detail: `${error instanceof Error ? error.message : 'The request failed.'} Your plan and progress still work on this device.`,
      })
    } finally {
      setSaving(false)
    }
  }

  /**
   * Mirror one status change to the server copy when there is one.
   *
   * The local write happens first and is never rolled back: a network failure
   * must not lose what the learner just did. The toast says exactly which copy
   * was updated, because "saved" would otherwise be a guess.
   */
  const mirrorProgress = (task: RoadmapTask, status: TaskStatus, actualHours?: number): void => {
    const link = savedLinks.find((entry) => entry.roadmapId === roadmapKey)
    if (!link || api().mode !== 'live' || !session) return
    const taskId = link.taskIds[task.taskKey]
    if (!taskId) return
    void api()
      .updateProgress({
        roadmapId: link.roadmapId,
        taskId,
        taskKey: task.taskKey,
        skillId: task.skillId,
        status,
        ...(typeof actualHours === 'number' ? { actualHours } : {}),
      })
      .catch((error: unknown) => {
        pushToast({
          kind: 'warning',
          message: 'Saved on this device, but not to your account.',
          detail: `${error instanceof Error ? error.message : 'The request failed.'} It will not sync by itself.`,
        })
      })
  }

  const exportRoadmap = (): void => {
    if (!data) return
    const lines: string[] = [
      `# ${data.roadmap.title}`,
      '',
      `Career: ${data.roadmap.careerName}`,
      `Weekly budget: ${weeklyHours} h (${pace} pace)`,
      `Estimated total: ${formatHours(summary.estimated)} — a planning estimate, not a promise.`,
      '',
      data.roadmap.estimateDisclaimer,
      '',
    ]
    for (const [week, weekTasks] of weeks) {
      lines.push(`## Week ${week}`)
      for (const task of weekTasks) {
        const status = localProgress[task.taskKey]?.status ?? task.status
        lines.push(`- [${status === 'completed' ? 'x' : status === 'in-progress' ? '~' : ' '}] ${task.name} (${formatHours(task.estimatedHours)}) — ${TASK_STATUS_LABELS[status]}`)
        lines.push(`  - Why here: ${task.reason}`)
        if (task.dependsOn.length > 0) lines.push(`  - Needs first: ${task.dependsOn.join(', ')}`)
      }
      lines.push('')
    }
    lines.push('## Caveats')
    for (const caveat of data.pathwayMeta.caveats) lines.push(`- ${caveat}`)

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${data.roadmap.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'roadmap'}.md`
    anchor.click()
    URL.revokeObjectURL(url)
    pushToast({ kind: 'success', message: 'Roadmap downloaded as Markdown.', detail: 'Includes your statuses and the caveats.' })
  }

  const exportCalendar = (): void => {
    if (!data) return
    // One all-day Monday event per planned week, in the .ics format every
    // calendar app imports. Dates are computed from today; the file says in
    // its description that the estimates are planning aids, not commitments.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
    const day = 86_400_000
    const monday = new Date()
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    const ymd = (date: Date): string => date.toISOString().slice(0, 10).replace(/-/g, '')
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GraphMentor AI//Roadmap//EN',
      'CALSCALE:GREGORIAN',
    ]
    for (const [week, weekTasks] of weeks) {
      const start = new Date(monday.getTime() + (week - 1) * 7 * day)
      const end = new Date(start.getTime() + day)
      const names = weekTasks.map((task) => task.name).join(', ').replace(/[,;\n]/g, ' ')
      lines.push(
        'BEGIN:VEVENT',
        `UID:graphmentor-${data.roadmap.careerId}-week-${week}@graphmentor.local`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${ymd(start)}`,
        `DTEND;VALUE=DATE:${ymd(end)}`,
        `SUMMARY:GraphMentor week ${week}: ${names.slice(0, 120)}`,
        `DESCRIPTION:${data.roadmap.title} — about ${weeklyHours} h this week. Curriculum estimate\, not a commitment.`,
        'END:VEVENT',
      )
    }
    lines.push('END:VCALENDAR')
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${data.roadmap.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'roadmap'}.ics`
    anchor.click()
    URL.revokeObjectURL(url)
    pushToast({ kind: 'success', message: 'Calendar file downloaded.', detail: 'Import it into any calendar app — one event per study week.' })
  }

  return (
    <div>
      <PageHeader
        eyebrow="Personalised roadmap"
        title={data?.roadmap.title ?? 'Your study plan'}
        description="Scheduled in dependency order, sized to the hours you actually have. Every estimate is a curriculum range, and you can re-plan at any time."
        actions={
          <>
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={exportRoadmap} disabled={!data}>
              Export Markdown
            </Button>
            <Button variant="secondary" icon={<CalendarPlus className="h-4 w-4" />} onClick={exportCalendar} disabled={!data}>
              Add to calendar
            </Button>
            <Button variant="ghost" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()} disabled={!data}>
              Print
            </Button>
            {canSave ? (
              <Button
                variant="primary"
                icon={<CloudUpload className="h-4 w-4" />}
                onClick={() => void saveToAccount()}
                disabled={!data || saving}
              >
                {saving ? 'Saving…' : savedLink ? 'Save changes to my account' : 'Save to my account'}
              </Button>
            ) : null}
            <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={roadmap.reload}>
              Re-plan
            </Button>
          </>
        }
      />

      <Card className="mb-5">
        <Grid cols={3}>
          <Field label="Career" htmlFor="roadmap-career">
            <Select id="roadmap-career" value={selected ?? ''} onChange={(event) => setCareerId(event.target.value || null)}>
              {(careers.data?.careers ?? []).map((career) => (
                <option key={career.id} value={career.id}>
                  {career.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Hours per week" htmlFor="roadmap-hours">
            <Select
              id="roadmap-hours"
              value={weeklyHours}
              onChange={(event) => {
                const value = Number(event.target.value)
                setWeeklyHours(value)
                useAppStore.getState().setProfile({ weeklyHours: value })
              }}
            >
              {[3, 5, 8, 10, 15, 20, 30].map((hours) => (
                <option key={hours} value={hours}>
                  {hours} h
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pace" htmlFor="roadmap-pace">
            <Select
              id="roadmap-pace"
              value={pace}
              onChange={(event) => {
                const value = event.target.value as typeof pace
                setPace(value)
                useAppStore.getState().setProfile({ preferredPace: value })
              }}
            >
              <option value="relaxed">Relaxed</option>
              <option value="steady">Steady</option>
              <option value="intensive">Intensive</option>
            </Select>
          </Field>
        </Grid>
        <Field label="Plan title (optional)" htmlFor="roadmap-title" hint="Used in the exported file and in the saved roadmap name.">
          <TextInput
            id="roadmap-title"
            value={title}
            maxLength={80}
            placeholder="e.g. Embedded firmware, evenings"
            onChange={(event) => setTitle(event.target.value.slice(0, 80))}
          />
        </Field>
      </Card>

      {roadmap.status === 'loading' ? <Loading label="Scheduling your plan…" /> : null}
      {roadmap.status === 'error' ? (
        <ErrorNotice message={roadmap.error?.message ?? 'The roadmap could not be generated'} detail={roadmap.error?.detail} onRetry={roadmap.reload} />
      ) : null}

      {data ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Tasks" value={formatNumber(tasks.length)} hint={`${weeks.length} weeks`} />
            <Stat label="Completed" value={formatNumber(summary.completed)} hint={`${percent(summary.completed, tasks.length)}% of the plan`} />
            <Stat label="Logged hours" value={`${formatNumber(Math.round(summary.hours))} h`} hint="From your own entries" />
            <Stat label="Needs review" value={formatNumber(summary.review)} hint="You flagged these" />
          </div>

          <Card>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm text-muted">Plan progress</span>
              <span className="text-sm font-medium">
                {summary.completed} of {tasks.length} tasks
              </span>
            </div>
            <ProgressBar value={summary.completed} max={Math.max(1, tasks.length)} label="Tasks completed" />
            <p className="mt-2 text-xs text-muted">
              Estimated total {formatHours(summary.estimated)} · at {weeklyHours} h/week this is{' '}
              {formatWeeks(summary.estimated, weeklyHours)}
              {weeks.length > 0
                ? ` — starting this week, that lands around ${new Date(Date.now() + weeks.length * 7 * 86_400_000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} if nothing slips`
                : ''}
              . {data.roadmap.estimateDisclaimer}
            </p>
          </Card>

          {tasks.length === 0 ? (
            <EmptyState title="There is nothing to schedule">
              Every required skill is already marked familiar. Try another career, or add an optional specialisation.
            </EmptyState>
          ) : null}

          {weeks.map(([week, weekTasks]) => {
            const weekHours = weekTasks.reduce((sum, task) => sum + (task.estimatedHours[0] + task.estimatedHours[1]) / 2, 0)
            return (
              <Card key={week}>
                <SectionTitle hint={`≈ ${formatNumber(Math.round(weekHours))} h of work`}>Week {week}</SectionTitle>
                <ul className="space-y-3">
                  {weekTasks.map((task) => {
                    const status = localProgress[task.taskKey]?.status ?? task.status
                    const overdue = task.scheduledWeek < week
                    return (
                      <li key={task.taskKey} className="rounded-lg border border-line p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{task.name}</span>
                          <DifficultyBadge difficulty={task.difficulty} />
                          <Chip>{formatHours(task.estimatedHours)}</Chip>
                          {task.kind === 'review' ? <Chip tone="violet">Review</Chip> : null}
                          {task.essential ? <Chip tone="accent">Essential</Chip> : <Chip>Optional</Chip>}
                          {status === 'completed' ? <Chip tone="success">Completed</Chip> : null}
                          {status === 'needs-review' ? <Chip tone="warning">Needs review</Chip> : null}
                          {status === 'in-progress' ? <Chip tone="violet">In progress</Chip> : null}
                          {overdue ? <Chip tone="danger">Carried over</Chip> : null}
                        </div>
                        <p className="mt-1 text-sm text-muted">{task.reason}</p>

                        {task.dependsOn.length > 0 ? (
                          <p className="mt-1 text-xs text-muted">
                            Needs first:{' '}
                            {task.dependsOn.map((id) => tasks.find((entry) => entry.skillId === id)?.name ?? id.replace(/^skill:/, '').replace(/-/g, ' ')).join(', ')}
                          </p>
                        ) : null}

                        {task.practice.length > 0 ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs text-accent">Practice and completion criteria</summary>
                            <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <List items={task.practice.slice(0, 4)} />
                              <List items={task.completionCriteria.slice(0, 4)} />
                            </div>
                          </details>
                        ) : null}

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <label className="text-xs text-muted" htmlFor={`status-${task.taskKey}`}>
                            Status
                          </label>
                          <Select
                            id={`status-${task.taskKey}`}
                            value={status}
                            className="w-auto"
                            onChange={(event) => {
                              const next = event.target.value as TaskStatus
                              // Progress is keyed by the row, not the skill: a
                              // spaced-review row repeats its skill's id.
                              setTaskStatus(roadmapKey, task.taskKey, next, { skillId: task.skillId })
                              mirrorProgress(task, next)
                              if (next === 'completed') {
                                pushToast({
                                  kind: 'success',
                                  message: `Marked "${task.name}" complete.`,
                                  detail: savedLink ? 'Saved on this device and to your account.' : 'Kept on this device.',
                                })
                              }
                            }}
                          >
                            {STATUS_ORDER.map((value) => (
                              <option key={value} value={value}>
                                {TASK_STATUS_LABELS[value]}
                              </option>
                            ))}
                          </Select>
                          <LinkButton to={`/skills/${task.skillId}`} size="sm" variant="ghost">
                            Open skill
                          </LinkButton>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </Card>
            )
          })}

          <Card>
            <SectionTitle hint="what this plan cannot promise">Caveats from the planner</SectionTitle>
            <List items={data.pathwayMeta.caveats} />
          </Card>

          <Card>
            <SectionTitle hint="irreversible actions ask for confirmation">Reset progress</SectionTitle>
            <p className="text-sm text-muted">
              Clearing progress removes every status and logged hour for this plan. The plan itself is regenerated from the graph at
              any time, so nothing about the curriculum is lost.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-[220px]">
                <Field label={`Type RESET to confirm`} htmlFor="reset-roadmap" hint="A deliberate speed bump; there is no undo.">
                  <TextInput
                    id="reset-roadmap"
                    value={confirmReset}
                    onChange={(event) => setConfirmReset(event.target.value)}
                    placeholder="RESET"
                  />
                </Field>
              </div>
              <Button
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                disabled={confirmReset.trim().toUpperCase() !== 'RESET'}
                onClick={() => {
                  resetRoadmapProgress(roadmapKey)
                  setConfirmReset('')
                  pushToast({ kind: 'warning', message: 'Progress cleared for this plan.' })
                  const link = savedLinks.find((entry) => entry.roadmapId === roadmapKey)
                  if (link && api().mode === 'live' && session) {
                    void api()
                      .resetProgress({ roadmapId: link.roadmapId, confirm: 'RESET' })
                      .catch((error: unknown) => {
                        pushToast({
                          kind: 'warning',
                          message: 'Cleared on this device, but the server copy still has the old progress.',
                          detail: error instanceof Error ? error.message : 'The request failed.',
                        })
                      })
                  }
                }}
              >
                Clear progress
              </Button>
            </div>
          </Card>

          <Callout kind="info" title="Where this plan is stored">
            {useAppStore.getState().session
              ? 'You are signed in, so progress is stored in your account and can be exported or deleted from Settings.'
              : 'Progress is stored in this browser only, under a key you can erase from Settings. Signing in copies it to your account if you want it on another device.'}
          </Callout>

          <div className="flex flex-wrap gap-2">
            <LinkButton to={`/gaps?career=${encodeURIComponent(data.roadmap.careerId)}`} variant="secondary">
              Re-check my gaps
            </LinkButton>
            <LinkButton to="/progress" variant="secondary" icon={<Route className="h-4 w-4" />}>
              All progress
            </LinkButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}


