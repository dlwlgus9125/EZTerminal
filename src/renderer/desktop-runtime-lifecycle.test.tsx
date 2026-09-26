// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopWindowState, DesktopWindowStatesSnapshot } from '../shared/desktop-window';
import { DesktopRuntimeLifecycleProvider } from './desktop-runtime-lifecycle';
import { registerAuxiliaryWindow } from './desktop-window-registry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let mount: HTMLElement;
let accept: (snapshot: DesktopWindowStatesSnapshot) => void;
let initial: (snapshot: DesktopWindowStatesSnapshot) => void;
const unsubscribe = vi.fn();
const cleanups: Array<() => void> = [];

function state(focused: boolean, windowName = 'main'): DesktopWindowState {
  return {
    windowName, kind: windowName === 'main' ? 'main' : 'auxiliary', focused,
    visible: true, minimized: false, maximized: false, fullscreen: false,
    displayId: '1', scaleFactor: 1, sequence: 0,
  };
}

beforeEach(() => {
  unsubscribe.mockClear();
  const pending = new Promise<DesktopWindowStatesSnapshot>((resolve) => { initial = resolve; });
  vi.stubGlobal('ezterminalDesktop', {
    getWindowStates: () => pending,
    onWindowStatesChanged: (listener: typeof accept) => {
      accept = listener;
      return unsubscribe;
    },
  });
  mount = document.createElement('div');
  document.body.appendChild(mount);
  root = createRoot(mount);
  act(() => root.render(<DesktopRuntimeLifecycleProvider><span>workbench</span></DesktopRuntimeLifecycleProvider>));
});

afterEach(() => {
  act(() => root.unmount());
  while (cleanups.length) cleanups.pop()?.();
  mount.remove();
  delete document.documentElement.dataset.runtimeTier;
  delete document.documentElement.dataset.runtimeWindowName;
  vi.unstubAllGlobals();
});

describe('native document lifecycle delivery', () => {
  it('updates animation state in the IPC callback before React commits', () => {
    act(() => {
      accept({ sequence: 2, windows: [state(true)] });
      expect(document.documentElement.dataset.runtimeTier).toBe('active');
      accept({ sequence: 3, windows: [state(false)] });
      expect(document.documentElement.dataset.runtimeTier).toBe('passive');
      accept({ sequence: 4, windows: [state(true)] });
      expect(document.documentElement.dataset.runtimeTier).toBe('active');
    });
  });

  it('does not let a late initial response or duplicate snapshot pause a resumed window', async () => {
    act(() => accept({ sequence: 5, windows: [state(true)] }));
    await act(async () => initial({ sequence: 1, windows: [state(false)] }));
    act(() => accept({ sequence: 5, windows: [state(false)] }));
    expect(document.documentElement.dataset.runtimeTier).toBe('active');
  });

  it('applies the latest native state to a newly registered popout independently of main focus', () => {
    act(() => accept({ sequence: 2, windows: [state(false), state(true, 'popout')] }));
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    cleanups.push(() => frame.remove());
    const auxiliary = frame.contentWindow!;
    auxiliary.name = 'popout';
    cleanups.push(registerAuxiliaryWindow(auxiliary));
    expect(auxiliary.document.documentElement.dataset.runtimeTier).toBe('active');
    expect(document.documentElement.dataset.runtimeTier).toBe('passive');
    act(() => {
      accept({ sequence: 3, windows: [state(true), state(false, 'popout')] });
      expect(auxiliary.document.documentElement.dataset.runtimeTier).toBe('passive');
      expect(document.documentElement.dataset.runtimeTier).toBe('active');
    });
  });

  it('ignores queued notifications after the provider unmounts', () => {
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    accept({ sequence: 4, windows: [state(true)] });
    expect(document.documentElement.dataset.runtimeTier).toBe('passive');
  });
});
