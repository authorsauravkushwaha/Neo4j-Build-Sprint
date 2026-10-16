/**
 * The workflow engine.
 *
 * Automation is where a career tool is most likely to become dishonest: a digest
 * that runs on a schedule, prints plausible numbers and reports success is
 * indistinguishable from a correct one unless somebody checks. So these tests
 * check the four properties the engine promises, in the order they matter:
 *
 *   1. it is honest about its environment (sample data, no network, dry runs),
 *   2. it records every node — including the skipped ones and why,
 *   3. it fails loudly, or continues loudly, but never silently,
 *   4. it cannot be talked into fetching a host the workflow did not allow.
 *
 * The services here are fakes, which is the point: nothing in this file can reach
 * the network, so a pass means the engine decided, not that the internet agreed.
 */
import { describe, expect, it, vi } from 'vitest'

import { runWorkflow, executionOrder, inspectWorkflow, DEFAULT_LIMITS } from '@core/workflow/engine.ts'
import { hostAllowed } from '@core/workflow/registry.ts'
import { WORKFLOW_ALLOWED_HOSTS, createMemoryRecorder, createWorkflowServices, unavailable } from '@core/workflow/services.ts'
import { WORKFLOW_LIBRARY, findWorkflow, scheduledWorkflows } from '@core/workflow/library.ts'
import { exportLibrary, toN8n } from '@core/workflow/n8nCompat.ts'
import { evaluate, resolveReference, validateExpressions, type ExpressionScope } from '@core/workflow/expressions.ts'
import { describeCron, isDue, isValidCron, nextOccurrences, parseCron } from '@core/workflow/cron.ts'
import type { WorkflowDefinition, WorkflowItem, WorkflowServices } from '@core/workflow/types.ts'

/* --------------------------------------------------------------- test doubles */

const FRONTIER = {
  remainingCount: 13,
  summaryLine: '13 skill(s) to go: 2 startable now, 3 gate(s) unblock 9, longest chain 5 deep.',
  frontier: [
    { skillId: 'skill:programming-fundamentals', name: 'Programming fundamentals', unlocks: 8 },
    { skillId: 'skill:operating-systems-and-linux', name: 'Operating systems and Linux', unlocks: 6 },
  ],
  criticalChain: [
    { skillId: 'skill:programming-fundamentals', name: 'Programming fundamentals' },
    { skillId: 'skill:operating-systems-and-linux', name: 'Operating systems and Linux' },
  ],
  gates: [{ skillId: 'skill:operating-systems-and-linux', name: 'Operating systems and Linux', unlocks: 6 }],
  gatesUnlock: 4,
  hours: { low: 120, high: 240 },
}

function services(overrides: Partial<WorkflowServices> = {}): WorkflowServices {
  return createWorkflowServices(
    {
      frontier: async () => FRONTIER,
      resources: async () => [
        { id: 'resource:mdn', name: 'MDN Web Docs', url: 'https://developer.mozilla.org/en-US/', accessModel: 'free', verified: '2026-10-01' },
        { id: 'resource:evil', name: 'Not allowed', url: 'https://not-on-the-list.example/x', accessModel: 'free', verified: null },
      ],
      mentor: async (input) => ({ answer: `Grounded answer to "${input.question}".`, citations: ['skill:operating-systems-and-linux', 'skill:computer-networks'] }),
      publicApis: async () => [{ name: 'Open Library', url: 'https://openlibrary.org/developers/api', category: 'Books' }],
      ...overrides,
    },
    { now: (() => {
      let t = Date.UTC(2026, 9, 16, 6, 0, 0)
      return () => (t += 5)
    })(), network: true, dataSource: 'bundled-sample' },
  )
}

