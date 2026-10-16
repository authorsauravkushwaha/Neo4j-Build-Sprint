/**
 * The workflow library.
 *
 * Five workflows that do real work in this repository, written as data so the UI
 * can draw them, the CLI can run them and the tests can inspect them. They are
 * not examples in a documentation page: two of them are what the verification
 * suite runs, one is what keeps the resource library's "last checked" dates
 * honest, and one exports the fixture the Java oracle compares against.
 *
 * Every one of them carries its own `limitations` array, and the engine appends
 * that array to every run's caveats. A workflow that produces a plan without
 * saying what the plan cannot know would be the same failure as a course list
 * that promises a job.
 */
import type { WorkflowDefinition } from './types.ts'

/**
 * Resource freshness sweep.
 *
 * Weekly, in CI, and by hand when someone wants to know whether the library has
 * rotted. It probes every resource URL that this workflow is allowed to touch and
 * reports the ones that stopped answering. It never edits the dataset: a human
 * decides what to do about a dead link, because "the check failed" and "this book
 * is worthless now" are different claims.
 */
const resourceFreshnessSweep: WorkflowDefinition = {
  id: 'workflow:resource-freshness-sweep',
  name: 'Resource freshness sweep',
  version: 3,
  description:
    'Probes every free resource URL for the skills of a career and reports the ones that stopped answering, so the "last checked" date in the library is a measurement rather than a claim.',
  limitations: [
    'A failed probe means the URL did not answer from this machine right now — not that the resource is gone, and never that it is worthless.',
    'Only https URLs on the allow-list below are probed. Anything else is recorded as not-probed, with the reason.',
    'It records findings; it never edits the curriculum. Removing a resource is a reviewed change.',
    'A redirect to a paywall answers 200 and therefore passes. Nobody has automated the harder question of whether the free tier still covers the material.',
  ],
  trigger: { kind: 'schedule', cron: '0 6 * * 1', description: 'Mondays at 06:00 UTC' },
  settings: {
    allowedHosts: [
      'developer.mozilla.org',
      'docs.python.org',
      'git-scm.com',
      'leetcode.com',
      'ocw.mit.edu',
      'regex101.com',
      'roadmap.sh',
      'sqlite.org',
      'www.freecodecamp.org',
      'www.khanacademy.org',
    ],
    limits: { maxNodes: 20, maxItemsPerNode: 400, maxRunMs: 90_000 },
  },
  nodes: [
    { id: 'n1', name: 'Weekly', type: 'gm.trigger.schedule', typeVersion: 1, position: [0, 0], parameters: { cron: '0 6 * * 1' } },
    {
      id: 'n2',
      name: 'Frontier',
      type: 'gm.graph.frontier',
      typeVersion: 2,
      position: [220, 0],
      parameters: { careerId: 'career:software-engineer', weeklyHours: 8 },
      notes: 'Used for its skill list, not its numbers: the sweep is about resources.',
    },
    {
      id: 'n3',
      name: 'Resources',
      type: 'gm.resources.list',
      typeVersion: 1,
      position: [440, 0],
      parameters: { limit: 40 },
    },
    {
      id: 'n4',
      name: 'Probe',
      type: 'gm.resources.check',
      typeVersion: 2,
      position: [660, 0],
      parameters: { timeoutMs: 6000 },
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 400,
      // One dead link is a finding, not a reason to abandon the sweep.
      onError: 'continue',
    },
    {
      id: 'n5',
      name: 'Report',
      type: 'gm.io.digest',
      typeVersion: 1,
      position: [880, 0],
      parameters: { title: 'Resource freshness, {{ $now }}' },
    },
    {
      id: 'n6',
      name: 'Record',
      type: 'gm.io.record',
      typeVersion: 1,
      position: [1100, 0],
      parameters: { collection: 'resource-checks' },
    },
  ],
  connections: {
    Weekly: { main: [[{ node: 'Frontier', type: 'main', index: 0 }]] },
    Frontier: { main: [[{ node: 'Resources', type: 'main', index: 0 }]] },
    Resources: { main: [[{ node: 'Probe', type: 'main', index: 0 }]] },
    Probe: { main: [[{ node: 'Report', type: 'main', index: 0 }]] },
    Report: { main: [[{ node: 'Record', type: 'main', index: 0 }]] },
  },
}

/**
 * Weekly plan digest.
 *
 * What a study group actually wants on a Monday: the three things worth starting,
 * the skills that gate the rest, and the chain that extra hours will not shorten.
 * Every number is the frontier engine's, and the digest records where they came
 * from.
 */
