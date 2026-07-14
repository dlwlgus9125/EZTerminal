import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeMenu } from './ThemeMenu';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)} data-testid="theme-trigger">
        Theme
      </button>
      <ThemeMenu
        open={open}
        current="matrix"
        onSelect={vi.fn()}
        onClose={() => setOpen(false)}
        returnFocusRef={triggerRef}
      />
    </>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState({}, '');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(
    <MobileNavigationHistoryProvider>
      <Harness />
    </MobileNavigationHistoryProvider>,
  ));
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="theme-trigger"]')!.click());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState({}, '');
});

describe('ThemeMenu action sheet', () => {
  it('exposes modal semantics and the selected theme state', () => {
    const sheet = host.querySelector<HTMLElement>('[data-testid="theme-menu"]');
    const selected = host.querySelector<HTMLButtonElement>('[data-testid="theme-option-matrix"]');

    expect(sheet?.getAttribute('role')).toBe('dialog');
    expect(sheet?.getAttribute('aria-modal')).toBe('true');
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(host.querySelector('[data-testid^="theme-option-"]'));
  });

  it('uses Android Back to close and return focus to its trigger', async () => {
    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(host.querySelector('[data-testid="theme-menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="theme-trigger"]'));
  });
});
