import { defineConfig } from 'vite';

// Vite config for the interpreter utilityProcess entry.
// Forge-vite handles Node externals and CJS output format for 'main' targets.
//
// node-pty is a NATIVE module (not a Node builtin), so Forge's auto-externalize
// list does NOT cover it. Without marking it external, Vite would try to bundle
// its `require('./build/Release/*.node')` edge and break native loading at
// runtime. Externalizing keeps `require('node-pty')` intact so the CJS bundle
// resolves the real (asar-unpacked) module at runtime.
//
// ssh2 (E5) is pure-JS here (Option B packaging, design §7.3 — no native build:
// its optional `cpu-features` acceleration is never compiled, and ssh2 itself
// falls back gracefully), but it and its prod deps (asn1, bcrypt-pbkdf, ...)
// still ship NO node_modules in a Forge+Vite package — bundling would pull in
// dynamic `require()`s ssh2 uses internally. Externalizing + forge.config.ts's
// packageAfterPrune recursive copier keeps `require('ssh2')` intact.
// https://vitejs.dev/config
export default defineConfig({
  // @xterm/headless 6.0.0 publishes its Node build under lib-headless, but its
  // package.json `module` field points at the nonexistent lib/xterm.mjs.
  // Node's CJS resolver falls back to `main`; Vite does not. Pin the package's
  // real ESM artifact so the semantic-restore model is bundled into the
  // interpreter utilityProcess instead of becoming a runtime external.
  resolve: {
    alias: {
      '@xterm/headless': '@xterm/headless/lib-headless/xterm-headless.mjs',
    },
  },
  build: {
    rollupOptions: {
      external: ['node-pty', 'ssh2'],
    },
  },
});