const weeklyPlanDigest: WorkflowDefinition = {
  id: 'workflow:weekly-plan-digest',
  name: 'Weekly plan digest',
  version: 2,
  description:
    'Turns the frontier for one career and one stated profile into a short, ordered plan: what to start, what it unblocks, and how deep the unshortenable chain runs.',
  limitations: [
    'It does not know your calendar, your exams or your energy. It orders the material; you place it in a week.',
    'Hour ranges are the curriculum median, not a measurement of anyone’s pace.',
    'The profile in the parameters is the only profile it can see. Nothing is inferred from your history.',
  ],
  trigger: { kind: 'manual', description: 'Run by hand, or from the workflow page' },
  settings: { limits: { maxNodes: 20, maxItemsPerNode: 200, maxRunMs: 30_000 } },
  nodes: [
    { id: 'd1', name: 'Start', type: 'gm.trigger.manual', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'd2',
      name: 'Frontier',
      type: 'gm.graph.frontier',
      typeVersion: 2,
      position: [220, 0],
      parameters: {
        careerId: 'career:software-engineer',
        weeklyHours: 8,
        ratings: [
          { skillId: 'skill:programming-fundamentals', state: 'confident' },
          { skillId: 'skill:version-control-git', state: 'confident' },
        ],
      },
      notes: 'The stated profile is written here, in the workflow file, because a hidden profile is a hidden assumption.',
    },
    {
      id: 'd3',
      name: 'Plan',
      type: 'gm.roadmap.plan',
      typeVersion: 1,
      position: [440, 0],
      parameters: { careerId: 'career:software-engineer', weeklyHours: 8 },
    },
    {
      id: 'd4',
      name: 'Line',
      type: 'gm.transform.template',
      typeVersion: 1,
      position: [660, 0],
      parameters: {
        text: '{{ $node["Frontier"].json.summary }} Start with: {{ $node["Frontier"].json.startable }}. Gates: {{ $node["Frontier"].json.gates }}. Chain: {{ $node["Frontier"].json.criticalChain }}.',
      },
    },
    {
      id: 'd5',
      name: 'Digest',
      type: 'gm.io.digest',
      typeVersion: 1,
      position: [880, 0],
      parameters: { title: 'This week, from the bundled curriculum' },
    },
  ],
  connections: {
    Start: { main: [[{ node: 'Frontier', type: 'main', index: 0 }]] },
    Frontier: { main: [[{ node: 'Plan', type: 'main', index: 0 }]] },
    Plan: { main: [[{ node: 'Line', type: 'main', index: 0 }]] },
    Line: { main: [[{ node: 'Digest', type: 'main', index: 0 }]] },
  },
}

/**
 * Ask the graph.
 *
 * The mentor, driven from a workflow, so a question can be asked on a schedule
 * and the answer kept with its citations. The `grounding` field the mentor node
 * attaches is the reason this is safe to automate: the output says what it is.
 */
const groundedQuestion: WorkflowDefinition = {
  id: 'workflow:grounded-question',
  name: 'Grounded question',
  version: 1,
  description:
    'Asks the mentor one question from the parameters, records the answer that came only from graph facts, and keeps the citations with it.',
  limitations: [
    'The mentor answers from this app’s bundled curriculum. A question outside it comes back unanswered, on purpose, rather than guessed at.',
    'With no AI provider configured the answer comes from the rules engine; either way the facts are the graph’s.',
  ],
  trigger: { kind: 'manual', description: 'Run by hand, or from the workflow page' },
  settings: { limits: { maxNodes: 12, maxItemsPerNode: 50, maxRunMs: 20_000 } },
  nodes: [
    { id: 'q1', name: 'Start', type: 'gm.trigger.manual', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'q2',
      name: 'Ask',
      type: 'gm.mentor.ask',
      typeVersion: 1,
      position: [220, 0],
      parameters: { question: 'What should I learn before Kubernetes?', careerId: 'career:cloud-and-devops-engineer' },
    },
    {
      id: 'q3',
      name: 'Digest',
      type: 'gm.io.digest',
      typeVersion: 1,
      position: [440, 0],
      parameters: { title: 'Mentor answer with citations' },
    },
  ],
  connections: {
    Start: { main: [[{ node: 'Ask', type: 'main', index: 0 }]] },
    Ask: { main: [[{ node: 'Digest', type: 'main', index: 0 }]] },
  },
}

