/**
 * Writes the cross-language fixture for `tools/oracle/FrontierOracle.java`.
 *
 * The fixture is deliberately *inputs plus expected output*: for every exported
 * case it records the exact slice the browser engine would receive (skills,
 * prerequisite edges, ratings, weekly hours) and then the canonical serialisation
 * of `analyzeFrontier`'s answer. The Java oracle reads only the inputs, computes
 * its own answer, and is compared line by line with the expected block.
 *
 * Three things make that comparison meaningful rather than decorative:
 *
 *  1. It refuses to export a case whose closure contains a prerequisite cycle.
 *     Cycle members are ordered by the graph's cyclic tail, where JavaScript's
 *     `localeCompare` and Java's `String.compareTo` can legitimately disagree, so
 *     a diff there would be a collation artefact rather than a bug. Better to
 *     refuse loudly than to compare something that cannot hold.
 *  2. Field values are checked for tabs and newlines, so a name can never smuggle
 *     a delimiter into the file and shift a column.
 *  3. The tuning constants (thresholds, budgets, hour defaults, mastery table) are
 *     written into the fixture as declared inputs, so the oracle reproduces
 *     algorithms — not policy numbers — and cannot be "fed" its answers.
 *
 * Run: npm run oracle:export   (then npm run oracle)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { knowledgeGraph } from '../src/data/seed/knowledgeGraph.ts'
import { loadCareerSlice } from '../supabase/functions/_shared/core/careerSlice.ts'
import { createLocalReader } from '../supabase/functions/_shared/core/localReader.ts'
import { analyzeFrontier, CAVEATS, ENGINE_LIMITS, type FrontierReport } from '../supabase/functions/_shared/core/recommend.ts'
import { STATE_TO_MASTERY } from '../supabase/functions/_shared/core/graphReader.ts'
import type { SkillState } from '../supabase/functions/_shared/core/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../tools/oracle/fixtures')
const outFile = resolve(outDir, 'frontier-oracle.tsv')

const TABS = /\t/
const NEWLINES = /[\r\n]/
function field(value: string): string {
  if (TABS.test(value) || NEWLINES.test(value)) {
    throw new Error(`Fixture field contains a tab or newline: ${JSON.stringify(value)}`)
  }
  return value
}

function bool(value: boolean): string {
  return value ? '1' : '0'
}

/**
 * The canonical serialisation, mirroring `FrontierOracle.canonicalise` in Java.
 * If the two ever drift, every line differs and the diff says so immediately.
 */
function canonical(caseId: string, report: FrontierReport): string[] {
  const skillShape = (skill: FrontierReport['frontier'][number]) =>
    [skill.skillId, field(skill.name), skill.difficulty, skill.estimatedHours[0], skill.estimatedHours[1], skill.unlocks, bool(skill.meetsTarget)].join('|')
  const weeks = report.hours.weeksAtWeeklyHours
  const lines: string[] = []
  lines.push(`CASE\t${caseId}`)
  lines.push(
    [
      'COUNT',
      `targets=${report.targetCount}`,
      `closure=${report.closureCount}`,
      `known=${report.knownInClosure}`,
      `remaining=${report.remainingCount}`,
      `gates=${report.gates.length}`,
      `gatesUnlock=${report.gatesUnlock}`,
    ].join('\t'),
  )
  lines.push(`SUMMARY\t${field(report.summaryLine)}`)
  lines.push(`HOURS\t${report.hours.low}\t${report.hours.high}`)
  lines.push(`WEEKS\t${weeks ? weeks.low : 'none'}\t${weeks ? weeks.high : 'none'}\t${report.hours.weeklyHours ?? 'none'}`)
  lines.push(`FRONTIER\t${report.frontier.map(skillShape).join('\t')}`)
  lines.push(`GATES\t${report.gates.map(skillShape).join('\t')}`)
  lines.push(`CHAIN\t${report.criticalChain.map((node) => `${node.skillId}|${field(node.name)}`).join('\t')}`)
  lines.push(`DEPTHS\t${report.depths.map((row) => `${row.skillId}|${row.depth}`).join('\t')}`)
  lines.push(
    `REMAINING\t${report.remaining
      .map((skill) => [skill.skillId, skill.depth, skill.unlocks, bool(skill.meetsTarget), skill.needsNow.map(field).join(';')].join('|'))
      .join('\t')}`,
  )
  lines.push(`PULLED\t${report.pulledIn.map((skill) => `${skill.skillId}|${field(skill.name)}`).join('\t')}`)
  lines.push(`CYCLIC\t${report.cyclic.join(';')}`)
  lines.push(`CAVEATS\t${report.caveats.map(field).join('\t')}`)
  return lines
}

type Profile = { label: string; weeklyHours: number; rating: (index: number, total: number) => { state: SkillState; quizScore?: number } | null }

