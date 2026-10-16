# Audience simulation — round 4

> **This is a model, not user research.** Fourteen personas with declared parameters
> were run through a seven-stage funnel against facts measured from this build. No
> real person was observed, surveyed or interviewed. It cannot tell you whether
> people will use the product; it can tell you which of your own claims are legible,
> where the friction is, and which stated assumption drives which result. The
> honesty rules of this repository apply to this document as well: every number below
> is either measured (and re-runnable with `npm run audience`) or explicitly labelled
> as a modelled weight.

Method: the pipeline is MiroFish's (seed extraction → persona generation →
simulation → report agent), with one substitution — the LLM agents are replaced by
deterministic predicates over a measured fact sheet, because this project has no AI
key and because a reaction you cannot audit is a reaction you cannot act on. What is
kept: the persona schema (`OasisAgentProfile`: name, bio, age, profession, interests,
social reach). What is lost: emergence. Nothing here models a review thread changing
somebody's mind. See [tools/audience/README.md](../tools/audience/README.md).

Measured: **2026-10-14T08:04:52.591Z** · base URL `http://127.0.0.1:4173` · conditions:
40 ms latency, 10 Mbit/s down / 3 Mbit/s up (regular 4G); 4× CPU slowdown; cold — a new browser context per route, nothing cached.

## Summary

6 of 14 modelled personas reach the end of the funnel with a plan they would keep; 8 leave at a named stage, most of them before the product itself is even reached. The single most expensive defect is not in the engine: it is that the route from the front page to a personal answer is longer than the patience of the people who need it most.

## The answer to "who is the audience", from the model

| Segment | Survives | Modelled condition for staying |
| --- | --- | --- |
| Has never studied any of it (wants order, not a catalogue) | 0/5 — none | must see the first step and the whole-route estimate without an account, on their device and connection |
| Working engineer in transition (wants a delta, not a syllabus) | 2/3 — mech-engineer-switching, self-taught-skeptic | must get a delta computed from their own ratings, with the ordering inspectable |
| Specialist or assessor judging the tool itself | 4/6 — architect-specialist, bootcamp-instructor, grad-student-ml, tech-writer-amplifier | must be able to re-derive the numbers, and must find nothing overclaimed |

## Where journeys ended

| Stage | Personas that left | Who |
| --- | --- | --- |
| arrives | 4 | career-changer-teacher, ld-manager-team, parent-limited-hours, reentry-career-break |
| first-five-seconds | 1 | slow-network-student |
| understands-what-it-is | 0 | — |
| sees-it-is-for-them | 1 | screen-reader-user |
| trusts-it-enough-to-try | 0 | — |
| reaches-a-real-answer | 2 | school-student-phone, working-dev-cloud |
| reasons-to-come-back *(survived)* | 6 | mech-engineer-switching, architect-specialist, self-taught-skeptic, bootcamp-instructor, grad-student-ml, tech-writer-amplifier |

## Weaknesses, ranked by modelled severity

### 1. The route from the front page to a personal answer is longer than the patience of the people who need it most

*Severity 64 (modelled: share of persona reach affected) · costs 8 persona(s): school-student-phone, mech-engineer-switching, working-dev-cloud, architect-specialist, self-taught-skeptic, bootcamp-instructor, grad-student-ml, tech-writer-amplifier*

Measured: 3, against a zero-interaction answer once the person reaches the gap screen. The friction is entirely in the path, not in the product.

**Fix:** Point the primary action straight at the answer; keep guided onboarding as the secondary path.

*Evidence:* `value.clicksLandingToAnswer`, `value.interactionsToAnswer`, `landing.firstCta`

### 2. Most modelled personas have no measured way to arrive at all

*Severity 25 (modelled: share of persona reach affected) · costs 4 persona(s): career-changer-teacher, ld-manager-team, parent-limited-hours, reentry-career-break*

4 of 14 personas arrive only through channels nothing in this build demonstrates: search indexing, an app store, or social reach. The product can be excellent and still be used by nobody, because nothing here creates demand.

