/**
 * Skill detail: what it is, what has to come first, what it unlocks, how it is
 * practised, and how to prove it to yourself.
 *
 * Includes an optional self-check (answers are revealed after choosing, and the
 * result is labelled for what it is: a practice check, never a certificate).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ExternalLink, GitBranch, Route } from 'lucide-react'

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
import { formatHours, percent } from '@/core/format.ts'
import { useAppStore } from '@/state/store.ts'
import { useClientQuery } from '@/features/shared/hooks.ts'
import { SelfRating } from '@/features/shared/SelfRating.tsx'
import { ShareButton } from '@/components/ShareButton.tsx'
import { recordRecentView } from '@/core/persistence.ts'

function SelfCheck({
  assessment,
  onScore,
}: {
  assessment: { id: string; name: string; questions: Array<{ prompt: string; options: string[]; answerIndex: number }> }
  onScore: (score: number) => void
}): ReactNode {
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [submitted, setSubmitted] = useState(false)

  const correct = assessment.questions.reduce(
    (sum, question, index) => sum + (answers[index] === question.answerIndex ? 1 : 0),
    0,
  )

  return (
    <Card>
      <SectionTitle hint={`${assessment.questions.length} questions, no timer`}>{assessment.name}</SectionTitle>
      <ol className="space-y-4">
        {assessment.questions.map((question, index) => (
          <li key={index}>
            <fieldset>
              <legend className="text-sm font-medium">{question.prompt}</legend>
              <div className="mt-1 space-y-1">
                {question.options.map((option, optionIndex) => {
                  const isChosen = answers[index] === optionIndex
                  const isCorrect = optionIndex === question.answerIndex
                  const tone = submitted && isCorrect ? 'text-[var(--gm-success)]' : submitted && isChosen ? 'text-[var(--gm-danger)]' : ''
                  return (
                    <label key={optionIndex} className={`flex items-center gap-2 text-sm ${tone}`}>
                      <input
                        type="radio"
                        name={`q-${assessment.id}-${index}`}
                        className="h-4 w-4 accent-[var(--gm-accent)]"
                        checked={isChosen}
                        onChange={() => setAnswers({ ...answers, [index]: optionIndex })}
                        disabled={submitted}
                      />
                      {option}
                      {submitted && isCorrect ? <span className="text-xs">(correct)</span> : null}
                    </label>
                  )
                })}
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!submitted ? (
          <Button
            variant="primary"
            disabled={Object.keys(answers).length < assessment.questions.length}
            onClick={() => {
              setSubmitted(true)
              onScore(correct / assessment.questions.length)
            }}
          >
            Check answers
          </Button>
        ) : (
          <p className="text-sm" aria-live="polite">
            <strong>
              {correct} of {assessment.questions.length} correct ({percent(correct, assessment.questions.length)}%).
            </strong>{' '}
            This score is stored only on this device and only feeds the recommendation weights.
          </p>
        )}
        {submitted ? (
          <Button
            variant="ghost"
            onClick={() => {
              setAnswers({})
              setSubmitted(false)
            }}
          >
            Try again
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

export function SkillDetailPage(): ReactNode {
  const { skillId = '' } = useParams()
  const setSkillState = useAppStore((state) => state.setSkillState)
  const pushToast = useAppStore((state) => state.pushToast)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const toggleBookmark = useAppStore((state) => state.toggleBookmark)

  const query = useClientQuery(() => api().getSkill(skillId), [skillId], 'this skill')
  const bookmarked = bookmarks.some((bookmark) => bookmark.targetId === skillId)

  useEffect(() => {
    if (query.data) {
      recordRecentView({ to: `/skills/${query.data.skill.id}`, name: query.data.skill.name, kind: 'Skill' })
    }
  }, [query.data])

  if (query.status === 'loading') return <Loading label="Loading this skill from the graph…" />
  if (query.status === 'error' || !query.data) {
    return <ErrorNotice message={query.error?.message ?? 'This skill could not be loaded'} detail={query.error?.detail} onRetry={query.reload} />
  }

  const { skill, resources, assessments, caveats } = query.data

  return (
    <div>
      <PageHeader
        eyebrow="Skill"
        title={skill.name}
        description={skill.summary || skill.description}
        actions={
          <>
            <Button
              variant={bookmarked ? 'secondary' : 'primary'}
              onClick={() => {
                const added = toggleBookmark({ targetType: 'skill', targetId: skill.id })
                pushToast({ kind: 'success', message: added ? 'Bookmarked.' : 'Bookmark removed.', detail: 'Find it again under Progress.' })
              }}
            >
              {bookmarked ? 'Bookmarked' : 'Bookmark'}
            </Button>
            <LinkButton to={`/graph?seed=${encodeURIComponent(skill.id)}`} variant="secondary" icon={<GitBranch className="h-4 w-4" />}>
              Show in graph
            </LinkButton>
            <LinkButton to={`/roadmap?career=`} variant="ghost" icon={<Route className="h-4 w-4" />}>
              Plan around it
            </LinkButton>
            <ShareButton title={`${skill.name} — GraphMentor AI`} />
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DifficultyBadge difficulty={skill.difficulty} />
        <Chip>{formatHours(skill.estimatedHours)} estimated</Chip>
        <Chip tone={skill.prerequisites.length > 0 ? 'warning' : 'success'}>
          {skill.prerequisites.length === 0 ? 'No prerequisites in the graph' : `${skill.prerequisites.length} prerequisite(s)`}
        </Chip>
        <Chip>{skill.unlocks.length} skill(s) depend on it</Chip>
      </div>

      <div className="mb-4">
        <SelfRating skillId={skill.id} skillName={skill.name} />
      </div>

      <Grid cols={2}>
        <Card>
          <SectionTitle hint="must be comfortable first">Prerequisites</SectionTitle>
          {skill.prerequisites.length === 0 ? (
            <p className="text-sm text-muted">
              The graph marks no prerequisites: this is a reasonable starting point. That reflects the curriculum, not your
              background.
            </p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {skill.prerequisites.map((prerequisite) => (
                <li key={prerequisite.id} className="flex flex-wrap items-center gap-2">
                  <Link to={`/skills/${prerequisite.id}`} className="no-underline hover:underline">
                    {prerequisite.name}
                  </Link>
                  {prerequisite.strength !== undefined ? (
                    <Chip title="How strongly the curriculum insists on it">{percent(prerequisite.strength, 1)}% strength</Chip>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle hint="what becomes easier afterwards">Unlocks</SectionTitle>
          {skill.unlocks.length === 0 ? (
            <p className="text-sm text-muted">Nothing in the current dataset depends on this skill.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {skill.unlocks.map((item) => (
                <li key={item.id}>
                  <Link to={`/skills/${item.id}`} className="no-underline hover:underline">
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Grid>

      <div className="mt-4 space-y-4">
        <Card>
          <SectionTitle hint="do these before claiming the skill">Practice and completion criteria</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold">Practice</h3>
              <List items={skill.practice} />
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">You are done when you can</h3>
              <List items={skill.completionCriteria} />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">{skill.description}</p>
        </Card>

        {skill.tools.length > 0 || skill.languages.length > 0 || skill.projects.length > 0 ? (
          <Grid cols={3}>
            {skill.languages.length > 0 ? (
              <Card>
                <SectionTitle>Languages</SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {skill.languages.map((language) => (
                    <Chip key={language.id}>{language.name}</Chip>
                  ))}
                </div>
              </Card>
            ) : null}
            {skill.tools.length > 0 ? (
              <Card>
                <SectionTitle>Tools</SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {skill.tools.map((tool) => (
                    <Chip key={tool.id}>{tool.name}</Chip>
                  ))}
                </div>
              </Card>
            ) : null}
            {skill.projects.length > 0 ? (
              <Card>
                <SectionTitle>Projects that build it</SectionTitle>
                <List items={skill.projects.map((project) => project.name)} />
              </Card>
            ) : null}
          </Grid>
        ) : null}

        <Card>
          <SectionTitle hint="free or free-to-audit, with an honest label">Resources</SectionTitle>
          {resources.length === 0 ? (
            <Callout kind="warning" title="No resource linked yet">
              This skill has no resource in the current dataset. That is reported honestly rather than filled with a placeholder
              link.
            </Callout>
          ) : (
            <ul className="space-y-3">
              {resources.map((resource) => (
                <li key={resource.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{resource.name}</span>
                    <Chip>{resource.provider}</Chip>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                    <span>{resource.accessBadge}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {resource.verification === 'verified'
                        ? 'link verified by the project maintainers'
                        : 'link not re-checked recently — dates are on the resource library page'}
                    </span>
                  </div>
                  <a
                    href={resource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-sm text-accent no-underline hover:underline"
                  >
                    Open {resource.provider} <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {assessments.length > 0 ? (
          assessments.map((assessment) => (
            <SelfCheck
              key={assessment.id}
              assessment={assessment}
              onScore={(score) => setSkillState(skill.id, score >= 0.75 ? 'practised' : 'learning', score)}
            />
          ))
        ) : (
          <Callout kind="info" title="No self-check for this skill">
            Not every skill has a written check in the dataset. Use the completion criteria above as your evidence instead.
          </Callout>
        )}

        <Card>
          <SectionTitle hint="things this page cannot tell you">Caveats</SectionTitle>
          <List items={caveats} />
        </Card>
      </div>
    </div>
  )
}


