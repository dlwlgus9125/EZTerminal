import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentHistoryProvider, AgentTranscriptPage } from '../shared/agent-history';
import type { AgentHistoryProviderAdapter, ProviderHistorySession } from './agent-history-provider';
import { AgentHistoryService } from './agent-history-service';
import { AgentProjectStore } from './agent-project-store';

function makeTemporaryDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeDirectory(base: string, name: string): string {
  const directory = path.join(base, name);
  mkdirSync(directory);
  return directory;
}

function fakeAdapter(
  session: ProviderHistorySession,
  provider: AgentHistoryProvider = 'codex',
): AgentHistoryProviderAdapter {
  const transcript: AgentTranscriptPage = {
    historyId: '',
    provider,
    turns: [{
      id: 'turn-1',
      status: 'completed',
      entries: [{ type: 'message', id: 'message-1', role: 'user', markdown: 'hello' }],
    }],
    nextCursor: null,
  };
  return {
    provider,
    listSessions: vi.fn(async () => ({ items: [session], nextCursor: null })),
    readTranscript: vi.fn(async () => transcript),
    buildResumeCommand: vi.fn((privateId: string, roots: readonly string[]) => ({
      commandText: `!${provider} ${roots.join(' ')} resume ${privateId}`,
      displayCommandText: `${provider} resume`,
    })),
    dispose: vi.fn(async () => undefined),
  };
}

