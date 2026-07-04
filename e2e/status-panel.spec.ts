import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';

// status-overlay-panel (rev6): a 300px non-modal overlay drawer, toggled from the
// app-head, showing CPU/MEM (always-on, 1Hz, with a 60s sparkline history) plus
// NET/DISK/PROC (collected only while the panel is open). These tests only assert
// structure/behavior, never exact system values (AC5).

test('status panel starts closed (AC11) and toggles open/closed', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  const panel = window.getByTestId('status-panel');
  const toggle = window.getByTestId('btn-toggle-stats');

  await expect(panel).toHaveCount(0);

  await toggle.click();
  await expect(panel).toBeVisible();

  await toggle.click();
  await expect(panel).toHaveCount(0);

  await app.close();
});

test('typing in the terminal still works while the panel is open (no focus/input interference)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();
  await expect(window.getByTestId('status-panel')).toBeVisible();

  // Submit via Enter (keyboard), not a Run-button click: the drawer is a
  // deliberate non-reflowing overlay (AC2), so on a narrow window it can sit
  // on top of the cmd-row's Run button — AC3 only promises the terminal's
  // own keyboard input/focus stay uninterrupted, which this exercises directly.
  const input = window.getByTestId('cmd-input');
  await input.fill('cd C:\\Windows');
  await input.press('Enter');
  await expect(window.getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });

  await app.close();
});

test('opening/closing the panel never changes the pane\'s bounding box (AC2/AC3 — overlay, not a layout resize)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  const pane = window.getByTestId('pane');
  await expect(pane).toBeVisible();

  // The Electron window's own size can still be settling (DPI/first-layout)
  // for a moment right after launch, independent of anything this feature
  // does — wait until two reads 150ms apart agree before trusting the
  // baseline, otherwise a transient pre-settle size gets falsely blamed on
  // the panel toggle below.
  let before: { x: number; y: number; width: number; height: number } | null = null;
  await expect(async () => {
    const a = await pane.boundingBox();
    await window.waitForTimeout(150);
    const b = await pane.boundingBox();
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    before = b;
  }).toPass({ timeout: 10_000 });

  await window.getByTestId('btn-toggle-stats').click();
  await expect(window.getByTestId('status-panel')).toBeVisible();

  const opened = await pane.boundingBox();
  expect(opened).toEqual(before);

  await window.getByTestId('btn-toggle-stats').click();
  await expect(window.getByTestId('status-panel')).toHaveCount(0);

  const closed = await pane.boundingBox();
  expect(closed).toEqual(before);

  await app.close();
});

test('all five sections render with the expected structure', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();

  const cpu = window.getByTestId('status-section-cpu');
  const mem = window.getByTestId('status-section-mem');
  const net = window.getByTestId('status-section-net');
  const disk = window.getByTestId('status-section-disk');
  const proc = window.getByTestId('status-section-proc');
  await expect(cpu).toBeVisible();
  await expect(mem).toBeVisible();
  await expect(net).toBeVisible();
  await expect(disk).toBeVisible();
  await expect(proc).toBeVisible();

  // CPU/MEM are always-on: a numeric metric appears quickly (no null/loading state).
  // Scoped to .status-metric (not a bare text match) since the per-core grid
  // (status-panel-v2) also renders "%" text inside this section.
  await expect(cpu.locator('.status-metric')).toContainText('%', { timeout: 5_000 });
  await expect(mem.locator('.status-metric')).toContainText('/', { timeout: 5_000 });

  // NET is either still warming up ("측정 중…") or already showing a rate — both
  // are valid (AC6's 1-2s warmup window is not guaranteed to have elapsed yet).
  await expect(net.locator('.status-metric, .status-loading')).toBeVisible();

  // DISK/PROC populate within their own polling window (10s/3s) once the panel
  // opens — loading text is replaced by real rows.
  await expect(disk.locator('.status-disk-row').first()).toBeVisible({ timeout: 15_000 });
  await expect(proc.locator('.status-proc-table tbody tr').first()).toBeVisible({
    timeout: 10_000,
  });

  await app.close();
});

test('waiting before opening the panel means the CPU/MEM sparkline seeds with multiple history points (AC10)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  // The graph loop (CPU/MEM) ticks every second from app startup regardless of
  // panel visibility — wait long enough for several samples to accumulate.
  await window.waitForTimeout(4_000);

  await window.getByTestId('btn-toggle-stats').click();
  const cpuPolyline = window.locator('[data-testid="status-section-cpu"] .sparkline polyline');
  await expect(cpuPolyline).toBeVisible();

  const pointsAttr = await cpuPolyline.getAttribute('points');
  const pointCount = (pointsAttr ?? '').trim().split(/\s+/).filter(Boolean).length;
  expect(pointCount).toBeGreaterThanOrEqual(3);

  await app.close();
});

// status-panel-v2: CPU core grid, MEM detail rows, NET rate sparklines, and the
// connections list — structure only, never exact system values (plan §Verification).

test('CPU core grid renders per-core bars once cores are available (0 cores tolerated — no crash)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();

  const cpu = window.getByTestId('status-section-cpu');
  await expect(cpu).toBeVisible();
  await expect(cpu.locator('.status-metric')).toContainText('%', { timeout: 5_000 });

  // The grid is conditional on cores.length > 0 — an empty first-tick array
  // simply omits it (no crash). If it's present, it must contain real bar rows.
  const coreGrid = window.getByTestId('status-cpu-cores');
  const coreGridCount = await coreGrid.count();
  if (coreGridCount > 0) {
    expect(await coreGrid.locator('.status-disk-bar').count()).toBeGreaterThan(0);
  }

  await app.close();
});

test('MEM detail rows (Used/Available/Cached/PageFile) render once memDetail arrives', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();

  const memDetail = window.getByTestId('status-mem-detail');
  await expect(memDetail).toBeVisible({ timeout: 15_000 }); // 3s poll + timeout margin

  // Used + PageFile are bar rows; all four rows carry a label.
  await expect(memDetail.locator('.status-disk-bar')).toHaveCount(2);
  await expect(memDetail.locator('.status-disk-label')).toHaveCount(4);

  await app.close();
});

test('NET rx/tx mini sparklines render once a rate is available', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();

  const netSparks = window.getByTestId('status-net-sparks');
  await expect(netSparks).toBeVisible({ timeout: 15_000 }); // NET warmup + first real rate

  await expect(netSparks.locator('.sparkline')).toHaveCount(2);

  await app.close();
});

test('connections section renders as its own section under NET (structure only)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-stats').click();

  const conns = window.getByTestId('status-section-conns');
  await expect(conns).toBeVisible();

  // Populates within its own 3s polling window once the panel opens (possibly
  // an empty table if the host has no active connections — never asserted).
  await expect(conns.locator('table')).toBeVisible({ timeout: 15_000 });

  await app.close();
});
