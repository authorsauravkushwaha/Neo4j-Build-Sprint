/**
 * The knowledge graph, in 3D.
 *
 * Same data as the 2D canvas — the same bounded subgraph the API returned, the
 * same node labels, the same highlighted prerequisite/downstream sets — laid out
 * by a 3D force simulation and drawn as glass lenses.
 *
 * Decisions worth knowing:
 *
 *   - **The layout is deterministic.** A seeded PRNG drives the initial
 *     positions, so the same subgraph always settles into the same shape. A
 *     layout that re-rolls on every render cannot be discussed in a demo or
 *     compared between two screenshots.
 *   - **The simulation converges once, then stops.** The settled positions are
 *     computed before the first frame; only the camera moves afterwards. A
 *     phone should not run physics for a graph that is not changing.
 *   - **Picking is real.** Pointer coordinates are raycast against the node
 *     meshes, so clicking a lens selects that node in the panel below. The 3D
 *     view is the same tool from another angle, not a picture of one.
 *   - **It is never the only way in.** The canvas is `aria-hidden`, the 2D
 *     canvas and the text list stay available, and reduced motion, a data-saver
 *     connection or a missing WebGL context all fall back to those.
 */
import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import type * as ThreeModule from 'three'
import { Boxes, Compass, Maximize2, Repeat } from 'lucide-react'

import { RELATION_META } from '@core/graphModel.ts'
import type { GraphEdge, GraphNode, NodeLabel, RelationType } from '@core/types.ts'

import { Callout } from '@/components/ui.tsx'
import { Scene3D, type SceneApi, type SceneHandles } from '@/components/three/Scene3D.tsx'

export interface Graph3DProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  focusId: string | null
  selectedId: string | null
  highlightDownstream: boolean
  onSelect: (nodeId: string | null) => void
  /** Where this data came from; rendered under the canvas. */
  provenanceNote?: string
  truncated?: boolean
  className?: string
}

/* -------------------------------------------------------------------------- */
/* Deterministic randomness                                                     */
/* -------------------------------------------------------------------------- */

/** mulberry32 — small, fast, and identical across engines for a given seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/* -------------------------------------------------------------------------- */
/* Layout: a small force simulation in three dimensions                         */
/* -------------------------------------------------------------------------- */

interface Point {
  x: number
  y: number
  z: number
}

export interface Layout3D {
  positions: Map<string, Point>
  /** Node ids in sorted order, so indices are stable between runs. */
  order: string[]
  neighbours: Map<string, Set<string>>
}

