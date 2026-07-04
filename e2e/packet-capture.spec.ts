import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';

// status-panel-v2 Phase 2B: an off-by-default "패킷" preview sub-view under the
// NET section. These tests assert structure/behavior only — real packet
// capture (device availability, Npcap presence) is environment-dependent and
// never asserted on here (plan §Verification, team-lead guidance for B5).
// The whole suite already runs serially (playwright.config.ts: workers 1,
// fullyParallel false), so no extra per-file serial config is needed.

test('packet subview is off by default when the status panel opens', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();
  await expect(window.getByTestId('status-panel')).toBeVisible();

  await expect(window.getByTestId('status-packet-toggle')).toBeVisible();
  await expect(window.getByTestId('status-packet-view')).toHaveCount(0);

  await app.close();
});

test('toggling on shows the first-run acknowledgement before subscribing; confirming reveals the subview', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();

  const toggle = window.getByTestId('status-packet-toggle');
  const packetView = window.getByTestId('status-packet-view');
  const ackConfirm = window.getByTestId('status-packet-ack-confirm');

  await toggle.click();
  await expect(packetView).toBeVisible();
  await expect(ackConfirm).toBeVisible();

  await ackConfirm.click();
  await expect(ackConfirm).toHaveCount(0);

  // Structure only: the loading line, a capture-status notice, or the row
  // table — never real packet values (capture success is nondeterministic
  // across environments — Npcap presence, device permissions, etc).
  await expect(
    packetView.locator('.status-loading, .status-packet-status, table'),
  ).toBeVisible();

  await app.close();
});

test('toggling off unsubscribes and hides the subview; toggling back on skips the already-seen acknowledgement', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();

  const toggle = window.getByTestId('status-packet-toggle');
  const packetView = window.getByTestId('status-packet-view');

  await toggle.click();
  await window.getByTestId('status-packet-ack-confirm').click();
  await expect(packetView).toBeVisible();

  await toggle.click();
  await expect(packetView).toHaveCount(0);

  // Re-subscribing: the ack was already recorded this session, so it must go
  // straight to the subview (no ack card) — exercises the
  // subscribe -> unsubscribe -> re-subscribe cycle's structure.
  await toggle.click();
  await expect(packetView).toBeVisible();
  await expect(window.getByTestId('status-packet-ack-confirm')).toHaveCount(0);
  await expect(
    packetView.locator('.status-loading, .status-packet-status, table'),
  ).toBeVisible();

  await app.close();
});
