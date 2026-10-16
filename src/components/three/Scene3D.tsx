/**
 * The 3D substrate: one place that owns how three.js is imported, sized,
 * animated, paused and disposed.
 *
 * Rules it enforces for every scene in the app:
 *   - three.js is a *dynamic* import, so it lands in its own chunk and never
 *     delays first paint of a page that does not use it;
 *   - the renderer only exists when the container has a real box (a zero-sized
 *     canvas is exactly the failure that used to blank the 2D graph);
 *   - nothing renders when the tab is hidden or the canvas is scrolled away —
 *     a background 3D scene must not burn a phone battery;
 *   - resizing updates the camera and renderer instead of rebuilding the scene;
 *   - every GPU resource is released on unmount, including on the error path;
 *   - a lost WebGL context is survivable: the scene stops and the caller's flat
 *     fallback appears instead of a black rectangle.
 *
 * ---------------------------------------------------------------------------
 * A note on the effect structure, because this file has had two bugs that only a
 * real browser could show, and both were about dependencies:
 *
 *   1. The build effect depends on the *measured size*. It used to depend on
 *      `status === 'waiting'` — a boolean that is `true` on the first render and
 *      stays `true`, so when the first run happened at 0×0 it never ran again.
 *      The scenes sat in `waiting` forever and drew nothing, in every browser,
 *      while the tests (which measure 0×0 and assert the fallback) were green.
 *   2. The build effect must NOT depend on `status` while also setting it.
 *      `setStatus('building')` re-ran the effect, whose cleanup set
 *      `cancelled = true`, which made the in-flight build abort silently at the
 *      next `await` — leaving the component stuck in `building` with no canvas.
 *
 * So: capability lives in its own state, progress lives in another, and the build
 * effect keys off geometry and capability only. `scripts/verify-browser.ts`
 * asserts the outcome end to end in Chromium.
 * ---------------------------------------------------------------------------
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type * as ThreeModule from 'three'

import { detectWebGL, renderPixelRatio } from './webgl.ts'
import { useAppStore } from '@/state/store.ts'

export interface SceneApi {
  THREE: typeof ThreeModule
  scene: ThreeModule.Scene
  camera: ThreeModule.PerspectiveCamera
  renderer: ThreeModule.WebGLRenderer
  width: number
  height: number
}

/** What a scene hands back to the substrate. */
export interface SceneHandles {
  step?: (elapsedSeconds: number, deltaSeconds: number) => void
  /** Pointer in normalised device coordinates (-1..1), or null when it leaves. */
  onPointer?: (ndc: { x: number; y: number } | null) => void
  onResize?: (width: number, height: number) => void
  dispose?: () => void
}

export interface Scene3DProps {
  build: (api: SceneApi) => SceneHandles | null
  /** Shown when 3D is unavailable, after a context loss, or if loading failed. */
  fallback?: ReactNode
  className?: string
  /** Human-readable name for the scene; the canvas itself is aria-hidden. */
  label: string
  /** Keep rendering even when scrolled out of view. Default: pause. */
  pauseOffscreen?: boolean
  /**
   * Change this string to rebuild the scene: a signature of the data being drawn,
   * not of the render pass. Without it, a scene whose data changed would keep
   * showing the old graph, and with an inline `build` in the dependency list
   * every unrelated re-render would throw the scene — and the camera — away.
   */
  sceneKey?: string
}

type Status = 'waiting' | 'building' | 'running' | 'unsupported' | 'lost'

