# Prior art

Six repositories were named as references when this project was commissioned:
[supabase/supabase](https://github.com/supabase/supabase),
[n8n-io/n8n](https://github.com/n8n-io/n8n),
[public-apis/public-apis](https://github.com/public-apis/public-apis),
[appwrite/appwrite](https://github.com/appwrite/appwrite),
[666ghj/MiroFish](https://github.com/666ghj/MiroFish) and
[vxcontrol/pentagi](https://github.com/vxcontrol/pentagi).

This page records what was taken from each one and what was refused, because
"inspired by" is not a statement anyone can check. Every claim below names something
in this repository — a file, a document, a test — and every borrowing is listed with
its cost, so a reader can decide whether the trade was worth it.

The rule applied throughout: **take the mechanism, not the surface.** A pattern is
worth importing when it is the reason the original works under load, in production or
under audit; it is not worth importing because it looks like the original.

---

## supabase/supabase — a real Postgres, reached through typed functions

**What it is.** A Postgres platform: the database, the client libraries, the CLI and,
in the monorepo, the Edge Functions runtime. The parts worth studying are not the UI
at all: they are the schema conventions (every table owned by a user carries an
ownership column and a policy), the migration discipline, and the shape of an error
that crosses a network boundary.

**What this project took**

| Borrowed | Where it lives | Why |
| --- | --- | --- |
| Row-level security as the ownership mechanism, not application filters | `supabase/migrations/001_graphmentor_core.sql` — `enable row level security` plus one policy per table (`profiles`, `saved_roadmaps`, `roadmap_tasks`, `user_skill_progress`, `bookmarks`, …) | A filter in a handler is one forgotten `where` away from a cross-user read. A policy is not reachable from the request path. |
| One `auth.uid()` definition shared by production and the local harness | `db/identity/00_auth_contract.sql` versus `supabase/local/00_supabase_shim.sql`, held equal by `tests/unit/db-contract.test.ts`, which also pins the role attributes and the `pg_hba.conf` requirement of TLS + SCRAM + a verified client certificate | The RLS harness otherwise proves properties of a function production does not have — parity theatre, where the test passes and the deployment does something else. |
| Edge Functions as thin, testable handlers | `supabase/functions/*/index.ts` are shims; the logic is in `supabase/functions/_shared/handlers/**` and runs in Node under vitest (`tests/integration/handlers.test.ts`, 43 tests) | Function bodies that can only run inside the platform can only be tested by deploying them. |
| A single response envelope and a typed contract shared by both sides | `_shared/core/contracts.ts`, `_shared/core/http.ts` | The client and the server cannot drift if a field rename breaks compilation on both sides. |
| Rate limiting keyed on identity with a window, not a counter | `_shared/core/rateLimit.ts` + `002_graphmentor_rate_limit.sql` | A counter resets on deploy; a window does not. |

**What was left behind.** The client library. This app talks to Postgres through the
Edge Functions and through `db/` for local parity, so shipping `@supabase/supabase-js`
into the bundle would add a dependency whose main job — being a REST client for
PostgREST — is already done by the functions. One fewer moving part in the browser,
and the ownership rules stay on the server where they can be enforced.

---

## n8n-io/n8n — automation as data, not as code

**What it is.** A workflow automation tool: nodes, connections, expressions, a
trigger, a run log. Its genuinely good ideas are structural — a workflow is a
document, a node's behaviour comes from a registry keyed by type, and an expression
language resolves references without evaluating anything.

**What this project took** (`supabase/functions/_shared/core/workflow/`, documented in
[`docs/workflows.md`](workflows.md), 56 tests in `tests/unit/workflow-engine.test.ts`)

- **Definitions are data.** `types.ts` declares the node types; there is no code
  node, no string-to-function and no `eval`. A definition can be read, diffed and
  stored without anyone needing to review a script.
- **A registry keyed by node type**, versioned per node (`typeVersion`), so a new node
  is a new entry rather than a new branch in an executor.
- **An expression language that cannot execute.** `expressions.ts` resolves `{{ }}`
  references with no operators and no calls. The reason is not purity: a
  string-interpolated query is the same defect as SQL injection wearing different
  clothes.
- **An explicit allow-list of reachable hosts**, checked per node type
  (`settings.allowedHosts`), with nothing reachable unless it is listed.
- **A run log per execution** that records what each node did, how long it took and
  what it refused, so a failure is a record and not a recollection.
- **Export to n8n's own document format** (`n8nCompat.ts`) — for review, not for
  execution. A workflow you can show someone is a workflow they can argue with.

**What was left behind.** Visual editing. n8n's canvas is its product; here the
workflows are six fixed, documented recipes in `library.ts`, because the value in
this project is the graph of prerequisites, not a second editor to maintain. The
honest limitation — this is not a general automation platform — is stated in
[`docs/features-and-limitations.md`](features-and-limitations.md).

---

## public-apis/public-apis — a dataset whose licence is part of the data

**What it is.** A community-curated list of free APIs, shaped as a README table and
shipped as CSV/JSON. Two things make it a good source rather than a good idea: every
row carries provenance (a link, a category) and every row carries conditions
(`Auth`, `CORS`, `HTTPS`).

**What this project took** (`scripts/import-public-apis.ts`, `src/data/publicApis/**`,
documented in [`docs/public-apis.md`](public-apis.md), tested in
`tests/unit/public-apis.test.ts` and `tests/unit/public-apis-importer.test.ts`)

- **Import as a build step, not a runtime fetch.** The script requires an explicit
  `--source` path, never reaches the network, refuses to write a catalogue below a row
  floor, and is byte-identical on a re-run, so the result can be reviewed in a diff.
- **Conditions are kept, not summarised.** A row's `Auth` and `CORS` values are stored
  verbatim and shown verbatim; the catalogue says "needs an API key", not "free".
- **Provenance is stamped into the artefact** — source commit `065455e`, read date,
  row count, and the count of rows whose `HTTPS` column says `Yes` while the link is
  still `http://` (two of them). A dataset without its read date is a rumour.
- **Rows that cannot be used are dropped rather than shown**: `HTTPS: No` rows, and
  rows that name no skill the curriculum teaches. 2,028 parsed → 259 kept.

**What was left behind.** The upstream README as a user interface. It is 2,028 rows in
one table with no way to ask "which of these need no key and teach me something in my
pathway" — which is the only question a learner actually has. The importer maps each
row onto curriculum skills so the catalogue is filterable by the app's own graph.

---

## appwrite/appwrite — a second backend, provably equivalent

**What it is.** A self-hostable backend: collections with permissions, and a document
API over them. It was not adopted as a replacement for anything. It was used as a
**second implementation of the same contract**, which is a much more useful thing to
have.

**What this project took** (`docs/appwrite.md`, the Appwrite adapter and its tests):
the design decision that this app has **one backend contract** — repositories of
records with per-user ownership — and that the Supabase implementation and the
Appwrite implementation must be interchangeable. The traps that decision exposes are
written down where a future contributor will hit them (`docs/appwrite.md`, "What is
identical, and how"): a row's id is mirrored into both `documentId` and the `id`
attribute; a `single()` that matched nothing *or more than one* must still surface the
same `PGRST116`; an Appwrite HTTP status has to map back onto the PostgREST code
(`POSTGREST_CODE_FOR_STATUS`) or `fail('…', error)` behaves differently on the two
backends; and a `409` during an upsert means a lost race, so the adapter re-reads and
patches the winner instead of reporting a failure.

**What was left behind.** Adopting it. Two backends running in production is two sets
of credentials, two failure modes and two bills for one product. What the second
implementation bought was a test of whether the contract was real: a contract only one
implementation can satisfy is not a contract, it is a description of that
implementation. The selection rule that came out of it is deliberately conservative —
a *complete* Appwrite configuration selects Appwrite, a *partial* one selects **no
backend at all** rather than half of one — because a backend that is 80% configured
fails in ways that look like application bugs.

---

## 666ghj/MiroFish — a simulation pipeline with its substitute declared

**What it is.** A multi-agent prediction engine: seed extraction, persona generation,
a simulation in which LLM agents react to each other, then a report agent that writes
up what happened.

**What this project took** ([`docs/audience-simulation.md`](audience-simulation.md),
`tools/audience/**`): the *pipeline shape* — extract seeds, generate personas, run
them through a funnel, report — and the persona schema (`OasisAgentProfile`: name,
bio, age, profession, interests, social reach). Fourteen personas with declared
parameters run a seven-stage funnel against facts measured from this build.

**What was left behind, and this one matters.** The LLM agents. A reaction you cannot
audit is a reaction you cannot act on, and this repository has no AI key by design.
The substitution — deterministic predicates over a measured fact sheet — is stated in
the document's own header, along with what is lost by making it: **emergence**.
Nothing there models a review thread changing somebody's mind. The document is
labelled a model, not user research, and it says what it cannot tell you before it
says anything else.

---

## vxcontrol/pentagi — autonomy bounded by a ledger

**What it is.** A system of autonomous agents that perform penetration-testing tasks:
tools with declared inputs, a permission boundary around what an agent may touch, and
per-task observability so an operator can answer "what did it actually do?" after the
fact. The security-relevant idea is not the autonomy. It is that **an agent's actions
are recorded in a form a third party can check**, because an autonomous system whose
reasoning cannot be reconstructed is not auditable, and an unauditable system cannot
be trusted with a claim as strong as "this answer came only from the graph".

**What this project took.** The ledger, applied to the mentor.

- Every graph read behind a mentor answer is recorded — the reader method, how many
  times it ran, what it asked for, how many rows came back, how long it took, and
  whether it hit its row limit (`_shared/core/mentorContext.ts`,
  `createReadLedger`/`summarizeReads`).
- The ledger is part of the response (`MentorChatResponse.context.reads`, with
  `readMs`), so it crosses the network with the answer instead of living in a log the
  reader cannot see.
- The mentor page renders it: the chip over each answer reads **"N graph
  reads · M ms"**, and the disclosure under it lists one line per reader method
  (`src/features/mentor/MentorPage.tsx`).
- The boundary is enforced structurally, which is why the ledger can be trusted: the
  context builder receives a `GraphReader` and cannot reach a database, a file or the
  network by any other route. The model is handed the *serialized context* and is
  explicitly told it cannot run queries (rule 9 of `MENTOR_SYSTEM_PROMPT`); a
  citation naming an id that is not in that context is dropped and reported as an
  unknown (`validateCitations`).
- Three tests keep it honest: `tests/unit/mentor-ledger.test.ts` (10) checks the
  grouping, the totals and the empty cases;
  `tests/integration/mentor.test.tsx` (4) checks the page shows the ledger; and
  `tests/integration/handlers.test.ts` checks the response carries it.

**What the ledger found on its first run.** A question the graph could not parse —
`"qwertyuiop zxcvbnm"` — reported **eleven rows read**. The readers fall back to an
arbitrary slice of the catalogue when given nothing to match on
(`localReader.findProjects`: an empty candidate set becomes every project), so the
answer came with five projects and six resources that looked tailored and were not.
The fix was not in the ledger but behind it: `buildMentorContext` now only asks for
recommendations when something is anchored — a skill or a career — and an unanchored
question reads nothing and says so. That is the whole argument for this kind of
observability, in one bug: the number was wrong before the feature existed, and nobody
could see it.

**What was left behind.** Autonomy. This mentor does not choose its own next action,
call arbitrary tools, or write to the graph. It reads, composes and cites. The scope of
what it can do is the reason its claims can be strong; a mentor that could write to a
learner's progress record would need a permission model this project does not have,
and building one so it could edit a roadmap without being asked would be effort spent
to make the product worse.

---

## The pattern across all six

Each reference contributed one thing that is hard to build from scratch and easy to
get subtly wrong: a policy you cannot bypass (Supabase), an execution model that is
data (n8n), a dataset that keeps its conditions (public-apis), a contract with two
implementations (Appwrite), a simulation with its substitute declared (MiroFish), and
an audit trail for a system that answers questions (PentAGI).

None of them contributed an interface, a brand, a colour or a dependency that was not
needed. Where a borrowing cost more than it was worth — the Supabase client, visual
workflow editing, a second production backend, LLM agents, autonomy — it was refused
on the record, in the table above, rather than quietly omitted.
