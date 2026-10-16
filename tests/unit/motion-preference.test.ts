/**
 * The "Reduce motion" switch has to reduce motion.
 *
 * This exists because it did not. The app wrote `data-reduced-motion` while the
 * 3D gate and the stylesheet read `data-motion`, so the switch changed an
 * attribute nobody consulted: 3D scenes kept drifting and CSS animations kept
 * running for a user who had explicitly asked them to stop. The OS preference
 * worked, which is why every test that emulated the OS setting passed while the
 * in-app switch did nothing.
 *
 * Three independent things must agree on one spelling, so all three are pinned
 * here: the writer (the store), the reader (the WebGL gate) and the stylesheet.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { detectWebGL, resetWebGLCache } from '@/components/three/webgl.ts'
import { applyTheme, useAppStore } from '@/state/store.ts'

const root = resolve(__dirname, '../..')
const css = readFileSync(resolve(root, 'src/styles/index.css'), 'utf8')
const storeSource = readFileSync(resolve(root, 'src/state/store.ts'), 'utf8')
const gateSource = readFileSync(resolve(root, 'src/components/three/webgl.ts'), 'utf8')

describe('the reduce-motion preference', () => {
  it('writes the attribute the 3D gate reads', () => {
    applyTheme({ ...useAppStore.getState().ui, theme: 'dark', reducedMotion: true })
    expect(document.documentElement.dataset.motion).toBe('reduced')
    applyTheme({ ...useAppStore.getState().ui, theme: 'dark', reducedMotion: false })
    expect(document.documentElement.dataset.motion).toBe('full')
  })

  it('reflects the operating system too, not only the app switch', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      // The app switch is off; the operating system is asking for less motion.
      applyTheme({ ...useAppStore.getState().ui, theme: 'dark', reducedMotion: false })
      expect(document.documentElement.dataset.motion).toBe('reduced')
    } finally {
      window.matchMedia = original
    }
  })

  it('switches the 3D gate off, with a reason a person can read', () => {
    document.documentElement.dataset.motion = 'reduced'
    resetWebGLCache()
    const capability = detectWebGL()
    expect(capability.supported).toBe(false)
    expect(capability.reason ?? '').toMatch(/reduced motion/i)

    document.documentElement.dataset.motion = 'full'
    resetWebGLCache()
  })

  it('is the spelling the stylesheet actually matches', () => {
    expect(css).toMatch(/\[data-motion='reduced'\]\s*\.gm-tilt/)
    expect(css).toMatch(/\[data-motion='reduced'\]\s*\.gm-float/)
    // The retired spelling must not come back: a rule nothing sets is dead code
    // that reads like a feature.
    expect(css).not.toMatch(/data-reduced-motion/)
  })

  it('is never written under a second name anywhere in the app', () => {
    // The retired *write* forms, not the words: the comment in store.ts names the
    // old attribute on purpose, to explain why it must not come back.
    for (const [file, source] of [
      ['src/state/store.ts', storeSource],
      ['src/components/three/webgl.ts', gateSource],
    ] as const) {
      expect(source, `${file} still writes the retired attribute`).not.toMatch(/dataset\.reducedMotion\s*=\s*['"]/)
      expect(source, `${file} still writes the retired attribute`).not.toMatch(/setAttribute\(\s*['"]data-reduced-motion['"]/)
    }
    expect(gateSource).toMatch(/dataset\.motion === 'reduced'/)
  })

  it('is honoured through the store action the settings screen calls', () => {
    useAppStore.getState().setUi({ reducedMotion: true })
    expect(document.documentElement.dataset.motion).toBe('reduced')
    useAppStore.getState().setUi({ reducedMotion: false })
    expect(document.documentElement.dataset.motion).toBe('full')
  })
})


