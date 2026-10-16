/**
 * The numbers in the prose are the numbers in the dataset.
 *
 * This test exists because they drifted. The dataset doubled in size — 13 careers
 * became 17, 97 resources became 154, 20 projects became 33 — and the README, the
 * features document and the verification log went on saying 13, 97 and 20 for a
 * while, because prose is not compiled and nothing checked it. Every one of those
 * sentences was *accurate when written*, which is exactly what makes this class of
 * error survive review: nobody re-reads a number they have already read.
 *
 * So the claims are extracted from the files and compared against
 * `datasetCounts`, which is itself derived from the seed and already checked by
 * `npm run validate:seed` against the generated Cypher. There is one source of
 * truth here and it is not a sentence.
 *
 * Three deliberate properties:
 *
 *   1. **Patterns, not line numbers.** A claim is found by the sentence frame it
 *      lives in (`**17 curated engineering careers** across 16 branches`), so
 *      moving the sentence does not break the test and rewriting it to avoid the
 *      frame does — that is the point, since the frame is what makes the claim
 *      checkable.
 *   2. **Every match is checked, and the count of matches is checked.** A file
 *      that says 17 in one row and 13 in another fails on the second match, and a
 *      pattern that stops matching anything at all fails loudly instead of passing
 *      vacuously.
 *   3. **Only the numbers are checked here.** `docs.test.ts` owns link integrity,
 *      `validate:seed` owns graph integrity. This file's whole job is that a
 *      reader who checks a number against the app finds the same number.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { datasetCounts, knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'

const root = resolve(__dirname, '../..')

function read(file: string): string {
  return readFileSync(resolve(root, file), 'utf8')
}

const counts = datasetCounts
/** Counted from the graph's own edges, not restated anywhere. */
const assumesEdges = knowledgeGraph.edges.filter((edge) => edge.type === 'ASSUMES')
const assumesResources = new Set(assumesEdges.map((edge) => edge.from)).size

interface Claim {
  file: string
  /** The frame the claim lives in. Every capture group is a number, in reading order. */
  pattern: RegExp
  /** What those numbers must equal. */
  expected: number[]
  /** Shown when the claim fails, because "expected 17, got 13" needs its subject. */
  what: string
  /** Minimum number of places in the file this frame must appear. Defaults to 1. */
  atLeast?: number
}

