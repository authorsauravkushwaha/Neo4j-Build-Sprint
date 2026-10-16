# The frontier: what to start, and what is actually left

`analyzeFrontier` (§6 of `supabase/functions/_shared/core/recommend.ts`) answers the
two questions this product is built around, from the same prerequisite graph that
everything else uses:

- **For someone who has not studied any of it:** what can I genuinely start today,
  and what has to come before what?
- **For someone who already works in the field:** what exactly is my remaining
  delta, which handful of skills gate the rest, and what cannot be parallelised no
  matter how many hours I have?

The gap analyser (`§3 analyzeSkillGaps`) already scored a career's *own* list. What
it never did was walk the prerequisites *those skills drag in* — the transitive
closure — which is precisely where the two audience questions live. A beginner needs
the closure; a specialist needs the closure minus what they already know. That is
this section.

The panel that renders it lives in `src/features/gaps/FrontierPanel.tsx` and appears
at the top of the skill-gap analyzer.

## What it computes

| Field | Meaning |
| --- | --- |
| `targetCount` | The career's own skills — the goal. |
| `closureCount` | Every skill reachable by walking `REQUIRES` backwards from the targets. |
| `knownInClosure` / `remainingCount` | Of those, how many are met (mastery ≥ **0.6**) and how many are not. |
| `frontier` | The remaining skills with **nothing unmet in front of them** — the ones startable today. |
| `gates` | Up to three remaining skills that block the most other remaining skills. |
| `gatesUnlock` | How many remaining skills the gate *set* unblocks **between them** — a union, never a sum. |
| `criticalChain` | The longest prerequisite path still ahead, ordered prerequisite-first. Extra hours cannot shorten it; only starting it can. |
| `remaining[]` | Every remaining skill in the order to do it, each naming what it needs first (`needsNow`). |
| `depths[]` | How deep each remaining skill sits in that order (1 = startable). |
| `pulledIn[]` | Closure members the career never lists — prerequisites of its requirements. |
| `hours`, `weeksAtWeeklyHours` | Effort as a range from the dataset's per-skill hour estimates, and the same range in weeks at the learner's pace. |
| `cyclic` | Any prerequisite cycle that reaches the closure, filtered from the whole graph. |
| `caveats` | The honest qualifications that ship with the numbers. |
| `summaryLine` | A one-line digest, deterministic byte-for-byte, used for cross-language comparison. |

### Two decisions worth knowing about

**Gates are counted as a union.** An earlier draft summed each gate's individual
unlock count, which produced sentences like "3 gates unlock 18" when two of the
gates unblocked overlapping skills — a number nobody could verify. `gatesUnlock`
now walks the gate set together and counts each unlock once, and a unit test builds
two gates that unblock the same two skills to pin exactly that case.

**Ordering is by UTF-16 code unit, not locale collation.** Every list this section
returns is sorted with `compareCodeUnits`, because `localeCompare` answers
differently in different hosts and `tools/oracle/FrontierOracle.java` recomputes
these same lists in Java to check them. A locale-sensitive sort would have turned
every cross-language diff into a collation argument. (Ids are ASCII, so for anything
a reader sees, it is simply alphabetical.)

## Evidence

| What | Where | Result |
| --- | --- | --- |
| Semantics | `tests/unit/frontier.test.ts` | 25 tests: startable set, met-threshold behaviour, union counting, real chain edges, cycles, determinism, ordering, effort ranges, plus monotonicity across all 17 careers. |
| Rendered behaviour | `scripts/verify-browser.ts` §11 | 12 checks in Chromium: the panel renders, its three numbers agree with each other, the stat row and the panel quote the same effort, each suggestion still lands on its skill page, and no console errors. |
| Cross-language agreement | `tools/oracle/FrontierOracle.java` | 39 cases, 507 canonical lines identical to the TypeScript engine, plus a self-test that injects an error and requires the diff to catch it. |

An example, from the shipped dataset, cold start on *Software engineer*:

