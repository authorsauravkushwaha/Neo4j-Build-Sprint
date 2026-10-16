/**
 * The workflow engine.
 *
 * Small on purpose. It walks the graph in dependency order, hands each node its
 * input items, and records what happened. Four properties are non-negotiable, and
 * each one exists because of a specific way automation goes wrong:
 *
 *   1. **Every node that ran is in the log.** Including the ones that were
 *      skipped, and *why*. A run whose summary only mentions successes is a run
 *      nobody can audit.
 *   2. **Failures are bounded, not fatal, unless they say otherwise.** A node may
 *      declare `onError: 'continue'` (fetch a resource, note that it failed, keep
 *      going) or `retryOnFail` with a try count. Anything else stops the run and
 *      reports the node that stopped it.
 *   3. **The environment is recorded in the result.** Sample data, a live graph
 *      and a dry run produce different-looking output, and the run log says which
 *      one produced this one. This is the same rule the rest of the app follows:
 *      never let sample output be mistaken for live output.
 *   4. **There is no arbitrary code.** Node behaviour comes from a registry keyed
 *      by type, parameters are data, and the only evaluation is the reference
 *      grammar in `expressions.ts`.
 *
 * Time is injected (`services.now`) and nothing here reads a clock, a network or
 * a global directly, so the same engine runs in the browser, in an edge function
 * and in a test — and a test run is reproducible.
 */
import {
  type WorkflowDefinition,
  type WorkflowItem,
  type WorkflowNode,
  type WorkflowNodeLog,
  type WorkflowRun,
  type WorkflowServices,
} from './types.ts'
import { evaluate, hasExpression, stringifyValue, validateExpressions } from './expressions.ts'
import { getNodeImplementation, isBatchNode, type NodeContext, type NodeResult, type NodeSkip } from './registry.ts'

/** Ceilings applied when a workflow does not set its own. */
export const DEFAULT_LIMITS = { maxNodes: 60, maxItemsPerNode: 500, maxRunMs: 120_000 } as const

export interface RunOptions {
  /** Record the plan without performing side effects (no network, no writes). */
  dryRun?: boolean
  /** Cap on items passed between nodes. Falls back to the workflow's or the default. */
  maxItemsPerNode?: number
}

export interface RunResult extends WorkflowRun {
  /** Problems found while *loading* the workflow, before anything ran. */
  planErrors: Array<{ node: string; parameter: string; reference: string; reason: string }>
}

class RunAborted extends Error {
  constructor(
    readonly nodeName: string,
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'RunAborted'
  }
}

const isSkip = (result: NodeResult | NodeSkip): result is NodeSkip => 'skipped' in result && result.skipped === true

/** Load-time checks: node names unique, connections point at real nodes, expressions parse. */
export function inspectWorkflow(definition: WorkflowDefinition): {
  errors: string[]
  planErrors: Array<{ node: string; parameter: string; reference: string; reason: string }>
} {
  const errors: string[] = []
  const names = new Set<string>()
  for (const node of definition.nodes) {
    if (names.has(node.name)) errors.push(`Two nodes are both called "${node.name}"; connections address nodes by name.`)
    names.add(node.name)
  }
  for (const [from, outputs] of Object.entries(definition.connections)) {
    if (!names.has(from)) errors.push(`Connections start from "${from}", which is not a node in this workflow.`)
    for (const port of outputs.main ?? []) {
      for (const connection of port ?? []) {
        if (!names.has(connection.node)) errors.push(`"${from}" connects to "${connection.node}", which is not a node in this workflow.`)
      }
    }
  }
  for (const node of definition.nodes) {
    if (!getNodeImplementation(node.type)) errors.push(`Node "${node.name}" has unknown type ${node.type}.`)
  }
  const limits = definition.settings?.limits
  const maxNodes = limits?.maxNodes ?? DEFAULT_LIMITS.maxNodes
  if (definition.nodes.length > maxNodes) errors.push(`This workflow has ${definition.nodes.length} nodes; the ceiling is ${maxNodes}.`)
  const planErrors = definition.nodes.flatMap((node) => validateExpressions(node.name, node.parameters))
  return { errors, planErrors }
}

