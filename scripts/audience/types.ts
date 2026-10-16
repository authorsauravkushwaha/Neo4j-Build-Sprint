/**
 * Shared types for the audience simulation.
 *
 * The engine is modelled on MiroFish's pipeline — seed extraction, persona
 * generation, simulation rounds, then a report agent — with one deliberate
 * difference: every agent decision here is a readable predicate over *measured*
 * product facts instead of an LLM call, so a reader can audit exactly why a
 * persona reacted the way it did. Nothing in this directory is a claim about real
 * people; see tools/audience/README.md for what the model can and cannot say.
 */

/** A single measured property of the shipped product. */
export interface MeasuredFact {
  id: string
  label: string
  /** The measured value — a number, a boolean, a short string, or a list. */
  value: number | boolean | string | string[]
  unit?: string
  /** Exactly how it was obtained, so it can be re-measured or disputed. */
  how: string
  /** Where it came from: this run's browser measurement, or the existing suite. */
  source: 'audience-run' | 'browser-suite' | 'dataset' | 'source-tree'
  route?: string
}

export interface RouteFacts {
  route: string
  h1: string
  /** What is visible without scrolling, whitespace collapsed. */
  firstScreen: string
  /** The first real call to action in the first screen, if any. */
  firstCta: { text: string; href: string } | null
  domContentLoadedMs: number
  loadMs: number
  firstContentfulPaintMs: number
  largestContentfulPaintMs: number | null
  transferKB: number
  scriptKB: number
  imageWithoutAlt: number
  unnamedControls: number
  smallTapTargets: number
  htmlLang: string
  consoleErrors: string[]
}

export interface FactSheet {
  generatedAt: string
  baseUrl: string
  build: { entry: string; entryKB: number; entryGzipKB: number; precacheEntries: number }
  /** Declared measurement conditions — a reaction measured under other conditions may differ. */
  conditions: {
    desktop: string
    mobile: string
    network: string
    cpu: string
    cache: string
  }
  routes: RouteFacts[]
  facts: Record<string, MeasuredFact>
}

export type Stance = 'pass' | 'hesitate' | 'bounce'

export interface StageResult {
  stage: FunnelStage
  stance: Stance
  /** Fact ids that drove this decision. Must exist in the fact sheet — asserted by tests. */
  evidence: string[]
  /** What the persona would say, in its own voice, kept short. */
  quote: string
}

export type FunnelStage =
  | 'arrives'
  | 'first-five-seconds'
  | 'understands-what-it-is'
  | 'sees-it-is-for-them'
  | 'trusts-it-enough-to-try'
  | 'reaches-a-real-answer'
  | 'reasons-to-come-back'

export interface Persona {
  id: string
  name: string
  age: number
  country: string
  profession: string
  /** MiroFish-style biography: who this person is in one paragraph. */
  bio: string
  interests: string[]
  /** Modelled word-of-mouth weight, 0..1 — how much this persona's verdict spreads. */
  reach: number
  device: 'desktop' | 'mobile' | 'slow-mobile'
  /** What they want from a site like this, in their words. */
  goal: string
  /** What "this was worth it" means for them. */
  successCriteria: string
  /** Seconds before they judge and leave. Attention, not politeness. */
  patienceSeconds: number
  /** Interactions they will spend before expecting value. */
  maxClicks: number
  needsProofBeforeSignup: boolean
  skeptic: 'low' | 'medium' | 'high'
  caresAbout: Array<'claims' | 'privacy' | 'accessibility' | 'speed' | 'offline' | 'data' | 'price'>
  /** Honest modelling of how this person would ever arrive, if at all. */
  arrivalChannels: string[]
}

export interface PersonaTrace {
  persona: Persona
  stages: StageResult[]
  /** Stage at which this persona's journey stopped, or null if it survived. */
  droppedAt: FunnelStage | null
  /** The single sentence this persona would say to a friend. */
  verdict: string
  /** What would change their mind — the actionable half of the simulation. */
  wouldReturnIf: string[]
  /** Objection theme ids raised by this persona. */
  objections: string[]
}

export interface ObjectionTheme {
  id: string
  theme: string
  /** Personas that raised it. */
  personas: string[]
  evidence: string[]
  /** The concrete product change that would remove it. */
  fix: string
}

export interface Finding {
  id: string
  kind: 'weakness' | 'strength'
  title: string
  detail: string
  personas: string[]
  evidence: string[]
  /** Severity: how many personas it costs, weighted by reach. 0..100, modelled. */
  severity: number
  fix?: string
}

export interface SimulationReport {
  generatedAt: string
  seed: { factSheetGeneratedAt: string; build: FactSheet['build']; conditions: FactSheet['conditions'] }
  summary: string
  sections: Array<{ title: string; body: string }>
  traces: PersonaTrace[]
  objections: ObjectionTheme[]
  findings: Finding[]
  dropOff: Array<{ stage: FunnelStage; count: number; personas: string[] }>
  audienceVerdict: Array<{ segment: string; survives: number; total: number; personas: string[]; condition: string }>
  caveats: string[]
}


