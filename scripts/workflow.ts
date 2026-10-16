/**
 * The workflow CLI.
 *
 * Same engine, same library, no browser. This exists because a workflow that can
 * only be run by clicking is a workflow nobody puts in CI, and the freshness sweep
 * in particular is only worth having if it runs on a schedule somewhere that is
 * not somebody's laptop.
 *
 *   npm run workflow -- --list
 *   npm run workflow -- --id workflow:resource-freshness-sweep
 *   npm run workflow -- --id workflow:weekly-plan-digest --json
 *   npm run workflow -- --due                     # what a scheduler would fire now
 *   npm run workflow -- --export-n8n tmp/n8n      # review documents, not a runtime
 *
 * Flags that matter:
 *   --dry-run        plan and log, perform no writes and no outbound requests
 *   --no-network     refuse every outbound probe, as a laptop with no wifi must
 *   --allow-probe    permit the resource check to actually make requests; without
 *                    it, the probe node skips and says so. Default is off, because
 *                    a command that reaches out to third-party sites should be an
 *                    explicit choice in a script, never a surprise.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { knowledgeGraph } from '../src/data/seed/knowledgeGraph.ts'
import { loadCareerSlice } from '../supabase/functions/_shared/core/careerSlice.ts'
import { createLocalReader } from '../supabase/functions/_shared/core/localReader.ts'
import { analyzeFrontier, buildPathway, rankResources } from '../supabase/functions/_shared/core/recommend.ts'
import { DEFAULT_CONTEXT_LIMITS, buildMentorContext, classifyIntent } from '../supabase/functions/_shared/core/mentorContext.ts'
import { answerWithRules } from '../supabase/functions/_shared/core/fallbackMentor.ts'
import { createWorkflowServices } from '../supabase/functions/_shared/core/workflow/services.ts'
import { runWorkflow } from '../supabase/functions/_shared/core/workflow/engine.ts'
import { WORKFLOW_LIBRARY, findWorkflow, scheduledWorkflows } from '../supabase/functions/_shared/core/workflow/library.ts'
import { exportLibrary } from '../supabase/functions/_shared/core/workflow/n8nCompat.ts'
import { describeCron, isDue } from '../supabase/functions/_shared/core/workflow/cron.ts'
import type { SkillState } from '../supabase/functions/_shared/core/types.ts'
import type { WorkflowDefinition, WorkflowServices } from '../supabase/functions/_shared/core/workflow/types.ts'
import { listPublicApis } from '../src/data/publicApis/index.ts'

interface Args {
  list: boolean
  due: boolean
  json: boolean
  dryRun: boolean
  allowProbe: boolean
  id: string | null
  exportN8n: string | null
  weeklyHours: number
  ratings: Array<{ skillId: string; state: string }>
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    list: false,
    due: false,
    json: false,
    dryRun: false,
    allowProbe: false,
    id: null,
    exportN8n: null,
    weeklyHours: 8,
    ratings: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--list') args.list = true
    else if (flag === '--due') args.due = true
    else if (flag === '--json') args.json = true
    else if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--allow-probe') args.allowProbe = true
    else if (flag === '--no-network') args.allowProbe = false
    else if (flag === '--id' && value) args.id = value
    else if (flag === '--export-n8n' && value) args.exportN8n = value
    else if (flag === '--weekly-hours' && value) args.weeklyHours = Number(value)
    else if (flag === '--rating' && value) {
      // --rating skill:version-control-git=confident
      const [skillId, state] = value.split('=')
      if (skillId && state) args.ratings.push({ skillId, state })
    }
  }
  return args
}

/**
 * Services for a CLI run: the bundled dataset through the same reader the app
 * uses, resources ranked by the same function, and the mentor answered by the
 * same rules engine. No key, no database, no network.
 */