**Fix:** Treat distribution as a product feature: a hosted demo on a real domain, a public repository with the run instructions, and presence where these people already ask the question.

*Evidence:* `value.landingExampleNumbers`

### 3. Controls below the 36 px target the rest of the app already meets

*Severity 20 (modelled: share of persona reach affected) · costs 3 persona(s): school-student-phone, bootcamp-instructor, screen-reader-user*

Measured: 22 interactive elements under 36 px in the first screen at 1440×900, while the 360 px layout passes the existing suite. The inconsistency is in the desktop chrome, not in a component library.

**Fix:** Raise header and first-screen controls to the same minimum height used elsewhere.

*Evidence:* `a11y.landingSmallTargets`, `a11y.mobileTargets`

### 4. The hero leads with the abstraction, not the outcome

*Severity 10 (modelled: share of persona reach affected) · costs 2 persona(s): school-student-phone, mech-engineer-switching*

The measured headline is "Plan an engineering path as a graph, not a checklist" and the longest paragraph above the fold explains that the 3D scene is not live data. Both are true and neither is what a stranger needs first: what it is, who it is for, and what an answer looks like.

**Fix:** Rewrite the first screen as: outcome, audience, one real number, one action.

*Evidence:* `landing.h1`, `landing.firstScreen`

### 5. A metered connection pays for a 3D hero it did not ask for

*Severity 5 (modelled: share of persona reach affected) · costs 1 persona(s): slow-network-student*

Measured: 497 of script and a 2048 ms LCP on a 1.6 Mbit/s link. Nothing about the planning answer needs the scene; the scene is the most expensive part of the first impression.

**Fix:** Detect save-data or an effective 2G/3G connection and render the static hero, keeping every number identical.

*Evidence:* `perf.landingJsKB`, `perf.landingLcpSlow`


## Strengths, with the same evidence standard

### A personal answer with zero interactions and no account

*Severity 64 (modelled) · carried by 8 persona(s): school-student-phone, mech-engineer-switching, working-dev-cloud, architect-specialist, self-taught-skeptic, bootcamp-instructor, grad-student-ml, tech-writer-amplifier*

Measured: with a career in the URL: 0 — bare /gaps: 0 interactions before the delta panel renders, in a fresh browser context with no session. Almost every competitor puts a form between the visitor and this moment.

*Evidence:* `value.interactionsToAnswer`, `value.answerNeedsAccount`

### The absence of marketing is itself a credential with the sceptics

*Severity 64 (modelled) · carried by 8 persona(s): school-student-phone, mech-engineer-switching, working-dev-cloud, architect-specialist, self-taught-skeptic, bootcamp-instructor, grad-student-ml, tech-writer-amplifier*

Measured and enforced by tests: no fabricated social proof, a strict CSP actually enforced in the browser, and a page that names its own limits. The personas with the highest reach are the ones who reward this.

*Evidence:* `trust.noFakeSocialProof`, `trust.csp`, `product.dataIsBundled`

### Works offline, which is rare and decisive for a real subset

*Severity 8 (modelled) · carried by 1 persona(s): self-taught-skeptic*

Measured by the existing suite: the shell and the analysis survive with the network cut. For a student on a metered phone this is not a checkbox, it is the reason the plan is still there tomorrow.

*Evidence:* `offline.shell`


## Objections the personas actually raised, and what would remove each

