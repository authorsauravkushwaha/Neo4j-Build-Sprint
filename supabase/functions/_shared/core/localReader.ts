/**
 * Local (in-memory) knowledge-graph reader.
 *
 * Used for three purposes, all legitimate:
 *  1. offline / demo mode in the browser (the bundled sample dataset),
 *  2. the graceful fallback when Neo4j has not been configured yet,
 *  3. fast, deterministic unit and integration tests of the recommendation
 *     engine, roadmap generator and mentor context builder.
 *
 * It implements exactly the same `GraphReader` contract as the live Neo4j
 * reader, including the same limits and cycle guards, so behaviour cannot
 * silently diverge between demo mode and production.
 */
import type {
  Difficulty,
  GraphEdge,
  GraphNeighborhood,
  GraphNode,
  LearningResource,
  NodeLabel,
  Project,
  RelationType,
  Skill,
} from './types.ts'
import type {
  AssessmentView,
  CareerDetail,
  CareerSearchInput,
  CareerSkillRow,
  CareerSummary,
  GraphReader,
  GraphTotals,
  ModuleView,
  NeighborhoodInput,
  ProjectQuery,
  ProjectView,
  ReadOptions,
  ReadResult,
  ResourceQuery,
  ResourceView,
  SkillIndexInput,
  SkillIndexRow,
  RouteView,
  SkillDetail,
  SkillMetaRow,
} from './graphReader.ts'
import { bfsReachable, clampLimit, difficultyRank } from './graphReader.ts'
import { MAX_CATALOG_LIMIT } from './types.ts'
import type { KnowledgeDataset, SeedNodeBase } from './dataset.ts'
import { normalizeText, searchMatchScore, similarity, unique, uniqueBy } from './normalize.ts'
import { isHttpsUrl } from './normalize.ts'
import { NODE_ID_PREFIXES, idPrefixOf } from './validate.ts'

interface InternalNode {
  id: string
  label: NodeLabel
  name: string
  summary: string
  difficulty?: Difficulty
  raw: Record<string, unknown>
}

interface InternalEdge {
  from: string
  to: string
  type: RelationType
  essential?: boolean
  weight?: number
  note?: string
}

const MAX_NEIGHBORHOOD_NODES = 300
const MAX_TRAVERSAL_NODES = 2000

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

