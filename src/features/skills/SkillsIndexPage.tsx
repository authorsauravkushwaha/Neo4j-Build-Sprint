/**
 * Skill index — every skill and concept in the curriculum, searchable.
 *
 * Until this page existed, the 89 skills could only be reached sideways:
 * through a career's skill tab, the graph, or the command palette. A learner
 * who already knows the name of the thing they want ("PID control", "spatial
 * joins") had no direct way in. This is that way in: one list, backed by the
 * same `listSkills` reader the palette uses, so it can never disagree with
 * the skill pages it links to.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'

import { Card, Chip, DifficultyBadge, EmptyState, ErrorNotice, Field, Loading, PageHeader, Select, SkillLink, TextInput } from '@/components/ui.tsx'
import { api } from '@/core/session.ts'
import { formatNumber } from '@/core/format.ts'
import { useClientQuery, useTextParam } from '@/features/shared/hooks.ts'

export function SkillsIndexPage(): ReactNode {
  const [search, setSearch] = useTextParam('q')
  const [kind, setKind] = useState('')
  const [difficulty, setDifficulty] = useState('')

  const index = useClientQuery(
    () => api().listSkills({ ...(search ? { q: search } : {}), limit: 400 }),
    [search],
    'the skill index',
  )

  const rows = useMemo(() => {
    const all = index.data?.skills ?? []
    return all.filter(
      (entry) => (!kind || entry.kind === kind) && (!difficulty || entry.difficulty === difficulty),
    )
  }, [index.data, kind, difficulty])

  return (
    <div>
      <PageHeader
        eyebrow="Skill index"
        title="Every skill in the curriculum, by name"
        description="Search the whole catalogue directly instead of arriving through a career. Each entry opens its page: prerequisites, what it unlocks, practice criteria, and free resources."
      />

      <Card className="mb-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Search" htmlFor="skill-search">
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted" />
              <TextInput
                id="skill-search"
                className="pl-8"
                placeholder="e.g. PID, spatial, welding"
                value={search}
                maxLength={60}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </Field>
          <Field label="Type" htmlFor="skill-kind">
            <Select id="skill-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">Skills and concepts</option>
              <option value="Skill">Skills only</option>
              <option value="Concept">Concepts only</option>
            </Select>
          </Field>
          <Field label="Curriculum level" htmlFor="skill-difficulty">
            <Select id="skill-difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option value="">Any level</option>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </Select>
          </Field>
        </div>
        <p aria-live="polite" className="mt-3 text-xs text-muted">
          {index.status === 'ready' ? `${formatNumber(rows.length)} of ${formatNumber(index.data?.total ?? 0)} entries shown.` : 'Loading…'}
        </p>
      </Card>

      {index.status === 'loading' ? <Loading label="Loading the skill index…" /> : null}
      {index.status === 'error' ? (
        <ErrorNotice message={index.error?.message ?? 'The skill index could not be loaded'} detail={index.error?.detail} onRetry={index.reload} />
      ) : null}
      {index.status === 'ready' && rows.length === 0 ? (
        <EmptyState title="No skill matches those filters">
          Try a shorter word, or clear the type and level filters.
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <Card>
          <ul className="flex flex-wrap gap-2">
            {rows.map((entry) => (
              <li key={entry.id} className="flex items-center gap-1.5">
                <SkillLink skillId={entry.id} name={entry.name} difficulty={entry.difficulty} />
                {entry.kind === 'Concept' ? <Chip title="A concept under a subject, not a practised skill">concept</Chip> : null}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Difficulty is the curriculum&apos;s judgement of where the entry sits, not a gate: every page states its own
            prerequisites. <DifficultyBadge difficulty="beginner" /> entries are the honest starting points.
          </p>
        </Card>
      ) : null}
    </div>
  )
}