| Objection | Personas | Concrete fix |
| --- | --- | --- |
| The first line sells the architecture ("as a graph") rather than the outcome | 2 — school-student-phone, mech-engineer-switching | Lead the hero with the outcome in the visitor's words ("what to learn first, and how long the whole thing takes"), keeping "graph" for the explanation underneath. |
| The primary call to action goes to onboarding rather than to the answer | 4 — school-student-phone, mech-engineer-switching, working-dev-cloud, self-taught-skeptic | Make the first action "show me the answer" (deep link into the gap view with a default career) and keep the guided setup as the second option. |
| Nearly half a megabyte of JavaScript before the page is useful, on connections people pay for | 1 — slow-network-student | Skip the 3D hero entirely when the browser reports save-data or a 2G/3G effective connection type, and serve the same copy from a static first paint. |
| There is no measured path by which strangers arrive; search and store channels are assumptions | 4 — career-changer-teacher, ld-manager-team, parent-limited-hours, reentry-career-break | Publish where the audience already is (a repository, a hosted demo behind a real domain, communities), and treat "discoverable" as an unverified claim until something measures it. |
| Dozens of controls below the 36 px target size in the first screen | 3 — school-student-phone, bootcamp-instructor, screen-reader-user | Bring header and first-screen controls up to the same 36 px minimum the rest of the app already uses. |

## What changed since the previous round

Round 3 → round 4.

- Survivors: 6 → 6
- Findings removed by the change: none
- Findings newly surfaced: none
- Measured facts that moved: `perf.landingLcpDesktop`, `perf.landingLcpSlow`, `perf.gapsLcpDesktop`, `a11y.reducedMotion`

### What moved, fact by fact

| Fact | Before | After |
| --- | --- | --- |
| `perf.landingLcpDesktop` | 396 | 388 |
| `perf.landingLcpSlow` | 2052 | 2048 |
| `perf.gapsLcpDesktop` | 504 | 492 |
| `a11y.reducedMotion` | false | true |

## The personas and their runs

| Persona | Device | Patience / click budget | Skepticism | Outcome | Modelled reach |
| --- | --- | --- | --- | --- | --- |
| Ananya, 16 — Year 11 student, physics and maths | mobile | 8s / 2 clicks | low | left at **reaches-a-real-answer** | 0.30 |
| Marta, 45 — Secondary school teacher, retraining into data analysis | desktop | 25s / 4 clicks | high | left at **arrives** | 0.40 |
| Deepak, 28 — Mechanical design engineer, 5 years, moving towards software | desktop | 20s / 3 clicks | medium | survived (with reservations) | 0.50 |
| Tomasz, 34 — Backend developer, 9 years, Kubernetes-curious | desktop | 10s / 2 clicks | high | left at **reaches-a-real-answer** | 0.60 |
| Priya, 41 — Principal engineer, security specialism | desktop | 40s / 6 clicks | high | survived (with reservations) | 0.80 |
| Emeka, 19 — First-year engineering student, shared 1.5 Mbit/s connection | slow-mobile | 12s / 3 clicks | medium | left at **first-five-seconds** | 0.40 |
| Jonas, 30 — Self-taught developer, no degree | desktop | 15s / 3 clicks | high | survived | 0.70 |
| Ravi, 38 — Bootcamp instructor, 300 students a year | desktop | 30s / 5 clicks | medium | survived (with reservations) | 0.90 |
| Sofia, 52 — Learning and development manager, 400-engineer company | desktop | 45s / 8 clicks | medium | left at **arrives** | 0.85 |
| Wei, 26 — MSc student, machine learning | desktop | 25s / 5 clicks | high | survived (with reservations) | 0.50 |
| Grace, 33 — Part-time nurse, 5 hours a week to study cybersecurity | mobile | 12s / 3 clicks | medium | left at **arrives** | 0.40 |
| Daniel, 24 — Computer science undergraduate, screen reader user | desktop | 30s / 6 clicks | high | left at **sees-it-is-for-them** | 0.50 |
| Hannah, 36 — Technical writer and newsletter author | desktop | 60s / 10 clicks | high | survived (with reservations) | 1.00 |
| Yusuf, 39 — Former systems administrator, three years out of work | desktop | 20s / 4 clicks | medium | left at **arrives** | 0.45 |

## Every run, in the persona's own voice

### Ananya — No — I left at "reaches-a-real-answer".

> Wants to build robots eventually. Studies on a phone because the family laptop is shared. Finds every "learn to code" site overwhelming and closes the tab when a page asks her to sign up.

