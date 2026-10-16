/**
 * The node registry: the only place a workflow node does anything.
 *
 * Every node type is implemented here, in about a screen of code each, and all
 * of them share three rules:
 *
 *   * **They take data from a service, never from the world.** No `fetch`, no
 *     `Date.now()`, no `localStorage` — the `WorkflowServices` object is the only
 *     way out, so the same node runs in the browser, in an edge function and in a
 *     test with the same result.
 *   * **They may refuse cleanly.** A node that needs a network, a database or a
 *     live mentor returns `{ skipped: true, reason }` instead of failing. The run
 *     log then says "skipped: no network in this environment" rather than
 *     reporting a green run that quietly did nothing.
 *   * **They validate their own parameters.** A missing `careerId` is a bad
 *     workflow, and the error message names the node and the parameter.
 */
import type { WorkflowItem, WorkflowNode, WorkflowServices } from './types.ts'
import { stringifyValue } from './expressions.ts'

export interface NodeContext {
  node: WorkflowNode
  /** Parameters, after expression evaluation. */
  parameters: Record<string, unknown>
  /** The item this invocation is processing. */
  item: WorkflowItem
  /** Everything the node received, for nodes that work on the whole batch. */
  input: WorkflowItem[]
  services: WorkflowServices
  dryRun: boolean
  /** Hosts this workflow declared. Empty means "no outbound requests". */
  allowedHosts: string[]
  workflowId: string
}

export interface NodeSuccess {
  items: WorkflowItem[]
}
export interface NodeSkip {
  skipped: true
  reason: string
}
export type NodeResult = NodeSuccess | NodeSkip

export const skipped = (reason: string): NodeSkip => ({ skipped: true, reason })
export const items = (...payloads: Array<Record<string, unknown>>): NodeSuccess => ({ items: payloads.map((json) => ({ json })) })

/* ------------------------------------------------------------------ helpers */

function requireString(context: NodeContext, key: string): string {
  const value = context.parameters[key]
  const text = stringifyValue(value)
  if (text === '') {
    throw new Error(`Node "${context.node.name}" needs a "${key}" parameter and none was given.`)
  }
  return text
}

function optionalNumber(context: NodeContext, key: string, fallback: number): number {
  const value = context.parameters[key]
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Node "${context.node.name}": "${key}" must be a non-negative number.`)
  }
  return number
}

function optionalStringList(context: NodeContext, key: string): string[] {
  const value = context.parameters[key]
  if (Array.isArray(value)) return value.map((entry) => stringifyValue(entry)).filter((entry) => entry !== '')
  const single = stringifyValue(value)
  return single === '' ? [] : single.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/** Ratings passed through a workflow parameter, in the shape the engine wants. */
function ratings(context: NodeContext): Array<{ skillId: string; state: string }> {
  const value = context.parameters.ratings
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (entry === null || typeof entry !== 'object') return null
      const record = entry as Record<string, unknown>
      const skillId = stringifyValue(record.skillId)
      const state = stringifyValue(record.state)
      return skillId === '' || state === '' ? null : { skillId, state }
    })
    .filter((entry): entry is { skillId: string; state: string } => entry !== null)
}

/**
 * A URL is only fetched when its host is on the workflow's own list.
 *
 * `https:` only, no credentials in the URL, and the host comparison is exact or a
 * subdomain — `evil.com` never matches `example.com`, and `example.com.evil.com`
 * does not match `example.com` either, which is the test that catches a naive
 * `endsWith` implementation.
 */
export function hostAllowed(url: string, allowedHosts: readonly string[]): { allowed: boolean; host: string; reason?: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, host: '', reason: 'not a URL' }
  }
  if (parsed.protocol !== 'https:') return { allowed: false, host: parsed.hostname, reason: 'only https is fetched' }
  if (parsed.username !== '' || parsed.password !== '') return { allowed: false, host: parsed.hostname, reason: 'credentials in the URL are refused' }
  const host = parsed.hostname.toLowerCase()
  if (parsed.port || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) {
    return { allowed: false, host, reason: 'private hosts, IP literals and non-standard ports are refused' }
  }
  const allowed = allowedHosts.some((entry) => {
    const candidate = entry.toLowerCase().replace(/^\./, '')
    return host === candidate || host.endsWith(`.${candidate}`)
  })
  return allowed ? { allowed: true, host } : { allowed: false, host, reason: `${host} is not in this workflow's allowedHosts` }
}

/* ------------------------------------------------------------------- registry */

/**
 * Which nodes are *batch* nodes.
 *
 * The engine's default is per-item invocation, which is what n8n does and what
 * most transform steps want. But a digest, a merge, a filter and a sweep are
 * about the whole batch: invoking them once per item would produce one digest per
 * input, probe every URL once per URL, and write a record per item per item.
 * That is not a performance bug, it is a wrong-output bug, and it is invisible
 * unless the item count is more than one — so it is declared here, next to the
 * implementations, and asserted in the tests.
 */
