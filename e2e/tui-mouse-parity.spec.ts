import { test, expect } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';

// TUI scroll parity (2026-07-11): a real terminal routes the wheel by what the
// full-screen program asked for — mouse reports when it enabled tracking
// (claude), the arrow-key fallback when it didn't (default vim). Both legs are
// xterm 6's own decision tree; these tests lock that the DECSETs a TUI emits
// actually reach the renderer xterm's parser through the ring/upgrade replay
// (the 2026-07-11 diagnosis confirmed they do — claude's history-recall
// symptom was pre-mouse-support claude, not a pipeline drop) and that the
// wheel then emits the right bytes into the shared PTY input path.
//
// Assertions read PUBLIC xterm state through PtyBlock's `__ezTerm` container
// seam (modes.mouseTrackingMode, buffer.active.type) and capture outgoing
// bytes with an extra term.onData listener — same data xterm hands to
// sendPtyInput. The mouse leg does NOT assert a child-side echo: a plain Node
// child cannot observe ConPTY-translated mouse input (libuv drops
// MOUSE_EVENT records); the end-to-end claude scroll was verified live.

const MOUSE_MODE_FIXTURE = path.resolve(__dirname, 'fixtures', 'mouse-mode-tui.js');
const ALT_SCREEN_ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'alt-screen-echo.js');

/** Wheel one notch up over the takeover terminal, capturing what xterm emits. */
async function wheelUpAndCapture(
  window: Awaited<ReturnType<Awaited<ReturnType<typeof launchApp>>['firstWindow']>>,
): Promise<string> {
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="pty-block"]') as HTMLElement & {
      __ezTerm?: { onData: (cb: (d: string) => void) => void };
    };
    const g = globalThis as { __wheelCapture?: string[] };
    g.__wheelCapture = [];
    el.__ezTerm!.onData((d) => g.__wheelCapture!.push(d));
  });
  const box = await window.getByTestId('pty-block').boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await window.mouse.wheel(0, -120);
  await expect
    .poll(
      () =>
        window.evaluate(
          () => ((globalThis as { __wheelCapture?: string[] }).__wheelCapture ?? []).join(''),
        ),
      { timeout: 5_000 },
    )
    .not.toBe('');
  return window.evaluate(
    () => ((globalThis as { __wheelCapture?: string[] }).__wheelCapture ?? []).join(''),
  );
}

test('tui-mouse-parity: a mouse-tracking TUI (claude-like) gets SGR wheel reports, never arrow keys', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${MOUSE_MODE_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pane')).toHaveClass(/pane--tui-takeover/);
  await expect
    .poll(() => window.locator('.pty-block .xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('MOUSE-MODE-READY');

  // The fixture's ?1002h/?1006h must have reached the xterm parser through
  // the upgrade replay — this is the leg the reported bug suspected.
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const el = document.querySelector('[data-testid="pty-block"]') as HTMLElement & {
            __ezTerm?: { modes: { mouseTrackingMode: string }; buffer: { active: { type: string } } };
          };
          const t = el?.__ezTerm;
          return t ? `${t.modes.mouseTrackingMode}/${t.buffer.active.type}` : 'missing';
        }),
      { timeout: 10_000 },
    )
    .toBe('drag/alternate');

  const sent = await wheelUpAndCapture(window);
  expect(sent).toContain('\x1b[<64;'); // SGR wheel-up report
  expect(sent).not.toContain('\x1b[A'); // no arrow-key fallback
  expect(sent).not.toContain('\x1bOA');

  await window.getByTestId('block-cancel').click({ force: true });
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });
  await app.close();
});

test('tui-mouse-parity: an alt-screen TUI without mouse (vim-like) keeps the wheel→arrow fallback, round-tripped to the child', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${ALT_SCREEN_ECHO_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pane')).toHaveClass(/pane--tui-takeover/);
  await expect
    .poll(() => window.locator('.pty-block .xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('ALT-SCREEN-READY');

  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const el = document.querySelector('[data-testid="pty-block"]') as HTMLElement & {
            __ezTerm?: { modes: { mouseTrackingMode: string }; buffer: { active: { type: string } } };
          };
          const t = el?.__ezTerm;
          return t ? `${t.modes.mouseTrackingMode}/${t.buffer.active.type}` : 'missing';
        }),
      { timeout: 10_000 },
    )
    .toBe('none/alternate');

  const sent = await wheelUpAndCapture(window);
  expect(sent).toContain('\x1b[A'); // arrow fallback preserved (vim parity)
  expect(sent).not.toContain('\x1b[<'); // and no mouse report was fabricated

  // The arrow must round-trip through ConPTY into the child: the fixture
  // echoes stdin as hex — 1b5b41 = ESC [ A.
  await expect
    .poll(() => window.locator('.pty-block .xterm-rows').innerText(), { timeout: 10_000 })
    .toContain('GOT:1b5b41');

  await window.getByTestId('block-cancel').click({ force: true });
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });
  await app.close();
});
