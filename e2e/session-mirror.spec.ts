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