const BATCH_NODES = new Set<string>([
  'gm.graph.pathway',
  'gm.transform.merge',
  'gm.transform.filter',
  'gm.io.digest',
  'gm.io.record',
  'gm.resources.check',
])

export function isBatchNode(type: string): boolean {
  return BATCH_NODES.has(type)
}

export type NodeImplementation = (context: NodeContext) => Promise<NodeResult>

const implementations: Record<string, NodeImplementation> = {
  /** The manual trigger passes one empty item downstream, so a run has a start. */
  'gm.trigger.manual': async () => items({ startedBy: 'manual' }),

  /** A schedule trigger carries its own cron expression into the run log. */
  'gm.trigger.schedule': async (context) =>
    items({ startedBy: 'schedule', cron: stringifyValue(context.parameters.cron) }),

  /** The frontier: what is left, what is startable now, which skills gate the rest. */
  'gm.graph.frontier': async (context) => {
    const careerId = requireString(context, 'careerId')
    const report = await context.services.frontier({
      careerId,
      ratings: ratings(context),
      weeklyHours: optionalNumber(context, 'weeklyHours', 8),
    })
    return items({
      careerId,
      remainingCount: report.remainingCount,
      startableCount: report.frontier.length,
      startable: report.frontier.map((skill) => skill.name),
      gates: report.gates.map((gate) => `${gate.name} (unblocks ${gate.unlocks})`),
      gatesUnlock: report.gatesUnlock,
      criticalChain: report.criticalChain.map((step) => step.name),
      criticalChainLength: report.criticalChain.length,
      hoursLow: report.hours.low,
      hoursHigh: report.hours.high,
      summary: report.summaryLine,
    })
  },

  /**
   * The ordered route for one career.
   *
   * The steps arrive in the engine's own order, each naming what it needs first and
   * what it unlocks, so a digest built from this node can say "start with X
   * because it unlocks Y" without the workflow knowing anything about the graph.
   */
  'gm.graph.pathway': async (context) => {
    const careerId = requireString(context, 'careerId')
    const pace = stringifyValue(context.parameters.pace)
    const style = stringifyValue(context.parameters.learningStyle)
    const comfort = stringifyValue(context.parameters.difficultyComfort)
    const route = await context.services.pathway({
      careerId,
      ratings: ratings(context),
      weeklyHours: optionalNumber(context, 'weeklyHours', 8),
      ...(pace === 'relaxed' || pace === 'steady' || pace === 'intensive' ? { pace } : {}),
      ...(style === 'video' || style === 'reading' || style === 'hands-on' || style === 'mixed' ? { learningStyle: style } : {}),
      ...(comfort === 'beginner' || comfort === 'intermediate' || comfort === 'advanced' ? { difficultyComfort: comfort } : {}),
    })
    if (route.steps.length === 0) {
      return skipped('this profile has nothing left to learn for that career')
    }
    return {
      items: route.steps.map((step) => ({
        json: {
          order: step.order,
          skillId: step.skillId,
          name: step.name,
          needs: step.dependsOn,
          unlocks: step.unlocks,
          hoursLow: step.estimatedHours[0],
          hoursHigh: step.estimatedHours[1],
        },
      })),
    }
  },

  /** Resources that teach the skills in the incoming items. */
  'gm.resources.list': async (context) => {
    const skillIds = optionalStringList(context, 'skillIds')
    const fromInput = context.input.flatMap((entry) =>
      Array.isArray(entry.json.skillIds) ? entry.json.skillIds.map((value) => stringifyValue(value)) : [],
    )
    const wanted = [...new Set([...skillIds, ...fromInput])].filter((entry) => entry !== '')
    const list = await context.services.resources({ skillIds: wanted, limit: optionalNumber(context, 'limit', 12) })
    return {
      items: list.map((resource) => ({
        json: {
          resourceId: resource.id,
          title: resource.name,
          url: resource.url,
          access: resource.accessModel,
          lastChecked: resource.verified,
        },
      })),
    }
  },

  /**
   * Probe each resource URL.
   *
   * This is the node that makes the resource library's "last checked" field a
   * measurement instead of a claim. It is also the node most in need of a
   * refusal: without a network it skips, without an allow-list entry it refuses
   * that host and records which one, and in a dry run it does neither.
   */
  'gm.resources.check': async (context) => {
    if (context.dryRun) return skipped('dry run: no requests were made')
    if (!context.services.network) return skipped('no network in this environment')

    const batch = context.input.length > 0 ? context.input : [context.item]
    const timeoutMs = optionalNumber(context, 'timeoutMs', 6000)
    const out: WorkflowItem[] = []
    let refused = 0
    for (const entry of batch) {
      const url = stringifyValue(entry.json.url)
      if (url === '') continue
      const decision = hostAllowed(url, context.allowedHosts)
      if (!decision.allowed) {
        refused += 1
        out.push({ json: { url, status: 'not-probed', reason: decision.reason ?? 'host not allowed' } })
        continue
      }
      try {
        const result = await context.services.fetch({ url, method: 'HEAD', timeoutMs })
        out.push({ json: { url, host: decision.host, status: result.ok ? 'ok' : 'unreachable', code: result.status, ms: result.ms } })
      } catch (error) {
        // A single dead link must not fail the sweep: the point of the sweep is
        // to find dead links.
        out.push({ json: { url, host: decision.host, status: 'error', reason: error instanceof Error ? error.message : String(error) } })
      }
    }
    if (refused > 0) {
      out.push({ json: { note: `${refused} URL(s) were not probed because their host is not allowed by this workflow.` } })
    }
    return { items: out }
  },

  /** A mentor answer, with the facts it used. */
  'gm.mentor.ask': async (context) => {
    const question = requireString(context, 'question')
    const careerId = stringifyValue(context.parameters.careerId)
    const answer = await context.services.mentor(careerId === '' ? { question } : { question, careerId })
    return items({
      question,
      answer: answer.answer,
      citations: answer.citations,
      // The rule the whole product rests on, restated where it can be read with
      // the answer rather than only in a policy document.
      grounding: 'This answer was assembled from graph facts listed in citations. No fact was added by a language model.',
    })
  },

  /** The roadmap summary for the profile in the parameters. */
  'gm.roadmap.plan': async (context) => {
    const careerId = requireString(context, 'careerId')
    const report = await context.services.frontier({
      careerId,
      ratings: ratings(context),
      weeklyHours: optionalNumber(context, 'weeklyHours', 8),
    })
    const weeklyHours = optionalNumber(context, 'weeklyHours', 8)
    const weeks = report.hours.high > 0 && weeklyHours > 0 ? Math.ceil(report.hours.high / weeklyHours) : null
    return items({
      careerId,
      weeklyHours,
      weeks,
      hoursLow: report.hours.low,
      hoursHigh: report.hours.high,
      order: report.criticalChain.map((step) => step.name),
      startWith: report.frontier.slice(0, 3).map((skill) => skill.name),
      note:
        weeks === null
          ? 'No hour estimate is available for this route yet.'
          : `${weeks} week(s) at ${weeklyHours} h/week by the curriculum's own hour ranges — a planning aid, not a measurement of anyone's pace.`,
    })
  },

  /** Public APIs from the imported directory, mapped to skills. */
  'gm.publicApi.map': async (context) => {
    const list = await context.services.publicApis({
      skillIds: optionalStringList(context, 'skillIds'),
      limit: optionalNumber(context, 'limit', 10),
    })
    if (list.length === 0) return skipped('no API in the imported directory maps to these skills')
    return {
      items: list.map((api) => ({ json: { name: api.name, url: api.url, category: api.category } })),
    }
  },

  /** A text template, evaluated per item. Its output is a string. */
  'gm.transform.template': async (context) => {
    const text = stringifyValue(context.parameters.text)
    return items({ text })
  },

  /** Keeps the items whose field satisfies a simple comparison. */
  'gm.transform.filter': async (context) => {
    const field = requireString(context, 'field')
    const equals = stringifyValue(context.parameters.equals)
    const contains = stringifyValue(context.parameters.contains)
    const kept = context.input.filter((entry) => {
      const value = stringifyValue(entry.json[field])
      if (equals !== '') return value === equals
      if (contains !== '') return value.toLowerCase().includes(contains.toLowerCase())
      return value !== ''
    })
    return { items: kept }
  },

  /** Concatenates the input from every upstream node. */
  'gm.transform.merge': async (context) => ({ items: context.input }),

  /** Writes items into a named collection through the record service. */
  'gm.io.record': async (context) => {
    const collection = requireString(context, 'collection')
    if (context.dryRun) return skipped(`dry run: nothing was written to "${collection}"`)
    for (const entry of context.input) {
      await context.services.record({ collection, item: entry.json })
    }
    return items({ collection, written: context.input.length })
  },

  /** Turns items into one human-readable digest item. */
  'gm.io.digest': async (context) => {
    const title = stringifyValue(context.parameters.title) || 'Digest'
    const lines = context.input.map((entry) => stringifyValue(entry.json.text ?? entry.json.summary ?? entry.json.title))
    return items({
      title,
      generatedAt: new Date(context.services.now()).toISOString(),
      itemCount: context.input.length,
      body: lines.filter((line) => line !== ''),
      // A digest that does not say where its numbers came from is the thing this
      // product exists to argue against.
      provenance: `Produced by workflow ${context.workflowId} from the ${context.services.dataSource} dataset.`,
    })
  },
}

export function getNodeImplementation(type: string): NodeImplementation | undefined {
  return implementations[type]
}

export function nodeTypes(): string[] {
  return Object.keys(implementations).sort()
}
