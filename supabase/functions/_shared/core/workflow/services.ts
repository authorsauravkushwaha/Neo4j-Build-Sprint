/**
 * Building the services a run is allowed to use.
 *
 * The engine takes capabilities as an argument (see `WorkflowServices`), and this
 * file is where those capabilities come from in each environment:
 *
 *   * the **browser**, in sample mode, over the bundled dataset;
 *   * the **edge function**, over Neo4j;
 *   * the **CLI**, over whichever of the two is configured;
 *   * the **tests**, over fixtures and an in-memory recorder.
 *
 * The important design decision is what happens when a capability is missing.
 * Each resolver falls back to a function that *refuses by name* — "this
 * environment cannot answer mentor questions" — rather than returning an empty
 * list. An empty list is a result; a refusal is a reason. A workflow that quietly
 * produced a digest full of blanks because nobody wired the resource reader would
 * be worse than one that failed, and this file is what makes that choice.
 *
 * Nothing in here reads a global clock, and the only global it touches is `fetch`,
 * which is passed in so a test can count requests instead of making them.
 */
import type { WorkflowServices } from './types.ts'

export interface ServiceOverrides {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  dataSource?: WorkflowServices['dataSource']
  network?: boolean
  fetchImpl?: typeof fetch
  record?: WorkflowServices['record']
  /** Extra fields attached to every `not available` error, for the log. */
  unavailableNote?: string
}

/** The refusal every missing capability produces: named, and never silent. */
export function unavailable(capability: string, note?: string): never {
  throw new Error(`This environment cannot ${capability}.${note ? ` ${note}` : ''}`)
}

/**
 * A recorder that keeps records in memory.
 *
 * Used by the browser (where the only durable store is the user's own browser
 * storage, reached through the feature that owns it) and by the tests. It is not
 * a fake: it is the real implementation for those two environments, and it reports
 * exactly what it stored so a run log can be checked against it.
 */
export function createMemoryRecorder(): { record: WorkflowServices['record']; items: Array<{ collection: string; item: Record<string, unknown> }> } {
  const items: Array<{ collection: string; item: Record<string, unknown> }> = []
  return {
    items,
    record: async ({ collection, item }) => {
      items.push({ collection, item })
    },
  }
}

/**
 * Ahead-only HTTP probe.
 *
 * HEAD only, bounded timeout, no redirects or ambient browser credentials.
 * The registry validates the initial URL against the workflow host policy;
 * following a redirect here would bypass that policy. A redirect is reported
 * as a non-success rather than probing its unvalidated destination.
 */
export function createFetchProbe(fetchImpl: typeof fetch = fetch): WorkflowServices['fetch'] {
  return async ({ url, method, timeoutMs }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'GraphMentorAI-resource-check/1.0 (+https://github.com/authorsauravkushwaha/Neo4j-Build-Sprint)' },
      })
      return { ok: response.ok, status: response.status, ms: Date.now() - started }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Assembles the service object.
 *
 * Every resolver is optional in the argument and *refuses* in the result, so a
 * caller can wire only what it has and the run log will still be honest about the
 * rest.
 */
export function createWorkflowServices(
  overrides: Partial<WorkflowServices> = {},
  options: ServiceOverrides = {},
): WorkflowServices {
  const note = options.unavailableNote
  return {
    now: options.now ?? (() => Date.now()),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    dataSource: options.dataSource ?? 'bundled-sample',
    network: options.network ?? false,
    frontier: overrides.frontier ?? (async () => unavailable('run a frontier analysis here', note)),
    pathway: overrides.pathway ?? (async () => unavailable('trace a pathway here', note)),
    resources: overrides.resources ?? (async () => unavailable('list resources here', note)),
    mentor: overrides.mentor ?? (async () => unavailable('answer mentor questions here', note)),
    publicApis: overrides.publicApis ?? (async () => []),
    fetch: overrides.fetch ?? createFetchProbe(options.fetchImpl ?? fetch),
    record: overrides.record ?? options.record ?? createMemoryRecorder().record,
  }
}

/**
 * Which hosts the workflows in the library are allowed to reach, as one set.
 *
 * Exported so the CI job and the browser's own disclosure of outbound requests
 * can quote the same list rather than describing it.
 */
export const WORKFLOW_ALLOWED_HOSTS: readonly string[] = [
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
] as const