Goal: Find out whether a robotics career is even reachable from where she is, and what the very first step is.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (word of mouth from a teacher)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **hesitate**: ""Plan an engineering path as a graph, not a checklist" — a graph is how you built it, not what I get. I had to read three lines to find out it plans a career." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **hesitate**: "22 controls in the first screen are smaller than a fingertip. For me that is not a detail, it is the difference between using it and not." _(facts: a11y.landingUnnamedControls, a11y.landingSmallTargets, a11y.htmlLang, a11y.imagesWithoutAlt, a11y.reducedMotion)_
  - `trusts-it-enough-to-try` — **pass**: "No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring." _(facts: value.landingExampleNumbers, trust.noFakeSocialProof, product.provenance, value.answerNeedsAccount)_
  - `reaches-a-real-answer` — **bounce**: "Once I am on the right screen it answers instantly — but getting there cost me 3 clicks, and I give a new site 2." _(facts: value.clicksLandingToAnswer, value.interactionsToAnswer, landing.firstCta)_

Would come back if: Lead the hero with the outcome in the visitor's words ("what to learn first, and how long the whole thing takes"), keeping "graph" for the explanation underneath. Make the first action "show me the answer" (deep link into the gap view with a default career) and keep the guided setup as the second option. Bring header and first-screen controls up to the same 36 px minimum the rest of the app already uses.

### Marta — No — I left at "arrives".

> Twenty years in a classroom. Doing this at night after her children sleep. Has been burned by a paid bootcamp that promised a job in six months and delivered slideshows.

Goal: A believable order of operations and an honest time estimate she can plan her evenings around.

  - `arrives` — **bounce**: "I only arrive through search: how long to retrain as a data analyst, and nothing in this build shows that path exists." _(no measurement: a structural judgement about arrival)_

Would come back if: Publish where the audience already is (a repository, a hosted demo behind a real domain, communities), and treat "discoverable" as an unverified claim until something measures it.

### Deepak — Probably — I would use it, but with 1 reservation I would complain about first.

> Good at tolerances and drawings, writes the occasional macro. Wants to move to a software role without starting from zero and resents being told to "just learn Python".

Goal: Find out what of his existing knowledge transfers and what the actual delta to a software role is.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (github / technical communities)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **hesitate**: ""Plan an engineering path as a graph, not a checklist" — a graph is how you built it, not what I get. I had to read three lines to find out it plans a career." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **pass**: "The first button says guest, no account — and zero clicks later I get my own answer. Fine, I am in." _(facts: value.interactionsToAnswer, landing.firstCta)_
  - `trusts-it-enough-to-try` — **pass**: "No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring." _(facts: value.landingExampleNumbers, trust.noFakeSocialProof, product.provenance, value.answerNeedsAccount)_
  - `reaches-a-real-answer` — **pass**: "3 clicks from the front page to my own answer, and then it just appears. That is the whole reason I stayed." _(facts: value.clicksLandingToAnswer, value.interactionsToAnswer, landing.firstCta)_
  - `reasons-to-come-back` — **pass**: "The roadmap and progress are mine, they work offline, and they survived me closing the tab." _(facts: offline.shell, value.roadmapFirstScreen, value.answerNeedsAccount)_

Would come back if: Lead the hero with the outcome in the visitor's words ("what to learn first, and how long the whole thing takes"), keeping "graph" for the explanation underneath. Make the first action "show me the answer" (deep link into the gap view with a default career) and keep the guided setup as the second option.

### Tomasz — No — I left at "reaches-a-real-answer".

> Ships on a deadline. Refuses to sit through a video course and closes anything that greets him with a marketing carousel. Judges a tool in the first screen.