const PROFILES: Profile[] = [
  // A beginner: nothing rated at all. Every skill in the closure is work to do.
  { label: 'cold', weeklyHours: 8, rating: () => null },
  // Someone part-way through the career's own list, rated by the engine's own
  // vocabulary — and rated in *sorted* id order so the fixture is reproducible.
  { label: 'warm', weeklyHours: 12, rating: (index) => (index % 2 === 0 ? { state: 'learning' } : { state: 'practised' }) },
  // A specialist: most of the list is done, with a quiz-backed rating mixed in,
  // so the frontier is a small delta rather than a curriculum.
  { label: 'hot', weeklyHours: 20, rating: (index, total) => (index < total - 2 ? { state: 'confident' } : { state: 'practised', quizScore: 0.8 }) },
]

async function main(): Promise<void> {
  const reader = createLocalReader(knowledgeGraph as never)
  const careers = [...knowledgeGraph.careers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out: string[] = []
  out.push('#GRAPHMENTOR FRONTIER ORACLE FIXTURE v1')
  out.push('#Inputs are authoritative; the EXPECTED block was produced by src/../recommend.ts analyzeFrontier.')
  out.push('#Do not hand-edit: regenerate with `npm run oracle:export`.')
  out.push('')

  out.push('#constants — declared inputs, so the oracle checks algorithms and not policy numbers')
  out.push(`CONST\tprereqMetThreshold\t${ENGINE_LIMITS.prereqMetThreshold}`)
  out.push(`CONST\tmaxTraversal\t${ENGINE_LIMITS.maxTraversal}`)
  out.push(`CONST\tmaxSteps\t${ENGINE_LIMITS.maxSteps}`)
  out.push(`CONST\tdefaultHoursLow\t${ENGINE_LIMITS.defaultSkillHours[0]}`)
  out.push(`CONST\tdefaultHoursHigh\t${ENGINE_LIMITS.defaultSkillHours[1]}`)
  for (const [state, value] of Object.entries(STATE_TO_MASTERY)) {
    out.push(`CONST\tmastery.${state}\t${value}`)
  }
  out.push(`CONST\tcaveat.selfReport\t${field(CAVEATS.selfReport)}`)
  out.push(`CONST\tcaveat.estimates\t${field(CAVEATS.estimates)}`)
  out.push('')

  let cases = 0
  for (const career of careers) {
    const slice = await loadCareerSlice(reader as never, career.id, { depth: 6, maxSkills: 400 })
    const orderedIds = [...slice.careerSkills.map((skill) => skill.id)].sort()
    for (const profile of PROFILES) {
      const caseId = `${career.id}--${profile.label}`
      const ratings = orderedIds
        .map((skillId, index) => {
          const decision = profile.rating(index, orderedIds.length)
          return decision ? { skillId, state: decision.state, ...(decision.quizScore !== undefined ? { quizScore: decision.quizScore } : {}) } : null
        })
        .filter((rating): rating is { skillId: string; state: SkillState; quizScore?: number } => rating !== null)

      const report = analyzeFrontier({
        careerId: slice.careerId,
        careerName: slice.careerName,
        careerSkills: slice.careerSkills,
        skillMeta: slice.skillMeta,
        prereqEdges: slice.prereqEdges,
        ratings,
        interests: [],
        weeklyHours: profile.weeklyHours,
      })

      if (report.cyclic.length > 0) {
        throw new Error(
          `${caseId}: closure contains a prerequisite cycle (${report.cyclic.join(', ')}). ` +
            'Cycle members are ordered by the cyclic tail, where JS and Java collation may differ, so this case cannot be compared across languages. Fix the graph or exclude the case explicitly.',
        )
      }
      if (report.remainingCount === 0) {
        throw new Error(`${caseId}: no remaining skills, so the case proves almost nothing. Adjust the profile.`)
      }

      out.push(`#case ${caseId} (${profile.label}, ${profile.weeklyHours}h/week)`)
      out.push(`CASE\t${caseId}\t${field(career.name)}`)
      for (const skillId of orderedIds) {
        out.push(`TARGET\t${skillId}`)
      }
      for (const meta of [...slice.skillMeta].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        out.push(`SKILL\t${meta.id}\t${field(meta.name)}\t${meta.difficulty}\t${meta.estimatedHoursLow}\t${meta.estimatedHoursHigh}`)
      }
      for (const edge of slice.prereqEdges) {
        if (edge.type !== 'REQUIRES') continue
        out.push(`EDGE\t${edge.from}\t${edge.to}`)
      }
      for (const rating of ratings) {
        out.push(`RATING\t${rating.skillId}\t${rating.state}\t${rating.quizScore ?? 'none'}`)
      }
      out.push(`WEEKLY\t${profile.weeklyHours}`)
      out.push('#EXPECTED')
      out.push(...canonical(caseId, report))
      out.push('')
      cases += 1
    }
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(outFile, `${out.join('\n')}\n`, 'utf8')
  console.log(`Wrote ${outFile.replace(resolve(here, '..'), '.')} — ${cases} case(s) across ${careers.length} career(s).`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})


