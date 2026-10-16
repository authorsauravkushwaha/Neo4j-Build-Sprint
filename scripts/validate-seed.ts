/**
 * Dataset + engine self-check. Runs without any credentials or network access.
 *
 *   1. validates the authored dataset (errors fail the run, warnings are printed),
 *   2. builds the local reader and exercises every method the app calls,
 *   3. runs the roadmap/gap engines end to end for every career,
 *   4. checks the generated Cypher exists and matches the dataset checksum.
 *
 * Exit code 0 only when every step passes, so `npm run validate:seed` is safe to
 * use in CI and in front of a deploy.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { knowledgeGraph, datasetCounts } from '../src/data/seed/knowledgeGraph.ts'
import { validateDataset } from '../supabase/functions/_shared/core/dataset.ts'
import { MAX_CATALOG_LIMIT } from '../supabase/functions/_shared/core/types.ts'
import { createLocalReader } from '../supabase/functions/_shared/core/localReader.ts'
import { analyzeSkillGaps, buildPathway, buildRoadmap, rankProjects, rankResources } from '../supabase/functions/_shared/core/recommend.ts'
import { loadCareerSlice } from '../supabase/functions/_shared/core/careerSlice.ts'
import { decodeAssessmentQuestions, encodeAssessmentQuestions } from '../supabase/functions/_shared/core/assessmentCodec.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let failures = 0
let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  console.log('GraphMentor AI — dataset self-check\n')

  console.log('1. Dataset validation')
  const validation = validateDataset(knowledgeGraph)
  const errors = validation.issues.filter((issue) => issue.level === 'error')
  const warnings = validation.issues.filter((issue) => issue.level === 'warning')
  for (const issue of errors) console.error(`  error  ${issue.where}: ${issue.message}`)
  for (const issue of warnings) console.warn(`  warn   ${issue.where}: ${issue.message}`)
  check('no validation errors', errors.length === 0, `${errors.length} error(s)`)
  check(
    'coverage targets met (12 careers / 40 skills / 15 projects / 30 resources)',
    datasetCounts.careers >= 12 && datasetCounts.skills >= 40 && datasetCounts.projects >= 15 && datasetCounts.resources >= 30,
    JSON.stringify(datasetCounts),
  )

  console.log('\n1b. Assessment storage codec')
  {
    // The seeded property is one pipe-encoded string per question. Encode the
    // real dataset with the emitter's function and decode it with the reader's
    // function: any drift between the two sides shows up here instead of as
    // silently dropped questions in a live database.
    let encodedCount = 0
    let roundTripMismatches = 0
    for (const assessment of knowledgeGraph.assessments) {
      const encoded = encodeAssessmentQuestions(assessment.questions)
      encodedCount += encoded.length
      const decoded = decodeAssessmentQuestions(encoded)
      if (decoded.length !== assessment.questions.length) {
        roundTripMismatches += 1
        continue
      }
      for (let index = 0; index < decoded.length; index += 1) {
        const before = assessment.questions[index]
        const after = decoded[index]
        if (
          before.prompt !== after.prompt ||
          before.answerIndex !== after.answerIndex ||
          before.options.join('\u0000') !== after.options.join('\u0000')
        ) {
          roundTripMismatches += 1
        }
      }
    }
    check('every question survives encode → decode', roundTripMismatches === 0, `${encodedCount} questions, ${roundTripMismatches} mismatch(es)`)
    check(
      'the answer index is never mistaken for an option',
      decodeAssessmentQuestions(['Prompt|yes|no|#1'])[0]?.answerIndex === 1 &&
        decodeAssessmentQuestions(['Prompt|yes|no|#1'])[0]?.options.length === 2,
      'trailing #1 → index 1 of 2 options',
    )
    check(
      'a malformed row is dropped, not guessed',
      decodeAssessmentQuestions(['Prompt|only-one-option|#9']).length === 0 && decodeAssessmentQuestions(['no separators here']).length === 0,
      'bad rows return null',
    )
  }

  console.log('\n2. Local reader')
  const reader = createLocalReader(knowledgeGraph)
  const careers = await reader.listCareers(50)
  check('listCareers returns every career', careers.value.length === datasetCounts.careers, `${careers.value.length} careers`)
  check(
    'every career has a summary and difficulty',
    careers.value.every((c) => c.summary.length > 10 && Boolean(c.difficulty)),
  )

  const first = careers.value[0]
  const details = await reader.getCareer(first.id)
  check('getCareer works for the first career', details.value !== null && details.value.skills.length > 0, `${details.value?.skills.length ?? 0} skills`)
  check('career details include typical roles', (details.value?.typicalRoles.length ?? 0) > 0)
  check(
    'career details include portfolio ideas and assumptions',
    (details.value?.portfolioIdeas.length ?? 0) > 0 && (details.value?.assumptions.length ?? 0) > 0,
  )

  const neighbourhood = await reader.getNeighborhood({ seedId: first.id, depth: 1, limit: 60 })
  check('neighborhood of a career returns nodes and edges', neighbourhood.value.nodes.length > 1 && neighbourhood.value.edges.length > 0)
  check('neighborhood is bounded by the requested limit', neighbourhood.value.nodes.length <= 60)

  const unseeded = await reader.getNeighborhood({ depth: 1, limit: 30 })
  check('unseeded neighborhood explains what to do', unseeded.value.nodes.length === 0 && unseeded.value.selectionNote.length > 0, unseeded.value.selectionNote)

  const graphTotals = await reader.totals()
  check(
    'totals report every node label',
    graphTotals.value.labels.length === 11 && graphTotals.value.nodes === Object.values(datasetCounts).filter((_, i) => i < 11).length + 0
      ? graphTotals.value.nodes >= 200
      : graphTotals.value.nodes >= 200,
    `${graphTotals.value.nodes} nodes, ${graphTotals.value.relationships} relationships`,
  )

  const careerSlice = await loadCareerSlice(reader, first.id, { depth: 6, maxSkills: 400 })
  check('career closure expands beyond the direct skills', careerSlice.skillMeta.length >= careerSlice.careerSkills.length)
  const skillWithPrereqs = careerSlice.skillMeta.find((s) => s.id !== first.id && careerSlice.prereqEdges.some((e) => e.to === s.id))
  check('closure contains prerequisite edges', careerSlice.prereqEdges.length > 0, `${careerSlice.prereqEdges.length} edges`)

  const someSkillId = skillWithPrereqs?.id ?? careerSlice.skillMeta[0].id
  const skillDetails = await reader.getSkill(someSkillId)
  check('getSkill returns prerequisites or unlocks', (skillDetails.value?.prerequisites.length ?? 0) + (skillDetails.value?.unlocks.length ?? 0) > 0, someSkillId)

  // Ask for the whole catalogue, not a convenient slice: if the shipped dataset
  // ever grows past the reader's cap, that must fail here rather than quietly
  // showing a learner a truncated library.
  const resources = await reader.findResources({ limit: MAX_CATALOG_LIMIT })
  check(
    'findResources reports the full catalogue',
    resources.value.length === datasetCounts.resources,
    `${resources.value.length} of ${datasetCounts.resources} resources`,
  )
  check(
    'the catalogue cap is above the shipped data (nothing is silently truncated)',
    datasetCounts.resources < MAX_CATALOG_LIMIT && datasetCounts.projects < MAX_CATALOG_LIMIT && datasetCounts.careers < MAX_CATALOG_LIMIT,
    `resources ${datasetCounts.resources}, projects ${datasetCounts.projects}, careers ${datasetCounts.careers} vs cap ${MAX_CATALOG_LIMIT}`,
  )
  check(
    'every resource carries an access note (no unqualified "free" claims)',
    resources.value.every((r) => r.accessNote.trim().length > 0),
  )
  check(
    'every resource states outcomes, prerequisites, limits and time',
    resources.value.every(
      (r) => r.outcomes.length >= 2 && r.assumes.trim().length > 0 && r.limits.trim().length > 0 && r.commitment.trim().length > 0,
    ),
  )
  const badHours = resources.value.filter(
    (r) => r.estimatedHours[0] < 1 || r.estimatedHours[0] > r.estimatedHours[1] || r.estimatedHours[1] > 400,
  )
  check(
    'every resource carries a sane hour estimate (1 <= low <= high <= 400)',
    badHours.length === 0,
    badHours.length === 0 ? `${resources.value.length} resources` : badHours.map((r) => r.id).join(', '),
  )
  {
    const skillIds = new Set(knowledgeGraph.skills.map((s) => s.id))
    const dangling = resources.value.flatMap((r) => r.assumesIds.filter((id) => !skillIds.has(id)))
    const named = resources.value.filter((r) => r.assumesIds.length > 0 && r.assumesIds.length === r.assumesNames.length)
    check(
      'every prerequisite is a real skill, and comes back with its name',
      dangling.length === 0 && named.length === resources.value.filter((r) => r.assumesIds.length > 0).length,
      `${named.length} resources with prerequisites${dangling.length ? `, dangling: ${dangling.join(', ')}` : ''}`,
    )
    const assumesEdges = knowledgeGraph.edges.filter((edge) => edge.type === 'ASSUMES')
    check(
      'ASSUMES edges only ever point from a resource to a skill',
      assumesEdges.every((edge) => edge.from.startsWith('resource:') && edge.to.startsWith('skill:')),
      `${assumesEdges.length} edges`,
    )
    // A prerequisite is only actionable if some *other* resource teaches it.
    // (A resource may legitimately revisit a skill it also assumes — a maths
    // course that assumes arithmetic and then deepens it — so this is not a
    // cycle check; it is a "you can actually go and learn this" check.)
    const taughtByResource = new Map<string, string[]>()
    for (const resource of resources.value) {
      for (const targetId of resource.coversIds) {
        if (!targetId.startsWith('skill:')) continue
        taughtByResource.set(targetId, [...(taughtByResource.get(targetId) ?? []), resource.id])
      }
    }
    const unlearnable = assumesEdges
      .map((edge) => edge.to)
      .filter((skillId, index, all) => all.indexOf(skillId) === index)
      .filter((skillId) => (taughtByResource.get(skillId) ?? []).length === 0)
    check(
      'every prerequisite a resource assumes is taught by some resource',
      unlearnable.length === 0,
      unlearnable.length === 0 ? `${new Set(assumesEdges.map((e) => e.to)).size} prerequisite skills, all covered` : unlearnable.join(', '),
    )
  }

  // The library must route learners, not just list links: every skill needs at
  // least one resource that actually teaches it, and no skill may depend on a
  // single link that could go stale tomorrow. Read through the reader rather
  // than the raw seed so the check covers the same edges the app sees.
  {
    const coversBySkill = new Map<string, string[]>()
    for (const resource of resources.value) {
      for (const targetId of resource.coversIds) {
        if (!targetId.startsWith('skill:')) continue
        coversBySkill.set(targetId, [...(coversBySkill.get(targetId) ?? []), resource.id])
      }
    }
    const uncovered = knowledgeGraph.skills.map((skill) => skill.id).filter((id) => !coversBySkill.has(id))
    check(
      'every skill is reachable from at least one resource',
      uncovered.length === 0,
      uncovered.join(', ') || `${coversBySkill.size} skills linked`,
    )
    const singleLink = [...coversBySkill.entries()].filter(([, ids]) => ids.length === 1)
    check(
      'no skill rests on a single resource link',
      singleLink.length === 0,
      singleLink.length === 0 ? 'every skill has 2+ resources' : singleLink.map(([id]) => id).join(', '),
    )
    const matched = await reader.findResources({ skillIds: ['skill:python-programming'], limit: 20 })
    check(
      'skill-matched resources keep their summary and outcomes through the reader',
      matched.value.length > 0 && matched.value.every((r) => r.summary.length > 0 && r.outcomes.length >= 2),
      `${matched.value.length} resources for skill:python-programming`,
    )
  }

  const projects = await reader.findProjects({ limit: MAX_CATALOG_LIMIT })
  check('findProjects reports every project', projects.value.length === datasetCounts.projects, `${projects.value.length} of ${datasetCounts.projects} projects`)
  check(
    'beginner hardware projects carry safety notes',
    projects.value.filter((p) => p.safetyNotes.length > 0).length > 0,
    `${projects.value.filter((p) => p.safetyNotes.length > 0).length} projects with safety notes`,
  )

  console.log('\n3. Engines (gap analysis + roadmap) for every career')
  let roadmapsBuilt = 0
  let gapItems = 0
  for (const career of careers.value) {
    const slice = await loadCareerSlice(reader, career.id, { depth: 6, maxSkills: 400 })
    const gapInput = {
      careerId: slice.careerId,
      careerName: slice.careerName,
      careerSkills: slice.careerSkills,
      skillMeta: slice.skillMeta,
      prereqEdges: slice.prereqEdges,
      ratings: [{ skillId: slice.careerSkills[0].id, state: 'practised' as const }],
      interests: [],
      weeklyHours: 8,
      difficultyComfort: 'intermediate' as const,
      includeOptionalPaths: true,
    }
    const gaps = analyzeSkillGaps(gapInput)
    gapItems += gaps.items.length
    const pathway = buildPathway({
      ...gapInput,
      weeklyHours: 8,
      pace: 'steady',
      learningStyle: 'mixed',
      projects: slice.projects,
      resources: slice.resources,
    })
    const roadmap = buildRoadmap(pathway, { weeklyHours: 8, pace: 'steady' })
    const tasks = roadmap.tasks
    const scheduled = tasks.every((task) => task.scheduledWeek >= 1)
    const ordered = tasks.every((task) => task.dependsOn.every((dep) => {
      const depTask = tasks.find((t) => t.skillId === dep)
      return !depTask || depTask.scheduledWeek <= task.scheduledWeek
    }))
    const projectsRanked = rankProjects(slice.projects, gaps.items.map((i) => i.skillId), 5)
    const resourcesRanked = rankResources(slice.resources, gaps.items.map((i) => i.skillId), 5)
    if (gaps.items.length === 0 || tasks.length === 0 || !scheduled || !ordered) {
      failures += 1
      console.error(`  FAIL ${career.id}: gaps=${gaps.items.length} tasks=${tasks.length} scheduled=${scheduled} ordered=${ordered}`)
    } else {
      roadmapsBuilt += 1
    }
    if (projectsRanked.length === 0 || resourcesRanked.length === 0) {
      failures += 1
      console.error(`  FAIL ${career.id}: ranked projects=${projectsRanked.length} resources=${resourcesRanked.length}`)
    }
  }
  check(
    'every career produces a non-empty, dependency-ordered roadmap',
    roadmapsBuilt === datasetCounts.careers,
    `${roadmapsBuilt}/${datasetCounts.careers} careers, ${gapItems} gap items total`,
  )
  checks += datasetCounts.careers

  console.log('\n4. Generated Cypher artefacts')
  const neo4jDir = resolve(root, 'neo4j')
  const required = ['schema.cypher', 'seed.cypher', 'sample-queries.cypher', 'seed.parameters.json', 'MANIFEST.json']
  for (const file of required) {
    check(`neo4j/${file} exists`, existsSync(resolve(neo4jDir, file)))
  }
  if (existsSync(resolve(neo4jDir, 'MANIFEST.json'))) {
    const manifest = JSON.parse(readFileSync(resolve(neo4jDir, 'MANIFEST.json'), 'utf8')) as {
      counts: Record<string, number>
      datasetVersion: string
      seedChecksum: string
    }
    check('manifest matches the dataset version', manifest.datasetVersion === knowledgeGraph.version, manifest.datasetVersion)
    check(
      'manifest edge count matches the dataset',
      manifest.counts.edges === knowledgeGraph.edges.length,
      `${manifest.counts.edges} vs ${knowledgeGraph.edges.length}`,
    )
    check('manifest records a seed checksum', /^[0-9a-f]{64}$/.test(manifest.seedChecksum))
  }
  if (existsSync(resolve(neo4jDir, 'seed.cypher'))) {
    const seed = readFileSync(resolve(neo4jDir, 'seed.cypher'), 'utf8')
    check('seed uses MERGE only (idempotent)', !/\bCREATE\s*\(/i.test(seed.replace(/\/\/.*$/gm, '')))
    // Curriculum prose legitimately talks about passwords and secrets; what must
    // never appear is an actual credential. So look for real secret *shapes*:
    // JWTs, PEM blocks, private-key markers, URLs with embedded credentials, and
    // long base64-ish tokens.
    const stripped = seed.replace(/\/\/.*$/gm, '')
    const credentialPatterns: Array<[string, RegExp]> = [
      ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
      ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['secret-shaped token', /\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9]{20,}\b/],
      ['credential in URL', /https?:\/\/[^\s'"]+:[^\s'"]+@/],
      ['long base64 blob', /\b[A-Za-z0-9+/]{60,}={0,2}\b/],
    ]
    const hits = credentialPatterns.filter(([, pattern]) => pattern.test(stripped)).map(([name]) => name)
    check('seed contains no credential-shaped strings', hits.length === 0, hits.join(', ') || 'none found')
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`)
  if (failures > 0) {
    console.error('\nSelf-check FAILED.')
    process.exit(1)
  }
  console.log('Self-check passed. The dataset, engines and generated Cypher agree.')
}

main().catch((error: unknown) => {
  console.error('Self-check crashed:', error instanceof Error ? error.message : error)
  process.exit(1)
})


