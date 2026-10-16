/**
 * Graph-grounded mentor.
 *
 * Product rules implemented here:
 *   - the answer always says which provider produced it ("rules engine" vs a
 *     named model) and what context it used,
 *   - citations are shown as evidence, and unresolved references are shown as
 *     unknowns instead of being hidden,
 *   - the conversation is kept in memory only, and the screen says so: nothing is
 *     written to storage by default,
 *   - the disclaimer is part of the answer, not a footnote.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Copy, Send, Sparkles, User } from 'lucide-react'

import {
  Button,
  Callout,
  Card,
  Chip,
  EmptyState,
  Field,
  Grid,
  LinkButton,
  List,
  Loading,
  PageHeader,
  SectionTitle,
  Select,
  TextArea,
} from '@/components/ui.tsx'
import type { MentorAnswer, MentorRead } from '@core/types.ts'
import { ApiError, type MentorInput } from '@/core/api.ts'
import { api } from '@/core/session.ts'
import { copyText } from '@/core/share.ts'
import { useAppStore } from '@/state/store.ts'
import { useCareerParam, useClientQuery } from '@/features/shared/hooks.ts'

interface Turn {
  question: string
  answer: MentorAnswer | null
  context: {
    intent: string
    skillsUsed: number
    projectsUsed: number
    resourcesUsed: number
    graphSource: string
    truncated: boolean
    /** Present on answers from this build; older cached turns may not have it. */
    reads?: MentorRead[]
    readMs?: number
  } | null
  error: string | null
  answeredAt: string
}

const SUGGESTIONS = [
  'Why do I need mathematics before machine learning?',
  'What should I build next for a robotics portfolio?',
  'Which skills am I missing for an embedded role?',
  'How is PID control connected to signals and systems?',
  'Where can I learn SQL for free?',
]

