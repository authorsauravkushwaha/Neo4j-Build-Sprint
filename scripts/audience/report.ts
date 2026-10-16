/**
 * Stage 4 of the audience simulation: the report.
 *
 * MiroFish ends with a ReportAgent that plans an outline, queries the simulated
 * world and writes sections. This does the same shape — a summary plus sections —
 * but every sentence is derived from the simulation JSON, and every round is
 * archived so the next round can be compared with it. That comparison is the point:
 * a simulation you can only run once is an opinion with extra steps.
 *
 * Output:
 *   tools/audience/rounds/<timestamp>.json   (archived, immutable)
 *   docs/audience-simulation.md              (latest round + what changed)
 *
 * Run: npm run audience   (measure → simulate → report)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSimulation } from './simulate.ts'
import type { FactSheet, SimulationReport } from './types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FACTS = resolve(root, 'tools/audience/measured-facts.json')
const ROUNDS = resolve(root, 'tools/audience/rounds')
const DOC = resolve(root, 'docs/audience-simulation.md')

function previousRound(): { round: number; report: SimulationReport; facts: FactSheet } | null {
  if (!existsSync(ROUNDS)) return null
  const files = readdirSync(ROUNDS).filter((name) => name.endsWith('.json')).sort()
  if (files.length === 0) return null
  const latest = files[files.length - 1] as string
  const parsed = JSON.parse(readFileSync(resolve(ROUNDS, latest), 'utf8')) as { round: number; report: SimulationReport; facts: FactSheet }
  return parsed
}

function factTable(sheet: FactSheet): string {
  const rows = Object.values(sheet.facts).map((fact) => {
    const value = Array.isArray(fact.value) ? fact.value.join(', ') : String(fact.value)
    return `| \`${fact.id}\` | ${fact.label} | ${truncate(value, 150)} | ${fact.source} |`
  })
  return ['| Fact | What it is | Measured value | Source |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

function personaTable(report: SimulationReport): string {
  const rows = report.traces.map((trace) => {
    const persona = trace.persona
    const outcome = trace.droppedAt ? `left at **${trace.droppedAt}**` : `survived${trace.stages.some((stage) => stage.stance === 'hesitate') ? ' (with reservations)' : ''}`
    return `| ${persona.name}, ${persona.age} — ${persona.profession} | ${persona.device} | ${persona.patienceSeconds}s / ${persona.maxClicks} clicks | ${persona.skeptic} | ${outcome} | ${trace.persona.reach.toFixed(2)} |`
  })
  return [
    '| Persona | Device | Patience / click budget | Skepticism | Outcome | Modelled reach |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

function tracesSection(report: SimulationReport): string {
  return report.traces
    .map((trace) => {
      const lines = trace.stages
        .map((stage) => `  - \`${stage.stage}\` — **${stage.stance}**: "${stage.quote}"${stage.evidence.length > 0 ? ` _(facts: ${stage.evidence.join(', ')})_` : ' _(no measurement: a structural judgement about arrival)_'}`)
        .join('\n')
      return [
        `### ${trace.persona.name} — ${trace.verdict}`,
        '',
        `> ${trace.persona.bio}`,
        '',
        `Goal: ${trace.persona.goal}`,
        '',
        lines,
        ...(trace.wouldReturnIf.length > 0 ? ['', `Would come back if: ${trace.wouldReturnIf.join(' ')}`] : []),
      ].join('\n')
    })
    .join('\n\n')
}

function delta(previous: { round: number; report: SimulationReport; facts: FactSheet } | null, current: SimulationReport, sheet: FactSheet): string {
  if (!previous) {
    return 'First recorded round — nothing to compare against yet. The next run will report what moved and what did not.'
  }
  const before = new Set(previous.report.traces.filter((trace) => trace.droppedAt === null).map((trace) => trace.persona.id))
  const after = new Set(current.traces.filter((trace) => trace.droppedAt === null).map((trace) => trace.persona.id))
  const gained = [...after].filter((id) => !before.has(id))
  const lost = [...before].filter((id) => !after.has(id))

  const changedFacts = Object.keys(sheet.facts).filter((id) => {
    const now = JSON.stringify(sheet.facts[id]?.value)
    const then = JSON.stringify(previous.facts.facts[id]?.value)
    return now !== then
  })

  const resolvedFindings = previous.report.findings
    .filter((finding) => finding.kind === 'weakness' && !current.findings.some((now) => now.id === finding.id))
    .map((finding) => finding.title)
  const newFindings = current.findings
    .filter((finding) => finding.kind === 'weakness' && !previous.report.findings.some((then) => then.id === finding.id))
    .map((finding) => finding.title)

  const rows = [
    `Round ${previous.round} → round ${previous.round + 1}.`,
    '',
    `- Survivors: ${before.size} → ${after.size}${gained.length > 0 ? ` (gained: ${gained.join(', ')})` : ''}${lost.length > 0 ? ` (lost: ${lost.join(', ')})` : ''}`,
    `- Findings removed by the change: ${resolvedFindings.length > 0 ? resolvedFindings.map((title) => `"${title}"`).join('; ') : 'none'}`,
    `- Findings newly surfaced: ${newFindings.length > 0 ? newFindings.map((title) => `"${title}"`).join('; ') : 'none'}`,
    `- Measured facts that moved: ${changedFacts.length > 0 ? changedFacts.map((id) => `\`${id}\``).join(', ') : 'none'}`,
    '',
    '### What moved, fact by fact',
    '',
    '| Fact | Before | After |',
    '| --- | --- | --- |',
    ...changedFacts.map((id) => {
      const then = previous.facts.facts[id]?.value
      const now = sheet.facts[id]?.value
      return `| \`${id}\` | ${truncate(String(then), 90)} | ${truncate(String(now), 90)} |`
    }),
  ]
  return rows.join('\n')
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

function render(round: number, report: SimulationReport, sheet: FactSheet, deltaText: string): string {
  const survivors = report.traces.filter((trace) => trace.droppedAt === null)
  const weaknesses = report.findings.filter((finding) => finding.kind === 'weakness')
  const strengths = report.findings.filter((finding) => finding.kind === 'strength')

  return `# Audience simulation — round ${round}

> **This is a model, not user research.** Fourteen personas with declared parameters
> were run through a seven-stage funnel against facts measured from this build. No
> real person was observed, surveyed or interviewed. It cannot tell you whether
> people will use the product; it can tell you which of your own claims are legible,
> where the friction is, and which stated assumption drives which result. The
> honesty rules of this repository apply to this document as well: every number below
> is either measured (and re-runnable with \`npm run audience\`) or explicitly labelled
> as a modelled weight.

Method: the pipeline is MiroFish's (seed extraction → persona generation →
simulation → report agent), with one substitution — the LLM agents are replaced by
deterministic predicates over a measured fact sheet, because this project has no AI
key and because a reaction you cannot audit is a reaction you cannot act on. What is
kept: the persona schema (\`OasisAgentProfile\`: name, bio, age, profession, interests,
social reach). What is lost: emergence. Nothing here models a review thread changing
somebody's mind. See [tools/audience/README.md](../tools/audience/README.md).

Measured: **${sheet.generatedAt}** · base URL \`${sheet.baseUrl}\` · conditions:
${sheet.conditions.network}; ${sheet.conditions.cpu}; ${sheet.conditions.cache}.

## Summary

${report.summary}

## The answer to "who is the audience", from the model

| Segment | Survives | Modelled condition for staying |
| --- | --- | --- |
${report.audienceVerdict.map((row) => `| ${row.segment} | ${row.survives}/${row.total} — ${row.personas.join(', ') || 'none'} | ${row.condition} |`).join('\n')}

## Where journeys ended

| Stage | Personas that left | Who |
| --- | --- | --- |
${report.dropOff.map((row) => `| ${row.stage}${row.stage === 'reasons-to-come-back' ? ' *(survived)*' : ''} | ${row.count} | ${row.personas.join(', ') || '—'} |`).join('\n')}

## Weaknesses, ranked by modelled severity

${weaknesses
  .map(
    (finding, index) => `### ${index + 1}. ${finding.title}

*Severity ${finding.severity} (modelled: share of persona reach affected) · costs ${finding.personas.length} persona(s): ${finding.personas.join(', ')}*

${finding.detail}

**Fix:** ${finding.fix ?? '—'}

*Evidence:* ${finding.evidence.map((id) => `\`${id}\``).join(', ')}
`,
  )
  .join('\n')}

## Strengths, with the same evidence standard

${strengths
  .map(
    (finding) => `### ${finding.title}

*Severity ${finding.severity} (modelled) · carried by ${finding.personas.length} persona(s): ${finding.personas.join(', ')}*

${finding.detail}

*Evidence:* ${finding.evidence.map((id) => `\`${id}\``).join(', ')}
`,
  )
  .join('\n')}

## Objections the personas actually raised, and what would remove each

| Objection | Personas | Concrete fix |
| --- | --- | --- |
${report.objections.map((objection) => `| ${objection.theme} | ${objection.personas.length} — ${objection.personas.join(', ')} | ${objection.fix} |`).join('\n')}

## What changed since the previous round

${deltaText}

## The personas and their runs

${personaTable(report)}

## Every run, in the persona's own voice

${tracesSection(report)}

## The measured fact sheet this ran on

${factTable(sheet)}

## Caveats

${report.caveats.map((caveat) => `- ${caveat}`).join('\n')}

## How to re-run

\`\`\`bash
npm run preview          # serve the build (or npm run dev, with BASE_URL=http://127.0.0.1:5173)
npm run audience         # measure → simulate → report, writing this document
\`\`\`

Every round is archived under \`tools/audience/rounds/\`, so the diff above is
reproducible rather than remembered. The persona parameters live in
\`scripts/audience/personas.ts\`; the rules live in \`scripts/audience/simulate.ts\`; the
measurements live in \`scripts/audience/measure.ts\`. Argue with any of them, change
one number, and re-run — a model you cannot disagree with in code is a horoscope.
`
}

/**
 * Every evidence id must resolve. The fact lookup throws on an unknown id when a
 * rule *reads* a fact, but evidence is only *cited* — so a stale id would print a
 * confident "(facts: a11y.reducedMotion)" next to a claim while nothing behind it
 * exists in the sheet. Two of those shipped in round 1. This closes that hole: an
 * unresolvable citation fails the run instead of decorating the report.
 */
