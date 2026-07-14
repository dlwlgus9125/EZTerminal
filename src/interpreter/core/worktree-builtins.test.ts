import { describe, expect, it, vi } from 'vitest';

import type { WorktreeRequest, WorktreeResult } from '../../shared/worktree';
import { ShellSession } from '../shell-session';
import { evaluate, parse, recordToJson, type JsonRecord, type PipelineData } from './index';

async function collect(data: PipelineData): Promise<JsonRecord[]> {
  if (data.kind !== 'list-stream') throw new Error(`expected list-stream, got ${data.kind}`);
  const rows: JsonRecord[] = [];
  for await (const row of data.rows) rows.push(recordToJson(row));
  return rows;
}

function run(
  text: string,
  executeWorktree: (request: WorktreeRequest) => Promise<WorktreeResult>,
  onWorktreeOpened?: Parameters<ShellSession['createContext']>[4],
): PipelineData {
  const context = new ShellSession('/repo').createContext(
    new AbortController().signal,
    undefined,
    undefined,
    executeWorktree,
    onWorktreeOpened,
  );
  return evaluate(parse(text), context);
}

const managed = {
  worktreeId: 'wt-1',
  repoId: 'repo-1',
  path: '/safe/feature',
  branch: 'feature',
  head: 'abc123',
  main: false,
  locked: false,
  managed: true,
  prunable: false,
} as const;

describe('worktree builtin', () => {
  it('lists worktrees as typed structured rows and invokes main lazily', async () => {
    const execute = vi.fn(async (): Promise<WorktreeResult> => ({
      ok: true,
      action: 'list',
      worktrees: [managed],
    }));
    const data = run('worktree list', execute);
    expect(execute).not.toHaveBeenCalled();

    await expect(collect(data)).resolves.toEqual([
      expect.objectContaining({
        status: 'ok',
        action: 'list',
        worktreeId: 'wt-1',
        path: '/safe/feature',
        managed: true,
        error: '',
      }),
    ]);
    expect(execute).toHaveBeenCalledWith({ action: 'list', cwd: '/repo' });
  });

  it('maps create flags to a bounded service request and emits only the created row', async () => {
    const execute = vi.fn(async (): Promise<WorktreeResult> => ({
      ok: true,
      action: 'create',
      worktrees: [managed],
      opened: managed,
    }));

    const rows = await collect(
      run('worktree create feature --base "main" --root "/safe/root" --allow-dirty-base', execute),
    );

    expect(execute).toHaveBeenCalledWith({
      action: 'create',
      cwd: '/repo',
      branch: 'feature',
      base: 'main',
      root: '/safe/root',
      allowDirtyBase: true,
    });
    expect(rows).toEqual([
      expect.objectContaining({ status: 'created', action: 'create', worktreeId: 'wt-1' }),
    ]);
  });

  it('keeps stable service failures in the structured block instead of throwing', async () => {
    const execute = vi.fn(async (): Promise<WorktreeResult> => ({
      ok: false,
      action: 'open',
      error: 'WORKTREE_NOT_FOUND',
      message: 'Worktree not found: missing',
    }));

    await expect(collect(run('worktree open missing', execute))).resolves.toEqual([
      expect.objectContaining({
        status: 'error',
        action: 'open',
        error: 'WORKTREE_NOT_FOUND',
        message: 'Worktree not found: missing',
      }),
    ]);
  });

  it('emits the validated open intent exactly once before the structured row', async () => {
    const opened = vi.fn();
    const execute = vi.fn(async (): Promise<WorktreeResult> => ({
      ok: true,
      action: 'open',
      worktrees: [managed],
      opened: managed,
    }));

    const rows = await collect(run('worktree open wt-1', execute, opened));

    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(managed);
    expect(rows).toEqual([
      expect.objectContaining({ status: 'opened', action: 'open', worktreeId: 'wt-1' }),
    ]);
  });

  it('validates the action grammar before invoking the main service', () => {
    const execute = vi.fn();
    expect(() => run('worktree remove', execute)).toThrow(/expected <worktree-id>/);
    expect(() => run('worktree list extra', execute)).toThrow(/expected no arguments/);
    expect(() => run('worktree unknown', execute)).toThrow(/unknown action/);
    expect(execute).not.toHaveBeenCalled();
  });
});
