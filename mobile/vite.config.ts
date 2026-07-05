import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web build for the Capacitor WebView shell (M2). Plain `vite build` — no
// Electron-specific config needed (contrast with the desktop's
// vite.renderer.config.ts, which injects a packaged-only CSP meta tag; the
// mobile CSP equivalent, if any, is Capacitor's own native-shell concern).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
});
