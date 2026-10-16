/**
 * Graph schema registry + row validation.
 *
 * The Neo4j Query API is called with queries that always `RETURN` flat property
 * maps (`n.id AS id, n.name AS name, labels(n)[0] AS label`). Two reasons:
 *  1. the JSON shape becomes version-independent (Query API v1 "row" arrays and
 *     v2 "data.values" both decode to the same flat objects), and
 *  2. every value can be validated field-by-field before it reaches the UI or an
 *     AI prompt. Unexpected or hostile content in the graph cannot become markup.
 */
import { NODE_LABELS, RELATION_TYPES, DIFFICULTIES, type NodeLabel, type RelationType, type Difficulty } from './types.ts'
import type { GraphNode, GraphEdge } from './types.ts'
import { clamp, isHttpsUrl, uniqueBy } from './normalize.ts'

export interface LabelMeta {
  label: NodeLabel
  display: string
  plural: string
  /** Distinguishes node types by shape *and* colour (never colour alone). */
  shape: 'round-rectangle' | 'ellipse' | 'hexagon' | 'diamond' | 'rectangle' | 'pentagon' | 'star' | 'octagon' | 'tag' | 'round-tag'
  /** Hue used by Cytoscape; also emitted as a legend swatch with a text label. */
  color: string
  /** CSS-safe token so themes can re-tint without touching graph code. */
  token: string
  description: string
}

export const LABEL_META: Record<NodeLabel, LabelMeta> = {
  Career: {
    label: 'Career',
    display: 'Career',
    plural: 'Careers',
    shape: 'hexagon',
    color: '#a78bfa',
    token: 'violet',
    description: 'A job or study direction a learner is aiming for.',
  },
  EngineeringBranch: {
    label: 'EngineeringBranch',
    display: 'Engineering branch',
    plural: 'Engineering branches',
    shape: 'round-rectangle',
    color: '#60a5fa',
    token: 'blue',
    description: 'A broad discipline such as Mechanical, Civil or Electronics.',
  },
  Subject: {
    label: 'Subject',
    display: 'Subject',
    plural: 'Subjects',
    shape: 'rectangle',
    color: '#2dd4bf',
    token: 'teal',
    description: 'A taught course-sized body of knowledge.',
  },
  Concept: {
    label: 'Concept',
    display: 'Concept',
    plural: 'Concepts',
    shape: 'ellipse',
    color: '#fbbf24',
    token: 'amber',
    description: 'An idea inside a subject that other ideas build on.',
  },
  Skill: {
    label: 'Skill',
    display: 'Skill',
    plural: 'Skills',
    shape: 'round-rectangle',
    color: '#22d3ee',
    token: 'cyan',
    description: 'Something a learner can practise and demonstrate.',
  },
  ProgrammingLanguage: {
    label: 'ProgrammingLanguage',
    display: 'Programming language',
    plural: 'Programming languages',
    shape: 'pentagon',
    color: '#34d399',
    token: 'green',
    description: 'A programming or query language.',
  },
  Tool: {
    label: 'Tool',
    display: 'Tool',
    plural: 'Tools',
    shape: 'star',
    color: '#fb923c',
    token: 'orange',
    description: 'Software, hardware or instrument used in practice.',
  },
  Project: {
    label: 'Project',
    display: 'Project',
    plural: 'Projects',
    shape: 'octagon',
    color: '#f472b6',
    token: 'pink',
    description: 'A buildable piece of work that proves and builds skills.',
  },
  Resource: {
    label: 'Resource',
    display: 'Resource',
    plural: 'Resources',
    shape: 'tag',
    color: '#94a3b8',
    token: 'slate',
    description: 'Free or freemium learning material with a verified link.',
  },
  Assessment: {
    label: 'Assessment',
    display: 'Assessment',
    plural: 'Assessments',
    shape: 'diamond',
    color: '#f87171',
    token: 'red',
    description: 'A short check that gives evidence about a skill (self-assessment is never verification).',
  },
  LearningModule: {
    label: 'LearningModule',
    display: 'Learning module',
    plural: 'Learning modules',
    shape: 'round-tag',
    color: '#818cf8',
    token: 'indigo',
    description: 'An ordered set of skills and resources that can be studied together.',
  },
}

export interface RelationMeta {
  type: RelationType
  from: NodeLabel[]
  to: NodeLabel[]
  description: string
  /** Short English phrase used to explain a relationship to a learner. */
  sentence: (from: string, to: string) => string
  /** Excluded from the default visualisation when it makes the graph too dense. */
  defaultHidden?: boolean
  /** Rendered with a dashed line to signal "optional / supporting". */
  optional?: boolean
  /**
   * Edge colour, read by the 2D canvas and the 3D scene. One palette for both,
   * so the two views of the same graph cannot disagree about what an edge means.
   * Hex strings, accepted by canvas, SVG and three.js alike.
   */
  color: string
}

