/**
 * Self-assessment control.
 *
 * The wording matters: these are the learner's own estimates, and the UI says so
 * every time they appear. There is deliberately no way to mark a skill as
 * "verified" — that would be a claim this app cannot make.
 */
import type { ReactNode } from 'react'
import type { SkillState } from '@core/types.ts'

import { Chip } from '@/components/ui.tsx'
import { SKILL_STATE_HINTS, SKILL_STATE_LABELS } from '@/core/format.ts'
import { useAppStore } from '@/state/store.ts'

const ORDER: SkillState[] = ['unknown', 'new', 'learning', 'practised', 'confident']

export function SelfRating({
  skillId,
  skillName,
  compact = false,
}: {
  skillId: string
  skillName: string
  compact?: boolean
}): ReactNode {
  const ratings = useAppStore((state) => state.ratings)
  const setSkillState = useAppStore((state) => state.setSkillState)
  const setUi = useAppStore((state) => state.setUi)
  const ui = useAppStore((state) => state.ui)
  const pushToast = useAppStore((state) => state.pushToast)
  const current = ratings.find((rating) => rating.skillId === skillId)?.state ?? 'unknown'

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`Self-rated level for ${skillName}`}>
        {ORDER.map((state) => (
          <button
            key={state}
            type="button"
            aria-pressed={current === state}
            title={SKILL_STATE_HINTS[state]}
            onClick={() => setSkillState(skillId, state)}
            className={`inline-flex min-h-9 items-center rounded-full border px-2.5 text-[11px] ${
              current === state ? 'border-accent bg-[var(--gm-accent-soft)] text-accent' : 'border-line text-muted hover:border-line-strong'
            }`}
          >
            {SKILL_STATE_LABELS[state]}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-line bg-[var(--gm-surface-2)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Your level in {skillName}</p>
        <Chip tone="accent">Self-reported</Chip>
      </div>
      <p className="mt-1 text-xs text-muted">
        This only affects what this app recommends. It is practice evidence for you, not a credential, and it is stored as plain
        text you can erase at any time.
      </p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Self-rated level for ${skillName}`}>
        {ORDER.map((state) => (
          <button
            key={state}
            type="button"
            aria-pressed={current === state}
            title={SKILL_STATE_HINTS[state]}
            onClick={() => {
              setSkillState(skillId, state)
              pushToast({ kind: 'success', message: `Saved: ${skillName} — ${SKILL_STATE_LABELS[state]}`, detail: 'Recommendations update immediately.' })
            }}
            className={`gm-chip px-3 py-1.5 text-sm ${
              current === state ? 'border-accent bg-[var(--gm-accent-soft)] text-accent' : 'hover:border-line-strong'
            }`}
          >
            {SKILL_STATE_LABELS[state]}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">{SKILL_STATE_HINTS[current]}</p>
      {!ui.graphLabels ? null : (
        <button
          type="button"
          className="mt-1 text-xs text-accent underline"
          onClick={() => setUi({ graphLabels: false })}
        >
          Hide this kind of hint
        </button>
      )}
    </div>
  )
}


