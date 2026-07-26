import { readFileSync } from 'node:fs';
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

test('running: drawer shows state/version/sessions/log lines (AC1/AC2/AC3)', async () => {
  const state = buildFixtureState({
    running: true,
    sessions: [{
      key: 'main',
      sessionId: 'sess-1',
      model: 'gpt-5.5',
      modelProvider: 'openai',
      updatedAt: Date.now(),
      totalTokens: 1234,
    }],
    logLines: [fakeLogLine('OpenClaw gateway ready'), fakeLogLine('heartbeat tick', 'DEBUG')],
  });
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
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect(window.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'stopped', {
      timeout: 10_000,
    });
    await expect(window.getByTestId('openclaw-guidance')).toBeVisible();

    const startButton = window.getByTestId('btn-openclaw-start');
    await expect(startButton).toBeEnabled();
    await startButton.click();
    await expect(window.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'running', {
      timeout: 15_000,
    });

    const finalState = JSON.parse(readFileSync(statePath, 'utf8')) as OpenClawFixtureState;
    const startCall = finalState.cliCalls.find((call) => call.argv.includes('start'));
    expect(startCall?.argv).toEqual(['gateway', 'start']);
  } finally {
    await app.close();
    await gateway.stop();
  }
});
