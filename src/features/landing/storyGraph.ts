/**
 * Turning a frontier report into a drawing.
 *
 * The story page draws a prerequisite graph, and the drawing has to be the real
 * one. So this module does not hand-place nodes: it takes the same
 * `FrontierReport` the skill-gap page renders as a list and lays it out from the
 * data it already contains —
 *
 *   * **x comes from `depths`**, the dependency depth the engine computed, so a
 *     skill always sits one column to the right of everything it needs;
 *   * **y comes from the order inside each depth**, spread evenly and sorted by
 *     `compareCodeUnits`, which is the engine's own comparator (the same one the
 *     Java oracle implements, and locale-independent by design);
 *   * **edges come from `needsNow`**, the engine's "what does this still need
 *     first" list, so every line drawn is a `requires` relationship with a reason
 *     behind it rather than a plausible-looking decoration.
 *
 * The consequence worth stating: if the dataset changes, or the engine's
 * traversal changes, or somebody edits a prerequisite, the drawing changes with
 * it. There is no second source of truth, and no number in this file to keep in
 * step with anything.
 */
import type { FrontierReport } from '@core/recommend.ts'

import type { ConstellationEdge, ConstellationNode, ConstellationState } from '@/skiper/components/GraphConstellation.tsx'

export interface Constellation {
  nodes: ConstellationNode[]
  edges: ConstellationEdge[]
  /** Visible caption. States what the drawing is, and what it is not. */
  caption: string
  /** How many of the remaining skills are drawn. */
  drawn: number
  /** The full remaining count, so the caption can say what was left out. */
  total: number
}

export interface ConstellationOptions {
  /** Cap on drawn nodes. The rest are counted in the caption, never silently dropped. */
  maxNodes?: number
  /** Draw the target career node on the right. */
  includeTarget?: boolean
}

/** UTF-16 code-unit comparison: the engine's own order, kept identical here. */
function codeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function constellationFromFrontier(report: FrontierReport, options: ConstellationOptions = {}): Constellation {
  const { maxNodes = 24, includeTarget = true } = options
  const chain = new Set(report.criticalChain.map((step) => step.skillId))
  const frontier = new Set(report.frontier.map((skill) => skill.skillId))

  // Depth first, then the engine's comparator: stable across runs and across
  // engines, which is what makes the drawing reproducible in a screenshot test.
  const remaining = [...report.remaining].sort((a, b) => (a.depth === b.depth ? codeUnits(a.skillId, b.skillId) : a.depth - b.depth))
  const drawn = remaining.slice(0, maxNodes)
  const drawnIds = new Set(drawn.map((skill) => skill.skillId))

  const maxDepth = Math.max(1, ...drawn.map((skill) => skill.depth))
  const byDepth = new Map<number, typeof drawn>()
  for (const skill of drawn) {
    const bucket = byDepth.get(skill.depth) ?? []
    bucket.push(skill)
    byDepth.set(skill.depth, bucket)
  }

  const nodes: ConstellationNode[] = []
  for (const [depth, bucket] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    // Left column starts at 8; the right column is reserved for the career node.
    const x = 8 + (depth / maxDepth) * (includeTarget ? 74 : 84)
    bucket.forEach((skill, index) => {
      const state: ConstellationState = chain.has(skill.skillId) ? 'chain' : frontier.has(skill.skillId) ? 'frontier' : 'later'
      // Spread the column vertically: one node sits centred, several fan out.
      const spread = bucket.length === 1 ? 0.5 : index / (bucket.length - 1)
      const y = 14 + spread * 72
      nodes.push({ id: skill.skillId, label: skill.name, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), kind: 'skill', state })
    })
  }

  const targetId = report.careerId
  if (includeTarget) {
    nodes.push({ id: targetId, label: report.careerName, x: 93, y: 50, kind: 'career', state: 'chain' })
  }

  const edges: ConstellationEdge[] = []
  for (const skill of drawn) {
    for (const need of skill.needsNow) {
      // An edge is only drawable when both ends are on the canvas. The camera
      // never invents the other end of a line.
      if (!drawnIds.has(need)) continue
      const onChain = chain.has(skill.skillId) && chain.has(need)
      edges.push({ from: need, to: skill.skillId, weight: onChain ? 1 : 0.5 })
    }
    if (includeTarget && skill.meetsTarget) {
      edges.push({ from: skill.skillId, to: targetId, weight: chain.has(skill.skillId) ? 1 : 0.5 })
    }
  }

  // Deterministic edge order, so the drawing animates in the same sequence every
  // time and a visual diff means a data change, not a hash-order change.
  edges.sort((a, b) => codeUnits(`${a.from}->${a.to}`, `${b.from}->${b.to}`))

  const totals = `The full remaining set is ${report.remainingCount} skill${report.remainingCount === 1 ? '' : 's'}`
  const sample = drawn.length < report.remainingCount ? `${totals}; the deepest ${drawn.length} are drawn here.` : `All ${report.remainingCount} are drawn here.`

  return {
    nodes,
    edges,
    drawn: drawn.length,
    total: report.remainingCount,
    caption: `Every line is a prerequisite in this app's bundled curriculum: ${report.careerName}, ${sample} Columns are dependency depth — a skill always sits to the right of everything it needs first.`,
  }
}

/**
 * How much of the remaining route a gating skill unblocks.
 *
 * The number comes from the engine (`FrontierSkill.unlocks` is already the
 * *transitive* count of remaining skills that depend on this one), because the
 * alternative — walking the graph here to count dependents — would be a second
 * implementation of a number the Java oracle also recomputes, and the three would
 * eventually disagree.
 *
 * An earlier version of this function counted only *direct* dependents. It was
 * wrong in a way worth recording: it produced a smaller number that still looked
 * plausible on the page, and nothing about it said which of the two meanings of
 * "unblocks" it had chosen. Hence the name change to `gateLeverage`, which cannot
 * be read as anything but the engine's own figure.
 */
export function gateLeverage(report: FrontierReport, skillId: string): { unlocked: number; share: number } {
  const skill = report.remaining.find((entry) => entry.skillId === skillId) ?? report.gates.find((entry) => entry.skillId === skillId)
  const unlocked = skill?.unlocks ?? 0
  return { unlocked, share: report.remainingCount === 0 ? 0 : Math.min(1, unlocked / report.remainingCount) }
}

/**
 * The share of the remaining route the gate set unblocks *between them*.
 *
 * `gatesUnlock` is the engine's union: a skill two gates share is counted once.
 * Adding the individual `unlocks` figures would overstate the case, and it is the
 * single easiest way to lie with correct arithmetic.
 */
export function gateSetLeverage(report: FrontierReport): number {
  return report.remainingCount === 0 ? 0 : Math.min(1, report.gatesUnlock / report.remainingCount)
}
