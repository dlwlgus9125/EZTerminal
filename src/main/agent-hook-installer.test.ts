import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AgentHookInstaller } from './agent-hook-installer';

const makeHome = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-agent-hooks-'));

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
}

describe('AgentHookInstaller', () => {
  it('installs Codex lifecycle groups without clobbering unrelated hooks and is idempotent', async () => {
    const home = makeHome();
    const configPath = path.join(home, '.codex', 'hooks.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }),
    );
    const installer = new AgentHookInstaller(home, path.join(home, 'relay.ps1'));
    const first = await installer.mutate('codex', true);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    expect(first.backupPath).toBeTruthy();
    const config = await readJson(configPath);
    const hooks = config.hooks as Record<string, unknown[]>;
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.PermissionRequest).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
    expect(first.status.enabled).toBe(true);
    expect(first.status.needsTrust).toBe(true);

    const second = await installer.mutate('codex', true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.backupPath).toBeUndefined();
    expect(((await readJson(configPath)).hooks as Record<string, unknown[]>).SessionStart).toHaveLength(1);
  });

  it('removes only exact owned entries and preserves Claude settings', async () => {
    const home = makeHome();
    const installer = new AgentHookInstaller(home, path.join(home, 'relay.ps1'));
    const configPath = path.join(home, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ hooks: [] }] } }));
    await installer.mutate('claude', true);
    const installed = await readJson(configPath);
    expect(installed.theme).toBe('dark');
    const notification = ((installed.hooks as Record<string, unknown[]>).Notification[0]) as Record<string, unknown>;
    expect(notification.matcher).toBe('permission_prompt|idle_prompt');

    const removed = await installer.mutate('claude', false);
    expect(removed.ok).toBe(true);
    const final = await readJson(configPath);
    expect(final.theme).toBe('dark');
    expect((final.hooks as Record<string, unknown[]>).PreToolUse).toHaveLength(1);
    expect((final.hooks as Record<string, unknown[]>).SessionStart).toBeUndefined();
  });

  it('refuses invalid JSON and drift without overwriting evidence', async () => {
    const home = makeHome();
    const installer = new AgentHookInstaller(home, path.join(home, 'relay.ps1'));
    const configPath = path.join(home, '.codex', 'hooks.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{invalid');
    const invalid = await installer.mutate('codex', true);
    expect(invalid).toMatchObject({ ok: false, error: 'invalid-json' });
    expect(await fs.readFile(configPath, 'utf8')).toBe('{invalid');

    await fs.writeFile(configPath, '{}');
    await installer.mutate('codex', true);
    const config = await readJson(configPath);
    const groups = (config.hooks as Record<string, Array<Record<string, unknown>>>).Stop;
    const handler = ((groups[0].hooks as Array<Record<string, unknown>>)[0]);
    handler.command = 'user-modified-command';
    await fs.writeFile(configPath, JSON.stringify(config));
    const drift = await installer.mutate('codex', false);
    expect(drift).toMatchObject({ ok: false, error: 'drift' });
    expect((await installer.status('codex')).drift).toBe(true);
  });

  it('reports official hook blockers without changing config', async () => {
    const home = makeHome();
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.codex', 'config.toml'),
      '[features]\nhooks = false\n[[hooks.Stop]]\n',
    );
    const installer = new AgentHookInstaller(home, path.join(home, 'relay.ps1'));
    const status = await installer.status('codex');
    expect(status.blockers).toEqual(expect.arrayContaining(['hooks-disabled', 'inline-hooks-present']));
    const result = await installer.mutate('codex', true);
    expect(result).toMatchObject({ ok: false, error: 'blocked' });
  });

  it('canonicalizes partial and duplicate exact owned entries, then removes all exact owned entries', async () => {
    const home = makeHome();
    const installer = new AgentHookInstaller(home, path.join(home, 'relay.ps1'));
    const configPath = path.join(home, '.codex', 'hooks.json');
    await installer.mutate('codex', true);
    const partial = await readJson(configPath);
    const hooks = partial.hooks as Record<string, unknown[]>;
    hooks.SessionStart.push(structuredClone(hooks.SessionStart[0]));
    delete hooks.Stop;
    await fs.writeFile(configPath, JSON.stringify(partial));

    expect(await installer.status('codex')).toMatchObject({ enabled: false, drift: false });
    const repaired = await installer.mutate('codex', true);
    expect(repaired.ok).toBe(true);
    const repairedHooks = (await readJson(configPath)).hooks as Record<string, unknown[]>;
    expect(repairedHooks.SessionStart).toHaveLength(1);
    expect(repairedHooks.Stop).toHaveLength(1);

    const removed = await installer.mutate('codex', false);
    expect(removed.ok).toBe(true);
    expect((await installer.status('codex')).enabled).toBe(false);
    expect((await readJson(configPath)).hooks).toBeUndefined();
  });

  it('aborts if the source changes while the replacement is prepared', async () => {
    const home = makeHome();
    const installer = new AgentHookInstaller(home, path.join(home, 'relay.ps1'));
    const configPath = path.join(home, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ theme: 'original' }));
    const realWriteFile = fs.writeFile.bind(fs);
    let injected = false;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      await realWriteFile(...args);
      if (!injected && String(args[0]).endsWith('.tmp')) {
        injected = true;
        await realWriteFile(configPath, JSON.stringify({ theme: 'external' }));
      }
    });
    try {
      const result = await installer.mutate('claude', true);
      expect(result).toMatchObject({ ok: false, error: 'io-error' });
      expect(await readJson(configPath)).toEqual({ theme: 'external' });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does not change config when backup creation fails', async () => {
    const home = makeHome();
    const installer = new AgentHookInstaller(home, path.join(home, 'relay.ps1'));
    const configPath = path.join(home, '.codex', 'hooks.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify({ theme: 'keep-me' });
    await fs.writeFile(configPath, original);
    const realWriteFile = fs.writeFile.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.ezterminal.bak')) throw new Error('simulated backup failure');
      await realWriteFile(...args);
    });
    try {
      const result = await installer.mutate('codex', true);
      expect(result).toMatchObject({ ok: false, error: 'io-error' });
      expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