export const RELATION_META: Record<RelationType, RelationMeta> = {
  REQUIRES_SKILL: {
    color: '#f97316',
    type: 'REQUIRES_SKILL',
    from: ['Career'],
    to: ['Skill'],
    description: 'A career needs this skill in practice.',
    sentence: (f, t) => `${f} needs ${t} in day-to-day work.`,
  },
  RELATED_TO: {
    color: '#64748b',
    type: 'RELATED_TO',
    from: ['Career', 'Subject', 'Concept', 'Skill'],
    to: ['Career', 'Subject', 'Concept', 'Skill'],
    description: 'Two entities overlap in practice but neither requires the other.',
    sentence: (f, t) => `${f} and ${t} frequently appear together, but neither requires the other.`,
    optional: true,
  },
  BELONGS_TO: {
    color: '#60a5fa',
    type: 'BELONGS_TO',
    from: ['Career', 'Subject', 'Skill', 'Project'],
    to: ['EngineeringBranch'],
    description: 'Discipline that a career or subject sits in.',
    sentence: (f, t) => `${f} belongs to ${t}.`,
  },
  REQUIRES: {
    color: '#ef4444',
    type: 'REQUIRES',
    from: ['Skill', 'Concept', 'Subject'],
    to: ['Skill', 'Concept', 'Subject'],
    description: 'Hard prerequisite: the target is much harder without the source.',
    sentence: (f, t) => `You should be comfortable with ${f} before ${t}.`,
  },
  HAS_CONCEPT: {
    color: '#38bdf8',
    type: 'HAS_CONCEPT',
    from: ['Subject'],
    to: ['Concept'],
    description: 'Concepts taught inside a subject.',
    sentence: (f, t) => `${f} introduces ${t}.`,
  },
  BUILDS_ON: {
    color: '#f59e0b',
    type: 'BUILDS_ON',
    from: ['Concept', 'Skill'],
    to: ['Concept', 'Skill'],
    description: 'A softer dependency than REQUIRES: helpful background knowledge.',
    sentence: (f, t) => `${f} builds on earlier ideas from ${t}.`,
    optional: true,
  },
  USES: {
    color: '#a855f7',
    type: 'USES',
    from: ['Skill', 'Project', 'Career'],
    to: ['Tool', 'ProgrammingLanguage'],
    description: 'A skill or project applies a tool or language.',
    sentence: (f, t) => `${f} is practised with ${t}.`,
  },
  PRACTICED_BY: {
    color: '#ec4899',
    type: 'PRACTICED_BY',
    from: ['Skill'],
    to: ['Project'],
    description: 'A project that lets you practise a skill.',
    sentence: (f, t) => `You practise ${f} by building ${t}.`,
  },
  BUILDS_SKILL: {
    color: '#22c55e',
    type: 'BUILDS_SKILL',
    from: ['Project'],
    to: ['Skill'],
    description: 'Skills a project develops.',
    sentence: (f, t) => `Building ${f} develops ${t}.`,
  },
  TAUGHT_BY: {
    color: '#14b8a6',
    type: 'TAUGHT_BY',
    from: ['Skill', 'Concept'],
    to: ['Resource'],
    description: 'Study material that teaches this skill.',
    sentence: (f, t) => `${f} is taught by ${t}.`,
  },
  COVERS: {
    color: '#2dd4bf',
    type: 'COVERS',
    from: ['Resource', 'LearningModule'],
    to: ['Subject', 'Skill', 'Concept'],
    description: 'Material that covers a subject or skill.',
    sentence: (f, t) => `${f} covers ${t}.`,
  },
  ASSUMES: {
    color: '#a78bfa',
    type: 'ASSUMES',
    from: ['Resource'],
    to: ['Skill'],
    description: 'A resource presumes you already have this skill before it is usable.',
    sentence: (f, t) => `${f} presumes you are already comfortable with ${t}.`,
    optional: true,
  },
  SUGGESTS_PROJECT: {
    color: '#fb923c',
    type: 'SUGGESTS_PROJECT',
    from: ['Career'],
    to: ['Project'],
    description: 'A portfolio project that fits this career.',
    sentence: (f, t) => `${f} is a good portfolio project for ${t}.`,
  },
  TEACHES: {
    color: '#84cc16',
    type: 'TEACHES',
    from: ['LearningModule'],
    to: ['Skill'],
    description: 'Skills a module is designed to teach.',
    sentence: (f, t) => `${f} teaches ${t}.`,
  },
  ASSESSES: {
    color: '#eab308',
    type: 'ASSESSES',
    from: ['Assessment'],
    to: ['Skill'],
    description: 'A check that gives evidence about a skill.',
    sentence: (f, t) => `${f} checks ${t}.`,
  },
  PART_OF: {
    color: '#3b82f6',
    type: 'PART_OF',
    from: ['Subject', 'Skill', 'Concept'],
    to: ['Subject', 'LearningModule'],
    description: 'Containment: a smaller topic inside a larger unit.',
    sentence: (f, t) => `${f} is part of ${t}.`,
    optional: true,
  },
}

export const DEFAULT_VISIBLE_LABELS: NodeLabel[] = [...NODE_LABELS]

export const DEFAULT_VISIBLE_RELATIONS: RelationType[] = RELATION_TYPES.filter((t) => !RELATION_META[t].defaultHidden)

