// capacitor.config.ts — Capacitor iOS shell config for EduSupervise.
//
// Phase 1 (this scaffold): wrap the live web app as an installable iOS app.
// `server.url` makes the WKWebView load the prod domain directly, which means:
//   - Session cookies set on edusupervise.ashbi.ca apply to every fetch
//     (no cross-origin cookie problem)
//   - The session/auth/RTE surface stays single-source on the web app
//   - Login state survives app launch (already in WKWebView cookie store)
//
// When we layer APNs push later, the same WKWebView continues to load the
// prod URL — the push pipeline is purely native (JS bridge to AppDelegate
// via @capacitor/push-notifications plugin) and doesn't change the web app's
// request path.
//
// `webDir` is required by `cap sync` but unused at runtime when `server.url`
// is set. We point it at the web build output so any offline-emergency
// fallback (e.g. `server.url` removed in dev) still has a sane target.

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ca.ashbi.edusupervise',
  appName: 'EduSupervise',
  webDir: 'apps/web/build/client',

  // Live URL — WKWebView navigates here on launch and stays in this origin.
  server: {
    url: 'https://edusupervise.ashbi.ca',
    cleartext: false,
    iosScheme: 'https',
  },

  ios: {
    contentInset: 'always',
    // Background color shown during launch screen. Matches the
    // Apple-HIG design tokens (system blue) — used until the WKWebView
    // has rendered the web app.
    backgroundColor: '#007AFF',
    // Allow Universal Links / URL scheme handlers to surface in-app
    // deep links from push notifications later.
    allowsLinkPreview: true,
  },

  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 0,
      backgroundColor: '#007AFF',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
  },
};

export default config;