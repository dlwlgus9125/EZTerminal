import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';
import {
  buildFixtureState,
  fakeLogLine,
  startFakeGateway,
  writeFakeCliShim,
  writeFixtureFiles,
  type OpenClawFixtureState,
} from './fixtures/openclaw-fixtures';

// openclaw-management M2: the desktop drawer for OpenClaw lifecycle/sessions/
// logs/core-settings (App.tsx's btn-toggle-openclaw + OpenClawPanel.tsx).
// Every scenario below drives a FAKE gateway + FAKE CLI (fixtures/
// openclaw-fixtures.ts) via the env seams OpenClawService already exposes
// (EZTERMINAL_OPENCLAW_CLI/_URL/_CONFIG_PATH) — the real gateway that may be
// running on this machine at 127.0.0.1:18789 is never dialed or perturbed.

const SCREENSHOT_DIR = path.join(
  process.env.TEMP ?? process.env.TMP ?? '.',
  'claude',
  'ezterminal-openclaw-panel-screenshots',
);
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test('running: drawer shows state/version/sessions/log lines (AC1/AC2/AC3)', async () => {
  const state = buildFixtureState({
    running: true,
    sessions: [
      {
        key: 'main',
        sessionId: 'sess-1',
        model: 'gpt-5.5',
        modelProvider: 'openai',
        updatedAt: Date.now(),
        totalTokens: 1234,
      },
    ],
    logLines: [fakeLogLine('OpenClaw gateway ready'), fakeLogLine('heartbeat tick', 'DEBUG')],
  });
  const { dir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(dir);
  const gateway = await startFakeGateway(statePath);

  const app = await launchApp(undefined, {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    // The fake CLI (execCli's child, spawned with no explicit `env` so it
    // inherits the app's process.env) reads this to find the shared state file.
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect(window.getByTestId('openclaw-panel')).toBeVisible();

    const stateSection = window.getByTestId('openclaw-state');
    await expect(stateSection).toHaveAttribute('data-state', 'running', { timeout: 10_000 });
    await expect(stateSection).toContainText('2026.6.11');

    await expect(window.getByTestId('openclaw-sessions')).toBeVisible({ timeout: 10_000 });
    await expect(window.getByTestId('openclaw-session-row')).toContainText('main');
    await expect(window.getByTestId('openclaw-session-row')).toContainText('gpt-5.5');

    await expect(window.getByTestId('openclaw-log-view')).toContainText('OpenClaw gateway ready', {
      timeout: 10_000,
    });

    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'running.png') });
  } finally {
    await app.close();
    await gateway.stop();
  }
});

test('stopped -> start: guidance CTA, fake CLI argv recorded, state flips, UI reaches running (AC1/AC6)', async () => {
  const state = buildFixtureState({ running: false });
  const { dir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(dir);
  const gateway = await startFakeGateway(statePath);

  const app = await launchApp(undefined, {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    // The fake CLI (execCli's child, spawned with no explicit `env` so it
    // inherits the app's process.env) reads this to find the shared state file.
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect(window.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'stopped', {
      timeout: 10_000,
    });

    // Guidance, never an error — a Start CTA replaces the sessions/log sections.
    await expect(window.getByTestId('openclaw-guidance')).toBeVisible();

    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'stopped.png') });

    const startBtn = window.getByTestId('btn-openclaw-start');
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    await expect(window.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'running', {
      timeout: 15_000,
    });
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'started.png') });

    const finalState = JSON.parse(readFileSync(statePath, 'utf8')) as OpenClawFixtureState;
    const startCall = finalState.cliCalls.find((c) => c.argv.includes('start'));
    expect(startCall).toBeDefined();
    expect(startCall?.argv).toEqual(['gateway', 'start']);
  } finally {
    await app.close();
    await gateway.stop();
  }
});

