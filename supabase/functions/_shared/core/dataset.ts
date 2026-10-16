/**
 * The knowledge-graph dataset format used by:
 *   - the local sample dataset (offline / demo mode),
 *   - unit and integration tests,
 *   - the Cypher emitter that generates neo4j/seed.cypher.
 *
 * The same validation runs in all three places, so a dataset that passes tests
 * is guaranteed to be emittable as Cypher and loadable into the local reader.
 */
import {
  ACCESS_MODELS,
  DIFFICULTIES,
  NODE_LABELS,
  RELATION_TYPES,
  VERIFICATION_STATES,
  type AccessModel,
  type Difficulty,
  type NodeLabel,
  type RelationType,
  type VerificationState,
} from './types.ts'
import { NODE_ID_PREFIXES, NODE_ID_REGEX, idPrefixOf } from './validate.ts'
import { isHttpsUrl, unique } from './normalize.ts'

/* ==========================================================================
 * Entity shapes (seed-friendly: arrays are required, no undefined)
 * ========================================================================== */

export interface SeedNodeBase {
  id: string
  name: string
  summary: string
  tags?: string[]
}

export interface SeedCareer extends SeedNodeBase {
  description: string
  branchIds: string[]
  responsibilities: string[]
  typicalRoles: string[]
  portfolioIdeas: string[]
  assumptions: string[]
  difficulty: Difficulty
  verification: VerificationState
  keywords: string[]
}

export interface SeedBranch extends SeedNodeBase {
  description?: string
}

export interface SeedSubject extends SeedNodeBase {
  branchIds: string[]
  difficulty: Difficulty
}

export interface SeedConcept extends SeedNodeBase {
  subjectId: string
  difficulty: Difficulty
}

export interface SeedSkill extends SeedNodeBase {
  description: string
  difficulty: Difficulty
  estimatedHoursLow: number
  estimatedHoursHigh: number
  practice: string[]
  completionCriteria: string[]
  mustBeSelfReported: boolean
  verification: VerificationState
}

export interface SeedLanguage extends SeedNodeBase {
  /** One-line explanation; `summary` is the only prose field for languages. */
  difficulty: Difficulty
}

export interface SeedTool extends SeedNodeBase {
  openSource: boolean
}

export interface SeedProject extends SeedNodeBase {
  description: string
  difficulty: Difficulty
  /** Skills this project builds; also emitted as BUILDS_SKILL edges. */
  skillIds: string[]
  /** Free-text tool list shown on the project card. */
  tools: string[]
  objectives: string[]
  deliverables: string[]
  milestones: string[]
  testingIdeas: string[]
  extensions: string[]
  safetyNotes: string[]
  estimatedHoursLow: number
  estimatedHoursHigh: number
}

export interface SeedResource extends SeedNodeBase {
  provider: string
  url: string
  format: 'docs' | 'video' | 'course' | 'book' | 'tutorial' | 'practice' | 'repository' | 'reference'
  difficulty: Difficulty
  language: string
  accessModel: AccessModel
  accessNote: string
  /** What a learner can actually do after working through it. */
  outcomes: string[]
  /** What the material presumes you already know. */
  assumes: string
  /** Where the material stops — the honest boundary of the resource. */
  limits: string
  /** The shape of the time involved, never a promise about it. */
  commitment: string
  /** Honest hour estimate, in the same units as the skill estimates. */
  estimatedHoursLow: number
  estimatedHoursHigh: number
  lastVerified: string | null
  verification: VerificationState
}

export interface SeedModule extends SeedNodeBase {
  description: string
  skillIds: string[]
  estimatedHoursLow: number
  estimatedHoursHigh: number
}

export interface SeedQuestion {
  prompt: string
  options: string[]
  answerIndex: number
}

export interface SeedAssessment extends SeedNodeBase {
  skillId: string
  difficulty: Difficulty
  questions: SeedQuestion[]
}

export interface SeedEdge {
  from: string
  to: string
  type: RelationType
  /** Only meaningful on Career -[:REQUIRES_SKILL]-> Skill. */
  essential?: boolean
  /** Optional 0..1 ranking hint from the curriculum author. */
  weight?: number
  note?: string
}

