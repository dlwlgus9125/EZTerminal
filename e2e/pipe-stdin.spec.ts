import { test, expect } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';

// M4 / AC-8: an external command run as a pipeline stage must not hang waiting
// for stdin it will never receive (process-runner.ts now spawns with array-form
// `stdio: ['ignore', 'pipe', 'pipe']`). The fixture blocks on `process.stdin`
// until 'end' fires; if the runner left stdin open-but-unwritten (the pre-fix
// default), 'end' never fires, the fixture never exits, and this test would time
// out waiting for `block-status` to reach `done` — that IS the regression this
// test guards against.
//
// Two-stage pipeline (not a bare single command): external commands ignore
// upstream PipelineData and reconstruct their own argv, so the leading `gen-rows`
// stage's own output is irrelevant — what matters is that the stdin fixture runs
// as a piped stage, exercising the same non-interactive runProcess() path a
// mid/end pipeline external command always takes (independent of `!`/auto-PTY
// routing, which only applies to a single bare command).

const STDIN_FIXTURE = path.resolve(__dirname, 'fixtures', 'stdin-eof.js');

test('pipe: an external command run as a pipeline stage gets its stdin closed (does not hang)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`gen-rows 1 | node ${STDIN_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('text-output')).toBeVisible();
  // Reaching `done` (not a timeout) proves the child actually exited instead of
  // hanging on a never-arriving stdin write.
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });
  // The fixture only calls `process.exit(42)` from its stdin 'end' handler, so
  // this exit-code line is proof EOF was delivered (not just that the block
  // settled some other way).
  await expect(window.getByTestId('text-output')).toContainText('exited with code 42');

  await app.close();
});