function citedEvidence(report: SimulationReport): Map<string, string[]> {
  const cited = new Map<string, string[]>()
  const note = (id: string, where: string): void => {
    cited.set(id, [...(cited.get(id) ?? []), where])
  }
  for (const finding of report.findings) {
    for (const id of finding.evidence) note(id, `finding "${finding.title}"`)
  }
  for (const trace of report.traces) {
    for (const stage of trace.stages) {
      for (const id of stage.evidence) note(id, `${trace.persona.id} at ${stage.stage}`)
    }
  }
  return cited
}

function assertEvidenceResolves(report: SimulationReport, sheet: FactSheet): void {
  const missing = [...citedEvidence(report)]
    .filter(([id]) => !(id in sheet.facts))
    .map(([id, where]) => `  - ${id}  (cited by ${[...new Set(where)].slice(0, 3).join('; ')})`)
  if (missing.length > 0) {
    console.error(`\n${missing.length} evidence id(s) do not exist in ${FACTS}:`)
    console.error(missing.join('\n'))
    console.error('\nEither measure the fact, or stop citing it — a citation that resolves to nothing is decoration.')
    process.exit(1)
  }
  const unused = Object.keys(sheet.facts).filter((id) => !citedEvidence(report).has(id))
  if (unused.length > 0) {
    console.log(`Note: ${unused.length} measured fact(s) are not cited by any finding or stage: ${unused.join(', ')}`)
  }
}

