/**
 * GET /health-check
 *
 * Reports honestly what is configured. This is the endpoint the frontend calls
 * first: it decides between live mode and the clearly-labelled local sample mode.
 * It never returns secrets, hostnames with credentials, or stack traces.
 */
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { json } from '../core/http.ts'
import type { GraphHealth } from '../core/types.ts'
import { describeProvider } from '../core/aiAdapter.ts'
import { emptyGraphHint } from '../core/neo4jReader.ts'
import type { Runtime } from '../runtime.ts'
import { signingStatus } from './shared.ts'

export interface HealthPayload {
  graph: GraphHealth
  ai: {
    configured: boolean
    provider: string
    note: string
  }
  storage: {
    configured: boolean
    /** Which backend holds the rows. Absent in guest mode, where nothing does. */
    backend?: 'supabase' | 'appwrite'
    note: string
  }
  security: {
    requestSigningRequired: boolean
    note: string
  }
  service: {
    version: string
    environment: string
    limits: {
      maxGraphNodesPerRequest: number
      mentorRequestsPerMinute: number
      maxRequestBodyKb: number
      aiMaxContextChars: number
    }
  }
}

export async function healthCheckHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const checkedAt = new Date().toISOString()

  let graph: GraphHealth
  if (!runtime.reader) {
    graph = {
      configured: false,
      reachable: false,
      source: 'unavailable',
      nodeCount: 0,
      relationshipCount: 0,
      labels: [],
      message:
        runtime.readerReason ??
        'No knowledge graph is configured on this deployment. The browser app will run in labelled sample-data mode.',
      ...(runtime.readerSetupHint ? { setupHint: runtime.readerSetupHint } : { setupHint: emptyGraphHint() }),
      checkedAt,
    }
  } else {
    try {
      const { value } = await runtime.reader.totals()
      const empty = value.nodes === 0
      graph = {
        configured: true,
        reachable: true,
        source: runtime.reader.kind === 'neo4j' ? 'neo4j-live' : 'local-sample',
        nodeCount: value.nodes,
        relationshipCount: value.relationships,
        labels: value.labels.map((entry) => ({ label: entry.label as GraphHealth['labels'][number]['label'], count: entry.count })),
        message: empty
          ? 'The graph is reachable but empty. Run the seed script to load the curriculum.'
          : `Graph reachable: ${value.nodes} nodes, ${value.relationships} relationships.`,
        ...(empty ? { setupHint: emptyGraphHint() } : {}),
        checkedAt,
      }
    } catch (error) {
      graph = {
        configured: true,
        reachable: false,
        source: 'unavailable',
        nodeCount: 0,
        relationshipCount: 0,
        labels: [],
        message:
          'The knowledge graph is configured but could not be reached. Check the Neo4j instance status and the NEO4J_* secrets, then try again.',
        setupHint: emptyGraphHint(),
        checkedAt,
      }
      request.logger.warn('graph unreachable during health check', {
        code: 'dependency_unavailable',
        detail: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  const signing = signingStatus(runtime)

  const payload: HealthPayload = {
    graph,
    ai: {
      configured: runtime.ai.configured,
      provider: describeProvider(runtime.config.ai),
      note: runtime.ai.configured
        ? 'AI answers are generated from retrieved graph context. They can contain errors — check the cited resources.'
        : 'No AI provider configured. The deterministic rules engine answers mentor questions from the same graph data.',
    },
    storage: {
      configured: runtime.repos !== null,
      ...(runtime.storageBackend ? { backend: runtime.storageBackend } : {}),
      note: describeStorage(runtime),
    },
    security: {
      requestSigningRequired: signing.required,
      note: signing.reason,
    },
    service: {
      version: '1.0.0',
      environment: runtime.config.environment,
      limits: {
        maxGraphNodesPerRequest: runtime.config.limits.maxRows,
        mentorRequestsPerMinute: runtime.config.limits.mentorPerMinute.limit,
        maxRequestBodyKb: Math.round(runtime.config.limits.maxJsonBodyBytes / 1024),
        aiMaxContextChars: runtime.config.limits.maxContextChars,
      },
    },
  }

  // Health information is public and mildly cacheable, but must not be cached by
  // a user's service worker in a way that hides an outage: 30 seconds, public.
  return json(200, { ok: true, data: payload, meta: { source: graph.source, generatedAt: checkedAt } }, {
    'cache-control': 'public, max-age=30, stale-while-revalidate=30',
  })
}

/**
 * What a user is told about where their data lives.
 *
 * Two things this must never do: claim Supabase on a deployment that runs on
 * Appwrite, and imply a hosted database when there is none. `storageBackend` is
 * set by the platform layer that created the repositories (see
 * `_shared/platform/deno.ts`), so the sentence follows the wiring rather than
 * guessing at it.
 */
function describeStorage(runtime: Runtime): string {
  if (!runtime.repos) {
    return 'Account storage is not configured here. The app runs in guest mode with progress kept in this browser only.'
  }
  if (runtime.storageBackend === 'appwrite') {
    return 'Accounts, saved roadmaps and progress are stored in this deployment’s Appwrite project, and every query is scoped to your account by the server.'
  }
  return 'Accounts, saved roadmaps and progress are stored in your Supabase project under Row Level Security.'
}
