# The recommendation engine

This is the document the in-app pages point at when they say "the weights are printed in the code". Every
number below is a constant in `supabase/functions/_shared/core/recommend.ts`; if this file and that file
ever disagree, the file wins and this one needs fixing. The engine has **no AI in it** — it is arithmetic
over the knowledge graph, and it produces the same answer for the same inputs on any machine.

Why it exists at all: a learner asking "what should I study next" deserves an answer that can be argued
with. A score you can inspect can be disputed, corrected and re-run. A model's suggestion cannot.

---

## 1. What it is given

| Input | Where it comes from |
| --- | --- |
| The dependency graph | `REQUIRES`, `REQUIRES_SKILL`, `BUILDS_ON` edges — the graph is the authority on ordering |
| Your self-reported skill states | `unknown`, `new`, `learning`, `practised`, `confident` (self-assessment, never inferred) |
| Your goal | a `Career` node, or nothing at all |
| Your constraints | weekly hours, pace (`relaxed` / `steady` / `intensive`), preferred style (`video` / `reading` / `hands-on` / `mixed`) |
| Interests | inferred from the names you gave during onboarding, capped at 8 |

## 2. Skill-gap scoring

`analyzeSkillGaps()` walks the goal's prerequisite closure and sorts each skill with `categorize()`, using
two thresholds: `FAMILIAR_THRESHOLD` **0.7** and `PREREQ_MET_THRESHOLD` **0.6**. These are the actual
categories, in the order the function tests them:

| Category | Meaning |
| --- | --- |
| `already-familiar` | Mastery ≥ 0.7. Excluded from plans, kept in the report so the reasoning is visible. |
| `missing-prerequisite` | At least one prerequisite sits below 0.6. The thing to fix first. |
| `optional-specialization` | Not an essential skill of the target career — real, but not blocking. |
| `ready-to-practice` | Essential, prerequisites met, some mastery already. Practice rather than re-learn. |
| `recommended-next` | Essential, prerequisites met, nothing started. The default front of the queue. |

Mastery is itself an estimate, and the engine does not pretend otherwise: a self-reported state maps to a
base value, and a quiz score moves it at most 30 % (`base * 0.7 + quiz * 0.3`). A quiz can nudge the
estimate; it can never turn self-report into proof.

A **cycle** in the prerequisite closure is reported, not hidden: `buildPrereqGraph()` returns `cyclic: true`
and the affected skill ids, and the path builder then relaxes the affected constraint instead of dropping
skills silently. Cycles should not exist in the dataset — `npm run validate:seed` fails if one is
introduced — but the engine does not assume its input is clean.

## 3. The candidate score

For each candidate skill, `rankSkills` blends five terms. Positive weights sum to **0.90**; the effort
penalty is **subtracted**.

| Term | Weight | What it measures |
| --- | --- | --- |
| Goal relevance | **0.35** | How many of the goal career's essential skills this skill unlocks. |
| Prerequisite centrality | **0.25** | How much else in the graph stands behind this skill — the multiplier effect. |
| Gap size | **0.20** | How far your self-reported state is from `confident`. |
| Interest fit | **0.10** | Name similarity against your interests, inferred at onboarding. |
| Effort penalty | **−0.20** | Estimated hours, normalised. Long topics are pushed later *without* being hidden. |

Deliberately absent: popularity, ratings, "most learners chose", or any signal that would need a population
this app does not have. There is no training data and no feedback loop that could drift.

### Worked example (arithmetic illustration, not a recorded run)

A learner targeting Robotics has `Python: new`, `Linear algebra: unknown`, `CAD: practised`. The term values
below are chosen to show how the weights combine; the ordering is the point, not the exact decimals.

| Skill | Relevance | Centrality | Gap | Interest | Effort | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Linear algebra | 0.35 | 0.21 | 0.20 | 0.04 | −0.09 | **0.71** |
| Python | 0.30 | 0.18 | 0.16 | 0.09 | −0.05 | **0.68** |
| CAD | 0.12 | 0.05 | 0.08 | 0.02 | −0.12 | **0.15** |

