import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlockController, BlockSnapshot } from '../../src/renderer/block-controller';
import { TouchInputBar } from './TouchInputBar';
import {
  ACTIVE_MOBILE_TAB_CHANGE_EVENT,
  defaultTerminalAccessoryLayout,
  terminalAccessoryLayoutStore,
} from './terminal-accessory-layout';
import { TERMINAL_KEY_REPEAT_DELAY_MS } from './terminal-key-repeat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeController(hasControl = true): { controller: BlockController; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const snapshot = {
    status: 'running',
    shape: 'pty',
    hasControl,
  } as BlockSnapshot;
  return {
    controller: {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      sendPtyInput: send,
    } as unknown as BlockController,
    send,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  terminalAccessoryLayoutStore.reload();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('TouchInputBar', () => {
  it('renders the original eight keys plus a persistent Manage action', () => {
    const { controller } = makeController();
    act(() => root.render(<TouchInputBar controller={controller} />));
    expect(container.querySelectorAll('.touch-key')).toHaveLength(9);
    expect(container.querySelector('[data-testid="touch-key-escape"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="touch-key-manage"]')).toBeTruthy();
  });

  it('cancels a held repeat when the active mobile tab changes', () => {
    const { controller, send } = makeController();
    act(() => root.render(<TouchInputBar controller={controller} />));
    const up = container.querySelector<HTMLButtonElement>('[data-testid="touch-key-arrow-up"]')!;
    act(() => up.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event(ACTIVE_MOBILE_TAB_CHANGE_EVENT)));
    act(() => vi.advanceTimersByTime(TERMINAL_KEY_REPEAT_DELAY_MS * 2));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends one byte sequence for keyboard or assistive-tech button activation', () => {
    const layout = defaultTerminalAccessoryLayout();
    terminalAccessoryLayoutStore.setLayout({ ...layout, visible: [...layout.visible, 'ctrl-r'] });
    const { controller, send } = makeController();
    act(() => root.render(<TouchInputBar controller={controller} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="touch-key-ctrl-r"]')!.click());
    expect(send).toHaveBeenCalledWith('\x12');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('disables terminal bytes while view-only but keeps Manage available', () => {
    const { controller } = makeController(false);
    act(() => root.render(<TouchInputBar controller={controller} />));
    expect(container.querySelector<HTMLButtonElement>('[data-testid="touch-key-escape"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="touch-key-manage"]')?.disabled).toBe(false);
  });

  it('keeps an empty-state Manage action when every key is hidden', () => {
    terminalAccessoryLayoutStore.setLayout({ ...defaultTerminalAccessoryLayout(), visible: [] });
    const { controller } = makeController();
    act(() => root.render(<TouchInputBar controller={controller} />));
    expect(container.querySelector('[data-testid="touch-input-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="touch-key-manage"]')).toBeTruthy();
  });
});