export function MentorPage(): ReactNode {
  const { careerId } = useCareerParam()
  const profile = useAppStore((state) => state.profile)
  const ratings = useAppStore((state) => state.ratings)
  const pushToast = useAppStore((state) => state.pushToast)

  const [message, setMessage] = useState('')
  const [mode, setMode] = useState<MentorInput['mode']>('concise')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [remaining, setRemaining] = useState<number | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  const careers = useClientQuery(() => api().listCareers({}), [], 'the career list')
  const effectiveCareer = careerId ?? profile.careerGoalId ?? null

  const history = useMemo(
    () =>
      turns.flatMap((turn) =>
        turn.answer
          ? [
              { role: 'user' as const, content: turn.question },
              { role: 'assistant' as const, content: turn.answer.answer },
            ]
          : [],
      ),
    [turns],
  )

  const ask = async (question: string): Promise<void> => {
    const text = question.trim().slice(0, 1200)
    if (text.length < 3) {
      pushToast({ kind: 'warning', message: 'Ask a slightly longer question.', detail: 'Mention a skill, career or project for a grounded answer.' })
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const result = await api().mentorChat({
        message: text,
        mode,
        careerId: effectiveCareer,
        history: history.slice(-6),
      })
      setTurns((current) => [
        ...current,
        {
          question: text,
          answer: result.data.answer,
          context: result.data.context,
          error: null,
          answeredAt: new Date().toISOString(),
        },
      ])
      const left = result.data.limits.requestsRemainingThisMinute
      setRemaining(Number.isFinite(left) ? left : null)
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null
      setTurns((current) => [
        ...current,
        {
          question: text,
          answer: null,
          context: null,
          error:
            apiError?.code === 'rate_limited'
              ? `Rate limited${apiError.retryAfterSeconds ? ` — try again in ${apiError.retryAfterSeconds}s` : ''}. The limit exists to keep the free tier available for everyone.`
              : apiError?.message ?? 'The mentor could not answer that question.',
          answeredAt: new Date().toISOString(),
        },
      ])
    } finally {
      setBusy(false)
      requestAnimationFrame(() => transcriptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }))
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Graph-grounded mentor"
        title="Ask about the graph, get answers that cite it"
        description="Answers are built from the same knowledge graph the rest of the app uses: specific skills, specific relationships, specific resources. When the graph does not cover something, the answer says so."
        actions={
          <LinkButton to="/graph" variant="secondary">
            Open the graph instead
          </LinkButton>
        }
      />

      <Grid cols={2}>
        <Card>
          <SectionTitle hint="affects length, not honesty">Ask a question</SectionTitle>
          <Field label="Career context" htmlFor="mentor-career" hint="Answers resolve pronouns and vague references to this career.">
            <Select id="mentor-career" value={effectiveCareer ?? ''} disabled>
              <option value="">{effectiveCareer ? careers.data?.careers.find((career) => career.id === effectiveCareer)?.name ?? effectiveCareer : 'No career selected'}</option>
            </Select>
          </Field>
          <Field label="Answer style" htmlFor="mentor-mode">
            <Select id="mentor-mode" value={mode} onChange={(event) => setMode(event.target.value as MentorInput['mode'])}>
              <option value="concise">Concise — direct answer and next actions</option>
              <option value="detailed">Detailed — includes the reasoning</option>
            </Select>
          </Field>
          <Field
            label="Your question"
            htmlFor="mentor-message"
            hint="Up to 1200 characters. Questions that mention a skill, career or project get the best answers."
          >
            <TextArea
              id="mentor-message"
              rows={3}
              maxLength={1200}
              value={message}
              placeholder="e.g. I know basic Python but not statistics. What should I do first for a data role?"
              onChange={(event) => setMessage(event.target.value.slice(0, 1200))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void ask(message)
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy} onClick={() => void ask(message)}>
              Ask
            </Button>
            <span className="text-xs text-muted">
              {message.length}/1200 · {remaining !== null ? `${remaining} request(s) left this minute` : 'rate limited per minute and per hour'}
            </span>
          </div>

          <div className="mt-4">
            <p className="gm-label">Try one of these</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="gm-chip min-h-9 px-2.5 text-left text-xs hover:border-accent"
                  onClick={() => {
                    setMessage(suggestion)
                    void ask(suggestion)
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <Callout kind="info" title="What this mentor will not do">
              It will not predict your salary or chances of being hired, invent courses that do not exist, or answer questions
              outside engineering learning and careers. It has no memory between sessions, and nothing you type here is stored by
              this app.
            </Callout>
            <p className="text-xs text-muted">
              Your self-reported skills ({ratings.length} rated) shape the answer. No account, chat transcript or profile detail is
              sent to an AI provider — only the curriculum context and your question, and only if a provider is configured at all.
            </p>
          </div>
        </Card>

        <Card>
          <SectionTitle hint="answers stay on this screen until you leave it">Conversation</SectionTitle>
          {turns.length === 0 ? (
            <EmptyState title="No questions yet">
              Ask something specific. The mentor answers from the graph: prerequisite chains, skill gaps, project ideas, study plans
              and resource pointers.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {turns.map((turn, index) => (
                <div key={`${turn.answeredAt}-${index}`} className="space-y-2">
                  <div className="flex items-start gap-2">
                    <User aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                    <p className="text-sm font-medium">{turn.question}</p>
                  </div>
                  <div className="rounded-lg border border-line bg-[var(--gm-surface-2)] p-3">
                    {turn.error ? (
                      <p className="flex items-start gap-2 text-sm text-[var(--gm-danger)]">
                        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                        {turn.error}
                      </p>
                    ) : turn.answer ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip tone="accent">{turn.answer.providerName}</Chip>
                          <Chip>{turn.answer.intent.replace(/-/g, ' ')}</Chip>
                          {turn.answer.degraded ? <Chip tone="warning">degraded: {turn.answer.degraded.reason}</Chip> : null}
                          {turn.context ? (
                            <Chip title="Size of the curriculum context used">
                              {turn.context.skillsUsed} skills · {turn.context.projectsUsed} projects · {turn.context.resourcesUsed} resources
                            </Chip>
                          ) : null}
                          {turn.context?.reads ? (
                            <Chip
                              title="Graph queries that produced this answer, and how long they took. The full list is under the answer."
                              tone={turn.context.reads.length === 0 ? 'warning' : 'default'}
                            >
                              {turn.context.reads.length} graph read{turn.context.reads.length === 1 ? '' : 's'} · {turn.context.readMs ?? 0} ms
                            </Chip>
                          ) : null}
                          {turn.context?.truncated ? <Chip tone="warning">context truncated</Chip> : null}
                        </div>

                        <div className="whitespace-pre-wrap text-sm">{turn.answer.answer}</div>

                        <div>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Copy className="h-3.5 w-3.5" />}
                            onClick={() => {
                              void copyText(
                                [
                                  turn.answer?.answer ?? '',
                                  ...(turn.answer && turn.answer.nextActions.length > 0
                                    ? ['', 'Next actions:', ...turn.answer.nextActions.map((action) => `- ${action}`)]
                                    : []),
                                ].join('\n'),
                              ).then((ok) =>
                                pushToast(
                                  ok
                                    ? { kind: 'success', message: 'Answer copied.', detail: 'Plain text — paste it into your notes.' }
                                    : { kind: 'warning', message: 'Could not copy.', detail: 'Select the text and copy it manually.' },
                                ),
                              )
                            }}
                          >
                            Copy answer
                          </Button>
                        </div>

                        {turn.answer.nextActions.length > 0 ? (
                          <div>
                            <h3 className="text-sm font-semibold">Next actions</h3>
                            <List items={turn.answer.nextActions} />
                          </div>
                        ) : null}

                        {turn.answer.evidence.length > 0 ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-accent">
                              Evidence used ({turn.answer.evidence.length})
                            </summary>
                            <ul className="mt-1 space-y-1 text-xs text-muted">
                              {turn.answer.evidence.map((evidence) => (
                                <li key={`${evidence.kind}-${evidence.id}`}>
                                  <span className="font-medium">{evidence.title}</span> — {evidence.label} ({evidence.basis})
                                  {evidence.url ? (
                                    <>
                                      {' '}
                                      <a href={evidence.url} target="_blank" rel="noopener noreferrer" className="text-accent no-underline hover:underline">
                                        open
                                      </a>
                                    </>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}

                        {turn.answer.graphBasis.length > 0 ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-accent">Graph basis</summary>
                            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
                              {turn.answer.graphBasis.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}

                        {turn.context?.reads ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-accent">
                              Graph reads ({turn.context.reads.length})
                            </summary>
                            {turn.context.reads.length === 0 ? (
                              <p className="mt-1 text-xs text-muted">
                                No graph reads were needed — which means this answer is not grounded in the curriculum, and you should read it
                                as general guidance rather than as a statement about the graph.
                              </p>
                            ) : (
                              <>
                                <p className="mt-1 text-xs text-muted">
                                  Every answer is written from the {turn.context.reads.length} query type
                                  {turn.context.reads.length === 1 ? '' : 's'} below and nothing else. Nothing was looked up outside this list.
                                </p>
                                <table className="mt-1 w-full text-left text-xs text-muted">
                                  <thead>
                                    <tr className="text-[11px] uppercase tracking-wide">
                                      <th className="pr-2 font-medium">Read</th>
                                      <th className="pr-2 font-medium">What it asked for</th>
                                      <th className="pr-2 font-medium text-right">Rows</th>
                                      <th className="font-medium text-right">Time</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {turn.context.reads.map((read: MentorRead) => (
                                      <tr key={read.call} className="border-t border-line align-top">
                                        <td className="pr-2 py-1 font-mono text-[11px]">
                                          {read.call}
                                          {read.calls > 1 ? ` ×${read.calls}` : ''}
                                        </td>
                                        <td className="pr-2 py-1 font-mono text-[11px]">{read.target || '—'}</td>
                                        <td className="py-1 text-right">{read.rows}</td>
                                        <td className="py-1 text-right">{read.ms} ms</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {turn.context.reads.some((read: MentorRead) => read.truncated) ? (
                                  <p className="mt-1 text-xs text-muted">
                                    At least one read hit its row limit, so the answer may be missing graph content that exists.
                                  </p>
                                ) : null}
                              </>
                            )}
                          </details>
                        ) : null}

                        {turn.answer.unknowns.length > 0 ? (
                          <div>
                            <h3 className="text-sm font-semibold">What the graph did not answer</h3>
                            <List items={turn.answer.unknowns} />
                          </div>
                        ) : null}

                        <p className="text-xs text-muted">{turn.answer.disclaimer}</p>
                      </div>
                    ) : (
                      <Loading label="Thinking…" />
                    )}
                  </div>
                </div>
              ))}
              <div ref={transcriptRef} />
            </div>
          )}
        </Card>
      </Grid>

      <div className="mt-5 space-y-3">
        <Callout kind="info" title="How to check an answer">
          Every claim the mentor makes should be traceable to a relationship you can inspect. Open the graph explorer, or the skill
          page it mentions, and confirm it. If an answer contradicts the graph, the graph is right.
        </Callout>
        <Card>
          <SectionTitle hint="citations and honesty over fluency">How this is wired</SectionTitle>
          <p className="text-sm text-muted">
            The question is classified into one of nine intents, the mentor builds a bounded context from the graph (18 skills, 5
            projects, 6 resources, 40 edges by default), and then either a configured AI provider answers from that context or the
            deterministic rules engine does. Citations referring to ids that were not in the context are dropped and reported as
            unknowns instead of being shown as if they were real. See docs/mentor.md for the exact prompt and guards.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <LinkButton to="/graph" variant="secondary" icon={<Sparkles className="h-4 w-4" />}>
              Inspect the graph
            </LinkButton>
            <LinkButton to="/gaps" variant="secondary">
              Run a gap analysis
            </LinkButton>
          </div>
        </Card>
      </div>
    </div>
  )
}