function asDiff(value: unknown, fallback: Difficulty = 'beginner'): Difficulty {
  return value === 'intermediate' || value === 'advanced' || value === 'beginner' ? value : fallback
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export interface LocalReaderOptions {
  /** Simulation of a slow/limited backend, for tests of loading + timeout paths. */
  artificialDelayMs?: number
}

export function createLocalReader(dataset: KnowledgeDataset, options: LocalReaderOptions = {}): GraphReader & {
  dataset: KnowledgeDataset
} {
  const nodes = new Map<string, InternalNode>()
  const outEdges = new Map<string, InternalEdge[]>()
  const inEdges = new Map<string, InternalEdge[]>()

  const register = (prefix: keyof typeof NODE_ID_PREFIXES, rows: Array<SeedNodeBase & Record<string, unknown>>) => {
    for (const row of rows) {
      nodes.set(row.id, {
        id: row.id,
        label: NODE_ID_PREFIXES[prefix],
        name: row.name,
        summary: row.summary ?? '',
        difficulty: typeof row.difficulty === 'string' ? asDiff(row.difficulty) : undefined,
        raw: row as unknown as Record<string, unknown>,
      })
    }
  }

  register('branch', dataset.branches as never)
  register('career', dataset.careers as never)
  register('subject', dataset.subjects as never)
  register('concept', dataset.concepts as never)
  register('skill', dataset.skills as never)
  register('lang', dataset.languages as never)
  register('tool', dataset.tools as never)
  register('project', dataset.projects as never)
  register('resource', dataset.resources as never)
  register('module', dataset.modules as never)
  register('assessment', dataset.assessments as never)

  for (const edge of dataset.edges) {
    const internal: InternalEdge = { ...edge }
    const out = outEdges.get(edge.from) ?? []
    out.push(internal)
    outEdges.set(edge.from, out)
    const incoming = inEdges.get(edge.to) ?? []
    incoming.push(internal)
    inEdges.set(edge.to, incoming)
  }

  const delay = async (signal?: AbortSignal) => {
    if (!options.artificialDelayMs) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, options.artificialDelayMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      })
    })
  }

  const wrap = async <T>(fn: () => T, o?: ReadOptions): Promise<ReadResult<T>> => {
    const started = now()
    await delay(o?.signal)
    const value = fn()
    return { value, ms: Math.max(0, Math.round(now() - started)) }
  }

  const outgoing = (id: string, type?: RelationType): InternalEdge[] => {
    const list = outEdges.get(id) ?? []
    return type ? list.filter((e) => e.type === type) : list
  }
  const incoming = (id: string, type?: RelationType): InternalEdge[] => {
    const list = inEdges.get(id) ?? []
    return type ? list.filter((e) => e.type === type) : list
  }
  const nodeName = (id: string): string => nodes.get(id)?.name ?? id

  const toSkillMeta = (id: string): SkillMetaRow | null => {
    const node = nodes.get(id)
    if (!node || node.label !== 'Skill') return null
    const raw = node.raw
    return {
      id: node.id,
      name: node.name,
      summary: node.summary,
      difficulty: asDiff(raw.difficulty),
      estimatedHoursLow: num(raw.estimatedHoursLow, 4),
      estimatedHoursHigh: num(raw.estimatedHoursHigh, 8),
      completionCriteria: strings(raw.completionCriteria),
      practice: strings(raw.practice),
    }
  }

  const toProjectView = (id: string, matched: string[] = []): ProjectView | null => {
    const node = nodes.get(id)
    if (!node || node.label !== 'Project') return null
    const raw = node.raw
    return {
      id: node.id,
      name: node.name,
      summary: node.summary,
      description: str(raw.description, node.summary),
      difficulty: asDiff(raw.difficulty),
      objectives: strings(raw.objectives),
      deliverables: strings(raw.deliverables),
      milestones: strings(raw.milestones),
      testingIdeas: strings(raw.testingIdeas),
      extensions: strings(raw.extensions),
      safetyNotes: strings(raw.safetyNotes),
      tools: strings(raw.tools),
      skillIds: outgoing(id, 'BUILDS_SKILL').map((e) => e.to),
      matchedSkillIds: matched,
      estimatedHours: [num(raw.estimatedHoursLow, 8), num(raw.estimatedHoursHigh, 20)],
    }
  }

  const toResourceView = (id: string, matched: string[] = []): ResourceView | null => {
    const node = nodes.get(id)
    if (!node || node.label !== 'Resource') return null
    const raw = node.raw
    const url = str(raw.url)
    const coversIds = outgoing(id, 'COVERS').map((e) => e.to)
    const assumesIds = outgoing(id, 'ASSUMES').map((e) => e.to)
    return {
      id: node.id,
      name: node.name,
      summary: node.summary,
      // Only https links are ever exposed as clickable.
      url: isHttpsUrl(url) ? url : '',
      provider: str(raw.provider, 'Unknown provider'),
      format: str(raw.format, 'reference'),
      difficulty: asDiff(raw.difficulty),
      language: str(raw.language, 'en'),
      accessModel: str(raw.accessModel, 'unknown'),
      accessNote: str(raw.accessNote, ''),
      outcomes: strings(raw.outcomes).slice(0, 6),
      assumes: str(raw.assumes, ''),
      limits: str(raw.limits, ''),
      commitment: str(raw.commitment, ''),
      estimatedHours: [num(raw.estimatedHoursLow, 0), num(raw.estimatedHoursHigh, 0)],
      assumesIds,
      assumesNames: assumesIds.map(nodeName),
      lastVerified: typeof raw.lastVerified === 'string' ? raw.lastVerified : null,
      verification: str(raw.verification, 'unverified') as ResourceView['verification'],
      coversIds,
      coversNames: coversIds.map(nodeName),
      matchedSkillIds: matched,
    }
  }

  const toCareerSummary = (id: string): CareerSummary | null => {
    const node = nodes.get(id)
    if (!node || node.label !== 'Career') return null
    return {
      id: node.id,
      name: node.name,
      summary: node.summary,
      difficulty: node.difficulty,
      verification: str(node.raw.verification, 'community') as CareerSummary['verification'],
      branchIds: outgoing(id, 'BELONGS_TO').map((e) => e.to),
      skillIds: outgoing(id, 'REQUIRES_SKILL').map((e) => e.to),
    }
  }

  const careerSkillRows = (careerId: string): CareerSkillRow[] =>
    outgoing(careerId, 'REQUIRES_SKILL')
      .map((edge): CareerSkillRow | null => {
        const node = nodes.get(edge.to)
        if (!node || node.label !== 'Skill') return null
        return {
          id: node.id,
          name: node.name,
          summary: node.summary,
          difficulty: asDiff(node.raw.difficulty),
          essential: edge.essential !== false,
          weight: typeof edge.weight === 'number' ? edge.weight : 0.5,
        }
      })
      .filter((row): row is CareerSkillRow => row !== null)
      .sort((a, b) => {
        if (a.essential !== b.essential) return a.essential ? -1 : 1
        const byDifficulty = difficultyRank(a.difficulty) - difficultyRank(b.difficulty)
        return byDifficulty !== 0 ? byDifficulty : a.name.localeCompare(b.name)
      })

  const neighbourhoodOf = (startIds: string[], depth: number, maxNodes: number) =>
    bfsReachable(
      startIds,
      (id) => outgoing(id).map((e) => e.to).concat(incoming(id).map((e) => e.from)),
      depth,
      maxNodes,
    )

  const walkPrerequisites = (startIds: string[], depth: number, includeStart: boolean) => {
    const maxNodes = MAX_TRAVERSAL_NODES
    const reach = bfsReachable(startIds, (id) => outgoing(id, 'REQUIRES').map((e) => e.to), depth, maxNodes)
    const ids = includeStart ? reach.order : reach.order.filter((id) => !startIds.includes(id))
    return { ids, truncated: reach.truncated }
  }

  const reader = {
    kind: 'local' as const,
    configured: true,
    provenance: dataset.provenance,
    dataset,

    async totals(): Promise<ReadResult<GraphTotals>> {
      return wrap(() => {
        const labelCounts = new Map<string, number>()
        for (const node of nodes.values()) labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1)
        return {
          nodes: nodes.size,
          relationships: dataset.edges.length,
          labels: [...labelCounts.entries()]
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        }
      })
    },

    async listSkillIndex(input: SkillIndexInput, o?: ReadOptions): Promise<ReadResult<SkillIndexRow[]>> {
      return wrap(() => {
        const limit = clampLimit(input.limit, 400, 120)
        const query = normalizeText(input.q ?? '')
        const subjectNames = new Map(dataset.subjects.map((subject) => [subject.id, subject.name]))

        const rows: SkillIndexRow[] = [
          ...dataset.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            kind: 'Skill' as const,
            difficulty: skill.difficulty,
          })),
          ...dataset.concepts.map((concept) => ({
            id: concept.id,
            name: concept.name,
            kind: 'Concept' as const,
            difficulty: concept.difficulty,
            ...(subjectNames.get(concept.subjectId) ? { parentName: subjectNames.get(concept.subjectId) as string } : {}),
          })),
        ]

        const filtered = query
          ? rows.filter((row) => normalizeText(`${row.name} ${row.parentName ?? ''} ${row.id}`).includes(query))
          : rows

        return filtered
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, limit)
      }, o)
    },

    async listCareers(limit: number, o?: ReadOptions): Promise<ReadResult<CareerSummary[]>> {
      return wrap(() => {
        const capped = clampLimit(limit, 200, 60)
        return dataset.careers
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, capped)
          .map((career) => toCareerSummary(career.id))
          .filter((c): c is CareerSummary => c !== null)
      }, o)
    },

    async searchCareers(input: CareerSearchInput, o?: ReadOptions): Promise<ReadResult<CareerSummary[]>> {
      return wrap(() => {
        const limit = clampLimit(input.limit, 60, 24)
        const offset = Math.max(0, Math.trunc(input.offset ?? 0))
        const query = normalizeText(input.q ?? '')

        const scored = dataset.careers
          .map((career) => {
            const haystack = `${career.name} ${career.summary} ${career.keywords.join(' ')}`
            const score = query ? Math.max(searchMatchScore(query, career.name), searchMatchScore(query, haystack) * 0.6) : 1
            return { career, score }
          })
          .filter((entry) => entry.score > 0)
          .filter((entry) => {
            if (!input.branchId) return true
            return outgoing(entry.career.id, 'BELONGS_TO').some((e) => e.to === input.branchId)
          })
          .filter((entry) => (input.difficulty ? asDiff(entry.career.difficulty) === input.difficulty : true))

        scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.career.name.localeCompare(b.career.name)))
        return scored
          .slice(offset, offset + limit)
          .map((entry) => toCareerSummary(entry.career.id))
          .filter((c): c is CareerSummary => c !== null)
      }, o)
    },

    async listBranches(limit: number, o?: ReadOptions) {
      return wrap(() => {
        const capped = clampLimit(limit, 80, 40)
        return dataset.branches
          .map((branch) => ({
            id: branch.id,
            name: branch.name,
            summary: branch.summary,
            careerCount: incoming(branch.id, 'BELONGS_TO').filter((e) => nodes.get(e.from)?.label === 'Career').length,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, capped)
      }, o)
    },

    async getCareer(careerId: string, o?: ReadOptions): Promise<ReadResult<CareerDetail | null>> {
      return wrap(() => {
        const node = nodes.get(careerId)
        if (!node || node.label !== 'Career') return null
        const raw = node.raw
        const branches = outgoing(careerId, 'BELONGS_TO')
          .map((e) => ({ id: e.to, name: nodeName(e.to) }))
          .filter((b) => nodes.get(b.id)?.label === 'EngineeringBranch')
        const related = outgoing(careerId, 'RELATED_TO')
          .concat(incoming(careerId, 'RELATED_TO'))
          .map((e) => (e.from === careerId ? e.to : e.from))
          .filter((id) => nodes.get(id)?.label === 'Career')
          .map((id) => ({ id, name: nodeName(id) }))
        return {
          id: node.id,
          name: node.name,
          summary: node.summary,
          description: str(raw.description, node.summary),
          difficulty: asDiff(raw.difficulty),
          verification: str(raw.verification, 'community') as CareerDetail['verification'],
          responsibilities: strings(raw.responsibilities),
          portfolioIdeas: strings(raw.portfolioIdeas),
          assumptions: strings(raw.assumptions),
          typicalRoles: strings(raw.typicalRoles),
          branchIds: branches.map((b) => b.id),
          branches,
          skills: careerSkillRows(careerId),
          related: uniqueBy(related, (r) => r.id),
          projects: outgoing(careerId, 'SUGGESTS_PROJECT')
            .map((e) => {
              const project = nodes.get(e.to)
              return project && project.label === 'Project'
                ? { id: project.id, name: project.name, difficulty: asDiff(project.raw.difficulty) }
                : null
            })
            .filter((p): p is { id: string; name: string; difficulty: Difficulty } => p !== null),
        }
      }, o)
    },

    async getCareerSkills(careerId: string, o?: ReadOptions) {
      return wrap(() => careerSkillRows(careerId), o)
    },

    async getCareerClosure(careerId: string, depth: number, limit: number, o?: ReadOptions) {
      return wrap(() => {
        const direct = outgoing(careerId, 'REQUIRES_SKILL').map((e) => e.to)
        const { ids, truncated } = walkPrerequisites(direct, Math.max(1, Math.min(depth, 6)), true)
        const rows = unique([...direct, ...ids])
          .map((id) => toSkillMeta(id))
          .filter((row): row is SkillMetaRow => row !== null)
          .slice(0, clampLimit(limit, 400, 200))
        return Object.assign(rows, { truncated })
      }, o)
    },

    async getSkillEdges(ids: string[], limit: number, o?: ReadOptions): Promise<ReadResult<GraphEdge[]>> {
      return wrap(() => {
        const set = new Set(ids)
        const edges: GraphEdge[] = []
        for (const edge of dataset.edges) {
          if (edge.type !== 'REQUIRES') continue
          if (!set.has(edge.from) || !set.has(edge.to)) continue
          edges.push({
            id: `${edge.from}|REQUIRES|${edge.to}`,
            from: edge.from,
            to: edge.to,
            type: 'REQUIRES',
            ...(edge.weight !== undefined ? { weight: edge.weight } : {}),
            ...(edge.note ? { note: edge.note } : {}),
          })
        }
        return edges.slice(0, clampLimit(limit, 600, 400))
      }, o)
    },

    async getSkill(skillId: string, o?: ReadOptions): Promise<ReadResult<SkillDetail | null>> {
      return wrap(() => {
        const node = nodes.get(skillId)
        const meta = toSkillMeta(skillId)
        if (!node || node.label !== 'Skill' || !meta) return null
        return {
          ...meta,
          description: str(node.raw.description, node.summary),
          prerequisites: outgoing(skillId, 'REQUIRES').map((e) => ({
            id: e.to,
            name: nodeName(e.to),
            ...(typeof e.weight === 'number' ? { strength: e.weight } : {}),
          })),
          unlocks: incoming(skillId, 'REQUIRES')
            .filter((e) => nodes.get(e.from)?.label === 'Skill')
            .map((e) => ({ id: e.from, name: nodeName(e.from) })),
          tools: outgoing(skillId, 'USES')
            .filter((e) => nodes.get(e.to)?.label === 'Tool')
            .map((e) => ({ id: e.to, name: nodeName(e.to) })),
          languages: outgoing(skillId, 'USES')
            .filter((e) => nodes.get(e.to)?.label === 'ProgrammingLanguage')
            .map((e) => ({ id: e.to, name: nodeName(e.to) })),
          projects: outgoing(skillId, 'PRACTICED_BY')
            .map((e) => nodes.get(e.to))
            .filter((n): n is InternalNode => Boolean(n) && n!.label === 'Project')
            .map((n) => ({ id: n.id, name: n.name, difficulty: asDiff(n.raw.difficulty) })),
          resources: outgoing(skillId, 'TAUGHT_BY')
            .map((e) => nodes.get(e.to))
            .filter((n): n is InternalNode => Boolean(n) && n!.label === 'Resource')
            .map((n) => ({
              id: n.id,
              name: n.name,
              provider: str(n.raw.provider),
              url: str(n.raw.url),
            })),
        }
      }, o)
    },

    async getSkillClosure(skillId: string, depth: number, limit: number, o?: ReadOptions) {
      return wrap(() => {
        const { ids } = walkPrerequisites([skillId], Math.max(1, Math.min(depth, 6)), false)
        return ids
          .map((id) => toSkillMeta(id))
          .filter((row): row is SkillMetaRow => row !== null)
          .slice(0, clampLimit(limit, 400, 200))
      }, o)
    },

    async getDownstream(skillId: string, depth: number, o?: ReadOptions) {
      return wrap(() => {
        const d = Math.max(1, Math.min(depth, 6))
        const reach = bfsReachable([skillId], (id) => incoming(id, 'REQUIRES').map((e) => e.from), d, MAX_TRAVERSAL_NODES)
        const downstreamIds = unique(reach.order.filter((id) => id !== skillId))
        const skills = downstreamIds
          .map((id) => toSkillMeta(id))
          .filter((row): row is SkillMetaRow => row !== null)
          .slice(0, 200)
        const careerIds = new Set<string>()
        for (const [careerId] of nodes) {
          if (nodes.get(careerId)?.label !== 'Career') continue
          const required = outgoing(careerId, 'REQUIRES_SKILL').map((e) => e.to)
          if (required.includes(skillId) || required.some((id) => downstreamIds.includes(id))) careerIds.add(careerId)
        }
        return {
          careers: [...careerIds].map((id) => ({ id, name: nodeName(id) })).slice(0, 40),
          skills,
        }
      }, o)
    },

    async getRoutes(careerId: string, fromSkillId: string, limit: number, o?: ReadOptions): Promise<ReadResult<RouteView[]>> {
      return wrap(() => {
        const required = new Set(outgoing(careerId, 'REQUIRES_SKILL').map((e) => e.to))
        const parent = new Map<string, string | null>([[fromSkillId, null]])
        const queue: string[] = [fromSkillId]
        const found: string[] = []
        let head = 0
        let guard = 0
        while (head < queue.length && guard++ < MAX_TRAVERSAL_NODES) {
          const current = queue[head++]
          if (current !== fromSkillId && required.has(current)) found.push(current)
          for (const edge of outgoing(current, 'REQUIRES')) {
            if (parent.has(edge.to)) continue
            parent.set(edge.to, current)
            queue.push(edge.to)
          }
        }
        const routes = found
          .map((target) => {
            const path: string[] = []
            let cursor: string | null = target
            while (cursor) {
              path.unshift(cursor)
              cursor = parent.get(cursor) ?? null
            }
            return {
              ids: path,
              names: path.map(nodeName),
              difficulties: path.map((id) => nodes.get(id)?.difficulty),
              targetId: target,
              targetName: nodeName(target),
              hops: path.length - 1,
            }
          })
          .sort((a, b) => (a.hops !== b.hops ? a.hops - b.hops : a.targetName.localeCompare(b.targetName)))
          .slice(0, clampLimit(limit, 10, 5))
        return routes
      }, o)
    },

    async getNeighborhood(input: NeighborhoodInput, o?: ReadOptions): Promise<ReadResult<GraphNeighborhood>> {
      return wrap(() => {
        const limit = clampLimit(input.limit, MAX_NEIGHBORHOOD_NODES, 120)
        const depth = Math.max(1, Math.min(input.depth ?? 1, 3))
        const allowedLabels = input.labels && input.labels.length > 0 ? new Set<NodeLabel>(input.labels) : null
        const allowedRelations = input.relations && input.relations.length > 0 ? new Set<RelationType>(input.relations) : null

        let seedNode: InternalNode | null = null
        let selectionNote = ''

        if (input.seedId) {
          seedNode = nodes.get(input.seedId) ?? null
          if (!seedNode) {
            return {
              seedId: input.seedId,
              nodes: [],
              edges: [],
              truncated: false,
              selectionNote: `No node with id ${input.seedId} exists in this dataset.`,
            }
          }
          selectionNote = `${depth}-hop neighbourhood of ${seedNode.name}, limited to ${limit} nodes.`
        } else if (input.careerId) {
          const career = nodes.get(input.careerId)
          if (!career || career.label !== 'Career') {
            return {
              seedId: null,
              nodes: [],
              edges: [],
              truncated: false,
              selectionNote: `No career with id ${input.careerId} exists in this dataset.`,
            }
          }
          selectionNote = `Overview of ${career.name}: required skills plus their tools and projects, limited to ${limit} nodes.`
          const direct = outgoing(input.careerId, 'REQUIRES_SKILL').map((e) => e.to)
          const reach = neighbourhoodOf(direct.map((id) => id), 1, limit)
          const ids = [input.careerId, ...direct, ...reach.order]
          return finish(input.careerId, ids, limit, selectionNote)
        } else {
          return {
            seedId: null,
            nodes: [],
            edges: [],
            truncated: false,
            selectionNote: 'Provide a seed node id or a career id to load a subgraph.',
          }
        }

        const reach = neighbourhoodOf([seedNode.id], depth, limit)
        const ids = [seedNode.id, ...reach.order]
        const result: GraphNeighborhood = finish(seedNode.id, ids, limit, selectionNote)

        // Depth-1 relation filtering, so the user can hide noisy relationship types.
        if (allowedRelations && depth === 1) {
          const keep = new Set(ids.slice(0, limit))
          const filtered = result.edges.filter((edge) => allowedRelations.has(edge.type))
          const nodeIds = new Set<string>([seedNode.id])
          for (const edge of filtered) {
            if (keep.has(edge.from)) nodeIds.add(edge.from)
            if (keep.has(edge.to)) nodeIds.add(edge.to)
          }
          result.nodes = result.nodes.filter((n) => nodeIds.has(n.id))
          result.edges = filtered
        }

        if (allowedLabels) {
          const allowed = result.nodes.filter((n) => n.id === seedNode!.id || allowedLabels.has(n.label))
          const keepIds = new Set(allowed.map((n) => n.id))
          result.nodes = allowed
          result.edges = result.edges.filter((e) => keepIds.has(e.from) && keepIds.has(e.to))
        }

        if (input.difficulty) {
          const keepIds = new Set(
            result.nodes
              .filter((n) => n.id === seedNode!.id || !n.difficulty || n.difficulty === input.difficulty)
              .map((n) => n.id),
          )
          result.nodes = result.nodes.filter((n) => keepIds.has(n.id))
          result.edges = result.edges.filter((e) => keepIds.has(e.from) && keepIds.has(e.to))
        }

        return result

        function finish(seedId: string | null, ids: string[], cap: number, note: string): GraphNeighborhood {
          const selected = unique(ids).slice(0, cap)
          const selectedSet = new Set(selected)
          const graphNodes: GraphNode[] = selected
            .map((id) => nodes.get(id))
            .filter((n): n is InternalNode => Boolean(n))
            .map((n) => ({
              id: n.id,
              label: n.label,
              name: n.name,
              ...(n.summary ? { summary: n.summary } : {}),
              ...(n.difficulty ? { difficulty: n.difficulty } : {}),
              props: {},
            }))
          const graphEdges: GraphEdge[] = []
          for (const edge of dataset.edges) {
            if (!selectedSet.has(edge.from) || !selectedSet.has(edge.to)) continue
            if (edge.type === 'RELATED_TO' || edge.type === 'PART_OF') continue
            graphEdges.push({
              id: `${edge.from}|${edge.type}|${edge.to}`,
              from: edge.from,
              to: edge.to,
              type: edge.type,
              ...(edge.weight !== undefined ? { weight: edge.weight } : {}),
            })
            if (graphEdges.length >= cap * 2) break
          }
          return {
            seedId,
            nodes: graphNodes,
            edges: graphEdges,
            truncated: ids.length > selected.length,
            selectionNote: note,
          }
        }
      }, o)
    },

    async getEdgesAmong(ids: string[], relations: RelationType[] | undefined, limit: number, o?: ReadOptions) {
      return wrap(() => {
        const set = new Set(ids)
        const allowed = relations && relations.length > 0 ? new Set(relations) : null
        const edges: GraphEdge[] = []
        for (const edge of dataset.edges) {
          if (allowed && !allowed.has(edge.type)) continue
          if (!set.has(edge.from) || !set.has(edge.to)) continue
          edges.push({
            id: `${edge.from}|${edge.type}|${edge.to}`,
            from: edge.from,
            to: edge.to,
            type: edge.type,
            ...(edge.weight !== undefined ? { weight: edge.weight } : {}),
          })
          if (edges.length >= clampLimit(limit, 600, 300)) break
        }
        return edges
      }, o)
    },

    async findProjects(query: ProjectQuery, o?: ReadOptions): Promise<ReadResult<ProjectView[]>> {
      return wrap(() => {
        const limit = clampLimit(query.limit, MAX_CATALOG_LIMIT, 8)
        const wantedSkills = new Set(query.skillIds ?? [])
        const candidates = new Map<string, string[]>()

        if (wantedSkills.size > 0) {
          for (const skillId of wantedSkills) {
            for (const edge of incoming(skillId, 'BUILDS_SKILL')) {
              if (nodes.get(edge.from)?.label !== 'Project') continue
              const matched = candidates.get(edge.from) ?? []
              matched.push(skillId)
              candidates.set(edge.from, matched)
            }
          }
        }
        if (query.careerId) {
          for (const edge of outgoing(query.careerId, 'SUGGESTS_PROJECT')) {
            if (nodes.get(edge.to)?.label !== 'Project') continue
            if (!candidates.has(edge.to)) candidates.set(edge.to, [])
          }
        }
        if (candidates.size === 0) {
          for (const project of dataset.projects) candidates.set(project.id, [])
        }

        return [...candidates.entries()]
          .map(([id, matched]) => ({ view: toProjectView(id, unique(matched)), matched: matched.length }))
          .filter((entry): entry is { view: ProjectView; matched: number } => entry.view !== null)
          .filter((entry) => (query.difficulty ? entry.view.difficulty === query.difficulty : true))
          .sort((a, b) => {
            if (b.matched !== a.matched) return b.matched - a.matched
            const byDifficulty = difficultyRank(a.view.difficulty) - difficultyRank(b.view.difficulty)
            return byDifficulty !== 0 ? byDifficulty : a.view.name.localeCompare(b.view.name)
          })
          .slice(0, limit)
          .map((entry) => entry.view)
      }, o)
    },

    async findResources(query: ResourceQuery, o?: ReadOptions): Promise<ReadResult<ResourceView[]>> {
      return wrap(() => {
        const limit = clampLimit(query.limit, MAX_CATALOG_LIMIT, 20)
        const wantedSkills = new Set(query.skillIds ?? [])
        const matchedBy = new Map<string, string[]>()

        if (wantedSkills.size > 0) {
          for (const skillId of wantedSkills) {
            for (const edge of incoming(skillId, 'COVERS')) {
              if (nodes.get(edge.from)?.label !== 'Resource') continue
              const list = matchedBy.get(edge.from) ?? []
              list.push(skillId)
              matchedBy.set(edge.from, list)
            }
          }
        }
        if (query.subjectId) {
          for (const edge of incoming(query.subjectId, 'COVERS')) {
            if (!matchedBy.has(edge.from)) matchedBy.set(edge.from, [])
          }
        }

        const q = normalizeText(query.q ?? '')
        const pool = matchedBy.size > 0 ? [...matchedBy.entries()] : dataset.resources.map((r) => [r.id, []] as const)

        return pool
          .map(([id, matched]) => ({ view: toResourceView(id, unique(matched)), matched: matched.length }))
          .filter((entry): entry is { view: ResourceView; matched: number } => entry.view !== null)
          .filter((entry) => (query.format ? entry.view.format === query.format : true))
          .filter((entry) => (query.accessModel ? entry.view.accessModel === query.accessModel : true))
          .filter((entry) => (query.difficulty ? entry.view.difficulty === query.difficulty : true))
          // Search over what the learner would search for: the name, the summary,
          // the provider, and the detail fields (outcomes, prerequisites, limits).
          .map((entry) => ({
            ...entry,
            score: q
              ? searchMatchScore(
                  q,
                  [
                    entry.view.name,
                    entry.view.summary,
                    entry.view.provider,
                    entry.view.assumes,
                    entry.view.limits,
                    entry.view.outcomes.join(' '),
                  ].join(' '),
                )
              : 1,
          }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => {
            if (b.matched !== a.matched) return b.matched - a.matched
            if (b.score !== a.score) return b.score - a.score
            return a.view.name.localeCompare(b.view.name)
          })
          .slice(0, limit)
          .map((entry) => entry.view)
      }, o)
    },

    async getAssessments(skillIds: string[], limit: number, o?: ReadOptions) {
      return wrap(() => {
        const wanted = new Set(skillIds)
        return dataset.assessments
          .filter((assessment) => wanted.size === 0 || wanted.has(assessment.skillId))
          .slice(0, clampLimit(limit, 40, 12))
          .map<AssessmentView>((assessment) => ({
            id: assessment.id,
            name: assessment.name,
            summary: assessment.summary,
            skillId: assessment.skillId,
            difficulty: asDiff(assessment.difficulty),
            questions: assessment.questions.map((question) => ({
              prompt: question.prompt,
              options: question.options.slice(0, 6),
              answerIndex: question.answerIndex,
            })),
          }))
      }, o)
    },

    async getModules(careerId: string | undefined, limit: number, o?: ReadOptions) {
      return wrap(() => {
        const careerSkills = careerId
          ? new Set(outgoing(careerId, 'REQUIRES_SKILL').map((e) => e.to))
          : null
        return dataset.modules
          .filter((module) => {
            if (!careerSkills) return true
            return module.skillIds.some((id) => careerSkills.has(id))
          })
          .slice(0, clampLimit(limit, 40, 12))
          .map<ModuleView>((module) => ({
            id: module.id,
            name: module.name,
            summary: module.summary,
            skillIds: module.skillIds,
          }))
      }, o)
    },

    /* Helper used by tests and the mentor context builder. */
    relatedNames(id: string, limit = 8): string[] {
      const node = nodes.get(id)
      if (!node) return []
      const neighbours = unique([
        ...outgoing(id).map((e) => e.to),
        ...incoming(id).map((e) => e.from),
      ])
      return neighbours
        .map((nid) => nodes.get(nid))
        .filter((n): n is InternalNode => Boolean(n))
        .sort((a, b) => similarity(node.name, b.name) - similarity(node.name, a.name))
        .slice(0, limit)
        .map((n) => `${n.label}: ${n.name}`)
    },

    /* Dataset-derived helpers used by the seed validator and docs generator. */
    datasetCounts() {
      return {
        nodes: nodes.size,
        edges: dataset.edges.length,
        skills: dataset.skills.length as number,
        careers: dataset.careers.length as number,
      }
    },
  }

  return reader as unknown as GraphReader & { dataset: KnowledgeDataset }
}

/** Convenience casts used by tests, kept here to avoid `any` in test files. */
export function asSkill(node: GraphNode): Skill | null {
  return node.label === 'Skill' ? (node as unknown as Skill) : null
}
export function asProject(node: GraphNode): Project | null {
  return node.label === 'Project' ? (node as unknown as Project) : null
}
export function asResource(node: GraphNode): LearningResource | null {
  return node.label === 'Resource' ? (node as unknown as LearningResource) : null
}
export function labelOfId(id: string): NodeLabel | null {
  const prefix = idPrefixOf(id)
  return prefix ? NODE_ID_PREFIXES[prefix] : null
}


