import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: "**/node_modules/{node-pty,systeminformation,chokidar,electron-log}/**",
    },
    name: "EZTerminal",
    executableName: "ezterminal",
    afterCopy: [
      (
        buildPath: string,
        _electronVersion: string,
        _platform: string,
        _arch: string,
        callback: (err?: Error | null) => void
      ) => {
        // VitePlugin bundles JS but leaves native modules as require() calls.
        // We need node_modules in the packaged app for these to resolve.
        const destModules = path.join(buildPath, "node_modules");
        if (!fs.existsSync(destModules)) {
          fs.mkdirSync(destModules, { recursive: true });
        }
        // Install production deps into the packaged app directory
        const pkgSrc = path.join(__dirname, "package.json");
        const pkgDest = path.join(buildPath, "package.json");
        // Copy package.json if not already there
        if (!fs.existsSync(pkgDest)) {
          fs.copyFileSync(pkgSrc, pkgDest);
        }
        try {
          const { execSync } = require("node:child_process");
          execSync("pnpm install --prod --no-frozen-lockfile", {
            cwd: buildPath,
            stdio: "inherit",
            shell: true,
          });
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "EZTerminal",
      authors: "EZTerminal Contributors",
      description: "EZTerminal - Electron-based local terminal emulator",
    }),
    new MakerZIP({}, ["darwin", "linux"]),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/index.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
