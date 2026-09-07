import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DAEMON_PROTOCOL_VERSION, type DaemonSnapshot } from '../shared/daemon-protocol';
import { planLegacyTerminalRegistrations } from './legacy-terminal-registration';

function snapshot(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    revision: 0,
    eventSequence: 0,
    generatedAt: '2026-09-04T10:00:00.000Z',
    runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: false, browserEnabled: false },
    projects: [],
    workspaces: [],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [],
    schedules: [],
    heartbeats: [],
    ...overrides,
  };
}

describe('legacy terminal registration', () => {
  it('keeps a canonical terminal in its registered workspace when a saved ancestor is an alias', async () => {
    const fixture = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ezterm-registration-alias-')));
    try {
      const parent = path.join(fixture, 'parent');
      const alias = path.join(fixture, 'alias');
      const canonicalRoot = path.join(parent, 'project');
      mkdirSync(canonicalRoot, { recursive: true });
      symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const savedRoot = path.join(alias, 'project');
      const now = '2026-09-04T10:00:00.000Z';
      const current = snapshot({
        projects: [{ id: 'saved-project', name: 'Saved', rootPath: savedRoot, source: 'native', revision: 1, createdAt: now, updatedAt: now }],
        workspaces: [{ id: 'saved-workspace', projectId: 'saved-project', name: 'Local', kind: 'local', rootPath: savedRoot, revision: 1, createdAt: now, updatedAt: now }],
      });
      const plan = await planLegacyTerminalRegistrations([{ sessionId: 'terminal', cwd: canonicalRoot }], current);

      expect(plan.projects).toEqual([]);
      expect(plan.workspaces).toEqual([]);
      expect(plan.sessions).toEqual([expect.objectContaining({ sessionId: 'terminal', workspaceId: 'saved-workspace' })]);
      expect(current.workspaces[0]!.rootPath).toBe(savedRoot);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('groups terminals from the same cwd into one stable Local workspace', async () => {
    const first = await planLegacyTerminalRegistrations([
      { sessionId: 'terminal-1', cwd: 'C:\\Working\\Demo', createdAt: 10 },
      { sessionId: 'terminal-2', cwd: 'c:/working/demo', createdAt: 20 },
    ], snapshot());
    const second = await planLegacyTerminalRegistrations([
      { sessionId: 'terminal-1', cwd: 'C:\\Working\\Demo', createdAt: 10 },
    ], snapshot());

    expect(first.projects).toHaveLength(1);
    expect(first.workspaces).toHaveLength(1);
    expect(first.sessions.map((session) => session.workspaceId)).toEqual([
      first.workspaces[0]!.workspaceId,
      first.workspaces[0]!.workspaceId,
    ]);
    expect(second.workspaces[0]!.workspaceId).toBe(first.workspaces[0]!.workspaceId);
  });

  it('reuses an existing compatible workspace and skips registered sessions', async () => {
    const now = '2026-09-04T10:00:00.000Z';
    const current = snapshot({
      projects: [{ id: 'project-1', name: 'Demo', rootPath: 'C:\\Working\\Demo', source: 'native', revision: 1, createdAt: now, updatedAt: now }],
      workspaces: [{ id: 'workspace-1', projectId: 'project-1', name: 'Local', kind: 'local', rootPath: 'C:\\Working\\Demo', revision: 1, createdAt: now, updatedAt: now }],
      sessions: [{ id: 'known', projectId: 'project-1', workspaceId: 'workspace-1', kind: 'terminal', title: 'Known', state: 'running', source: 'legacy-pty', revision: 1, createdAt: now, updatedAt: now }],
    });

    const plan = await planLegacyTerminalRegistrations([
      { sessionId: 'known', cwd: 'C:\\Working\\Demo' },
      { sessionId: 'new', cwd: 'c:\\working\\demo' },
    ], current);

    expect(plan.projects).toEqual([]);
    expect(plan.workspaces).toEqual([]);
    expect(plan.sessions).toEqual([{ sessionId: 'new', workspaceId: 'workspace-1', title: 'Terminal · demo' }]);
  });

  it('uses a known project hint without inventing a second project', async () => {
    const plan = await planLegacyTerminalRegistrations(
      [{ sessionId: 'terminal-1', cwd: 'C:\\Working\\KnownRepo' }],
      snapshot(),
      { resolveProject: () => ({ projectId: 'known-project', name: 'Known', rootPath: 'C:\\Working\\KnownRepo' }) },
    );

    expect(plan.projects).toEqual([{ projectId: 'known-project', name: 'Known', rootPath: 'C:\\Working\\KnownRepo' }]);
    expect(plan.workspaces[0]).toMatchObject({ projectId: 'known-project', name: 'Local' });
  });
});