function cliServices(args: Args, records: Array<{ collection: string; item: Record<string, unknown> }>): WorkflowServices {
  const reader = createLocalReader(knowledgeGraph)
  /* Only the skills the workflow asks about are read, and each read is cached by
     career, so a five-node workflow reads the graph once. */
  const slices = new Map<string, Awaited<ReturnType<typeof loadCareerSlice>>>()
  const sliceFor = async (careerId: string) => {
    const cached = slices.get(careerId)
    if (cached) return cached
    const slice = await loadCareerSlice(reader, careerId, { depth: 6, maxSkills: 400 })
    slices.set(careerId, slice)
    return slice
  }

  return createWorkflowServices(
    {
      frontier: async ({ careerId, weeklyHours }) => {
        const slice = await sliceFor(careerId)
        const report = analyzeFrontier({
          careerId: slice.careerId,
          careerName: slice.careerName,
          careerSkills: slice.careerSkills,
          skillMeta: slice.skillMeta,
          prereqEdges: slice.prereqEdges,
          ratings: args.ratings.map((rating) => ({ skillId: rating.skillId, state: rating.state as SkillState })),
          weeklyHours,
        })
        return {
          remainingCount: report.remainingCount,
          summaryLine: report.summaryLine,
          frontier: report.frontier.map((skill) => ({ skillId: skill.skillId, name: skill.name, unlocks: skill.unlocks })),
          criticalChain: report.criticalChain.map((step) => ({ skillId: step.skillId, name: step.name })),
          gates: report.gates.map((gate) => ({ skillId: gate.skillId, name: gate.name, unlocks: gate.unlocks })),
          gatesUnlock: report.gatesUnlock,
          hours: { low: report.hours.low, high: report.hours.high },
        }
      },
      pathway: async ({ careerId, ratings, weeklyHours, pace, learningStyle, difficultyComfort }) => {
        const slice = await sliceFor(careerId)
        const pathway = buildPathway({
          careerId: slice.careerId,
          careerName: slice.careerName,
          careerSkills: slice.careerSkills,
          skillMeta: slice.skillMeta,
          prereqEdges: slice.prereqEdges,
          ratings: ratings.map((rating) => ({ skillId: rating.skillId, state: rating.state as SkillState })),
          weeklyHours,
          pace: pace ?? 'steady',
          learningStyle: learningStyle ?? 'mixed',
          difficultyComfort: difficultyComfort ?? 'beginner',
        })
        return {
          steps: pathway.steps.map((step) => ({
            order: step.order,
            skillId: step.skillId,
            name: step.name,
            dependsOn: step.dependsOn,
            unlocks: step.unlocks,
            estimatedHours: step.estimatedHours,
          })),
          totalHours: pathway.estimatedHours,
          alternatives: pathway.alternatives.length,
        }
      },
      resources: async ({ skillIds, limit }) => {
        const slice = await sliceFor('career:software-engineer')
        const ranked = rankResources(
          slice.resources.map((resource) => ({ ...resource, matchedSkillIds: resource.coversIds, matchReason: '', accessBadge: '' })) as never,
          skillIds,
          limit,
        )
        return ranked.map((resource) => ({
          id: resource.id,
          name: resource.name,
          url: resource.url,
          accessModel: resource.accessModel,
          verified: resource.lastVerified,
        }))
      },
      mentor: async ({ question, careerId }) => {
        const slice = await sliceFor(careerId ?? 'career:software-engineer')
        const context = await buildMentorContext({
          reader,
          message: question,
          intent: classifyIntent(question),
          careerId: careerId ?? null,
          vocabulary: [{ id: slice.careerId, name: slice.careerName, label: 'Career' }],
          limits: DEFAULT_CONTEXT_LIMITS,
        })
        const answer = answerWithRules({
          request: { message: question, mode: 'concise', careerId: careerId ?? null },
          context,
        })
        return { answer: answer.answer, citations: answer.graphBasis }
      },
      publicApis: async ({ skillIds, limit }) => listPublicApis({ skillIds, limit }).map((entry) => ({ name: entry.name, url: entry.url, category: entry.category })),
      record: async ({ collection, item }) => {
        records.push({ collection, item })
      },
    },
    {
      dataSource: 'bundled-sample',
      /* Outbound probes are opt-in. Without --allow-probe the probe node skips and
         the run log says why, which is the honest outcome for a CI job that has
         not been given permission to hammer third-party sites. */
      network: args.allowProbe && !args.dryRun,
      unavailableNote: 'Run with --allow-probe to let the resource check make requests.',
    },
  )
}

function printRun(definition: WorkflowDefinition, result: Awaited<ReturnType<typeof runWorkflow>>): void {
  process.stdout.write(`\n${definition.name} (${definition.id}) — ${result.status}\n`)
  process.stdout.write(`  ${result.startedAt} → ${result.finishedAt} (${result.durationMs}ms), source ${result.environment.dataSource}${result.environment.dryRun ? ', dry run' : ''}\n`)
  for (const node of result.nodes) {
    const detail = node.skipReason ?? node.error ?? ''
    process.stdout.write(
      `  ${node.status.padEnd(9)} ${node.nodeName.padEnd(12)} ${String(node.inputCount).padStart(3)} in / ${String(node.outputCount).padStart(3)} out  ${String(node.durationMs).padStart(5)}ms  ${detail}\n`,
    )
  }
  if (result.caveats.length > 0) {
    process.stdout.write('  caveats:\n')
    for (const caveat of result.caveats) process.stdout.write(`    - ${caveat}\n`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.list || (!args.id && !args.exportN8n && !args.due)) {
    process.stdout.write('Workflows in this repository:\n')
    for (const definition of WORKFLOW_LIBRARY) {
      const trigger =
        definition.trigger.kind === 'schedule' && definition.trigger.cron
          ? `schedule: ${definition.trigger.cron} — ${describeCron(definition.trigger.cron)}`
          : 'run by hand'
      process.stdout.write(`  ${definition.id}\n    ${definition.name} · ${definition.nodes.length} steps · ${trigger}\n`)
    }
    if (!args.id && !args.exportN8n) return
  }

  if (args.due) {
    const now = new Date()
    process.stdout.write(`Due at ${now.toISOString()}:\n`)
    const due = scheduledWorkflows().filter(({ cron }) => isDue(cron, now))
    if (due.length === 0) process.stdout.write('  nothing\n')
    for (const { workflow } of due) process.stdout.write(`  ${workflow.id}\n`)
    return
  }

  if (args.exportN8n) {
    const directory = resolve(process.cwd(), args.exportN8n)
    mkdirSync(directory, { recursive: true })
    const files = exportLibrary(WORKFLOW_LIBRARY)
    for (const [name, document] of Object.entries(files)) {
      writeFileSync(resolve(directory, name), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    }
    process.stdout.write(`Wrote ${Object.keys(files).length} n8n document(s) to ${directory} — for review, not for execution.\n`)
    return
  }

  const definition = findWorkflow(args.id ?? '')
  if (!definition) {
    process.stderr.write(`No workflow called "${args.id}". Try --list.\n`)
    process.exitCode = 1
    return
  }

  const records: Array<{ collection: string; item: Record<string, unknown> }> = []
  const result = await runWorkflow(definition, cliServices(args, records), { dryRun: args.dryRun })

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ run: result, records }, null, 2)}\n`)
  } else {
    printRun(definition, result)
    if (records.length > 0) process.stdout.write(`  wrote ${records.length} record(s): ${[...new Set(records.map((record) => record.collection))].join(', ')}\n`)
  }

  // A failed run is a failed command: CI must not read a red run as green.
  if (result.status === 'failed') process.exitCode = 1
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
