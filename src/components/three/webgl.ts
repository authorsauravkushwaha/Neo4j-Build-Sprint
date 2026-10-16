/**
 * WebGL capability detection.
 *
 * Three.js is ~180 kB of the budget, so it is only ever imported after this says
 * yes. The check is deliberately conservative and side-effect free:
 *
 *   - no `window`/`document` (tests, SSR, prerender)      -> unsupported
 *   - reduced motion requested by the OS *or* the app     -> unsupported
 *     (the 3D views are all motion; a static frame of a floating scene is a
 *      worse experience than the flat view, so the flat view is what we give)
 *   - `data-saver` on, or a 2g-class connection           -> unsupported
 *   - no WebGL2 and no WebGL1 context                     -> unsupported
 *
 * Callers must treat "unsupported" as a normal state, never as an error: every
 * 3D surface in this app has a working non-3D equivalent behind it.
 */

let cached: boolean | null = null

export interface WebGLCapability {
  supported: boolean
  /** Why not, in words a settings screen can show. Empty when supported. */
  reason: string
}

function motionReduced(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true
  return document.documentElement.dataset.motion === 'reduced'
}

function connectionIsSlow(): boolean {
  if (typeof navigator === 'undefined') return false
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (!connection) return false
  if (connection.saveData === true) return true
  return connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g'
}

export function detectWebGL(force = false): WebGLCapability {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { supported: false, reason: 'No browser environment.' }
  }
  if (!force && motionReduced()) {
    return { supported: false, reason: 'Reduced motion is on, so animated 3D is switched off.' }
  }
  if (!force && connectionIsSlow()) {
    return { supported: false, reason: 'Your connection reports a data limit, so the 3D view is skipped.' }
  }
  // `force` deliberately bypasses the cache: a device that failed the first
  // probe deserves a genuine second attempt when the user asks for one.
  if (cached !== null && !force) {
    return cached ? { supported: true, reason: '' } : { supported: false, reason: 'This browser or GPU does not expose WebGL.' }
  }

  let supported = false
  try {
    const canvas = document.createElement('canvas')
    /*
     * `failIfMajorPerformanceCaveat` is what refuses a software rasteriser — and
     * it is exactly what the user's override has to switch off. Skipping only the
     * heuristics above (motion, connection) while still passing this flag made
     * "try 3D anyway" a no-op on any machine whose GPU is driven in software:
     * the override appeared to work, the preference saved, and nothing changed.
     * That bug survived every jsdom test and was found by rendering this in a
     * real browser with SwiftShader.
     */
    const attributes = { failIfMajorPerformanceCaveat: !force }
    const gl = canvas.getContext('webgl2', attributes) ?? canvas.getContext('webgl', attributes)
    supported = Boolean(gl)
    if (gl && typeof (gl as WebGLRenderingContext).getExtension === 'function') {
      const lose = (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')
      lose?.loseContext()
    }
  } catch {
    supported = false
  }
  cached = supported
  return supported ? { supported: true, reason: '' } : { supported: false, reason: 'This browser or GPU does not expose WebGL.' }
}

/** Called by the settings screen so an explicit preference can re-probe. */
export function resetWebGLCache(): void {
  cached = null
}

/** Device pixel ratio, clamped: a 4x phone screen must not render 4x the pixels. */
export function renderPixelRatio(): number {
  if (typeof window === 'undefined') return 1
  return Math.min(window.devicePixelRatio || 1, 2)
}