test('CLI absent: not-installed guidance card, zero error dialogs (AC6)', async () => {
  // An absolute path that resolves to nothing — CommandResolver treats an
  // absolute name as a direct probe (no PATH search), so this deterministically
  // reports "not installed" regardless of whether a real `openclaw` happens to
  // be on this machine's PATH.
  //
  // openclaw-stabilization M2: desktop visibility defaults to `openclawMode:
  // 'auto'`, which hides the OpenClaw button/drawer entirely once isInstalled()
  // is false — exactly this test's CLI-absent setup. This scenario is
  // specifically about the drawer's OWN not-installed guidance card, so a
  // fresh userData dir is pre-seeded with `openclawMode: 'on'` (forcing the
  // drawer visible regardless of install state) — mirrors layout-persistence.
  // spec.ts's pattern of writing a JSON file directly into a temp userData dir
  // before launch.
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-openclaw-not-installed-e2e-'));
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ schemaVersion: 1, startup: { mode: 'last' }, openclawMode: 'on' }),
    'utf8',
  );
  const app = await launchApp(dir, {
    EZTERMINAL_OPENCLAW_CLI: path.join(SCREENSHOT_DIR, `does-not-exist-${Date.now()}.cmd`),
  });
  let dialogCount = 0;
  try {
    const window = await app.firstWindow();
    window.on('dialog', (dialog) => {
      dialogCount += 1;
      void dialog.dismiss();
    });

    await window.getByTestId('btn-toggle-openclaw').click();
    const stateSection = window.getByTestId('openclaw-state');
    await expect(stateSection).toHaveAttribute('data-state', 'not-installed', { timeout: 10_000 });

    const guidance = window.getByTestId('openclaw-guidance');
    await expect(guidance).toBeVisible();
    await expect(guidance).toContainText('npm i -g openclaw');

    // No operational sections render for a not-installed CLI (nothing to do).
    await expect(window.getByTestId('btn-openclaw-start')).toHaveCount(0);
    await expect(window.getByTestId('openclaw-sessions')).toHaveCount(0);

    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'not-installed.png') });

    expect(dialogCount).toBe(0);
  } finally {
    await app.close();
  }
});

test('config save: edited model/port draft sends allowlisted config-set argv, restart banner renders (AC4)', async () => {
  const state = buildFixtureState({ running: true });
  const { dir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(dir);
  const gateway = await startFakeGateway(statePath);

  const app = await launchApp(undefined, {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect(window.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'running', {
      timeout: 10_000,
    });

    // Seed draft fields already populated from the fixture's initial config
    // (buildFixtureState's `agents.defaults.model`) — wait for the fetch to
    // land before overwriting, so we're editing rather than racing the seed.
    const modelInput = window.getByTestId('openclaw-config-model');
    await expect(modelInput).toHaveValue('openai/gpt-5.5', { timeout: 10_000 });

    await modelInput.fill('openai/gpt-6');
    await window.getByTestId('openclaw-config-port').fill('18790');
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'config-edited.png') });

    await window.getByTestId('openclaw-config-save').click();

    const banner = window.getByTestId('openclaw-restart-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(/재시작해야 적용됩니다|Restart the gateway to apply changes/);
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'config-saved.png') });

    const finalState = JSON.parse(readFileSync(statePath, 'utf8')) as OpenClawFixtureState;
    const configSetCalls = finalState.cliCalls.filter((c) => c.argv[0] === 'config' && c.argv[1] === 'set');
    const modelCall = configSetCalls.find((c) => c.argv[2] === 'agents.defaults.model');
    const portCall = configSetCalls.find((c) => c.argv[2] === 'gateway.port');
    expect(modelCall?.argv).toEqual(['config', 'set', 'agents.defaults.model', 'openai/gpt-6', '--strict-json']);
    expect(portCall?.argv).toEqual(['config', 'set', 'gateway.port', '18790', '--strict-json']);
  } finally {
    await app.close();
    await gateway.stop();
  }
});

test('autostart: two-step confirm installs, fake CLI argv recorded (task #9)', async () => {
  const state = buildFixtureState({ running: true });
  const { dir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(dir);
  const gateway = await startFakeGateway(statePath);

  const app = await launchApp(undefined, {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect(window.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'running', {
      timeout: 10_000,
    });

    // First click is a no-op confirm prompt, not the action itself.
    await window.getByTestId('btn-openclaw-autostart-install').click();
    await expect(window.getByTestId('btn-openclaw-autostart-install-confirm')).toBeVisible();

    let finalState = JSON.parse(readFileSync(statePath, 'utf8')) as OpenClawFixtureState;
    expect(finalState.cliCalls.find((c) => c.argv.includes('install'))).toBeUndefined();

    await window.getByTestId('btn-openclaw-autostart-install-confirm').click();
    await expect(window.getByTestId('openclaw-autostart-result')).toContainText(/등록되었습니다|Autostart was registered/, {
      timeout: 10_000,
    });

    finalState = JSON.parse(readFileSync(statePath, 'utf8')) as OpenClawFixtureState;
    const installCall = finalState.cliCalls.find((c) => c.argv.includes('install'));
    expect(installCall).toBeDefined();
    expect(installCall?.argv).toEqual(['gateway', 'install']);
  } finally {
    await app.close();
    await gateway.stop();
  }
});
