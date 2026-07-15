import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isWebViewJavaScriptRuntimeError } from '../mobile/e2e/lib.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('mobile E2E forced-xterm contract', () => {
  it('recognizes only uncaught WebView JavaScript runtime failures', () => {
    expect(isWebViewJavaScriptRuntimeError(
      'E/chromium(123): [ERROR:CONSOLE(1)] "Uncaught TypeError: Cannot read properties of undefined"',
    )).toBe(true);
    expect(isWebViewJavaScriptRuntimeError(
      'I/Capacitor/Console(123): File: http://localhost/app.js - Msg: Uncaught ReferenceError: WeakRef is not defined',
    )).toBe(true);
    expect(isWebViewJavaScriptRuntimeError(
      'I/Capacitor/Console(123): File: http://localhost/app.js - Msg: ReferenceError: WeakRef is not defined',
    )).toBe(true);
    expect(isWebViewJavaScriptRuntimeError(
      'E/chromium(123): [ERROR:CONSOLE(1)] "Uncaught (in promise) TypeError: Failed to read file"',
    )).toBe(true);
    expect(isWebViewJavaScriptRuntimeError(
      'I/Capacitor/Console(123): File: http://localhost/app.js - Msg: Uncaught DOMException: The operation failed',
    )).toBe(true);

    expect(isWebViewJavaScriptRuntimeError(
      'I/Capacitor/Console(123): File: http://localhost/app.js - Msg: Error: expected connection retry',
    )).toBe(false);
    expect(isWebViewJavaScriptRuntimeError(
      'E/AndroidRuntime(123): Uncaught TypeError: unrelated native process log',
    )).toBe(false);
  });

  it('forces xterm, waits for its real DOM, taps natively, checks errors, and closes CDP', () => {
    const smoke = readFileSync(path.join(root, 'mobile/e2e/smoke.ts'), 'utf8');

    expect(smoke).toContain("'!cmd /d /c echo xterm74'");
    expect(smoke).toContain("waitForVisibleTestIdDescendant('pty-block', '.xterm-screen'");
    expect(smoke).toContain("tapTestId('pty-block')");
    expect(smoke).toContain('assertNoWebViewJavaScriptRuntimeErrors()');
    expect(smoke).toContain('closeWebViewDevtools()');
  });

  it('waits for the visible tab run control instead of a hidden duplicate', () => {
    const library = readFileSync(path.join(root, 'mobile/e2e/lib.ts'), 'utf8');
    const parity = readFileSync(path.join(root, 'mobile/e2e/parity.ts'), 'utf8');
    const start = library.indexOf('export async function waitForVisibleTestIdEnabled');
    const end = library.indexOf('export function getSelectedTestIdIndex', start);
    const waiter = library.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(waiter).toContain('.reverse()');
    expect(waiter).toContain("!element.hasAttribute('disabled')");
    expect(parity).toContain("waitForVisibleTestIdEnabled('btn-run', 20_000)");
  });

  it('re-observes More sheet state after both row and backdrop mis-taps', () => {
    const library = readFileSync(path.join(root, 'mobile/e2e/lib.ts'), 'utf8');
    const start = library.indexOf('export async function openWorkspaceMoreAction');
    const helper = library.slice(start);

    expect(start).toBeGreaterThan(0);
    expect(helper).toContain('attempt <= 3');
    expect(helper).toContain("[destinationTestId, 'workspace-more-sheet', 'workspace-more-btn']");
    expect(helper).toContain('re-observing state');
  });
});
