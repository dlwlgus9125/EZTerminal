import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/*.e2e.ts", "**/*.spec.ts", "**/*.test.ts"],
  timeout: 60000,
  // Allow extra time for Electron worker teardown (PTY processes need time to exit)
  workers: 1,
  expect: {
    timeout: 10000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    // Electron requires the app to be built before testing
    trace: "on-first-retry",
    launchOptions: {
      slowMo: 0,
    },
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
