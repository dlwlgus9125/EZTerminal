import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { launchApp } from './launch-app';
import { TestWsClient } from './ws-client';

// M2 full mirroring (plan §M2, AC4/AC5): a session/run created over the mobile
// remote-control WS bridge must reflect onto the desktop dockview the same way
// a locally-created tab would — this drives the REAL remote-bridge.ts with a
// Node 'ws' client (no fakes; those already live in remote-bridge.test.ts),
// standing in for a phone. `EZTERMINAL_REMOTE_PORT` pins a dedicated port so
// this never collides with a real, already-running desktop instance's bridge
// on the default port (remote-bridge.ts's `DEFAULT_REMOTE_BRIDGE_PORT`).
const REMOTE_PORT = 17420;

test('session mirroring: WS create-session/run-command/destroy-session reflect on the desktop dockview', async () => {
  const app = await launchApp(undefined, { EZTERMINAL_REMOTE_PORT: String(REMOTE_PORT) });
  // Named `win`, not `window` (unlike most other specs): this test calls
  // `.evaluate(() => window.…)` to reach the BROWSER global — naming the
  // Page variable `window` would shadow it inside that callback.
  const win = await app.firstWindow();
  await expect(win.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Baseline: the default single local pane.
  await expect(win.getByTestId('pane')).toHaveCount(1);

  // The bridge's token is desktop-owned persisted state — read it the same way
  // the pairing panel does (getRemoteToken), rather than reaching into the
  // userData dir's remote-token.json.
  const token = await win.evaluate(() => window.ezterminal.getRemoteToken());
  const client = await TestWsClient.connectAuthed(`ws://127.0.0.1:${REMOTE_PORT}`, token);

  try {
    // ── AC4 (add): WS create-session -> a new desktop tab appears within 2s ──
    const createRequestId = randomUUID();
    client.send({ kind: 'create-session', requestId: createRequestId });
    const createdMsg = await client.waitFor(
      (msg) => msg.kind === 'session-created' && msg.requestId === createRequestId,
    );
    if (createdMsg.kind !== 'session-created') throw new Error('unreachable');
    const { sessionId } = createdMsg.session;

    // Scoped by the pane's own `data-session-id` (Track A ③'s existing
    // attribute — see layout-persistence.spec.ts) rather than by tab title
    // text, since the adopted pane's title/naming is an internal choice.
    const mirroredPane = win.locator(`[data-testid="pane"][data-session-id="${sessionId}"]`);
    await expect(mirroredPane).toHaveCount(1, { timeout: 2_000 });

    // ── AC5 (mirror): WS run-command in that session -> output streams onto
    //    the desktop tab ────────────────────────────────────────────────────
    const marker = `mirror-${Date.now()}`;
    const runId = randomUUID();
    client.send({ kind: 'run-command', runId, sessionId, commandText: `echo ${marker}` });
    await expect(mirroredPane).toContainText(marker, { timeout: 10_000 });

    // ── AC4 (remove): WS destroy-session -> the desktop tab disappears within 2s ──
    client.send({ kind: 'destroy-session', sessionId });
    await expect(mirroredPane).toHaveCount(0, { timeout: 2_000 });
    await expect(win.getByTestId('pane')).toHaveCount(1);
  } finally {
    client.close();
    await app.close();
  }
});

// M4 (plan §M4, desktop attach-on-bind): the mirroring gap this fixes is
// LEVEL- vs edge-triggered discovery. `run-started` broadcasts exactly once,
// at the moment a run begins — a pane that binds to a session AFTER that
// moment (an adopted pane, e.g. after a Ctrl+R reload or a restored layout)
// has no other way to learn about a run already in flight. This test proves
// the fix end-to-end: start a run, THEN mount an adopting pane, and confirm
// it shows the run anyway — something the old edge-triggered-only code could
// not do, since the adopting pane didn't exist when `run-started` fired.
test('session mirroring: a pane that adopts a session AFTER a run already started still attaches to it (M4 level-triggered attach)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);
  const pane0 = panes.nth(0);
  const sessionId = await pane0.getAttribute('data-session-id');
  if (!sessionId) throw new Error('expected pane0 to have a data-session-id');

  // A long-running command whose plain stdout writes emit no TUI signal
  // (M3 adaptive render never upgrades it to xterm), so its output stays
  // real DOM text — same long-running-tick shape as launch.spec.ts's cancel
  // tests, just with a unique marker instead of 'tick'.
  const marker = `attach-on-bind-${Date.now()}`;
  await pane0
    .getByTestId('cmd-input')
    .fill(`node -e "setInterval(() => process.stdout.write('${marker}'), 50)"`);
  await pane0.getByTestId('btn-run').click();
  await expect(pane0.getByTestId('pty-plain-block')).toBeVisible();
  await expect(pane0).toContainText(marker, { timeout: 10_000 });

  // ONLY NOW — well after the run's one-time `run-started` broadcast already
  // fired and passed — mount a SECOND pane that ADOPTS the same session, via
  // the same `window.__ezDock` test seam drag-layout.spec.ts/tab-overflow.spec.ts
  // use (dockview's mouse drag is native HTML5 DnD, not Playwright-drivable).
  // `addPanel` with `params.adoptSessionId` is exactly what App.tsx's own
  // `onSessionAdded` mirroring handler calls — TerminalPanel forwards that
  // param straight to TerminalPane's `adoptSessionId` prop.
  await window.evaluate((adoptSessionId) => {
    type EzDockApi = {
      addPanel(opts: {
        id: string;
        component: string;
        title: string;
        renderer: string;
        params?: Record<string, unknown>;
        position?: { referencePanel: string; direction: string };
      }): unknown;
    };
    const dock = (globalThis as unknown as { __ezDock?: EzDockApi }).__ezDock;
    if (!dock) throw new Error('__ezDock test seam missing');
    dock.addPanel({
      id: 'tab-adopt-midrun',
      component: 'terminal',
      title: 'Adopted',
      renderer: 'always',
      params: { adoptSessionId },
      position: { referencePanel: 'tab-1', direction: 'right' },
    });
  }, sessionId);

  // A split places the new pane in its own grid group, visible immediately
  // (not a hidden inactive tab) — dockview renders new groups after existing
  // ones, so nth(1) is the adopting pane (same convention as splits.spec.ts).
  await expect(panes).toHaveCount(2);
  const adoptedPane = panes.nth(1);
  await expect(adoptedPane).toHaveAttribute('data-session-id', sessionId);

  // The proof: this pane's mount effect never received `run-started` for
  // this run (it didn't exist yet when that fired) — so seeing the running
  // block with live output here can only come from the `listRuns()` catch-up
  // added in M4.
  await expect(adoptedPane.getByTestId('pty-plain-block')).toBeVisible({ timeout: 5_000 });
  await expect(adoptedPane).toContainText(marker, { timeout: 10_000 });

  await app.close();
});
