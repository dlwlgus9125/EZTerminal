import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalApi } from '../../src/shared/ipc';
import { MobileStatsView } from './MobileStatsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.clear();
  Object.defineProperty(window, 'ezterminal', {
    configurable: true,
    value: {
      setStatsPanelVisible: vi.fn(),
      getStatsHistory: vi.fn(async () => []),
      onStatsUpdate: vi.fn(() => () => undefined),
    } as unknown as EzTerminalApi,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MobileStatsView onClose={vi.fn()} />);
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'ezterminal');
});

describe('MobileStatsView tabs', () => {
  it('exposes selected state, tabpanel relationships, and roving focus', () => {
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const panels = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')];

    expect(tabs).toHaveLength(3);
    expect(panels).toHaveLength(3);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]?.tabIndex).toBe(0);
    expect(tabs[1]?.tabIndex).toBe(-1);
    expect(document.getElementById(tabs[0]!.getAttribute('aria-controls')!)).toBe(panels[0]);

    tabs[0]!.focus();
    act(() => tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));

    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(panels[0]?.hidden).toBe(true);
    expect(panels[1]?.hidden).toBe(false);
  });
});