export interface KnowledgeDataset {
  version: string
  updated: string
  /** Short note shown in the UI when sample data is being displayed. */
  provenance: string
  branches: SeedBranch[]
  careers: SeedCareer[]
  subjects: SeedSubject[]
  concepts: SeedConcept[]
  skills: SeedSkill[]
  languages: SeedLanguage[]
  tools: SeedTool[]
  projects: SeedProject[]
  resources: SeedResource[]
  modules: SeedModule[]
  assessments: SeedAssessment[]
  edges: SeedEdge[]
}

/* ==========================================================================
 * Validation
 * ========================================================================== */

export interface DatasetIssue {
  level: 'error' | 'warning'
  where: string
  message: string
}

export interface DatasetValidation {
  ok: boolean
  issues: DatasetIssue[]
  counts: Record<string, number>
  /** Adjacency used by the cycle detector; exported for tests. */
  prerequisites: Array<{ from: string; to: string }>
}

function checkId(issues: DatasetIssue[], where: string, id: string): boolean {
  if (!NODE_ID_REGEX.test(id)) {
    issues.push({ level: 'error', where, message: `Identifier "${id}" does not match the id convention.` })
    return false
  }
  return true
}

function expectLabel(issues: DatasetIssue[], where: string, id: string, label: NodeLabel): boolean {
  const prefix = idPrefixOf(id)
  if (!prefix) return false
  const actual = NODE_ID_PREFIXES[prefix]
  if (actual !== label) {
    issues.push({ level: 'error', where, message: `Expected a ${label} id, received "${id}" (${actual}).` })
    return false
  }
  return true
}

/**
 * Full structural validation of a dataset. Deliberately strict: the seed script
 * refuses to load a dataset with errors, because a partial graph silently breaks
 * prerequisite ordering.
 */
