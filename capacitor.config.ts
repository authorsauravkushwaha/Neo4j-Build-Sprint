import type { CapacitorConfig } from '@capacitor/cli'

/**
 * GraphMentor AI — Capacitor configuration.
 *
 * The Android app loads the *same* built web app (dist/) inside a hardened
 * WebView. It uses the same build-time API base as the web frontend; depending
 * on deployment that can be the Node API or the Supabase Edge Functions.
 * The app can also use bundled demo data when no backend is configured.
 *
 * Secrets: nothing sensitive is bundled here. Neo4j passwords and AI keys stay
 * in the selected backend's server-side configuration.
 */
const config: CapacitorConfig = {
  appId: 'ai.graphmentor.app',
  appName: 'GraphMentor AI',
  webDir: 'dist',
  // Android: keep the WebView on https://localhost with no mixed content.
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
    // Only these prefixes may navigate the WebView itself; everything else is
    // handed to the system browser by src/core/platform/externalLinks.ts.
    allowNavigation: [],
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    backgroundColor: '#0b1220',
  },
  ios: {
    contentInset: 'always',
    backgroundColor: '#0b1220',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: '#0b1220ff',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b1220',
      overlaysWebView: false,
    },
    // No network/geolocation/contacts/storage permissions are requested.
  },
}

export default config


