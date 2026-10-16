/**
 * Exporting a workflow into n8n's format.
 *
 * Why this file exists at all: the value of adopting n8n's *shape* is that the
 * files can be read with tools other people already have. Somebody who wants to
 * argue about whether the freshness sweep retries properly can open the export in
 * an n8n canvas, see the same graph, the same connections, the same retry settings
 * and the same notes, and disagree with it there.
 *
 * What the export is **not**: a runtime bridge. n8n cannot execute a
 * `gm.graph.frontier` node, because that node is this product's engine, and the
 * nodes that do exist in both ecosystems do not have the same parameters. So the
 * export is honest about the difference instead of pretending:
 *
 *   * triggers are mapped to their n8n equivalents, because those really are the
 *     same idea and n8n will place them on the canvas correctly;
 *   * every other node keeps its `gm.*` type, so n8n shows it as an unknown node
 *     in the right place with its parameters intact rather than silently
 *     substituting something that would behave differently;
 *   * a `meta.gmExport` block records what the importer must not assume.
 *
 * The alternative — translating each `gm.*` node into a `n8n-nodes-base.code`
 * node containing JavaScript — was rejected: it would put unread, ungenerated,
 * untested code into a file that looks authoritative, which is a worse outcome
 * than an honest placeholder.
 */
import type { WorkflowDefinition, WorkflowNode } from './types.ts'

/** The node types that mean the same thing in both ecosystems. */
const TRIGGER_EQUIVALENTS: Partial<Record<WorkflowNode['type'], string>> = {
  'gm.trigger.manual': 'n8n-nodes-base.manualTrigger',
  'gm.trigger.schedule': 'n8n-nodes-base.scheduleTrigger',
}

/** n8n's own workflow document, in the subset this project uses. */
export interface N8nWorkflow {
  name: string
  nodes: Array<{
    id: string
    name: string
    type: string
    typeVersion: number
    position: [number, number]
    parameters: Record<string, unknown>
    notes?: string
    notesInFlow?: boolean
    disabled?: boolean
    retryOnFail?: boolean
    maxTries?: number
    waitBetweenTries?: number
    onError?: 'stopWorkflow' | 'continueRegularOutput'
  }>
  connections: WorkflowDefinition['connections']
  settings: { executionOrder: 'v1'; saveManualExecutions: boolean; timezone: string; callerPolicy: 'workflowsFromSameOwner' }
  meta: {
    gmExport: {
      workflowId: string
      version: number
      exportedFrom: string
      /** Statements the importer must not assume away. */
      importNotes: string[]
      limitations: string[]
      allowedHosts: string[]
    }
  }
  nodes_meta?: Record<string, string>
}

/**
 * Converts a definition.
 *
 * Note what is preserved and what is translated: names, ids, positions, notes,
 * retry settings and every parameter map cross over unchanged, so the export is
 * a faithful description of the graph. Only the two trigger types are renamed,
 * because only those two mean the same thing on both sides.
 */
export function toN8n(definition: WorkflowDefinition, options: { timezone?: string } = {}): N8nWorkflow {
  const unknownNodes = definition.nodes.filter((node) => !TRIGGER_EQUIVALENTS[node.type]).map((node) => node.name)

  return {
    name: definition.name,
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: TRIGGER_EQUIVALENTS[node.type] ?? node.type,
      typeVersion: node.typeVersion,
      position: node.position,
      parameters: node.parameters,
      ...(node.notes ? { notes: node.notes, notesInFlow: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.retryOnFail ? { retryOnFail: true } : {}),
      ...(node.maxTries !== undefined ? { maxTries: node.maxTries } : {}),
      ...(node.waitBetweenTries !== undefined ? { waitBetweenTries: node.waitBetweenTries } : {}),
      ...(node.onError ? { onError: node.onError === 'continue' ? 'continueRegularOutput' : 'stopWorkflow' } : {}),
    })),
    connections: definition.connections,
    settings: {
      executionOrder: 'v1',
      saveManualExecutions: true,
      timezone: options.timezone ?? 'UTC',
      callerPolicy: 'workflowsFromSameOwner',
    },
    meta: {
      gmExport: {
        workflowId: definition.id,
        version: definition.version,
        exportedFrom: 'graphmentor-ai core/workflow (n8nCompat.ts)',
        importNotes: [
          'This export is for review, not for execution. The nodes below are this product\'s own engine steps.',
          `${unknownNodes.length} node(s) have no n8n equivalent and will import as unknown nodes: ${unknownNodes.join(', ')}.`,
          'Every node here reads the bundled curriculum or an allow-listed host. There is no code node, no credential and no arbitrary HTTP, so importing this file grants n8n no capability it did not already have.',
          'Parameter names are this project\'s, not n8n\'s. They are preserved verbatim so the graph can be compared step by step.',
        ],
        limitations: [...definition.limitations],
        allowedHosts: definition.settings?.allowedHosts ?? [],
      },
    },
    nodes_meta: Object.fromEntries(definition.nodes.map((node) => [node.name, node.type])),
  }
}

/** Every workflow in a library, as a map of file name to document. */
export function exportLibrary(definitions: readonly WorkflowDefinition[]): Record<string, N8nWorkflow> {
  const files: Record<string, N8nWorkflow> = {}
  for (const definition of definitions) {
    const slug = definition.id.replace(/^workflow:/, '')
    files[`${slug}.n8n.json`] = toN8n(definition)
  }
  return files
}
