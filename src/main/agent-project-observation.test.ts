import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  classifyDaemonPathAuthority,
  recordAgentProjectObservation,
} from './agent-project-observation';

const NOW = '2026-09-04T00:00:00.000Z';

function revisioned() {
  return { revision: 1, createdAt: NOW, updatedAt: NOW };
}

function options(overrides: Partial<Parameters<typeof recordAgentProjectObservation>[1]> = {}) {
  return {
    resolvePath: vi.fn(async () => ({ ok: false as const, error: 'path-outside-root' as const })),
    touchProject: vi.fn(async () => true),
    recordProject: vi.fn(async () => undefined),
    canonicalizeDirectory: vi.fn(async (value: string) => path.resolve(value)),
    getDaemonSnapshot: vi.fn(() => ({ projects: [], workspaces: [] })),
    syncProjects: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('recordAgentProjectObservation', () => {
  it('prefers a more-specific revoked Workspace over its active Project root', () => {
    const projectRoot = path.resolve('registered-project');
    const revokedRoot = path.join(projectRoot, 'external-review');
    expect(classifyDaemonPathAuthority({
      projects: [{
        ...revisioned(), id: 'project-1', name: 'Project', rootPath: projectRoot,
        source: 'native',
      }],
      workspaces: [{
        ...revisioned(), id: 'workspace-1', projectId: 'project-1', name: 'Review',
        kind: 'worktree', rootPath: revokedRoot, archivedAt: NOW,
      }],
    }, path.join(revokedRoot, 'src'))).toBe('revoked');
  });

  it('ignores a late observation beneath a durably archived Project tombstone', async () => {
    const root = path.resolve('deleted-project');
    const input = options({
      getDaemonSnapshot: vi.fn(() => ({
        projects: [{
          ...revisioned(), id: 'deleted-project', name: 'Deleted', rootPath: root,
          source: 'native' as const, archivedAt: NOW,
        }],
        workspaces: [],
      })),
    });

    await expect(recordAgentProjectObservation({
      cwd: path.join(root, 'src'),
      updatedAt: 100,
    }, input)).resolves.toBe('ignored');
    expect(input.recordProject).not.toHaveBeenCalled();
    expect(input.syncProjects).not.toHaveBeenCalled();
  });

  it('never auto-imports an external Workspace that requires authorization', async () => {
    const input = options({
      resolvePath: vi.fn(async () => ({ ok: false as const, error: 'authorization-required' as const })),
    });

    await expect(recordAgentProjectObservation({
      cwd: path.resolve('external-worktree'),
      updatedAt: 100,
    }, input)).resolves.toBe('ignored');
    expect(input.canonicalizeDirectory).not.toHaveBeenCalled();
    expect(input.recordProject).not.toHaveBeenCalled();
  });

  it('imports only an unknown canonical directory and synchronizes it before leaving the caller FIFO', async () => {
    const root = path.resolve('new-project');
    const input = options();

    await expect(recordAgentProjectObservation({ cwd: root, updatedAt: 100 }, input))
      .resolves.toBe('imported');
    expect(input.recordProject).toHaveBeenCalledWith(root, 100);
    expect(input.syncProjects).toHaveBeenCalledOnce();
  });

  it('still imports observed work that only has a legacy terminal daemon record', async () => {
    const root = path.resolve('legacy-terminal-project');
    const input = options({
      getDaemonSnapshot: vi.fn(() => ({
        projects: [{
          ...revisioned(), id: 'legacy-project', name: 'Legacy', rootPath: root,
          source: 'legacy-import' as const,
        }],
        workspaces: [{
          ...revisioned(), id: 'legacy-workspace', projectId: 'legacy-project', name: 'Legacy',
          kind: 'local' as const, rootPath: root,
        }],
      })),
    });

    await expect(recordAgentProjectObservation({ cwd: root, updatedAt: 100 }, input))
      .resolves.toBe('imported');
    expect(input.recordProject).toHaveBeenCalledWith(root, 100);
  });

  it('touches an already authorized Project without creating a second root', async () => {
    const input = options({
      resolvePath: vi.fn(async () => ({
        ok: true as const,
        request: { projectId: 'project-1' },
      })),
    });

    await expect(recordAgentProjectObservation({
      cwd: path.resolve('registered-project'),
      updatedAt: 200,
    }, input)).resolves.toBe('updated');
    expect(input.touchProject).toHaveBeenCalledWith('project-1', 200);
    expect(input.recordProject).not.toHaveBeenCalled();
    expect(input.syncProjects).toHaveBeenCalledOnce();
  });
});
