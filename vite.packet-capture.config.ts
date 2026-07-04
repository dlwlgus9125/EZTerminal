import { defineConfig } from 'vite';

// Vite config for the packet-capture utilityProcess entry (Phase 2B).
// Mirrors vite.interpreter.config.ts: `cap` is a NATIVE module (classic
// node-gyp `.node` addon, not a Node builtin), so Forge's auto-externalize
// list does not cover it. Without marking it external, Vite would try to
// bundle its native `require()` and break loading at runtime. Externalizing
// keeps `require('cap')` intact so the CJS bundle resolves the real
// (asar-unpacked, Electron-ABI-rebuilt) module at runtime.
// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['cap'],
    },
  },
});
