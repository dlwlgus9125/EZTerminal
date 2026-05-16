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
    rollupOptions: {
      // Ensure Node.js built-ins are NOT bundled into renderer
      external: [],
    },
  },
});
