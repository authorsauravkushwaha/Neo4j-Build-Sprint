# Workflows

Automation in this project is a **readable graph of steps**, not a script and not a
black box. This document is the contract: what a workflow can do, what it refuses
to do, how a run is logged, and where the whole thing is checked.

The engine lives in `supabase/functions/_shared/core/workflow/`, runs unchanged in
the browser, in the CLI and in the tests, and has no dependency on this app's UI or
on Supabase.

```
types.ts       the shapes: node types, definitions, items, run logs, injected services
expressions.ts the {{ }} reference language — no eval, no calls, no operators
cron.ts        the five-field schedule parser (UTC, documented day-of-month/DOW rule)
registry.ts    the 14 node implementations and the URL allow-list check
engine.ts      ordering, retries, limits, redaction, run-log assembly
services.ts    how capabilities are supplied per environment, and how they refuse
library.ts     the five workflows this repository actually ships
n8nCompat.ts   export to n8n's document format, for review rather than execution
```

## What a workflow is

A definition is data: nodes, connections, and a settings block. There is no code
node, no string-to-function, and no `eval` anywhere in the engine. A node's
behaviour comes from a registry keyed by its `type`, and its parameters are values —
including values that came from an earlier node, resolved through the reference
grammar below.

```ts
{
  id: 'workflow:weekly-plan-digest',
  name: 'Weekly plan digest',
  limitations: [ /* shown on every run, on the page and in the CLI output */ ],
  trigger: { kind: 'schedule', cron: '0 6 * * 1', description: 'Mondays at 06:00 UTC' },
  settings: { allowedHosts: [ /* nothing is reachable unless it is listed here */ ],
              limits: { maxNodes: 20, maxItemsPerNode: 200, maxRunMs: 30_000 } },
  nodes: [ { id, name, type, typeVersion, position, parameters } ],
  connections: { 'Frontier': { main: [[{ node: 'Resources', type: 'main', index: 0 }]] } },
}
```

