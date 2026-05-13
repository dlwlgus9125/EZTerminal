import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    // Electron requires the app to be built before testing
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "electron",
      use: {
        // Will be configured per-test to launch Electron
        launchOptions: {
          executablePath: path.resolve("./node_modules/.bin/electron"),
          args: ["."],
        },
      },
    },
  ],
  // Build is required before running e2e tests
  // Run: pnpm package first
});
