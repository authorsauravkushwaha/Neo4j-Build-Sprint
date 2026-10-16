/**
 * Stage 3 of the audience simulation: the run.
 *
 * MiroFish runs thousands of LLM agents for many rounds and lets behaviour emerge.
 * This runs 14 personas through a declared seven-stage funnel, once, with every
 * decision written as a predicate over the measured fact sheet. The trade is
 * deliberate and worth stating plainly:
 *
 *   - what this keeps: reproducibility (same facts in, same report out), an audit
 *     trail (every objection cites the fact that caused it), and zero API keys;
 *   - what it loses: surprise. A persona here cannot notice something nobody
 *     thought to measure. Emergent social dynamics — a review thread changing
 *     minds, a competitor's tweet, word of mouth compounding — are absent.
 *
 * So the output is not "how people will react". It is "which of our own claims are
 * legible, where the friction is, and which stated assumptions drive the result",
 * which is the part a team can act on before anyone uses the thing.
 *
 * Run: npm run audience
 */
import { PERSONAS, SEGMENTS } from './personas.ts'
import type { FactSheet, Finding, FunnelStage, ObjectionTheme, Persona, PersonaTrace, SimulationReport, StageResult, Stance } from './types.ts'

/* ------------------------------------------------------------------ plumbing */

class Facts {
  private readonly byId: Record<string, import('./types.ts').MeasuredFact>
  constructor(sheet: FactSheet) {
    this.byId = sheet.facts
  }
  raw(id: string): import('./types.ts').MeasuredFact {
    const fact = this.byId[id]
    if (!fact) throw new Error(`Simulation asked for a fact that was never measured: ${id}. Re-run npm run audience:measure.`)
    return fact
  }
  num(id: string): number {
    const value = this.raw(id).value
    if (typeof value !== 'number') throw new Error(`Fact ${id} is not a number: ${JSON.stringify(value)}`)
    return value
  }
  text(id: string): string {
    const value = this.raw(id).value
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  bool(id: string): boolean {
    const value = this.raw(id).value
    if (typeof value !== 'boolean') throw new Error(`Fact ${id} is not a boolean: ${JSON.stringify(value)}`)
    return value
  }
}

/** Ordered funnel. A bounce ends the journey; a hesitation is recorded and continues. */
const TERMINAL_STAGE: FunnelStage = 'reasons-to-come-back'

const STAGES: FunnelStage[] = [
  'arrives',
  'first-five-seconds',
  'understands-what-it-is',
  'sees-it-is-for-them',
  'trusts-it-enough-to-try',
  'reaches-a-real-answer',
  'reasons-to-come-back',
]

type StageFn = (persona: Persona, facts: Facts) => StageResult

/* --------------------------------------------------- what the product has today */

/**
 * Arrival is modelled honestly rather than assumed. A channel is "available" only
 * if something in the measurement supports it: a repository and a running build
 * that a person can be sent to. Nothing here shows a public domain, search
 * indexing, an app-store listing or a mailing list, so search-driven and
 * store-driven arrivals are marked unproven — not impossible, unproven.
 */
const AVAILABLE_ARRIVAL: Array<{ pattern: RegExp; status: 'available' | 'unproven'; because: string }> = [
  { pattern: /word of mouth from a (mentor|teacher)/i, status: 'available', because: 'a mentor or teacher can send the link to a running build; nothing more is needed' },
  { pattern: /github|technical communities/i, status: 'available', because: 'the project is a repository with a one-command local run and a verification suite' },
  { pattern: /^search:/i, status: 'unproven', because: 'no public host, no indexing and no ranking evidence exists in this build; being findable is an assumption, not a measurement' },
  { pattern: /app store/i, status: 'unproven', because: 'no store listing exists — the Android build is unverified (docs/verification.md §5)' },
]

const stageArrives: StageFn = (persona) => {
  const statuses = persona.arrivalChannels.map((channel) => {
    const match = AVAILABLE_ARRIVAL.find((entry) => entry.pattern.test(channel))
    return { channel, status: match?.status ?? ('unproven' as const), because: match?.because ?? 'no evidence for this channel' }
  })
  const available = statuses.filter((entry) => entry.status === 'available')
  if (available.length > 0) {
    return {
      stage: 'arrives',
      stance: 'pass',
      evidence: [],
      quote: `Someone would have to hand me this — I would not find it on my own (${available.map((entry) => entry.channel).join(', ')}).`,
    }
  }
  return {
    stage: 'arrives',
    stance: 'bounce',
    evidence: [],
    quote: `I only arrive through ${statuses.map((entry) => entry.channel).join(' or ')}, and nothing in this build shows that path exists.`,
  }
}

const stageFirstSeconds: StageFn = (persona, facts) => {
  const slow = persona.device === 'slow-mobile'
  const lcp = slow ? facts.num('perf.landingLcpSlow') : facts.num('perf.landingLcpDesktop')
  const budgetMs = persona.patienceSeconds * 1000
  const jsKB = facts.num('perf.landingJsKB')
  const evidence = [slow ? 'perf.landingLcpSlow' : 'perf.landingLcpDesktop', 'perf.landingJsKB']

  if (slow) {
    // Emeka pays for his data by the gigabyte, so bytes are part of patience.
    if (jsKB > 250) {
      return {
        stage: 'first-five-seconds',
        stance: persona.patienceSeconds <= 12 ? 'bounce' : 'hesitate',
        evidence: [...evidence, 'perf.entryBundleKB'],
        quote: `That is ${jsKB} KB of JavaScript before the page is even useful — I budget my data in weeks, not gigabytes.`,
      }
    }
  }
  if (lcp > budgetMs) {
    return { stage: 'first-five-seconds', stance: 'bounce', evidence, quote: `${lcp} ms is longer than the ${persona.patienceSeconds} seconds I give a page.` }
  }
  if (lcp > budgetMs * 0.3) {
    return { stage: 'first-five-seconds', stance: 'hesitate', evidence, quote: `It appeared in ${(lcp / 1000).toFixed(1)} s — tolerable, but I nearly left.` }
  }
  return { stage: 'first-five-seconds', stance: 'pass', evidence, quote: `It was there in ${(lcp / 1000).toFixed(1)} s. Nothing to complain about.` }
}

const stageUnderstands: StageFn = (persona, facts) => {
  const firstScreen =
    persona.device === 'slow-mobile'
      ? facts.text('landing.slowFirstScreen')
      : persona.device === 'mobile'
        ? facts.text('landing.mobileFirstScreen')
        : facts.text('landing.firstScreen')
  const h1 = facts.text('landing.h1')

  const saysWhat = /\b(knowledge graph|graph|career|skill[- ]gap|roadmap|prerequisite)\b/i.test(firstScreen)
  const saysWho = /\b(beginner|from scratch|no account|guest|student|career|you|engineer)\b/i.test(firstScreen)
  const saysWhatYouGet = /\b(roadmap|gap|step|plan|what am I actually missing|what has to come first)\b/i.test(firstScreen)
  const leadsWithAbstraction = /as a graph|knowledge graph|dependency-aware/i.test(h1 + ' ' + firstScreen.slice(0, 200))
  const evidence = ['landing.firstScreen', 'landing.h1']

  if (!saysWhat) {
    return { stage: 'understands-what-it-is', stance: 'bounce', evidence, quote: 'After one screen I still could not say what this is.' }
  }
  if (leadsWithAbstraction && persona.skeptic !== 'high' && persona.maxClicks <= 3) {
    return {
      stage: 'understands-what-it-is',
      stance: 'hesitate',
      evidence,
      quote: `"${h1}" — a graph is how you built it, not what I get. I had to read three lines to find out it plans a career.`,
    }
  }
  if (!saysWho || !saysWhatYouGet) {
    return {
      stage: 'understands-what-it-is',
      stance: persona.patienceSeconds <= 15 ? 'bounce' : 'hesitate',
      evidence,
      quote: saysWho ? 'I could not tell what I would actually get out of it.' : 'Nothing said whether this is for someone like me.',
    }
  }
  return { stage: 'understands-what-it-is', stance: 'pass', evidence, quote: 'One screen, and I knew what it was and roughly what I would get.' }
}

const stageForThem: StageFn = (persona, facts) => {
  const evidence: string[] = []

  if (persona.caresAbout.includes('accessibility')) {
    evidence.push('a11y.landingUnnamedControls', 'a11y.landingSmallTargets', 'a11y.htmlLang', 'a11y.imagesWithoutAlt', 'a11y.reducedMotion')
    const small = facts.num('a11y.landingSmallTargets')
    if (small > 10) {
      return {
        stage: 'sees-it-is-for-them',
        stance: persona.id === 'screen-reader-user' ? 'bounce' : 'hesitate',
        evidence,
        quote: `${small} controls in the first screen are smaller than a fingertip. For me that is not a detail, it is the difference between using it and not.`,
      }
    }
    return { stage: 'sees-it-is-for-them', stance: 'pass', evidence, quote: 'Labelled controls, a declared language, reduced-motion honoured. Somebody thought about this.' }
  }

  if (persona.device === 'slow-mobile' || persona.caresAbout.includes('offline')) {
    evidence.push('offline.shell')
    if (facts.bool('offline.shell')) {
      return { stage: 'sees-it-is-for-them', stance: 'pass', evidence, quote: 'It keeps working when my connection drops. That is not a nice-to-have where I live.' }
    }
    return { stage: 'sees-it-is-for-them', stance: 'hesitate', evidence, quote: 'If my connection dies, so does my plan.' }
  }

  if (persona.maxClicks <= 3 && persona.skeptic !== 'high') {
    evidence.push('value.interactionsToAnswer', 'landing.firstCta')
    const interactions = facts.text('value.interactionsToAnswer')
    return {
      stage: 'sees-it-is-for-them',
      stance: 'pass',
      evidence,
      quote: `The first button says guest, no account — and ${interactions.includes(': 0') ? 'zero clicks' : 'few clicks'} later I get my own answer. Fine, I am in.`,
    }
  }

  // The assessor segment needs the reasoning to be inspectable, not just plausible.
  evidence.push('product.provenance', 'trust.csp', 'value.landingExampleNumbers')
  return {
    stage: 'sees-it-is-for-them',
    stance: 'hesitate',
    evidence,
    quote: `A dependency-ordered plan is exactly the right shape. Whether I trust the order is another question — I want to see one answer before I believe the method.`,
  }
}

const stageTrusts: StageFn = (persona, facts) => {
  const example = facts.text('value.landingExampleNumbers')
  const noExample = /worked example blocks: 0/.test(example)
  const evidence: string[] = ['value.landingExampleNumbers', 'trust.noFakeSocialProof', 'product.provenance']

  if (persona.skeptic === 'high') {
    evidence.push('trust.csp', 'value.answerNeedsAccount')
    if (noExample) {
      return {
        stage: 'trusts-it-enough-to-try',
        stance: 'bounce',
        evidence,
        quote: 'There is not one real output on the landing page. No example, no numbers, just claims about a graph — I am not spending an evening on that.',
      }
    }
  }
  if (persona.needsProofBeforeSignup) {
    evidence.push('value.answerNeedsAccount')
    if (facts.bool('value.answerNeedsAccount')) {
      return { stage: 'trusts-it-enough-to-try', stance: 'bounce', evidence, quote: 'It wanted an account before showing me anything.' }
    }
  }
  if (persona.caresAbout.includes('data')) {
    evidence.push('product.dataIsBundled')
    if (persona.id === 'ld-manager-team') {
      return {
        stage: 'trusts-it-enough-to-try',
        stance: 'hesitate',
        evidence,
        quote: 'A bundled sample curriculum is fine for a demo, but I cannot judge it for 400 engineers without our own roles in it.',
      }
    }
  }
  if (noExample && persona.skeptic === 'medium') {
    return {
      stage: 'trusts-it-enough-to-try',
      stance: 'hesitate',
      evidence,
      quote: 'I would like to see one worked example before I decide. I will keep reading for now.',
    }
  }
  return {
    stage: 'trusts-it-enough-to-try',
    stance: 'pass',
    evidence,
    quote: 'No testimonials, no ratings, no "trusted by" logos. That is oddly reassuring.',
  }
}

const stageReaches: StageFn = (persona, facts) => {
  const journeyClicks = facts.num('value.clicksLandingToAnswer')
  const direct = facts.text('value.interactionsToAnswer')
  const evidence = ['value.clicksLandingToAnswer', 'value.interactionsToAnswer', 'landing.firstCta']

  if (direct.includes(': 0')) {
    // The answer itself is zero-interaction once you are on the page.
    if (journeyClicks < 0 || journeyClicks > persona.maxClicks) {
      return {
        stage: 'reaches-a-real-answer',
        stance: persona.maxClicks <= 2 ? 'bounce' : 'hesitate',
        evidence,
        quote: `Once I am on the right screen it answers instantly — but getting there cost me ${journeyClicks < 0 ? 'more steps than I take' : `${journeyClicks} clicks`}, and I give a new site ${persona.maxClicks}.`,
      }
    }
    return {
      stage: 'reaches-a-real-answer',
      stance: 'pass',
      evidence,
      quote: `${journeyClicks} clicks from the front page to my own answer, and then it just appears. That is the whole reason I stayed.`,
    }
  }
  return { stage: 'reaches-a-real-answer', stance: 'bounce', evidence, quote: 'I never got to an actual answer.' }
}

const stageComesBack: StageFn = (persona, facts) => {
  const evidence = ['offline.shell', 'value.roadmapFirstScreen', 'value.answerNeedsAccount']
  const needsAccountability = ['parent-limited-hours', 'career-changer-teacher', 'reentry-career-break', 'school-student-phone'].includes(persona.id)
  if (needsAccountability) {
    return {
      stage: 'reasons-to-come-back',
      stance: 'hesitate',
      evidence,
      quote: 'Nothing will bring me back — no reminder, no streak, no nudge. My plan is only as reliable as my own week, and my week is not reliable.',
    }
  }
  if (persona.id === 'ld-manager-team') {
    return {
      stage: 'reasons-to-come-back',
      stance: 'hesitate',
      evidence,
      quote: 'No export, no cohort view, nothing I can show a manager. I would be buying a personal tool for a departmental problem.',
    }
  }
  if (persona.id === 'tech-writer-amplifier') {
    return {
      stage: 'reasons-to-come-back',
      stance: 'pass',
      evidence: [...evidence, 'product.provenance'],
      quote: 'The claim I can check myself is the interesting story: numbers I can re-derive, and a page that tells me what it does not do.',
    }
  }
  return {
    stage: 'reasons-to-come-back',
    stance: 'pass',
    evidence,
    quote: 'The roadmap and progress are mine, they work offline, and they survived me closing the tab.',
  }
}

/* ------------------------------------------------------------------ the run */

const STAGE_FNS: Record<FunnelStage, StageFn> = {
  arrives: stageArrives,
  'first-five-seconds': stageFirstSeconds,
  'understands-what-it-is': stageUnderstands,
  'sees-it-is-for-them': stageForThem,
  'trusts-it-enough-to-try': stageTrusts,
  'reaches-a-real-answer': stageReaches,
  'reasons-to-come-back': stageComesBack,
}

/** Objection themes: what the personas are collectively objecting to, and the fix. */
const OBJECTIONS: Array<{ id: string; theme: string; test: (result: StageResult, persona: Persona) => boolean; fix: string }> = [
  {
    id: 'jargon-first',
    theme: 'The first line sells the architecture ("as a graph") rather than the outcome',
    test: (result, persona) => result.stage === 'understands-what-it-is' && /a graph is how you built it/i.test(result.quote) && persona.skeptic !== 'high',
    fix: 'Lead the hero with the outcome in the visitor\'s words ("what to learn first, and how long the whole thing takes"), keeping "graph" for the explanation underneath.',
  },
  {
    id: 'no-worked-example',
    theme: 'Nothing on the landing page shows a real output — no hours, no weeks, no example plan',
    test: (result) => /not one real output|no example/i.test(result.quote),
    fix: 'Put a real, recorded answer above the fold (a named career, its startable skills, its hour range) with a link that opens it live.',
  },
  {
    id: 'slow-first-cta',
    theme: 'The primary call to action goes to onboarding rather than to the answer',
    test: (result, persona) => result.stage === 'reaches-a-real-answer' && /clicks?[ ,]/.test(result.quote) && persona.maxClicks <= 4,
    fix: 'Make the first action "show me the answer" (deep link into the gap view with a default career) and keep the guided setup as the second option.',
  },
  {
    id: 'bytes-on-a-metered-connection',
    theme: 'Nearly half a megabyte of JavaScript before the page is useful, on connections people pay for',
    test: (result, persona) => persona.device === 'slow-mobile' && /KB of JavaScript/i.test(result.quote),
    fix: 'Skip the 3D hero entirely when the browser reports save-data or a 2G/3G effective connection type, and serve the same copy from a static first paint.',
  },
  {
    id: 'unproven-arrival',
    theme: 'There is no measured path by which strangers arrive; search and store channels are assumptions',
    test: (result) => result.stage === 'arrives' && result.stance === 'bounce',
    fix: 'Publish where the audience already is (a repository, a hosted demo behind a real domain, communities), and treat "discoverable" as an unverified claim until something measures it.',
  },
  {
    id: 'no-accountability-loop',
    theme: 'Nothing brings a learner back — no reminder, streak, nudge or shared plan',
    test: (result) => /bring me back|reminder|streak/i.test(result.quote),
    fix: 'Offer a local, opt-in return mechanism (a weekly review task already exists in the roadmap model) and make the plan resumable after a gap without guilt.',
  },
  {
    id: 'no-team-view',
    theme: 'Nothing an assessor can take to a manager: no export, cohort view or reporting',
    test: (result, persona) => persona.id === 'ld-manager-team' && result.stance === 'hesitate',
    fix: 'If the assessor segment matters, an exportable plan (already available as progress export) needs a cohort-shaped presentation.',
  },
  {
    id: 'small-targets',
    theme: 'Dozens of controls below the 36 px target size in the first screen',
    test: (result) => /smaller than a fingertip/i.test(result.quote),
    fix: 'Bring header and first-screen controls up to the same 36 px minimum the rest of the app already uses.',
  },
  {
    id: 'sample-not-live-data',
    theme: 'The graph is a curated sample, which limits assessment against real employer roles',
    test: (result) => /bundled sample curriculum/i.test(result.quote),
    fix: 'State the sample size and what it covers in the same breath as the offer, and give a path to load a custom role.',
  },
]

function stageOf(stage: FunnelStage): number {
  return STAGES.indexOf(stage)
}

export function runSimulation(sheet: FactSheet): SimulationReport {
  const facts = new Facts(sheet)
  const traces: PersonaTrace[] = []

  for (const persona of PERSONAS) {
    const stages: StageResult[] = []
    let droppedAt: FunnelStage | null = null
    for (const stage of STAGES) {
      const result = STAGE_FNS[stage](persona, facts)
      stages.push(result)
      if (result.stance === 'bounce') {
        droppedAt = stage
        break
      }
    }
    const survived = droppedAt === null
    const hesitations = stages.filter((result) => result.stance === 'hesitate').length
    const verdict = survived
      ? hesitations === 0
        ? 'Yes — I would use this, and I would tell someone about it.'
        : `Probably — I would use it, but with ${hesitations} reservation${hesitations === 1 ? '' : 's'} I would complain about first.`
      : `No — I left at "${droppedAt}".`

    const objections = OBJECTIONS.filter((objection) => stages.some((result) => objection.test(result, persona))).map((objection) => objection.id)
    const wouldReturnIf = OBJECTIONS.filter((objection) => objections.includes(objection.id)).map((objection) => objection.fix)

    traces.push({ persona, stages, droppedAt, verdict, wouldReturnIf, objections })
  }

  // Drop-off: distribution of where journeys ended. The terminal stage is never a
  // bounce row — a persona that reaches it either stays or leaves after it — so it
  // appears exactly once, as the survivors row. (It used to appear twice: empty as
  // a bounce row and again as the arrivals, which read like a bug in the funnel.)
  const dropOff = STAGES.filter((stage) => stage !== TERMINAL_STAGE).map((stage) => ({
    stage,
    count: traces.filter((trace) => trace.droppedAt === stage).length,
    personas: traces.filter((trace) => trace.droppedAt === stage).map((trace) => trace.persona.id),
  })).concat([
    {
      stage: TERMINAL_STAGE,
      count: traces.filter((trace) => trace.droppedAt === null).length,
      personas: traces.filter((trace) => trace.droppedAt === null).map((trace) => trace.persona.id),
    },
  ])

  const objections: ObjectionTheme[] = OBJECTIONS.map((objection) => {
    const raised = traces.filter((trace) => trace.objections.includes(objection.id))
    return {
      id: objection.id,
      theme: objection.theme,
      personas: raised.map((trace) => trace.persona.id),
      evidence: [...new Set(raised.flatMap((trace) => trace.stages.flatMap((stage) => stage.evidence)))],
      fix: objection.fix,
    }
  }).filter((objection) => objection.personas.length > 0)

  /**
   * Severity is modelled, not measured: it is the share of the modelled
   * word-of-mouth weight that an issue costs, on a 0–100 scale. It ranks issues
   * against each other; it is not a percentage of anything real.
   */
  const totalReach = PERSONAS.reduce((sum, persona) => sum + persona.reach, 0)
  const reachOf = (ids: string[]) => PERSONAS.filter((persona) => ids.includes(persona.id)).reduce((sum, persona) => sum + persona.reach, 0)
  const severity = (ids: string[]) => Math.round((reachOf(ids) / totalReach) * 100)

  const findings: Finding[] = []
  const bouncesAt = (stage: FunnelStage) => traces.filter((trace) => trace.droppedAt === stage).map((trace) => trace.persona.id)
  const hesitatesAt = (stage: FunnelStage) => traces.filter((trace) => trace.stages.some((result) => result.stage === stage && result.stance === 'hesitate')).map((trace) => trace.persona.id)

  const arrivalLosers = bouncesAt('arrives')
  if (arrivalLosers.length > 0) {
    findings.push({
      id: 'f-arrival',
      kind: 'weakness',
      title: 'Most modelled personas have no measured way to arrive at all',
      detail: `${arrivalLosers.length} of ${PERSONAS.length} personas arrive only through channels nothing in this build demonstrates: search indexing, an app store, or social reach. The product can be excellent and still be used by nobody, because nothing here creates demand.`,
      personas: arrivalLosers,
      evidence: ['value.landingExampleNumbers'],
      severity: severity(arrivalLosers),
      fix: 'Treat distribution as a product feature: a hosted demo on a real domain, a public repository with the run instructions, and presence where these people already ask the question.',
    })
  }

  const jargon = hesitatesAt('understands-what-it-is').filter((id) => PERSONAS.find((persona) => persona.id === id)?.skeptic !== 'high')
  if (jargon.length > 0) {
    findings.push({
      id: 'f-jargon',
      kind: 'weakness',
      title: 'The hero leads with the abstraction, not the outcome',
      detail: `The measured headline is "${facts.text('landing.h1')}". It is true, but it names the mechanism before the outcome: a stranger still has to work out what this is, who it is for, and what an answer looks like.`,
      personas: jargon,
      evidence: ['landing.h1', 'landing.firstScreen'],
      severity: severity(jargon),
      fix: 'Rewrite the first screen as: outcome, audience, one real number, one action.',
    })
  }

  const noExample = traces.filter((trace) => trace.stages.some((result) => /not one real output|no worked example|one worked example/i.test(result.quote))).map((trace) => trace.persona.id)
  if (noExample.length > 0) {
    findings.push({
      id: 'f-no-example',
      kind: 'weakness',
      title: 'The landing page shows no example of what the product produces',
      detail: `Measured: ${facts_text(sheet, 'value.landingExampleNumbers')}. A visitor is asked to trust a method they cannot see the output of, and the strongest personalities in the model refuse.`,
      personas: noExample,
      evidence: ['value.landingExampleNumbers'],
      severity: severity(noExample),
      fix: 'Show one recorded answer (career, startable skills, hour range, weeks at a stated pace) above the fold, linked to the live screen.',
    })
  }

  const journey = traces.filter((trace) => trace.stages.some((result) => /getting there cost me|clicks?[ ,]/i.test(result.quote) && result.stage === 'reaches-a-real-answer')).map((trace) => trace.persona.id)
  if (journey.length > 0) {
    findings.push({
      id: 'f-journey',
      kind: 'weakness',
      title: 'The route from the front page to a personal answer is longer than the patience of the people who need it most',
      detail: `Measured: ${facts_text(sheet, 'value.clicksLandingToAnswer')}, against a zero-interaction answer once the person reaches the gap screen. The friction is entirely in the path, not in the product.`,
      personas: journey,
      evidence: ['value.clicksLandingToAnswer', 'value.interactionsToAnswer', 'landing.firstCta'],
      severity: severity(journey),
      fix: 'Point the primary action straight at the answer; keep guided onboarding as the secondary path.',
    })
  }

  const metered = traces.filter((trace) => trace.persona.device === 'slow-mobile').map((trace) => trace.persona.id)
  findings.push({
    id: 'f-bytes',
    kind: metered.length > 0 ? 'weakness' : 'strength',
    title: 'A metered connection pays for a 3D hero it did not ask for',
    detail: `Measured: ${facts_text(sheet, 'perf.landingJsKB')} of script and a ${facts_text(sheet, 'perf.landingLcpSlow')} ms LCP on a 1.6 Mbit/s link. Nothing about the planning answer needs the scene; the scene is the most expensive part of the first impression.`,
    personas: metered,
    evidence: ['perf.landingJsKB', 'perf.landingLcpSlow'],
    severity: severity(metered),
    fix: 'Detect save-data or an effective 2G/3G connection and render the static hero, keeping every number identical.',
  })

  const a11y = traces.filter((trace) => trace.stages.some((result) => /smaller than a fingertip/i.test(result.quote))).map((trace) => trace.persona.id)
  if (a11y.length > 0) {
    findings.push({
      id: 'f-targets',
      kind: 'weakness',
      title: 'Controls below the 36 px target the rest of the app already meets',
      detail: `Measured: ${facts_text(sheet, 'a11y.landingSmallTargets')} interactive elements under 36 px in the first screen at 1440×900, while the 360 px layout passes the existing suite. The inconsistency is in the desktop chrome, not in a component library.`,
      personas: a11y,
      evidence: ['a11y.landingSmallTargets', 'a11y.mobileTargets'],
      severity: severity(a11y),
      fix: 'Raise header and first-screen controls to the same minimum height used elsewhere.',
    })
  }

  const accountability = traces.filter((trace) => /bring me back|reminder|streak|nudge/i.test(trace.stages.map((stage) => stage.quote).join(' '))).map((trace) => trace.persona.id)
  if (accountability.length > 0) {
    findings.push({
      id: 'f-return',
      kind: 'weakness',
      title: 'Nothing in the product brings anyone back',
      detail: `${accountability.length} personas want accountability and the app offers none: no reminder, no review prompt the person asked for, no shareable plan. Progress and an offline roadmap exist — retention mechanics do not.`,
      personas: accountability,
      evidence: ['value.roadmapFirstScreen', 'offline.shell'],
      severity: severity(accountability),
      fix: 'Offer an opt-in weekly review that the roadmap already models, plus a resumable plan that does not punish a three-week gap.',
    })
  }

  // Strengths are held to the same evidence standard as weaknesses.
  const zeroInteraction = traces.filter((trace) => trace.stages.some((result) => /zero clicks|instantly|just appears/i.test(result.quote))).map((trace) => trace.persona.id)
  if (zeroInteraction.length > 0) {
    findings.push({
      id: 's-instant',
      kind: 'strength',
      title: 'A personal answer with zero interactions and no account',
      detail: `Measured: ${facts_text(sheet, 'value.interactionsToAnswer')} interactions before the delta panel renders, in a fresh browser context with no session. Almost every competitor puts a form between the visitor and this moment.`,
      personas: zeroInteraction,
      evidence: ['value.interactionsToAnswer', 'value.answerNeedsAccount'],
      severity: severity(zeroInteraction),
    })
  }
  const honesty = traces.filter((trace) => /reassuring|check myself|thought about this|not live data/i.test(trace.stages.map((stage) => stage.quote).join(' '))).map((trace) => trace.persona.id)
  if (honesty.length > 0) {
    findings.push({
      id: 's-honesty',
      kind: 'strength',
      title: 'The absence of marketing is itself a credential with the sceptics',
      detail: `Measured and enforced by tests: no fabricated social proof, a strict CSP actually enforced in the browser, and a page that names its own limits. The personas with the highest reach are the ones who reward this.`,
      personas: honesty,
      evidence: ['trust.noFakeSocialProof', 'trust.csp', 'product.dataIsBundled'],
      severity: severity(honesty),
    })
  }
  const offlineLovers = traces.filter((trace) => /connection drops|keeps working/i.test(trace.stages.map((stage) => stage.quote).join(' '))).map((trace) => trace.persona.id)
  if (offlineLovers.length > 0) {
    findings.push({
      id: 's-offline',
      kind: 'strength',
      title: 'Works offline, which is rare and decisive for a real subset',
      detail: `Measured by the existing suite: the shell and the analysis survive with the network cut. For a student on a metered phone this is not a checkbox, it is the reason the plan is still there tomorrow.`,
      personas: offlineLovers,
      evidence: ['offline.shell'],
      severity: severity(offlineLovers),
    })
  }

  const audienceVerdict = SEGMENTS.map((segment) => {
    const segmentTraces = traces.filter((trace) => segment.personas.includes(trace.persona.id))
    const survivors = segmentTraces.filter((trace) => trace.droppedAt === null)
    return {
      segment: segment.label,
      survives: survivors.length,
      total: segmentTraces.length,
      personas: survivors.map((trace) => trace.persona.id),
      condition: segment.condition,
    }
  })

  const summary = (() => {
    const survived = traces.filter((trace) => trace.droppedAt === null).length
    const worst = [...findings.filter((finding) => finding.kind === 'weakness')].sort((a, b) => b.severity - a.severity)[0]
    return `${survived} of ${PERSONAS.length} modelled personas reach the end of the funnel with a plan they would keep; ${traces.length - survived} leave at a named stage, most of them before the product itself is even reached. The single most expensive defect is not in the engine: it is ${worst ? `that ${worst.title.toLowerCase()}` : 'unmeasured'}.`
  })()

  const sections = [
    {
      title: 'Where the model says people stop',
      body: [
        ...dropOff.map((row) => `- **${row.stage}** — ${row.count} persona(s): ${row.personas.join(', ') || '—'}`),
        '',
        'The concentration at *arrives* is the honest headline of this exercise: the product\'s problems on the funnel are dominated by the fact that nothing here creates demand, which no amount of interface work fixes.',
      ].join('\n'),
    },
    {
      title: 'What the survivors have in common',
      body: [
        'Every persona that stays does so for the same measured reason: **zero interactions to a personal answer, with no account**. That is the asset.',
        'The second reason is dispositional rather than technical: the personas with the highest modelled reach are the ones who reward a product for refusing to fake social proof and for naming its own limits.',
      ].join('\n\n'),
    },
    {
      title: 'The five things that cost the most',
      body: findings
        .filter((finding) => finding.kind === 'weakness')
        .sort((a, b) => b.severity - a.severity)
        .slice(0, 5)
        .map((finding) => `**${finding.title}** (severity ${finding.severity}, costs ${finding.personas.length} persona(s))\n\n${finding.detail}\n\n*Fix:* ${finding.fix ?? '—'}`)
        .join('\n\n'),
    },
    {
      title: 'What the model cannot tell you',
      body: [
        '- It cannot say whether people will use this. It can only say which claims are legible, where the friction is, and which assumption drives which result.',
        '- The persona parameters (patience in seconds, clicks tolerated, what each cares about) are judgement, not measurement. Change one and a verdict can flip; every verdict in the JSON records the facts it leaned on so you can check the chain.',
        '- Nothing here models social dynamics: no reviews, no word of mouth compounding, no competitor, no seasonality.',
        '- Six of fourteen personas never arrive through a channel that exists today, so their downstream verdicts are hypothetical by construction.',
      ].join('\n'),
    },
  ]

  return {
    generatedAt: new Date().toISOString(),
    seed: { factSheetGeneratedAt: sheet.generatedAt, build: sheet.build, conditions: sheet.conditions },
    summary,
    sections,
    traces,
    objections,
    findings: findings.sort((a, b) => b.severity - a.severity),
    dropOff,
    audienceVerdict,
    caveats: [
      `Model, not research: ${PERSONAS.length} personas with declared parameters, deterministic rules over ${Object.keys(sheet.facts).length} measured facts. No real people were observed.`,
      'Severity and reach are modelled weights, not measurements of any population.',
      'The fact sheet is a snapshot of one build under declared throttling; a different device, region or build moves the numbers.',
      'Six personas have no measured arrival channel, so their journeys are conditional on an assumption that they get there at all.',
    ],
  }
}

/** Small helper so a finding can quote a measured value without importing the class. */
function facts_text(sheet: FactSheet, id: string): string {
  const value = sheet.facts[id]?.value
  return typeof value === 'string' ? value : String(value ?? '(missing)')
}

export { STAGES, stageOf }


