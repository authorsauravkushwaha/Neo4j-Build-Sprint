/**
 * The workflow page.
 *
 * What it shows, and why it looks like this:
 *
 *   * **The graph, not a form.** Each workflow is drawn as its nodes and the
 *     connections between them, because "what does this thing do" is answered by
 *     seeing the order of operations, not by reading a paragraph about it.
 *   * **Every node in the run log.** Including the skipped ones. A workflow page
 *     that only shows the happy path teaches people to trust a green tick.
 *   * **The caveats are on the page, not in a doc.** The engine appends each
 *     workflow's own `limitations` to every run, and this page renders them above
 *     the results rather than in a footnote.
 *   * **Runs happen here.** A run uses the same client the rest of the app uses,
 *     so in sample mode it reads the bundled curriculum in this tab and the log
 *     says so; with a backend configured the same run reads the live graph.
 *
 * The page never sends the workflow anywhere. There is no server-side runner in
 * this deployment: pretending otherwise would be the exact dishonesty the run
 * log exists to prevent, so the copy says "runs in this tab" out loud.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Download, Play, RotateCcw } from 'lucide-react'

import { Button, Callout, Card, Chip, List, PageHeader, SectionTitle } from '@/components/ui.tsx'
import { api } from '@/core/session.ts'
import { createClientWorkflowServices } from '@/core/workflowServices.ts'
import { runWorkflow, type RunResult } from '@core/workflow/engine.ts'
import { describeCron } from '@core/workflow/cron.ts'
import { WORKFLOW_LIBRARY } from '@core/workflow/library.ts'
import { toN8n } from '@core/workflow/n8nCompat.ts'
import { getNodeImplementation } from '@core/workflow/registry.ts'
import type { WorkflowDefinition, WorkflowItem, WorkflowServices } from '@core/workflow/types.ts'
import { useIsDemo } from '@/features/shared/hooks.ts'
import { formatRelative } from '@/core/format.ts'
import { Stagger } from '@/skiper/components/Stagger.tsx'

interface StoredRecord {
  collection: string
  item: Record<string, unknown>
}

const RUN_LABEL: Record<string, string> = {
  succeeded: 'Succeeded',
  partial: 'Finished with a failure it was told to continue past',
  failed: 'Failed',
}

const NODE_TONE: Record<string, string> = {
  succeeded: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-rose-700 dark:text-rose-300',
  skipped: 'text-amber-700 dark:text-amber-300',
  disabled: 'text-muted',
}

function NodeGraph({ definition }: { definition: WorkflowDefinition }): ReactNode {
  // Layers by dependency depth: left to right is the order of operations.
  const layers = useMemo(() => {
    const depth = new Map<string, number>()
    const parents = new Map<string, string[]>()
    for (const node of definition.nodes) parents.set(node.name, [])
    for (const [from, outputs] of Object.entries(definition.connections)) {
      for (const port of outputs.main ?? []) {
        for (const connection of port ?? []) parents.get(connection.node)?.push(from)
      }
    }
    const visit = (name: string, seen: Set<string>): number => {
      if (depth.has(name)) return depth.get(name) ?? 0
      if (seen.has(name)) return 0
      seen.add(name)
      const own = (parents.get(name) ?? []).map((parent) => visit(parent, seen) + 1)
      const value = own.length > 0 ? Math.max(...own) : 0
      depth.set(name, value)
      return value
    }
    for (const node of definition.nodes) visit(node.name, new Set())
    const byDepth = new Map<number, string[]>()
    for (const node of definition.nodes) {
      const value = depth.get(node.name) ?? 0
      byDepth.set(value, [...(byDepth.get(value) ?? []), node.name])
    }
    return [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([, names]) => names)
  }, [definition])

  return (
    <ol className="gm-workflow-graph flex flex-wrap items-stretch gap-2 text-xs" aria-label={`Steps in ${definition.name}`}>
      {layers.map((names, index) => (
        <li key={index} className="flex items-center gap-2">
          <ul className="flex flex-col gap-1">
            {names.map((name) => {
              const node = definition.nodes.find((candidate) => candidate.name === name)
              const implemented = node ? getNodeImplementation(node.type) !== undefined : false
              return (
                <li key={name} className="gm-chip" title={node?.type}>
                  <span aria-hidden="true" className="gm-workflow-graph-dot" /> {name}
                  {implemented ? null : <span className="text-muted"> (not implemented)</span>}
                </li>
              )
            })}
          </ul>
          {index < layers.length - 1 ? (
            <span aria-hidden="true" className="text-muted">
              →
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function ItemPreview({ items }: { items: WorkflowItem[] }): ReactNode {
  if (items.length === 0) return <p className="text-xs text-muted">No items.</p>
  return (
    <ul className="gm-workflow-items space-y-1 text-xs">
      {items.map((item, index) => (
        <li key={index}>
          <code className="break-words">{JSON.stringify(item.json).slice(0, 400)}</code>
        </li>
      ))}
    </ul>
  )
}

function RunLog({ run }: { run: RunResult }): ReactNode {
  return (
    <div className="mt-4 space-y-3" data-testid="workflow-run">
      <p className="text-sm">
        <strong>{RUN_LABEL[run.status] ?? run.status}</strong> — {run.nodes.length} node(s), {run.durationMs}ms,{' '}
        reading <code>{run.environment.dataSource}</code>
        {run.environment.network ? ' with a network available' : ' with no network'}
        {run.environment.dryRun ? ', in a dry run' : ''}.
      </p>

      {run.caveats.length > 0 ? (
        <Callout kind="warning" title="What this run could not do">
          <List items={run.caveats} />
        </Callout>
      ) : null}

      <Stagger as="ol" className="space-y-2">
        {run.nodes.map((node, index) => (
          <li key={`${node.nodeId}-${index}`} className="gm-panel p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium">
                {index + 1}. {node.nodeName}{' '}
                <span className={`text-xs ${NODE_TONE[node.status] ?? 'text-muted'}`}>{node.status}</span>
              </span>
              <span className="text-xs text-muted">
                {node.inputCount} in / {node.outputCount} out · {node.attempts} attempt(s) · {node.durationMs}ms
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              <code>{node.type}</code>
              {node.skipReason ? ` — skipped: ${node.skipReason}` : ''}
              {node.error ? ` — ${node.error}` : ''}
            </p>
            {node.sample.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted">Sample output (first {node.sample.length})</summary>
                <div className="mt-1">
                  <ItemPreview items={node.sample} />
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </Stagger>

      {run.planErrors.length > 0 ? (
        <Callout kind="warning" title="References this run could not resolve">
          <List items={run.planErrors.map((problem) => `${problem.node} → ${problem.parameter}: ${problem.reference} (${problem.reason})`)} />
        </Callout>
      ) : null}
    </div>
  )
}

function WorkflowCard({
  definition,
  onRun,
  running,
  run,
  onReset,
  notes,
}: {
  definition: WorkflowDefinition
  onRun: (dryRun: boolean) => void
  running: boolean
  run: RunResult | null
  onReset: () => void
  notes: StoredRecord[]
}): ReactNode {
  const [showLimits, setShowLimits] = useState(false)
  const schedule = definition.trigger.kind === 'schedule' && definition.trigger.cron ? describeCron(definition.trigger.cron) : null

  const download = (): void => {
    const document = toN8n(definition)
    const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = window.document.createElement('a')
    link.href = url
    link.download = `${definition.id.replace(/^workflow:/, '')}.n8n.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card as="section" className="gm-workflow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="gm-card-title text-base font-semibold">{definition.name}</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">{definition.description}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip>{definition.nodes.length} steps</Chip>
            <Chip>{definition.trigger.kind === 'schedule' ? 'Scheduled' : 'Run by hand'}</Chip>
            <Chip>v{definition.version}</Chip>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={download} aria-label={`Download ${definition.name} as an n8n document`}>
            <Download aria-hidden="true" className="h-4 w-4" /> n8n
          </Button>
          <Button variant="ghost" onClick={() => onRun(true)} disabled={running}>
            Dry run
          </Button>
          <Button onClick={() => onRun(false)} disabled={running}>
            <Play aria-hidden="true" className="h-4 w-4" /> {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>

      {schedule ? <p className="mt-2 text-xs text-muted">On a schedule: {schedule}. Nothing runs it automatically in this deployment; the expression drives the CLI and CI.</p> : null}

      <div className="mt-4">
        <NodeGraph definition={definition} />
      </div>

      <button
        type="button"
        className="mt-3 inline-flex items-center gap-1 text-xs text-muted underline"
        aria-expanded={showLimits}
        onClick={() => setShowLimits((value) => !value)}
      >
        <ChevronDown aria-hidden="true" className="h-3 w-3" /> What this workflow cannot do
      </button>
      {showLimits ? (
        <div className="mt-2">
          <List items={definition.limitations} />
        </div>
      ) : null}

      {run ? (
        <>
          {notes.length > 0 ? (
            <p className="mt-3 text-xs text-muted">
              It wrote {notes.length} record(s) to {[...new Set(notes.map((note) => note.collection))].join(', ')}, kept in this tab only.
            </p>
          ) : null}
          <RunLog run={run} />
          <Button variant="ghost" className="mt-3" onClick={onReset}>
            <RotateCcw aria-hidden="true" className="h-4 w-4" /> Clear this run
          </Button>
        </>
      ) : null}
    </Card>
  )
}

export function WorkflowsPage(): ReactNode {
  const demo = useIsDemo()
  const [runs, setRuns] = useState<Record<string, RunResult | null>>({})
  const [running, setRunning] = useState<string | null>(null)
  const [records, setRecords] = useState<StoredRecord[]>([])
  const [error, setError] = useState<string | null>(null)

  const run = async (definition: WorkflowDefinition, dryRun: boolean): Promise<void> => {
    setRunning(definition.id)
    setError(null)
    const stored: StoredRecord[] = []
    try {
      /*
       * One services object per run, holding this run's records. Nothing is
       * written anywhere else: a workflow in this deployment has no server to
       * write to, and the page says so rather than implying a background job.
       */
      const services: WorkflowServices = createClientWorkflowServices(api(), {
        record: async ({ collection, item }) => {
          stored.push({ collection, item })
        },
        unavailableNote: 'Configure a backend to run this against live data.',
      })
      const result = await runWorkflow(definition, services, { dryRun })
      setRecords((previous) => [...previous, ...stored])
      setRuns((previous) => ({ ...previous, [definition.id]: result }))
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workflows"
        description="Automation you can read. Each workflow is a small graph of steps — read the curriculum, list resources, check them, write a digest — with every run logged node by node, including the parts that were skipped and why."
      />

      <Callout kind={demo ? 'info' : 'success'} title={demo ? 'Running against the bundled curriculum in this tab' : 'Running against the live knowledge graph'}>
        <p className="text-sm">
          {demo
            ? 'A run reads the same bundled dataset the rest of the app uses in sample mode. It cannot reach the network unless a workflow declares an allowed host, and host checks are enforced in the engine, not in this page.'
            : 'A run reads the live graph through the same client the rest of the app uses.'}{' '}
          The node types are implemented in <code>core/workflow/registry.ts</code>, the runner is <code>core/workflow/engine.ts</code>, and the same code runs in tests and from the CLI
          (<code>npm run workflow -- --id …</code>).
        </p>
      </Callout>

      {error ? <Callout kind="warning" title="That run could not start">{error}</Callout> : null}

      {records.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm text-muted">Records written this session ({records.length})</summary>
          <div className="mt-2">
            <ItemPreview items={records.map((record) => ({ json: record.item }))} />
          </div>
        </details>
      ) : null}

      {WORKFLOW_LIBRARY.map((definition) => (
        <WorkflowCard
          key={definition.id}
          definition={definition}
          running={running === definition.id}
          run={runs[definition.id] ?? null}
          notes={records.filter((record) => record.item.workflowId === definition.id)}
          onRun={(dryRun) => void run(definition, dryRun)}
          onReset={() => setRuns((previous) => ({ ...previous, [definition.id]: null }))}
        />
      ))}

      <Card className="gm-workflow-card">
        <SectionTitle hint="The same engine, from a terminal">Running a workflow outside the browser</SectionTitle>
        <pre className="gm-code mt-2 overflow-x-auto text-xs">
          <code>{`# list the library
npm run workflow -- --list

# run one against the bundled sample dataset
npm run workflow -- --id workflow:weekly-plan-digest

# export the n8n documents for review
npm run workflow -- --export-n8n tmp/n8n`}</code>
        </pre>
        <p className="mt-2 text-xs text-muted">
          Last run summary: {Object.values(runs).filter(Boolean).length} workflow(s) run in this tab since the page loaded
          {records.length > 0 ? `, ${records.length} record(s) held in memory` : ''}
          {Object.values(runs)[0] ? `, most recent finished ${formatRelative(Object.values(runs)[0]!.finishedAt)}` : ''}.
        </p>
      </Card>
    </div>
  )
}
