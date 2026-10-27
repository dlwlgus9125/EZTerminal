import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileToastProvider, useMobileToast, type MobileToastAction } from './MobileToast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let show: ReturnType<typeof useMobileToast>;

function Probe(): null {
  show = useMobileToast();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<MobileToastProvider><Probe /></MobileToastProvider>));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

const toast = (): HTMLElement | null => document.querySelector('[data-testid="mobile-toast"]');

describe('MobileToast', () => {
  it('shows a plain message that takes no touches and goes away by itself', () => {
    act(() => show('Sent'));
    expect(toast()?.textContent).toContain('Sent');
    expect(toast()?.hasAttribute('data-action')).toBe(false);
    expect(document.querySelector('[data-testid="mobile-toast-action"]')).toBeNull();
    act(() => { vi.advanceTimersByTime(2600); });
    expect(toast()).toBeNull();
  });

  it('offers one follow-up that runs once and closes the toast, and stays long enough to reach', () => {
    const action: MobileToastAction = { label: 'Open conversation', onSelect: vi.fn() };
    act(() => show('Sent to “Fix the login”', action));
    expect(toast()?.getAttribute('data-action')).toBe('true');
    act(() => { vi.advanceTimersByTime(2600); });
    const button = document.querySelector<HTMLButtonElement>('[data-testid="mobile-toast-action"]');
    expect(button?.textContent).toBe('Open conversation');
    act(() => button!.click());
    expect(action.onSelect).toHaveBeenCalledOnce();
    expect(toast()).toBeNull();
  });
});
