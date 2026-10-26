// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { WorkspaceWorktreeAccess, WorkspaceWorktreeStatusView } from '../../shared/workspace-worktree';
import { AppI18nProvider } from '../i18n';
import { shellSnapshot } from './shell-fixtures';
import { projectWorktrees, WorktreesDialog } from './WorktreesDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const record = { revision: 1, createdAt: '2026-10-24T09:00:00.000Z', updatedAt: '2026-10-24T09:00:00.000Z' };
function withWorktrees(): DaemonSnapshot {
  const base = shellSnapshot();
  const worktree = (id: string, projectId: string, name: string, extra: object = {}) => ({ id, projectId, name, kind: 'worktree' as const, rootPath: `C:/wt/${name}`, ...record, ...extra });
  return {
    ...base,
    workspaces: [
      ...base.workspaces,
      worktree('wt-login', 'p-ez', 'login'),
      worktree('wt-docs', 'p-ez', 'docs'),
      worktree('wt-fresh', 'p-ez', 'fresh'),
      worktree('planning-workspace-run-1', 'p-ez', 'run-1'),
      worktree('wt-old', 'p-ez', 'old', { archivedAt: '2026-10-20T00:00:00.000Z' }),
      worktree('wt-garnet', 'p-garnet', 'garnet'),
    ],
    sessions: [...base.sessions, { id: 's-wt', projectId: 'p-ez', workspaceId: 'wt-login', kind: 'agent', title: 'Login', state: 'running', source: 'structured', ...record }],
    agents: [...base.agents, { sessionId: 's-wt', providerId: 'codex', permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: false, state: 'working', ...record }],
  };
}
const statuses: readonly WorkspaceWorktreeStatusView[] = [
  { workspaceId: 'wt-login', branch: 'feature/login', dirty: true, ahead: 2, merged: false, status: 'review' },
  { workspaceId: 'wt-docs', branch: 'docs/readme', dirty: false, ahead: 0, merged: true, status: 'done' },
  { workspaceId: 'wt-fresh', branch: 'fresh', dirty: false, ahead: 0, merged: false },
];
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

function render(status: Pick<WorkspaceWorktreeAccess, 'status'>['status'], snapshot: DaemonSnapshot = withWorktrees()) {
  const handlers = { onClose: vi.fn(), onNew: vi.fn(), onMerge: vi.fn() };
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <WorktreesDialog project={{ projectId: 'p-ez', name: 'EZTerminal' }} snapshot={snapshot} worktrees={{ status }} reloadKey={0} {...handlers} />
    </AppI18nProvider>,
  ));
  return handlers;
}
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="worktree-row"]')];

describe('projectWorktrees', () => {
  it('lists the project’s own worktrees: not a flow run’s, not archived, not another project’s', () => {
    expect(projectWorktrees(withWorktrees(), 'p-ez').map((row) => [row.workspaceId, row.working])).toEqual([
      ['wt-login', true], ['wt-docs', false], ['wt-fresh', false],
    ]);
    expect(projectWorktrees(null, 'p-ez')).toEqual([]);
  });
});

describe('WorktreesDialog', () => {
  it('shows where each worktree stands, a running conversation first', async () => {
    const status = vi.fn(async () => ({ ok: true as const, value: statuses }));
    render(status);
    await flush();
    expect(status).toHaveBeenCalledWith('p-ez');
    expect(document.querySelector('[data-testid="worktrees-dialog"]')?.textContent).toContain('Worktrees · EZTerminal');
    expect(rows().map((row) => row.dataset.state)).toEqual(['working', 'done', 'clean']);
    expect(rows()[0]!.textContent).toContain('feature/login');
    expect(rows()[0]!.textContent).toContain('In progress · 2 commits ahead · Uncommitted changes');
    expect(rows()[1]!.textContent).toContain('Done');
    expect(rows()[2]!.textContent).toContain('No changes');
  });

  it('opens the merge for a row and offers a new worktree', async () => {
    const handlers = render(vi.fn(async () => ({ ok: true as const, value: statuses })));
    await flush();
    act(() => rows()[1]!.querySelector<HTMLButtonElement>('[data-testid="workspace-merge"]')!.click());
    expect(handlers.onMerge).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'wt-docs', rootPath: 'C:/wt/docs' }));
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="worktrees-new"]')!.click());
    expect(handlers.onNew).toHaveBeenCalledOnce();
  });

  it('says when there are none, and when git cannot be read (with a retry)', async () => {
    const base = shellSnapshot();
    render(vi.fn(async () => ({ ok: true as const, value: [] })), base);
    await flush();
    expect(document.querySelector('[data-testid="worktrees-dialog"]')?.textContent).toContain('This project has no worktrees.');
    act(() => root.unmount());
    root = createRoot(container);
    const failing = vi.fn<Pick<WorkspaceWorktreeAccess, 'status'>['status']>()
      .mockResolvedValueOnce({ ok: false, reason: 'git-failed', message: 'git is not installed' })
      .mockResolvedValueOnce({ ok: true, value: statuses });
    render(failing);
    await flush();
    expect(document.querySelector('[data-testid="worktrees-dialog"] [role="alert"]')?.textContent).toContain('git is not installed');
    act(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === 'Retry')!.click());
    await flush();
    expect(rows()).toHaveLength(3);
  });
});
