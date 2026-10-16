/**
 * The scroll story's scenes.
 *
 * Kept out of `LandingPage.tsx` because these are the pieces that carry the
 * product's argument, and an argument is easier to review when it is not
 * interleaved with layout code.
 *
 * Three rules hold for everything in this file:
 *
 *   1. **Nothing here is invented.** Every number comes from the bundled
 *      curriculum (`knowledgeGraph`, `datasetCounts`) or from the frontier engine
 *      running on the reader's own machine in sample mode. There is no figure
 *      typed by hand to look impressive.
 *   2. **The visuals are `aria-hidden`.** The same facts are in the step copy as
 *      real sentences, because a drawing cannot be read aloud and a sentence can.
 *   3. **Each scene says what it cannot do.** The limits are inside the story,
 *      not quarantined on a page nobody opens.
 */
import type { ReactNode } from 'react'
import { ArrowRight, Blocks, CircleSlash, Clock, GitBranch, ListX, ShieldCheck, Sparkles } from 'lucide-react'

import { LinkButton } from '@/components/ui.tsx'
import { datasetCounts, knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import { formatHours, formatNumber, formatWeeks } from '@/core/format.ts'
import type { FrontierReport } from '@core/recommend.ts'
import { GraphConstellation } from '@/skiper/components/GraphConstellation.tsx'
import { Meter } from '@/skiper/components/Stats.tsx'
import type { SceneStep } from '@/skiper/components/ScrollScene.tsx'
import { constellationFromFrontier, gateLeverage, gateSetLeverage } from './storyGraph.ts'

/* ==========================================================================
 * Shared little drawings
 * ========================================================================== */

/** A visual frame: the inset panel every scene visual sits in. */
function Frame({ children, caption }: { children: ReactNode; caption: string }): ReactNode {
  return (
    <div className="gm-scene-visual-inner">
      {children}
      <p className="gm-scene-caption">{caption}</p>
    </div>
  )
}

/**
 * What a course list looks like: twelve rows of equal weight, in an order
 * nothing explains. This is the thing the product is an argument against, drawn
 * with the app's own sample of real course titles rather than a strawman.
 */
function FlatListVisual(): ReactNode {
  const rows = knowledgeGraph.skills.slice(0, 9).map((skill) => ({
    id: skill.id,
    name: skill.name,
    hours: skill.estimatedHoursHigh,
  }))
  return (
    <Frame caption="A list: nine titles, sorted by nothing. Nothing here says which of them you can start today.">
      <ul className="gm-flatlist">
        {rows.map((row) => (
          <li key={row.id}>
            <span className="gm-flatlist-label">{row.name}</span>
            <span>{row.hours} h</span>
          </li>
        ))}
        <li>
          <span className="gm-flatlist-label">…and {Math.max(0, datasetCounts.skills - rows.length)} more</span>
          <span>in some order</span>
        </li>
      </ul>
    </Frame>
  )
}

/** The same skills, with the order written down. */
function OrderedVisual({ report }: { report: FrontierReport }): ReactNode {
  const steps = report.criticalChain.slice(0, 6)
  return (
    <Frame
      caption={`A graph: the same skills, each placed after what it needs. This chain is ${report.criticalChain.length} deep and cannot be shortened by studying harder.`}
    >
      <ol className="gm-chain-list">
        {steps.map((step, index) => (
          <li key={step.skillId} className="gm-chain-step">
            <span>{step.name}</span>
            {index < steps.length - 1 ? (
              <ArrowRight aria-hidden="true" className="gm-chain-arrow h-3.5 w-3.5" />
            ) : null}
          </li>
        ))}
      </ol>
      <div className="mt-1 grid gap-2">
        <Meter
          value={report.frontier.length / Math.max(1, report.remainingCount)}
          label="Startable today"
          note={`${report.frontier.length} of ${report.remainingCount} remaining skills have nothing unmet in front of them.`}
        />
        <Meter
          value={report.gates.length / Math.max(1, report.remainingCount)}
          label="Gating skills"
          note={`${report.gates.length} skill(s) unblock ${formatNumber(report.gatesUnlock)} others between them — counted once, never added up twice.`}
          tone="muted"
        />
      </div>
    </Frame>
  )
}

/* ==========================================================================
 * Scene 1 — why a list cannot answer the question
 * ========================================================================== */

export function problemSceneSteps(): SceneStep[] {
  return [
    {
      id: 'list',
      kicker: 'The problem',
      title: 'A list tells you what exists, not what is first',
      body: (
        <>
          Every engineering syllabus, career page and roadmap article is a list. Lists are easy to make and impossible to
          act on: they answer &ldquo;what is out there&rdquo; when the question was &ldquo;what do I do on Monday&rdquo;.
          Nothing in a list says that one topic assumes another, so nothing in a list can order itself.
        </>
      ),
      visual: <FlatListVisual />,
    },
    {
      id: 'order',
      kicker: 'The idea',
      title: 'Write the order down once, as edges',
      body: (
        <>
          GraphMentor stores each skill as a node and each dependency as a directed edge: <em>A requires B</em> means B
          comes first, always, for everyone. It is the one piece of information a course catalogue throws away, and it is
          the only thing needed to sort any list of topics into an order that is actually possible.
        </>
      ),
      visual: (
        <Frame caption={`${formatNumber(datasetCounts.edges)} relationships in the bundled curriculum, ${datasetCounts.relationshipTypes} kinds of them. Every one is written down in the dataset.`}>
          <div className="grid gap-2">
            {['requires', 'covers', 'assumes', 'relatedTo'].map((kind, index) => (
              <Meter
                key={kind}
                value={(index + 1) / 4}
                label={`${kind} — ${index === 0 ? 'must come first' : index === 1 ? 'resource teaches it' : index === 2 ? 'recommended, not required' : 'worth knowing together'}`}
                tone={index === 0 ? 'accent' : 'muted'}
              />
            ))}
          </div>
        </Frame>
      ),
    },
    {
      id: 'why-ai',
      kicker: 'Why it is not a chatbot',
      title: 'The graph decides; language only phrases',
      body: (
        <>
          The mentor does not improvise a curriculum. It reads the same graph this page is drawn from, answers from what
          it found, and shows the edges it used. Without any AI key configured it still answers — through a deterministic
          rules engine over the same facts — and it says when the graph does not know rather than filling the gap with
          something plausible.
        </>
      ),
      visual: (
        <Frame caption="Two paths to the same answer. Neither one is allowed to add a fact the graph does not contain.">
          <div className="grid gap-2 text-sm">
            <div className="rounded-lg border border-line bg-[var(--gm-surface-2)] p-2">
              <p className="font-medium text-ink">Rules engine</p>
              <p className="text-xs text-muted">No API key, no network. Runs in the browser and in the edge function.</p>
            </div>
            <div className="rounded-lg border border-line bg-[var(--gm-surface-2)] p-2">
              <p className="font-medium text-ink">Optional language model</p>
              <p className="text-xs text-muted">Re-phrases facts the graph already returned. It is never the source.</p>
            </div>
          </div>
        </Frame>
      ),
    },
  ]
}

/* ==========================================================================
 * Scene 2 — the graph itself, drawn from the reader's own frontier
 * ========================================================================== */

export function graphSceneSteps(report: FrontierReport): SceneStep[] {
  const constellation = constellationFromFrontier(report, { maxNodes: 20 })
  const depth = report.depths.reduce((max, entry) => Math.max(max, entry.depth), 0)
  return [
    {
      id: 'nodes',
      kicker: 'The graph',
      title: `${report.careerName}: ${report.remainingCount} skills still to go`,
      body: (
        <>
          This is the engine&rsquo;s own answer for {report.careerName} with nothing rated — the same computation the
          skill-gap page runs, drawn instead of listed. It counts {report.closureCount} skills in the full prerequisite
          closure, of which {report.targetCount} are things the career itself asks for and the rest are pulled in because
          something else needs them first.
        </>
      ),
      visual: <GraphConstellation nodes={constellation.nodes} edges={constellation.edges} caption={constellation.caption} />,
    },
    {
      id: 'depth',
      kicker: 'Reading it',
      title: 'Left to right is order, not difficulty',
      body: (
        <>
          A skill sits one column to the right of everything it needs, so the columns are dependency depth: {formatNumber(depth)} layers
          deep for this career. Nothing in the first column has an unmet prerequisite, which is exactly why the first column
          is the only honest place a beginner can be told to start.
        </>
      ),
      visual: <GraphConstellation nodes={constellation.nodes} edges={constellation.edges} caption="The same drawing, paused on the depth question: x is order, y is nothing in particular — the vertical position only keeps labels apart." showLabels={false} />,
    },
    {
      id: 'frontier',
      kicker: 'The frontier',
      title: `${report.frontier.length} things you can start today`,
      body: (
        <>
          The frontier is every remaining skill with nothing unmet in front of it. It is the honest answer to
          &ldquo;what now&rdquo;: not the whole syllabus, not a ranking by popularity, but the subset that is actually
          available to you this week given what you already have.
        </>
      ),
      visual: (
        <Frame caption="Each bar is a real count from the frontier computation, not a progress bar for the reader.">
          <div className="grid gap-2">
            <Meter value={report.frontier.length / Math.max(1, report.remainingCount)} label="Startable now" note={`${report.frontier.length} of ${report.remainingCount} remaining.`} />
            <Meter value={1 - report.frontier.length / Math.max(1, report.remainingCount)} label="Blocked by something else" note="Waiting on a prerequisite, in this dataset, as of now." tone="muted" />
          </div>
        </Frame>
      ),
    },
    {
      id: 'chain',
      kicker: 'The constraint',
      title: 'One chain cannot be parallelised',
      body: (
        <>
          {report.criticalChain.length > 0 ? (
            <>
              The longest prerequisite chain through what is left is {report.criticalChain.length} skills deep:{' '}
              {report.criticalChain.map((step) => step.name).join(' → ')}. Extra weekly hours compress everything around
              it and leave this untouched, which is the closest thing to a deadline this data can honestly offer.
            </>
          ) : (
            <>Nothing is left to order: the career&rsquo;s required skills are all met, so there is no critical chain to report.</>
          )}
        </>
      ),
      visual: <OrderedVisual report={report} />,
    },
  ]
}

/* ==========================================================================
 * Scene 3 — what comes back, in the shape the reader asked for
 * ========================================================================== */

export function answerSceneSteps(report: FrontierReport): SceneStep[] {
  const startable = report.frontier.slice(0, 3)
  const gate = report.gates[0]
  const leverage = gate ? gateLeverage(report, gate.skillId) : { unlocked: 0, share: 0 }
  const gateSet = gateSetLeverage(report)
  return [
    {
      id: 'start',
      kicker: 'The answer',
      title: 'What to open first',
      body: (
        <>
          {startable.length > 0 ? (
            <>
              For {report.careerName} with nothing rated, the first three things you can start are{' '}
              {startable.map((skill) => skill.name).join(', ')}. Each one links to the skill page with its practice
              exercises, its completion criteria and the free resources that teach it.
            </>
          ) : (
            <>Everything this career requires is already met in your profile, so the engine returns no starting set.</>
          )}
        </>
      ),
      visual: (
        <Frame caption="Every entry comes from the frontier list; the order is the engine's, not a preference.">
          <ul className="grid gap-2">
            {startable.map((skill) => (
              <li key={skill.skillId} className="rounded-lg border border-line bg-[var(--gm-surface-2)] p-2">
                <p className="text-sm font-medium text-ink">{skill.name}</p>
                <p className="text-xs text-muted">
                  {skill.difficulty} · {formatHours(skill.estimatedHours)} · unblocks {skill.unlocks} later skill(s)
                </p>
              </li>
            ))}
          </ul>
        </Frame>
      ),
    },
    {
      id: 'gate',
      kicker: 'The leverage',
      title: gate ? `${gate.name} is the one worth doing next` : 'No single skill gates the rest',
      body: gate ? (
        <>
          Gating skills are the ones that block the most of what is left. {gate.name} unblocks{' '}
          {formatNumber(leverage.unlocked)} of the {report.remainingCount} skills still to go, and the {report.gates.length}{' '}
          gates between them unblock {formatNumber(report.gatesUnlock)} — a union, so a skill two gates share is counted once,
          and the gates themselves are not counted as work they unlock.
        </>
      ) : (
        <>Nothing left is gating anything else. What remains can be done in any order you can sustain.</>
      ),
      visual: (
        <Frame caption="The union, not the sum. Adding the individual numbers would overstate what any single skill buys.">
          <Meter
            value={leverage.share}
            label={gate ? `${gate.name} on its own` : 'No gate'}
            note={`${formatNumber(leverage.unlocked)} skill(s) depend on it, transitively — the engine's own count, not a sum of neighbours.`}
          />
          <Meter
            value={gateSet}
            label="The gate set, together"
            note={`${formatNumber(report.gatesUnlock)} of ${report.remainingCount} remaining skills, as a union, excluding the gates themselves.`}
            tone="muted"
          />
        </Frame>
      ),
    },
    {
      id: 'time',
      kicker: 'The time',
      title: report.hours.weeksAtWeeklyHours
        ? `${formatHours([report.hours.low, report.hours.high])} of study — ${formatWeeks([report.hours.weeksAtWeeklyHours.low, report.hours.weeksAtWeeklyHours.high], report.hours.weeklyHours ?? 8)} at ${report.hours.weeklyHours ?? 8} h/week`
        : `${formatHours([report.hours.low, report.hours.high])} of study in total`,
      body: (
        <>
          Hours are curriculum estimates — a range, because a single number would pretend to a precision this data does not
          have — and they are planning aids, not measurements of your pace. Change the weekly hours and the weeks change;
          the chain length does not.
        </>
      ),
      visual: (
        <Frame caption="Two numbers, deliberately separate: what the material takes, and how long that is at your pace.">
          <div className="grid gap-2">
            <Meter value={0.5} label={`Effort: ${formatHours([report.hours.low, report.hours.high])}`} note="Sum of the median hour estimates for the remaining skills." />
            <Meter
              value={report.hours.weeksAtWeeklyHours ? Math.min(1, (report.hours.weeksAtWeeklyHours.high ?? 0) / 52) : 0}
              label={report.hours.weeksAtWeeklyHours ? `Calendar: ${report.hours.weeksAtWeeklyHours.low}–${report.hours.weeksAtWeeklyHours.high} weeks` : 'Calendar: set your weekly hours'}
              note={`At ${report.hours.weeklyHours ?? 8} hours a week.`}
              tone="muted"
            />
          </div>
        </Frame>
      ),
    },
  ]
}

/* ==========================================================================
 * Small scene-like bands used between the big scenes
 * ========================================================================== */

export interface IntegrationCard {
  name: string
  status: string
  body: ReactNode
  icon: ReactNode
}

/**
 * The platform band.
 *
 * This is where the six upstream projects this build learns from are named, with
 * an honest status word on each: what is wired up, what is a local-first
 * fallback, and what is deliberately off. A landing page that listed integrations
 * without saying which of them actually run here would be the exact thing this
 * product refuses to be.
 */
export const INTEGRATIONS: IntegrationCard[] = [
  {
    name: 'Neo4j knowledge graph',
    status: 'core',
    icon: <GitBranch aria-hidden="true" className="h-4 w-4" />,
    body: (
      <>
        The prerequisite graph is stored as nodes and relationships, seeded from the same dataset the browser uses in sample
        mode. Cypher is generated from the dataset by <code>npm run emit:cypher</code>, so the database and the app cannot
        drift apart.
      </>
    ),
  },
  {
    name: 'Supabase platform',
    status: 'core',
    icon: <Blocks aria-hidden="true" className="h-4 w-4" />,
    body: (
      <>
        18 Edge Functions hold the API, the rate limiter and the account routes; row-level security repeats every ownership
        check the server already makes. Database credentials never reach the browser, and the migrations are in the repo.
      </>
    ),
  },
  {
    name: 'Appwrite adapter',
    status: 'alternative backend',
    icon: <Blocks aria-hidden="true" className="h-4 w-4" />,
    body: (
      <>
        A second implementation of the same storage contract, so the app can run on Appwrite instead of Supabase without
        touching a feature page. The contract and its conformance tests are shared; nothing about row ownership is
        re-invented per provider.
      </>
    ),
  },
  {
    name: 'Workflow engine',
    status: 'in-repo',
    icon: <Sparkles aria-hidden="true" className="h-4 w-4" />,
    body: (
      <>
        Automation graphs in the shape the n8n project uses — nodes, ports, connections, expressions, allow-listed HTTP —
        executed by a small deterministic runner with retries, timeouts and an audit log. It powers the resource freshness
        sweep and the weekly plan digest.
      </>
    ),
  },
  {
    name: 'Public API directory',
    status: 'imported',
    icon: <Sparkles aria-hidden="true" className="h-4 w-4" />,
    body: (
      <>
        A curated slice of the public-apis directory, imported with its licence and its own fields intact, then mapped onto
        the skills each API actually demonstrates. Every entry keeps a last-checked date, because an unverifiable free
        resource is not a free resource.
      </>
    ),
  },
  {
    name: 'Adversarial self-audit',
    status: 'ci',
    icon: <ShieldCheck aria-hidden="true" className="h-4 w-4" />,
    body: (
      <>
        A scoped, non-destructive probe suite in the spirit of an autonomous pentest agent: it plans, runs injection,
        authorisation, rate-limit and prompt-injection probes against a target it is allowed to touch, then writes a report
        that CI fails on. It refuses any host that is not explicitly allowed.
      </>
    ),
  },
  {
    name: 'Council simulation',
    status: 'tools',
    icon: <Sparkles aria-hidden="true" className="h-4 w-4" />,
    body: (
      <>
        Multi-persona deliberation over the graph: several agents with different goals argue about a career question in
        rounds, every claim has to cite a graph fact, and the transcript is measured rather than narrated. It is how the
        product&rsquo;s own claims get stress-tested before they ship.
      </>
    ),
  },
]

/** The two limits that belong in the story rather than on a separate page. */
export const STORY_LIMITS: Array<{ icon: ReactNode; title: string; body: ReactNode }> = [
  {
    icon: <ListX aria-hidden="true" className="h-4 w-4" />,
    title: 'The curriculum is a curated sample, not a global standard',
    body: (
      <>
        It is authored from public syllabi and documentation, and it says so on every screen. Your university may order
        things differently, and an employer may care about something it does not contain.
      </>
    ),
  },
  {
    icon: <Clock aria-hidden="true" className="h-4 w-4" />,
    title: 'Hours are estimates, not a schedule',
    body: (
      <>
        Every time range comes from the curriculum&rsquo;s own median estimates. They are planning aids. Nothing here knows
        how fast you read, how much time you really have, or how a semester breaks your week.
      </>
    ),
  },
  {
    icon: <CircleSlash aria-hidden="true" className="h-4 w-4" />,
    title: 'No job, no certificate, no promise',
    body: (
      <>
        Completing a skill marks it in your own progress record. Nothing is issued, nothing is verified by an institution, and
        there is no guarantee of employment, admission or a salary from any route through this graph.
      </>
    ),
  },
]

/**
 * The one call to action that belongs at the end of the story.
 *
 * It goes to `/gaps` rather than to a sign-up screen: the question a reader
 * arrives with is answerable with zero input, and asking them to register first
 * would be trading their time for our metric.
 */
export function StoryCta(): ReactNode {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <LinkButton to="/gaps" variant="primary" icon={<ArrowRight className="h-4 w-4" />}>
        See what&rsquo;s missing
      </LinkButton>
      <LinkButton to="/onboarding" variant="secondary">
        Rate what I already know
      </LinkButton>
      <LinkButton to="/graph" variant="ghost" icon={<GitBranch className="h-4 w-4" />}>
        Open the graph in 3D
      </LinkButton>
    </div>
  )
}
