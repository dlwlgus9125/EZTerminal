// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDockviewPanelHeaderProps } from 'dockview-react';

import { WorkspaceTab } from './WorkspaceTab';

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

function fakeProps() {
  const titleListeners = new Set<(event: { title: string }) => void>();
  let title = 'Terminal 3';
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
    onDidTitleChange: (listener: (event: { title: string }) => void) => {
      titleListeners.add(listener);
      return { dispose: () => titleListeners.delete(listener) };
    },
  };
  return {
    props: {
      api,
      containerApi: {},
      params: {},
      tabLocation: 'header',
    } as unknown as IDockviewPanelHeaderProps,
    api,
  };
}

function renderTab(overrides: Partial<React.ComponentProps<typeof WorkspaceTab>> = {}) {
  const { props, api } = fakeProps();
  const requestClose = vi.fn((close: () => void) => close());
  const onSplit = vi.fn();
  const onTitleChanged = vi.fn();
  act(() => root.render(
    <WorkspaceTab
      {...props}
      requestClose={requestClose}
      onSplit={onSplit}
      onTitleChanged={onTitleChanged}
      {...overrides}
    />,
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
  it('opens an accessible action menu and splits relative to the invoked panel', () => {
    const { api, onSplit } = renderTab();
    const menu = openContextMenu();
    expect(menu.getAttribute('role')).toBe('menu');
    expect(api.setActive).toHaveBeenCalledTimes(1);

    act(() => document.querySelector<HTMLButtonElement>('[data-testid="tab-ctx-split-right"]')!.click());
    expect(onSplit).toHaveBeenCalledWith('tab-3', 'right');
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
});
