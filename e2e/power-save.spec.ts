import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';

/**
 * A running agent turn keeps the PC from idle sleep, and the hold is released when the turn ends.
 * The real powerSaveBlocker is wrapped to record what the app asks of it.
 */

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');

test('a running agent turn holds off idle sleep and releases it when the turn ends', async () => {
  const profile = createRegisteredE2eTempDir('ezterm-power-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-power-project-');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const app = await launchApp(profile, { [pathKey]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[pathKey] ?? ''}`, TMPDIR: profile });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ powerSaveBlocker }) => {
      const calls: string[] = [];
      (globalThis as { __ezPowerCalls?: string[] }).__ezPowerCalls = calls;
      const start = powerSaveBlocker.start.bind(powerSaveBlocker);
      const stop = powerSaveBlocker.stop.bind(powerSaveBlocker);
      powerSaveBlocker.start = (type) => { calls.push(`start:${type}`); return start(type); };
      powerSaveBlocker.stop = (id) => { calls.push('stop'); stop(id); };
    });
    const saved = await page.evaluate((root) => window.ezterminal.saveAgentProject({ name: 'Power', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    expect(saved.ok).toBe(true);
    const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    if (!inspection.ok) throw new Error(inspection.message);
    const { probe, reviewDigest } = inspection.value;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
      const id = `e2e-power-enable-${attempt}`;
      const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
        commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'e2e-power' }, type: 'provider.enable',
        payload: { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
          executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest },
      }));
      if (receipt.ok) break;
      if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
    }
    await page.getByTestId('rail-agents').click();
    await page.getByTestId('agent-new-run').click();
    const draft = page.getByTestId('conversation-start');
    await expect(draft).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.workspaces.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    const composer = draft.getByTestId('structured-agent-composer-input');
    await composer.fill('Keep the PC awake while you work.');
    await composer.press('Enter');
    await expect.poll(async () => page.evaluate(async () => {
      const snapshot = await window.ezterminal.getDaemonSnapshot();
      return snapshot?.turns.length ? snapshot.turns.every((turn) => turn.state === 'completed') : false;
    }), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => app.evaluate(() => (globalThis as { __ezPowerCalls?: string[] }).__ezPowerCalls ?? []), { timeout: 10_000 })
      .toEqual(['start:prevent-app-suspension', 'stop']);
  } finally {
    await app.close();
  }
});
