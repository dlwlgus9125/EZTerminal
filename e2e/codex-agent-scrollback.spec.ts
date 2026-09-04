import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';
import {
  readXtermAllBuffer,
  readXtermBuffer,
  readXtermBufferType,
  scrollXtermToTop,
} from './xterm-buffer';

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const EXPECTED_MARKERS = Array.from(
  { length: 80 },
  (_, index) => `CODEX-SEQ-${String(index + 1).padStart(3, '0')}`,
);

function seedTerminalProject(userDataDir: string, projectRoot: string): void {
  writeFileSync(
    path.join(userDataDir, 'agent-projects.json'),
    JSON.stringify({
      version: 3,
      projects: [{
        projectId: 'codex-scrollback-fixture',
        name: 'Codex scrollback fixture',
        primaryRoot: projectRoot,
        additionalRoots: [],
        pinned: true,
        origin: 'terminal',
        lastActiveAt: 1_785_181_625_234,
        createdAt: 1_785_181_600_000,
        updatedAt: 1_785_181_625_234,
      }],
    }),
    'utf8',
  );
}

function pathEnvironment(): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path')
    ?? 'PATH';
  return {
    [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`,
  };
}

test('direct Codex terminal retains every sequential output line in scrollback', async () => {
  const projectRoot = createRegisteredE2eTempDir('ezterm-e2e-codex-scrollback-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-e2e-codex-scrollback-data-');
  seedTerminalProject(userDataDir, projectRoot);

  const app = await launchApp(userDataDir, {
    ...pathEnvironment(),
    EZTERMINAL_E2E_CODEX_SCROLLBACK: '1',
  });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const input = window.getByTestId('cmd-input');
  await input.fill('codex --no-alt-screen');
  await input.press('Enter');

  const terminal = window.locator('[data-testid="pane"]:visible').getByTestId('pty-block');
  await expect(terminal).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readXtermAllBuffer(terminal), { timeout: 15_000 })
    .toContain(EXPECTED_MARKERS.at(-1));

  const retainedMarkers = [...(await readXtermAllBuffer(terminal)).matchAll(/CODEX-SEQ-\d{3}/gu)]
    .map(([marker]) => marker);
  expect(
    retainedMarkers,
    'Agents-owned Codex output must retain the complete ordered sequence after viewport overflow',
  ).toEqual(EXPECTED_MARKERS);
  expect(await readXtermBufferType(terminal)).toBe('normal');

  await scrollXtermToTop(terminal);
  await expect.poll(() => readXtermBuffer(terminal)).toContain(EXPECTED_MARKERS[0]);

  await window.locator('[data-testid="pane"]:visible').getByTestId('block-cancel').click();
  await app.close();
});
