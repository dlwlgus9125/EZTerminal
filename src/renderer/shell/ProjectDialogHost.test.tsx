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

type Handlers = Omit<ProjectDialogHostProps, 'state' | 'onStateChange' | 'access'>;
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
function render(): Handlers {
  const handlers: Handlers = {
    onSaved: vi.fn(), onDeleted: vi.fn(), onChanged: vi.fn(), onOpenBoard: vi.fn(), onCliHistory: vi.fn(), onWorktreeCreated: vi.fn(),
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
