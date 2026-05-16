/**
 * E2E tests for Terminal I/O (T1 skeleton scope).
 * Launches Electron with the dev build (.vite/build/index.js + .vite/renderer/).
 *
 * Prerequisites:
 * - pnpm exec vite build --config vite.renderer.config.ts --outDir .vite/renderer/main_window
 * - Copy renderer output to .vite/renderer/main_window/
 * - Main process already built at .vite/build/index.js
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_EXEC = path.join(APP_ROOT, "node_modules/electron/dist/electron.exe");
const MAIN_ENTRY = path.join(APP_ROOT, ".vite/build/index.js");

async function launchApp() {
  return electron.launch({
    executablePath: ELECTRON_EXEC,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      NODE_ENV: "test",
      ELECTRON_IS_TEST: "1",
    },
  });
}

/** Close app with timeout to avoid hanging on PTY cleanup */
async function closeApp(app: Awaited<ReturnType<typeof launchApp>>): Promise<void> {
  const proc = app.process();
  const pid = proc.pid;
  await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  // Force-kill the electron process tree if still running (PTY children block exit on Windows)
  if (pid !== undefined && !proc.killed) {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  }
}

test.describe("Terminal echo", () => {
  test("Terminal echo - hello input displays in xterm", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // Wait for xterm to mount and PTY to connect
    await window.waitForSelector(".xterm-viewport", { state: "attached", timeout: 10000 });

    // Focus the xterm textarea and type via page keyboard
    const xtermTextarea = window.locator(".xterm-helper-textarea").first();
    await xtermTextarea.click({ force: true });
    await window.keyboard.type("hello");
    await window.keyboard.press("Enter");

    // Wait for echo output (PTY + 16ms coalescing + render)
    await window.waitForTimeout(3000);

    // Check xterm buffer contains "hello"
    const xtermContent = await window.evaluate(() => {
      const rows = document.querySelectorAll(".xterm-rows > div");
      return Array.from(rows)
        .map((r) => r.textContent ?? "")
        .join("\n");
    });
    expect(xtermContent).toContain("hello");

    await closeApp(app);
  });
});

test.describe("Terminal command", () => {
  test("Terminal command - echo test shows output", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector(".xterm-viewport", { state: "attached", timeout: 10000 });

    // Focus xterm and send input via page keyboard (after force-focusing the textarea)
    const xtermTextarea = window.locator(".xterm-helper-textarea").first();
    await xtermTextarea.click({ force: true });
    await window.keyboard.type("echo test");
    await window.keyboard.press("Enter");
    await window.waitForTimeout(3000);

    const xtermContent = await window.evaluate(() => {
      const rows = document.querySelectorAll(".xterm-rows > div");
      return Array.from(rows)
        .map((r) => r.textContent ?? "")
        .join("\n");
    });
    expect(xtermContent).toContain("test");

    await closeApp(app);
  });
});

test.describe("Terminal startup", () => {
  test("Terminal startup - shell prompt within 3s", async () => {
    const start = Date.now();
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // xterm-rows appears when xterm renders content (shell prompt)
    await window.waitForSelector(".xterm-rows", { timeout: 4000 });

    const elapsed = Date.now() - start;
    // Allow up to 3s from test start (not app launch) for shell prompt
    expect(elapsed).toBeLessThan(3000);

    await closeApp(app);
  });
});
