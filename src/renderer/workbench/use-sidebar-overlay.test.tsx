// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SIDEBAR_REFLOW_QUERY, useSidebarReflow } from './use-sidebar-overlay';

let root: Root;
let host: HTMLDivElement;
let matches = false;
let listener: (() => void) | undefined;

function Probe(): JSX.Element {
  const reflow = useSidebarReflow();
  return <output data-testid="value">{String(reflow)}</output>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    get matches() { return matches; },
    media: query,
    onchange: null,
    addEventListener: (_type: string, next: () => void) => { listener = next; },
    removeEventListener: (_type: string, next: () => void) => {
      if (listener === next) listener = undefined;
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  matches = false;
  listener = undefined;
});

describe('useSidebarReflow', () => {
  it('uses the normative 1200px breakpoint and follows media changes', () => {
    act(() => root.render(<Probe />));
    expect(window.matchMedia).toHaveBeenCalledWith(SIDEBAR_REFLOW_QUERY);
    expect(host.textContent).toBe('false');

    matches = true;
    act(() => listener?.());
    expect(host.textContent).toBe('true');
  });
});