Goal: See whether the graph agrees with his own sense of what he is missing for a cloud role.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (github / technical communities)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **pass**: "One screen, and I knew what it was and roughly what I would get." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **hesitate**: "A dependency-ordered plan is exactly the right shape. Whether I trust the order is another question — I want to see one answer before I believe the method." _(facts: product.provenance, trust.csp, value.landingExampleNumbers)_
  - `trusts-it-enough-to-try` — **pass**: "No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring." _(facts: value.landingExampleNumbers, trust.noFakeSocialProof, product.provenance, trust.csp, value.answerNeedsAccount, value.answerNeedsAccount, product.dataIsBundled)_
  - `reaches-a-real-answer` — **bounce**: "Once I am on the right screen it answers instantly — but getting there cost me 3 clicks, and I give a new site 2." _(facts: value.clicksLandingToAnswer, value.interactionsToAnswer, landing.firstCta)_

Would come back if: Make the first action "show me the answer" (deep link into the gap view with a default career) and keep the guided setup as the second option.

### Priya — Probably — I would use it, but with 1 reservation I would complain about first.

> Runs reviews, mentors six people, thinks in dependency graphs already. Sceptical of anything that claims to know her own gaps. Will check whether the numbers can be audited before she repeats them to anyone.

Goal: Test the tool on a field she does not own, and see if the ordering logic survives contact with her judgement.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (github / technical communities, word of mouth from a mentor)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **pass**: "One screen, and I knew what it was and roughly what I would get." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **hesitate**: "A dependency-ordered plan is exactly the right shape. Whether I trust the order is another question — I want to see one answer before I believe the method." _(facts: product.provenance, trust.csp, value.landingExampleNumbers)_
  - `trusts-it-enough-to-try` — **pass**: "No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring." _(facts: value.landingExampleNumbers, trust.noFakeSocialProof, product.provenance, trust.csp, value.answerNeedsAccount, product.dataIsBundled)_
  - `reaches-a-real-answer` — **pass**: "3 clicks from the front page to my own answer, and then it just appears. That is the whole reason I stayed." _(facts: value.clicksLandingToAnswer, value.interactionsToAnswer, landing.firstCta)_
  - `reasons-to-come-back` — **pass**: "The roadmap and progress are mine, they work offline, and they survived me closing the tab." _(facts: offline.shell, value.roadmapFirstScreen, value.answerNeedsAccount)_

### Emeka — No — I left at "first-five-seconds".

> Pays for a data bundle by the gigabyte. Every megabyte is a decision. Studies in a browser with five other tabs closed to save memory.

Goal: Get a usable answer without spending his bundle on it.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (word of mouth from a teacher)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **bounce**: "That is 497 KB of JavaScript before the page is even useful — I budget my data in weeks, not gigabytes." _(facts: perf.landingLcpSlow, perf.landingJsKB, perf.entryBundleKB)_

Would come back if: Skip the 3D hero entirely when the browser reports save-data or a 2G/3G effective connection type, and serve the same copy from a static first paint.

### Jonas — Yes — I would use this, and I would tell someone about it.

> Hates hand-holding and hates "AI career coach" language more. Will deliberately try to break the tool and will publish a verdict about it either way.

Goal: Work out whether this is a real graph computation or a thin wrapper around a chatbot.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (github / technical communities)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **pass**: "One screen, and I knew what it was and roughly what I would get." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **pass**: "It keeps working when my connection drops. That is not a nice-to-have where I live." _(facts: offline.shell)_
  - `trusts-it-enough-to-try` — **pass**: "No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring." _(facts: value.landingExampleNumbers, trust.noFakeSocialProof, product.provenance, trust.csp, value.answerNeedsAccount, value.answerNeedsAccount, product.dataIsBundled)_
  - `reaches-a-real-answer` — **pass**: "3 clicks from the front page to my own answer, and then it just appears. That is the whole reason I stayed." _(facts: value.clicksLandingToAnswer, value.interactionsToAnswer, landing.firstCta)_
  - `reasons-to-come-back` — **pass**: "The roadmap and progress are mine, they work offline, and they survived me closing the tab." _(facts: offline.shell, value.roadmapFirstScreen, value.answerNeedsAccount)_

Would come back if: Make the first action "show me the answer" (deep link into the gap view with a default career) and keep the guided setup as the second option.

### Ravi — Probably — I would use it, but with 1 reservation I would complain about first.

