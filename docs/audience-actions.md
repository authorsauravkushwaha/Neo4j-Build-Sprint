# What was done about the audience study

The study itself is generated: `npm run audience` rewrites
[audience-simulation.md](audience-simulation.md) from a fresh measurement of the
running build, so any hand-written note in that file would be destroyed by the next
run. This file is the hand-maintained half: what was actually done about each
finding, what is still open, and why.

Round 4 is the current round (14 personas, 30 measured facts, 11 route views). The
reference for what each fact means is `tools/audience/measured-facts.json`; the
method and its declared limits are in `tools/audience/README.md`.

## Fixed

| Finding | What changed | Evidence that it is fixed |
| --- | --- | --- |
| **Round 1, top severity — the landing page promised a plan but never showed one** | The landing page now runs the real engine on two stated profiles and prints its own output, with links into the skills it names | Browser suite §13: from-zero `13 skill(s) to go: 2 startable now, 3 gate(s) unblock 9, longest chain 5 deep.` and in-field `10 … 4 startable … chain 3`; landing and `/gaps` agree **number for number**; no console errors |
| **The in-app reduce-motion switch did nothing (`a11y.reducedMotion` false)** | The switch wrote `data-reduced-motion` while the scene and the stylesheet read `data-motion`. The writer was corrected, the OS preference and the switch now both feed the same attribute, and an OS-change listener re-applies it | `a11y.reducedMotion` is `true` in round 4 (`data-motion="reduced"`, 0 canvases, 0 tilted elements). Browser suite §15 proves the *stored switch alone* does it, with no OS preference involved; six unit tests pin writer, reader, stylesheet, OS reflection, and the retired spelling |

## Open, with the next step named

| Finding | Why it is not fixed yet | What fixing it would take |
| --- | --- | --- |
| **3 clicks from the front page to a personal answer** (severity 64, the top modelled finding; the trace records the refused attempt and the successful one) | The primary call to action deliberately enters guided onboarding — that screen is where a person's *own* ratings come from, and it is the only path to a delta computed from them. The landing page already carries the zero-account answer above the fold (the worked example). Making the hero's first action "show me the answer" would trade the guided path for a default-career answer | One extra hero link straight to `/gaps` (keeping onboarding as the secondary path), then a re-run of `npm run audience` so the click count is *re-measured* rather than asserted. Until that run exists, this stays a modelled recommendation, not an improvement |
| **No measured arrival channel** (4 personas can only arrive through channels this build does not demonstrate) | Distribution is not a code property, and this environment can neither host a real domain nor index a search result. Nothing here creates demand, and claiming otherwise would be exactly the kind of unverifiable claim this project refuses | A hosted demo on a real domain, a public repository with these run instructions, and answers in the places these people already ask. All three are *outside* the repository's evidence, so they must be reported as assumptions until something measures them |
| **22 interactive elements under 36 px in the desktop first screen** — measured, while the 360 px layout already meets the minimum | The count is real and the inconsistency is in the header/first-screen chrome, not in a component. A rushed pass would move every screenshot and invalidate the round-4 measurement mid-report | Raise the header and first-screen controls to the 36 px floor the rest of the app uses, then re-measure `a11y.landingSmallTargets` and re-run the browser suite |
| **The hero leads with the abstraction** ("as a graph, not a checklist") | The worked example now answers the "what do I get" question directly under the hero, but the headline is unchanged: rewriting the first line is a copy decision, and the current line is *true* — the risk is only that it is not first | Rewrite the first screen as outcome → audience → one real number → one action, keeping "graph" for the explanation underneath, and re-measure `landing.firstScreen` |
| **A metered connection pays for a 3D hero it did not ask for** (497 kB of script, 2048 ms LCP on a 1.6 Mbit/s link) | The scene never blocks the copy, and reduce-motion already removes it, but nothing detects save-data or an effective 2G/3G connection | Detect `save-data` / `effectiveType` and render the static hero, keeping every number identical, then re-measure `perf.landingLcpSlow` |

## Out of scope, said plainly

- **Severity and reach are modelled weights**, not population measurements. They rank
  findings inside this model; they are not a forecast of adoption.
- **Nothing in this repository can prove demand.** The study can show where a
  modelled visitor would stop and why; it cannot show that anyone arrives.
- **The personas are not people.** They are declared parameters with deterministic
  rules over measured facts, reproducible from `scripts/audience/personas.ts` and
  `scripts/audience/simulate.ts`.

## Security work in the same period (not from this study)

The injection audit (`npm run verify:injection`) and the CORS fix in
`supabase/functions/_shared/core/http.ts` came from the standing threat list, not
from the audience model; they are recorded in [security.md](security.md) §13. They
are listed here only so the two evidence trails are not confused with each other:
the audience study is a model of reactions, the security suite is a measurement of
the shipped code.