/**
 * Public API map.
 *
 * Maps the skills in the frontier onto free APIs from the imported public-apis
 * directory, so a learner who wants to build something with what they are
 * learning gets a concrete, callable starting point rather than another course.
 */
const publicApiMap: WorkflowDefinition = {
  id: 'workflow:public-api-map',
  name: 'Public API map',
  version: 1,
  description:
    'Takes the skills a learner is working on and lists free, callable APIs from the imported public-apis directory that demonstrate them.',
  limitations: [
    'The directory is imported and dated, not live. Every entry keeps the date it was last checked.',
    'Free is the publisher’s claim at import time. Rate limits, keys and terms change without notice.',
    'An API being related to a topic is not a lesson. These are practice targets, not a curriculum.',
  ],
  trigger: { kind: 'manual', description: 'Run by hand, from the workflow page' },
  settings: { limits: { maxNodes: 12, maxItemsPerNode: 100, maxRunMs: 20_000 } },
  nodes: [
    { id: 'a1', name: 'Start', type: 'gm.trigger.manual', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'a2',
      name: 'Frontier',
      type: 'gm.graph.frontier',
      typeVersion: 2,
      position: [220, 0],
      parameters: { careerId: 'career:data-scientist', weeklyHours: 6 },
    },
    {
      id: 'a3',
      name: 'Apis',
      type: 'gm.publicApi.map',
      typeVersion: 1,
      position: [440, 0],
      parameters: {
        skillIds: 'skill:programming-fundamentals, skill:data-analysis-and-visualisation, skill:databases-and-sql',
        limit: 8,
      },
    },
    {
      id: 'a4',
      name: 'Digest',
      type: 'gm.io.digest',
      typeVersion: 1,
      position: [660, 0],
      parameters: { title: 'Free APIs to practise with' },
    },
  ],
  connections: {
    Start: { main: [[{ node: 'Frontier', type: 'main', index: 0 }]] },
    Frontier: { main: [[{ node: 'Apis', type: 'main', index: 0 }]] },
    Apis: { main: [[{ node: 'Digest', type: 'main', index: 0 }]] },
  },
}

/**
 * Frontier export.
 *
 * The canonical, diffable fixture that `tools/oracle/FrontierOracle.java`
 * compares against. It exists as a workflow so that "the export ran" and "the
 * export is what the export script produced" are the same statement.
 */
const frontierExport: WorkflowDefinition = {
  id: 'workflow:frontier-export',
  name: 'Frontier export for the Java oracle',
  version: 2,
  description:
    'Writes the canonical frontier lines the cross-language oracle compares against the TypeScript engine. Same inputs, same output, byte for byte.',
  limitations: [
    'It exports what this engine computed. It cannot tell you whether the engine is right — that is the oracle’s job, and the oracle runs separately.',
    'One line per case, sorted by code unit rather than by locale, because the Java side sorts the same way.',
  ],
  trigger: { kind: 'manual', description: 'Run before the oracle, and in CI' },
  settings: { limits: { maxNodes: 12, maxItemsPerNode: 100, maxRunMs: 30_000 } },
  nodes: [
    { id: 'e1', name: 'Start', type: 'gm.trigger.manual', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'e2',
      name: 'Frontier',
      type: 'gm.graph.frontier',
      typeVersion: 2,
      position: [220, 0],
      parameters: { careerId: 'career:software-engineer', weeklyHours: 8 },
    },
    {
      id: 'e3',
      name: 'Record',
      type: 'gm.io.record',
      typeVersion: 1,
      position: [440, 0],
      parameters: { collection: 'oracle-fixture' },
    },
  ],
  connections: {
    Start: { main: [[{ node: 'Frontier', type: 'main', index: 0 }]] },
    Frontier: { main: [[{ node: 'Record', type: 'main', index: 0 }]] },
  },
}

export const WORKFLOW_LIBRARY: readonly WorkflowDefinition[] = [
  resourceFreshnessSweep,
  weeklyPlanDigest,
  groundedQuestion,
  publicApiMap,
  frontierExport,
]

export function findWorkflow(id: string): WorkflowDefinition | undefined {
  return WORKFLOW_LIBRARY.find((workflow) => workflow.id === id)
}

/** The workflows a schedule would fire, in the order their cron says. */
export function scheduledWorkflows(): Array<{ workflow: WorkflowDefinition; cron: string }> {
  return WORKFLOW_LIBRARY.flatMap((workflow) =>
    workflow.trigger.kind === 'schedule' && workflow.trigger.cron ? [{ workflow, cron: workflow.trigger.cron }] : [],
  )
}
