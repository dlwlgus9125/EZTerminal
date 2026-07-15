import { defineConfig } from 'vite';

// Vite config for the preload script (narrow contextBridge API).
// https://vitejs.dev/config
const buildSha = process.env.EZTERMINAL_BUILD_SHA ?? process.env.GITHUB_SHA ?? 'dev';

export default defineConfig({
  // Preload exposes the build identity in About/Diagnostics. Compile it into
  // app.asar so it remains available outside the CI process environment.
  define: {
    'process.env.EZTERMINAL_BUILD_SHA': JSON.stringify(buildSha),
    'process.env.GITHUB_SHA': JSON.stringify(buildSha),
  },
});