Reading it: linear algebra first because it is behind the most other things, despite the higher effort
penalty — exactly the trade-off the weights are meant to express. CAD comes last because it is largely
optional breadth for this goal.

## 4. Ordering a plan

`buildPathway()` and `buildRoadmap()` never schedule a skill before its prerequisites:

1. Take the goal's prerequisite closure.
2. Topologically sort by `REQUIRES` edges, using the score above to break ties.
3. Convert levels into weeks, sized by `weeklyHours` and scaled by pace: `PACE_MULTIPLIER` is
   **0.75** (relaxed), **1.0** (steady), **1.35** (intensive).
4. Interleave review rows: after every **3rd** learning step, a review of the skills most likely to decay.
   A quiz row at **30 % mastery** is inserted rather than pretending a topic is done after one pass.
5. Cap the plan at **MAX_STEPS = 60**. Hitting the cap produces an explicit note, never a silently shorter
   roadmap.
6. Steps are numbered from **0** (`order` is zero-based); `taskKeyFor(kind, order)` derives the stable row
   key `learn-<order>` that progress is recorded against. Review rows reuse their learning row's `skillId`
   but get their own key, which is why progress can be tracked per row rather than per skill.

`rescheduleRoadmap()` re-derives the remaining sequence from the same graph when you change hours or pace,
keeping completed steps completed.

## 5. Projects and resources

- Projects come from `SUGGESTS_PROJECT` edges: a project is suggested because the graph connects it to a
  skill you are trying to build, not because it is popular. Difficulty and estimated hours rank within that.
- Resources are ranked by coverage of your gap, then by access badge — `free` before `free-audit` before
  `freemium`. A resource is marked `verified` **only** if its link was actually checked; the date comes from
  `src/data/seed/resourceVerification.json`, written by `npm run verify:resources`, never from a guess.

## 6. The frontier: what to start, and what is left

Everything above scores a career's *own* list. §6 of the same module — `analyzeFrontier`
— answers the question a learner actually asks, by walking the prerequisites those
skills drag in: the transitive closure, minus what is already met, split into what is
startable now, what gates the rest, and the longest chain that cannot be
parallelised. Its output drives the delta view at the top of `/gaps`, for a beginner
and a specialist alike. It is documented separately, with its evidence and its
limits, in [frontier.md](frontier.md) — including the Java oracle that recomputes
every number independently.

## 7. What it cannot do

- It cannot tell you whether a skill will get you hired. It only knows the graph.
- It cannot know how fast *you* learn; the hour estimates are curriculum averages multiplied by your pace.
- It has no memory of what other learners did, because no such data exists here.
- It will not reorder the graph to flatter you: if a difficult prerequisite is genuinely required, it stays
  in front of what depends on it.
- It is not adaptive in the machine-learning sense. Nothing here learns from your usage.

## 8. Reading the code

| Function | File | Purpose |
| --- | --- | --- |
| `analyzeSkillGaps` | `core/recommend.ts` | Buckets + report + `categoryLabels` |
| `buildPathway` | `core/recommend.ts` | Dependency-ordered route with essentials/optional split |
| `buildRoadmap`, `rescheduleRoadmap` | `core/recommend.ts` | Weekly plan, review spacing, re-planning |
| `nextActivity`, `summarizeProgress` | `core/recommend.ts` | What is next, and how far along you are |
| `rankProjects`, `rankResources` | `core/recommend.ts` | Ranking with the same transparent weights |
| `inferInterests` | `core/recommend.ts` | Interest list from onboarding names, capped at 8 |
| `buildPrereqGraph` | `core/recommend.ts` | `{ prerequisites, dependents, cyclic }` |

Tests: `tests/unit/recommend.test.ts` (31 tests) pins determinism under a fixed clock, dependency
invariants, review spacing, cycle handling and tie-breaking. `tests/unit/validate.test.ts` checks the
dataset the engine reads satisfies the assumptions above.