> Spends his weekends answering the same "what should I learn first" question in DMs. Looking for something he can hand students that will not waste their first month.

Goal: A credible, self-serve starting point he can vouch for, and a way to see a student's gap without asking them 40 questions.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (github / technical communities)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **pass**: "One screen, and I knew what it was and roughly what I would get." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **hesitate**: "22 controls in the first screen are smaller than a fingertip. For me that is not a detail, it is the difference between using it and not." _(facts: a11y.landingUnnamedControls, a11y.landingSmallTargets, a11y.htmlLang, a11y.imagesWithoutAlt, a11y.reducedMotion)_
  - `trusts-it-enough-to-try` — **pass**: "No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring." _(facts: value.landingExampleNumbers, trust.noFakeSocialProof, product.provenance, value.answerNeedsAccount)_
  - `reaches-a-real-answer` — **pass**: "3 clicks from the front page to my own answer, and then it just appears. That is the whole reason I stayed." _(facts: value.clicksLandingToAnswer, value.interactionsToAnswer, landing.firstCta)_
  - `reasons-to-come-back` — **pass**: "The roadmap and progress are mine, they work offline, and they survived me closing the tab." _(facts: offline.shell, value.roadmapFirstScreen, value.answerNeedsAccount)_

Would come back if: Bring header and first-screen controls up to the same 36 px minimum the rest of the app already uses.

### Sofia — No — I left at "arrives".

> Buys tools for other people. Needs to know what data leaves the building, whether it works without internet for plants with no Wi-Fi, and whether her juniors will actually open it.

Goal: Evaluate whether to put this in front of her engineers and apprentices.

  - `arrives` — **bounce**: "I only arrive through search: engineering skills gap assessment tool, and nothing in this build shows that path exists." _(no measurement: a structural judgement about arrival)_

Would come back if: Publish where the audience already is (a repository, a hosted demo behind a real domain, communities), and treat "discoverable" as an unverified claim until something measures it.

### Wei — Probably — I would use it, but with 1 reservation I would complain about first.

> Comfortable with graphs and sceptical of anything that has not thought about prerequisites. Wants to compare the tool's ordering against the course catalogue he is currently being taught from.

Goal: Find holes in the tool's reasoning, or borrow its structure for a study plan.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (github / technical communities)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **pass**: "One screen, and I knew what it was and roughly what I would get." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **hesitate**: "A dependency-ordered plan is exactly the right shape. Whether I trust the order is another question — I want to see one answer before I believe the method." _(facts: product.provenance, trust.csp, value.landingExampleNumbers)_
  - `trusts-it-enough-to-try` — **pass**: "No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring." _(facts: value.landingExampleNumbers, trust.noFakeSocialProof, product.provenance, trust.csp, value.answerNeedsAccount, product.dataIsBundled)_
  - `reaches-a-real-answer` — **pass**: "3 clicks from the front page to my own answer, and then it just appears. That is the whole reason I stayed." _(facts: value.clicksLandingToAnswer, value.interactionsToAnswer, landing.firstCta)_
  - `reasons-to-come-back` — **pass**: "The roadmap and progress are mine, they work offline, and they survived me closing the tab." _(facts: offline.shell, value.roadmapFirstScreen, value.answerNeedsAccount)_

### Grace — No — I left at "arrives".

> Fits study into gaps between shifts. Has started four courses and finished none, because none of them told her which parts actually mattered for the job she wants.

Goal: A plan that survives a schedule that falls apart twice a month.

  - `arrives` — **bounce**: "I only arrive through search: cybersecurity career change with no experience, and nothing in this build shows that path exists." _(no measurement: a structural judgement about arrival)_

Would come back if: Publish where the audience already is (a repository, a hosted demo behind a real domain, communities), and treat "discoverable" as an unverified claim until something measures it.

### Daniel — No — I left at "sees-it-is-for-them".

> Has abandoned more study tools than he has finished, most of them because a canvas, an unlabelled control or a hover-only interaction made the page unusable with a keyboard and a screen reader.

