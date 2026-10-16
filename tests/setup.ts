/**
 * Test bootstrap.
 *
 * - adds jest-dom matchers for the component tests,
 * - gives jsdom the browser APIs the app uses but jsdom does not implement
 *   (matchMedia, ResizeObserver, canvas 2D context used by Cytoscape, scrolling),
 * - resets local storage between files so tests never inherit state.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

/* ---------------------------------------------------------------- matchMedia */

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

/* ------------------------------------------------------------- ResizeObserver */

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, configurable: true, value: ResizeObserverStub })
}

/* ------------------------------------------------------------------- scrolling */

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

/* ------------------------------------------------------------ canvas (Cytoscape) */

/**
 * jsdom has no canvas backend. Cytoscape only needs a context object to exist;
 * the graph tests assert on model data, never on rendered pixels.
 */
const canvasContextStub: Record<string, unknown> = {}
const contextMethods = [
  'arc',
  'beginPath',
  'clearRect',
  'clip',
  'closePath',
  'createLinearGradient',
  'drawImage',
  'fill',
  'fillRect',
  'fillText',
  'getImageData',
  'lineTo',
  'measureText',
  'moveTo',
  'putImageData',
  'rect',
  'restore',
  'rotate',
  'save',
  'scale',
  'setLineDash',
  'setTransform',
  'stroke',
  'strokeRect',
  'strokeText',
  'translate',
  'bezierCurveTo',
  'quadraticCurveTo',
  'ellipse',
  'createPattern',
  'transform',
  'resetTransform',
  'isPointInPath',
  'getLineDash',
]

for (const method of contextMethods) {
  canvasContextStub[method] = vi.fn()
}
canvasContextStub.measureText = vi.fn(() => ({ width: 10, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 2 }))
canvasContextStub.createLinearGradient = vi.fn(() => ({ addColorStop: vi.fn() }))
canvasContextStub.getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(4) }))
canvasContextStub.canvas = { width: 800, height: 600 }

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  writable: true,
  configurable: true,
  value: (type: string) => (type === '2d' ? canvasContextStub : null),
})

/* ----------------------------------------------------------------- URL helpers */

if (!URL.createObjectURL) {
  Object.defineProperty(URL, 'createObjectURL', { writable: true, configurable: true, value: () => 'blob:test' })
}
if (!URL.revokeObjectURL) {
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, configurable: true, value: () => {} })
}

/* ---------------------------------------------------------------- tests hooks */

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.dataset.theme = 'dark'
  // The attribute the app actually reads (see applyTheme in state/store.ts).
  document.documentElement.dataset.motion = 'full'
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})