export function layoutGraph3D(nodes: GraphNode[], edges: GraphEdge[], iterations = 240): Layout3D {
  const order = nodes.map((node) => node.id).sort()
  const index = new Map(order.map((id, position) => [id, position]))
  const count = order.length
  const positions: Point[] = new Array(count)
  const velocity: Point[] = new Array(count)

  const random = prng(hashString(order.join('|')) || 1)
  const radius = Math.max(4, Math.cbrt(Math.max(count, 1)) * 3.4)

  for (let position = 0; position < count; position += 1) {
    // Fibonacci sphere: an even spread, so the force pass starts from a neutral
    // cloud instead of one knot that has to untangle.
    const t = (position + 0.5) / count
    const inclination = Math.acos(1 - 2 * t)
    const azimuth = Math.PI * (1 + Math.sqrt(5)) * position
    const jitter = 0.85 + random() * 0.3
    positions[position] = {
      x: Math.cos(azimuth) * Math.sin(inclination) * radius * jitter,
      y: Math.cos(inclination) * radius * jitter,
      z: Math.sin(azimuth) * Math.sin(inclination) * radius * jitter,
    }
    velocity[position] = { x: 0, y: 0, z: 0 }
  }

  const links = edges
    .filter((edge) => index.has(edge.from) && index.has(edge.to))
    .map((edge) => ({ a: index.get(edge.from) as number, b: index.get(edge.to) as number }))

  const neighbours = new Map<string, Set<string>>()
  for (const id of order) neighbours.set(id, new Set())
  for (const edge of edges) {
    neighbours.get(edge.from)?.add(edge.to)
    neighbours.get(edge.to)?.add(edge.from)
  }

  const idealLength = 2.6
  const repulsion = 5.4
  const damping = 0.82
  const centring = 0.02

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / iterations

    // Pairwise repulsion. Quadratic cost is fine here: the subgraph is bounded by
    // the API (hundreds of nodes, never thousands) and this runs once.
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        let dx = positions[a].x - positions[b].x
        let dy = positions[a].y - positions[b].y
        let dz = positions[a].z - positions[b].z
        let distanceSq = dx * dx + dy * dy + dz * dz
        if (distanceSq < 0.0001) {
          // Coincident points would divide by zero; nudge them apart.
          dx = (random() - 0.5) * 0.01
          dy = (random() - 0.5) * 0.01
          dz = (random() - 0.5) * 0.01
          distanceSq = 0.0001
        }
        const distance = Math.sqrt(distanceSq)
        const force = repulsion / distanceSq
        const fx = (dx / distance) * force
        const fy = (dy / distance) * force
        const fz = (dz / distance) * force
        velocity[a].x += fx
        velocity[a].y += fy
        velocity[a].z += fz
        velocity[b].x -= fx
        velocity[b].y -= fy
        velocity[b].z -= fz
      }
    }

    for (const link of links) {
      const dx = positions[link.b].x - positions[link.a].x
      const dy = positions[link.b].y - positions[link.a].y
      const dz = positions[link.b].z - positions[link.a].z
      const distance = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz))
      const force = ((distance - idealLength) / distance) * 0.06
      const fx = dx * force
      const fy = dy * force
      const fz = dz * force
      velocity[link.a].x += fx
      velocity[link.a].y += fy
      velocity[link.a].z += fz
      velocity[link.b].x -= fx
      velocity[link.b].y -= fy
      velocity[link.b].z -= fz
    }

    for (let position = 0; position < count; position += 1) {
      // A gentle pull to the origin keeps disconnected clusters on screen.
      velocity[position].x -= positions[position].x * centring
      velocity[position].y -= positions[position].y * centring
      velocity[position].z -= positions[position].z * centring

      velocity[position].x *= damping
      velocity[position].y *= damping
      velocity[position].z *= damping

      positions[position].x += velocity[position].x * cooling
      positions[position].y += velocity[position].y * cooling
      positions[position].z += velocity[position].z * cooling
    }
  }

  const map = new Map<string, Point>()
  order.forEach((id, position) => map.set(id, positions[position]))
  return { positions: map, order, neighbours }
}

/* -------------------------------------------------------------------------- */
/* Palette — mirrors the 2D canvas so the two views agree                      */
/* -------------------------------------------------------------------------- */

const HEX: Record<string, number> = {
  Career: 0x22d3ee,
  EngineeringBranch: 0x818cf8,
  Subject: 0x60a5fa,
  Concept: 0x34d399,
  Skill: 0xa78bfa,
  ProgrammingLanguage: 0xf472b6,
  Tool: 0xfbbf24,
  Project: 0xfb923c,
  Resource: 0x94a3b8,
  LearningModule: 0x2dd4bf,
  Assessment: 0xf87171,
}

const PREREQ_COLOUR = 0xf59e0b
const DOWNSTREAM_COLOUR = 0x22c55e
const PREREQ_HEX = '#f59e0b'
const DOWNSTREAM_HEX = '#22c55e'

function toneFor(label: NodeLabel | undefined): number {
  return HEX[label ?? 'Resource'] ?? 0x94a3b8
}

/* -------------------------------------------------------------------------- */

