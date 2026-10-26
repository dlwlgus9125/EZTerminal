// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProjectSummary } from '../../shared/agent-history';
import { AppI18nProvider } from '../i18n';
import type { ProjectRegistryAccess } from '../ProjectDialogs';
import { AllProjectsDialog, type AllProjectsDialogProps } from './AllProjectsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

const summary = (projectId: string, name: string, pinned = false): AgentProjectSummary => ({
  projectId, name, primaryRoot: `C:\\Work\\${name}`, additionalRoots: [], pinned, saved: true, sessionCount: 0, providers: [], lastActiveAt: 1,
});
const handoff = summary('p-handoff', 'Handoff', true);
const kitchen = summary('p-kitchen', 'Kitchen');
const flush = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); };

function accessFor(overrides: Partial<ProjectRegistryAccess> = {}): ProjectRegistryAccess {
  return {
    listAgentProjects: vi.fn<ProjectRegistryAccess['listAgentProjects']>(async () => ({ items: [handoff, kitchen], nextCursor: null })),
    saveAgentProject: vi.fn<ProjectRegistryAccess['saveAgentProject']>(async (input) => ({ ok: true, project: { ...kitchen, ...input, projectId: input.projectId ?? 'new' } })),
    removeAgentProject: vi.fn(async () => true),
    ...overrides,
  };
}

function render(access: ProjectRegistryAccess, options: { readonly withoutAdd?: boolean } = {}): AllProjectsDialogProps {
  const props: AllProjectsDialogProps = {
    access, reloadKey: 0, onClose: vi.fn(), onOpen: vi.fn(), onEdit: vi.fn(), onCliHistory: vi.fn(), onDelete: vi.fn(), onChanged: vi.fn(),
    ...(options.withoutAdd ? {} : { onAdd: vi.fn() }),
  };
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><AllProjectsDialog {...props} /></AppI18nProvider>));
  return props;
}
const byTestId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
};
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};
const rowNames = (): string[] => [...document.querySelectorAll('.ez-project-list__name')].map((name) => name.textContent ?? '');

describe('AllProjectsDialog', () => {
  it('lists every project, pinned first as the registry orders them', async () => {
    const access = accessFor();
    render(access);
    await flush();
    expect(access.listAgentProjects).toHaveBeenCalledWith(false, undefined, 40, undefined);
    expect(byTestId('all-projects-dialog').textContent).toContain('All projects');
    expect(rowNames()).toEqual(['Handoff (pinned)', 'Kitchen']);
  });

  it('searches the registry', async () => {
    const access = accessFor();
    render(access);
    await flush();
    const input = byTestId<HTMLInputElement>('all-projects-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, 'kit'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    expect(access.listAgentProjects).toHaveBeenLastCalledWith(false, undefined, 40, 'kit');
  });

  it('reads the next page on demand', async () => {
    const listAgentProjects = vi.fn<ProjectRegistryAccess['listAgentProjects']>()
      .mockResolvedValueOnce({ items: [handoff], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: [kitchen], nextCursor: null });
    render(accessFor({ listAgentProjects }));
    await flush();
    act(() => byTestId('all-projects-more').click());
    await flush();
    expect(listAgentProjects).toHaveBeenLastCalledWith(false, 'page-2', 40, undefined);
    expect(rowNames()).toEqual(['Handoff (pinned)', 'Kitchen']);
    expect(document.querySelector('[data-testid="all-projects-more"]')).toBeNull();
  });

  it('opens a project and pins one, then reads the order again', async () => {
    const access = accessFor();
    const props = render(access);
    await flush();
    act(() => byTestId('all-projects-open-p-kitchen').click());
    expect(props.onOpen).toHaveBeenCalledWith(kitchen);
    act(() => byTestId('all-projects-pin-p-kitchen').click());
    await flush();
    expect(access.saveAgentProject).toHaveBeenCalledWith({ projectId: 'p-kitchen', name: 'Kitchen', primaryRoot: 'C:\\Work\\Kitchen', additionalRoots: [], pinned: true });
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(access.listAgentProjects).toHaveBeenLastCalledWith(true, undefined, 40, undefined);
    expect(button('Unpin project: Handoff')).toBeTruthy();
  });

  it('manages a project from its menu, and Escape there closes only the menu', async () => {
    const props = render(accessFor());
    await flush();
    act(() => button('Manage Kitchen').click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => { document.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    for (const [label, handler] of [['Edit project', props.onEdit], ['CLI history', props.onCliHistory], ['Delete project', props.onDelete]] as const) {
      act(() => button('Manage Kitchen').click());
      act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label)!.click());
      expect(handler).toHaveBeenLastCalledWith(kitchen);
    }
  });

  it('offers adding only where folders can be chosen', async () => {
    const props = render(accessFor());
    await flush();
    act(() => byTestId('all-projects-add').click());
    expect(props.onAdd).toHaveBeenCalledOnce();
    act(() => root.unmount());
    root = createRoot(container);
    render(accessFor(), { withoutAdd: true });
    await flush();
    expect(document.querySelector('[data-testid="all-projects-add"]')).toBeNull();
  });

  it('says when there is nothing yet, nothing matching, or the list could not be read', async () => {
    render(accessFor({ listAgentProjects: vi.fn(async () => ({ items: [], nextCursor: null })) }));
    await flush();
    expect(byTestId('all-projects-dialog').textContent).toContain('No projects yet.');
    act(() => root.unmount());
    root = createRoot(container);
    const failing = vi.fn<ProjectRegistryAccess['listAgentProjects']>().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ items: [kitchen], nextCursor: null });
    render(accessFor({ listAgentProjects: failing }));
    await flush();
    expect(byTestId('all-projects-dialog').querySelector('[role="alert"]')?.textContent).toContain('Could not load projects.');
    act(() => button('Retry').click());
    await flush();
    expect(rowNames()).toEqual(['Kitchen']);
  });
});