export function validateDataset(dataset: KnowledgeDataset): DatasetValidation {
  const issues: DatasetIssue[] = []
  const ids = new Map<string, NodeLabel>()

  const index = <T extends { id: string; name: string }>(
    rows: T[],
    label: NodeLabel,
    required: readonly string[] = [],
    minNameLength = 2,
  ) => {
    for (const row of rows) {
      const where = `${label} ${row.id}`
      if (!checkId(issues, where, row.id)) continue
      if (!expectLabel(issues, where, row.id, label)) continue
      if (ids.has(row.id)) {
        issues.push({ level: 'error', where, message: `Duplicate identifier "${row.id}".` })
        continue
      }
      if (!row.name || row.name.trim().length < minNameLength) {
        issues.push({ level: 'error', where, message: 'Missing or too-short name.' })
      }
      ids.set(row.id, label)
      for (const key of required) {
        const value = (row as unknown as Record<string, unknown>)[key]
        if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
          issues.push({ level: 'warning', where, message: `Field "${key}" is empty.` })
        }
      }
    }
  }

  index(dataset.branches, 'EngineeringBranch')
  index(dataset.careers, 'Career', ['description', 'responsibilities', 'typicalRoles', 'branchIds'])
  index(dataset.subjects, 'Subject')
  index(dataset.concepts, 'Concept')
  index(dataset.skills, 'Skill', ['description', 'practice', 'completionCriteria'])
  // Programming languages may legitimately have one-character names ("C", "R").
  index(dataset.languages, 'ProgrammingLanguage', [], 1)
  index(dataset.tools, 'Tool')
  index(dataset.projects, 'Project', ['objectives', 'deliverables', 'milestones'])
  index(dataset.resources, 'Resource', ['provider', 'url'])
  index(dataset.modules, 'LearningModule')
  index(dataset.assessments, 'Assessment')

  // The dataset must carry exactly the node collections the graph model knows
  // about. This is what keeps `NODE_LABELS`, the Cypher emitter and the readers
  // in step: adding a label to the model without a collection is an error, and
  // an extra collection nobody reads is reported instead of silently ignored.
  const collectionOf: Record<NodeLabel, string> = {
    Career: 'careers',
    EngineeringBranch: 'branches',
    Subject: 'subjects',
    Concept: 'concepts',
    Skill: 'skills',
    ProgrammingLanguage: 'languages',
    Tool: 'tools',
    Project: 'projects',
    Resource: 'resources',
    Assessment: 'assessments',
    LearningModule: 'modules',
  }
  const datasetRecord = dataset as unknown as Record<string, unknown>
  for (const label of NODE_LABELS) {
    const key = collectionOf[label]
    if (!Array.isArray(datasetRecord[key])) {
      issues.push({ level: 'error', where: 'dataset', message: `Missing node collection "${key}" for label ${label}.` })
    }
  }
  const knownFields = new Set<string>(['version', 'updated', 'provenance', 'edges', ...Object.values(collectionOf)])
  for (const key of Object.keys(datasetRecord)) {
    if (!knownFields.has(key)) {
      issues.push({ level: 'warning', where: 'dataset', message: `Unknown dataset field "${key}" is ignored.` })
    }
  }

  // Vocabularies: every difficulty and verification value must be one the graph
  // model understands, otherwise the UI would have no colour or filter for it.
  for (const label of NODE_LABELS) {
    const rows = datasetRecord[collectionOf[label]] as Array<Record<string, unknown>> | undefined
    if (!rows) continue
    for (const row of rows) {
      const where = `${label} ${String(row.id)}`
      if (row.difficulty !== undefined && !DIFFICULTIES.includes(row.difficulty as Difficulty)) {
        issues.push({ level: 'error', where, message: `Unknown difficulty "${String(row.difficulty)}".` })
      }
      if (row.verification !== undefined && !VERIFICATION_STATES.includes(row.verification as VerificationState)) {
        issues.push({ level: 'error', where, message: `Unknown verification state "${String(row.verification)}".` })
      }
    }
  }

  // Resource links must be https and free of embedded credentials.
  for (const resource of dataset.resources) {
    if (!isHttpsUrl(resource.url)) {
      issues.push({
        level: 'error',
        where: `Resource ${resource.id}`,
        message: `URL must be absolute https with no credentials: ${resource.url}`,
      })
    }
    if (!ACCESS_MODELS.includes(resource.accessModel)) {
      issues.push({ level: 'error', where: `Resource ${resource.id}`, message: 'Unknown access model.' })
    }
    if (resource.verification === 'verified' && !resource.lastVerified) {
      issues.push({
        level: 'warning',
        where: `Resource ${resource.id}`,
        message: 'Marked verified but has no lastVerified date.',
      })
    }
  }

  for (const project of dataset.projects) {
    if (
      project.difficulty === 'beginner' &&
      project.safetyNotes.length === 0 &&
      project.objectives.some((o) => /mains|solder|120v|240v|li-?ion|laser|high voltage/i.test(o))
    ) {
      issues.push({
        level: 'warning',
        where: `Project ${project.id}`,
        message: 'Hardware hazards mentioned without a safety note.',
      })
    }
    if (project.estimatedHoursHigh < project.estimatedHoursLow) {
      issues.push({
        level: 'error',
        where: `Project ${project.id}`,
        message: 'estimatedHoursHigh is lower than estimatedHoursLow.',
      })
    }
  }

  for (const skill of dataset.skills) {
    if (skill.estimatedHoursHigh < skill.estimatedHoursLow) {
      issues.push({ level: 'error', where: `Skill ${skill.id}`, message: 'Hour range is inverted.' })
    }
    if (skill.mustBeSelfReported === undefined) {
      issues.push({ level: 'warning', where: `Skill ${skill.id}`, message: 'missing mustBeSelfReported flag.' })
    }
  }

  for (const assessment of dataset.assessments) {
    if (assessment.questions.length === 0) {
      issues.push({ level: 'error', where: `Assessment ${assessment.id}`, message: 'Assessment has no questions.' })
    }
    for (const question of assessment.questions) {
      if (question.options.length < 2 || question.options.length > 6) {
        issues.push({
          level: 'error',
          where: `Assessment ${assessment.id}`,
          message: 'Each question needs 2–6 options.',
        })
      }
      if (question.answerIndex < 0 || question.answerIndex >= question.options.length) {
        issues.push({
          level: 'error',
          where: `Assessment ${assessment.id}`,
          message: 'answerIndex is out of range.',
        })
      }
      // The seeded property is "prompt|option|...|#answerIndex", so a pipe in any
      // text would silently split a question into the wrong shape. Fail here
      // instead of dropping questions at read time.
      const encoded = [question.prompt, ...question.options]
      if (encoded.some((part) => part.includes('|'))) {
        issues.push({
          level: 'error',
          where: `Assessment ${assessment.id}`,
          message: 'Question text and options must not contain a "|" character (it is the storage separator).',
        })
      }
      if (question.prompt.length > 300 || question.options.some((option) => option.length > 200)) {
        issues.push({
          level: 'warning',
          where: `Assessment ${assessment.id}`,
          message: 'Question text is longer than the reader keeps (300 chars prompt / 200 chars option).',
        })
      }
    }
  }

  // Edges: endpoints exist, types allowed, no dangling references.
  const seenEdges = new Set<string>()
  for (const edge of dataset.edges) {
    const where = `Edge ${edge.from} -[${edge.type}]-> ${edge.to}`
    if (!RELATION_TYPES.includes(edge.type)) {
      issues.push({ level: 'error', where, message: `Unknown relationship type "${edge.type}".` })
      continue
    }
    if (!ids.has(edge.from)) {
      issues.push({ level: 'error', where, message: `Unknown source node "${edge.from}".` })
    }
    if (!ids.has(edge.to)) {
      issues.push({ level: 'error', where, message: `Unknown target node "${edge.to}".` })
    }
    if (edge.from === edge.to) {
      issues.push({ level: 'error', where, message: 'Self-referencing relationship.' })
    }
    const key = `${edge.from}|${edge.type}|${edge.to}`
    if (seenEdges.has(key)) {
      issues.push({ level: 'error', where, message: 'Duplicate relationship.' })
    }
    seenEdges.add(key)
    if (edge.weight !== undefined && (edge.weight < 0 || edge.weight > 1)) {
      issues.push({ level: 'error', where, message: 'weight must be between 0 and 1.' })
    }
  }

  // REQUIRES edges take part in topological ordering, so shape matters:
  // direction must be (dependent)-[:REQUIRES]->(prerequisite) over Skills.
  const prerequisites: Array<{ from: string; to: string }> = []
  for (const edge of dataset.edges) {
    if (edge.type !== 'REQUIRES') continue
    const fromLabel = ids.get(edge.from)
    const toLabel = ids.get(edge.to)
    if (fromLabel !== 'Skill' || toLabel !== 'Skill') {
      issues.push({
        level: 'warning',
        where: `Edge ${edge.from} -[:REQUIRES]-> ${edge.to}`,
        message: 'REQUIRES is normally Skill → Skill; the roadmap engine only orders Skill → Skill edges.',
      })
      continue
    }
    prerequisites.push({ from: edge.from, to: edge.to })
  }

  const cycles = findPrerequisiteCycles(prerequisites)
  for (const cycle of cycles) {
    issues.push({
      level: 'error',
      where: `Cycle ${cycle.join(' → ')}`,
      message: 'Prerequisite cycles make a roadmap impossible; break the loop.',
    })
  }

  // Coverage expectations from the product brief (reported, not enforced).
  const expected: Array<[string, number, number]> = [
    ['careers', dataset.careers.length, 12],
    ['skills', dataset.skills.length, 40],
    ['projects', dataset.projects.length, 15],
    ['resources', dataset.resources.length, 30],
  ]
  for (const [name, actual, target] of expected) {
    if (actual < target) {
      issues.push({
        level: 'warning',
        where: 'coverage',
        message: `Only ${actual} ${name}; the brief targets at least ${target} credible entries.`,
      })
    }
  }

  // Every career should have at least one essential skill and a project.
  const careerSkillCounts = new Map<string, number>()
  const careerProjectCounts = new Map<string, number>()
  for (const edge of dataset.edges) {
    if (edge.type === 'REQUIRES_SKILL' && edge.essential !== false) {
      careerSkillCounts.set(edge.from, (careerSkillCounts.get(edge.from) ?? 0) + 1)
    }
    if (edge.type === 'SUGGESTS_PROJECT') {
      careerProjectCounts.set(edge.from, (careerProjectCounts.get(edge.from) ?? 0) + 1)
    }
  }
  for (const career of dataset.careers) {
    if ((careerSkillCounts.get(career.id) ?? 0) < 3) {
      issues.push({
        level: 'warning',
        where: `Career ${career.id}`,
        message: 'Fewer than three essential skills — the roadmap will be thin.',
      })
    }
    if ((careerProjectCounts.get(career.id) ?? 0) === 0) {
      issues.push({ level: 'warning', where: `Career ${career.id}`, message: 'No suggested project.' })
    }
  }

  const counts: Record<string, number> = {
    branches: dataset.branches.length,
    careers: dataset.careers.length,
    subjects: dataset.subjects.length,
    concepts: dataset.concepts.length,
    skills: dataset.skills.length,
    languages: dataset.languages.length,
    tools: dataset.tools.length,
    projects: dataset.projects.length,
    resources: dataset.resources.length,
    modules: dataset.modules.length,
    assessments: dataset.assessments.length,
    edges: dataset.edges.length,
    nodes:
      dataset.branches.length +
      dataset.careers.length +
      dataset.subjects.length +
      dataset.concepts.length +
      dataset.skills.length +
      dataset.languages.length +
      dataset.tools.length +
      dataset.projects.length +
      dataset.resources.length +
      dataset.modules.length +
      dataset.assessments.length,
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues, counts, prerequisites }
}

