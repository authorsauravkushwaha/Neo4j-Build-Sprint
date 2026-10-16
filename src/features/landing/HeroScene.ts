/**
 * The landing hero scene: a slow constellation of knowledge-graph nodes rendered
 * as soft moulded forms in real 3D.
 *
 * It is not decoration — the shapes and colours are the same vocabulary the
 * knowledge graph uses (nodes are labelled entities, edges are relationships),
 * so the hero is a small truthful preview of what the app does. What it is *not*
 * is live data: the node set here is a fixed composition, and the page says so
 * beside it. The real graph lives at /graph.
 *
 * Cost control: ~40 lens-shaped meshes, no post-processing, no external textures
 * or HDRIs (the environment is generated procedurally by three's RoomEnvironment,
 * which ships with the library). One directional light, one fill, a slow drift.
 */
import type * as ThreeModule from 'three'
import type { SceneApi, SceneHandles } from '@/components/three/Scene3D.ts'

/** Fixed, hand-tuned layout: deterministic, so it looks the same on every load. */
const NODES: Array<{ x: number; y: number; z: number; scale: number; tone: number; kind: 'career' | 'skill' | 'concept' | 'project' }> = [
  { x: -3.1, y: 0.9, z: 0.4, scale: 1.15, tone: 0, kind: 'career' },
  { x: -1.6, y: -1.3, z: -1.1, scale: 0.72, tone: 1, kind: 'skill' },
  { x: -2.2, y: 2.1, z: -0.6, scale: 0.55, tone: 2, kind: 'concept' },
  { x: 0.2, y: 1.5, z: 1.2, scale: 0.95, tone: 0, kind: 'career' },
  { x: 1.9, y: 0.3, z: -0.4, scale: 0.8, tone: 1, kind: 'skill' },
  { x: 3.2, y: -1.2, z: 0.7, scale: 0.6, tone: 2, kind: 'concept' },
  { x: 1.1, y: -1.9, z: 1.4, scale: 0.68, tone: 1, kind: 'skill' },
  { x: -0.6, y: -0.4, z: 2.1, scale: 0.5, tone: 3, kind: 'project' },
  { x: 2.4, y: 2.0, z: -1.3, scale: 0.48, tone: 2, kind: 'concept' },
  { x: -3.4, y: -0.9, z: -1.4, scale: 0.52, tone: 1, kind: 'skill' },
  { x: 0.9, y: 2.6, z: 0.2, scale: 0.42, tone: 3, kind: 'project' },
  { x: -1.2, y: -2.4, z: 0.3, scale: 0.45, tone: 1, kind: 'skill' },
]

/** Which nodes are connected; mirrors the shape of a dependency chain. */
const LINKS: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 3],
  [3, 4],
  [3, 5],
  [4, 6],
  [4, 7],
  [5, 8],
  [1, 6],
  [2, 9],
  [1, 9],
  [6, 11],
  [7, 11],
  [5, 10],
]

interface Tones {
  core: number
  rim: number
}

