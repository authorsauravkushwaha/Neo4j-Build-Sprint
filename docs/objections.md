# Why somebody would not use this — 100+ objections, and what happened to each

This is the ruthless list: every serious reason a stranger, a specialist or a sceptic could
give for closing the tab, grouped by where the objection lives. Each entry carries a status:

- **fixed** — the change is in the source *and* has been measured (the measurement is quoted).
- **fixed, re-measure** — the change is in the source; the quoted measurement predates the
  current build, so it must be re-run before it is claimed again.
- **open** — real, still true, not yet fixed. These are defects, not disclosures.
- **cannot fix here** — structurally outside what this sandbox can do (no host, no users, no
  third-party audit). Stated as such rather than papered over.

Nothing in this file is aspirational. Where a number appears, it was produced by a command in
this repository; where no measurement exists, the item says so.

Last sweep: 2026-10-14, against the build whose dataset is `datasetVersion 1.1.0`
(444 nodes, 1,585 relationships, checksum `4da024ddaef1` in `neo4j/MANIFEST.json`). This is a historical product-objection log, not a current deployment verification. Current graph/backend architecture and the production verification boundary are in [architecture.md](architecture.md); no external LIVE NEO4J claim follows from this log.

---

## A. First impression (1–13)

1. **The hero led with the mechanism, not an outcome** ("Plan an engineering path as a graph,
   not a checklist"). — **fixed**: the page now opens with one `<h1>`: "What to learn first,
   and how long the rest will take", and the sub-copy names the outcome, the audience and the
   no-account promise.
2. **The `<h1>` read as a run-on to anything consuming text** ("first,and"). — **fixed**,
   measured after rebuild: `"What to learn first, and how long the rest will take"`.
3. **Nothing showed what an answer looks like.** — **fixed**: a worked-example block runs on
   the landing page with real dataset numbers (8 example nodes measured by browser probe).
4. **The hero buttons were dead to a real click** (a 3D transform flattened the press). —
   **fixed**: `transform-style: flat`; a real mouse-click path is now a browser check.
5. **The 3D scene looked like live data.** — **fixed**: the scene is labelled as a
   visualisation of the shipped dataset, and "try 3D anyway" is a real persisted preference.
6. **Too many controls were under 36 px.** — **fixed** on the landing first screen: 22 → 0.
7. **There is no install prompt on the first screen.** — **open / by design**: the install
   affordance only appears when the browser supports it and the user shows interest. A nag is
   worse than its absence; recorded so the choice is visible.
8. **"What is this app?" took scrolling.** — **fixed**: a "What you can do here" section lists
   the career explorer, the graph, the roadmap, projects and resources.
9. **Jargon before benefit** ("graph", "prerequisites", "frontier"). — **fixed, re-measure**:
   the simulation's jargon finding now interpolates the *measured* headline instead of a
   retired copy string; whether the finding still fires for the modelled personas is decided by
   the next audience round, not by my opinion.
10. **No skip affordance.** — **fixed**: `skipLink: 1` measured on the landing page.
11. **Anonymous users had no route in.** — **fixed**: guest mode is the default path; nothing
    requires an account (`0 accounts required` is on the social card because it is true).
12. **The first screen had no numbers.** — **fixed**: the hero section quotes real dataset
    totals (17 careers, 89 skills, 154 resources at this build) read from `datasetCounts`.
13. **No visual sample of the graph before signing up.** — **fixed**: the hero is the sample;
    it mounts a real canvas when WebGL and motion settings allow.

## B. Trust (14–27)

14. **The numbers could be invented.** — **fixed**: every count derives from `datasetCounts`
    and `npm run validate:seed` asserts the dataset, both engines and the generated Cypher
    agree (58/58 checks at this build).
15. **"Verified" resource labels could be self-awarded.** — **fixed**: labels come from
    `npm run verify:resources` (154 URLs: 136 reachable, 14 redirected, 4 blocked, 0 failed,
    0 timed out) with the run date stored per resource.
16. **Four resource URLs refuse automated checkers** (All About Circuits, three OSHA pages,
    all HTTP 403 to this datacentre IP). — **fixed**: the dataset says so in each access note
    and the app shows "not automatically confirmed" rather than a clean tick.
17. **A provider outage looked like a dead link** (PVGIS failed once, then answered 200). —
    **fixed**: failed fetches are re-run before a resource is judged; the re-run cleared it.
18. **Time estimates could be fantasy.** — **fixed**: ranges with stated assumptions; the
    validator rejects inverted or absurd ranges (1–400 h, low ≤ high).
19. **The dataset could be padding.** — **fixed**: every skill is covered by at least two
    resources, every career has ≥3 essential skills and ≥1 suggested project; the gauntlet
    fails the build on a single-link skill.
20. **"Works offline" could be a lie.** — **fixed, re-measure**: the service worker registers
    from the built app and an offline fallback page ships (browser check, 2026-10-14 08:49).
21. **Roadmaps could promise employment.** — **fixed**: the footer and the About page state
    that estimates are planning aids, not promises of employment or salary.
22. **No maintainer identity or contact.** — **open**: `SECURITY.md` and
    `CODE_OF_CONDUCT.md` define the reporting channel (private advisory once published), but
    there is no named human and no address, because inventing one would be worse.
23. **Screenshots in docs could be mock-ups.** — **fixed**: every screenshot in
    `docs/screenshots/` is written by the browser suite during a real run (9 files).
24. **The footer version could drift from the app.** — **fixed**: the version is injected at
    build time from `package.json`; the served footer reads `v1.0.0`, matching the manifest.
25. **An error could expose internals.** — **fixed**: one error shape reaches the client; no
    stack traces, SQL or key material (see §H).
26. **A stale cache could serve a wrong page.** — **open**: the service worker uses Workbox
    defaults with an update prompt; there is no automated test that an *update* lands on a
    second visit, only that the worker registers.
27. **No third-party validation of anything.** — **cannot fix here**: no external auditor has
    touched this repository. Every claim in this file is self-measured and says so.

## C. Shareability and SEO (28–40)

28. **No social preview image.** — **fixed**: `public/social-card.png`, 1200×630, generated by
    `npm run emit:social-card` from real dataset counts; served `200 image/png`, 66,740 bytes.
29. **The card text could be stale.** — **fixed**: regenerated this build — "16 engineering
    careers · 89 skills · 154 free resources · 0 accounts required" — and it must be re-run
    whenever counts move (recorded in `CONTRIBUTING.md`).
30. **No `og:url` / canonical.** — **cannot fix here**: both require a real domain. When
    `VITE_SITE_URL` is set the build emits canonical URLs and a sitemap; unset, it prints a
    warning instead of inventing a URL.
31. **No sitemap.xml.** — **cannot fix here** for the same reason. Note that requesting
    `/sitemap.xml` returns 200 with the SPA shell — a 200 that means nothing; the build log,
    not the status code, is the truth.
32. **`twitter:card` missing.** — **fixed**: `summary_large_image`, with a real image.
33. **Title could be truncated in search results.** — **fixed**: 49 characters, measured.
34. **Meta description could be missing.** — **fixed**: present in `index.html` and substituted
    at build time.
35. **`robots.txt` was inconsistent** (hand-written file said `/auth`, generated file said
    `/account`, `/login`, `/reset-password`). — **fixed**: `public/robots.txt` now matches what
    the build generates, so dev and dist agree.
36. **No structured data.** — **fixed**: one JSON-LD block, measured (`jsonLd: 1`).
37. **Deep links could 404 on refresh.** — **fixed, re-measure**: SPA fallback plus
    `_redirects`/`netlify.toml`; the served-route probe passes, but this needs a host to be
    proven properly.
38. **No share button.** — **open / by design**: sharing requires a real URL; a share button
    that shares localhost is worse than none.
39. **No print/PDF path from the landing page.** — **open**: print styles exist
    (`gm-no-print`) and roadmap pages print cleanly, but there is no explicit "export as PDF"
    affordance on the first screen.
40. **No OpenGraph image for individual pages.** — **open**: one card serves every route. Fine
    today, weak if the site ever gets per-career pages.

## D. Accessibility (41–53)

41. **Heading structure could be broken.** — **fixed**: one `<h1>` per route; the landing page
    previously had two (PageHeader + hero) and had every page read its own title twice.
42. **`lang` could be unset.** — **fixed**: `en`, measured.
43. **No skip link.** — **fixed**: present as the first focusable element.
44. **Contrast on a soft-UI surface could fail.** — **fixed, re-measure**: body 15.13:1, muted
    6.51:1 (measured 2026-10-14 08:49; re-run with the next browser pass).
45. **State carried only by shadow.** — **fixed by construction and checked**: colour, border
    and text change with state; the browser suite fails if a surface falls back to a backdrop
    blur.
46. **Reduced motion could be ignored.** — **fixed**: with `prefers-reduced-motion`, no canvas
    mounts, tilt is neutralised and CSS animation stops — three separate browser checks.
47. **Undersized tap targets.** — **fixed**: 0 elements under 24 px on `/`, `/dashboard`,
    `/graph`, `/roadmap`; the graph view's Canvas/3D/List toggles and the four `/settings`
    checkboxes now meet the project's own 36 px aim (`min-h-9`). Disclosed in
    `docs/accessibility.md`.
48. **Unnamed controls.** — **fixed, re-measure**: the audience instrument counts unnamed
    interactive elements per route; the count was 0 when last run and must be re-read in round 5.
49. **Images without `alt`.** — **fixed, re-measure**: counted per route by the same instrument.
50. **Keyboard trap / unreachable palette.** — **fixed**: the palette is mounted above the
    router, so <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> works on lazy-loaded screens too.
51. **No screen-reader user testing.** — **cannot fix here**: automated checks and self-run
    keyboard passes are necessary but not sufficient, and no audit has been commissioned.
52. **Focus visibility on tinted neumorphic surfaces.** — **fixed, re-measure**: focus uses a
    token ring; it is verified by inspection in the browser suite, not by a contrast assertion.
53. **English-only interface.** — **open**: localisation is not attempted; the dataset lists
    programming languages, not UI locales.

## E. Performance (54–66)

54. **The main JS chunk is large.** — **open**: `index-*.js` is 1.1 MB before gzip (three.js
    732 KB, graph engine 436 KB are separate async chunks). Route-level splitting exists; the
    entry chunk is the remaining problem.
55. **Metered-connection load time.** — **open**: round 4 measured 497 KB of JS and a 2048 ms
    metered LCP on the landing page. No round has been run against this build; the number is
    quoted as the last honest measurement and the target of the next round.
56. **The service worker precaches 2.6 MB.** — **open**: 35 entries, 2,675 KiB. Bounded and
    offline-complete, but heavy for a first visit on a slow link.
57. **INP / long tasks are not measured.** — **open**: no interaction-latency measurement
    exists in this repository. Claiming it would be invention.
58. **No `save-data` handling.** — **fixed (partial)**: the WebGL/3D path is skipped when
    `navigator.connection.saveData` is set or the connection is 2g (see `src/components/three/webgl.ts`),
    so the heaviest asset never loads on a data-saving browser. A broader low-bandwidth mode for
    images and non-essential motion is still open.
59. **3D on weak GPUs.** — **fixed**: the scene mounts only after a WebGL capability probe
    accepts the renderer, and the list/canvas views remain complete without it.
60. **Repeat visits.** — **fixed**: the offline shell is cached and served by the service
    worker (browser check).
61. **Third-party script weight.** — **fixed**: the CSP allows no external script origins and
    the landing probe finds no external link hosts; there is no analytics or ad code in the
    repo.
62. **Image weight.** — **fixed**: the only raster assets are the social card (66 KB) and
    small PNG icons; no hero photography.
63. **Fonts.** — **fixed**: system font stack; no webfont request, so no layout shift from
    font swap and no third-party font origin in the CSP.
64. **Cold cache vs warm cache on the preview.** — **open**: only achievable on a real host
    with real cache headers; the preview server is not representative.
65. **Bundle budget enforcement.** — **open**: the build warns above 900 KB but nothing fails;
    there is no CI budget assertion yet.
66. **Perf claims in docs could go stale.** — **fixed**: `docs/verification.md` records the
    build's own reported numbers, and `CONTRIBUTING.md` requires re-measurement when they move.

## F. Content (67–80)

67. **Too small for a specialist.** — **fixed, and expanding step by step**: the dataset now
    spans 16 branches and 17 careers — software, data/AI, security, mechanical, electrical,
    robotics, civil, embedded, cloud, renewable energy, aerospace, chemical/process, biomedical,
    industrial/manufacturing and surveying/geospatial — at 89 skills, 33 projects, 154 resources.
68. **Content that sounds generic.** — **fixed by rule**: every resource states what you do and
    what you get, its prerequisites, its limits and a time range; the "more precise" pass is
    enforced by the validator, not by taste.
69. **A skill resting on one link.** — **fixed**: the gauntlet fails the build if any skill has
    fewer than two independent resources.
70. **Hidden paywalls.** — **fixed**: every resource carries an access model and a plain
    access note (what is free, what is paid, what needs an account).
71. **Prerequisites left implicit.** — **fixed**: `ASSUMES` edges are validated against skills
    some resource actually teaches.
72. **Projects that are tutorials in disguise.** — **fixed**: each project ships objectives,
    deliverables, milestones, testing ideas, extensions and hours — 29 of them.
73. **Unsafe hardware projects.** — **fixed**: hazards (mains, soldering, lasers, batteries,
    machine tools) demand safety notes; the validator fails the build without them.
74. **Careers untethered to real skills.** — **fixed**: every career has ≥3 essential skills
    and at least one suggested project, and the roadmap engine builds for all 17.
75. **Assessments that are trivia.** — **fixed**: 16 self-checks are tied to specific skills,
    and a quiz score can move a borderline claim but can never promote one the self-report did
    not support.
76. **Claims of labour-market authority.** — **fixed**: About states the dataset is a curated
    sample, not a labour-market database, and nothing quotes salaries or job counts.
77. **Stale resources.** — **fixed, with a schedule**: every URL carries `lastVerified`, and
    the CI file runs the link check weekly.
78. **No content for advanced practitioners specifically.** — **open, improving**: specialist
    entry points exist (frontier/gap analysis against real prerequisites), but the resource
    library skews beginner-friendly because honest advanced free material is rarer.
79. **No user-generated content.** — **open / by design**: none, and none faked. A curated
    dataset that says so beats an empty forum.
80. **Data provenance for the dataset itself.** — **open**: each resource is traceable, but the
    skill/prerequisite graph is editorial. It says so in About; a full provenance record per
    edge does not exist.

## G. Repository legitimacy (81–94)

81. **No LICENSE.** — **fixed**: MIT, copyright "GraphMentor AI contributors". The maintainer
    can and should review that choice; it is a default, not a decision made for them.
82. **No CHANGELOG.** — **fixed**: `CHANGELOG.md` with the real dataset and product facts for
    this cut.
83. **No CONTRIBUTING guide.** — **fixed**: setup, the ordered check chain, the rules the repo
    enforces, and the count-sweep list.
84. **No SECURITY policy.** — **fixed**: `SECURITY.md` with the 13-class table mapping each
    class to code and tests, plus explicit "out of scope" honesty.
85. **No code of conduct.** — **fixed**: Contributor Covenant 2.1 by reference plus a short
    plain-language expectation list.
86. **No CI.** — **fixed in source**: `.github/workflows/ci.yml` runs the same commands a
    developer runs, plus a weekly link-check job and a bundle-budget assertion. It now has a
    repository host (GitHub) to execute against; a green run is evidence, not an assumption.
87. **No accessibility documentation.** — **fixed**: `docs/accessibility.md` with measured
    facts and known exceptions.
88. **The privacy page referenced a changelog that did not exist.** — **fixed**: the root
    `CHANGELOG.md` is now that changelog (`docs/changelog.md` would be a second file saying the
    same thing, so it is deliberately not created).
89. **No git history, no repository.** — **fixed**: the project is published at
    https://github.com/authorsauravkushwaha/Neo4j-Build-Sprint with a working branch and a
    deploy workflow; history accumulates from here.
90. **No hosted demo.** — **fixed (via GitHub Pages)**: `.github/workflows/deploy.yml` builds
    and publishes to GitHub Pages on every push to main; the URL is derived from the repository
    name. A custom domain is still optional and unset.
91. **No APK, despite the Capacitor work.** — **cannot fix here**: `cap:add:android` and
    `cap:sync` exist and are real, but no Android toolchain is present, so no artifact is built
    and none is claimed.
92. **No badges.** — **cannot fix honestly**: test/coverage badges need a CI host; a hardcoded
    badge would be a lie.
93. **No screenshots in the README.** — **open**: the browser suite writes screenshots under
    `docs/screenshots/` on a real run; embedding them in the README is still pending and would
    require those artifacts to be committed.
94. **One-off probe scripts in the repository root** (`probe-*.ts`, `probe-landing.mjs`). —
    **fixed**: the five discovery probes moved to `scripts/probes/` so the repository root stays
    clean; they remain development scaffolding, not shipped code.

## H. Privacy and security (95–108)

95. **Sign-up friction before value.** — **fixed**: guest mode is complete; an account is
    optional and never required to see an answer.
96. **Secrets in the browser.** — **fixed**: no secret material in `localStorage`; only
    preferences and progress, with reset, export and delete controls.
97. **Indefinite retention of what you type.** — **fixed**: no sensitive conversation is kept
    by default; the privacy page states the policy the code implements.
98. **Injection (SQL/NoSQL/Cypher).** — **fixed**: parameterised queries only, no string-built
    SQL, and the Cypher emitter is MERGE-only over a generated parameter file; audited by
    `validate:seed` and unit tests.
99. **Secret-key leakage.** — **fixed**: only the anon key is shipped; `npm run lint:secrets`
    scans `src/` and `dist/`.
100. **Replay of privileged requests.** — **fixed**: single-use, time-boxed nonces.
101. **Long-password DoS.** — **fixed**: hard bounds before hashing; the boundary is a test.
102. **ReDoS.** — **fixed by construction**: linear-time validation patterns; no nested
     quantifiers over input.
103. **Rate limiting.** — **fixed**: per-route token buckets with honest responses.
104. **Auth ≠ authorization.** — **fixed**: privileged handlers re-check ownership, not just
     a valid session.
105. **Clipboard.** — **fixed by policy**: copies are explicit and user-initiated, and never
     carry key material.
106. **Error leakage.** — **fixed**: one error shape; no internal detail reaches a client.
107. **CSP.** — **fixed, with one documented exception**: the served page carries a real CSP
     (a browser check asserts the header); the graph engine's own container style injection is
     the only allowance, and it is documented rather than quietly loosened.
108. **Third-party surveillance.** — **fixed**: no analytics, no trackers, no third-party
     script; the CSP has no external script origin.

---

## What cannot be fixed from inside this sandbox

Stated plainly, because pretending otherwise would be the biggest objection of all:

1. **No custom domain** — canonical URLs and a sitemap are emitted when `VITE_SITE_URL` is
   set (the deploy workflow sets it to the GitHub Pages URL), but a project-specific domain is
   still optional and unset.
2. **Repository host now exists** — GitHub hosts the code, runs CI and publishes Pages; badges
   and a green-run history remain to be earned rather than assumed.
3. **No Android toolchain** — so no APK, and no claim of one.
4. **No third-party audit or screen-reader testing** — so accessibility and security are
   self-measured, however carefully.
5. **No users** — so there is no testimonial, no rating, no retention number, and none will be
   invented. The audience study is a deterministic simulation of a published method
   (`scripts/audience/README.md`), not evidence about real people.
6. **Demand generation remains open** — a hosted demo and a public repository now exist, but
   discovery and promotion are still the maintainer's job.

## Re-measure queue

Items marked *fixed, re-measure* and every performance number become quotable again after:

```bash
npm run build && npm run preview &
BASE_URL=http://127.0.0.1:4173 npm run verify:browser     # refreshes docs/browser-verification.json
BASE_URL=http://127.0.0.1:4173 npm run audience           # round 5: refreshes tools/audience/measured-facts.json
```

Known stale artefact note: `docs/browser-verification.json` was last refreshed 2026-10-14
and reports 154 resource rows; re-run `npm run verify:browser` against a production build to
refresh it.