function main(): void {
  if (!existsSync(FACTS)) {
    console.error('No measured facts. Run `npm run audience:measure` first.')
    process.exit(1)
  }
  const sheet = JSON.parse(readFileSync(FACTS, 'utf8')) as FactSheet
  const report = runSimulation(sheet)
  assertEvidenceResolves(report, sheet)
  const previous = previousRound()
  const round = (previous?.round ?? 0) + 1

  mkdirSync(ROUNDS, { recursive: true })
  const stamp = report.generatedAt.replace(/[:.]/g, '-')
  writeFileSync(resolve(ROUNDS, `${stamp}.json`), `${JSON.stringify({ round, report, facts: sheet }, null, 2)}\n`, 'utf8')

  const deltaText = delta(previous, report, sheet)
  writeFileSync(DOC, render(round, report, sheet, deltaText), 'utf8')

  const survivors = report.traces.filter((trace) => trace.droppedAt === null).length
  console.log(`\nRound ${round}: ${survivors}/${report.traces.length} personas survive; ${report.findings.filter((f) => f.kind === 'weakness').length} weaknesses, ${report.findings.filter((f) => f.kind === 'strength').length} strengths.`)
  console.log('Report: docs/audience-simulation.md   Archive: tools/audience/rounds/')
}

main()


