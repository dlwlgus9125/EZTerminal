/**
 * E2E tests for Tab Management (T6 scope — keyboard-driven).
 * AC-L2-02-1: Ctrl+T creates tab
 * AC-L2-02-2: Ctrl+W closes tab
 * AC-L2-02-3: Ctrl+Tab switches tab
 * AC-L2-02-N1: Ctrl+W on last tab is blocked
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

async function closeApp(app: Awaited<ReturnType<typeof launchApp>>): Promise<void> {
  const proc = app.process();
  const pid = proc.pid;
  await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  if (pid !== undefined && !proc.killed) {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  }
}

test.describe("Tab create", () => {
  test("Tab create - Ctrl+T adds a tab", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector(".xterm-viewport", { state: "attached", timeout: 10000 });

    const before = await window.locator("[data-tab-id]").count();
    expect(before).toBe(1);

    await window.keyboard.press("Control+t");
    await window.waitForTimeout(500);

    const after = await window.locator("[data-tab-id]").count();
    expect(after).toBe(2);

    await closeApp(app);
  });

  test("Tab create - multiple Ctrl+T calls add multiple tabs", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector(".xterm-viewport", { state: "attached", timeout: 10000 });

    await window.keyboard.press("Control+t");
    await window.keyboard.press("Control+t");
    await window.waitForTimeout(500);

    const count = await window.locator("[data-tab-id]").count();
    expect(count).toBe(3);

    await closeApp(app);
  });
});

test.describe("Tab close", () => {
  test("Tab close - Ctrl+W removes active tab", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector(".xterm-viewport", { state: "attached", timeout: 10000 });

    // Add a second tab
    await window.keyboard.press("Control+t");
    await window.waitForTimeout(500);
    expect(await window.locator("[data-tab-id]").count()).toBe(2);

    const activeBeforeId = await window.locator("[data-active='true']").getAttribute("data-tab-id");

    // Close it
    await window.keyboard.press("Control+w");
    await window.waitForTimeout(500);

    expect(await window.locator("[data-tab-id]").count()).toBe(1);

    // Remaining tab should NOT be the one we closed
    const remainingId = await window.locator("[data-tab-id]").getAttribute("data-tab-id");
    expect(remainingId).not.toBe(activeBeforeId);

    await closeApp(app);
  });
});

test.describe("Tab switch", () => {
  test("Tab switch - Ctrl+Tab cycles to next tab", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector(".xterm-viewport", { state: "attached", timeout: 10000 });

    const tab1Id = await window.locator("[data-tab-id]").first().getAttribute("data-tab-id");

    // Create second tab (becomes active)
    await window.keyboard.press("Control+t");
    await window.waitForTimeout(500);

    const activeAfterCreate = await window.locator("[data-active='true']").getAttribute("data-tab-id");
    expect(activeAfterCreate).not.toBe(tab1Id);

    // Ctrl+Tab → back to first tab (2 tabs, wraps around)
    await window.keyboard.press("Control+Tab");
    await window.waitForTimeout(500);

    const activeAfterSwitch = await window.locator("[data-active='true']").getAttribute("data-tab-id");
    expect(activeAfterSwitch).toBe(tab1Id);

    await closeApp(app);
  });
});

test.describe("Tab close last blocked", () => {
  test("Tab close last blocked - Ctrl+W on single tab does nothing", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector(".xterm-viewport", { state: "attached", timeout: 10000 });

    expect(await window.locator("[data-tab-id]").count()).toBe(1);

    // Attempt to close last tab
    await window.keyboard.press("Control+w");
    await window.waitForTimeout(500);

    // Should still have 1 tab
    expect(await window.locator("[data-tab-id]").count()).toBe(1);

    await closeApp(app);
  });
});