/** Order in which nodes run: a stable topological sort of the connections. */
export function executionOrder(definition: WorkflowDefinition): WorkflowNode[] {
  const byName = new Map(definition.nodes.map((node) => [node.name, node]))
  const incoming = new Map<string, string[]>()
  for (const node of definition.nodes) incoming.set(node.name, [])
  for (const [from, outputs] of Object.entries(definition.connections)) {
    for (const port of outputs.main ?? []) {
      for (const connection of port ?? []) {
        if (!byName.has(connection.node) || !byName.has(from)) continue
        incoming.get(connection.node)?.push(from)
      }
    }
  }

  const ordered: WorkflowNode[] = []
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (name: string): void => {
    if (done.has(name) || visiting.has(name)) return
    visiting.add(name)
    // Sorted parents, so the order does not depend on object key order.
    for (const parent of [...(incoming.get(name) ?? [])].sort()) visit(parent)
    visiting.delete(name)
    done.add(name)
    const node = byName.get(name)
    if (node) ordered.push(node)
  }
  // Triggers are the roots; everything else is reached from them, and any node
  // with no incoming connections is also treated as a root rather than dropped.
  const roots = definition.nodes.filter((node) => node.type.startsWith('gm.trigger.')).map((node) => node.name)
  const starts = roots.length > 0 ? roots : definition.nodes.map((node) => node.name)
  for (const name of starts) visit(name)
  for (const node of definition.nodes) visit(node.name)
  return ordered
}

/** Inputs for a node: the concatenation of every upstream node's output. */
function collectInput(name: string, definition: WorkflowDefinition, outputs: Map<string, WorkflowItem[]>): WorkflowItem[] {
  const items: WorkflowItem[] = []
  for (const [from, ports] of Object.entries(definition.connections)) {
    if (!outputs.has(from)) continue
    for (const port of ports.main ?? []) {
      for (const connection of port ?? []) {
        if (connection.node !== name) continue
        items.push(...(outputs.get(from) ?? []))
      }
    }
  }
  return items
}

/**
 * Truncates items for the log, so a run record stays a record and not a dump.
 *
 * The sample keeps the item shape (`{ json: … }`) rather than flattening it,
 * because the log is read next to the node that produced it and the shape is part
 * of what a reader is checking.
 */
function logSample(items: WorkflowItem[], redact: string[]): WorkflowItem[] {
  return items.slice(0, 3).map((item) => {
    const json: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(item.json)) {
      if (redact.includes(key)) {
        json[key] = '[redacted]'
        continue
      }
      const text = stringifyValue(value)
      json[key] = text.length > 300 ? `${text.slice(0, 300)}…` : value
    }
    return { json }
  })
}

/**
 * Runs a workflow.
 *
 * Never throws for a node-level problem: a failed run comes back as a `WorkflowRun`
 * with `status: 'failed'` and the reason attached, because a caller that has to
 * catch an exception to find out what a workflow did will eventually forget to.
 * It throws only for a malformed definition, which is a programming error.
 */