```
13 skill(s) to go: 2 startable now, 3 gate(s) unblock 9, longest chain 5 deep.
start here:  Programming fundamentals · Version control with Git
gates:       Programming fundamentals (unblocks 11) · Operating systems and Linux (4) · Computer networks (3)
cannot be parallelised: Programming fundamentals → Operating systems and Linux →
                        Computer networks → Cybersecurity fundamentals → Secure coding practices
effort:      410–1,030 h ≈ 52–129 weeks at 8 h/week
pulled in:   2 prerequisites the career never lists
```

Rate most of that career as known and the same panel returns the delta instead —
reachable by clearing the ratings, so both readings are one control apart.

## The cross-language oracle

`npm run oracle` regenerates `tools/oracle/fixtures/frontier-oracle.tsv` from the
TypeScript engine, compiles `FrontierOracle.java` with plain `javac` (no build tool),
recomputes every number in Java, and diffs the result line by line.

**What is genuinely independent:** graph construction and de-duplication, the
transitive closure, the unlock walks, gate selection and union semantics, Kahn's
algorithm and the longest-path chain, the aggregation, and every character of the
canonical output.

**What is not:** the tuning policy. The met-threshold, traversal budget, default hour
range, mastery table and caveat sentences are read from the fixture as *declared
inputs* rather than restated in Java, so the oracle tests algorithms, not constants.
Those constants are pinned by unit tests instead (`ENGINE_LIMITS`).

**What it refuses to do:** export a case whose closure contains a prerequisite
cycle. Cycle members are ordered by the graph's cyclic tail, where Java and
JavaScript collation may legitimately differ, so a diff there would be an artefact
rather than a bug. The exporter fails loudly instead of comparing something it
cannot justify. (Cycles *are* covered — by unit tests, not by the oracle.)

Configured to fail honestly:

- the fixture exporter rejects any field containing a tab or newline, so a skill name
  can never shift a column;
- `scripts/run-oracle.mjs` refuses to call a fixture with fewer than 5 cases or 60
  expected lines a proof, so an empty export cannot print `MATCH`;
- `--selftest` corrupts one character of the expectation in memory and requires the
  diff to notice, which is what stops a green `MATCH` from being vacuous;
- `npm run verify` runs the oracle as a core step and, on a machine with no JDK,
  reports it as **skipped by name** rather than passed.

## Limits, stated rather than hidden

- **Self-assessment is not evidence.** "Met" means the learner said so (or a quiz
  nudged a borderline claim). The blend is `0.7 × selfReport + 0.3 × quiz`, so a
  `practised` claim (0.7) with a failing quiz falls to 0.49 and stays on the list,
  while a `learning` claim (0.4) cannot reach 0.6 even with a perfect quiz. The
  caveats ship with every report.
- **Hours are planning ranges** from the dataset's per-skill estimates, summed. They
  are not a promise of elapsed time, and the week figure is a range derived from the
  learner's own weekly-hours setting.
- **The closure is bounded by the career slice** (`depth` 6, `maxSkills` 400). The
  limits are applied upstream by `loadCareerSlice`, and a truncated slice is
  reported as such rather than silently presented as complete.
- **Only `REQUIRES` edges are walked.** Other relationship types describe the graph
  but do not order the work.
- **A cycle in the data is disclosed, not smoothed over:** the report names the
  affected skills in `cyclic`, adds a caveat, and still returns an answer.
- **This is not a schedule.** Ordering and effort, yes; dates and durations per step
  belong to the roadmap builder, which uses the same graph.

## Why this made the product better, not just bigger

Building the panel surfaced a contradiction that had been shipping: the stat row
computed remaining effort from a local difficulty heuristic (18–40 h per "advanced"
skill) while the frontier used the dataset's per-skill estimates, so the same page
could say "100–240 h" and "410–1,030 h" about the same ratings. The page now has one
hour model — the dataset's — and a browser check asserts the two renderings agree.


