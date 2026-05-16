/**
 * Build all Electron targets for e2e testing.
 * Produces production-like .vite/ output: main, preload, renderer.
 *
 * Usage: node scripts/build-e2e.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Main process
mkdirSync(".vite/build", { recursive: true });
execFileSync(
  npx,
  [
    "esbuild",
    "src/main/index.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    // External modules — must match vite.main.config.ts externals
    // and forge.config.ts asar.unpack list.
    "--external:electron",
    "--external:node-pty",
    "--external:cap",
    "--external:systeminformation",
    "--external:electron-log",
    "--external:chokidar",
    "--define:MAIN_WINDOW_VITE_DEV_SERVER_URL='\"\"'",
    "--define:MAIN_WINDOW_VITE_NAME='\"main_window\"'",
    "--outfile=.vite/build/index.js",
  ],
  { stdio: "inherit", cwd: process.cwd(), shell: true }
);

// Preload
mkdirSync(".vite/preload", { recursive: true });
execFileSync(
  npx,
  [
    "esbuild",
    "src/preload/index.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=.vite/preload/index.js",
  ],
  { stdio: "inherit", cwd: process.cwd(), shell: true }
);

// Renderer
mkdirSync(".vite/renderer/main_window", { recursive: true });
execFileSync(
  npx,
  [
    "vite",
    "build",
    "--config",
    "vite.renderer.config.ts",
    "--outDir",
    "../../.vite/renderer/main_window",
  ],
  { stdio: "inherit", cwd: process.cwd(), shell: true }
);

console.log("\n--- e2e build complete ---");
