import { defineConfig } from "@playwright/test";

const storybookUrl = "http://127.0.0.1:6006";

export default defineConfig({
  testDir: "./visual",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: storybookUrl,
    colorScheme: "dark",
    deviceScaleFactor: 1,
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm storybook --ci --no-open",
    url: `${storybookUrl}/index.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
