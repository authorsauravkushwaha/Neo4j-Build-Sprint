# The public API catalogue

A learner who has just finished "HTTP basics" should be able to point at something
real and callable. That is the whole reason this catalogue exists: to sit next to a
skill, not to be another list of links.

Source: [`public-apis/public-apis`](https://github.com/public-apis/public-apis)
(MIT). It is a community-maintained table — one row per API, grouped by category,
with four facts per row: the name and link, a one-line description, and the
`Auth`, `HTTPS` and `CORS` columns.

## What we keep, and what we throw away

| | |
| --- | --- |
| Rows read at import | see `PUBLIC_API_SOURCE` in the generated file (last import: 2026-10-16, commit `065455e`) |
| Categories kept | 19, chosen because they map onto the curriculum (`Development`, `Open Source Projects`, `Machine Learning`, `Science & Math`, `Geocoding`, `Security`, `Test Data`, `Weather`, …) |
| Rows kept | at most 16 per category, ranked: no-auth first, then CORS-known, then most curriculum links, then alphabetical |
| Fields kept | name, url, description (≤200 chars), category, `auth`, `cors`, `skillIds` |
| Fields removed | everything else. No rate limits, no quotas, no "free forever" claims — nothing this project did not read in the source table |

Dropping the other 40-odd categories is the point. A catalogue of 2,000 APIs is not
guidance, it is a haystack; the ranked, capped subset is small enough to read and
still covers every category a student project would plausibly reach for.

## Importing and refreshing

```bash
git clone --depth 1 https://github.com/public-apis/public-apis.git /tmp/public-apis
npx tsx scripts/import-public-apis.ts --source /tmp/public-apis/README.md
# or: npm run import:public-apis -- --source /tmp/public-apis/README.md
```

The importer:

- **refuses to fetch anything on its own** — you give it a file, so an import is a
  deliberate act with a reviewable diff;
- **refuses to write a catalogue it cannot parse** — fewer than 500 parsed rows
  aborts the run, because a silently-empty catalogue looks exactly like a
  successfully-empty one;
- **validates every skill id** against the 90 skills in
  `src/data/seed/knowledgeGraph.ts`, so a typo cannot enter the data;
- **stamps the source commit and the date the rows were read** into the generated
  file, which is what makes "last checked" a measurement rather than a claim;
- **is deterministic**: same input file, same output file, sorted and capped, so the
  diff of a refresh shows only real changes.

Generated output goes to `src/data/publicApis/catalog.generated.ts` — a file with a
header saying it is generated, with the exact commands to regenerate it. It is
loaded lazily (only the workflows page and the catalogue view import it), so it does
not sit in the main bundle.

## How an API is matched to a skill

Two steps, both visible in the importer rather than hidden in a model:

1. **Category → skills**, from an explicit map (19 entries): `Geocoding` →
   `gis-and-spatial-analysis`, `geodesy-and-coordinate-systems`; `Machine Learning`
   → `machine-learning-fundamentals`, `responsible-ai-practices`; and so on.
2. **Keywords → skills**, from eleven regex rules over the name and description:
   `oauth|authentication|jwt` adds `applied-cryptography`; `docker|kubernetes`
   adds `containers-and-docker` and `cloud-fundamentals`; `geospat|latitude|longitude`
   adds `gis-and-spatial-analysis`.

An entry with no curriculum link is dropped: in a list that claims to be useful,
it would be trivia. An entry whose Auth column is anything other than "No" also gets
`applied-cryptography`, because "go and read how to hold a key" is the actual next
step.

Every match reason is stated in the UI — "Calling this exercises 2 skill(s) in your
route" — and never "recommended for you".

## What this catalogue cannot tell you

These four statements are shown in the UI, returned by
`publicApiProvenance()`, and repeated here because they are the difference between
a useful list and a trap:

1. **Imported, not live.** The rows are a snapshot of the upstream directory at the
   commit above. Refreshing is a script run, not a background job.
2. **`auth` and `cors` are upstream's columns, quoted.** An entry marked `apiKey`
   needs a key. `CORS: Unknown` means the directory does not say — test it before
   building a browser app around that endpoint.
3. **Free means free at import time.** Rate limits, quotas and terms change without
   notice, and nobody here re-reads the terms for you.
4. **A related API is a practice target, not a lesson.** It appears next to a skill
   because calling it exercises that skill, not because it teaches it.

## Where it appears

- `gm.publicApi.map` — the workflow node, used by
  `workflow:public-api-map` (`docs/workflows.md`).
- `listPublicApis({ skillIds, category, q, limit })` — the query layer in
  `src/data/publicApis/index.ts`, callable from any feature.
- **Not yet**: there is no public catalogue *page*. The data, the query layer, the
  provenance object and the workflow node all exist and are tested; a browsable
  `/apis` route is the next piece of surface, and it is listed in
  `docs/features-and-limitations.md` rather than quietly implied by this document.

## Licence and attribution

Upstream is MIT; the licence text is at
`https://github.com/public-apis/public-apis/blob/master/LICENSE`. The generated file
records the source repository, the licence, the commit and the date. Descriptions
are quoted verbatim from upstream (truncated to 200 characters), and the link column
is reproduced unchanged so a reader can always go and check the original row.
