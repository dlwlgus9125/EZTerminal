// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeApp = vi.hoisted(() => {
  const listeners = new Set<(event: { readonly canGoBack: boolean }) => void>();
  const exitApp = vi.fn(async () => undefined);
  const addListener = vi.fn(async (
    _event: string,
    listener: (event: { readonly canGoBack: boolean }) => void,
  ) => {
    listeners.add(listener);
    return {
      remove: vi.fn(async () => {
        listeners.delete(listener);
      }),
    };
  });
  return { addListener, exitApp, listeners };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: nativeApp.addListener, exitApp: nativeApp.exitApp },
}));

import { MobileWorkbenchCoordinator } from './MobileWorkbenchCoordinator';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.history.replaceState({}, '');
  nativeApp.listeners.clear();
  nativeApp.addListener.mockClear();
  nativeApp.exitApp.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState({}, '');
  vi.restoreAllMocks();
});

async function renderCoordinator(page?: JSX.Element): Promise<void> {
  await act(async () => {
    root.render(
      <MobileWorkbenchCoordinator
        terminal={<div>terminal</div>}
        page={page}
        onRequestTerminal={vi.fn()}
      />,
    );
    await Promise.resolve();
  });
}

describe('MobileNavigationHistory native Android Back', () => {
  it('traverses the owned page entry instead of exiting the Activity', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await renderCoordinator(<div>sessions</div>);

    expect(nativeApp.listeners.size).toBe(1);
    act(() => [...nativeApp.listeners][0]({ canGoBack: false }));

    expect(back).toHaveBeenCalledTimes(1);
    expect(nativeApp.exitApp).not.toHaveBeenCalled();
  });

  it('exits only when no mobile navigation layer is active', async () => {
    await renderCoordinator();

    expect(nativeApp.listeners.size).toBe(1);
    act(() => [...nativeApp.listeners][0]({ canGoBack: false }));

    expect(nativeApp.exitApp).toHaveBeenCalledTimes(1);
  });

  it('traverses browser history instead of exiting when no layer is active but WebView can go back', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await renderCoordinator();

    expect(nativeApp.listeners.size).toBe(1);
    act(() => [...nativeApp.listeners][0]({ canGoBack: true }));

    expect(back).toHaveBeenCalledTimes(1);
    expect(nativeApp.exitApp).not.toHaveBeenCalled();
  });
});
