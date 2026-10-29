import { describe, expect, it, vi } from 'vitest';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { GitReviewDiffResult } from '../shared/git-status';
import { installWorktreeBaseDiffIpc } from './worktree-base-diff-ipc';

const snapshot = {
  projects: [{ id: 'P', rootPath: 'C:/repo' }],
  workspaces: [
    { id: 'L', projectId: 'P', kind: 'local', rootPath: 'C:/repo' },
    { id: 'W', projectId: 'P', kind: 'worktree', rootPath: 'C:/repo-wt/feature' },
    { id: 'gone', projectId: 'P', kind: 'worktree', rootPath: 'C:/repo-wt/gone', archivedAt: '2026-10-29T00:00:00.000Z' },
    { id: 'planning-workspace-abc', projectId: 'P', kind: 'worktree', rootPath: 'C:/repo-wt/attempt' },
  ],
} as unknown as DaemonSnapshot;

function fixture(options: { readonly base?: string; readonly diff?: GitReviewDiffResult } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); }),
    removeHandler: vi.fn((name: string) => { handlers.delete(name); }),
  };
  const worktrees = { baseBranch: vi.fn(async () => ('base' in options ? options.base : 'main')) };
  const git = {
    getReviewDiff: vi.fn(async (): Promise<GitReviewDiffResult> => options.diff ?? {
      ok: true, text: 'diff --git a/x b/x', truncated: false, omissions: [], baseRef: 'main', mergeBase: 'a'.repeat(40), ahead: 2,
    }),
  };
  const window = { sender: { id: 1 } };
  const dispose = installWorktreeBaseDiffIpc({
    ipc: ipc as never,
    authorized: (event, clientId) => event === (window as never) && clientId === 'surface-1',
    getSnapshot: () => snapshot,
    worktrees,
    git: git as never,
  });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(window, ...args);
  const invokeFrom = (event: unknown, channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return { handlers, worktrees, git, dispose, invoke, invokeFrom };
}

describe('worktree base diff IPC', () => {
  it('answers a worktree’s base branch and its change since then, found from the workspace id', async () => {
    const f = fixture();
    expect(await f.invoke('git:worktree-base', 'surface-1', 'W')).toEqual({ ok: true, baseRef: 'main' });
    expect(f.worktrees.baseBranch).toHaveBeenCalledWith({ workspaceId: 'W', rootPath: 'C:/repo-wt/feature', mainRoot: 'C:/repo' });
    expect(await f.invoke('git:worktree-base-diff', 'surface-1', 'W')).toEqual({
      ok: true, text: 'diff --git a/x b/x', truncated: false, omissions: [], baseRef: 'main', mergeBase: 'a'.repeat(40), ahead: 2,
    });
    expect(f.git.getReviewDiff).toHaveBeenCalledWith('C:/repo-wt/feature', { kind: 'base-branch', baseRef: 'main' });
  });

  it('answers only an EZTerminal window', async () => {
    const f = fixture();
    expect(await f.invoke('git:worktree-base', 'not-a-surface', 'W')).toEqual({ ok: false, error: 'not-found' });
    expect(await f.invokeFrom({ sender: { id: 2 } }, 'git:worktree-base-diff', 'surface-1', 'W')).toEqual({ ok: false, error: 'invalid-path' });
    expect(f.worktrees.baseBranch).not.toHaveBeenCalled();
    expect(f.git.getReviewDiff).not.toHaveBeenCalled();
  });

  it('reads only a person’s live worktree workspace, never a path or a run’s worktree', async () => {
    const f = fixture();
    for (const workspaceId of ['L', 'gone', 'planning-workspace-abc', 'missing', 'C:/repo', 42]) {
      expect(await f.invoke('git:worktree-base', 'surface-1', workspaceId)).toEqual({ ok: false, error: 'not-found' });
      expect(await f.invoke('git:worktree-base-diff', 'surface-1', workspaceId)).toEqual({ ok: false, error: 'invalid-path' });
    }
    expect(f.git.getReviewDiff).not.toHaveBeenCalled();
  });

  it('says so when the main checkout has no branch out, or the base cannot be compared', async () => {
    const detached = fixture({ base: undefined });
    expect(await detached.invoke('git:worktree-base', 'surface-1', 'W')).toEqual({ ok: false, error: 'no-base' });
    expect(await detached.invoke('git:worktree-base-diff', 'surface-1', 'W')).toEqual({ ok: false, error: 'no-base' });
    const unrelated = fixture({ diff: { ok: false, error: 'no-base' } });
    expect(await unrelated.invoke('git:worktree-base-diff', 'surface-1', 'W')).toEqual({ ok: false, error: 'no-base' });
  });

  it('removes both channels on dispose', () => {
    const f = fixture();
    f.dispose();
    expect(f.handlers.size).toBe(0);
  });
});
