// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProjectSummary } from '../../shared/agent-history';
import { AppI18nProvider } from '../i18n';
import type { ProjectRegistryAccess } from '../ProjectDialogs';
import { ProjectDialogHost, type ProjectDialogHostProps, type ProjectDialogState } from './ProjectDialogHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

const kitchen: AgentProjectSummary = {
  projectId: 'p-kitchen', name: 'Kitchen', primaryRoot: 'C:\\Work\\Kitchen', additionalRoots: [], pinned: false, saved: true, sessionCount: 0, providers: [], lastActiveAt: 1,
};
const flush = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); };
const access: ProjectRegistryAccess = {
  listAgentProjects: vi.fn(async () => ({ items: [kitchen], nextCursor: null })),
  saveAgentProject: vi.fn(async (input) => ({ ok: true as const, project: { ...kitchen, ...input, projectId: input.projectId ?? 'new' } })),
  removeAgentProject: vi.fn(async () => true),
  selectFolders: vi.fn(async () => ({ canceled: false, paths: ['C:\\Work\\Fresh'] })),
};

type Handlers = Omit<ProjectDialogHostProps, 'state' | 'onStateChange' | 'access' | 'worktrees' | 'snapshot'> & Pick<Partial<ProjectDialogHostProps>, 'worktrees' | 'snapshot'>;
let openDialog: (state: ProjectDialogState) => void = () => undefined;
function Harness(handlers: Handlers): JSX.Element {
  const [state, setState] = useState<ProjectDialogState | null>(null);
  openDialog = setState;
  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <button type="button" data-testid="invoker" onClick={() => setState({ kind: 'list' })}>All projects</button>
      <ProjectDialogHost state={state} onStateChange={setState} access={access} {...handlers} />
    </AppI18nProvider>
  );
}
function render(extra: Partial<Handlers> = {}): Handlers {
  const handlers: Handlers = {
    onSaved: vi.fn(), onDeleted: vi.fn(), onChanged: vi.fn(), onOpenBoard: vi.fn(), onCliHistory: vi.fn(), onWorktreeCreated: vi.fn(), ...extra,
  };
  act(() => root.render(<Harness {...handlers} />));
  return handlers;
}
const dialogs = (): number => document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;
const byTestId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
};
const pressEscape = (): void => { act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); };
function chooseFromMenu(label: string): void {
  act(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === 'Manage Kitchen')!.click());
  act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label)!.click());
}

