import { defineConfig } from "@playwright/test";

const storybookUrl = "http://127.0.0.1:6006";

function configuredRetries(defaultValue: number): number {
  const raw = process.env.EZTERMINAL_PLAYWRIGHT_RETRIES;
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`EZTERMINAL_PLAYWRIGHT_RETRIES must be a non-negative integer (received ${raw})`);
  }
  return parsed;
}

export default defineConfig({
  testDir: "./visual",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: configuredRetries(0),
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