/**
 * Iterative DFS cycle detection over the prerequisite graph.
 *
 * Iterative (explicit stack) rather than recursive so a pathological graph
 * cannot overflow the call stack, and visited-node guards mean a malformed graph
 * terminates instead of looping forever.
 */
export function findPrerequisiteCycles(edges: Array<{ from: string; to: string }>): string[][] {
  const adjacency = new Map<string, string[]>()
  const nodes = new Set<string>()
  for (const edge of edges) {
    nodes.add(edge.from)
    nodes.add(edge.to)
    const list = adjacency.get(edge.from) ?? []
    if (!list.includes(edge.to)) list.push(edge.to)
    adjacency.set(edge.from, list)
  }

  const state = new Map<string, 0 | 1 | 2>() // 0 = new, 1 = on stack, 2 = done
  const cycles: string[][] = []
  const reported = new Set<string>()

  // Depth-first, iterative. Each node is pushed at most once (it is marked
  // "on stack" before the push), and every frame walks its neighbour list with a
  // monotonically increasing cursor, so the walk always terminates. The step
  // budget is a belt-and-braces guard: if it is ever hit we bail out rather
  // than hang the caller (a validator that never returns is worse than one that
  // reports "could not fully check").
  const stepBudget = 50 * (edges.length + nodes.size) + 10_000
  let steps = 0

  for (const start of nodes) {
    if ((state.get(start) ?? 0) !== 0) continue
    const stack: Array<{ node: string; index: number; path: string[] }> = [
      { node: start, index: 0, path: [start] },
    ]
    state.set(start, 1)

    while (stack.length > 0) {
      if (++steps > stepBudget) return cycles
      const frame = stack[stack.length - 1]
      const neighbours = adjacency.get(frame.node) ?? []
      if (frame.index >= neighbours.length) {
        state.set(frame.node, 2)
        stack.pop()
        continue
      }
      const next = neighbours[frame.index++]
      const nextState = state.get(next) ?? 0
      if (nextState === 1) {
        const cycleStart = frame.path.indexOf(next)
        const cycle = frame.path.slice(cycleStart === -1 ? 0 : cycleStart)
        const key = [...cycle].sort().join('|')
        if (!reported.has(key)) {
          reported.add(key)
          cycles.push(cycle)
        }
        continue
      }
      if (nextState === 0) {
        state.set(next, 1)
        // `index: 0` is essential — a frame pushed without it would advance
        // from `undefined`, produce NaN, and never reach its own end.
        stack.push({ node: next, index: 0, path: [...frame.path, next] })
      }
    }
  }
  return cycles
}

/** Distinct ids referenced by a dataset, used for integrity checks in tests. */
export function datasetNodeIds(dataset: KnowledgeDataset): string[] {
  return unique([
    ...dataset.branches.map((b) => b.id),
    ...dataset.careers.map((c) => c.id),
    ...dataset.subjects.map((s) => s.id),
    ...dataset.concepts.map((c) => c.id),
    ...dataset.skills.map((s) => s.id),
    ...dataset.languages.map((l) => l.id),
    ...dataset.tools.map((t) => t.id),
    ...dataset.projects.map((p) => p.id),
    ...dataset.resources.map((r) => r.id),
    ...dataset.modules.map((m) => m.id),
    ...dataset.assessments.map((a) => a.id),
  ])
}


