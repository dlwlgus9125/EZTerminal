import path from "node:path";
import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  build: {
    // Forge VitePlugin uses '.vite/build' as default outDir for both main and preload,
    // causing filename collision (both output index.js). Preload needs its own directory
    // matching the path referenced in main: path.join(__dirname, "../preload/index.js")
    outDir: path.resolve(__dirname, ".vite/preload"),
    rollupOptions: {
      external: [
        "electron",
        "fs",
        "path",
        "os",
        "net",
        "child_process",
        "events",
        "stream",
        "util",
        "crypto",
        "buffer",
        "url",
      ],
    },
  },
});
