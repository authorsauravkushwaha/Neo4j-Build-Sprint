/**
 * Entry point.
 *
 * Order matters and is deliberate:
 *   0. tell zod not to probe for eval-based code generation (see core/zod-config.ts),
 *   1. apply the saved theme *before* the first paint (no flash, and no inline
 *      script is needed, which keeps the Content-Security-Policy strict),
 *   2. start the session probe (demo vs live) without blocking the render,
 *   3. mount the router,
 *   4. register the service worker afterwards, so a slow network can never delay
 *      the first screen. The service worker is registered from a module import
 *      (injectRegister: null in vite.config.ts) — the page contains no inline JS.
 */
// First, and deliberately before every other import: it must run before the
// shared dataset modules are evaluated. See the file for why.
import './core/zod-config.ts'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'

import './styles/index.css'
import { App } from './app/App.tsx'
import { applyTheme, useAppStore } from './state/store.ts'
import { initSession } from './core/session.ts'
import { config } from './core/env.ts'

applyTheme(useAppStore.getState().ui)

const container = document.getElementById('root')
if (!container) {
  throw new Error('The application root element (#root) is missing from index.html.')
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename={config.basePath === '/' ? undefined : config.basePath.replace(/\/$/, '')}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// Probe the backend in the background. Until it answers, the app runs in demo
// mode and says so; pages that need live data show their own loading state.
void initSession()

// Follow the OS theme when the user has not chosen one explicitly.
if (typeof window !== 'undefined' && window.matchMedia) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = (): void => {
    if (useAppStore.getState().ui.theme === 'system') applyTheme(useAppStore.getState().ui)
  }
  media.addEventListener?.('change', listener)
}

// Follow a change to the OS motion preference while the page is open, for the
// same reason the theme listener above exists: the declaration on <html> has to
// keep matching what the operating system is asking for.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => {
    applyTheme(useAppStore.getState().ui)
  })
}

// Re-apply the theme when the store changes it (the toggle in Settings).
useAppStore.subscribe((state, previous) => {
  if (state.ui !== previous.ui) applyTheme(state.ui)
})

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  registerSW({
    immediate: false,
    onNeedRefresh() {
      useAppStore.getState().pushToast({
        kind: 'info',
        message: 'A new version of GraphMentor is available.',
        detail: 'Reload when you are ready — your progress is kept.',
      })
    },
    onOfflineReady() {
      useAppStore.getState().pushToast({
        kind: 'success',
        message: 'Saved for offline use.',
        detail: 'The app shell and the sample dataset now work without a connection.',
      })
    },
  })
}


