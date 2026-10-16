/**
 * Workflow services backed by the app's own client.
 *
 * The engine never imports anything that touches the world (see
 * `core/workflow/types.ts`); this file is the browser's answer to "then how does a
 * node read the graph". Every capability is delegated to the *same* client the
 * rest of the UI uses, which is the point:
 *
 *   * in sample mode the calls run the bundled engine in this tab;
 *   * in live mode the same calls go to the Edge Functions over Neo4j;
 *   * a workflow therefore behaves identically in both, and the run log's
 *     `dataSource` reflects which one answered.
 *
 * Nothing here invents a capability. If the client cannot answer — the backend
 * has no graph configured, the mentor has no provider — the error travels out and
 * the node is logged as failed or skipped *by name*, rather than producing a
 * blank that looks like a fact.
 */
import type { GraphMentorClient, ResourceQueryInput } from './api.ts'
import { createWorkflowServices } from '@core/workflow/services.ts'
import type { WorkflowServices } from '@core/workflow/types.ts'

export interface WorkflowServiceOptions {
  /** Called for every record a workflow writes. */
  record: WorkflowServices['record']
  /** Default weekly hours when a node does not state a profile. */
  weeklyHours?: number
  /** Extra caveat attached to every refusal, e.g. "configure a backend to run this". */
  unavailableNote?: string
}

/**
 * The one place a workflow may leave the app, and only after the engine has
 * checked the host against the workflow's own allow-list.
 */
function probeFetch(): WorkflowServices['fetch'] {
  return async ({ url, method, timeoutMs }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    try {
      const response = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        referrerPolicy: 'no-referrer',
        headers: { accept: 'text/html,application/xhtml+xml' },
      })
      return { ok: response.ok, status: response.status, ms: Date.now() - started }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function createClientWorkflowServices(client: GraphMentorClient, options: WorkflowServiceOptions): WorkflowServices {
  const weeklyHours = options.weeklyHours ?? 8
  return createWorkflowServices(
    {
      frontier: async ({ careerId, ratings }) => {
        const result = await client.analyzeGaps({ careerId, ratings, weeklyHours })
        const report = result.data.frontier
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
        const result = await client.getCareerPath({
          careerId,
          ratings,
          weeklyHours,
          pace: pace ?? 'steady',
          learningStyle: learningStyle ?? 'mixed',
          difficultyComfort: difficultyComfort ?? 'beginner',
        })
        const pathway = result.data.pathway
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
        const query: ResourceQueryInput = { limit, ...(skillIds.length > 0 ? { skillIds } : {}) }
        const result = await client.listResources(query)
        return result.data.resources.map((resource) => ({
          id: resource.id,
          name: resource.name,
          url: resource.url,
          accessModel: resource.accessModel,
          verified: resource.lastVerified,
        }))
      },
      mentor: async ({ question, careerId }) => {
        const result = await client.mentorChat({ message: question, mode: 'concise', careerId: careerId ?? null })
        return {
          answer: result.data.answer.answer,
          citations: [...result.data.answer.graphBasis, ...result.data.answer.evidence.map((reference) => reference.id ?? reference.label)],
        }
      },
      publicApis: async ({ skillIds, limit }) => {
        const { listPublicApis } = await import('@/data/publicApis/index.ts')
        return listPublicApis({ skillIds, limit })
      },
      fetch: probeFetch(),
      record: options.record,
    },
    {
      dataSource: client.mode === 'demo' ? 'bundled-sample' : 'neo4j',
      network: typeof navigator === 'undefined' ? false : navigator.onLine,
      ...(options.unavailableNote ? { unavailableNote: options.unavailableNote } : {}),
    },
  )
}