function workflow(withAllowedHost = true): WorkflowDefinition {
  return {
    id: 'workflow:test',
    name: 'Test workflow',
    version: 1,
    description: 'A workflow used by the tests.',
    limitations: ['A test workflow cannot tell you anything about the curriculum.'],
    trigger: { kind: 'manual', description: 'by hand' },
    settings: { allowedHosts: withAllowedHost ? ['developer.mozilla.org'] : [] },
    nodes: [
      { id: 'a', name: 'Start', type: 'gm.trigger.manual', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Frontier', type: 'gm.graph.frontier', typeVersion: 1, position: [1, 0], parameters: { careerId: 'career:software-engineer' } },
      { id: 'c', name: 'Resources', type: 'gm.resources.list', typeVersion: 1, position: [2, 0], parameters: { limit: 5 } },
      { id: 'd', name: 'Probe', type: 'gm.resources.check', typeVersion: 1, position: [3, 0], parameters: {} },
      { id: 'e', name: 'Digest', type: 'gm.io.digest', typeVersion: 1, position: [4, 0], parameters: { title: 'Digest' } },
    ],
    connections: {
      Start: { main: [[{ node: 'Frontier', type: 'main', index: 0 }]] },
      Frontier: { main: [[{ node: 'Resources', type: 'main', index: 0 }]] },
      Resources: { main: [[{ node: 'Probe', type: 'main', index: 0 }]] },
      Probe: { main: [[{ node: 'Digest', type: 'main', index: 0 }]] },
    },
  }
}

/* ------------------------------------------------------------------ ordering */

describe('planning a run', () => {
  it('orders nodes so every node runs after its inputs', () => {
    const order = executionOrder(workflow()).map((node) => node.name)
    expect(order[0]).toBe('Start')
    expect(order.indexOf('Frontier')).toBeLessThan(order.indexOf('Resources'))
    expect(order.indexOf('Resources')).toBeLessThan(order.indexOf('Probe'))
    expect(order.at(-1)).toBe('Digest')
  })

  it('refuses a workflow whose connections point at nothing', () => {
    const broken = workflow()
    broken.connections = { Start: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] } }
    const { errors } = inspectWorkflow(broken)
    expect(errors.join(' ')).toMatch(/Ghost/)
  })

  it('refuses two nodes with the same name, because connections address nodes by name', () => {
    const duplicate = workflow()
    duplicate.nodes.push({ id: 'x', name: 'Start', type: 'gm.trigger.manual', typeVersion: 1, position: [9, 9], parameters: {} })
    expect(inspectWorkflow(duplicate).errors.join(' ')).toMatch(/both called "Start"/)
  })

  it('refuses an unknown node type instead of ignoring it', () => {
    const unknown = workflow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unknown.nodes.push({ id: 'z', name: 'Mystery', type: 'gm.do.anything' as any, typeVersion: 1, position: [0, 0], parameters: {} })
    expect(inspectWorkflow(unknown).errors.join(' ')).toMatch(/unknown type/)
  })

  it('rejects a malformed expression at load time, naming the node and the parameter', () => {
    const bad = workflow()
    const probe = bad.nodes.find((node) => node.name === 'Probe')!
    probe.parameters = { what: '{{ setTimeout("x", 1) }}' }
    const { planErrors } = inspectWorkflow(bad)
    expect(planErrors).toHaveLength(1)
    expect(planErrors[0]?.node).toBe('Probe')
    expect(planErrors[0]?.reference).toMatch(/setTimeout/)
  })

  it('throws only for a malformed definition, which is a programming error', async () => {
    const broken = workflow()
    broken.connections = { Start: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] } }
    await expect(runWorkflow(broken, services())).rejects.toThrow(/cannot run/)
  })
})

/* ----------------------------------------------------------------- the engine */