export async function runWorkflow(
  definition: WorkflowDefinition,
  services: WorkflowServices,
  options: RunOptions = {},
): Promise<RunResult> {
  const { dryRun = false } = options
  const { errors, planErrors } = inspectWorkflow(definition)
  if (errors.length > 0) {
    throw new Error(`This workflow cannot run: ${errors.join(' ')}`)
  }

  const limits = {
    maxNodes: definition.settings?.limits?.maxNodes ?? DEFAULT_LIMITS.maxNodes,
    maxItemsPerNode: options.maxItemsPerNode ?? definition.settings?.limits?.maxItemsPerNode ?? DEFAULT_LIMITS.maxItemsPerNode,
    maxRunMs: definition.settings?.limits?.maxRunMs ?? DEFAULT_LIMITS.maxRunMs,
  }

  const startedAt = services.now()
  const order = executionOrder(definition).slice(0, limits.maxNodes)
  const outputs = new Map<string, WorkflowItem[]>()
  const logs: WorkflowNodeLog[] = []
  const caveats: string[] = []
  let status: WorkflowRun['status'] = 'succeeded'
  let aborted: RunAborted | null = null

  for (const node of order) {
    if (aborted) break
    const nodeStart = services.now()

    const log = (partial: Omit<WorkflowNodeLog, 'nodeId' | 'nodeName' | 'type' | 'startedAt' | 'durationMs'>): void => {
      logs.push({
        nodeId: node.id,
        nodeName: node.name,
        type: node.type,
        startedAt: new Date(nodeStart).toISOString(),
        durationMs: services.now() - nodeStart,
        ...partial,
      })
    }

    if (node.disabled) {
      outputs.set(node.name, collectInput(node.name, definition, outputs))
      log({ status: 'disabled', inputCount: 0, outputCount: 0, attempts: 0, sample: [], skipReason: 'disabled in the definition' })
      continue
    }

    const input = collectInput(node.name, definition, outputs)
    const truncated = input.length > limits.maxItemsPerNode
    if (truncated) caveats.push(`Node "${node.name}" received ${input.length} items; only the first ${limits.maxItemsPerNode} were processed.`)
    const workingInput = truncated ? input.slice(0, limits.maxItemsPerNode) : input

    /*
     * Per-item invocation by default, once for the whole batch when the node says
     * so (see `isBatchNode`). A digest invoked per item would emit one digest per
     * resource, which looks like a rich result and is a duplicated one.
     */
    const scopes: WorkflowItem[] =
      isBatchNode(node.type) || workingInput.length === 0 ? [{ json: workingInput[0]?.json ?? {} }] : workingInput
    const attempts = node.retryOnFail ? Math.max(1, Math.min(node.maxTries ?? 2, 5)) : 1
    const accumulated: WorkflowItem[] = []
    let lastError: string | undefined
    let skip: NodeSkip | null = null
    let usedAttempts = 0

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      usedAttempts = attempt
      accumulated.length = 0
      lastError = undefined
      skip = null
      try {
        for (const [index, scopeItem] of scopes.entries()) {
          const parameters = evaluateParameters(node, {
            json: scopeItem.json,
            nodes: Object.fromEntries([...outputs.entries()].map(([name, items]) => [name, items[0]?.json ?? {}])),
            now: services.now(),
            workflowId: definition.id,
            count: workingInput.length || index + 1,
          })
          const context: NodeContext = {
            node,
            parameters,
            item: scopeItem,
            input: workingInput,
            services,
            dryRun,
            allowedHosts: definition.settings?.allowedHosts ?? [],
            workflowId: definition.id,
          }
          const result = await getNodeImplementation(node.type)!(context)
          if (isSkip(result)) {
            skip = result
            break
          }
          accumulated.push(...result.items)
        }
        if (!skip) break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (attempt < attempts && (node.waitBetweenTries ?? 0) > 0) {
          // The delay is a service, not a `setTimeout` in here: a test must not
          // sleep, and a browser tab should not either.
          await services.sleep?.(node.waitBetweenTries ?? 0)
        }
      }
    }

    if (skip) {
      outputs.set(node.name, workingInput)
      log({ status: 'skipped', inputCount: workingInput.length, outputCount: workingInput.length, attempts: usedAttempts, sample: logSample(workingInput, node.redact ?? []), skipReason: skip.reason })
      continue
    }

    if (lastError !== undefined) {
      if (node.onError === 'continue') {
        outputs.set(node.name, workingInput)
        log({ status: 'failed', inputCount: workingInput.length, outputCount: workingInput.length, attempts: usedAttempts, sample: logSample(workingInput, node.redact ?? []), error: lastError })
        caveats.push(`Node "${node.name}" failed and was configured to continue: ${lastError}`)
        status = 'partial'
        continue
      }
      log({ status: 'failed', inputCount: workingInput.length, outputCount: 0, attempts: usedAttempts, sample: [], error: lastError })
      aborted = new RunAborted(node.name, lastError)
      break
    }

    if (accumulated.length > limits.maxItemsPerNode) {
      caveats.push(`Node "${node.name}" produced ${accumulated.length} items; only the first ${limits.maxItemsPerNode} were passed on.`)
    }
    const capped = accumulated.slice(0, limits.maxItemsPerNode)
    outputs.set(node.name, capped)
    log({
      status: 'succeeded',
      inputCount: workingInput.length,
      outputCount: capped.length,
      attempts: usedAttempts,
      sample: logSample(capped, node.redact ?? []),
    })

    if (services.now() - startedAt > limits.maxRunMs) {
      aborted = new RunAborted(node.name, `The run exceeded its ${limits.maxRunMs}ms budget.`)
      break
    }
  }

  const finishedAt = services.now()
  if (aborted) status = 'failed'

  // The workflow's own output is the last node that produced items, with the
  // trigger nodes' empty outputs excluded.
  const terminal = order[order.length - 1]
  const output = terminal ? (outputs.get(terminal.name) ?? []) : []

  if (dryRun) caveats.push('Dry run: no network requests and no records were written.')
  // Only say it when it applies: a caveat on a workflow that never leaves the
  // machine is noise, and noise in a caveat list is how people learn to skip it.
  const needsNetwork = order.some((node) => node.type === 'gm.resources.check')
  if (!services.network && needsNetwork) {
    caveats.push('No network in this environment: the nodes that need one were skipped, by name, in the log.')
  }

  return {
    runId: `run:${definition.id}:${startedAt}`,
    workflowId: definition.id,
    workflowName: definition.name,
    workflowVersion: definition.version,
    status,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    environment: { dataSource: services.dataSource, network: services.network, dryRun },
    nodes: logs,
    output,
    caveats: [
      ...definition.limitations,
      ...caveats,
      ...(aborted ? [`Stopped at "${aborted.nodeName}": ${aborted.detail}`] : []),
    ],
    planErrors,
  }
}

/** Evaluates every parameter, collecting unresolved references into a warning. */
function evaluateParameters(node: WorkflowNode, scope: Parameters<typeof evaluate>[1]): Record<string, unknown> {
  const parameters: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.parameters)) {
    const result = evaluate(value, scope)
    if (result.unresolved.length > 0 && hasExpression(value)) {
      // Reported rather than thrown: label templates are allowed to be partial.
      parameters[`${key}__unresolved`] = result.unresolved
    }
    parameters[key] = result.value
  }
  return parameters
}
