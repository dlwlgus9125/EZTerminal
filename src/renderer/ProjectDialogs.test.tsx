// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProjectSummary } from '../shared/agent-history';
import { AppI18nProvider } from './i18n';
import {
  findAgentProject,
  ProjectDeleteDialog,
  ProjectEditorDialog,
  type ProjectEditorMode,
  type ProjectRegistryAccess,
} from './ProjectDialogs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const project: AgentProjectSummary = {
  projectId: 'project-handoff', name: 'Handoff', primaryRoot: 'C:\\Work\\handoff', additionalRoots: ['C:\\Work\\shared'],
  pinned: true, saved: true, sessionCount: 0, providers: [], lastActiveAt: 1,
};
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

function accessFor(overrides: Partial<ProjectRegistryAccess> = {}): ProjectRegistryAccess {
  return {
    listAgentProjects: vi.fn<ProjectRegistryAccess['listAgentProjects']>(async () => ({ items: [], nextCursor: null })),
    saveAgentProject: vi.fn<ProjectRegistryAccess['saveAgentProject']>(async (input) => ({
      ok: true,
      project: { ...project, projectId: input.projectId ?? 'project-new', name: input.name, primaryRoot: input.primaryRoot, additionalRoots: input.additionalRoots, pinned: input.pinned },
    })),
    removeAgentProject: vi.fn<ProjectRegistryAccess['removeAgentProject']>(async () => true),
    selectFolders: vi.fn<NonNullable<ProjectRegistryAccess['selectFolders']>>(async () => ({ canceled: false, paths: ['C:\\Work\\fresh-app'] })),
    ...overrides,
  };
}

function renderEditor(mode: ProjectEditorMode, access: ProjectRegistryAccess, handlers: { onClose?: () => void; onSaved?: (saved: AgentProjectSummary, previous?: string) => void } = {}): void {
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <ProjectEditorDialog open mode={mode} access={access} onClose={handlers.onClose ?? vi.fn()} onSaved={handlers.onSaved ?? vi.fn()} />
    </AppI18nProvider>,
  ));
}

const byTestId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
};
const nameInput = (): HTMLInputElement => byTestId<HTMLInputElement>('agent-project-name');
const roots = (): string[] => [...document.querySelectorAll('.agent-project-roots li span[title]')].map((item) => item.textContent ?? '');
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(element: HTMLElement): Promise<void> { act(() => element.click()); await flush(); }
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};

