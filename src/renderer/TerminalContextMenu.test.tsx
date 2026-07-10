// @vitest-environment jsdom
//
// No @testing-library/react in this repo (root suite runs `environment: 'node'`
// with no DOM-testing deps installed) — this exercises the component with a
// real React root + native DOM events instead, scoped to jsdom via the pragma
// above so the rest of the suite is unaffected.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalContextMenu, type TerminalContextMenuItem } from './TerminalContextMenu';

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
  });

  it('closes on an outside mousedown', () => {
    const onClose = vi.fn();
    renderMenu([{ action: 'copy', label: 'Copy', onClick: vi.fn() }], onClose);
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
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
