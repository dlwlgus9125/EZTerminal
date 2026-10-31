// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceWorktreeStatusView } from '../shared/workspace-worktree';
import { AppI18nProvider } from './i18n';
import { WorktreeMergeDialog } from './WorktreeDialogs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const untouched: WorkspaceWorktreeStatusView = { workspaceId: 'w', branch: 'suggest/fix', baseBranch: 'main', dirty: false, ahead: 0, merged: false, untouched: true };
const cleanup = { chats: 1, busy: false, run: vi.fn(async () => ({ ok: true as const, value: { branch: 'suggest/fix', branchDeleted: true, archivedChats: 1, notes: [] } })) };

async function open(status: WorkspaceWorktreeStatusView): Promise<void> {
  await act(async () => {
    root.render(
      <AppI18nProvider locale="ko" languages={['ko']}>
        <WorktreeMergeDialog open onOpenChange={() => undefined} title="suggest/fix" status={status} onRefresh={async () => undefined}
          onCommit={vi.fn()} onMerge={vi.fn()} cleanup={cleanup} />
      </AppI18nProvider>,
    );
    await Promise.resolve();
  });
}

const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('cleaning up a worktree', () => {
  it('says why a worktree with nothing of its own can go without a merge, and offers no merge', async () => {
    await open(untouched);
    expect(byTestId('worktree-merge-note')?.textContent).toBe('자기 커밋도 커밋 안 된 변경도 없어 병합 없이 정리할 수 있습니다.');
    expect(byTestId('worktree-merge-confirm')).toBeNull();
    expect(byTestId('worktree-cleanup')).not.toBeNull();
    expect(byTestId('worktree-merge-dialog')?.textContent).not.toContain('병합 커밋이 하나 생깁니다');
  });

  it('still says what a merge does while there is one to make', async () => {
    await open({ ...untouched, ahead: 1, untouched: false, status: 'review' });
    expect(byTestId('worktree-merge-dialog')?.textContent).toContain('병합 커밋이 하나 생깁니다');
  });

  it('does not claim its work is merged when it asks to confirm', async () => {
    await open(untouched);
    await act(async () => { byTestId('worktree-cleanup')!.click(); await Promise.resolve(); });
    const consequences = byTestId('worktree-cleanup-consequences')?.textContent ?? '';
    expect(consequences).toContain('이 브랜치에는 자기 커밋도 커밋 안 된 변경도 없습니다.');
    expect(consequences).not.toContain('병합돼 있습니다');
  });

  it('still says a merged branch is merged', async () => {
    await open({ ...untouched, merged: true, status: 'done' });
    expect(byTestId('worktree-merge-note')?.textContent).toBe('이미 main에 병합됐습니다.');
    await act(async () => { byTestId('worktree-cleanup')!.click(); await Promise.resolve(); });
    expect(byTestId('worktree-cleanup-consequences')?.textContent).toContain('작업은 main에 병합돼 있습니다.');
  });

  it.each([
    ['a commit of its own', { ahead: 1, untouched: false, status: 'review' as const }],
    ['uncommitted changes', { dirty: true, untouched: false, status: 'review' as const }],
    ['no branch of its own to compare', { untouched: false }],
  ])('offers no clean-up with %s', async (_label, status) => {
    await open({ ...untouched, ...status });
    expect(byTestId('worktree-cleanup')).toBeNull();
  });
});
