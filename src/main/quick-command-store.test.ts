import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_QUICK_COMMANDS,
  QUICK_COMMAND_SCHEMA_VERSION,
  type QuickCommand,
} from '../shared/quick-command';
import { QuickCommandStore } from './quick-command-store';

const IDS = Array.from(
  { length: MAX_QUICK_COMMANDS + 4 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-quick-commands-'));
}

function makeStore(dir: string, ids = IDS): QuickCommandStore {
  let nextId = 0;
  let tick = 0;
  return new QuickCommandStore(dir, {
    newId: () => ids[nextId++],
    now: () => new Date(Date.UTC(2026, 6, 13, 0, 0, tick++)),
  });
}

function persistedCommand(index: number): QuickCommand {
  return {
    id: IDS[index],
    name: `Command ${index}`,
    command: `echo ${index}`,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  };
}

describe('QuickCommandStore', () => {
  it('starts empty and writes a versioned atomic envelope', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    expect(await store.list()).toEqual([]);

    const created = await store.create({
      name: '  Build  ',
      command: 'pnpm build',
      description: '  all targets  ',
    });

    expect(created).toEqual({
      ok: true,
      command: {
        id: IDS[0],
        name: 'Build',
        command: 'pnpm build',
        description: 'all targets',
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    });
    const file = path.join(dir, 'quick-commands.json');
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      schemaVersion: QUICK_COMMAND_SCHEMA_VERSION,
      commands: [created.ok ? created.command : null],
    });
  });

  it('rejects invalid input before touching disk', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();

    await expect(store.create({ name: 'Bad', command: 'echo one\necho two' })).resolves.toMatchObject({
      ok: false,
      error: 'invalid',
    });
    expect(existsSync(path.join(dir, 'quick-commands.json'))).toBe(false);
  });

  it('enforces case-insensitive name uniqueness on create and update', async () => {
    const store = makeStore(makeDir());
    await store.init();
    const a = await store.create({ name: 'Build', command: 'pnpm build' });
    const b = await store.create({ name: 'Test', command: 'pnpm test' });
    expect(a.ok && b.ok).toBe(true);

    await expect(store.create({ name: 'BUILD', command: 'other' })).resolves.toMatchObject({
      ok: false,
      error: 'duplicate-name',
    });
    if (b.ok) {
      await expect(store.update(b.command.id, { name: 'build', command: 'pnpm test' })).resolves.toMatchObject({
        ok: false,
        error: 'duplicate-name',
      });
    }
  });

  it('updates without changing identity/createdAt and deletes by id', async () => {
    const store = makeStore(makeDir());
    await store.init();
    const created = await store.create({ name: 'Build', command: 'pnpm build', description: 'old description' });
    if (!created.ok) throw new Error('fixture create failed');

    const updated = await store.update(created.command.id, {
      name: 'Build all',
      command: 'pnpm -r build',
      description: '',
    });
    expect(updated).toMatchObject({
      ok: true,
      command: {
        id: created.command.id,
        createdAt: created.command.createdAt,
        name: 'Build all',
        command: 'pnpm -r build',
      },
    });
    if (updated.ok) {
      expect(updated.command.updatedAt).not.toBe(created.command.updatedAt);
      expect('description' in updated.command).toBe(false);
    }

    await expect(store.delete(created.command.id)).resolves.toMatchObject({ ok: true });
    await expect(store.delete(created.command.id)).resolves.toEqual({
      ok: false,
      error: 'not-found',
      message: 'quick command not found',
    });
    expect(await store.list()).toEqual([]);
  });

  it(`enforces the ${MAX_QUICK_COMMANDS}-record limit`, async () => {
    const dir = makeDir();
    writeFileSync(
      path.join(dir, 'quick-commands.json'),
      JSON.stringify({
        schemaVersion: QUICK_COMMAND_SCHEMA_VERSION,
        commands: Array.from({ length: MAX_QUICK_COMMANDS }, (_, index) => persistedCommand(index)),
      }),
      'utf8',
    );
    const store = makeStore(dir, [IDS[MAX_QUICK_COMMANDS]]);
    await store.init();

    await expect(store.create({ name: 'One too many', command: 'pwd' })).resolves.toMatchObject({
      ok: false,
      error: 'limit-reached',
    });
  });

  it('quarantines malformed or schema-invalid storage', async () => {
    for (const bytes of ['{oops', JSON.stringify({ schemaVersion: 1, commands: [{ nope: true }] })]) {
      const dir = makeDir();
      const file = path.join(dir, 'quick-commands.json');
      writeFileSync(file, bytes, 'utf8');
      const store = makeStore(dir);
      await store.init();

      expect(await store.list()).toEqual([]);
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(bytes);
    }
  });

  it('serializes concurrent mutations without losing either command', async () => {
    const store = makeStore(makeDir());
    await store.init();

    const [a, b] = await Promise.all([
      store.create({ name: 'A', command: 'echo a' }),
      store.create({ name: 'B', command: 'echo b' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect((await store.list()).map((command) => command.name)).toEqual(['A', 'B']);
  });

  it('notifies subscribers once per successful mutation with detached snapshots', async () => {
    const store = makeStore(makeDir());
    await store.init();
    const listener = vi.fn<(commands: readonly QuickCommand[]) => void>();
    const unsubscribe = store.subscribe(listener);

    const created = await store.create({ name: 'A', command: 'echo a' });
    await store.create({ name: 'a', command: 'duplicate' });
    if (!created.ok) throw new Error('fixture create failed');
    await store.update(created.command.id, { name: 'B', command: 'echo b' });
    unsubscribe();
    await store.delete(created.command.id);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0]).toHaveLength(1);
    expect(listener.mock.calls[1][0][0].name).toBe('B');
  });

  it('isolates each subscriber from another subscriber mutating its snapshot', async () => {
    const store = makeStore(makeDir());
    await store.init();
    store.subscribe((commands) => {
      (commands[0] as { name: string }).name = 'tampered';
    });
    const observer = vi.fn<(commands: readonly QuickCommand[]) => void>();
    store.subscribe(observer);

    await store.create({ name: 'Original', command: 'pwd' });

    expect(observer.mock.calls[0][0][0].name).toBe('Original');
    expect((await store.list())[0].name).toBe('Original');
  });
});
