# Features and limitations

Two lists, side by side, because a feature list without its limits is marketing.

---

## Part 1 — What this app does

### Works with no configuration, and says which mode it is in

- **Local sample mode** is the default: the bundled curriculum (`src/data/seed/knowledgeGraph.ts`) runs
  through the same engine in the browser. Every screen works — graph, gaps, roadmap, projects, resources,
  mentor. The UI labels this everywhere as *"the bundled sample dataset"*, never as live data.
- **Live mode** activates when Supabase is configured. The same screens then read from Neo4j through Edge
  Functions. The client refuses to mix the two: if the backend fails, the UI offers demo mode as an
  explicit choice instead of quietly serving sample data.
- The **health check** reports the truth in one place: graph source, node/relationship counts, whether AI is
  configured, which provider, whether request signing is required, and the build version.

### The knowledge graph (the signature feature)

- Interactive canvas with zoom, pan, fit and re-layout.
- Filters by node type, relationship type, difficulty and maximum node count, with a hard cap that is
  **reported when it truncates** rather than silently cutting the picture.
- Prerequisite highlighting (what must come first) and downstream highlighting (what this unlocks).
- Path tracing between any two nodes (shortest directed path).
- Bounded neighbourhoods: every query has a depth and row limit, so no screen ever tries to load the whole
  graph.
- A **list view** with the same nodes, relationships and degrees — the canvas is `aria-hidden` and the list
  is the accessible equivalent, so the graph is usable with a keyboard or a screen reader.
- A **3D view** of the same bounded subgraph (the third tab, alongside Canvas and List): a force layout
  computed deterministically from the node ids, so the same query lays out the same way every time. Drag to
  orbit, click a node to select it, scroll to zoom; prerequisites and downstream nodes are highlighted in
  the same amber/green palette as the canvas.
- The 3D view is **not** a replacement for the canvas or the list. It is another way to look at the same
  result, it needs WebGL, and when WebGL is unavailable (or reduced motion is on) it falls back to a short
  explanation plus a pointer to Canvas and List rather than an empty box.

### Curriculum

- **17 curated engineering careers** across 16 branches, each with typical roles, required skills,
  related careers and explicit caveats.
- **89 skills** with prerequisites, difficulty, study-hour ranges, proficiency levels and practice notes.
- **33 projects** with deliverables, milestones, testing ideas, extension work and — importantly —
  **safety notes** where the project involves mains voltage, soldering, machine tools, chemicals, high
  currents or cloud cost.
- **154 free and free-to-audit resources** (courses, books, docs, references, hands-on practice). Each one
  states three things a link list usually hides: **what you can do afterwards**, **what it assumes you
  already know**, and **where it stops**; plus how long it takes, what "free" means for that provider
  (`free-open`, `free-audit`, `free-account`, `free-with-limits`) and the date the link was last actually
  checked.
- **Effort you can plan around.** Every resource carries an hour range and a plain-English shape
  (`≈ 10–30 hours. A few days per feature, with a meter and a board in front of you.`), using the same units
  as the skill estimates, so a gap analysis turns into a timetable rather than a wish.
- **Prerequisites are graph facts, not prose.** 91 resources carry `ASSUMES` edges to the skills they
  presume you already have (120 of them). They render as links to the skill pages and can be queried:
  `MATCH (r:Resource)-[:ASSUMES]->(s:Skill)`. A resource may revisit a skill it also assumes — a course that
  assumes arithmetic and then deepens it — but every prerequisite is taught by some resource, and
  `validate:seed` fails if that stops being true.
- **Every skill has at least two routes.** `npm run validate:seed` fails if any skill in the graph is left
  without a resource, or is reachable from only one link that could go stale tomorrow.
- **13 learning modules** and **16 assessments** that map a route across several skills at once.
- **Find anything in one keystroke.** Cmd/Ctrl+K opens a command palette that searches every page, career,
  skill, concept, project and resource — offline, without an AI provider, and without a page load. It is a
  real dialog (focus moves in and returns to where it was, arrow keys move, Enter opens) and the ranking is
  plain and explainable: exact title, prefix, word start, substring, then the ids and tools an entry carries.
  Skills and concepts come from `GET /get-skills`, the index endpoint the palette called for.

### Planning and analysis

- **Career pathway builder**: the full route in dependency order, split into essentials and optional
  breadth, with the count of each.
- **Skill-gap analyzer**: classifies every skill as *already familiar*, *missing prerequisite*,
  *recommended next* or *optional specialisation*, and estimates remaining effort as a range plus weeks at
  your stated pace. Self-ratings are explicitly labelled as self-reported and unverifiable.
