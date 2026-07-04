import { defineConfig } from 'vite';

// Vite config for the script-host utilityProcess entry (E4). Forge-vite handles
// Node externals and CJS output format for 'main' targets. Unlike the
// interpreter's config, there is no native module to externalize here — the
// script host is plain JS (dynamic `import()` of the user's own script, which
// resolves its own node_modules from its own location — see script-host.ts).
// https://vitejs.dev/config
export default defineConfig({});
