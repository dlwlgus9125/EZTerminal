import { defineConfig } from 'vite';

// Vite config for the Electron main process (broker).
//
// systeminformation (status-overlay-panel, SystemStatsService) is
// DELIBERATELY left un-externalized here — unlike node-pty/ssh2 in
// vite.interpreter.config.ts, which are externalized because node-pty loads
// native .node/.dll addons by real filesystem path (can't be bundled) and
// ssh2 uses internal dynamic requires. systeminformation has neither problem:
// every `require()` in its lib/ tree (checked directly in node_modules) is a
// static string literal with no platform- or runtime-computed paths, and a
// production Vite build of src/main/main.ts bundles it cleanly (verified:
// the built main.js inlines its exports — e.g. `powerShellStart`, its own
// "5.31.11" version string — with no literal `require('systeminformation')`
// or the bare string "systeminformation" anywhere in the output, confirming
// Rollup treated it as ordinary bundled JS, not an external). Runtime
// behavior in the packaged exe is still confirmed by team-verify's packaged
// smoke (T3.5, .omc/plans/status-overlay-panel.md).
//
// ws (mobile remote-control M0/M3) is NOT safe to bundle here, unlike
// systeminformation above: it has an internal `require('bufferutil')` /
// `require('utf-8-validate')` try/catch fallback (both are optional peer
// deps, deliberately not installed — ws's own pure-JS path handles frame
// masking without them). Bundling breaks that fallback — confirmed by an
// M3 emulator smoke test crashing with `TypeError: y.unmask is not a
// function` the moment a real client sent a WS frame (the connection opens
// fine; parsing the first frame is what crashes). Externalizing keeps
// `require('ws')` intact so it resolves the real node_modules/ws package
// (whose own fallback logic is untouched) — same shape as node-pty/ssh2's
// externalization in vite.interpreter.config.ts. forge.config.ts's
// packageAfterPrune copies the real module in for the packaged exe.
// https://vitejs.dev/config
export default defineConfig({
  define: {
    // Bake the source identity into the packaged app. Reading process.env only
    // at runtime would show "dev" when an end user launches the installed app.
    'process.env.EZTERMINAL_BUILD_SHA': JSON.stringify(
      process.env.EZTERMINAL_BUILD_SHA ?? process.env.GITHUB_SHA ?? 'dev',
    ),
    'process.env.GITHUB_SHA': JSON.stringify(
      process.env.EZTERMINAL_BUILD_SHA ?? process.env.GITHUB_SHA ?? 'dev',
    ),
  },
  build: {
    rollupOptions: {
      external: ['ws'],
    },
  },
});