describe('ProjectEditorDialog: adding', () => {
  it('opens empty, then chosen folders fill the folders and the name', async () => {
    const access = accessFor();
    renderEditor({ kind: 'add' }, access);
    expect(byTestId('agent-project-editor').textContent).toContain('Add project');
    expect(byTestId<HTMLButtonElement>('agent-project-save').disabled).toBe(true);
    expect(roots()).toEqual([]);
    expect(document.querySelector('[data-testid="agent-project-editor"] [role="alert"]')).toBeNull();
    await click(byTestId('agent-project-add-folder'));
    expect(access.selectFolders).toHaveBeenCalledWith(true);
    expect(roots()).toEqual(['C:\\Work\\fresh-app']);
    expect(nameInput().value).toBe('fresh-app');
    expect(byTestId<HTMLButtonElement>('agent-project-save').disabled).toBe(false);
  });

  it('keeps a typed name and skips folders already listed', async () => {
    const selectFolders = vi.fn<NonNullable<ProjectRegistryAccess['selectFolders']>>()
      .mockResolvedValueOnce({ canceled: false, paths: ['C:\\Work\\fresh-app'] })
      .mockResolvedValueOnce({ canceled: false, paths: ['c:\\work\\FRESH-APP', 'C:\\Work\\docs'] });
    const access = accessFor({ selectFolders });
    renderEditor({ kind: 'add' }, access);
    type(nameInput(), 'My app');
    await click(byTestId('agent-project-add-folder'));
    await click(byTestId('agent-project-add-folder'));
    expect(nameInput().value).toBe('My app');
    expect(roots()).toEqual(['C:\\Work\\fresh-app', 'C:\\Work\\docs']);
  });

  it('follows a new primary folder with the untouched name', async () => {
    const access = accessFor({ selectFolders: vi.fn(async () => ({ canceled: false, paths: ['C:\\Work\\one', 'C:\\Work\\two'] })) });
    renderEditor({ kind: 'add' }, access);
    await click(byTestId('agent-project-add-folder'));
    expect(nameInput().value).toBe('one');
    await click(button('Set as primary'));
    expect(roots()).toEqual(['C:\\Work\\two', 'C:\\Work\\one']);
    expect(nameInput().value).toBe('two');
  });

  it('saves a new project without an id and reports it', async () => {
    const access = accessFor();
    const onSaved = vi.fn();
    renderEditor({ kind: 'add' }, access, { onSaved });
    await click(byTestId('agent-project-add-folder'));
    await click(byTestId('agent-project-save'));
    expect(access.saveAgentProject).toHaveBeenCalledWith({ name: 'fresh-app', primaryRoot: 'C:\\Work\\fresh-app', additionalRoots: [], pinned: false });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-new', name: 'fresh-app' }), undefined);
  });

  it('a cancelled folder choice changes nothing', async () => {
    const access = accessFor({ selectFolders: vi.fn(async () => ({ canceled: true, paths: [] })) });
    renderEditor({ kind: 'add' }, access);
    await click(byTestId('agent-project-add-folder'));
    expect(roots()).toEqual([]);
    expect(nameInput().value).toBe('');
  });

  it('stays open and says so when saving fails', async () => {
    const access = accessFor({ saveAgentProject: vi.fn(async () => ({ ok: false, reason: 'duplicate' } as const)) });
    const onSaved = vi.fn();
    renderEditor({ kind: 'add' }, access, { onSaved });
    await click(byTestId('agent-project-add-folder'));
    await click(byTestId('agent-project-save'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(byTestId('agent-project-editor').querySelector('[role="alert"]')?.textContent).toBe('Could not save the project.');
  });

  it('has no folder button without a folder picker', () => {
    const withoutPicker: ProjectRegistryAccess = { ...accessFor() };
    delete (withoutPicker as { selectFolders?: unknown }).selectFolders;
    renderEditor({ kind: 'add' }, withoutPicker);
    expect(document.querySelector('[data-testid="agent-project-add-folder"]')).toBeNull();
  });
});

describe('ProjectEditorDialog: editing', () => {
  it('starts from every folder of the project and saves it under its id', async () => {
    const access = accessFor();
    const onSaved = vi.fn();
    renderEditor({ kind: 'edit', project }, access, { onSaved });
    expect(byTestId('agent-project-editor').textContent).toContain('Edit project');
    expect(nameInput().value).toBe('Handoff');
    expect(roots()).toEqual(['C:\\Work\\handoff', 'C:\\Work\\shared']);
    await click(button('Set as primary'));
    await click(byTestId('agent-project-save'));
    expect(access.saveAgentProject).toHaveBeenCalledWith({
      projectId: 'project-handoff', name: 'Handoff', primaryRoot: 'C:\\Work\\shared', additionalRoots: ['C:\\Work\\handoff'], pinned: true,
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ primaryRoot: 'C:\\Work\\shared' }), 'project-handoff');
  });

  it('removes a folder and keeps the name as it was', async () => {
    const access = accessFor();
    renderEditor({ kind: 'edit', project }, access);
    await click(button('Remove folder: C:\\Work\\shared'));
    expect(roots()).toEqual(['C:\\Work\\handoff']);
    expect(nameInput().value).toBe('Handoff');
  });
});

describe('ProjectDeleteDialog', () => {
  function renderDelete(access: ProjectRegistryAccess, onDeleted = vi.fn()): void {
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <ProjectDeleteDialog project={project} access={access} onClose={vi.fn()} onDeleted={onDeleted} />
      </AppI18nProvider>,
    ));
  }

  it('removes the project once confirmed', async () => {
    const access = accessFor();
    const onDeleted = vi.fn();
    renderDelete(access, onDeleted);
    expect(byTestId('agent-project-delete').getAttribute('role')).toBe('alertdialog');
    await click(button('Delete project'));
    expect(access.removeAgentProject).toHaveBeenCalledWith('project-handoff');
    expect(onDeleted).toHaveBeenCalledWith('project-handoff');
  });

  it('stays open with the reason when removing fails', async () => {
    const access = accessFor({ removeAgentProject: vi.fn(async () => false) });
    const onDeleted = vi.fn();
    renderDelete(access, onDeleted);
    await click(button('Delete project'));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(byTestId('agent-project-delete').querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('findAgentProject', () => {
  it('reads pages until the project turns up', async () => {
    const other = { ...project, projectId: 'other' };
    const list = vi.fn<ProjectRegistryAccess['listAgentProjects']>()
      .mockResolvedValueOnce({ items: [other], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: [project], nextCursor: 'page-3' });
    await expect(findAgentProject(list, 'project-handoff')).resolves.toBe(project);
    expect(list).toHaveBeenNthCalledWith(1, false, undefined, 100);
    expect(list).toHaveBeenNthCalledWith(2, false, 'page-2', 100);
  });

  it('gives null after the last page', async () => {
    const list = vi.fn<ProjectRegistryAccess['listAgentProjects']>(async () => ({ items: [], nextCursor: null }));
    await expect(findAgentProject(list, 'missing')).resolves.toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
