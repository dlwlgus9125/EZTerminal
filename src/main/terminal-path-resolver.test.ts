import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveTerminalFileLocation } from './terminal-path-resolver';
import { TerminalFileCapabilityStore } from './terminal-file-capability';

const dirs: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ez-path-'));
  dirs.push(base);
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside.txt');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'a');
  await writeFile(outside, 'outside');
  return { root, outside };
}

describe('resolveTerminalFileLocation', () => {
  it('resolves a contained regular file and preserves exact source position', async () => {
    const { root } = await fixture();
    const capabilities = new TerminalFileCapabilityStore({ newId: () => 'cap-1' });
    await expect(resolveTerminalFileLocation(
      { path: './src/a.ts', cwd: root, line: 7, column: 3, executionKind: 'local' },
      capabilities,
    )).resolves.toEqual({
      ok: true,
      path: path.join(root, 'src', 'a.ts'),
      capability: 'cap-1',
      line: 7,
      column: 3,
    });
  });

  it('rejects remote, outside, missing and directory targets with stable reasons', async () => {
    const { root, outside } = await fixture();
    const capabilities = new TerminalFileCapabilityStore();
    await expect(resolveTerminalFileLocation({ path: './src/a.ts', cwd: root, executionKind: 'ssh' }, capabilities)).resolves.toEqual({ ok: false, reason: 'remote' });
    await expect(resolveTerminalFileLocation({ path: outside, cwd: root, executionKind: 'local' }, capabilities)).resolves.toEqual({ ok: false, reason: 'outside-workspace' });
    await expect(resolveTerminalFileLocation({ path: './none', cwd: root, executionKind: 'local' }, capabilities)).resolves.toEqual({ ok: false, reason: 'missing' });
    await expect(resolveTerminalFileLocation({ path: './src', cwd: root, executionKind: 'local' }, capabilities)).resolves.toEqual({ ok: false, reason: 'not-file' });
    await expect(resolveTerminalFileLocation({ path: './src/a.ts', cwd: root, executionKind: 'runtime' as never }, capabilities)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects malformed positions before touching the filesystem', async () => {
    await expect(resolveTerminalFileLocation(
      { path: 'a', cwd: '.', line: 0, executionKind: 'local' },
      new TerminalFileCapabilityStore(),
    )).resolves.toEqual({ ok: false, reason: 'invalid' });
  });
});
