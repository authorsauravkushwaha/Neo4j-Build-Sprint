/**
 * Progress: everything the learner has told the app about themselves, in one
 * place, with the controls to correct or erase it.
 *
 * Deliberately not gamified: totals and honest summaries, no streaks, no points,
 * no comparison with other users (there is no way to compare — nothing is
 * aggregated across accounts).
 */
import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Bookmark, Download, Trash2 } from 'lucide-react'

import {
  Button,
  Callout,
  Card,
  Chip,
  EmptyState,
  LinkButton,
  List,
  PageHeader,
  ProgressBar,
  SectionTitle,
  Stat,
} from '@/components/ui.tsx'
import { SKILL_STATE_LABELS, TASK_STATUS_LABELS, formatDate, formatNumber, percent } from '@/core/format.ts'
import { useAppStore } from '@/state/store.ts'
import { SelfRating } from '@/features/shared/SelfRating.tsx'
import { Stagger } from '@/skiper/components/Stagger.tsx'

export function ProgressPage(): ReactNode {
  const ratings = useAppStore((state) => state.ratings)
  const progress = useAppStore((state) => state.progress)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const profile = useAppStore((state) => state.profile)
  const toggleBookmark = useAppStore((state) => state.toggleBookmark)
  const exportLocalData = useAppStore((state) => state.exportLocalData)
  const pushToast = useAppStore((state) => state.pushToast)

  const tasks = useMemo(() => Object.values(progress).flatMap((entry) => Object.values(entry.tasks)), [progress])
  const completed = tasks.filter((task) => task.status === 'completed')
  const review = tasks.filter((task) => task.status === 'needs-review')
  const hours = tasks.reduce((sum, task) => sum + (task.actualHours ?? 0), 0)

  // "This week" is honest arithmetic over the timestamps the learner already
  // created: tasks touched in the last 7 days and the hours logged on them.
  // It is labelled as such — there is no background tracking behind it.
  const week = useMemo(() => {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000
    const touched = tasks.filter((task) => Date.parse(task.updatedAt) >= since)
    return {
      touched: touched.length,
      completed: touched.filter((task) => task.status === 'completed').length,
      hours: touched.reduce((sum, task) => sum + (task.actualHours ?? 0), 0),
    }
  }, [tasks])

  const byState = useMemo(() => {
    const map = new Map<string, number>()
    for (const rating of ratings) map.set(rating.state, (map.get(rating.state) ?? 0) + 1)
    return map
  }, [ratings])

  const download = (): void => {
    const payload = exportLocalData()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `graphmentor-progress-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    pushToast({ kind: 'success', message: 'Progress exported.', detail: 'A JSON file with everything stored on this device.' })
  }

  const downloadReport = (): void => {
    const lines: string[] = [
      '# My GraphMentor progress',
      '',
      `Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} from data stored on this device.`,
      '',
      '## Summary',
      '',
      `- Skills rated: ${ratings.length} (${byState.get('confident') ?? 0} confident)`,
      `- Roadmap tasks completed: ${completed.length} of ${tasks.length} tracked`,
      `- Hours logged: ${Math.round(hours)} h (your own entries)`,
      `- Bookmarks: ${bookmarks.length}`,
      '',
      '## This week (last 7 days)',
      '',
      `- ${week.completed} task(s) completed, ${week.touched} touched, ${week.hours.toFixed(1)} hours logged on recently updated tasks`,
      `- Weekly study target: ${profile.weeklyHours} h`,
      '',
      '## Self-rated skills',
      '',
      ...(ratings.length === 0
        ? ['No skills rated yet.']
        : ratings.map(
            (rating) =>
              `- ${rating.skillId.replace(/^skill:/, '').replace(/-/g, ' ')} — ${SKILL_STATE_LABELS[rating.state] ?? rating.state}${
                rating.quizScore !== undefined ? ` (self-check ${percent(rating.quizScore, 1)}%)` : ''
              }`,
          )),
      '',
      '## Roadmap tasks',
      '',
      ...(tasks.length === 0
        ? ['No roadmap tasks tracked yet.']
        : tasks.map(
            (task) =>
              `- [${task.status === 'completed' ? 'x' : ' '}] ${task.skillId.replace(/^skill:/, '').replace(/-/g, ' ')} — ${task.status}${
                task.actualHours ? ` (${task.actualHours} h)` : ''
              }`,
          )),
      '',
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `graphmentor-progress-report-${new Date().toISOString().slice(0, 10)}.md`
    anchor.click()
    URL.revokeObjectURL(url)
    pushToast({ kind: 'success', message: 'Progress report downloaded.', detail: 'A readable Markdown summary of this device’s progress.' })
  }

  return (
    <div>
      <PageHeader
        eyebrow="Progress"
        title="What you have recorded, and what to do about it"
        description="Self-reported skill levels, roadmap statuses, logged hours and bookmarks. All of it is editable, exportable and erasable."
        actions={
          <>
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={download}>
              Export JSON
            </Button>
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={downloadReport}>
              Download progress report (.md)
            </Button>
            <LinkButton to="/settings" variant="ghost" icon={<Trash2 className="h-4 w-4" />}>
              Erase data
            </LinkButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Skills rated" value={formatNumber(ratings.length)} hint={`${byState.get('confident') ?? 0} confident`} />
        <Stat label="Tasks completed" value={formatNumber(completed.length)} hint={`of ${tasks.length} tracked`} />
        <Stat label="Hours logged" value={`${formatNumber(Math.round(hours))} h`} hint="Your own entries" />
        <Stat label="Bookmarks" value={formatNumber(bookmarks.length)} hint="Across all types" />
      </div>

      <Card className="mb-5">
        <SectionTitle hint="the last 7 days, from your own task updates">This week</SectionTitle>
        {week.touched === 0 ? (
          <p className="text-sm text-muted">
            No roadmap tasks updated in the last 7 days, so there is nothing to summarise yet. Opening a roadmap and
            marking a task — or logging hours on one — is what fills this in.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Tasks completed" value={formatNumber(week.completed)} hint="in the last 7 days" />
              <Stat label="Tasks touched" value={formatNumber(week.touched)} hint="any status change" />
              <Stat label="Hours logged" value={`${week.hours.toFixed(1)} h`} hint="on recently updated tasks" />
              <Stat label="Weekly target" value={`${profile.weeklyHours} h`} hint={week.hours >= profile.weeklyHours ? 'met this week' : 'from your profile'} />
            </div>
            <div className="mt-3">
              <ProgressBar value={week.hours} max={Math.max(1, profile.weeklyHours)} label="Hours logged this week against your target" />
            </div>
          </>
        )}
      </Card>

      <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        <Card>
          <SectionTitle hint="what the planner sees">Self-rated skills</SectionTitle>
          {ratings.length === 0 ? (
            <EmptyState title="No skills rated yet" action={<LinkButton to="/gaps" variant="primary">Run a gap analysis</LinkButton>}>
              Rating skills takes a minute and makes every recommendation in the app specific to you.
            </EmptyState>
          ) : (
            <>
              <ProgressBar value={completed.length} max={Math.max(1, tasks.length)} label="Tasks completed" />
              <ul className="mt-3 grid grid-cols-2 gap-2 text-sm">
                {[...byState.entries()].map(([state, count]) => (
                  <li key={state} className="flex items-center justify-between rounded-md border border-line px-2 py-1">
                    <span>{SKILL_STATE_LABELS[state as keyof typeof SKILL_STATE_LABELS] ?? state}</span>
                    <span className="font-medium">{count}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 space-y-2">
                {ratings.slice(0, 12).map((rating) => (
                  <div key={rating.skillId} className="rounded-md border border-line p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link to={`/skills/${rating.skillId}`} className="text-sm no-underline hover:underline">
                        {rating.skillId.replace(/^skill:/, '').replace(/-/g, ' ')}
                      </Link>
                      <Chip>{SKILL_STATE_LABELS[rating.state]}</Chip>
                    </div>
                    <div className="mt-1">
                      <SelfRating skillId={rating.skillId} skillName={rating.skillId} compact />
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Updated {formatDate(rating.updatedAt)}
                      {rating.quizScore !== undefined ? ` · self-check ${percent(rating.quizScore, 1)}%` : ''}
                    </p>
                  </div>
                ))}
                {ratings.length > 12 ? (
                  <p className="text-xs text-muted">Showing the first 12 of {ratings.length}; the export contains all of them.</p>
                ) : null}
              </div>
            </>
          )}
        </Card>

        <Card>
          <SectionTitle hint="from your roadmaps">Task progress</SectionTitle>
          {tasks.length === 0 ? (
            <EmptyState title="No roadmap progress yet" action={<LinkButton to="/roadmap" variant="primary">Open your roadmap</LinkButton>}>
              Statuses you set on roadmap tasks appear here.
            </EmptyState>
          ) : (
            <ul className="space-y-2 text-sm">
              {Object.entries(progress).map(([roadmapKey, entry]) => {
                const entryTasks = Object.values(entry.tasks)
                const done = entryTasks.filter((task) => task.status === 'completed').length
                return (
                  <li key={roadmapKey} className="rounded-md border border-line p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{roadmapKey.replace(/^career:/, '').replace(/-/g, ' ')}</span>
                      <Chip tone={done === entryTasks.length ? 'success' : 'default'}>
                        {done}/{entryTasks.length} done
                      </Chip>
                    </div>
                    <div className="mt-1">
                      <ProgressBar value={done} max={Math.max(1, entryTasks.length)} label={`Progress for ${roadmapKey}`} />
                    </div>
                    <ul className="mt-2 space-y-1">
                      {entryTasks.slice(0, 6).map((task) => (
                        <li key={task.skillId} className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                          <span>{task.skillId.replace(/^skill:/, '').replace(/-/g, ' ')}</span>
                          <span>
                            {TASK_STATUS_LABELS[task.status]}
                            {task.actualHours ? ` · ${task.actualHours} h` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </Stagger>

      <div className="mt-5 space-y-4">
        <Card>
          <SectionTitle hint="skills, projects and resources you saved">Bookmarks</SectionTitle>
          {bookmarks.length === 0 ? (
            <p className="text-sm text-muted">
              Nothing bookmarked. Use the save button on a skill, project or resource to keep it here.
            </p>
          ) : (
            <ul className="space-y-2">
              {bookmarks.map((bookmark) => (
                <li key={bookmark.targetId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2.5">
                  <span className="text-sm">
                    <Chip>{bookmark.targetType}</Chip>{' '}
                    {bookmark.targetType === 'skill' ? (
                      <Link to={`/skills/${bookmark.targetId}`} className="no-underline hover:underline">
                        {bookmark.targetId.replace(/^skill:/, '').replace(/-/g, ' ')}
                      </Link>
                    ) : bookmark.targetType === 'career' ? (
                      <Link to={`/careers/${bookmark.targetId}`} className="no-underline hover:underline">
                        {bookmark.targetId.replace(/^career:/, '').replace(/-/g, ' ')}
                      </Link>
                    ) : (
                      bookmark.targetId
                    )}
                  </span>
                  <Button size="sm" variant="ghost" icon={<Bookmark className="h-3.5 w-3.5" />} onClick={() => toggleBookmark({ targetType: bookmark.targetType, targetId: bookmark.targetId })}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {review.length > 0 ? (
          <Callout kind="warning" title={`${review.length} task(s) flagged for review`}>
            <List items={review.map((task) => `${task.skillId.replace(/^skill:/, '').replace(/-/g, ' ')} — flagged ${formatDate(task.updatedAt)}`)} />
          </Callout>
        ) : null}

        <Callout kind="info" title="Nothing here is shared or ranked">
          There are no leaderboards, no study streaks and no comparison with other people. Progress exists so the planner can
          schedule realistically, and it stays under your control.
        </Callout>
      </div>
    </div>
  )
}


