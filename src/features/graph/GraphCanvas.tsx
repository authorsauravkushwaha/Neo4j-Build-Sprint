/**
 * Cytoscape canvas.
 *
 * Accessibility notes, because a canvas is invisible to assistive technology:
 *   - the canvas is `aria-hidden` and every capability has an equivalent in the
 *     list view rendered next to it (same data, real DOM),
 *   - keyboard users get an accessible toolbar (zoom, fit, highlight, trace a
 *     path) instead of having to interact with the canvas,
 *   - animations are switched off when the user asked for reduced motion.
 *
 * The component is presentational: it renders whatever nodes/edges it is given
 * and reports selections upward. All data loading happens in GraphPage.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import cytoscape, { type Core, type ElementDefinition, type EventObject, type Layouts } from 'cytoscape'

import { LABEL_META, RELATION_META } from '@core/graphModel.ts'
import type { GraphEdge, GraphNode, NodeLabel, RelationType } from '@core/types.ts'

import { Button, Callout } from '@/components/ui.tsx'
import { Maximize2, Minus, Plus, Route, Target } from 'lucide-react'

export interface GraphCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  focusId: string | null
  selectedId: string | null
  pathFrom: string | null
  pathTo: string | null
  highlightDownstream: boolean
  animate: boolean
  onSelect: (nodeId: string | null) => void
  onZoomChange?: (zoom: number) => void
}

const DIFFICULTY_RING: Record<string, string> = {
  beginner: '#047857',
  intermediate: '#b45309',
  advanced: '#b91c1c',
}

export function GraphCanvas({
  nodes,
  edges,
  focusId,
  selectedId,
  pathFrom,
  pathTo,
  highlightDownstream,
  animate,
  onSelect,
  onZoomChange,
}: GraphCanvasProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)
  /**
   * The running layout, so it can be stopped before the graph it is laying out
   * disappears.
   *
   * Cytoscape's animated `cose` layout keeps applying node positions on its own
   * animation loop. `Core.destroy()` does not stop it. When the canvas unmounts
   * mid-animation — switching to the 3D or list view does exactly that — the loop
   * keeps writing positions to elements that have been detached, whose `cy()`
   * reference is now null, and cytoscape throws
   * `Cannot read properties of null (reading 'notify')` from inside its own
   * style bookkeeping. The user sees a working page and a red console error;
   * anyone reading that console would reasonably conclude the app is broken.
   */
  const layoutRef = useRef<Layouts | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [failure, setFailure] = useState<string | null>(null)

  /**
   * The layout engine needs a real box. A zero-sized surface (first paint, a
   * hidden tab, a collapsed container, or a browser with no layout yet) makes
   * cytoscape throw, which used to unmount the whole page. So: measure first,
   * and only build the canvas once there is something to draw into.
   */
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const measure = () =>
      setSize((previous) => {
        const next = { width: element.clientWidth, height: element.clientHeight }
        return next.width === previous.width && next.height === previous.height ? previous : next
      })
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /**
   * Stops the current layout, if any, then runs `work`.
   *
   * This exists because of a genuinely nasty failure that took a stack trace and
   * an instrumented build to pin down:
   *
   *   `Cannot read properties of null (reading 'notify')`
   *
   * thrown from inside cytoscape when a visitor switched between the Canvas / 3D
   * / List views. The chain is:
   *
   *   cose layout frame → done() → refreshPositions() → Collection.positions()
   *   → cy.startBatch() → cy.endBatch() → renderer().notify()
   *
   * `Core.destroy()` nulls the renderer. An animated `cose` layout drives itself
   * with `requestAnimationFrame`, so a frame queued before teardown can still run
   * afterwards — and `layout.stop()` does not cancel a frame that is already
   * queued. Writing positions then throws on a page that looks fine, which is the
   * worst kind of console error: the kind that teaches people to ignore it.
   *
   * Rather than trying to win a race with a library's animation frames, the layout
   * is run synchronously (see `runLayout`), so there are no frames to lose it to.
   * Stopping is kept anyway: it is one line and it makes the ordering explicit.
   */
  const whenLayoutIdle = useCallback((work: () => void): void => {
    const layout = layoutRef.current
    layoutRef.current = null
    try {
      layout?.stop()
    } catch {
      // A layout that has already finished, or whose core is gone, is not an error.
    }
    work()
  }, [])

  /**
   * Runs a layout; never lets a layout failure blank the app.
   *
   * The layout is deliberately **synchronous** (`animate: false`) and bounded
   * (`numIter`, `refresh`). Cytoscape's animated path drives itself with
   * animation frames, which is how this component ended up throwing
   * `Cannot read properties of null (reading 'notify')` from inside the library
   * when the view was switched mid-layout: a frame outlived the core it belonged
   * to. A synchronous layout has no frames to outlive anything.
   *
   * The cost is that the settle is instant rather than eased, and that the layout
   * blocks for as long as it takes — hence the iteration cap, and the grid
   * fallback for large neighbourhoods. The entrance is animated in CSS instead
   * (see `.gm-canvas-enter`), which is also what the reduced-motion rule switches
   * off, so the motion preference is still honoured.
   */
  const runLayout = useCallback((instance: Core, options: { padding: number }) => {
    whenLayoutIdle(() => {
      try {
        const layout = instance.layout({
          name: instance.nodes().length > 120 ? 'grid' : 'cose',
          animate: false,
          numIter: instance.nodes().length > 60 ? 250 : 400,
          refresh: 20,
          nodeRepulsion: () => 12000,
          idealEdgeLength: () => 90,
          padding: options.padding,
        } as never)
        layoutRef.current = layout
        layout.run()
      } catch {
        setFailure('The graph layout engine could not draw this neighbourhood on this device. The list view has the same nodes and relationships.')
      }
    })
  }, [whenLayoutIdle])

  const elements = useMemo<ElementDefinition[]>(() => {
    const nodeIds = new Set(nodes.map((node) => node.id))
    return [
      ...nodes.map((node) => ({
        data: {
          id: node.id,
          label: node.label,
          name: node.name,
          summary: node.summary ?? '',
          difficulty: node.difficulty ?? '',
          // Colour by node type, ring by difficulty: two encodings, but never
          // colour alone (the list view spells both out in text).
          color: LABEL_META[node.label as NodeLabel]?.color ?? '#64748b',
          shape: LABEL_META[node.label as NodeLabel]?.shape ?? 'round-rectangle',
          ring: node.difficulty ? (DIFFICULTY_RING[node.difficulty] ?? '#64748b') : '#94a3b8',
        },
      })),
      ...edges
        .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
        .map((edge) => ({
          data: {
            id: edge.id,
            source: edge.from,
            target: edge.to,
            type: edge.type,
            weight: edge.weight ?? 0.5,
            dashed: Boolean(RELATION_META[edge.type as RelationType]?.defaultHidden),
          },
        })),
    ]
  }, [nodes, edges])

  /* create once there is a measurable surface */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (size.width === 0 || size.height === 0) return
    if (cyRef.current) return

    let instance: Core
    try {
      instance = cytoscape({
        container,
        elements,
        wheelSensitivity: 0.2,
        minZoom: 0.15,
        maxZoom: 3,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': 'data(color)',
              shape: 'data(shape)' as never,
              label: 'data(name)',
              color: 'var(--gm-text)',
              'font-size': 9,
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'text-max-width': '110px',
              'text-wrap': 'ellipsis',
              width: 26,
              height: 26,
              'border-width': 2,
              'border-color': 'data(ring)',
            },
          },
          {
            selector: 'edge',
            style: {
              width: 1.2,
              'line-color': 'var(--gm-border-strong)',
              'target-arrow-color': 'var(--gm-border-strong)',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              'arrow-scale': 0.8,
              opacity: 0.75,
            },
          },
          { selector: 'edge[dashed = true]', style: { 'line-style': 'dashed', opacity: 0.5 } },
          { selector: 'node[focus = "true"]', style: { 'border-width': 4, 'border-color': 'var(--gm-accent)' } },
          { selector: 'node[selected = "true"]', style: { 'border-width': 5, 'border-color': 'var(--gm-violet)' } },
          { selector: 'node[prereq = "true"]', style: { 'background-color': '#f59e0b', 'border-color': '#b45309' } },
          { selector: 'node[downstream = "true"]', style: { 'background-color': '#22c55e', 'border-color': '#047857' } },
          { selector: 'node[dimmed = "true"]', style: { opacity: 0.25 } },
          { selector: 'edge[path = "true"]', style: { 'line-color': 'var(--gm-violet)', 'target-arrow-color': 'var(--gm-violet)', width: 3, opacity: 1 } },
          { selector: 'edge[dimmed = "true"]', style: { opacity: 0.15 } },
        ],
      layout: { name: 'preset' },
      })
    } catch {
      setFailure('The interactive canvas could not start in this browser. The list view has the same nodes and relationships.')
      return
    }

    instance.on('tap', 'node', (event: EventObject) => {
      onSelect((event.target as unknown as { id(): string }).id())
    })
    instance.on('tap', (event: EventObject) => {
      if (event.target === instance) onSelect(null)
    })
    instance.on('zoom', () => {
      onZoomChange?.(instance.zoom())
    })

    cyRef.current = instance
    setFailure(null)
    return () => {
      // Wait for the layout's last iteration before tearing the core down.
      whenLayoutIdle(() => {
        instance.destroy()
        if (cyRef.current === instance) cyRef.current = null
      })
    }
    // Rebuilds only when the surface changes size, not on every data update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height])

  /* update data without recreating the instance */
  useEffect(() => {
    const instance = cyRef.current
    if (!instance) return
    // The previous layout must not be mid-iteration while its elements vanish.
    whenLayoutIdle(() => {
      // The component (or the canvas) may have been torn down while we waited.
      if (cyRef.current !== instance) return
      instance.elements().remove()
      instance.add(elements)
      runLayout(instance, { padding: 24 })
      try {
        instance.fit(undefined, 40)
      } catch {
        // Fitting an empty or unmeasured viewport is not worth an error message.
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, runLayout])

  /* highlight focus, selection, prerequisites and downstream closure */
  useEffect(() => {
    const instance = cyRef.current
    if (!instance) return
    instance.nodes().removeData('focus selected prereq downstream dimmed')
    instance.edges().removeData('path dimmed')

    if (focusId) instance.getElementById(focusId).data('focus', 'true')
    if (selectedId) instance.getElementById(selectedId).data('selected', 'true')

    const anchor = selectedId ?? focusId
    if (anchor && (highlightDownstream || pathFrom || pathTo)) {
      const start = instance.getElementById(anchor)
      if (start.nonempty()) {
        const prerequisites = start.predecessors().nodes()
        const downstream = start.successors().nodes()
        prerequisites.data('prereq', 'true')
        downstream.data('downstream', 'true')
        const keep = prerequisites.union(downstream).union(start)
        instance.nodes().difference(keep).data('dimmed', 'true')
      }
    }

    if (pathFrom && pathTo) {
      const from = instance.getElementById(pathFrom)
      const to = instance.getElementById(pathTo)
      if (from.nonempty() && to.nonempty()) {
        const dijkstra = instance.elements().dijkstra({ root: from, directed: true })
        const path = dijkstra.pathTo(to)
        if (path && path.nonempty()) {
          path.edges().data('path', 'true')
          path.nodes().data('selected', 'true')
        }
      }
    }
  }, [focusId, selectedId, highlightDownstream, pathFrom, pathTo, elements])

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Graph view controls">
        <Button size="sm" variant="ghost" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.25)} aria-label="Zoom in">
          <Plus aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 0.8)} aria-label="Zoom out">
          <Minus aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => cyRef.current?.fit(undefined, 40)}
          icon={<Maximize2 className="h-3.5 w-3.5" />}
        >
          Fit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const instance = cyRef.current
            if (!instance) return
            runLayout(instance, { padding: 24 })
          }}
          icon={<Route className="h-3.5 w-3.5" />}
        >
          Re-layout
        </Button>
        <span className="ml-1 inline-flex items-center gap-1 text-xs text-muted">
          <Target aria-hidden="true" className="h-3.5 w-3.5" /> Click a node for details; the list view below has the same
          information in text.
        </span>
      </div>

      <div
        ref={containerRef}
        aria-hidden="true"
        className={`gm-graph-surface h-[420px] w-full sm:h-[520px]${animate ? ' gm-canvas-enter' : ''}`}
        data-testid="graph-canvas"
      />

      {failure ? (
        <div className="mt-3">
          <Callout kind="warning" title="The canvas is unavailable, everything else still works">
            {failure}
          </Callout>
        </div>
      ) : null}
    </div>
  )
}