export function buildHeroScene({ THREE, scene, camera, renderer, width }: SceneApi): SceneHandles {
  const disposables: Array<{ dispose: () => void }> = []
  const group = new THREE.Group()
  scene.add(group)

  /* ---------------------------------------------------------------- lighting */
  scene.add(new THREE.AmbientLight(0xffffff, 0.35))

  // Neumorphic lighting, in 3D: the key comes from the upper LEFT and the fill
  // is a cooler, weaker light from the lower right, which is the same
  // light-up-left / shade-down-right pairing every surface in the UI casts.
  const key = new THREE.DirectionalLight(0xffffff, 1.9)
  key.position.set(-6, 7, 6)
  scene.add(key)

  const fill = new THREE.DirectionalLight(0x8fb4ff, 0.85)
  fill.position.set(6, -5, -3)
  scene.add(fill)

  const rim = new THREE.PointLight(0x2ee6e6, 22, 26, 2)
  rim.position.set(-2.5, 3.5, 4)
  scene.add(rim)

  /* --------------------------------------------------------------- material */
  const tones: Tones[] = [
    { core: 0x0e7490, rim: 0x22d3ee }, // careers
    { core: 0x6d28d9, rim: 0xa78bfa }, // skills
    { core: 0x047857, rim: 0x34d399 }, // concepts
    { core: 0xb45309, rim: 0xfbbf24 }, // projects
  ]

  const geometries: ThreeModule.BufferGeometry[] = [
    new THREE.IcosahedronGeometry(0.42, 1),
    new THREE.SphereGeometry(0.4, 32, 24),
    new THREE.TorusGeometry(0.3, 0.13, 20, 40),
    new THREE.OctahedronGeometry(0.46, 0),
  ]
  geometries.forEach((geometry) => disposables.push(geometry))

  const meshes: ThreeModule.Mesh[] = []
  const materialCache = new Map<string, ThreeModule.MeshPhysicalMaterial>()

  for (const node of NODES) {
    const tone = tones[node.tone]
    const key = `${node.tone}`
    let material: ThreeModule.MeshPhysicalMaterial | undefined = materialCache.get(key)
    if (!material) {
      material = new THREE.MeshPhysicalMaterial({
        color: tone.core,
        // Moulded, not glass. The site is neumorphic — one opaque material lit
        // from the upper left — so the nodes are matte and opaque to match:
        // no transmission (nothing refracts), no clearcoat gloss, and enough
        // roughness that the key light spreads into a soft highlight instead of
        // a specular pin. The four tonal hues stay, because they are the same
        // vocabulary the knowledge-graph legend uses.
        roughness: 0.55,
        metalness: 0,
        clearcoat: 0.1,
        clearcoatRoughness: 0.65,
        emissive: tone.rim,
        emissiveIntensity: 0.05,
      })
      materialCache.set(key, material)
      disposables.push(material)
    }
    const surface = material

    const mesh = new THREE.Mesh(geometries[node.kind === 'career' ? 0 : node.kind === 'skill' ? 1 : node.kind === 'concept' ? 2 : 3], surface)
    mesh.position.set(node.x, node.y, node.z)
    mesh.scale.setScalar(node.scale * 1.35)
    mesh.rotation.set(node.x * 0.3, node.y * 0.4, 0)
    mesh.userData.baseY = node.y
    mesh.userData.phase = node.x * 0.7 + node.y * 1.3
    group.add(mesh)
    meshes.push(mesh)
  }

  /* ------------------------------------------------------------------ edges */
  const edgePositions: number[] = []
  const edgeColors: number[] = []
  for (const [a, b] of LINKS) {
    const from = NODES[a]
    const to = NODES[b]
    edgePositions.push(from.x, from.y, from.z, to.x, to.y, to.z)
    const colour = new THREE.Color(0x8fb4ff)
    edgeColors.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b)
  }
  const edgeGeometry = new THREE.BufferGeometry()
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3))
  edgeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(edgeColors, 3))
  const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.34 })
  disposables.push(edgeGeometry, edgeMaterial)
  group.add(new THREE.LineSegments(edgeGeometry, edgeMaterial))

  /* Floating motes: cheap depth cue — a completely empty background reads as a
     flat poster, and motes give the camera movement something to travel past. */
  const moteCount = 220
  const moteGeometry = new THREE.BufferGeometry()
  const motePositions = new Float32Array(moteCount * 3)
  for (let index = 0; index < moteCount; index += 1) {
    motePositions[index * 3] = (Math.random() - 0.5) * 22
    motePositions[index * 3 + 1] = (Math.random() - 0.5) * 14
    motePositions[index * 3 + 2] = (Math.random() - 0.5) * 16 - 3
  }
  moteGeometry.setAttribute('position', new THREE.Float32BufferAttribute(motePositions, 3))
  const moteMaterial = new THREE.PointsMaterial({
    color: 0xbcd7ff,
    size: 0.035,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    sizeAttenuation: true,
  })
  disposables.push(moteGeometry, moteMaterial)
  const motes = new THREE.Points(moteGeometry, moteMaterial)
  scene.add(motes)

  /* ------------------------------------------------------------- interaction */
  let pointer = { x: 0, y: 0 }
  let smoothed = { x: 0, y: 0 }
  let manual = 0

  const onPointer = (ndc: { x: number; y: number } | null): void => {
    pointer = ndc ?? { x: 0, y: 0 }
  }

  // Drag to spin: the same gesture as the knowledge graph, so the hero teaches
  // the interaction instead of only admiring itself.
  const canvas = renderer.domElement
  let dragging = false
  let lastX = 0
  const onDown = (event: PointerEvent): void => {
    dragging = true
    lastX = event.clientX
    canvas.setPointerCapture?.(event.pointerId)
  }
  const onMove = (event: PointerEvent): void => {
    if (!dragging) return
    const dx = event.clientX - lastX
    lastX = event.clientX
    manual += dx * 0.005
  }
  const onUp = (): void => {
    dragging = false
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  canvas.style.cursor = 'grab'
  canvas.style.touchAction = 'pan-y'

  return {
    onPointer,

    step(elapsed, delta) {
      // Ease towards the pointer instead of following it exactly: glass should
      // feel heavy.
      smoothed.x += (pointer.x - smoothed.x) * Math.min(1, delta * 2.2)
      smoothed.y += (pointer.y - smoothed.y) * Math.min(1, delta * 2.2)

      group.rotation.y = manual + elapsed * 0.055 + smoothed.x * 0.28
      group.rotation.x = Math.sin(elapsed * 0.14) * 0.06 + smoothed.y * 0.16

      for (const mesh of meshes) {
        const phase = mesh.userData.phase as number
        mesh.position.y = (mesh.userData.baseY as number) + Math.sin(elapsed * 0.55 + phase) * 0.16
        mesh.rotation.x += delta * 0.16
        mesh.rotation.y += delta * 0.1
      }

      motes.rotation.y = elapsed * 0.012

      // A gentle dolly keeps the composition alive without moving the camera
      // enough to make text on top of it uncomfortable to read.
      camera.position.x = smoothed.x * 0.5
      camera.position.y = 0.6 + smoothed.y * 0.35
      camera.position.z = 9 - Math.sin(elapsed * 0.1) * 0.35
      camera.lookAt(0, 0, 0)

      void width
    },

    dispose() {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      for (const item of disposables) item.dispose()
      scene.remove(group)
      scene.remove(motes)
    },
  }
}


