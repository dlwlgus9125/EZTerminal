import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  // Set root to renderer directory so Vite can find index.html
  root: path.resolve(__dirname, "src/renderer"),
  // Use relative base for Electron file:// protocol
  base: "./",
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
  build: {
    // Absolute path required: Forge VitePlugin sets outDir as relative,
    // but our custom root makes it resolve to src/renderer/.vite/ instead
    // of the project root .vite/ where electron-packager expects it.
    outDir: path.resolve(__dirname, ".vite/renderer/main_window"),
    rollupOptions: {
      // Ensure Node.js built-ins are NOT bundled into renderer
      external: [],
    },
  },
});
