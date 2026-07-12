import { defineConfig } from 'vitest/config';

// mobile/ is a browser-only bundle boundary (Capacitor WebView, M2+) — its
// tests run under jsdom (unlike the root project's `environment: 'node'`)
// since ws-ezterminal.ts uses `window`/`MessageEvent`/`EventTarget` directly.
export default defineConfig({
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**'],
  },
});
