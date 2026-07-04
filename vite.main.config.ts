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
// https://vitejs.dev/config
export default defineConfig({});
