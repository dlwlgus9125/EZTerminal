import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  build: {
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
