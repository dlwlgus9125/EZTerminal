// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDockviewPanelHeaderProps } from 'dockview-react';

import { AppI18nProvider } from './i18n';
import { agentHistoryTabTitle, WorkspaceTab } from './WorkspaceTab';

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
  document.querySelector('[data-testid="workspace-tab-context-menu"]')?.remove();
  container.remove();
});

function fakeProps(initialParams: Record<string, unknown> = {}) {
  const titleListeners = new Set<(event: { title: string }) => void>();
  const parameterListeners = new Set<(params: Record<string, unknown>) => void>();
  let title = 'Terminal 3';
  let params: Record<string, unknown> = initialParams;
  const api = {
    id: 'tab-3',
    component: 'terminal',
    get title() { return title; },
    setTitle: vi.fn((next: string) => {
      title = next;
      for (const listener of titleListeners) listener({ title: next });
    }),
    setActive: vi.fn(),
    close: vi.fn(),
    getParameters: vi.fn(() => params),
    updateParameters: vi.fn((next: Record<string, unknown>) => {
      params = next;
      for (const listener of parameterListeners) listener(next);
    }),
    onDidParametersChange: (listener: (next: Record<string, unknown>) => void) => {
      parameterListeners.add(listener);
      return { dispose: () => parameterListeners.delete(listener) };
    },
    onDidTitleChange: (listener: (event: { title: string }) => void) => {
      titleListeners.add(listener);
      return { dispose: () => titleListeners.delete(listener) };
    },
  };
  return {
    props: {
      api,
      containerApi: {},
      params: initialParams,
      tabLocation: 'header',
    } as unknown as IDockviewPanelHeaderProps,
    api,
  };
}

function renderTab(
  overrides: Partial<React.ComponentProps<typeof WorkspaceTab>> = {},
  locale: 'en' | 'ko' = 'en',
) {
  const { props, api } = fakeProps();
  const requestClose = vi.fn((close: () => void) => close());
  const onSplit = vi.fn();
  const onTitleChanged = vi.fn();
  act(() => root.render(
    <AppI18nProvider locale={locale} languages={[locale]}>
      <WorkspaceTab
        {...props}
        requestClose={requestClose}
        onSplit={onSplit}
        onTitleChanged={onTitleChanged}
        {...overrides}
      />
    </AppI18nProvider>,
  ));
  return { api, requestClose, onSplit, onTitleChanged };
}

