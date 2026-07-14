import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TerminalAccessorySettings } from './TerminalAccessorySettings';
import { terminalAccessoryLayoutStore } from './terminal-accessory-layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  terminalAccessoryLayoutStore.reload();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<TerminalAccessorySettings />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TerminalAccessorySettings', () => {
  it('hides a built-in key immediately and persists the versioned layout', () => {
    const escape = container.querySelector<HTMLInputElement>('[data-testid="terminal-key-visible-escape"]')!;
    act(() => escape.click());
    expect(terminalAccessoryLayoutStore.getSnapshot().layout.visible).not.toContain('escape');
    expect(JSON.parse(localStorage.getItem('ezterminal-mobile-terminal-accessory-layout') ?? '').version).toBe(1);
  });

  it('supports a non-drag reorder action and reset', () => {
    const tabRow = container.querySelector<HTMLElement>('[data-testid="terminal-key-setting-tab"]')!;
    const moveUp = tabRow.querySelector<HTMLButtonElement>('button[aria-label="Move Tab up"]')!;
    act(() => moveUp.click());
    expect(terminalAccessoryLayoutStore.getSnapshot().layout.order.slice(0, 2)).toEqual(['tab', 'escape']);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="terminal-key-layout-reset"]')!.click());
    expect(terminalAccessoryLayoutStore.getSnapshot().layout.order.slice(0, 2)).toEqual(['escape', 'tab']);
  });
});