Goal: A career plan he can actually navigate.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (word of mouth from a mentor)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **pass**: "One screen, and I knew what it was and roughly what I would get." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **bounce**: "22 controls in the first screen are smaller than a fingertip. For me that is not a detail, it is the difference between using it and not." _(facts: a11y.landingUnnamedControls, a11y.landingSmallTargets, a11y.htmlLang, a11y.imagesWithoutAlt, a11y.reducedMotion)_

Would come back if: Bring header and first-screen controls up to the same 36 px minimum the rest of the app already uses.

### Hannah — Probably — I would use it, but with 1 reservation I would complain about first.

> Writes about developer tools for 18,000 subscribers. Does not recommend anything she has not used end to end, and will say precisely why if she declines.

Goal: Decide whether to write about this, and what the honest angle would be.

  - `arrives` — **pass**: "Someone would have to hand me this — I would not find it on my own (github / technical communities)." _(no measurement: a structural judgement about arrival)_
  - `first-five-seconds` — **pass**: "It was there in 0.4 s. Nothing to complain about." _(facts: perf.landingLcpDesktop, perf.landingJsKB)_
  - `understands-what-it-is` — **pass**: "One screen, and I knew what it was and roughly what I would get." _(facts: landing.firstScreen, landing.h1)_
  - `sees-it-is-for-them` — **hesitate**: "A dependency-ordered plan is exactly the right shape. Whether I trust the order is another question — I want to see one answer before I believe the method." _(facts: product.provenance, trust.csp, value.landingExampleNumbers)_
  - `trusts-it-enough-to-try` — **pass**: "No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring." _(facts: value.landingExampleNumbers, trust.noFakeSocialProof, product.provenance, trust.csp, value.answerNeedsAccount, product.dataIsBundled)_
  - `reaches-a-real-answer` — **pass**: "3 clicks from the front page to my own answer, and then it just appears. That is the whole reason I stayed." _(facts: value.clicksLandingToAnswer, value.interactionsToAnswer, landing.firstCta)_
  - `reasons-to-come-back` — **pass**: "The claim I can check myself is the interesting story: numbers I can re-derive, and a page that tells me what it does not do." _(facts: offline.shell, value.roadmapFirstScreen, value.answerNeedsAccount, product.provenance)_

### Yusuf — No — I left at "arrives".

> Left the industry for family reasons, now re-entering. His skills are real but four years stale and he does not know which parts employers still care about.

Goal: Work out the shortest honest route back to employability.

  - `arrives` — **bounce**: "I only arrive through search: returning to IT after a career break, and nothing in this build shows that path exists." _(no measurement: a structural judgement about arrival)_

Would come back if: Publish where the audience already is (a repository, a hosted demo behind a real domain, communities), and treat "discoverable" as an unverified claim until something measures it.

## The measured fact sheet this ran on