describe('running a workflow', () => {
  it('walks the graph and records every node that ran', async () => {
    const run = await runWorkflow(workflow(), services())
    expect(run.status).toBe('succeeded')
    expect(run.nodes.map((node) => node.nodeName)).toEqual(['Start', 'Frontier', 'Resources', 'Probe', 'Digest'])
    for (const node of run.nodes) {
      expect(node.status).toBe('succeeded')
      expect(node.durationMs).toBeGreaterThanOrEqual(0)
      expect(node.attempts).toBe(1)
    }
    // The digest is the workflow's output, and it says where its numbers came from.
    expect(run.output).toHaveLength(1)
    expect(run.output[0]?.json.provenance).toMatch(/bundled-sample/)
  })

  it('records the environment, so sample output can never be read as live output', async () => {
    const run = await runWorkflow(workflow(), services())
    expect(run.environment).toEqual({ dataSource: 'bundled-sample', network: true, dryRun: false })
    const live = await runWorkflow(workflow(), createWorkflowServices({ frontier: async () => FRONTIER }, { dataSource: 'neo4j', network: true }))
    expect(live.environment.dataSource).toBe('neo4j')
  })

  it('skips the network nodes, by name, when there is no network', async () => {
    const run = await runWorkflow(workflow(), services({}, ), )
    expect(run.status).toBe('succeeded')
    // Rebuilt with network off: the probe must skip rather than fail or pretend.
    const offline = createWorkflowServices({ frontier: async () => FRONTIER, resources: async () => [
      { id: 'r', name: 'MDN', url: 'https://developer.mozilla.org/', accessModel: 'free', verified: null },
    ] }, { network: false, dataSource: 'bundled-sample' })
    const offlineRun = await runWorkflow(workflow(), offline)
    const probe = offlineRun.nodes.find((node) => node.nodeName === 'Probe')
    expect(probe?.status).toBe('skipped')
    expect(probe?.skipReason).toMatch(/no network/)
    expect(offlineRun.caveats.join(' ')).toMatch(/No network in this environment: the nodes that need one were skipped/)
  })

  it('probes only the hosts the workflow allows, and says which it refused', async () => {
    const fetch = vi.fn(async (request: Parameters<WorkflowServices['fetch']>[0]) => ({ ok: true, status: 200, ms: 12, url: request.url }))
    const run = await runWorkflow(workflow(), services({ fetch } as Partial<WorkflowServices>, ))
    const probe = run.nodes.find((node) => node.nodeName === 'Probe')
    expect(probe?.status).toBe('succeeded')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({ url: 'https://developer.mozilla.org/en-US/', method: 'HEAD' })
    const refused = probe?.sample.find((item) => String(item.json.url).includes('not-on-the-list'))
    expect(refused?.json.reason).toMatch(/allowedHosts/)
  })

  it('does not fetch anything in a dry run, and says so in the caveats', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, ms: 1 }))
    const run = await runWorkflow(workflow(), services({ fetch } as Partial<WorkflowServices>), { dryRun: true })
    expect(fetch).not.toHaveBeenCalled()
    expect(run.environment.dryRun).toBe(true)
    expect(run.nodes.find((node) => node.nodeName === 'Probe')?.status).toBe('skipped')
    expect(run.caveats.join(' ')).toMatch(/Dry run/)
  })

  it('retries a failing node and then fails the run, naming the node that stopped it', async () => {
    const flaky = workflow()
    const frontierNode = flaky.nodes.find((node) => node.name === 'Frontier')!
    frontierNode.retryOnFail = true
    frontierNode.maxTries = 3
    frontierNode.waitBetweenTries = 10
    const sleep = vi.fn(async () => undefined)
    const frontier = vi.fn(async () => {
      throw new Error('the graph reader is unavailable')
    })
    const run = await runWorkflow(flaky, createWorkflowServices({ frontier }, { sleep }))
    expect(run.status).toBe('failed')
    expect(run.nodes.find((node) => node.nodeName === 'Frontier')?.attempts).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(run.caveats.join(' ')).toMatch(/Stopped at "Frontier"/)
    // Nothing downstream of the failure ran.
    expect(run.nodes.some((node) => node.nodeName === 'Digest')).toBe(false)
  })

  it('continues past a node that opted into continuing, and marks the run partial', async () => {
    const tolerant = workflow()
    const resources = tolerant.nodes.find((node) => node.name === 'Resources')!
    resources.onError = 'continue'
    const run = await runWorkflow(
      tolerant,
      createWorkflowServices({
        frontier: async () => FRONTIER,
        resources: async () => {
          throw new Error('no resource index configured')
        },
      }),
    )
    expect(run.status).toBe('partial')
    expect(run.nodes.find((node) => node.nodeName === 'Resources')?.status).toBe('failed')
    // The digest still ran, on whatever the failed node passed through.
    expect(run.nodes.find((node) => node.nodeName === 'Digest')?.status).toBe('succeeded')
    expect(run.caveats.join(' ')).toMatch(/configured to continue/)
  })

  it('marks a disabled node as disabled rather than dropping it from the log', async () => {
    const withDisabled = workflow()
    const digest = withDisabled.nodes.find((node) => node.name === 'Digest')!
    digest.disabled = true
    const run = await runWorkflow(withDisabled, services())
    const logged = run.nodes.find((node) => node.nodeName === 'Digest')
    expect(logged?.status).toBe('disabled')
    expect(logged?.skipReason).toMatch(/disabled/)
  })

  it('redacts a parameter it was told to redact', async () => {
    const secretive = workflow()
    const start = secretive.nodes.find((node) => node.name === 'Start')!
    start.redact = ['startedBy']
    const run = await runWorkflow(secretive, services())
    const sample = run.nodes.find((node) => node.nodeName === 'Start')?.sample[0]?.json
    expect(sample?.startedBy).toBe('[redacted]')
  })

  it('writes records in a dry run nowhere, and in a real run to the recorder', async () => {
    const recorder = createMemoryRecorder()
    const withRecord: WorkflowDefinition = {
      ...workflow(),
      nodes: [...workflow().nodes, { id: 'f', name: 'Store', type: 'gm.io.record', typeVersion: 1, position: [5, 0], parameters: { collection: 'runs' } }],
      connections: { ...workflow().connections, Digest: { main: [[{ node: 'Store', type: 'main', index: 0 }]] } },
    }
    await runWorkflow(withRecord, services({ record: recorder.record }), { dryRun: true })
    expect(recorder.items).toHaveLength(0)
    await runWorkflow(withRecord, services({ record: recorder.record }))
    expect(recorder.items).toHaveLength(1)
    expect(recorder.items[0]?.collection).toBe('runs')
  })

  it('caps the items passed between nodes and says that it capped them', async () => {
    const many = workflow()
    const run = await runWorkflow(many, services({ resources: async () => Array.from({ length: 40 }, (_v, index) => ({ id: `r${index}`, name: `Resource ${index}`, url: 'https://developer.mozilla.org/', accessModel: 'free', verified: null })) }), {
      maxItemsPerNode: 5,
    })
    expect(run.nodes.find((node) => node.nodeName === 'Resources')?.outputCount).toBe(5)
    expect(run.caveats.join(' ')).toMatch(/produced 40 items/)
  })

  it('refuses a workflow larger than the ceiling', () => {
    const huge = workflow()
    huge.nodes = Array.from({ length: DEFAULT_LIMITS.maxNodes + 1 }, (_v, index) => ({
      id: `n${index}`,
      name: `Node ${index}`,
      type: 'gm.transform.merge' as const,
      typeVersion: 1,
      position: [index, 0] as [number, number],
      parameters: {},
    }))
    huge.connections = {}
    expect(inspectWorkflow(huge).errors.join(' ')).toMatch(/ceiling/)
  })

  it('appends the workflow s own limitations to every run', async () => {
    const run = await runWorkflow(workflow(), services())
    expect(run.caveats).toContain('A test workflow cannot tell you anything about the curriculum.')
  })
})

