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

    // Focus the terminal and type — click the terminal container first, then the textarea
    const termContainer = window.locator(".terminal-wrapper").first();
    await termContainer.click({ force: true });
    await window.waitForTimeout(200);
    const xtermTextarea = window.locator(".xterm-helper-textarea").first();
    await xtermTextarea.focus();
    await window.waitForTimeout(200);
    await window.keyboard.type("hello", { delay: 50 });
    await window.keyboard.press("Enter");
    await window.waitForTimeout(2000);

    // Verify: check xterm buffer via exposed __xterm__ or fall back to viewport existence
    const hasContent = await window.evaluate(() => {
      const term = (window as Record<string, unknown>).__xterm__;
      if (!term) return "NO_XTERM";
      const t = term as {
        buffer: {
          active: {
            length: number;
            getLine: (
              i: number
            ) => { translateToString: (trimRight?: boolean) => string } | undefined;
          };
        };
      };
      const buf = t.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line?.translateToString(true).includes("hello")) return "FOUND";
      }
      // Collect first 5 non-empty lines for debugging
      const lines: string[] = [];
      for (let i = 0; i < Math.min(buf.length, 10); i++) {
        const line = buf.getLine(i);
        if (line) {
          const text = line.translateToString(true);
          if (text.length > 0) lines.push(`L${i}:${text}`);
        }
      }
      return `NOT_FOUND:${lines.join("|")}`;
    });
    expect(hasContent).toBe("FOUND");

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
    // Wait for command output — poll xterm buffer until "test" appears
    await window.waitForFunction(
      () => {
        const term = (window as Record<string, unknown>).__xterm__ as
          | {
              buffer: {
                active: {
                  length: number;
                  getLine: (
                    i: number
                  ) => { translateToString: (trimRight?: boolean) => string } | undefined;
                };
              };
            }
          | undefined;
        if (!term) return false;
        const buf = term.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          if (line?.translateToString(true).includes("test")) return true;
        }
        return false;
      },
      { timeout: 10000 }
    );

    await closeApp(app);
  });
});

test.describe("Terminal startup", () => {
  test("Terminal startup - shell prompt within 3s", async () => {
    const start = Date.now();
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // xterm viewport appears when terminal mounts and PTY connects
    await window.waitForSelector(".xterm-viewport", { state: "attached", timeout: 4000 });

    const elapsed = Date.now() - start;
    // Allow up to 3s from test start (not app launch) for shell prompt
    expect(elapsed).toBeLessThan(3000);

    await closeApp(app);
  });
});