export function Graph3D({
  nodes,
  edges,
  focusId,
  selectedId,
  highlightDownstream,
  onSelect,
  provenanceNote,
  truncated,
  className = '',
}: Graph3DProps): ReactNode {
  const layout = useMemo(() => layoutGraph3D(nodes, edges), [nodes, edges])

  /** Prepared once per data change; the frame loop only reads it. */
  const model = useMemo(() => {
    const degree = new Map<string, number>()
    for (const id of layout.order) degree.set(id, layout.neighbours.get(id)?.size ?? 0)
    const maxDegree = Math.max(1, ...degree.values())

    const labels = new Map<string, NodeLabel>(nodes.map((node) => [node.id, node.label]))
    const names = new Map<string, string>(nodes.map((node) => [node.id, node.name]))

    const anchor = selectedId ?? focusId
    const prerequisites = new Set<string>()
    const downstream = new Set<string>()
    if (anchor && highlightDownstream) {
      // An incoming REQUIRES edge means "this node needs that one first".
      for (const edge of edges) {
        if (edge.to === anchor && edge.type === 'REQUIRES') prerequisites.add(edge.from)
        if (edge.from === anchor) downstream.add(edge.to)
      }
    }

    return { degree, maxDegree, labels, names, anchor, prerequisites, downstream }
  }, [layout, nodes, edges, selectedId, focusId, highlightDownstream])

  /**
   * The frame loop reads highlight state from a ref, not from props: the scene is
   * built once per data change and must not be rebuilt just because a node was
   * clicked or a panel toggled.
   */
  const highlightRef = useRef(model)
  highlightRef.current = model

  const build = useCallback(
    ({ THREE, scene, camera, renderer }: SceneApi): SceneHandles => {
      const disposables: Array<{ dispose: () => void }> = []
      const group = new THREE.Group()
      scene.add(group)

      /* Lights: the same neumorphic pairing as the rest of the UI — key from the
         upper left, cooler fill from the lower right — so a node reads as a
         moulded solid with a lit side and a shaded side. */
      scene.add(new THREE.AmbientLight(0xffffff, 0.5))
      const key = new THREE.DirectionalLight(0xffffff, 1.6)
      key.position.set(-7, 9, 8)
      scene.add(key)
      const fill = new THREE.DirectionalLight(0x8ba7ff, 0.9)
      fill.position.set(7, -5, -6)
      scene.add(fill)

      let maxRadius = 1
      for (const id of layout.order) {
        const point = layout.positions.get(id)
        if (point) maxRadius = Math.max(maxRadius, Math.hypot(point.x, point.y, point.z))
      }

      const sphere = new THREE.SphereGeometry(1, 20, 14)
      disposables.push(sphere)

      const meshes: ThreeModule.Mesh[] = []
      layout.order.forEach((id) => {
        const point = layout.positions.get(id)
        if (!point) return
        const degree = model.degree.get(id) ?? 0
        // Degree drives size: hubs are the things worth clicking.
        const scale = 0.16 + (degree / model.maxDegree) * 0.42
        const label = model.labels.get(id)
        // Opaque and matte, matching the neumorphic material of the chrome: in
        // 3D the nodes are the moulded solids, and the label colour is what
        // carries information. Selection/state still moves the emissive.
        const material = new THREE.MeshPhysicalMaterial({
          color: toneFor(label),
          roughness: 0.52,
          metalness: 0,
          clearcoat: 0.12,
          clearcoatRoughness: 0.6,
          emissive: toneFor(label),
          emissiveIntensity: 0.12,
        })
        disposables.push(material)

        const mesh = new THREE.Mesh(sphere, material)
        mesh.position.set(point.x, point.y, point.z)
        mesh.scale.setScalar(scale)
        mesh.userData.nodeId = id
        mesh.userData.baseScale = scale
        group.add(mesh)
        meshes.push(mesh)
      })

      /* All edges in one line batch: a single draw call for the whole graph. */
      const edgePositions: number[] = []
      const edgeColours: number[] = []
      const scratch = new THREE.Color()
      for (const edge of edges) {
        const from = layout.positions.get(edge.from)
        const to = layout.positions.get(edge.to)
        if (!from || !to) continue
        edgePositions.push(from.x, from.y, from.z, to.x, to.y, to.z)
        scratch.set(RELATION_META[edge.type as RelationType]?.color ?? '#6b7a99')
        edgeColours.push(scratch.r, scratch.g, scratch.b, scratch.r, scratch.g, scratch.b)
      }
      const edgeGeometry = new THREE.BufferGeometry()
      edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3))
      edgeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(edgeColours, 3))
      const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4 })
      disposables.push(edgeGeometry, edgeMaterial)
      const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial)
      group.add(edgeLines)

      /* Frame the node cloud: fit maxRadius into the vertical field of view. */
      const fitDistance = (maxRadius + 1.8) / Math.tan((camera.fov * Math.PI) / 360)
      camera.position.set(0, maxRadius * 0.35, fitDistance * 1.05)
      camera.near = 0.1
      camera.far = fitDistance * 8
      camera.updateProjectionMatrix()

      const raycaster = new THREE.Raycaster()
      const pointerNdc = new THREE.Vector2()

      /* ---------------------------------------------------------- interaction */
      let yaw = 0
      let pitch = 0.18
      let targetYaw = 0
      let targetPitch = 0.18
      let distance = fitDistance * 1.05
      let targetDistance = distance
      let dragging = false
      let lastX = 0
      let lastY = 0
      let travelled = 0
      let hovered: string | null = null

      const canvas = renderer.domElement
      canvas.style.cursor = 'grab'
      canvas.style.touchAction = 'none'

      const pick = (clientX: number, clientY: number): string | null => {
        const rect = canvas.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        pointerNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1))
        raycaster.setFromCamera(pointerNdc, camera)
        const hit = raycaster.intersectObjects(meshes, false)[0]
        return hit ? (hit.object.userData.nodeId as string) : null
      }

      const onPointerDown = (event: PointerEvent): void => {
        dragging = true
        travelled = 0
        lastX = event.clientX
        lastY = event.clientY
        canvas.setPointerCapture?.(event.pointerId)
        canvas.style.cursor = 'grabbing'
      }

      const onPointerMove = (event: PointerEvent): void => {
        if (dragging) {
          const dx = event.clientX - lastX
          const dy = event.clientY - lastY
          travelled += Math.abs(dx) + Math.abs(dy)
          lastX = event.clientX
          lastY = event.clientY
          targetYaw -= dx * 0.006
          targetPitch = Math.max(-1.15, Math.min(1.15, targetPitch + dy * 0.005))
          return
        }
        const id = pick(event.clientX, event.clientY)
        if (id !== hovered) {
          hovered = id
          canvas.style.cursor = id ? 'pointer' : 'grab'
        }
      }

      const onPointerUp = (event: PointerEvent): void => {
        dragging = false
        canvas.style.cursor = hovered ? 'pointer' : 'grab'
        // A drag moves the camera; a click selects. Tell them apart by travel, so
        // orbiting never lands on a node by accident.
        if (travelled > 4) return
        onSelect(pick(event.clientX, event.clientY))
      }

      const onWheel = (event: WheelEvent): void => {
        event.preventDefault()
        targetDistance = Math.max(maxRadius * 0.6, Math.min(fitDistance * 2.6, targetDistance + event.deltaY * 0.006))
      }

      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', onPointerUp)
      canvas.addEventListener('pointercancel', onPointerUp)
      canvas.addEventListener('wheel', onWheel, { passive: false })

      let pointer = { x: 0, y: 0 }

      return {
        onPointer(ndc) {
          pointer = ndc ?? { x: 0, y: 0 }
        },

        step(elapsed, delta) {
          const model = highlightRef.current
          const highlighting = Boolean(model.anchor && (model.prerequisites.size > 0 || model.downstream.size > 0))

          for (const mesh of meshes) {
            const id = mesh.userData.nodeId as string
            const material = mesh.material as ThreeModule.MeshPhysicalMaterial
            const base = mesh.userData.baseScale as number
            const isSelected = model.anchor === id && model.anchor !== null
            const isPrereq = model.prerequisites.has(id)
            const isDownstream = model.downstream.has(id)

            if (isPrereq) {
              material.color.setHex(PREREQ_COLOUR)
              material.emissive.setHex(PREREQ_COLOUR)
              material.emissiveIntensity = 0.5
              material.opacity = 1
            } else if (isDownstream) {
              material.color.setHex(DOWNSTREAM_COLOUR)
              material.emissive.setHex(DOWNSTREAM_COLOUR)
              material.emissiveIntensity = 0.5
              material.opacity = 1
            } else {
              const tone = toneFor(model.labels.get(id))
              material.color.setHex(tone)
              material.emissive.setHex(tone)
              material.emissiveIntensity = 0.22
              material.opacity = highlighting ? 0.22 : 0.96
            }

            const emphasis = isSelected ? 1.85 : isPrereq || isDownstream ? 1.4 : 1
            const pulse = isSelected ? 1 + Math.sin(elapsed * 2.6) * 0.07 : 1
            mesh.scale.setScalar(base * emphasis * pulse)
          }

          // Highlighted edges keep full opacity; the rest recede with their nodes.
          edgeMaterial.opacity = highlighting ? 0.12 : 0.4

          /* Camera: damped orbit, plus a slow automatic drift so an untouched
             view still shows that it is three-dimensional. */
          targetYaw += delta * 0.05
          yaw += (targetYaw - yaw) * Math.min(1, delta * 6)
          pitch += (targetPitch - pitch) * Math.min(1, delta * 6)
          distance += (targetDistance - distance) * Math.min(1, delta * 4)

          camera.position.set(
            Math.sin(yaw) * distance + pointer.x * 0.6,
            Math.sin(pitch) * distance * 0.55 + pointer.y * 0.6,
            Math.cos(yaw) * distance,
          )
          camera.lookAt(0, 0, 0)
        },

        dispose() {
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('pointermove', onPointerMove)
          canvas.removeEventListener('pointerup', onPointerUp)
          canvas.removeEventListener('pointercancel', onPointerUp)
          canvas.removeEventListener('wheel', onWheel)
          scene.remove(group)
          for (const item of disposables) item.dispose()
          meshes.length = 0
        },
      }
    },
    [edges, layout, model, onSelect],
  )

  const anchorName = model.anchor ? (model.names.get(model.anchor) ?? model.anchor) : null

  /*
   * A cheap signature of *what is drawn*: node ids in layout order, the edge
   * count, and the current highlight sets. `Scene3D` rebuilds on a change to this
   * and on nothing else, so selecting a node re-lights the graph, while an
   * unrelated re-render (a hover tooltip elsewhere on the page) does not throw
   * the scene and the user's camera angle away.
   */
  const sceneKey = useMemo(() => {
    const ids = nodes.map((node) => node.id).join(',')
    const prereq = [...model.prerequisites].sort().join(',')
    const downstream = [...model.downstream].sort().join(',')
    return `${ids}#${edges.length}#${model.anchor ?? ''}#${prereq}#${downstream}`
  }, [nodes, edges, model])

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <Compass aria-hidden="true" className="h-3.5 w-3.5" />
          Drag to orbit, scroll to zoom, click a node for details.
        </span>
        <span className="inline-flex items-center gap-1">
          <Boxes aria-hidden="true" className="h-3.5 w-3.5" />
          {nodes.length} nodes · {edges.length} relationships
        </span>
        <span className="inline-flex items-center gap-1">
          <Repeat aria-hidden="true" className="h-3.5 w-3.5" />
          Deterministic layout
        </span>
        <span className="inline-flex items-center gap-1">
          <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: PREREQ_HEX }} aria-hidden="true" /> must come
          first
          <span className="ml-1 inline-block h-2 w-2 rounded-full" style={{ background: DOWNSTREAM_HEX }} aria-hidden="true" />{' '}
          unlocked
        </span>
      </div>

      {anchorName ? (
        <p className="mb-2 text-xs">
          Highlighting: <span className="font-medium text-ink">{anchorName}</span>
          {model.prerequisites.size > 0 ? ` · ${model.prerequisites.size} prerequisite(s)` : ''}
          {model.downstream.size > 0 ? ` · ${model.downstream.size} unlocked` : ''}
        </p>
      ) : null}

      <Scene3D
        label="Knowledge graph in three dimensions"
        className="h-[420px] w-full overflow-hidden rounded-xl sm:h-[560px]"
        build={build}
        sceneKey={sceneKey}
        fallback={
          <div className="grid h-full place-items-center rounded-xl border border-line p-6">
            <Callout kind="info" title="The 3D view is not available on this device">
              Nothing is lost: switch to <strong>Canvas</strong> for the interactive 2D graph, or <strong>List</strong> for the
              same nodes and relationships as text.
            </Callout>
          </div>
        }
      />

      {truncated ? (
        <Callout kind="warning" title="This is a bounded view">
          The result was cut off by the depth or row limit, so this is not the whole graph. Narrow the filters or reduce the
          number of hops to see a denser picture.
        </Callout>
      ) : null}

      {provenanceNote ? <p className="mt-2 text-xs text-muted">{provenanceNote}</p> : null}
    </div>
  )
}


