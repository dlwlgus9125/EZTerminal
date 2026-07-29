import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentTranscriptPage } from '../shared/agent-history';
import type { AgentHistoryProviderAdapter, ProviderHistorySession } from './agent-history-provider';
import { AgentHistoryService } from './agent-history-service';
import { AgentProjectStore } from './agent-project-store';

function makeDirectory(base: string, name: string): string {
  const directory = path.join(base, name);
  mkdirSync(directory);
  return directory;
}

function fakeAdapter(session: ProviderHistorySession): AgentHistoryProviderAdapter {
  const transcript: AgentTranscriptPage = {
    historyId: '',
    turns: [{
      id: 'turn-1',
      status: 'completed',
      entries: [{ type: 'message', id: 'message-1', role: 'user', markdown: 'hello' }],
    }],
    nextCursor: null,
  };
  return {
    provider: 'codex',
    listSessions: vi.fn(async () => ({ items: [session], nextCursor: null })),
    discoverProjects: vi.fn(async () => ({
      items: [{ primaryRoot: session.cwd, lastActiveAt: session.updatedAt }],
      nextCursor: null,
    })),
    readTranscript: vi.fn(async () => transcript),
    dispose: vi.fn(async () => undefined),
  };
}

describe('AgentHistoryService', () => {
  it('returns locally saved projects without waiting for provider discovery', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-history-local-projects-'));
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
      discoverProjects: vi.fn(() => new Promise<never>(() => undefined)),
      readTranscript: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const service = new AgentHistoryService(store, [adapter]);

    const result = await Promise.race([
      service.listProjects(),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);

    expect(result).not.toBe('blocked');
    expect(result).toMatchObject({
      items: [{
        name: 'Local project',
        primaryRoot,
      }],
    });
  });

  it('exposes stable opaque ids while retaining the provider id only inside resume resolution', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-history-'));
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

    const projects = await service.listProjects(true);
    const sessions = await service.listSessions(projects.items[0]!.projectId);
    const historyId = sessions.items[0]!.historyId;
    expect(historyId).toMatch(/^codex_[0-9a-f]{24}$/);
    expect(JSON.stringify(projects)).not.toContain('provider-private-thread-id');
    expect(JSON.stringify(sessions)).not.toContain('provider-private-thread-id');

    const transcript = await service.readTranscript(historyId);
    expect(transcript).toMatchObject({ historyId, turns: [{ id: 'turn-1' }] });
    const preparation = await service.prepareResume(historyId);
    const resolved = await service.resolveResume(
      historyId,
      preparation!.revision,
      'recorded',
    );
    expect(resolved).toEqual({
      ok: true,
      privateId: 'provider-private-thread-id',
      roots: [recordedRoot],
    });
  });

  it('detects saved multi-root drift and rejects a stale root-choice token', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-history-roots-'));
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
    const base = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-history-missing-'));
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
    const project = (await service.listProjects(true)).items[0]!;
    const session = (await service.listSessions(project.projectId)).items[0]!;

    await expect(service.prepareResume(session.historyId)).resolves.toMatchObject({
      canResume: true,
      missingRecordedRoots: [missing],
      currentRoots: [primary],
      missingCurrentRoots: [],
    });
  });
});
