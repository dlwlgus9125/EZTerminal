// @vitest-environment jsdom
//
// No @testing-library/react in this repo (root suite runs `environment: 'node'`
// with no DOM-testing deps installed) — this exercises the component with a
// real React root + native DOM events instead, scoped to jsdom via the pragma
// above so the rest of the suite is unaffected.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isTerminalContextMenuKey,
  mayRestoreTerminalContextMenuFocus,
  TerminalContextMenu,
  type TerminalContextMenuItem,
} from './TerminalContextMenu';

// Silences React's "not configured to support act()" warning for this file's
// synchronous createRoot().render() calls below.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderMenu(items: TerminalContextMenuItem[], onClose: () => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<TerminalContextMenu x={10} y={20} items={items} onClose={onClose} />);
  });
  return container;
}

function press(key: string): void {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('TerminalContextMenu', () => {
  it('renders each item at its data-testid', () => {
    const el = renderMenu(
      [
        { action: 'copy', label: 'Copy', onClick: vi.fn() },
        { action: 'paste', label: 'Paste', onClick: vi.fn() },
      ],
      vi.fn(),
    );
    expect(el.querySelector('[data-testid="term-ctx-copy"]')?.textContent).toBe('Copy');
    expect(el.querySelector('[data-testid="term-ctx-paste"]')?.textContent).toBe('Paste');
    expect(el.querySelector('[role="menu"]')).not.toBeNull();
    expect(el.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
  });

  it('focuses the first enabled item and roves with wraparound while skipping disabled items', () => {
    const el = renderMenu(
      [
        { action: 'copy', label: 'Copy', disabled: true, onClick: vi.fn() },
        { action: 'paste', label: 'Paste', onClick: vi.fn() },
        { action: 'find', label: 'Find', onClick: vi.fn() },
      ],
      vi.fn(),
    );
    const paste = el.querySelector<HTMLButtonElement>('[data-testid="term-ctx-paste"]')!;
    const find = el.querySelector<HTMLButtonElement>('[data-testid="term-ctx-find"]')!;

    expect(document.activeElement).toBe(paste);
    expect(paste.tabIndex).toBe(0);
    expect(find.tabIndex).toBe(-1);

    press('ArrowDown');
    expect(document.activeElement).toBe(find);
    press('ArrowDown');
    expect(document.activeElement).toBe(paste);
    press('ArrowUp');
    expect(document.activeElement).toBe(find);
    press('Home');
    expect(document.activeElement).toBe(paste);
    press('End');
    expect(document.activeElement).toBe(find);
  });

  it('activates the roving item with Enter or Space', () => {
    const onEnter = vi.fn();
    const closeEnter = vi.fn();
    renderMenu([{ action: 'copy', label: 'Copy', onClick: onEnter }], closeEnter);
    press('Enter');
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(closeEnter).toHaveBeenCalledWith(expect.objectContaining({ reason: 'action' }));

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;

    const onSpace = vi.fn();
    const closeSpace = vi.fn();
    renderMenu([{ action: 'paste', label: 'Paste', onClick: onSpace }], closeSpace);
    press(' ');
    expect(onSpace).toHaveBeenCalledTimes(1);
    expect(closeSpace).toHaveBeenCalledWith(expect.objectContaining({ reason: 'action' }));
  });

  it('disables an item and suppresses its onClick when `disabled` is set', () => {
    const onClick = vi.fn();
    const el = renderMenu([{ action: 'copy', label: 'Copy', disabled: true, onClick }], vi.fn());
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="term-ctx-copy"]')!;
    expect(btn.disabled).toBe(true);
    act(() => btn.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires onClick then onClose when an enabled item is picked', () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const el = renderMenu([{ action: 'copy', label: 'Copy', onClick }], onClose);
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="term-ctx-copy"]')!;
    act(() => btn.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderMenu([{ action: 'copy', label: 'Copy', onClick: vi.fn() }], onClose);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: 'escape' }));
  });

  it('closes on an outside mousedown', () => {
    const onClose = vi.fn();
    renderMenu([{ action: 'copy', label: 'Copy', onClick: vi.fn() }], onClose);
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: 'outside' }));
  });

  it('does NOT close on a mousedown inside the menu', () => {
    const onClose = vi.fn();
    const el = renderMenu([{ action: 'copy', label: 'Copy', onClick: vi.fn() }], onClose);
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="term-ctx-copy"]')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('terminal context-menu invocation and focus policy', () => {
  it('recognizes Shift+F10 and the ContextMenu key only', () => {
    expect(isTerminalContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isTerminalContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isTerminalContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    expect(isTerminalContextMenuKey({ key: 'F9', shiftKey: true })).toBe(false);
  });

  it('allows restoration in the origin pane but never after an outside action targets another pane', () => {
    const first = document.createElement('section');
    first.className = 'pane';
    const menuItem = document.createElement('button');
    first.append(menuItem);
    const second = document.createElement('section');
    second.className = 'pane';
    const otherInput = document.createElement('input');
    second.append(otherInput);
    document.body.append(first, second);

    expect(mayRestoreTerminalContextMenuFocus(
      first,
      { reason: 'escape', target: menuItem },
      menuItem,
    )).toBe(true);
    expect(mayRestoreTerminalContextMenuFocus(
      first,
      { reason: 'outside', target: otherInput },
      menuItem,
    )).toBe(false);
    expect(mayRestoreTerminalContextMenuFocus(
      first,
      { reason: 'escape', target: menuItem },
      otherInput,
    )).toBe(false);
  });
});