- **Roadmap generator**: week-by-week plan using your real weekly hours, with a spaced **review row** after
  every third learning step, and a rescheduler that keeps completed work in place.
- **Project recommender**: scores projects by how much of the graph they exercise, with the match reason
  stated per suggestion.
- **Resource recommender**: ranks free resources for the skills in your plan by coverage and format fit.
- **Progress tracking**: per-task status, logged hours, and a summary computed from stored rows — no
  streaks, no points, no invented motivation mechanics.

### Mentor

- Graph-grounded answers with **citations** to the skills, projects and resources used, and a stated
  confidence/uncertainty section.
- **Works with no AI key.** A deterministic rules engine (`fallbackMentor.ts`) answers from the same context;
  the UI says which one replied.
- Concise and detailed modes; 9 recognised intents; hard caps on how much context is assembled
  (18 skills, 5 projects, 6 resources, 40 edges, 12 000 characters).
- Honest limits: it does not know your grades, cannot verify your self-ratings, will not promise outcomes,
  and never takes instructions from text inside the graph context.

### Presentation

- A **neumorphic** surface system: one opaque material shared by the page, cards, chips and the app bar,
  with light/shade shadow pairs — cast inwards for insets and for anything held or selected. It is
  decoration, not information: no surface uses a backdrop blur, and state never rests on a shadow alone,
  because colour, text and the focus ring always move with it. The two 3D scenes below are lit the same
  way — key from the upper left, cooler fill from the lower right — and their nodes are matte and opaque
  rather than glass, with the label hues kept because in the graph those hues carry information.
- Two **three.js** scenes: a fixed hero composition on the landing page and the 3D graph view above. Both
  load on demand, both pause when off-screen or when the tab is hidden, and both release their GPU
  resources on unmount.
- **The whole app is a scroll experience, not just the landing page** (`src/skiper/`,
  [skiper-ui.md](skiper-ui.md)). The app bar condenses once it is no longer the top of the page; every
  route enters with the same short rise-and-fade; content lists arrive in order, which costs one CSS rule
  per position rather than a component per row; a roadmap's week heading stays pinned while its own week
  scrolls past; and a hairline rail plus a **back-to-top** button make a forty-task page navigable. The
  same layer is driven by the *data*: the path's steps arrive in dependency order because the engine
  computed that order, and nothing in it is a number the front end owns.
- **Motion is a preference, and it is honoured everywhere.** Reduced motion renders the finished state —
  the entrance is not created at all, not merely shortened — except for the back-to-top control, which is
  behaviour rather than decoration: a reduced-motion reader needs it exactly as much as anybody else. The
  layer never moves a box (only transform, opacity and box-shadow) so a scroll cannot cause a reflow, and
  filter cards, form fields and the mentor transcript are deliberately still.
- Fallbacks, in order: reduced motion → static; no WebGL → static; no JavaScript layout yet → the scene
  builds only after its container has a real measured size. The app is fully usable with none of it.
- **Where the tilt is, and where it deliberately is not.** Every surface is the same material, but only the *focal*
  card on a screen follows the pointer in 3D (`Card lift`); the rest are `gm-card-static`, which still
  gains depth on hover but does not move. Applying the tilt to every card was tried and rejected: a page
  of panels rippling under the pointer is noise, and it makes long-form text harder to read while it is
  being read. The rule is one promoted surface per screen — the hero on the landing page, "Next up" on the
  dashboard — rather than an effect sprinkled everywhere.
- **A `force3d` preference exists for software renderers.** The capability probe asks for a WebGL context
  with `failIfMajorPerformanceCaveat: true`, which refuses machines that would draw in software. That is
  the right default (a software GPU makes a 3D page worse, not better), but it is a *default*, not a
  verdict: Settings carries "Try the 3D views on this device anyway", which re-probes without the caveat
  and stores the choice. Without it, a visitor on such a machine was refused 3D permanently with no
  explanation and no way to override — which is how that bug was found.

### Automation and practice targets

- **A readable workflow engine** (`core/workflow`): definitions are JSON with **14 node types**
  (`gm.http.request`, `gm.graph.pathway`, `gm.ai.mentor`, …), and six shipped workflows — a mentor digest, a
  frontier export, a pathway digest, a resource check, a public-API map and a weekly roadmap build. Runs are
  reproducible: every node records what it received and what it returned, so a result can be read back
  rather than re-run.
