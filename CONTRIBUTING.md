# Contributing

Thanks for considering it. This repository has a smaller amount of tooling than it looks like
it does, but the tooling it has is load-bearing: it exists because a number shipped in the UI
or in the docs was once wrong. Read this page before your first pull request and the checks
will feel like a safety net rather than a tax.

## Get it running

```bash
npm ci                 # Node 20+. Supabase packages warn about Node 22; warnings only.
npm run dev            # http://localhost:5173
npm run preview        # serves the production build on 0.0.0.0:4173
```

No API key is required for anything: the app ships a curated dataset, and the local reader
answers from it. `supabase/` is optional infrastructure.

## The checks, in the order they matter

```bash
npm run validate:seed        # dataset rules + reader + both engines + generated Cypher
npm run emit:cypher          # regenerate neo4j/ from the seed (must be clean first)
npm run typecheck            # tsc -b, no emit
npm test                     # vitest run
npm run build                # tsc -b && vite build
npm run verify               # the full ordered chain; skips are named, not silent
npm run verify:resources     # link-checks every resource URL (needs the network)
```

Every script returns non-zero on failure and prints what it checked. `npm run verify` with
`--with-infra` treats a skip as a failure, which is what CI should use.

## Rules the repository enforces

1. **No invented numbers, users, testimonials, ratings or outcomes.** Not in copy, not in
   docs, not in tests. If something cannot be measured here, say it is unverified.
2. **Counts are derived or swept.** Node/edge/row counts come from `datasetCounts`; if you
   change the dataset, update the pinned strings listed in `docs/objections.md`
   (§Repo legitimacy) and re-run `npm run emit:social-card`.
3. **Instruments must not hardcode the thing they measure.** If a script quotes landing copy,
   read the measured fact instead.
4. **Doc references must resolve.** A comment that points at a file that does not exist fails
   `tests/unit/docs.test.ts`.
5. **Seed authoring rules.** See the header of `src/data/seed/knowledgeGraph.ts`: real https
   URLs, honest access labels, outcomes ≥2, stated prerequisites, time as a range, safety
   notes for anything mains-/solder-/laser-/battery-powered, and no filler to hit a count.
   `npm run validate:seed` enforces the mechanical part.
6. **Accessibility bar.** New controls are ≥36 px in their smallest dimension, focus is
   visible, state is never carried by shadow alone, and both themes must pass contrast.
   `docs/accessibility.md` lists the known exceptions.
7. **Surface language.** The UI is neumorphic: one base colour per theme, state shown by
   border and text as well as shadow. Do not introduce `backdrop-filter` or a second base.
8. **Never claim what was not built.** No APK claims, no deployment URLs, no "live" data.

## Pull request checklist

- [ ] `npm run validate:seed` passes
- [ ] `npm run typecheck` and `npm test` pass
- [ ] `npm run build` passes and `dist/` is not committed
- [ ] New UI has a keyboard path, an accessible name, and both themes checked
- [ ] Any number in copy or docs traces to a command in the PR description
- [ ] `npm run emit:cypher` re-run if the seed changed, and `neo4j/` committed with it