describe('ProjectDialogHost', () => {
  it('opens backup and restore on top of the project settings and goes back to them, edits kept; an unanswered request shows again', async () => {
    const pending = { read: vi.fn(() => ({ type: 'export' as const, projectId: 'p-kitchen', commandId: 'export-1' })), write: vi.fn(async () => undefined) };
    const executeProjectArchive = vi.fn(async () => ({ ok: false as const, error: 'unavailable' as const, message: 'offline' }));
    render({ archive: { access: { executeProjectArchive }, pending } });
    act(() => openDialog({ kind: 'edit', project: kitchen }));
    await flush();
    const name = byTestId<HTMLInputElement>('agent-project-name');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Kitchen renamed');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => byTestId('agent-project-backup').click());
    await flush();
    expect(dialogs()).toBe(2);
    expect(byTestId('project-archive-dialog').textContent).toContain('Kitchen');
    expect(pending.read).toHaveBeenCalledWith('p-kitchen');
    pressEscape();
    await flush();
    expect(dialogs()).toBe(1);
    expect(byTestId('agent-project-editor').textContent).toContain('Edit project');
    expect(byTestId<HTMLInputElement>('agent-project-name').value).toBe('Kitchen renamed');
  });

  it('offers no backup entry where the host has no archive', async () => {
    render();
    act(() => openDialog({ kind: 'edit', project: kitchen }));
    await flush();
    expect(document.querySelector('[data-testid="agent-project-backup"]')).toBeNull();
  });

  it('opens an edit from the list over it one layer at a time, and goes back to the list', async () => {
    render();
    const invoker = byTestId<HTMLButtonElement>('invoker');
    invoker.focus();
    act(() => invoker.click());
    await flush();
    expect(dialogs()).toBe(1);
    chooseFromMenu('Edit project');
    await flush();
    expect(dialogs()).toBe(1);
    expect(byTestId('agent-project-editor').textContent).toContain('Edit project');
    pressEscape();
    await flush();
    expect(dialogs()).toBe(1);
    expect(document.querySelector('[data-testid="all-projects-dialog"]')).not.toBeNull();
    pressEscape();
    await flush();
    expect(dialogs()).toBe(0);
    expect(document.activeElement).toBe(invoker);
  });

  it('goes back to the list after a delete made from it, and reads it again', async () => {
    const handlers = render();
    act(() => byTestId('invoker').click());
    await flush();
    const reads = vi.mocked(access.listAgentProjects).mock.calls.length;
    chooseFromMenu('Delete project');
    await flush();
    expect(byTestId('agent-project-delete').getAttribute('role')).toBe('alertdialog');
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="agent-project-delete"] button')].find((item) => item.textContent?.trim() === 'Delete project')!.click());
    await flush();
    expect(handlers.onDeleted).toHaveBeenCalledWith('p-kitchen');
    expect(document.querySelector('[data-testid="all-projects-dialog"]')).not.toBeNull();
    expect(vi.mocked(access.listAgentProjects).mock.calls.length).toBeGreaterThan(reads);
  });

  it('closes on a project chosen from the list or its CLI history', async () => {
    const handlers = render();
    act(() => byTestId('invoker').click());
    await flush();
    act(() => byTestId('all-projects-open-p-kitchen').click());
    expect(handlers.onOpenBoard).toHaveBeenCalledWith(kitchen);
    expect(dialogs()).toBe(0);
    act(() => byTestId('invoker').click());
    await flush();
    chooseFromMenu('CLI history');
    expect(handlers.onCliHistory).toHaveBeenCalledWith(kitchen);
    expect(dialogs()).toBe(0);
  });

  it('goes from the worktrees to a merge and back, reading git again; a new worktree cancelled goes back too', async () => {
    const status = vi.fn(async () => ({ ok: true as const, value: [{ workspaceId: 'wt-1', branch: 'feature/a', dirty: false, ahead: 1, merged: false, status: 'review' as const }] }));
    const worktrees = {
      create: vi.fn(async () => ({ ok: true as const, value: { workspaceId: 'wt-2' } })),
      status,
      commit: vi.fn(), merge: vi.fn(), remove: vi.fn(),
    };
    const record = { revision: 1, createdAt: '2026-10-24T09:00:00.000Z', updatedAt: '2026-10-24T09:00:00.000Z' };
    const snapshot = { workspaces: [{ id: 'wt-1', projectId: 'p-kitchen', name: 'a', kind: 'worktree', rootPath: 'C:/wt/a', ...record }], sessions: [], agents: [], agentRelations: [], turns: [], approvals: [] };
    const handlers = render();
    act(() => root.render(<Harness {...handlers} worktrees={worktrees as never} snapshot={snapshot as never} />));
    const project = { projectId: 'p-kitchen', name: 'Kitchen' };
    act(() => openDialog({ kind: 'worktrees', project }));
    await flush();
    expect(byTestId('worktrees-dialog')).toBeTruthy();
    const reads = status.mock.calls.length;
    act(() => byTestId('workspace-merge').click());
    await flush();
    expect(byTestId('worktree-merge-dialog')).toBeTruthy();
    expect(dialogs()).toBe(1);
    pressEscape();
    await flush();
    expect(byTestId('worktrees-dialog')).toBeTruthy();
    expect(status.mock.calls.length).toBeGreaterThan(reads + 1);

    act(() => byTestId('worktrees-new').click());
    await flush();
    expect(byTestId('new-worktree-dialog')).toBeTruthy();
    pressEscape();
    await flush();
    expect(byTestId('worktrees-dialog')).toBeTruthy();
  });

  it('closes once a new worktree is made, and its conversation opens', async () => {
    const worktrees = { create: vi.fn(async () => ({ ok: true as const, value: { workspaceId: 'wt-2' } })), status: vi.fn(), commit: vi.fn(), merge: vi.fn(), remove: vi.fn() };
    const handlers = render();
    act(() => root.render(<Harness {...handlers} worktrees={worktrees as never} />));
    const project = { projectId: 'p-kitchen', name: 'Kitchen' };
    act(() => openDialog({ kind: 'worktree-new', project, returnTo: 'worktrees' }));
    await flush();
    const input = byTestId<HTMLInputElement>('new-worktree-branch');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, 'feature/b'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => byTestId('new-worktree-create').click());
    await flush();
    expect(worktrees.create).toHaveBeenCalledWith('p-kitchen', 'feature/b');
    expect(handlers.onWorktreeCreated).toHaveBeenCalledWith(project, 'wt-2');
    expect(dialogs()).toBe(0);
  });

  it('closes after adding a project, even one started from the list', async () => {
    const handlers = render();
    act(() => openDialog({ kind: 'add', returnTo: 'list' }));
    await flush();
    act(() => byTestId('agent-project-add-folder').click());
    await flush();
    act(() => byTestId('agent-project-save').click());
    await flush();
    expect(handlers.onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Fresh' }), 'add', undefined);
    expect(dialogs()).toBe(0);
  });
});
