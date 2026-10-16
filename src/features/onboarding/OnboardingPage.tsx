/**
 * Onboarding — skippable at every step, and never a wall in front of the app.
 *
 * Design decisions:
 *   - five short steps, each with a "Skip this step" action and a visible
 *     "Skip for now" that goes straight to the dashboard,
 *   - nothing here requires an account; answers are stored locally,
 *   - free-text inputs are length-capped and stored as plain text,
 *   - the career question is answered from the same list the explorer uses, so a
 *     typo cannot create a career that does not exist in the graph.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, SkipForward } from 'lucide-react'

import { Button, Callout, Card, Chip, Field, Loading, PageHeader, ProgressBar, Select, TextArea, TextInput } from '@/components/ui.tsx'
import { api } from '@/core/session.ts'
import { useAppStore } from '@/state/store.ts'
import { useClientQuery } from '@/features/shared/hooks.ts'
import type { Difficulty } from '@core/types.ts'

const STEPS = ['Study stage', 'Branches of interest', 'Target career', 'Time and pace', 'Comfort level'] as const

export function OnboardingPage(): ReactNode {
  const navigate = useNavigate()
  const profile = useAppStore((state) => state.profile)
  const setProfile = useAppStore((state) => state.setProfile)
  const complete = useAppStore((state) => state.completeOnboarding)
  const pushToast = useAppStore((state) => state.pushToast)

  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState(profile)

  const careers = useClientQuery(() => api().listCareers({}), [], 'the career list')
  const branches = useMemo(() => careers.data?.branches ?? [], [careers.data])

  useEffect(() => {
    setDraft(profile)
  }, [profile])

  const finish = (skipped: boolean): void => {
    setProfile(draft)
    complete()
    pushToast(
      skipped
        ? { kind: 'info', message: 'Skipped setup.', detail: 'You can change any answer later in Settings — nothing is locked in.' }
        : { kind: 'success', message: 'Preferences saved on this device.', detail: 'Open the dashboard to pick a career goal.' },
    )
    navigate('/dashboard', { replace: true })
  }

  const toggleInterest = (id: string): void => {
    const has = draft.interestIds.includes(id)
    setDraft({
      ...draft,
      interestIds: has ? draft.interestIds.filter((value) => value !== id) : [...draft.interestIds, id].slice(0, 6),
    })
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        eyebrow={`Step ${step + 1} of ${STEPS.length}`}
        title="Tell GraphMentor where you are starting from"
        description="These answers only shape the recommendations. No account, no email, nothing leaves this device unless you later choose to sign in."
        actions={
          <Button variant="ghost" onClick={() => finish(true)} icon={<SkipForward className="h-4 w-4" />}>
            Skip for now
          </Button>
        }
      />

      <div className="mb-4">
        <ProgressBar value={step + 1} max={STEPS.length} label={`Onboarding progress: step ${step + 1} of ${STEPS.length}`} />
        <p className="mt-1 text-xs text-muted" aria-live="polite">
          {STEPS[step]}
        </p>
      </div>

      <Card>
        {step === 0 ? (
          <div>
            <h2 className="mb-1 text-lg font-semibold">What are you studying, or what did you study?</h2>
            <p className="mb-3 text-sm text-muted">
              This changes the wording of advice, not the graph. If none of these fit, choose "Something else" and carry on.
            </p>
            <Field label="Stage" htmlFor="education">
              <Select
                id="education"
                value={draft.educationLevel}
                onChange={(event) => setDraft({ ...draft, educationLevel: event.target.value })}
              >
                <option value="">Prefer not to say</option>
                <option value="school">In school</option>
                <option value="diploma">Diploma or polytechnic</option>
                <option value="undergraduate">Undergraduate degree</option>
                <option value="postgraduate">Postgraduate degree</option>
                <option value="self-taught">Self-taught or career changer</option>
                <option value="other">Something else</option>
              </Select>
            </Field>
            <Field label="Branch or specialisation (optional)" htmlFor="branch-name" hint="Free text, up to 80 characters.">
              <TextInput
                id="branch-name"
                maxLength={80}
                value={draft.branch}
                placeholder="e.g. Electronics and communication"
                onChange={(event) => setDraft({ ...draft, branch: event.target.value.slice(0, 80) })}
              />
            </Field>
          </div>
        ) : null}

        {step === 1 ? (
          <div>
            <h2 className="mb-1 text-lg font-semibold">Which areas interest you?</h2>
            <p className="mb-3 text-sm text-muted">
              Pick up to six. Interests only nudge ranking within skills a career already requires — they never invent requirements.
            </p>
            {careers.status === 'loading' ? <Loading label="Loading branches…" /> : null}
            <div className="flex flex-wrap gap-2">
              {branches.map((branch) => {
                const active = draft.interestIds.includes(branch.id)
                return (
                  <button
                    key={branch.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleInterest(branch.id)}
                    className={`gm-chip px-3 py-1.5 text-sm ${
                      active ? 'border-accent bg-[var(--gm-accent-soft)] text-accent' : 'hover:border-line-strong'
                    }`}
                    title={`${branch.careerCount} careers in this branch`}
                  >
                    {active ? <Check aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" /> : null}
                    {branch.name}
                  </button>
                )
              })}
            </div>
            {careers.status === 'error' ? (
              <Callout kind="warning" title="Could not load the branch list">
                {careers.error?.message} You can skip this step and set interests later.
              </Callout>
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div>
            <h2 className="mb-1 text-lg font-semibold">Is there a direction you are aiming for?</h2>
            <p className="mb-3 text-sm text-muted">
              Optional, and changeable at any time. Leaving it empty means every screen asks you to choose a career first.
            </p>
            <Field label="Target career" htmlFor="goal-career">
              <Select
                id="goal-career"
                value={draft.careerGoalId ?? ''}
                onChange={(event) => setDraft({ ...draft, careerGoalId: event.target.value || null })}
              >
                <option value="">No goal yet — I want to explore</option>
                {(careers.data?.careers ?? []).map((career) => (
                  <option key={career.id} value={career.id}>
                    {career.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Anything you want to remember about your goal (optional)"
              htmlFor="goal-note"
              hint="Only stored on this device unless you sign in. Up to 200 characters."
            >
              <TextArea
                id="goal-note"
                rows={3}
                maxLength={200}
                value={draft.goalNote}
                onChange={(event) => setDraft({ ...draft, goalNote: event.target.value.slice(0, 200) })}
                placeholder="e.g. Want to move from support work into embedded firmware within a year."
              />
            </Field>
          </div>
        ) : null}

        {step === 3 ? (
          <div>
            <h2 className="mb-1 text-lg font-semibold">How much time do you actually have?</h2>
            <p className="mb-3 text-sm text-muted">
              Be honest rather than ambitious: the roadmap is built from this number, and an unrealistic budget produces a plan
              you will abandon.
            </p>
            <Field
              label={`Study hours per week: ${draft.weeklyHours}`}
              htmlFor="weekly-hours"
              hint="Between 1 and 40 hours. This is a budget, not a requirement."
            >
              <input
                id="weekly-hours"
                type="range"
                min={1}
                max={40}
                step={1}
                value={draft.weeklyHours}
                onChange={(event) => setDraft({ ...draft, weeklyHours: Number(event.target.value) })}
                className="w-full accent-[var(--gm-accent)]"
              />
            </Field>
            <Field label="Preferred pace" htmlFor="pace" hint="Relaxed 0.75×, steady 1×, intensive 1.35× the weekly capacity.">
              <Select
                id="pace"
                value={draft.preferredPace}
                onChange={(event) =>
                  setDraft({ ...draft, preferredPace: event.target.value as typeof draft.preferredPace })
                }
              >
                <option value="relaxed">Relaxed — steady progress, longer horizon</option>
                <option value="steady">Steady — balanced</option>
                <option value="intensive">Intensive — as fast as reasonable</option>
              </Select>
            </Field>
            <Field label="How you prefer to learn" htmlFor="style" hint="Used to order resources, not to exclude any of them.">
              <Select
                id="style"
                value={draft.learningStyle}
                onChange={(event) =>
                  setDraft({ ...draft, learningStyle: event.target.value as typeof draft.learningStyle })
                }
              >
                <option value="mixed">A mix</option>
                <option value="video">Video-first</option>
                <option value="reading">Reading and documentation</option>
                <option value="hands-on">Hands-on building</option>
              </Select>
            </Field>
          </div>
        ) : null}

        {step === 4 ? (
          <div>
            <h2 className="mb-1 text-lg font-semibold">How challenging should the plan start?</h2>
            <p className="mb-3 text-sm text-muted">
              This sets where the roadmap begins, not where it ends. Choosing "beginner" starts from fundamentals even if you
              have some experience — you can self-rate individual skills later.
            </p>
            <div className="flex flex-wrap gap-2">
              {(['beginner', 'intermediate', 'advanced'] as Difficulty[]).map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={draft.difficultyComfort === level}
                  onClick={() => setDraft({ ...draft, difficultyComfort: level })}
                  className={`gm-chip px-3 py-1.5 text-sm capitalize ${
                    draft.difficultyComfort === level ? 'border-accent bg-[var(--gm-accent-soft)] text-accent' : 'hover:border-line-strong'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
            <div className="mt-4">
              <Callout kind="info" title="What happens next">
                The dashboard shows your goal, your next three skills in dependency order, and the fastest way to change any
                of it. You can also skip the dashboard and jump straight into the knowledge graph.
              </Callout>
            </div>
            <p className="mt-3 text-xs text-muted">
              Interests selected: {draft.interestIds.length === 0 ? 'none' : draft.interestIds.length}. All answers stay on this
              device.
            </p>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <Button
            variant="ghost"
            onClick={() => (step === 0 ? navigate(-1) : setStep(step - 1))}
            icon={<ArrowLeft className="h-4 w-4" />}
            disabled={step === 0}
          >
            Back
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => finish(true)}>
              Skip for now
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={() => setStep(step + 1)} icon={<ArrowRight className="h-4 w-4" />}>
                Continue
              </Button>
            ) : (
              <Button variant="primary" onClick={() => finish(false)} icon={<Check className="h-4 w-4" />}>
                Finish setup
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        <Chip tone="accent">No account needed</Chip>
        <Chip>Stored on this device</Chip>
        <Chip>Editable in Settings</Chip>
      </div>
    </div>
  )
}


