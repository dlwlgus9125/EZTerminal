// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileContextMenu } from './FileContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const firstAction = vi.fn();
const secondAction = vi.fn();
const thirdAction = vi.fn();

function press(target: EventTarget, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      shiftKey,
    }));
  });
}

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>Open menu</button>
      {open && (
        <FileContextMenu
          x={20}
          y={30}
          items={[
            { action: 'first', label: 'First', onSelect: firstAction },
            { action: 'second', label: 'Second', onSelect: secondAction },
            { action: 'third', label: 'Third', onSelect: thirdAction },
          ]}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function openMenu(): { opener: HTMLButtonElement; menu: HTMLElement; items: NodeListOf<HTMLButtonElement> } {
  const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
  opener.focus();
  act(() => opener.click());
  return {
    opener,
    menu: container.querySelector<HTMLElement>('[data-testid="file-context-menu"]')!,
    items: container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  firstAction.mockReset();
  secondAction.mockReset();
  thirdAction.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('FileContextMenu accessibility', () => {
  it('exposes menu semantics and focuses the first item when opened', () => {
    const { menu, items } = openMenu();

    expect(menu.getAttribute('role')).toBe('menu');
    expect(items).toHaveLength(3);
    expect([...items].every((item) => item.tabIndex === -1)).toBe(true);
    expect(document.activeElement).toBe(items[0]);
  });

  it('wraps Arrow navigation and supports Home and End', () => {
    const { items } = openMenu();

    press(items[0], 'ArrowUp');
    expect(document.activeElement).toBe(items[2]);
    press(items[2], 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    press(items[0], 'End');
    expect(document.activeElement).toBe(items[2]);
    press(items[2], 'Home');
    expect(document.activeElement).toBe(items[0]);
  });

  it('activates the focused item with Space and closes the menu', () => {
    const { items } = openMenu();
    press(items[0], 'ArrowDown');
    press(items[1], ' ');

    expect(secondAction).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('closes with Escape and restores focus to the opener', () => {
    const { opener, items } = openMenu();
    press(items[0], 'Escape');

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