| Fact | What it is | Measured value | Source |
| --- | --- | --- | --- |
| `landing.firstScreen` | What a stranger reads above the fold on the landing page | Engineering career navigator Plan an engineering path as a graph, not a checklist Explore engineering careers as a knowledge graph: trace prerequisit… | audience-run |
| `landing.firstCta` | The first interactive element in the landing first screen | Start (guest, no account) → /onboarding | audience-run |
| `landing.h1` | Landing page headline | Plan an engineering path as a graph, not a checklist | audience-run |
| `landing.mobileFirstScreen` | What a phone user reads above the fold (360×740) | Engineering career navigator Plan an engineering path as a graph, not a checklist Explore engineering careers as a knowledge graph: trace prerequisit… | audience-run |
| `landing.slowFirstScreen` | What a phone user on a 1.6 Mbit/s link reads above the fold | Engineering career navigator Plan an engineering path as a graph, not a checklist Explore engineering careers as a knowledge graph: trace prerequisit… | audience-run |
| `perf.landingLcpDesktop` | Largest Contentful Paint, landing page, 4G + 4× CPU slowdown, cold cache | 388 | audience-run |
| `perf.landingLcpSlow` | Largest Contentful Paint on a slow phone link | 2048 | audience-run |
| `perf.landingJsKB` | Script bytes transferred before the landing page settles | 497 | audience-run |
| `perf.gapsLcpDesktop` | Largest Contentful Paint on the gap page | 492 | audience-run |
| `value.interactionsToAnswer` | Interactions needed before a stranger sees their own answer | with a career in the URL: 0 — bare /gaps: 0 | audience-run |
| `value.clicksLandingToAnswer` | Interactions from the landing page to a stranger's own answer, following the page's own CTAs | 3 | audience-run |
| `value.landingExampleNumbers` | Concrete worked numbers shown on the landing page (hours, weeks, "skill(s) to go") | above the fold: 2 — anywhere on the page: 6 — example found: 410–1,030 h | audience-run |
| `value.answerNeedsAccount` | Whether the first real answer requires an account | false | audience-run |
| `value.roadmapFirstScreen` | What the roadmap screen shows before any account exists | Personalised roadmap Roadmap: Aerospace engineer Scheduled in dependency order, sized to the hours you actually have. Every estimate is a curriculum … | audience-run |
| `value.libraryCount` | How many resources the library exposes with outcomes and limits | count not in first screen | audience-run |
| `value.mentorFirstScreen` | What the mentor screen offers without an AI key | Graph-grounded mentor Ask about the graph, get answers that cite it Answers are built from the same knowledge graph the rest of the app uses: specifi… | audience-run |
| `offline.shell` | Works offline after the first visit | true | audience-run |
| `a11y.reducedMotion` | Prefers-reduced-motion is honoured: no 3D canvas, no tilt transform, and the flag is declared | true | audience-run |
| `trust.noFakeSocialProof` | Social-proof claims on the landing page that this build cannot back up (testimonials, ratings, user counts, stars) | 0 | audience-run |
| `trust.settingsFirstScreen` | What the settings screen tells a stranger about their data | Settings Accessibility, account and your data Nothing here is required to use the app. Every control works offline and takes effect immediately. Appe… | audience-run |
| `a11y.landingSmallTargets` | Undersized interactive targets in the landing first screen (desktop) | 22 | audience-run |
| `a11y.landingUnnamedControls` | Interactive elements in the landing first screen with no accessible name | 0 | audience-run |
| `a11y.htmlLang` | Language declared on the document | en | audience-run |
| `a11y.imagesWithoutAlt` | Images rendered anywhere without alt text | 0 | audience-run |
| `trust.consoleErrors` | Console errors across every route in a cold browser | 0 | audience-run |
| `product.dataIsBundled` | Whether the graph shown is a live database or a bundled curriculum | true | source-tree |
| `product.provenance` | Whether every resource link, hour estimate and outcome is documented | true | source-tree |
| `perf.entryBundleKB` | Main JavaScript bundle shipped to every visitor | 1004 | source-tree |
| `a11y.mobileTargets` | No undersized tap targets or overflow at 360 px | true | browser-suite |
| `trust.csp` | A strict Content-Security-Policy is actually enforced in the browser | true | browser-suite |

## Caveats

- Model, not research: 14 personas with declared parameters, deterministic rules over 30 measured facts. No real people were observed.
- Severity and reach are modelled weights, not measurements of any population.
- The fact sheet is a snapshot of one build under declared throttling; a different device, region or build moves the numbers.
- Six personas have no measured arrival channel, so their journeys are conditional on an assumption that they get there at all.

## How to re-run

```bash
npm run preview          # serve the build (or npm run dev, with BASE_URL=http://127.0.0.1:5173)
npm run audience         # measure → simulate → report, writing this document
```

Every round is archived under `tools/audience/rounds/`, so the diff above is
reproducible rather than remembered. The persona parameters live in
`scripts/audience/personas.ts`; the rules live in `scripts/audience/simulate.ts`; the
measurements live in `scripts/audience/measure.ts`. Argue with any of them, change
one number, and re-run — a model you cannot disagree with in code is a horoscope.