describe('AgentHistoryService', () => {
  it('returns locally saved projects without querying provider history', async () => {
    const base = makeTemporaryDirectory('ez-agent-history-local-projects-');
    const primaryRoot = makeDirectory(base, 'primary');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    await store.upsert({
      name: 'Local project',
      primaryRoot,
      additionalRoots: [],
      pinned: false,
    });
    const adapter: AgentHistoryProviderAdapter = {
      provider: 'codex',
      listSessions: vi.fn(async () => ({ items: [], nextCursor: null })),
      readTranscript: vi.fn(),
      buildResumeCommand: vi.fn(() => null),
      dispose: vi.fn(async () => undefined),
    };
    const service = new AgentHistoryService(store, [adapter]);

    const result = await service.listProjects(true);

    expect(result).toMatchObject({
      items: [{
        name: 'Local project',
        primaryRoot,
      }],
    });
    expect(adapter.listSessions).not.toHaveBeenCalled();
  });

  it('searches project names and every host root while keeping pin and recency order', async () => {
    const base = makeTemporaryDirectory('ez-agent-project-search-');
    const alpha = makeDirectory(base, 'alpha');
    const shared = makeDirectory(base, 'shared-docs');
    const beta = makeDirectory(base, 'beta');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    await store.upsert({
      name: 'Alpha Workspace',
      primaryRoot: alpha,
      additionalRoots: [shared],
      pinned: false,
    });
    await store.upsert({
      name: 'Beta Workspace',
      primaryRoot: beta,
      additionalRoots: [],
      pinned: true,
    });
    await store.recordWork({ primaryRoot: alpha, additionalRoots: [shared], lastActiveAt: 200 });
    await store.recordWork({ primaryRoot: beta, additionalRoots: [], lastActiveAt: 100 });
    const service = new AgentHistoryService(store, []);

    await expect(service.listProjects(false, undefined, 40, 'SHARED-DOCS')).resolves
      .toMatchObject({ items: [{ name: 'Alpha Workspace' }] });
    await expect(service.listProjects(false, undefined, 40, 'beta workspace')).resolves
      .toMatchObject({ items: [{ name: 'Beta Workspace' }] });
    expect((await service.listProjects()).items.map((project) => project.name)).toEqual([
      'Beta Workspace',
      'Alpha Workspace',
    ]);
  });

  it('catalogs enabled launchers and resolves provider and generic new-chat commands privately', async () => {
    const base = makeTemporaryDirectory('ez-agent-project-launch-');
    const primary = makeDirectory(base, 'primary');
    const extra = makeDirectory(base, 'extra');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    await store.upsert({
      name: 'Launch Workspace',
      primaryRoot: primary,
      additionalRoots: [extra],
      pinned: false,
    });
    const codex: AgentHistoryProviderAdapter = {
      provider: 'codex',
      listSessions: vi.fn(async () => ({ items: [], nextCursor: null })),
      readTranscript: vi.fn(),
      buildResumeCommand: vi.fn(() => null),
      buildNewCommand: vi.fn((roots: readonly string[]) => ({
        commandText: `!codex ${roots.join('|')}`,
        displayCommandText: 'codex',
      })),
      dispose: vi.fn(async () => undefined),
    };
    const claude: AgentHistoryProviderAdapter = {
      provider: 'claude',
      listSessions: vi.fn(async () => ({ items: [], nextCursor: null })),
      readTranscript: vi.fn(),
      buildResumeCommand: vi.fn(() => null),
      buildNewCommand: vi.fn(() => ({
        commandText: '!claude --add-dir private',
        displayCommandText: 'claude',
      })),
      dispose: vi.fn(async () => undefined),
    };
    let profiles = [{
      id: 'profile-private-id',
      name: 'My Agent',
      executable: 'my-agent',
      enabled: true,
    }, {
      id: 'disabled-private-id',
      name: 'Disabled Agent',
      executable: 'disabled-agent',
      enabled: false,
    }];
    const service = new AgentHistoryService(store, [codex, claude], () => profiles);
    const projectId = (await service.listProjects()).items[0]!.projectId;
    const launchers = service.listLaunchers();

    expect(launchers.map((launcher) => [launcher.provider, launcher.name])).toEqual([
      ['codex', 'Codex'],
      ['claude', 'Claude Code'],
      ['generic', 'My Agent'],
    ]);
    expect(JSON.stringify(launchers)).not.toContain('profile-private-id');
    expect(JSON.stringify(launchers)).not.toContain('my-agent');

    const codexPreparation = await service.prepareLaunch(projectId, 'codex');
    expect(codexPreparation).toMatchObject({ ok: true, cwd: primary, roots: [primary, extra] });
    expect(codexPreparation.ok).toBe(true);
    if (!codexPreparation.ok) return;
    await expect(service.resolveLaunch(projectId, 'codex', codexPreparation.revision)).resolves
      .toEqual({
        ok: true,
        roots: [primary, extra],
        commandText: `!codex ${primary}|${extra}`,
        displayCommandText: 'codex',
      });

    const generic = launchers.find((launcher) => launcher.provider === 'generic')!;
    const genericPreparation = await service.prepareLaunch(projectId, generic.launcherId);
    expect(genericPreparation.ok).toBe(true);
    if (!genericPreparation.ok) return;
    await expect(service.resolveLaunch(
      projectId,
      generic.launcherId,
      genericPreparation.revision,
    )).resolves.toEqual({
      ok: true,
      roots: [primary, extra],
      commandText: '!my-agent',
      displayCommandText: 'My Agent',
    });

    profiles = [{ ...profiles[0]!, executable: 'my-agent-v2' }];
    await expect(service.resolveLaunch(
      projectId,
      generic.launcherId,
      genericPreparation.revision,
    )).resolves.toEqual({ ok: false, reason: 'stale' });
  });

  it('exposes stable opaque ids while retaining the provider id only inside resume resolution', async () => {
    const base = makeTemporaryDirectory('ez-agent-history-');
    const recordedRoot = makeDirectory(base, 'recorded');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    const adapter = fakeAdapter({
      privateId: 'provider-private-thread-id',
      parentPrivateId: null,
      title: 'Previous task',
      preview: 'A local transcript preview',
      createdAt: 10,
      updatedAt: 20,
      cwd: recordedRoot,
      roots: [recordedRoot],
      source: 'cli',
      rolloutPath: null,
    });
    const service = new AgentHistoryService(store, [adapter]);

    await service.recordTerminalWork([recordedRoot], 20);
    const projects = await service.listProjects(true);
    const sessions = await service.listSessions(projects.items[0]!.projectId);
    const historyId = sessions.items[0]!.historyId;
    expect(historyId).toMatch(/^codex_[0-9a-f]{24}$/);
    expect(JSON.stringify(projects)).not.toContain('provider-private-thread-id');
    expect(JSON.stringify(sessions)).not.toContain('provider-private-thread-id');

    const transcript = await service.readTranscript(historyId);
    expect(transcript).toMatchObject({ historyId, provider: 'codex', turns: [{ id: 'turn-1' }] });
    const preparation = await service.prepareResume(historyId);
    const resolved = await service.resolveResume(
      historyId,
      preparation!.revision,
      'recorded',
    );
    // The provider id reaches the launch line and stops there.
    expect(resolved).toEqual({
      ok: true,
      provider: 'codex',
      roots: [recordedRoot],
      commandText: `!codex ${recordedRoot} resume provider-private-thread-id`,
      displayCommandText: 'codex resume',
    });
  });

  it('detects saved multi-root drift and rejects a stale root-choice token', async () => {
    const base = makeTemporaryDirectory('ez-agent-history-roots-');
    const primary = makeDirectory(base, 'primary');
    const extra = makeDirectory(base, 'extra');
    const replacement = makeDirectory(base, 'replacement');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    const adapter = fakeAdapter({
      privateId: 'thread-2',
      parentPrivateId: null,
      title: 'Multi-root task',
      preview: '',
      createdAt: 10,
      updatedAt: 30,
      cwd: primary,
      roots: [primary, extra],
      source: 'cli',
      rolloutPath: null,
    });
    const service = new AgentHistoryService(store, [adapter]);
    await service.recordTerminalWork([primary, extra], 30);
    const project = (await service.listProjects(true)).items[0]!;
    const saved = await service.saveProject({
      name: 'Saved project',
      primaryRoot: primary,
      additionalRoots: [replacement],
      pinned: true,
    });
    expect(saved.ok).toBe(true);
    const session = (await service.listSessions(project.projectId)).items[0]!;
    const initial = await service.prepareResume(session.historyId);
    expect(initial).toMatchObject({
      rootsMatch: false,
      recordedRoots: [primary, extra],
      currentRoots: [primary, replacement],
      canResume: true,
    });

    await service.saveProject({
      projectId: project.projectId,
      name: 'Saved project',
      primaryRoot: primary,
      additionalRoots: [],
      pinned: true,
    });
    await expect(service.resolveResume(
      session.historyId,
      initial!.revision,
      'current',
    )).resolves.toEqual({ ok: false, reason: 'stale' });
  });

  it('falls back to the session cwd when an old recorded extra folder is missing', async () => {
    const base = makeTemporaryDirectory('ez-agent-history-missing-');
    const primary = makeDirectory(base, 'primary');
    const missing = path.join(base, 'removed-extra');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    const adapter = fakeAdapter({
      privateId: 'thread-missing-root',
      parentPrivateId: null,
      title: 'Removed workspace',
      preview: '',
      createdAt: 10,
      updatedAt: 30,
      cwd: primary,
      roots: [primary, missing],
      source: 'cli',
      rolloutPath: null,
    });
    const service = new AgentHistoryService(store, [adapter]);
    await service.recordTerminalWork([primary, missing], 30);
    const project = (await service.listProjects(true)).items[0]!;
    const session = (await service.listSessions(project.projectId)).items[0]!;

    await expect(service.prepareResume(session.historyId)).resolves.toMatchObject({
      canResume: true,
      missingRecordedRoots: [missing],
      currentRoots: [primary],
      missingCurrentRoots: [],
    });
  });

  it('resumes a non-Codex provider through its own adapter command', async () => {
    const base = makeTemporaryDirectory('ez-agent-history-claude-');
    const root = makeDirectory(base, 'primary');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    const adapter = fakeAdapter({
      privateId: `${root}\\9f2c1b74.jsonl`,
      parentPrivateId: null,
      title: 'Previous Claude task',
      preview: 'Previous Claude task',
      createdAt: 10,
      updatedAt: 20,
      cwd: root,
      roots: [root],
      source: 'cli',
      rolloutPath: null,
    }, 'claude');
    const service = new AgentHistoryService(store, [adapter]);
    await service.recordTerminalWork([root], 20);
    const project = (await service.listProjects(true)).items[0]!;
    const session = (await service.listSessions(project.projectId)).items[0]!;

    expect(session.historyId).toMatch(/^claude_[0-9a-f]{24}$/);
    expect(JSON.stringify(session)).not.toContain('9f2c1b74');
    const preparation = await service.prepareResume(session.historyId);
    expect(preparation).toMatchObject({ provider: 'claude', canResume: true });
    await expect(service.resolveResume(
      session.historyId,
      preparation!.revision,
      'recorded',
    )).resolves.toMatchObject({
      ok: true,
      provider: 'claude',
      displayCommandText: 'claude resume',
    });
  });

  it('reports a provider that cannot express the resume as unavailable', async () => {
    const base = makeTemporaryDirectory('ez-agent-history-unsupported-');
    const root = makeDirectory(base, 'primary');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    const adapter = fakeAdapter({
      privateId: 'unsupported',
      parentPrivateId: null,
      title: 'Task',
      preview: '',
      createdAt: 10,
      updatedAt: 20,
      cwd: root,
      roots: [root],
      source: 'cli',
      rolloutPath: null,
    }, 'claude');
    (adapter.buildResumeCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const service = new AgentHistoryService(store, [adapter]);
    await service.recordTerminalWork([root], 20);
    const project = (await service.listProjects(true)).items[0]!;
    const session = (await service.listSessions(project.projectId)).items[0]!;
    const preparation = await service.prepareResume(session.historyId);

    await expect(service.resolveResume(
      session.historyId,
      preparation!.revision,
      'recorded',
    )).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });
});

function pagingAdapter(
  provider: AgentHistoryProvider,
  cwd: string,
  updatedAts: readonly number[],
): AgentHistoryProviderAdapter {
  const sessions: ProviderHistorySession[] = updatedAts.map((updatedAt) => ({
    privateId: `${provider}-${String(updatedAt)}`,
    parentPrivateId: null,
    title: `${provider} ${String(updatedAt)}`,
    preview: '',
    createdAt: updatedAt,
    updatedAt,
    cwd,
    roots: [cwd],
    source: 'cli',
    rolloutPath: null,
  }));
  return {
    provider,
    listSessions: vi.fn(async ({ cursor, limit }) => {
      const start = cursor ? Number.parseInt(cursor, 10) : 0;
      const items = sessions.slice(start, start + limit);
      const next = start + items.length;
      return { items, nextCursor: next < sessions.length ? String(next) : null };
    }),
    readTranscript: vi.fn(),
    buildResumeCommand: vi.fn(() => null),
    dispose: vi.fn(async () => undefined),
  };
}

describe('AgentHistoryService merged provider paging', () => {
  it('interleaves providers by recency and continues past both page boundaries', async () => {
    const base = makeTemporaryDirectory('ez-agent-history-merge-');
    const root = makeDirectory(base, 'primary');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    const codex = pagingAdapter('codex', root, [12, 10, 8, 6, 4, 2]);
    const claude = pagingAdapter('claude', root, [11, 9, 7, 5, 3, 1]);
    const service = new AgentHistoryService(store, [codex, claude]);
    await service.recordTerminalWork([root], 12);
    const projectId = (await service.listProjects(true)).items[0]!.projectId;

    // Page 1 leaves both providers with unread items inside the page they just
    // fetched; page 2 exhausts those and has to advance each provider's cursor.
    const first = await service.listSessions(projectId, undefined, 4);
    expect(first.items.map((item) => item.title)).toEqual([
      'codex 12', 'claude 11', 'codex 10', 'claude 9',
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.listSessions(projectId, first.nextCursor!, 4);
    expect(second.items.map((item) => item.title)).toEqual([
      'codex 8', 'claude 7', 'codex 6', 'claude 5',
    ]);

    const third = await service.listSessions(projectId, second.nextCursor!, 4);
    expect(third.items.map((item) => item.title)).toEqual([
      'codex 4', 'claude 3', 'codex 2', 'claude 1',
    ]);
    expect(third.nextCursor).toBeNull();

    // Never more than one page worth of sessions is asked of either provider.
    for (const call of (codex.listSessions as ReturnType<typeof vi.fn>).mock.calls) {
      expect((call[0] as { limit: number }).limit).toBe(4);
    }
  });

  it('keeps paging when one provider fails and drops it from the continuation', async () => {
    const base = makeTemporaryDirectory('ez-agent-history-merge-error-');
    const root = makeDirectory(base, 'primary');
    const store = new AgentProjectStore(path.join(base, 'user-data'));
    await store.init();
    const codex = pagingAdapter('codex', root, [4, 3, 2, 1]);
    const claude = pagingAdapter('claude', root, [9]);
    (claude.listSessions as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('claude history is unavailable'));
    const service = new AgentHistoryService(store, [codex, claude]);
    await service.recordTerminalWork([root], 4);
    const projectId = (await service.listProjects(true)).items[0]!.projectId;

    const first = await service.listSessions(projectId, undefined, 2);
    expect(first.items.map((item) => item.title)).toEqual(['codex 4', 'codex 3']);
    const second = await service.listSessions(projectId, first.nextCursor!, 2);
    expect(second.items.map((item) => item.title)).toEqual(['codex 2', 'codex 1']);
    expect(second.nextCursor).toBeNull();
  });
});
