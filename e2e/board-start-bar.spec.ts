import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';
import { openProjectBoard } from './project-navigation';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { resizeWindow } from './workbench-navigation';

/**
 * The board's bottom input is one line tall: its settings menus open upward over the board and every item
 * in them can be chosen (they were cut to the bar's height, hiding the AI choices at the top: "no Codex").
 */
const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');

test('the board input opens its model menu over the board, with the AI choices reachable', async () => {
  test.setTimeout(120_000);
  const profile = createRegisteredE2eTempDir('ezterm-board-bar-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-board-bar-project-');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const app = await launchApp(profile, { [pathKey]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[pathKey] ?? ''}`, TMPDIR: profile });
  try {
    const page = await app.firstWindow();
    await resizeWindow(page, { width: 1440, height: 900 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate((root) => window.ezterminal.saveAgentProject({ name: 'Board bar', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    if (!saved.ok) throw new Error(saved.reason);
    const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    if (!inspection.ok) throw new Error(inspection.message);
    const { probe, reviewDigest } = inspection.value;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
      const id = `board-bar-enable-${attempt}`;
      const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
        commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'e2e-board-bar' },
        type: 'provider.enable', payload: { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
          executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest },
      }));
      if (receipt.ok) break;
      if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
    }
    await openProjectBoard(page, saved.project.projectId);
    const bar = page.getByTestId('shell-start-bar');
    const model = bar.getByTestId('structured-agent-live-model');
    await expect(model).toHaveAttribute('aria-label', /^Codex model/u, { timeout: 30_000 });
    await model.click();
    const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitemradio', { name: 'Codex', exact: true }) });
    await expect(menu).toBeVisible();
    // Above the one-line bar and not cut by it: the AI choice at the top answers a real click at its centre.
    const ai = menu.getByRole('menuitemradio', { name: 'Codex', exact: true });
    expect(await ai.evaluate((item) => {
      const box = item.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!hit && (hit === item || item.contains(hit));
    })).toBe(true);
    await menu.getByRole('menuitemradio', { name: 'GPT 5.6 Fixture' }).click();
    await expect(model).toHaveAttribute('aria-label', /GPT 5\.6 Fixture/u);
  } finally {
    await app.close();
  }
});
