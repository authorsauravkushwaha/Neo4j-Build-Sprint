/**
 * Frontier panel — "where do I start, and what exactly is left".
 *
 * This is the screen that has to serve both ends of the audience at once:
 *
 *  - someone who has never studied any of it gets one short list of things they
 *    can start today, and nothing else competing for attention;
 *  - someone who already knows most of it gets the delta: the handful of skills
 *    still missing, which of them gate the rest, and the one chain that cannot be
 *    parallelised no matter how much time they have.
 *
 * Both readings come from the same `FrontierReport`, so the two audiences cannot
 * be shown contradictory numbers. The field-by-field reference, the evidence and
 * the honest limits are in docs/frontier.md. Everything here is computed from the shipped
 * prerequisite graph — the panel never invents a suggestion, and when there is
 * nothing left to compute it says so instead of manufacturing work.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Flag, KeyRound, ListOrdered } from 'lucide-react'

import { Card, Chip, SectionTitle, SkillLink } from '@/components/ui.tsx'
import type { FrontierReport } from '@core/recommend.ts'
import { formatHours, formatNumber, formatWeeks } from '@/core/format.ts'

export function FrontierPanel({
  report,
  weeklyHours,
}: {
  report: FrontierReport
  weeklyHours: number
}): ReactNode {
  const { frontier, gates, criticalChain, pulledIn, hours } = report
  const weeks = hours.weeksAtWeeklyHours

  if (report.remainingCount === 0) {
    return (
      <div data-testid="frontier-panel">
        <Card>
          <SectionTitle hint="nothing left unrated in this route">Nothing left in this route</SectionTitle>
          <p className="text-sm text-muted" data-testid="frontier-summary">
            {report.summaryLine}
          </p>
          <p className="mt-2 text-xs text-muted">
            That is your own self-assessment talking, not a certificate: the graph has no way to verify it. Re-rate any
            skill and this list will grow again.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div data-testid="frontier-panel">
      <Card>
        <SectionTitle hint="computed from the prerequisite graph, not from a course catalogue">
        Where to start, and what is left
      </SectionTitle>

      <p className="text-sm" data-testid="frontier-summary">
        {report.summaryLine}
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Flag aria-hidden="true" className="h-4 w-4 text-accent" />
            Start here now
          </h3>
          {frontier.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2" data-testid="frontier-start">
              {frontier.map((skill) => (
                <SkillLink key={skill.skillId} skillId={skill.skillId} name={skill.name} difficulty={skill.difficulty} />
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Nothing can be started yet — every remaining skill is waiting on something else in the same loop. That is a
              defect in the graph, and the note at the bottom says which items are affected.
            </p>
          )}
          {frontier.length > 0 ? (
            <p className="mt-2 text-xs text-muted">
              Nothing else in the route has to come first{frontier.length === 1 ? '' : ' for any of these'}.
            </p>
          ) : null}
        </div>

        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound aria-hidden="true" className="h-4 w-4 text-accent" />
            These gate the rest
          </h3>
          {gates.length > 0 ? (
            <ul className="mt-2 space-y-2" data-testid="frontier-gates">
              {gates.map((gate) => (
                <li key={gate.skillId} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link to={`/skills/${encodeURIComponent(gate.skillId)}`} className="font-medium no-underline hover:underline">
                    {gate.name}
                  </Link>
                  <Chip tone="accent">unblocks {formatNumber(gate.unlocks)}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Nothing left gates anything: the rest can be taken in any order you like.
            </p>
          )}
          {gates.length > 0 ? (
            <p className="mt-2 text-xs text-muted">
              Between them they unblock {formatNumber(report.gatesUnlock)} of the {formatNumber(report.remainingCount)}{' '}
              skills left — counted once each, not added up.
            </p>
          ) : null}
        </div>

        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ListOrdered aria-hidden="true" className="h-4 w-4 text-accent" />
            This part cannot be hurried
          </h3>
          {criticalChain.length > 1 ? (
            <ol className="mt-2 space-y-1 text-sm" data-testid="frontier-chain">
              {criticalChain.map((node, index) => (
                <li key={node.skillId} className="flex items-center gap-2">
                  <span className="text-xs text-muted">{index + 1}.</span>
                  <Link to={`/skills/${encodeURIComponent(node.skillId)}`} className="no-underline hover:underline">
                    {node.name}
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-muted">
              No ordering constraint is left — nothing here waits on anything else.
            </p>
          )}
          {criticalChain.length > 1 ? (
            <p className="mt-2 text-xs text-muted">
              The longest chain still ahead: {criticalChain.length} steps, each needing the one above it. Extra hours
              cannot shorten this one — only starting it can.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-muted">
        <span data-testid="frontier-effort">
          {formatNumber(report.remainingCount)} skill(s) left · {formatHours([hours.low, hours.high])}
          {weeks ? ` · ${formatWeeks([hours.low, hours.high], weeklyHours)} at ${weeklyHours} h/week` : ''}
        </span>
        {pulledIn.length > 0 ? (
          <span data-testid="frontier-pulled">
            {formatNumber(pulledIn.length)} of them {pulledIn.length === 1 ? 'is a prerequisite' : 'are prerequisites'}{' '}
            this career never lists — they are in the route because something above needs them.
          </span>
        ) : null}
        <span>
          Estimates are planning ranges for a typical learner, not a promise, and self-ratings are not verified.
        </span>
        </div>
      </Card>
    </div>
  )
}