export function Scene3D({
  build,
  fallback = null,
  className = '',
  label,
  pauseOffscreen = true,
  sceneKey = '',
}: Scene3DProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = useAppStore((state) => state.ui.reducedMotion)
  const force3d = useAppStore((state) => state.ui.force3d)

  /** Can this device do WebGL at all, by the app's own rules? */
  const [capable, setCapable] = useState<boolean>(() => detectWebGL(force3d).supported)
  const [status, setStatus] = useState<Status>(() => (detectWebGL(force3d).supported ? 'waiting' : 'unsupported'))
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [failure, setFailure] = useState<string | null>(null)

  /* Live references, so resizing never rebuilds the scene. */
  const handlesRef = useRef<SceneHandles | null>(null)
  const rendererRef = useRef<ThreeModule.WebGLRenderer | null>(null)
  const cameraRef = useRef<ThreeModule.PerspectiveCamera | null>(null)
  const builtRef = useRef(false)

  /*
   * The build callback and the pause flag are read through refs so the build
   * effect does not depend on their identities. Callers legitimately pass
   * callbacks that are recreated when their own filters change (`Graph3D` wraps
   * one over its whole filter model); keying the effect on those objects would
   * tear the scene down on unrelated re-renders.
   */
  const buildRef = useRef(build)
  const pauseRef = useRef(pauseOffscreen)
  useEffect(() => {
    buildRef.current = build
    pauseRef.current = pauseOffscreen
  })

  /*
   * Re-probe when either preference changes: reduced motion can remove the
   * capability, and "try 3D anyway" can add it back. `detectWebGL(force)` also
   * clears the module-level cache when forced, so a device that failed the first
   * probe gets a genuine second attempt rather than the cached "no".
   *
   * This sets capability only — never `status`. Mixing the two is bug 2 above.
   */
  useEffect(() => {
    const supported = detectWebGL(force3d).supported
    setCapable(supported)
    setStatus((current) => {
      // Never downgrade a scene that is already on screen and drawing.
      if (current === 'running' || current === 'building') return current
      return supported ? 'waiting' : 'unsupported'
    })
  }, [reducedMotion, force3d])

  /* 1. Measure the box. No box, no renderer — the mistake that blanks canvases. */
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

  /*
   * 2. Build once, when there is a capability and something to draw into.
   *
   * Dependencies are geometry, capability and `sceneKey` — deliberately not
   * `status` (bug 2) and not `build` (see the refs below). Resizes are handled by
   * effect 3; `builtRef` makes later runs cheap no-ops.
   */
  useEffect(() => {
    if (!capable || builtRef.current) return
    if (size.width === 0 || size.height === 0) return
    const container = containerRef.current
    if (!container) return
    builtRef.current = true

    let cancelled = false
    let raf = 0
    let cleanupListeners: (() => void) | null = null
    let visible = true

    const fail = (message: string, next: Status): void => {
      if (cancelled) return
      setFailure(message)
      setStatus(next)
    }

    const start = async (): Promise<void> => {
      setStatus('building')

      let THREE: typeof ThreeModule
      try {
        THREE = await import('three')
      } catch {
        fail('The 3D engine could not be loaded — it may be blocked by your network or an extension.', 'lost')
        return
      }
      if (cancelled) return

      try {
        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(46, size.width / size.height, 0.1, 400)
        const renderer = new THREE.WebGLRenderer({
          antialias: renderPixelRatio() < 2,
          alpha: true,
          powerPreference: 'high-performance',
        })
        renderer.setPixelRatio(renderPixelRatio())
        renderer.setSize(size.width, size.height, false)
        renderer.setClearColor(0x000000, 0)
        // Tone mapping and a correct output colour space are what stop the glass
        // reading as flat plastic under the scene lights.
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.05
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.domElement.setAttribute('aria-hidden', 'true')
        renderer.domElement.style.display = 'block'
        renderer.domElement.style.width = '100%'
        renderer.domElement.style.height = '100%'
        container.appendChild(renderer.domElement)

        rendererRef.current = renderer
        cameraRef.current = camera

        const onContextLost = (event: Event): void => {
          event.preventDefault()
          cancelAnimationFrame(raf)
          fail('Your device dropped the 3D context (this happens when a GPU is busy or memory is low).', 'lost')
        }
        renderer.domElement.addEventListener('webglcontextlost', onContextLost)

        const handles = buildRef.current({ THREE, scene, camera, renderer, width: size.width, height: size.height })
        handlesRef.current = handles

        const clock = new THREE.Clock()
        const loop = (): void => {
          raf = requestAnimationFrame(loop)
          const delta = clock.getDelta()
          if (!visible || document.hidden) return
          handles?.step?.(clock.getElapsedTime(), delta)
          renderer.render(scene, camera)
        }

        let observer: IntersectionObserver | null = null
        if (pauseRef.current && typeof IntersectionObserver !== 'undefined') {
          observer = new IntersectionObserver(
            (entries) => {
              visible = entries.some((entry) => entry.isIntersecting)
            },
            { threshold: 0.01 },
          )
          observer.observe(container)
        }

        const onPointerMove = (event: PointerEvent): void => {
          const rect = container.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return
          handles?.onPointer?.({
            x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
            y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
          })
        }
        const onPointerLeave = (): void => handles?.onPointer?.(null)
        container.addEventListener('pointermove', onPointerMove, { passive: true })
        container.addEventListener('pointerleave', onPointerLeave)

        cleanupListeners = () => {
          observer?.disconnect()
          container.removeEventListener('pointermove', onPointerMove)
          container.removeEventListener('pointerleave', onPointerLeave)
          renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
        }

        setStatus('running')
        loop()
      } catch (error) {
        fail(
          `The 3D view could not start on this device${error instanceof Error ? ` (${error.message})` : ''}. The flat view has the same content.`,
          'lost',
        )
      }
    }

    void start()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      cleanupListeners?.()
      handlesRef.current?.dispose?.()
      handlesRef.current = null
      const renderer = rendererRef.current
      if (renderer) {
        renderer.dispose()
        // Free the GPU context explicitly: browsers cap how many may exist.
        renderer.forceContextLoss()
        renderer.domElement.remove()
      }
      rendererRef.current = null
      cameraRef.current = null
      builtRef.current = false
    }
    // The scene is a function of geometry, capability and the caller's data key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capable, size.width, size.height, sceneKey])

  /* 3. Resize in place. */
  useEffect(() => {
    const renderer = rendererRef.current
    const camera = cameraRef.current
    if (!renderer || !camera || size.width === 0 || size.height === 0) return
    renderer.setSize(size.width, size.height, false)
    camera.aspect = size.width / size.height
    camera.updateProjectionMatrix()
    handlesRef.current?.onResize?.(size.width, size.height)
  }, [size])

  const degraded = status === 'unsupported' || status === 'lost'

  return (
    <div className={`relative ${className}`}>
      {/*
        `data-status` and `data-size` are deliberate diagnosis hooks: the states
        this component can be in (`waiting`, `building`, `running`, `unsupported`,
        `lost`) are otherwise invisible from the DOM, and "the 3D view is blank"
        is a bug report nobody can act on without them. `npm run verify:browser`
        reads them, and so can anyone with devtools open.
      */}
      <div
        ref={containerRef}
        className="h-full w-full"
        data-testid="scene-3d"
        data-status={status}
        data-size={`${size.width}x${size.height}`}
      />

      {!degraded && status !== 'running' ? (
        <div className="gm-glass-raw pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit]">
          <span className="gm-label">{label}: preparing…</span>
        </div>
      ) : null}

      {degraded && fallback ? <div className="h-full w-full">{fallback}</div> : null}

      {degraded ? (
        <p className="sr-only">
          {label} is unavailable.{failure ? ` ${failure}` : ''} A non-animated version of this content is shown instead.
        </p>
      ) : null}
    </div>
  )
}


