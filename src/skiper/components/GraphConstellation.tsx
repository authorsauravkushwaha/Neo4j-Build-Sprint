/**
 * The constellation: a prerequisite graph that draws itself as the reader
 * scrolls.
 *
 * This is the one animation in the product that is *informational* rather than
 * decorative, and it is drawn from the real graph — the nodes and edges are the
 * same `requires` relationships the gap analyser and the roadmap read. If the
 * dataset changes, this changes with it, because nothing here is hand-placed:
 * the layout comes from dependency depth (see `features/landing/storyGraph.ts`).
 *
 * The technique worth naming: each edge is an SVG path with `pathLength="1"`,
 * so the browser normalises every edge to the same length and drawing it is
 * one `stroke-dashoffset` from 1 to 0. No measurement pass, no per-edge scaling
 * maths, and it composes: edge *n* draws over its own slice of the scroll,
 * which is what makes the graph appear to build itself in dependency order.
 *
 * Accessibility: the whole SVG is `aria-hidden`. The same facts are stated in
 * the copy beside it as real text (the chain, in order, with the reasons), which
 * is what a screen reader and a text extractor actually read. The caption prop
 * exists so the visible caption can be honest about what the drawing is.
 */
import { type ReactNode } from 'react'

import { clamp01, mapRange } from '../motion/tokens.ts'
import { useMotionPreference } from '../motion/useMotionPreference.ts'
import { useScrollProgress } from '../motion/useScrollProgress.ts'

export type ConstellationKind = 'skill' | 'career' | 'project' | 'resource'
export type ConstellationState = 'known' | 'frontier' | 'later' | 'chain' | 'plain'

export interface ConstellationNode {
  id: string
  label: string
  /** Centre coordinates in the 0..100 x 0..100 viewBox. */
  x: number
  y: number
  kind: ConstellationKind
  state?: ConstellationState
  /** Optional short note drawn beside the node in the list fallback. */
  note?: string
}

export interface ConstellationEdge {
  from: string
  to: string
  /** Draw weight: 1 for the critical chain, lower for everything else. */
  weight?: number
}

export interface GraphConstellationProps {
  nodes: readonly ConstellationNode[]
  edges: readonly ConstellationEdge[]
  /** Visible caption under the drawing. Never omit: the drawing is not obvious. */
  caption: string
  /** External progress (a scene feeding its own scroll value). When absent the component measures itself. */
  progress?: number
  className?: string
  /** Draw a label next to each node. Off for a dense graph, on for a chain of five. */
  showLabels?: boolean
}

const NODE_RADIUS: Record<ConstellationKind, number> = { career: 3.1, skill: 2.2, project: 1.9, resource: 1.6 }

export function GraphConstellation({
  nodes,
  edges,
  caption,
  progress: externalProgress,
  className = '',
  showLabels = true,
}: GraphConstellationProps): ReactNode {
  const { reduced } = useMotionPreference()
  const own = useScrollProgress({ mode: 'through', reducedValue: 1 })
  const progress = reduced ? 1 : clamp01(externalProgress ?? own.progress)
  const byId = new Map(nodes.map((node) => [node.id, node]))

  // Each edge draws inside its own window of the scene, and the last fifth of
  // the scroll is reserved so the finished graph is held on screen rather than
  // blinking out at the moment it completes.
  const drawWindow = 0.78
  const slice = edges.length > 0 ? drawWindow / edges.length : drawWindow

  return (
    <figure ref={own.ref} className={`gm-constellation ${className}`}>
      <svg viewBox="0 0 100 100" className="gm-constellation-svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <linearGradient id="gm-edge-chain" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--gm-accent)" />
            <stop offset="100%" stopColor="var(--gm-violet)" />
          </linearGradient>
        </defs>

        <g className="gm-constellation-edges">
          {edges.map((edge, index) => {
            const from = byId.get(edge.from)
            const to = byId.get(edge.to)
            if (!from || !to) return null
            // A gentle curve rather than a straight line: dependency graphs read
            // as a mesh, and a mesh of straight lines looks like scaffolding.
            const midX = (from.x + to.x) / 2
            const midY = (from.y + to.y) / 2 - 6
            const local = mapRange(progress, index * slice, index * slice + slice, 0, 1)
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - local}
                strokeWidth={edge.weight === 1 ? 0.55 : 0.3}
                stroke={edge.weight === 1 ? 'url(#gm-edge-chain)' : 'var(--gm-border-strong)'}
                fill="none"
                strokeLinecap="round"
              />
            )
          })}
        </g>

        <g className="gm-constellation-nodes">
          {nodes.map((node, index) => {
            // A node appears once the edges feeding it have drawn.
            const arrivesAt = Math.min(0.8, (index / Math.max(1, nodes.length)) * drawWindow)
            const shown = progress >= arrivesAt
            return (
              <g key={node.id} data-kind={node.kind} data-state={node.state ?? 'plain'} data-shown={shown} className="gm-constellation-node">
                {node.state === 'frontier' ? <circle cx={node.x} cy={node.y} r={NODE_RADIUS[node.kind] + 2.4} className="gm-constellation-halo" /> : null}
                <circle cx={node.x} cy={node.y} r={NODE_RADIUS[node.kind]} />
                {showLabels ? (
                  <text x={node.x + NODE_RADIUS[node.kind] + 1.4} y={node.y + 1.1} className="gm-constellation-label">
                    {node.label}
                  </text>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>

      <figcaption className="gm-constellation-caption">{caption}</figcaption>
    </figure>
  )
}
