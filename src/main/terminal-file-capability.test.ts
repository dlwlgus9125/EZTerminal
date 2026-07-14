import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalFileCapabilityStore } from './terminal-file-capability';
import { resolveTerminalFileLocation } from './terminal-path-resolver';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; file: string; outside: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ez-terminal-cap-'));
  dirs.push(base);
  const root = path.join(base, 'workspace');
  const file = path.join(root, 'src', 'a.ts');
  const outside = path.join(base, 'outside.txt');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'inside');
  await writeFile(outside, 'outside');
  return { root, file, outside };
}

async function resolveWith(
  store: TerminalFileCapabilityStore,
  root: string,
): Promise<{ path: string; capability: string }> {
  const result = await resolveTerminalFileLocation(
    { path: './src/a.ts', cwd: root, executionKind: 'local' },
    store,
  );
  if (!result.ok) throw new Error(`resolve failed: ${result.reason}`);
  return result;
}

describe('TerminalFileCapabilityStore', () => {
  it('fails closed when the initial terminal path is a symlink outside the workspace', async () => {
    const { root, file, outside } = await fixture();
    await rm(file);
    await symlink(outside, file, 'file');
    const store = new TerminalFileCapabilityStore({ newId: () => 'cap-1' });

    await expect(resolveTerminalFileLocation(
      { path: './src/a.ts', cwd: root, executionKind: 'local' },
      store,
    )).resolves.toEqual({ ok: false, reason: 'outside-workspace' });
    expect(store.size).toBe(0);
  });

  it('rejects a path swap between resolve and consume', async () => {
    const { root, file } = await fixture();
    const store = new TerminalFileCapabilityStore({ newId: () => 'cap-1' });
    const resolved = await resolveWith(store, root);

    await rename(file, `${file}.old`);
    await writeFile(file, 'replacement');

    await expect(store.consumeAndOpen(resolved.capability, resolved.path)).resolves.toEqual({
      ok: false,
      error: 'file-changed',
    });
  });

  it('rejects a symlink escape installed after resolve', async () => {
    const { root, file, outside } = await fixture();
    const store = new TerminalFileCapabilityStore({ newId: () => 'cap-1' });
    const resolved = await resolveWith(store, root);

    await rename(file, `${file}.old`);
    await symlink(outside, file, 'file');

    await expect(store.consumeAndOpen(resolved.capability, resolved.path)).resolves.toEqual({
      ok: false,
      error: 'file-changed',
    });
  });

  it('is one-shot even when the first consume uses the wrong path', async () => {
    const { root } = await fixture();
    const store = new TerminalFileCapabilityStore({ newId: () => 'cap-1' });
    const resolved = await resolveWith(store, root);

    await expect(store.consumeAndOpen(resolved.capability, `${resolved.path}.wrong`)).resolves.toEqual({
      ok: false,
      error: 'path-mismatch',
    });
    await expect(store.consumeAndOpen(resolved.capability, resolved.path)).resolves.toEqual({
      ok: false,
      error: 'invalid-capability',
    });
  });

  it('expires capabilities and evicts the oldest entry at the bound', async () => {
    const { root } = await fixture();
    let now = 10;
    let id = 0;
    const store = new TerminalFileCapabilityStore({
      ttlMs: 50,
      cap: 2,
      now: () => now,
      newId: () => `cap-${++id}`,
    });
    const first = await resolveWith(store, root);
    const second = await resolveWith(store, root);
    const third = await resolveWith(store, root);

    await expect(store.consumeAndOpen(first.capability, first.path)).resolves.toEqual({
      ok: false,
      error: 'invalid-capability',
    });
    const secondOpen = await store.consumeAndOpen(second.capability, second.path);
    expect(secondOpen.ok).toBe(true);
    if (secondOpen.ok) await secondOpen.handle.close();

    now = 61;
    await expect(store.consumeAndOpen(third.capability, third.path)).resolves.toEqual({
      ok: false,
      error: 'expired',
    });
  });
});
