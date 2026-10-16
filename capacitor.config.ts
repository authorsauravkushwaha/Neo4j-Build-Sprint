import type { CapacitorConfig } from '@capacitor/cli'

/**
 * GraphMentor AI — Capacitor configuration.
 *
 * The Android app loads the *same* built web app (dist/) inside a hardened
 * WebView. It talks to the *same* Edge Functions and the *same* Supabase
 * database as the website — there is no second copy of any user data.
 *
 * Secrets: nothing sensitive is bundled here. The Neo4j password and AI keys
 * exist only as Supabase Edge Function secrets.
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


