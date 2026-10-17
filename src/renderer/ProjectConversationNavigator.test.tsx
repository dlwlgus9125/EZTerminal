// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, DaemonSnapshot } from '../shared/daemon-protocol';
import type { DaemonAgentSessionListAccess } from './DaemonAgentSessions';
import { ProjectConversationNavigator } from './ProjectConversationNavigator';
import { sessionStartSnapshot } from './session-start.fixtures';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const eventBase = { protocolVersion: sessionStartSnapshot.protocolVersion, eventId: 'event', revision: 1, sequence: 2, occurredAt: sessionStartSnapshot.generatedAt };
describe('project navigation observation', () => {
  let element: HTMLDivElement;
  let root: Root;
  beforeEach(() => { window.localStorage.clear(); element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
  afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
  const render = async (access: DaemonAgentSessionListAccess): Promise<void> => {
    await act(async () => root.render(<AppI18nProvider locale="en" languages={['en']}><ProjectConversationNavigator projects={[]} access={{}} daemonAccess={access} onOpenProject={vi.fn()} onOpenSession={vi.fn()} onOpenTerminal={vi.fn()} /></AppI18nProvider>));
  };
  it('ignores streamed transcript events while refreshing changes to session metadata', async () => {
    let listener!: (event: DaemonEvent) => void;
    const getSnapshot = vi.fn(async () => sessionStartSnapshot);
    await render({ getSnapshot, getAvailability: vi.fn(), observeEvents: next => { listener = next; return () => undefined; } });
    await act(async () => { for (let sequence = 2; sequence < 102; sequence += 1) listener({ ...eventBase, sequence, kind: 'transcript.appended', payload: { sessionId: 'chat', fromSequence: sequence, toSequence: sequence } }); });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => listener({ ...eventBase, kind: 'entity.upserted', payload: { entityType: 'agent', entityId: 'chat' } }));
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
  it('coalesces metadata notifications received while a snapshot is loading', async () => {
    let listener!: (event: DaemonEvent) => void;
    let resolve!: (snapshot: DaemonSnapshot) => void;
    const initial = new Promise<DaemonSnapshot>(done => { resolve = done; });
    const getSnapshot = vi.fn().mockReturnValueOnce(initial).mockResolvedValue(sessionStartSnapshot);
    await render({ getSnapshot, getAvailability: vi.fn(), observeEvents: next => { listener = next; return () => undefined; } });
    await act(async () => {
      for (let sequence = 2; sequence < 12; sequence += 1) listener({ ...eventBase, sequence, kind: 'entity.upserted', payload: { entityType: 'session', entityId: 'chat' } });
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => resolve(sessionStartSnapshot));
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
  it('shows where a worktree stands and commits then merges it from its row', async () => {
    const status = { workspaceId: 'feature', branch: 'session-ux', baseBranch: 'main', dirty: true, ahead: 0, merged: false, status: 'review' as const };
    const worktrees = {
      create: vi.fn(),
      status: vi.fn().mockResolvedValueOnce({ ok: true, value: [status] }).mockResolvedValueOnce({ ok: true, value: [status] })
        .mockResolvedValueOnce({ ok: true, value: [{ ...status, dirty: false, ahead: 1 }] })
        .mockResolvedValue({ ok: true, value: [{ ...status, dirty: false, ahead: 0, merged: true, status: 'done' }] }),
      commit: vi.fn(async () => ({ ok: true, value: { commit: 'abc' } })),
      merge: vi.fn(async () => ({ ok: true, value: { into: 'main', commit: 'def' } })),
    };
    const previous = window.ezterminal;
    Object.assign(window, { ezterminal: { workspaceWorktrees: worktrees } });
    try {
      const onNew = vi.fn();
      const project = { projectId: 'project', name: 'EZTerminal', primaryRoot: 'C:/Working/EZTerminal', additionalRoots: [], pinned: false };
      await act(async () => root.render(<AppI18nProvider locale="en" languages={['en']}><ProjectConversationNavigator projects={[project as never]} access={{}}
        daemonAccess={{ getSnapshot: vi.fn(async () => sessionStartSnapshot), getAvailability: vi.fn(), observeEvents: () => () => undefined }}
        onOpenProject={vi.fn()} onOpenSession={vi.fn()} onOpenTerminal={vi.fn()} onNewConversationInWorkspace={onNew} /></AppI18nProvider>));
      expect(worktrees.status).toHaveBeenCalledWith('project');
      const row = element.querySelector('[role="treeitem"][aria-label^="session-ux"]');
      expect(row?.getAttribute('aria-label')).toContain('Ready to review');
      await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="New chat here: session-ux"]')!.click());
      expect(onNew).toHaveBeenCalledWith('project', 'feature');

      await act(async () => element.querySelector<HTMLButtonElement>('[data-testid="workspace-merge"]')!.click());
      const confirm = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-testid="worktree-merge-confirm"]')!;
      expect(confirm().disabled).toBe(true);
      const message = document.querySelector<HTMLInputElement>('[data-testid="worktree-commit-message"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(message, 'Tidy copy');
        message.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="worktree-commit"]')!.click());
      expect(worktrees.commit).toHaveBeenCalledWith('feature', 'Tidy copy');
      expect(document.querySelector('[data-testid="worktree-merge-ahead"]')?.textContent).toBe('1');
      await act(async () => confirm().click());
      expect(worktrees.merge).toHaveBeenCalledWith('feature');
      expect(document.querySelector('[data-testid="worktree-merge-dialog"]')?.textContent).toContain('Merged session-ux into main.');
    } finally {
      Object.assign(window, { ezterminal: previous });
    }
  });
});
