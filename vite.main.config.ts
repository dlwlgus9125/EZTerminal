import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // External modules — must match scripts/build-e2e.mjs externals
      // and forge.config.ts asar.unpack list.
      external: [
        "electron",
        "node-pty",
        "cap",
        "systeminformation",
        "chokidar",
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
        "querystring",
        "assert",
        "zlib",
        "http",
        "https",
        "tls",
        "dns",
        "readline",
        "cluster",
        "worker_threads",
        "perf_hooks",
      ],
    },
  },
  resolve: {
    // Some libs that can run in both Web and Node.js, such as `axios`,
    // we need to tell Vite to build them in Node.js context.
    conditions: ["node", "module", "import"],
  },
});