- **Outbound requests are allowlisted.** A node may only reach a host on the workflow's list, and the union
  of the shipped workflows' hosts is asserted to equal the one exported host list
  (`WORKFLOW_ALLOWED_HOSTS`) — a workflow cannot quietly acquire a new destination. Hosts are https-only, no
  credentials in the URL, and a refused host is an error rather than an empty result.
- **`npm run workflow -- --id … --json` runs one on the command line**, and `scripts/workflow.ts --list`
  prints the catalogue. The same engine is used in the browser (`workflowServices.ts`), so a definition does
  not behave differently in the two places.
- **A public-API catalogue for practice**: **259 entries** imported from
  [`public-apis/public-apis`](https://github.com/public-apis/public-apis) (MIT), each linked to the
  curriculum skills it exercises, with the source commit, the read date and upstream's `auth` / `cors`
  columns quoted rather than guessed. See [public-apis.md](public-apis.md).

### Accounts and data

- **Password sign-in and email-link sign-in**, both through Supabase. Guest mode is complete: no feature is
  locked behind an account.
- **The password rule is one function used on both sides** (`validatePasswordStrength` in the shared core,
  imported by the browser). It is length-based — at least 10 characters, at most 72 bytes, not a known-bad
  password — and deliberately *not* a composition rule; `docs/security.md` §2 explains why, and
  `tests/unit/auth.test.ts` fails if the two sides ever diverge.
- **Sign-in attempts are rate limited before they reach the identity provider** (10 per minute and 40 per
  hour per address, 30 per minute per network), counted against a hash of the address rather than the
  address itself.
- **Sign out everywhere** revokes every refresh token for the account — the control to use after losing a
  device.
- Server-side data is RLS-scoped to the signed-in user; a second account cannot read or modify it.
- **Export** (device and account copies, clearly separated) and **delete** (account data or local data) from
  Settings, without contacting anyone.
- Progress syncs across devices once a plan is saved to an account; otherwise it stays on the device and the
  app says so.

### Platforms

- Responsive web app: 360 px phone through desktop, with a mobile navigation drawer and touch-sized controls.
- **PWA**: installable, offline shell (an `offline.html` fallback page), 29 precache entries, and an update
  prompt that asks before reloading — it never silently swaps the app under you.
- **Capacitor Android** configuration committed (`appId: ai.graphmentor.app`) sharing the same build, plus
  the same Edge Functions, so user data has exactly one home.
- **Two storage backends, one API**: Supabase (row-level security in the database) or Appwrite (the
  ownership policy enforced by the adapter). Swapping them changes no screen and no handler. What differs,
  and what has not been exercised, is in [appwrite.md](appwrite.md) — including the honest part: no live
  Appwrite project has been run against this code.
- Accessibility: skip link, focus-visible rings, labelled controls, reduced-motion support (which also
  disables graph animation, the scroll entrances and the progress rail), a theme selector, and text
  alternatives for every canvas-based feature. No animation in this app is the only route to information:
  every pinned scene has a stacked static form, every list is in the DOM from the first render, and the
  chapter rails are real links that skip the story entirely.

---

## Part 2 — What this app cannot do (and never claims)

### About outcomes

- **No job, internship, salary or placement guarantee.** Planning a study order does not create demand for
  your skills, and the app says exactly that wherever it would be tempting to imply otherwise.
- **No salary figures or "hireability" scores.** None are invented, and none are implied.
- **No social proof.** No user counts, testimonials, ratings, reviews or success statistics exist anywhere in
  the UI. A test asserts this, because it is the kind of thing that creeps in later.

### About the data

- The curriculum is **curated and finite**: 17 careers, 89 skills, 33 projects, 154 resources and 15
  relationship types. It is not exhaustive, region-specific (salaries, visa paths, licensing and local job markets are deliberately out of
  scope) and will not match every university syllabus.
- Resource **verification is a point-in-time check**, not a guarantee. Providers move URLs, add paywalls,
  and retire courses. The app shows the check date so you can judge it; a link that refused the checker is
  shown as unverified rather than assumed good.
- **Self-assessments are self-reported.** The graph cannot verify that you really know something. The
  analyzer says so on screen, in the caveats, and in exports.
- **Estimates are ranges**, based on typical study time — not promises about how fast *you* will learn.

### About the API catalogue

- **It is a snapshot, not a live index**: 259 of 2,028 upstream rows, read on one date at one commit,
  refreshed by a script that refuses to fetch on its own. Rate limits, quotas and terms change without
  notice and nothing here re-reads them.
- **Auth means auth.** An entry marked `apiKey` needs a key; `CORS: Unknown` means the directory does not
  say, and "free" means free at import time. The UI repeats all five caveats next to the data rather than in
  a footnote.
- **Two rows link to a plaintext `http://` page** while upstream's own HTTPS column says `Yes`. They are
  kept and marked (`linkScheme: "http"`), ranked last, and never presented as ready to call — hiding them
  would be tidier and less truthful.
- **There is no public catalogue page yet.** The data, the query layer, the provenance object, the tests
  and the workflow node all exist; a browsable `/apis` route is the next piece of surface. Until then the
  catalogue is reached through the workflow node and the query layer, and this document says so instead of
  implying a page that is not there.

### About the workflow engine

- **It is not a general-purpose automation platform.** There is no arbitrary code execution, no shell node,
  no filesystem access and no plugin loader. Nodes do one of a fixed set of things, and outbound traffic is
  allowlisted by host.
- **Scheduling is a definition field, not a daemon.** The cron expressions are parsed and validated (five
  UTC fields), and `docs/workflows.md` states where a real deployment would have to run them; this project
  does not ship a scheduler that claims to have run anything.
- **An HTTP node needs the network** and will fail — loudly, with the host it refused — in an environment
  without one. That is stated in the run output rather than swallowed.

### About the AI mentor

- With no provider configured, answers come from a **rules engine**: correct, cited, but limited to
  templated reasoning over the graph. It will not write you an essay.
- With a provider configured, the model only **rephrases graph facts**. It cannot introduce a skill, project
  or resource that is not in the graph, and it does not know anything about you beyond what you type in the
  session.
- It will not help with anything outside engineering learning navigation, and it is not a substitute for a
  teacher, a mentor, or a real person reading your work.

### About the running software

- **Free-tier quotas apply.** Neo4j AuraDB Free and Supabase's free tier have storage, compute and request
  limits that can change; a deployment can run out of them. The app degrades and says so, but cannot promise
  uptime.
- **No email is guaranteed** unless the deployment configures SMTP for sign-in links and resets.
- **No 2FA, no device list, no login history.** "Sign out everywhere" is the only remote-revocation tool,
  and it revokes all devices rather than one. A stolen password plus a working inbox is a full takeover.
- **Account deletion is two steps, and one of them is manual.** The app deletes your *data*; removing the
  login itself needs a server-side key the browser never holds, so it is a request to the operator. The
  screen says so rather than implying one click erases everything.
- **No offline AI or offline live data**: offline, the app serves the installed shell and the bundled sample
  dataset. Live graph reads need a connection (they are never fabricated from cache).
- **No file uploads, no image analysis, no voice input.** None are implemented, in either mode.

### What has not been verified here

Read [verification.md](verification.md) before trusting any of the above in a live deployment. In summary:
no Neo4j instance, no Supabase project, no AI key, no SMTP and no Android SDK were available while this was
built, so **live Neo4j reads, the Supabase-hosted backend, AI provider calls, GoTrue (password sign-in,
sign-in links, password resets) and email delivery, and the APK are unverified**. The user-data endpoints are
implemented and covered by tests and by a local HTTP run against a real Postgres, but were never invoked
against a deployed project. What *has* been verified locally, against real infrastructure rather than in
jsdom, is RLS with the shipped migrations applied, the auth path over a real socket with the limiter in
Postgres, and the WebGL, neumorphic and mobile UI in a real browser engine — see `docs/verification.md` §5.

Two more that are easy to over-read, and both have moved since this list was written: the **3D scenes have
now been rendered in a real browser engine** (WebGL 2.0 via Chromium/ANGLE, with the hero and graph scenes
drawing, orbiting and zooming), and **the neumorphic material has been measured in the same run** — a card
and the app bar paint the same colour as the page, read from rendered pixels and not only from computed
styles; the shadows come in light/shade pairs; form fields are pressed in; a held button inverts its
shadow; no surface carries a backdrop blur; reduced motion respected. What is still unverified
is *how they feel on real hardware*: the browser run renders through a software rasteriser, so it proves the
scenes are correct, not that they are fast. The remaining unverified list lives in `docs/verification.md` §6
with the exact commands that would close each item.

### Deliberately out of scope

- No résumé builder, portfolio hosting, or interview question bank.
- No employer directory, job board, or recruiter contact.
- No paid content, affiliate links, or sponsored placement — the resource list has no monetisation path.
- No social features: no profiles to share, no leaderboards, no public progress.


