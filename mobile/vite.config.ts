import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web build for the Capacitor WebView shell (M2). Plain `vite build` — no
// Electron-specific config needed (contrast with the desktop's
// vite.renderer.config.ts, which injects a packaged-only CSP meta tag; the
// mobile CSP equivalent, if any, is Capacitor's own native-shell concern).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    // Local Android automation opts in with `vite build --mode e2e`.
    __EZTERMINAL_E2E__: JSON.stringify(mode === 'e2e'),
  },
  build: {
    // Android 10 (API 29) can ship with WebView 74 before Play-system
    // updates. Keep the bundle parseable there instead of relying on a
    // separately updated WebView (notably, WebView 74 cannot parse `??`).
    target: 'chrome74',
    outDir: 'dist',
    // The release verifier uses Rollup's graph metadata to prove the tiny
    // compatibility bootstrap has no static application dependencies and that
    // `main.tsx` remains behind the post-polyfill dynamic-import boundary.
    manifest: true,
  },
}));
