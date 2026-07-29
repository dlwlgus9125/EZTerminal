import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AgentProjectStore } from './agent-project-store';

function makeFixture(): {
  readonly userData: string;
  readonly primary: string;
  readonly extra: string;
} {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-projects-'));
  const userData = path.join(base, 'user-data');
  const primary = path.join(base, 'primary');
  const extra = path.join(base, 'extra');
  mkdirSync(primary);
  mkdirSync(extra);
  return { userData, primary, extra };
}

describe('AgentProjectStore', () => {
  it('persists discovered roots and recent activity without session data', async () => {
    const fixture = makeFixture();
    const store = new AgentProjectStore(fixture.userData);
    await store.init();

    await store.discover([{
      primaryRoot: fixture.primary,
      lastActiveAt: 123,
    }]);
    await store.flush();

    expect(store.list()[0]).toMatchObject({
      primaryRoot: path.normalize(fixture.primary),
      explicit: false,
      lastActiveAt: 123,
    });
    const persisted = readFileSync(path.join(fixture.userData, 'agent-projects.json'), 'utf8');
    expect(persisted).not.toContain('historyId');
    expect(persisted).not.toContain('privateId');
    expect(persisted).not.toContain('transcript');
  });

  it('persists only bounded project metadata and canonical multi-root paths', async () => {
    const fixture = makeFixture();
    const store = new AgentProjectStore(fixture.userData);
    await store.init();

    const result = await store.upsert({
      name: 'Workspace',
      primaryRoot: fixture.primary,
      additionalRoots: [fixture.extra, fixture.primary, fixture.extra],
      pinned: true,
    });
    expect(result.ok).toBe(true);
    await store.flush();

    const persisted = JSON.parse(
      readFileSync(path.join(fixture.userData, 'agent-projects.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain('transcript');
    expect(JSON.stringify(persisted)).not.toContain('prompt');

    const reloaded = new AgentProjectStore(fixture.userData);
    await reloaded.init();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]).toMatchObject({
      name: 'Workspace',
      primaryRoot: path.normalize(fixture.primary),
      additionalRoots: [path.normalize(fixture.extra)],
      pinned: true,
    });
  });

  it('rejects missing roots and duplicate primary projects without changing the cache', async () => {
    const fixture = makeFixture();
    const store = new AgentProjectStore(fixture.userData);
    await store.init();

    await expect(store.upsert({
      name: 'Missing',
      primaryRoot: path.join(fixture.primary, 'missing'),
      additionalRoots: [],
      pinned: false,
    })).resolves.toEqual({ ok: false, reason: 'invalid' });

    const first = await store.upsert({
      name: 'First',
      primaryRoot: fixture.primary,
      additionalRoots: [],
      pinned: false,
    });
    expect(first.ok).toBe(true);
    await expect(store.upsert({
      name: 'Duplicate',
      primaryRoot: fixture.primary,
      additionalRoots: [],
      pinned: false,
    })).resolves.toEqual({ ok: false, reason: 'duplicate' });
    expect(store.list()).toHaveLength(1);
  });

  it('quarantines malformed metadata instead of accepting provider content', async () => {
    const fixture = makeFixture();
    mkdirSync(fixture.userData);
    const file = path.join(fixture.userData, 'agent-projects.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      projects: [{ transcript: 'must not be loaded' }],
    }));

    const store = new AgentProjectStore(fixture.userData);
    await store.init();

    expect(store.list()).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.corrupt`)).toBe(true);
  });
});