function openContextMenu(): HTMLElement {
  const tab = container.querySelector<HTMLElement>('.agent-aware-tab')!;
  act(() => tab.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 30,
  })));
  return document.querySelector<HTMLElement>('[data-testid="workspace-tab-context-menu"]')!;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('input setter unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('WorkspaceTab interactions', () => {
  it('formats Agent history tabs as project and provider', () => {
    expect(agentHistoryTabTitle(' EZTerminal ', 'codex')).toBe('EZTerminal · Codex');
    expect(agentHistoryTabTitle('Project Alpha', 'claude')).toBe('Project Alpha · Claude');
  });

  it('shows a static project and provider identity with the full label in a tooltip', () => {
    const fixture = fakeProps();
    fixture.api.component = 'agent-session';
    fixture.api.setTitle('EZTerminal · Codex');
    renderTab({
      api: fixture.api as unknown as IDockviewPanelHeaderProps['api'],
      params: { historyId: 'codex_opaque', provider: 'codex' },
    });

    const tab = container.querySelector<HTMLElement>('.agent-history-tab')!;
    const viewport = container.querySelector<HTMLElement>('.agent-history-tab__viewport')!;
    expect(tab.dataset.provider).toBe('codex');
    expect(viewport.getAttribute('title')).toBe('EZTerminal · Codex');
    expect(viewport.querySelector('.agent-history-tab__label')?.textContent).toBe('EZTerminal');
    expect(viewport.querySelector('.agent-provider-badge')?.textContent).toBe('Codex');
    expect(viewport.querySelector('.agent-history-tab__label.is-long')).toBeNull();
  });

  it('opens an accessible action menu and splits relative to the invoked panel', () => {
    const { api, onSplit } = renderTab();
    const menu = openContextMenu();
    expect(menu.getAttribute('role')).toBe('menu');
    expect(api.setActive).toHaveBeenCalledTimes(1);

    act(() => document.querySelector<HTMLButtonElement>('[data-testid="tab-ctx-split-right"]')!.click());
    expect(onSplit).toHaveBeenCalledWith('tab-3', 'right');
  });

  it('announces the rename shortcut in Korean', () => {
    renderTab({}, 'ko');
    const menu = openContextMenu();

    expect(menu.getAttribute('aria-label')).toBe('탭 작업');
    expect(menu.querySelector('kbd')?.getAttribute('aria-label')).toBe('단축키 F2');
  });

  it('renames with F2/Enter and routes persistence through the caller', () => {
    const { api, onTitleChanged } = renderTab();
    const tab = container.querySelector<HTMLElement>('[data-testid="dockview-dv-default-tab"]')!;
    act(() => tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    const input = container.querySelector<HTMLInputElement>('[data-testid="workspace-tab-rename"]')!;
    act(() => setInputValue(input, '  Build logs  '));
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

    expect(api.setTitle).toHaveBeenCalledWith('Build logs');
    expect(onTitleChanged).toHaveBeenCalledWith('Build logs');
    expect(container.querySelector('[data-testid="workspace-tab-rename"]')).toBeNull();
  });

  it('restores the generated title for a blank rename and cancels on Escape', () => {
    const { api } = renderTab();
    act(() => container.querySelector<HTMLElement>('.agent-aware-tab')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
    ));
    let input = container.querySelector<HTMLInputElement>('[data-testid="workspace-tab-rename"]')!;
    act(() => setInputValue(input, '   '));
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(api.setTitle).toHaveBeenCalledWith('Terminal 3');

    act(() => container.querySelector<HTMLElement>('.agent-aware-tab')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
    ));
    input = container.querySelector<HTMLInputElement>('[data-testid="workspace-tab-rename"]')!;
    act(() => setInputValue(input, 'Do not save'));
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(api.setTitle).not.toHaveBeenCalledWith('Do not save');
  });

  it('keeps close behind the supplied risky-close guard', () => {
    const { api, requestClose } = renderTab();
    openContextMenu();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="tab-ctx-close"]')!.click());
    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  it('shows project identity with a live provider badge and persists custom/generated title mode', () => {
    const projectSession = {
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'worktree-1',
      projectName: 'EZTerminal',
      titleMode: 'generated' as const,
    };
    const fixture = fakeProps({ projectSession });
    fixture.api.setTitle('EZTerminal');
    renderTab({
      api: fixture.api as unknown as IDockviewPanelHeaderProps['api'],
      params: { projectSession },
      status: 'working',
      provider: 'generic',
      providerLabel: 'Aider',
    });

    expect(container.querySelector('.project-session-tab__label')?.textContent).toBe('EZTerminal');
    expect(container.querySelector('.project-session-tab__badge')?.textContent).toBe('Aider');

    act(() => container.querySelector<HTMLElement>('.agent-aware-tab')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
    ));
    let input = container.querySelector<HTMLInputElement>('[data-testid="workspace-tab-rename"]')!;
    act(() => setInputValue(input, 'Build shell'));
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(fixture.api.updateParameters).toHaveBeenLastCalledWith({
      projectSession: { ...projectSession, titleMode: 'custom' },
    });

    act(() => container.querySelector<HTMLElement>('.agent-aware-tab')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
    ));
    input = container.querySelector<HTMLInputElement>('[data-testid="workspace-tab-rename"]')!;
    act(() => setInputValue(input, '   '));
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(fixture.api.updateParameters).toHaveBeenLastCalledWith({
      projectSession: { ...projectSession, titleMode: 'generated' },
    });
  });

  it('restores project identity from renderer params and synchronizes Dockview parameters', () => {
    const projectSession = {
      projectId: 'project-1',
      projectName: 'EZTerminal',
      titleMode: 'generated' as const,
    };
    const fixture = fakeProps();
    fixture.api.setTitle('EZTerminal');
    renderTab({
      api: fixture.api as unknown as IDockviewPanelHeaderProps['api'],
      params: { projectSession },
    });

    expect(container.querySelector('.project-session-tab__label')?.textContent).toBe('EZTerminal');
    expect(container.querySelector('.project-session-tab__badge')?.textContent).toBe('Terminal');
    expect(fixture.api.updateParameters).toHaveBeenCalledWith({ projectSession });
  });

  it('falls back to a Terminal badge after an agent ends', () => {
    const projectSession = {
      projectId: 'project-1',
      projectName: 'EZTerminal',
      titleMode: 'generated' as const,
    };
    const fixture = fakeProps({ projectSession });
    renderTab({
      api: fixture.api as unknown as IDockviewPanelHeaderProps['api'],
      params: { projectSession },
      status: 'error',
      provider: 'claude',
      providerLabel: 'Claude',
    });

    expect(container.querySelector('.project-session-tab__badge')?.textContent).toBe('Terminal');
    expect(container.querySelector('.project-session-tab')?.getAttribute('data-provider')).toBeNull();
  });

});
