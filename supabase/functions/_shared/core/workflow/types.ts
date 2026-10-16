/**
 * Workflow definitions.
 *
 * The shape is deliberately the one n8n uses, because that ecosystem's JSON is
 * the closest thing to a lingua franca for "a graph of automated steps", and
 * because a definition that can be exported into it is a definition somebody
 * else can inspect with a tool they already have. Nodes carry `name`, `type`,
 * `typeVersion` and `position`; edges live in `connections` keyed by node name
 * and grouped by output port (`main`, index 0, 1, …). `toN8n()` in
 * `n8nCompat.ts` renames the node types and nothing else.
 *
 * What this is *not*: a general-purpose automation platform. There is no code
 * node, no arbitrary HTTP, no filesystem access and no credential store. Every
 * node type is implemented in this repository and every one of them takes its
 * data from the knowledge graph or from an allow-listed host. That is a
 * deliberate narrowing: the value of the integration is the *shape* of the
 * automation (a reviewable graph, with retries and an audit log), not the ability
 * to run arbitrary code in a career-guidance app.
 */

/** Every node type the registry implements. Unknown types fail the run, loudly. */
export const WORKFLOW_NODE_TYPES = [
  'gm.trigger.manual',
  'gm.trigger.schedule',
  'gm.graph.frontier',
  'gm.graph.pathway',
  'gm.resources.list',
  'gm.resources.check',
  'gm.mentor.ask',
  'gm.roadmap.plan',
  'gm.publicApi.map',
  'gm.transform.template',
  'gm.transform.filter',
  'gm.transform.merge',
  'gm.io.record',
  'gm.io.digest',
] as const

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number]

export function isWorkflowNodeType(value: string): value is WorkflowNodeType {
  return (WORKFLOW_NODE_TYPES as readonly string[]).includes(value)
}

/** Matches n8n's `INodeExecutionData`: each item is a JSON payload with optional binary. */
export interface WorkflowItem {
  json: Record<string, unknown>
}

export interface WorkflowNode {
  /** Stable within the workflow. Used in the audit log. */
  id: string
  /** n8n's connection key. Unique within the workflow, and the thing `connections` refers to. */
  name: string
  type: WorkflowNodeType
  /** Kept for n8n compatibility and for the canvas the UI draws. */
  typeVersion: number
  position: [number, number]
  parameters: Record<string, unknown>
  /** Disabled nodes are skipped and reported as skipped, never silently dropped. */
  disabled?: boolean
  retryOnFail?: boolean
  maxTries?: number
  /** Milliseconds between retries. */
  waitBetweenTries?: number
  /** `stop` (default) fails the run; `continue` records the error and passes input through. */
  onError?: 'stop' | 'continue'
  notes?: string
  /** Parameter names whose values must never be written to a log or a digest. */
  redact?: string[]
}

/** `connections[fromName].main[outputIndex]` is the list of targets of that port. */
export interface WorkflowConnection {
  node: string
  type: 'main'
  index: number
}

export type WorkflowConnections = Record<string, { main: Array<Array<WorkflowConnection>> }>

export interface WorkflowTrigger {
  kind: 'manual' | 'schedule' | 'webhook'
  /** Standard five-field cron, for `schedule`. Parsed by `parseCron` in cron.ts. */
  cron?: string
  /** Human description shown in the UI, because a cron string is not a sentence. */
  description: string
}

export interface WorkflowDefinition {
  id: string
  name: string
  version: number
  /** What it does, in one sentence, in the UI. */
  description: string
  /**
   * What it deliberately does not do. Rendered beside the workflow, for the same
   * reason every other surface in this app carries its limits.
   */
  limitations: string[]
  trigger: WorkflowTrigger
  nodes: WorkflowNode[]
  connections: WorkflowConnections
  settings?: {
    /**
     * Hosts this workflow may call, if it has an HTTP-capable node. Empty means
     * no network at all. A host must match exactly or be a subdomain of an entry.
     */
    allowedHosts?: string[]
    /** Hard ceilings. Exceeding one fails the run rather than truncating it. */
    limits?: { maxNodes?: number; maxItemsPerNode?: number; maxRunMs?: number }
  }
}

/** One node's outcome, as it goes into the run log. */
export interface WorkflowNodeLog {
  nodeId: string
  nodeName: string
  type: WorkflowNodeType
  status: 'succeeded' | 'failed' | 'skipped' | 'disabled'
  startedAt: string
  durationMs: number
  /** Items in, items out. The shapes are visible; the payloads are in `sample`. */
  inputCount: number
  outputCount: number
  attempts: number
  /** Redacted, truncated sample of the output, for the UI's run view. */
  sample: WorkflowItem[]
  error?: string
  /** Why it was skipped, when it was — "no network in this environment", etc. */
  skipReason?: string
}

export interface WorkflowRun {
  runId: string
  workflowId: string
  workflowName: string
  workflowVersion: number
  status: 'succeeded' | 'failed' | 'partial'
  startedAt: string
  finishedAt: string
  durationMs: number
  /** The environment the run saw, recorded so a result can never be misread. */
  environment: { dataSource: 'bundled-sample' | 'neo4j' | 'unavailable'; network: boolean; dryRun: boolean }
  nodes: WorkflowNodeLog[]
  output: WorkflowItem[]
  caveats: string[]
}

/**
 * The services a run may use.
 *
 * Passed in rather than imported, so the same engine runs in three places without
 * a build-time branch: over the bundled dataset in the browser, over Neo4j in an
 * edge function, and over fixtures in a test. The engine never reaches for a
 * global, which is also what makes a run reproducible.
 */
export interface WorkflowServices {
  now: () => number
  /**
   * Optional delay between retries. Injected for the same reason the clock is:
   * a test must not sleep for real, and a browser tab should not either — the
   * page passes a timer, a test passes `() => Promise.resolve()`.
   */
  sleep?: (ms: number) => Promise<void>
  /** Which data source this run is actually reading. Recorded in the run log. */
  dataSource: 'bundled-sample' | 'neo4j' | 'unavailable'
  /** True when this environment can make outbound requests. */
  network: boolean
  /** Frontier analysis for a career and a profile. */
  frontier: (input: { careerId: string; ratings: Array<{ skillId: string; state: string }>; weeklyHours: number }) => Promise<{
    remainingCount: number
    summaryLine: string
    frontier: Array<{ skillId: string; name: string; unlocks: number }>
    criticalChain: Array<{ skillId: string; name: string }>
    gates: Array<{ skillId: string; name: string; unlocks: number }>
    gatesUnlock: number
    hours: { low: number; high: number }
  }>
  /** Resources that teach a set of skills, with their verification state. */
  resources: (input: { skillIds: string[]; limit?: number }) => Promise<
    Array<{ id: string; name: string; url: string; accessModel: string; verified: string | null }>
  >
  /** A grounded mentor answer, with the facts it used. */
  mentor: (input: { question: string; careerId?: string }) => Promise<{ answer: string; citations: string[] }>
  /** Public APIs mapped to a skill, from the imported directory. */
  publicApis: (input: { skillIds: string[]; limit?: number }) => Promise<Array<{ name: string; url: string; category: string }>>
  /** An HTTP HEAD/GET probe, only ever called with a host the workflow allows. */
  fetch: (input: { url: string; method: 'HEAD' | 'GET'; timeoutMs: number }) => Promise<{ ok: boolean; status: number; ms: number }>
  /** Writes a record somewhere durable. In the browser this is local storage. */
  record: (input: { collection: string; item: Record<string, unknown> }) => Promise<void>
}