export function isNodeLabel(value: string): value is NodeLabel {
  return (NODE_LABELS as readonly string[]).includes(value)
}

export function isRelationType(value: string): value is RelationType {
  return (RELATION_TYPES as readonly string[]).includes(value)
}

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value)
}

/* ==========================================================================
 * Row validation
 * ========================================================================== */

export interface RawRow {
  [key: string]: unknown
}

function coerceScalar(value: unknown): string | number | boolean | string[] | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) : value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .slice(0, 60)
      .map((v) => (v.length > 400 ? v.slice(0, 400) : v))
  }
  return null
}

/** Keeps only JSON-safe, bounded property values from a graph row. */
export function coerceProps(row: RawRow, knownKeys: readonly string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const key of knownKeys) {
    if (!(key in row)) continue
    const value = coerceScalar(row[key])
    if (value !== null) props[key] = value
  }
  return props
}

export interface NodeRowShape {
  id?: unknown
  name?: unknown
  label?: unknown
  summary?: unknown
  difficulty?: unknown
}

/**
 * Validates one graph row into a GraphNode. Rows that do not look like a node
 * (missing id, unknown label, non-https resource URL) are dropped instead of
 * being passed through, so malformed data cannot reach the renderer.
 */
export function toGraphNode(row: RawRow, extraPropKeys: readonly string[] = []): GraphNode | null {
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (!id || id.length > 72) return null
  const label = typeof row.label === 'string' && isNodeLabel(row.label) ? row.label : null
  if (!label) return null
  const name = typeof row.name === 'string' && row.name.trim().length > 0 ? row.name.trim().slice(0, 200) : id
  const summary = typeof row.summary === 'string' ? row.summary.slice(0, 1200) : undefined

  const props = coerceProps(row, ['slug', 'careerIds', 'skillIds', 'branchIds', 'url', 'provider', 'accessModel', 'format', 'essential', 'tags', ...extraPropKeys])

  if (label === 'Resource') {
    const url = typeof row.url === 'string' ? row.url : ''
    // A resource without a safe link is still useful metadata, but the UI must
    // never render a clickable non-https URL.
    props.url = isHttpsUrl(url) ? url : ''
  }

  const difficulty = isDifficulty(row.difficulty) ? row.difficulty : undefined

  return {
    id,
    label,
    name,
    ...(summary ? { summary } : {}),
    ...(difficulty ? { difficulty } : {}),
    props: props as GraphNode['props'],
  }
}

export interface EdgeRowShape {
  from?: unknown
  to?: unknown
  type?: unknown
  weight?: unknown
  note?: unknown
}

export function toGraphEdge(row: RawRow): GraphEdge | null {
  const from = typeof row.from === 'string' ? row.from : ''
  const to = typeof row.to === 'string' ? row.to : ''
  const type = typeof row.type === 'string' && isRelationType(row.type) ? row.type : null
  if (!from || !to || !type) return null
  const weightRaw = typeof row.weight === 'number' ? row.weight : Number(row.weight)
  const weight = Number.isFinite(weightRaw) ? clamp(weightRaw, 0, 1) : undefined
  const note = typeof row.note === 'string' ? row.note.slice(0, 300) : undefined
  return {
    id: `${from}|${type}|${to}`,
    from,
    to,
    type,
    ...(weight !== undefined ? { weight } : {}),
    ...(note ? { note } : {}),
  }
}

/**
 * Builds a neighbourhood payload from validated rows, dropping edges whose
 * endpoints are absent (Cytoscape must never receive a dangling edge) and
 * de-duplicating both lists.
 */
export function buildNeighborhood(
  nodeRows: RawRow[],
  edgeRows: RawRow[],
  options: { seedId?: string | null; limit: number; selectionNote: string },
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
  const nodes = uniqueBy(
    nodeRows.map((r) => toGraphNode(r)).filter((n): n is GraphNode => n !== null),
    (n) => n.id,
  ).slice(0, options.limit)

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges = uniqueBy(
    edgeRows
      .map((r) => toGraphEdge(r))
      .filter((e): e is GraphEdge => e !== null && nodeIds.has(e.from) && nodeIds.has(e.to)),
    (e) => e.id,
  ).slice(0, options.limit * 2)

  const truncated = nodeRows.length > nodes.length || edgeRows.length > edges.length
  return { nodes, edges, truncated }
}

/** Human-readable relationship sentence used in explanations and tooltips. */
export function explainRelationship(type: RelationType, fromName: string, toName: string): string {
  const meta = RELATION_META[type]
  return meta ? meta.sentence(fromName, toName) : `${fromName} -[${type}]-> ${toName}`
}

export function graphBasisLine(type: RelationType, fromId: string, toId: string): string {
  return `(${fromId}) -[:${type}]-> (${toId})`
}

/** Legend data for the graph UI and the accessible list view. */
export function legend(): Array<{ label: NodeLabel; display: string; shape: string; color: string; description: string }> {
  return NODE_LABELS.map((l) => ({
    label: l,
    display: LABEL_META[l].display,
    shape: LABEL_META[l].shape,
    color: LABEL_META[l].color,
    description: LABEL_META[l].description,
  }))
}