const CLAIMS: Claim[] = [
  {
    file: 'README.md',
    pattern: /\|\s*(\d+) curated engineering careers with skills, roles and caveats/,
    expected: [counts.careers],
    what: 'the README feature table describes the career explorer',
  },
  {
    file: 'README.md',
    pattern: /\|\s*(\d+) projects with deliverable lists/,
    expected: [counts.projects],
    what: 'the README feature table describes the project recommender',
  },
  {
    file: 'README.md',
    pattern: /\|\s*(\d+) free and free-to-audit resources\. Every one states/,
    expected: [counts.resources],
    what: 'the README feature table describes the resource library',
  },
  {
    file: 'docs/features-and-limitations.md',
    pattern: /\*\*(\d+) curated engineering careers\*\* across (\d+) branches/,
    expected: [counts.careers, counts.branches],
    what: 'the features document states the curriculum size',
  },
  {
    file: 'docs/features-and-limitations.md',
    pattern: /\*\*(\d+) skills\*\* with prerequisites/,
    expected: [counts.skills],
    what: 'the features document states the skill count',
  },
  {
    file: 'docs/features-and-limitations.md',
    pattern: /\*\*(\d+) projects\*\* with deliverables/,
    expected: [counts.projects],
    what: 'the features document states the project count',
  },
  {
    file: 'docs/features-and-limitations.md',
    pattern: /\*\*(\d+) free and free-to-audit resources\*\*/,
    expected: [counts.resources],
    what: 'the features document states the resource count',
  },
  {
    file: 'docs/features-and-limitations.md',
    pattern: /(\d+) resources carry `ASSUMES` edges to the skills they\s+presume you already have \((\d+) of them\)/,
    expected: [assumesResources, assumesEdges.length],
    what: 'the features document states how many resources declare prerequisites',
  },
  {
    file: 'docs/features-and-limitations.md',
    pattern: /\*\*(\d+) learning modules\*\* and \*\*(\d+) assessments\*\*/,
    expected: [counts.modules, counts.assessments],
    what: 'the features document states the module and assessment counts',
  },
  {
    file: 'docs/features-and-limitations.md',
    pattern: /curated and finite\*\*: (\d+) careers, (\d+) skills, (\d+) projects, (\d+) resources and (\d+)\s+relationship types/,
    expected: [counts.careers, counts.skills, counts.projects, counts.resources, counts.relationshipTypes],
    what: 'the limitations section restates the whole dataset',
  },
  {
    file: 'docs/verification.md',
    pattern: /^Dataset contents \(counted from the source of truth/m,
    expected: [],
    what: 'the verification log keeps the dataset section it links to the seed',
  },
  {
    file: 'docs/verification.md',
    pattern: /\|\s*Engineering branches\s*\|\s*(\d+)\s*\|\s*Languages\s*\|\s*(\d+)\s*\|/,
    expected: [counts.branches, counts.languages],
    what: 'the verification dataset table row 1',
  },
  {
    file: 'docs/verification.md',
    pattern: /\|\s*Careers\s*\|\s*(\d+)\s*\|\s*Tools\s*\|\s*(\d+)\s*\|/,
    expected: [counts.careers, counts.tools],
    what: 'the verification dataset table row 2',
  },
  {
    file: 'docs/verification.md',
    pattern: /\|\s*Subjects\s*\|\s*(\d+)\s*\|\s*Projects\s*\|\s*(\d+)\s*\|/,
    expected: [counts.subjects, counts.projects],
    what: 'the verification dataset table row 3',
  },
  {
    file: 'docs/verification.md',
    pattern: /\|\s*Concepts\s*\|\s*(\d+)\s*\|\s*Resources\s*\|\s*(\d+)\s*\|/,
    expected: [counts.concepts, counts.resources],
    what: 'the verification dataset table row 4',
  },
  {
    file: 'docs/verification.md',
    pattern: /\|\s*Skills\s*\|\s*(\d+)\s*\|\s*Learning modules\s*\|\s*(\d+)\s*\|/,
    expected: [counts.skills, counts.modules],
    what: 'the verification dataset table row 5',
  },
  {
    file: 'docs/verification.md',
    pattern: /\|\s*Assessments\s*\|\s*(\d+)\s*\|\s*Graph edges\s*\|\s*(\d+)\s*\|/,
    expected: [counts.assessments, counts.edges],
    what: 'the verification dataset table row 6',
  },
  {
    file: 'docs/verification.md',
    pattern: /`ASSUMES` (\d+) \(across (\d+) resources\)/,
    expected: [assumesEdges.length, assumesResources],
    what: 'the verification log counts the ASSUMES edges',
  },
  {
    file: 'docs/objections.md',
    pattern: /totals \((\d+) careers, (\d+) skills, (\d+) resources at this build\)/,
    expected: [counts.careers, counts.skills, counts.resources],
    what: 'the objections document answers "where do your numbers come from"',
  },
  {
    file: 'docs/objections.md',
    pattern: /spans (\d+) branches and (\d+) careers/,
    expected: [counts.branches, counts.careers],
    what: 'the objections document describes the curriculum span',
  },
  {
    file: 'docs/objections.md',
    pattern: /at (\d+) skills, (\d+) projects, (\d+) resources\./,
    expected: [counts.skills, counts.projects, counts.resources],
    what: 'the objections document restates the totals',
  },
  {
    file: 'src/features/misc/AboutPage.tsx',
    pattern: /both engines for all (\d+) careers/,
    expected: [counts.careers],
    what: 'the About screen states how many careers both engines were run against',
  },
]

describe('the numbers in the prose', () => {
  it('are the numbers in the seed', () => {
    for (const claim of CLAIMS) {
      const source = read(claim.file)
      const matches = [...source.matchAll(new RegExp(claim.pattern.source, claim.pattern.flags.includes('m') ? 'gm' : 'g'))]
      expect(matches.length, `${claim.file}: no match for ${claim.pattern} — ${claim.what}`).toBeGreaterThanOrEqual(
        claim.atLeast ?? 1,
      )
      for (const match of matches) {
        const found = match.slice(1).map((group) => Number(group))
        expect(found, `${claim.file}: "${match[0].trim()}" — ${claim.what}`).toEqual(claim.expected)
      }
    }
  })

  it('counts the ASSUMES edges from the graph rather than from a document', () => {
    // The two numbers this file derives are worth their own assertion: if the seed
    // stops emitting ASSUMES edges, every prose claim about them would be "0 of 0"
    // and the test above would pass while the feature had disappeared.
    expect(assumesEdges.length).toBeGreaterThan(50)
    expect(assumesResources).toBeGreaterThan(50)
    for (const edge of assumesEdges) {
      expect(edge.from.startsWith('resource:')).toBe(true)
      expect(edge.to.startsWith('skill:')).toBe(true)
    }
  })

  it('has prose claiming a dataset size at all', () => {
    // A guard against the honest failure mode of a table like the one above: a
    // rename that makes every pattern stop matching. The `atLeast` defaults would
    // catch it per claim, and this catches the shape of the mistake.
    expect(CLAIMS.length).toBeGreaterThanOrEqual(20)
    expect(counts.careers).toBeGreaterThan(0)
    expect(counts.edges).toBeGreaterThan(counts.skills)
  })
})