/* ------------------------------------------------------------------- services */

describe('the capability refusals', () => {
  it('refuses by name when a capability was never wired', async () => {
    const bare = createWorkflowServices()
    await expect(bare.frontier({ careerId: 'career:x', ratings: [], weeklyHours: 4 })).rejects.toThrow(/cannot run a frontier analysis here/)
    await expect(bare.mentor({ question: 'x' })).rejects.toThrow(/cannot answer mentor questions here/)
    expect(() => unavailable('do it', 'No reason given.')).toThrow(/cannot do it. No reason given./)
  })

  it('never returns an empty list in place of a missing capability', async () => {
    const bare = createWorkflowServices()
    // An empty list would look like "no resources exist", which is a claim.
    await expect(bare.resources({ skillIds: [] })).rejects.toThrow()
    // Public APIs are the one exception, and only because the imported directory
    // genuinely may not map to a given skill.
    await expect(bare.publicApis({ skillIds: ['skill:x'] })).resolves.toEqual([])
  })
})

/* ---------------------------------------------------------------- host safety */

describe('the URL allow-list', () => {
  it('allows an exact host and its subdomains', () => {
    expect(hostAllowed('https://developer.mozilla.org/en-US/docs', ['developer.mozilla.org']).allowed).toBe(true)
    expect(hostAllowed('https://docs.developer.mozilla.org/x', ['developer.mozilla.org']).allowed).toBe(true)
  })

  it('refuses a lookalike, which is what a naive endsWith would let through', () => {
    expect(hostAllowed('https://developer.mozilla.org.evil.example/', ['developer.mozilla.org'])).toMatchObject({ allowed: false })
    expect(hostAllowed('https://notdeveloper.mozilla.org/', ['developer.mozilla.org'])).toMatchObject({ allowed: false })
  })

  it('refuses plain http, credentials in the URL, and non-URLs', () => {
    expect(hostAllowed('http://developer.mozilla.org/', ['developer.mozilla.org']).reason).toMatch(/https/)
    expect(hostAllowed('https://user:pass@developer.mozilla.org/', ['developer.mozilla.org']).reason).toMatch(/credentials/)
    expect(hostAllowed('not a url', ['developer.mozilla.org']).reason).toMatch(/not a URL/)
  })

  it('refuses everything when the workflow declared no hosts', () => {
    expect(hostAllowed('https://developer.mozilla.org/', []).allowed).toBe(false)
  })
})

