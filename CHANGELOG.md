# Changelog

Two versions move independently: the **app** version (`package.json`) and the **dataset**
version (`neo4j/MANIFEST.json`). Every number below is reproducible with the commands in
`docs/verification.md`; nothing here is an estimate.

## Unreleased

- Account sync now also carries roadmap task progress (statuses, logged hours and notes), not just
  bookmarks, skill ratings and profile — stored in `public.user_task_progress` under the same
  role-scoped RLS as the other sync tables.
- The sync panel shows what your account currently holds before you download over a device.
- Progress page: a "This week" summary (tasks completed/touched and hours logged in the last
  7 days against your weekly target) and a downloadable Markdown progress report.

## 1.0.0 — 2026-10-14

First complete cut: a pre-seeded, account-free engineering career navigator that answers from
the browser without a network round trip, and optionally uses Supabase when configured.

**Dataset** — `datasetVersion 1.1.0`, seed checksum recorded in `neo4j/MANIFEST.json`:

- 16 engineering branches, 17 careers, 24 subjects, 37 concepts, 89 skills, 33 projects,
  154 resources, 13 learning modules, 16 self-check assessments, 37 tools and 8 languages.
- **444 nodes and 1,585 relationships**, emitted as 36 batched, MERGE-only Cypher statements.
- Every skill is reachable from at least two resources; every resource carries an access note,
  stated prerequisites, outcomes and limits, and a real time range (1–400 h, low ≤ high).
- 154 resource URLs are link-checked in `docs/resource-verification.md`; four providers reject
  automated checkers and are labelled as such in the app rather than quietly marked verified.
- Chemical/process, biomedical, industrial/manufacturing and surveying/geospatial slices were added on top of the
  original software/electronics/mechanical core; each slice passed the dataset gauntlet before
  the next was started.

**Product**

- Career explorer, skill-gap analysis against real prerequisites, dependency-aware roadmaps,
  project library with safety notes, resource library with access models, and a 3D knowledge
  graph view that is labelled as a visualisation of the shipped dataset, not live data.
- Guest mode works with no account; progress and preferences are local-only with reset,
  export and delete controls.

**Verification** — the state of the gates at this cut is recorded in `docs/verification.md`;
the honest summary is: unit/integration suite green, dataset self-check green, generated
Cypher in sync with the dataset, and every "verified" resource label produced by
`npm run verify:resources` rather than by hand.

**Known gaps** — listed in `docs/objections.md`, including the ones this repository cannot
close from inside the sandbox it was built in (no hosted instance, no Android APK artefact,
no third-party accessibility audit, no screen-reader user testing).


