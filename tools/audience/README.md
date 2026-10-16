# The audience simulation

*What this is:* a deterministic model that walks fourteen declared personas through a
seven-stage funnel against facts measured from this build, and writes down where each
one leaves and why.

*What was done about the findings:* [`../../docs/audience-actions.md`](../../docs/audience-actions.md)
— fixed, open and out-of-scope, with the next step named for each.

*What this is not:* user research, and not MiroFish's output. No real person was
observed, surveyed or interviewed. No LLM was involved — this project has no AI key,
and a reaction you cannot audit is a reaction you cannot act on. The file
[`../docs/audience-simulation.md`](../../docs/audience-simulation.md) is the study
itself; `rounds/` holds one immutable JSON per run, so a "what changed" claim is a
computed diff rather than a memory.

## The method, and what was kept

The pipeline is [MiroFish](https://github.com/666ghj/MiroFish)'s — seed extraction →
persona generation → simulation rounds → report — with one substitution: **the agents
are deterministic predicates over a measured fact sheet instead of LLM calls.**

| MiroFish stage | Here | Where |
| --- | --- | --- |
| Seed extraction (a document, a news story) | The shipped product, measured in a cold browser under declared network and CPU throttling | `scripts/audience/measure.ts` |
| GraphRAG over the seed | A fact sheet: id, value, unit, how it was measured, and whether it came from this run, the browser suite, or the source tree | `tools/audience/measured-facts.json` |
| Persona generation (`OasisAgentProfile`) | Fourteen personas with declared parameters — patience, click budget, whether proof is required before signing up, scepticism, interests, reach, device, arrival channels | `scripts/audience/personas.ts` |
| Simulation rounds with memory | Seven stage functions, each returning a stance, a first-person quote and the evidence ids behind it | `scripts/audience/simulate.ts` |
| Report agent (summary + sections) | The study: summary, segment verdicts, drop-off, ranked weaknesses and strengths, objections with fixes, per-persona traces, the fact table, caveats | `scripts/audience/report.ts` |

What is lost in the substitution is emergence: nothing here models a review thread
changing somebody's mind, and no persona surprises the person who wrote it. What is
gained is auditability — every sentence in the study can be traced to a number, and
every number to a command.

## Declared conditions

A reaction is only meaningful relative to an environment, so the environment is
recorded with the facts (`conditions` in the fact sheet):

- **Desktop** 1440×900, device pixel ratio 1, no account, fresh profile.
- **Mobile** 360×740, mobile user agent, touch.
- **Network** 40 ms latency, 10 Mbit/s down / 3 Mbit/s up (regular 4G).
- **CPU** 4× slowdown.
- **Cache** cold — a new browser context per route.
- **Build** the production bundle served by `npm run preview`, not the dev server.

Change any of these and the numbers move. That is why they are in the artifact.

## How the model decides

- A persona walks the stages in order and stops at the first stage where it bounces.
- Each stage function reads facts through a lookup that **throws** on an unknown id, so
  a rule cannot quietly read a fact that does not exist.
- Severity is the modelled share of persona *reach* affected (0–100). Reach is a
  judgement about how many people a persona speaks to, written as a number a reader can
  argue with. It is **not** a population measure and not a probability of anything.
- Arrival channels are modelled as available (`mentor/teacher`, `github/communities`)
  or unproven (`search:`, app stores). Nothing in this build demonstrates that people
  find the product through search, so the model does not assume they do — that single
  decision costs the study four of its fourteen personas.
- Evidence is cited, not summarised: every finding and every stage carries the fact
  ids behind it, and the run **fails** if any cited id is missing from the sheet. Two
  ids in round 1 resolved to nothing; that is why the check exists.

## What the model can and cannot claim

Can: which of the product's own claims are legible on a real screen; where friction
sits between arrival and a personal answer; which defect costs the most modelled reach;
which fix removes which objection; and what moved between two measured builds.

Cannot: whether people will use this. It has no demand model, no market, no
competition, no retention curve and no real users. A persona that "would come back"
is a sentence written by a rule that was written by the author of the product. Treat
the *facts* as evidence and the *personas* as an argument you are invited to change
in code.

## Re-running

```bash
npm run preview            # serve the built app (or: npm run dev with BASE_URL=http://127.0.0.1:5173)
npm run audience           # measure → simulate → report
```

`npm run audience:measure` alone re-measures and rewrites
`tools/audience/measured-facts.json`; `npm run audience:simulate` alone re-simulates
from the existing sheet and archives a new round. The measurement needs the preview
server up, and takes a couple of minutes.

## Honesty rules this file is bound by

1. No invented real-user evidence: nothing here is described as a survey, an
   interview, a review or a metric from production.
2. No false attribution: this is a re-implementation of MiroFish's *method*, not
   MiroFish, and it is never presented as LLM-driven.
3. Synthetic personas are never presented as people. Every quote in the study is
   labelled as what a rule said, not what somebody said.
4. The fact sheet is a snapshot of one build under declared conditions, and the study
   says so in its own caveats rather than in a footnote somebody else wrote.