/* ----------------------------------------------------------------- expressions */

describe('the expression grammar', () => {
  const scope: ExpressionScope = {
    json: { title: 'MDN', items: [{ name: 'first' }], nested: { deep: { value: 7 } } },
    nodes: { Frontier: { summary: '13 to go', count: 13 } },
    now: Date.UTC(2026, 9, 16),
    workflowId: 'workflow:test',
    count: 2,
  }

  it('reads the current item, including array indexes', () => {
    expect(evaluate('{{ $json.title }}', scope).value).toBe('MDN')
    expect(evaluate('{{ $json.items[0].name }}', scope).value).toBe('first')
    expect(evaluate('{{ $json.nested.deep.value }}', scope).value).toBe(7)
  })

  it('keeps the type when a parameter is exactly one reference', () => {
    // A count that arrived as the string "13" would fail number validation later.
    expect(evaluate('{{ $node["Frontier"].json.count }}', scope).value).toBe(13)
  })

  it('interpolates inside a sentence', () => {
    const result = evaluate('{{ $node["Frontier"].json.summary }} at {{ $now }}', scope)
    expect(result.value).toMatch(/^13 to go at 2026-10-16T00:00:00.000Z$/)
    expect(result.unresolved).toEqual([])
  })

  it('renders an unresolved reference as empty and reports it, never as literal braces', () => {
    const result = evaluate('{{ $node["Typo"].json.summary }}', scope)
    expect(result.value).toBe('')
    expect(result.unresolved).toEqual(['$node["Typo"].json.summary'])
    expect(String(result.value)).not.toMatch(/\{\{/)
  })

  it('refuses anything that is not a reference: no calls, no operators, no assignment', () => {
    for (const attempt of ['{{ process.exit(1) }}', '{{ 1 + 1 }}', '{{ $json.a = 2 }}', '{{ $json.__proto__ }}'.replace('__proto__', 'constructor')]) {
      const result = evaluate(attempt, scope)
      expect(result.value, attempt).toBe('')
      expect(result.unresolved.length, attempt).toBeGreaterThan(0)
    }
  })

  it('never walks the prototype chain', () => {
    expect(resolveReference('$json.constructor', scope).value).toBeUndefined()
    expect(resolveReference('$json.toString', scope).value).toBeUndefined()
  })

  it('validates a whole parameter map, including nested arrays', () => {
    const problems = validateExpressions('Node', {
      ok: '{{ $json.title }}',
      nested: { list: ['{{ $json.title }}', '{{ 2 + 2 }}'] },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.parameter).toBe('nested.list[1]')
  })
})

/* -------------------------------------------------------------------- library */

describe('the workflow library', () => {
  it('is internally consistent: every workflow plans without errors', () => {
    for (const definition of WORKFLOW_LIBRARY) {
      const { errors, planErrors } = inspectWorkflow(definition)
      expect(errors, definition.id).toEqual([])
      expect(planErrors, definition.id).toEqual([])
    }
  })

  it('states its limits on every workflow, because a feature list without limits is marketing', () => {
    for (const definition of WORKFLOW_LIBRARY) {
      expect(definition.limitations.length, definition.id).toBeGreaterThan(0)
    }
  })

  it('names every allowed host explicitly, and nothing is reachable by default', () => {
    const declared = new Set<string>()
    for (const definition of WORKFLOW_LIBRARY) {
      const hosts = definition.settings?.allowedHosts ?? []
      for (const host of hosts) {
        expect(host, definition.id).toMatch(/^[a-z0-9.-]+$/)
        expect(host).not.toMatch(/^\*|\*$/)
        declared.add(host)
      }
    }
    // The list the UI and the CI job quote is the list the workflows actually use:
    // a disclosure that drifts from the behaviour is worse than no disclosure.
    expect([...declared].sort()).toEqual([...WORKFLOW_ALLOWED_HOSTS].sort())
  })

  it('has exactly one scheduled workflow, and a cron a human can read', () => {
    const scheduled = scheduledWorkflows()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.cron).toMatch(/^\d+ \d+ \* \* \d$/)
    expect(scheduled[0]?.workflow.trigger.description).toMatch(/Mondays/)
  })

  it('finds a workflow by id, and returns nothing for an unknown one', () => {
    expect(findWorkflow('workflow:weekly-plan-digest')?.name).toBe('Weekly plan digest')
    expect(findWorkflow('workflow:nope')).toBeUndefined()
  })
})

/* ----------------------------------------------------------------- n8n export */

describe('the n8n export', () => {
  it('keeps the graph, the parameters and the retry settings', () => {
    const definition = findWorkflow('workflow:resource-freshness-sweep')!
    const exported = toN8n(definition)
    expect(exported.connections).toEqual(definition.connections)
    const probe = exported.nodes.find((node) => node.name === 'Probe')
    expect(probe).toMatchObject({ retryOnFail: true, maxTries: 2, waitBetweenTries: 400, onError: 'continueRegularOutput' })
    expect(exported.settings.executionOrder).toBe('v1')
  })

  it('maps the triggers it genuinely shares, and refuses to fake the rest', () => {
    const exported = toN8n(findWorkflow('workflow:weekly-plan-digest')!)
    expect(exported.nodes.find((node) => node.name === 'Start')?.type).toBe('n8n-nodes-base.manualTrigger')
    // The engine's own nodes keep their identity: n8n shows them as unknown in
    // the right place rather than running something that would behave differently.
    expect(exported.nodes.find((node) => node.name === 'Frontier')?.type).toBe('gm.graph.frontier')
  })

  it('says in the file what an importer must not assume', () => {
    const exported = toN8n(findWorkflow('workflow:grounded-question')!)
    const notes = exported.meta.gmExport.importNotes.join(' ')
    expect(notes).toMatch(/for review, not for execution/)
    expect(notes).toMatch(/no code node, no credential and no arbitrary HTTP/)
    expect(exported.meta.gmExport.limitations.length).toBeGreaterThan(0)
  })

  it('exports the whole library under stable file names', () => {
    const files = exportLibrary(WORKFLOW_LIBRARY)
    expect(Object.keys(files).sort()).toEqual([
      'frontier-export.n8n.json',
      'grounded-question.n8n.json',
      'public-api-map.n8n.json',
      'resource-freshness-sweep.n8n.json',
      'weekly-plan-digest.n8n.json',
    ])
    for (const [name, document] of Object.entries(files)) {
      expect(document.nodes.length, name).toBeGreaterThan(1)
    }
  })
})

/* ------------------------------------------------- a real run over the library */

describe('running a library workflow with real-ish services', () => {
  it('produces a digest whose body is built from the engine s numbers', async () => {
    const definition = findWorkflow('workflow:weekly-plan-digest')!
    const run = await runWorkflow(definition, services())
    expect(run.status).toBe('succeeded')
    const digest = run.output[0]?.json as Record<string, unknown>
    expect(digest.title).toMatch(/bundled curriculum/)
    expect(String(digest.provenance)).toMatch(/bundled-sample/)
    const line = (digest.body as string[])[0] ?? ''
    expect(line).toContain('13 skill(s) to go')
  })

  it('records items through the injected recorder rather than a global store', async () => {
    const recorder = createMemoryRecorder()
    const definition = findWorkflow('workflow:frontier-export')!
    const run = await runWorkflow(definition, services({ record: recorder.record }))
    expect(run.status).toBe('succeeded')
    expect(recorder.items).toHaveLength(1)
    const recorded = recorder.items[0]?.item as Record<string, unknown>
    expect(recorded.summary).toMatch(/13 skill\(s\) to go/)
    // The export carries the inputs a comparison needs, not just the conclusion.
    expect(recorded.criticalChainLength).toBe(2)
  })

  it('skips the public-API node with a reason when nothing maps to the skills', async () => {
    const definition = findWorkflow('workflow:public-api-map')!
    const run = await runWorkflow(definition, services({ publicApis: async () => [] }))
    const node = run.nodes.find((entry) => entry.nodeName === 'Apis')
    expect(node?.status).toBe('skipped')
    expect(node?.skipReason).toMatch(/no API in the imported directory/i)
  })
})

/* ------------------------------------------------------------------- the shape */

describe('the item shape', () => {
  it('passes n8n-shaped items between nodes', () => {
    const item: WorkflowItem = { json: { text: 'hello' } }
    expect(Object.keys(item)).toEqual(['json'])
  })
})

/* ----------------------------------------------------------------------- cron */

describe('the cron parser', () => {
  it('reads a weekly expression and finds the next Monday at 06:00 UTC', () => {
    // 2026-10-16 is a Friday.
    const from = new Date(Date.UTC(2026, 9, 16, 12, 0, 0))
    const [next] = nextOccurrences('0 6 * * 1', from, 1)
    expect(next?.toISOString()).toBe('2026-10-19T06:00:00.000Z')
    expect(next?.getUTCDay()).toBe(1)
  })

  it('expands steps, ranges and lists', () => {
    const [first] = nextOccurrences('*/15 9-17 * * 1-5', new Date(Date.UTC(2026, 9, 16, 7, 59, 0)), 1)
    expect(first?.toISOString()).toBe('2026-10-16T09:00:00.000Z')
    // 07:59 on a Friday: the next quarter-hour inside the working window is 09:00.
    const [second] = nextOccurrences('0 0,12 * * 0,6', new Date(Date.UTC(2026, 9, 16, 13, 0, 0)), 1)
    expect(second?.toISOString()).toBe('2026-10-17T00:00:00.000Z')
  })

  it('accepts day and month names, and 7 as Sunday', () => {
    expect(parseCron('30 8 * * mon').dayOfWeek.values).toEqual([1])
    expect(parseCron('30 8 * jan *').month.values).toEqual([1])
    expect(parseCron('0 0 * * 7').dayOfWeek.values).toEqual([0])
  })

  it('handles a month end instead of pretending February has 31 days', () => {
    const [next] = nextOccurrences('0 3 31 * *', new Date(Date.UTC(2027, 1, 1, 0, 0, 0)), 1)
    // February 2027 has 28 days, so the next 31st is in March.
    expect(next?.toISOString()).toBe('2027-03-31T03:00:00.000Z')
  })

  it('treats a restricted day-of-month and day-of-week as either-matches, and documents that in the test', () => {
    // 2026-10-02 is the first Friday of October; 2026-11-01 is a Sunday the 1st.
    expect(isDue('0 0 1 * 5', new Date(Date.UTC(2026, 9, 2)))).toBe(true)
    expect(isDue('0 0 1 * 5', new Date(Date.UTC(2026, 10, 1)))).toBe(true)
    expect(isDue('0 0 1 * 5', new Date(Date.UTC(2026, 9, 3)))).toBe(false)
  })

  it('refuses a malformed expression with a sentence, not a stack trace', () => {
    expect(() => parseCron('0 6 * *')).toThrow(/five fields/)
    expect(() => parseCron('0 25 * * *')).toThrow(/hour field starts at 0 and ends at 23/)
    expect(() => parseCron('0 6 * * nonsense')).toThrow(/not a number or a known name/)
    expect(() => parseCron('0 6 * * 5-1')).toThrow(/runs backwards/)
    expect(() => parseCron('*/0 6 * * *')).toThrow(/positive whole number/)
    expect(isValidCron('0 6 * * 1')).toBe(true)
    expect(isValidCron('every monday')).toBe(false)
  })

  it('refuses an expression that never fires rather than searching forever', () => {
    expect(() => nextOccurrences('0 0 30 2 *', new Date(Date.UTC(2026, 0, 1)), 1)).toThrow(/does not fire/)
  })

  it('describes an expression in words a person can check', () => {
    expect(describeCron('0 6 * * 1')).toMatch(/06:00/)
    expect(describeCron('0 6 * * 1')).toMatch(/Monday/)
    expect(describeCron('0 6 * * 1')).toMatch(/UTC/)
  })

  it('is the expression the library s scheduled workflow actually uses', () => {
    const scheduled = scheduledWorkflows()
    const cron = scheduled[0]?.cron ?? ''
    expect(isValidCron(cron)).toBe(true)
    const [next] = nextOccurrences(cron, new Date(Date.UTC(2026, 9, 16)), 1)
    expect(next?.getUTCDay()).toBe(1)
    expect(next?.getUTCHours()).toBe(6)
  })
})