The shape is n8n's, deliberately: `nodes` plus `connections` keyed by node name is
a format other tools can read, and adopting it means this project does not invent a
second one. What is *not* adopted is n8n's node catalogue — see
[the export section](#exporting-for-n8n).

## The node types

| Type | What it does | Notes |
| --- | --- | --- |
| `gm.trigger.manual` | starts a run | one empty item, so a run has a root |
| `gm.trigger.schedule` | carries a cron expression into the run | parsing and "is it due" live in `cron.ts` |
| `gm.graph.frontier` | the frontier for one career and one stated profile | the engine in `recommend.ts`; numbers are not recomputed here |
| `gm.resources.list` | free resources for the skills in the input | `rankResources`, so ranking matches the rest of the app |
| `gm.resources.check` | probes resource URLs | the only node that leaves the machine; opt-in, allow-listed, `HEAD` only |
| `gm.mentor.ask` | one grounded answer with citations | attaches the grounding statement to its own output |
| `gm.roadmap.plan` | hours and weeks for a route | ranges, never a single promised date |
| `gm.publicApi.map` | free APIs from the imported catalogue | see [`public-apis.md`](public-apis.md) |
| `gm.transform.template` | evaluates a text template per item | the output is a string, always |
| `gm.transform.filter` | keeps items matching a field comparison | whole batch, see below |
| `gm.transform.merge` | concatenates upstream items | whole batch |
| `gm.io.record` | writes items to a named collection | skipped, with a reason, in a dry run |
| `gm.io.digest` | one human-readable item with provenance | whole batch |

Batch nodes (`filter`, `merge`, `digest`, `record`, `resources.check`) are declared
in `registry.ts` and run **once** for the whole input. Everything else runs once per
item, which is n8n's default. A digest invoked per item would emit one digest per
resource — a rich-looking result that is a duplicated one, and the sort of bug that
never shows up in a one-item test.

## The reference language

Parameters may interpolate values from earlier nodes:

```
{{ $json.title }}                         the current item
{{ $json.items[0].name }}                 array indexes
{{ $node["Frontier"].json.summary }}      another node's first output item
{{ $now }}  {{ $count }}  {{ $workflow.id }}
```

Four rules, each of which is a refusal:

1. **No calls, no operators, no assignment.** `{{ process.exit(1) }}`,
   `{{ 1 + 1 }}` and `{{ $json.a = 2 }}` all evaluate to the empty string *and* are
   reported as unresolved references — load-time validation names the node and the
   parameter (`Frontier.summary` vs `Frontier.nested.list[1]`).
2. **No prototype-chain reads.** Paths are read with an own-property check, so
   `$json.constructor` and `$json.__proto__` are undefined rather than clever.
3. **A whole-string reference keeps its type.** `"{{ $node[\"Frontier\"].json.count }}"`
   resolves to the number, not `"13"`, because a count that arrives as a string
   fails numeric validation three nodes later.
4. **An unresolved reference renders empty and is reported**, never as literal
   `{{ }}` braces. A digest with a hole in it says so in the run's caveats.

## Running a workflow

**From the app** — `/workflows`. Each workflow is drawn step by step, run
deliberately, and logged node by node. Runs happen **in the tab**: there is no
server-side runner in this deployment and the page says so rather than pretending.

**From the CLI** — the same engine against the bundled dataset:

```bash
npm run workflow -- --list
npm run workflow -- --due                                # what a scheduler would fire now
npm run workflow -- --id workflow:weekly-plan-digest      # run it
npm run workflow -- --id workflow:resource-freshness-sweep --dry-run
npm run workflow -- --id workflow:resource-freshness-sweep --allow-probe
npm run workflow -- --export-n8n tmp/n8n
```

Outbound probes are **opt-in** (`--allow-probe`). Without it the probe node skips
and the log says why — the honest outcome for a CI job that has not been given
permission to make requests to third-party sites. A run that fails sets exit code 1,
so a red run cannot be read as green by a pipeline.

## What a run log contains

Every node that was considered, in execution order, with: status (`succeeded`,
`failed`, `skipped`, `disabled`), input and output counts, attempts, duration, a
truncated sample of its output (redacted where the node asked), and — for anything
that did not succeed — the reason in words.

Plus `environment`: the data source (`bundled-sample`, `neo4j`, `unavailable`),
whether a network was available, and whether it was a dry run. Sample output can
never be mistaken for live output, because the log states which one produced it.

Plus `caveats`: the workflow's own `limitations` array, appended to *every* run —
so the limits travel with the results rather than living in a doc nobody opens.

A run does not throw for a node-level problem. It returns with `status: 'failed'`
and the node that stopped it named. A caller that has to catch an exception to find
out what happened will eventually forget to.

## Retries, failure and limits

- `retryOnFail` + `maxTries` (clamped to 5) + `waitBetweenTries`. The wait is an
  injected service, so tests do not sleep and a browser tab does not block.
- `onError: 'continue'` marks the run `partial` and keeps going with whatever the
  failed node passed through. Anything else stops the run at that node.
- Ceilings: `maxNodes` (default 60), `maxItemsPerNode` (500), `maxRunMs`
  (120 s). Hitting item ceilings adds a caveat that says so; hitting the time
  budget stops the run with the reason recorded.
- A definition that cannot run — duplicate node names, a connection to a node that
  does not exist, an unknown type, a malformed expression — is refused at load
  time, before any node runs.

## Security posture

The engine's threat model is "a workflow definition is untrusted input".

| Attack | Why it does not work |
| --- | --- |
| Arbitrary code in a parameter | There is no evaluator: the reference grammar has no calls or operators, and there is no code node at all. |
| Reaching an attacker's host | `gm.resources.check` refuses any URL whose host is not in that workflow's own `allowedHosts`. https only; credentials in the URL refused; `evil.example` does not match `example.com` and neither does `example.com.evil.example` (the lookalike case a naive `endsWith` gets wrong). |
| SSRF via redirect | A redirect is reported with the status code; only https hosts on the list are requested in the first place. |
| Exfiltration through the log | Samples are truncated, and a node may declare `redact`, whose fields are logged as `[redacted]`. |
| Runaway cost | Node, item and time ceilings; item ceilings are caveated rather than silent. |
| Lying about what happened | Every node is logged including skipped ones; the environment is recorded; the workflow's limitations are repeated on every run. |
| Silently doing nothing | A missing capability refuses **by name** (`This environment cannot run a frontier analysis here`) instead of returning an empty list, which would look like a result. |

## The five shipped workflows

| Workflow | Trigger | What it is for |
| --- | --- | --- |
| `workflow:resource-freshness-sweep` | `0 6 * * 1` | probes the free resources for one career and reports what stopped answering |
| `workflow:weekly-plan-digest` | manual | the frontier turned into an ordered plan for one stated profile |
| `workflow:grounded-question` | manual | one mentor question, answered with citations, recorded with them |
| `workflow:public-api-map` | manual | free APIs to practise the skills a learner is working on |
| `workflow:frontier-export` | manual | the fixture the cross-language Java oracle compares against |

Each carries its own `limitations`; read them on the page or in `library.ts`. The
short version: a failed probe is not a dead resource, hour ranges are the
curriculum's own, and a related API is a practice target rather than a lesson.

## Exporting for n8n

`n8nCompat.ts` writes an n8n document (`toN8n`, `exportLibrary`) and the CLI writes
them with `--export-n8n`. Be precise about what that file is:

- **It is for review.** Somebody who wants to argue about whether the freshness
  sweep retries properly can open the same graph in a canvas they already have.
- **It is not a runtime bridge.** The two trigger types map to their n8n
  equivalents; every other node keeps its `gm.*` type, so n8n shows it as an
  unknown node in the right place with its parameters intact. Translating each node
  into a `n8n-nodes-base.code` node containing JavaScript was rejected: it would put
  unread, untested code into a file that looks authoritative.
- **The file says so.** `meta.gmExport.importNotes` lists the nodes with no n8n
  equivalent, states that parameters are this project's, and records that there is
  no code node, no credential and no arbitrary HTTP in the export.

## How this is checked

| Test | What it pins |
| --- | --- |
| `tests/unit/workflow-engine.test.ts` (54) | ordering, refusals at load time, per-node logs, environment recording, retries and `waitBetweenTries`, `onError: continue`, disabled nodes, redaction, item caps, node ceilings, capability refusals, the allow-list (including the lookalike-host case), the expression grammar and its refusals, cron parsing and due-ness, library self-consistency, and the n8n export's honesty fields |
| `tests/integration/workflows.test.tsx` (7) | the page lists the library, opens each workflow's limits, runs one, logs every node including the skipped probe, reports the data source, and offers no builder it does not have |

The CI workflow runs the CLI against the bundled dataset, so the engine is
exercised through the same entrance a person uses.
