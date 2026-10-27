// @vitest-environment jsdom

import { act, useEffect, useId, useState } from 'react';
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

import { Menu, MenuItem, Popover } from '../../src/renderer/ui';
import { MobileWorkbenchCoordinator } from './MobileWorkbenchCoordinator';
import { MobileNavigationHistoryProvider, useMobileNavigationHistory } from './MobileNavigationHistory';

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
        onRequestRoot={vi.fn()}
      />,
    );
    await Promise.resolve();
  });
}

describe('MobileNavigationHistory native Android Back', () => {
  it('leaves open a menu that the newly opened page holds itself', async () => {
    await renderCoordinator();
    await act(async () => {
      root.render(
        <MobileWorkbenchCoordinator
          terminal={<div>terminal</div>}
          page={<Menu label="Sheet menu" defaultOpen trigger={<button type="button">Sheet menu</button>}><MenuItem onSelect={() => undefined}>Inside</MenuItem></Menu>}
          onRequestRoot={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('closes an open popover like Escape, focus back on its button', async () => {
    await renderCoordinator(
      <Popover ariaLabel="Usage" trigger={<button type="button">Usage</button>}>
        <button type="button">Details</button>
      </Popover>,
    );
    const trigger = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Usage')!;
    act(() => trigger.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => [...nativeApp.listeners][0]({ canGoBack: false }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes the menus of a screen a new page covers, so Back closes the page on top', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const menu = (
      <Menu label="Conversation" trigger={<button type="button">More</button>}>
        <MenuItem onSelect={() => undefined}>Previous conversations</MenuItem>
      </Menu>
    );
    await act(async () => {
      root.render(<MobileWorkbenchCoordinator terminal={<div>{menu}</div>} onRequestRoot={vi.fn()} />);
      await Promise.resolve();
    });
    act(() => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'More')!.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => {
      root.render(<MobileWorkbenchCoordinator terminal={<div>{menu}</div>} page={<div>review</div>} onRequestRoot={vi.fn()} />);
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => [...nativeApp.listeners][0]({ canGoBack: false }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('closes an open menu first and keeps the page under it', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await renderCoordinator(
      <Menu label="Conversation" trigger={<button type="button">More</button>}>
        <MenuItem onSelect={() => undefined}>Previous conversations</MenuItem>
      </Menu>,
    );
    const trigger = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'More')!;
    act(() => trigger.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => [...nativeApp.listeners][0]({ canGoBack: false }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(back).not.toHaveBeenCalled();
    // The next Back leaves the page as usual.
    act(() => [...nativeApp.listeners][0]({ canGoBack: false }));
    expect(back).toHaveBeenCalledTimes(1);
  });

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
  it("registers the shell's stop below a project opened from the feed, so closing the project keeps it (I4)", async () => {
    function ProjectLayer(): JSX.Element {
      const navigation = useMobileNavigationHistory();
      const id = useId();
      useEffect(() => navigation.pushLayer({ id: `project-${id}`, kind: 'page', onBack: () => undefined }), [id, navigation]);
      return <div>project</div>;
    }
    const entries: string[] = [];
    const push = window.history.pushState.bind(window.history);
    vi.spyOn(window.history, 'pushState').mockImplementation((state, unused, url) => {
      entries.push(String((state as { ezterminalNavigation?: { layerId?: string } } | null)?.ezterminalNavigation?.layerId));
      push(state, unused, url);
    });
    // One commit opens both: the feed's project screen (the shell's stop) and the project inside it.
    await act(async () => {
      root.render(
        <MobileWorkbenchCoordinator terminal={<div>terminal</div>} page={<ProjectLayer />} terminalActive={false}
          destinationActive={false} tabRootActive onRequestTabRoot={vi.fn()} />,
      );
      await Promise.resolve();
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatch(/^mobile-tab-/);
    expect(entries[1]).toMatch(/^project-/);
  });
  it('also consumes the entry of a layer released while a close was being traversed (I4)', async () => {
    function Layer({ id, onBack }: { readonly id: string; readonly onBack: () => void }): null {
      const navigation = useMobileNavigationHistory();
      useEffect(() => navigation.pushLayer({ id, kind: 'page', onBack }), [id, navigation, onBack]);
      return null;
    }
    function Close(): JSX.Element {
      const navigation = useMobileNavigationHistory();
      return <button type="button" data-testid="close" onClick={() => navigation.closeLayer('detail', 'ui')}>close</button>;
    }
    // A conversation opened from the feed: the shell's stop and the conversation's own; leaving the
    // conversation also returns the shell to the feed, which releases its stop in the same moment.
    function Harness(): JSX.Element {
      const [open, setOpen] = useState(true);
      const leave = (): void => setOpen(false);
      return <>{open && <Layer id="shell" onBack={leave} />}{open && <Layer id="detail" onBack={leave} />}<Close /></>;
    }
    const states: unknown[] = [];
    const push = window.history.pushState.bind(window.history);
    vi.spyOn(window.history, 'pushState').mockImplementation((state, unused, url) => { states.push(state); push(state, unused, url); });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    await act(async () => {
      root.render(<MobileNavigationHistoryProvider><Harness /></MobileNavigationHistoryProvider>);
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="close"]')!.click();
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    expect(back).toHaveBeenCalledTimes(1);
    // The browser lands on the shell's entry, whose layer is gone: it is consumed as well.
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate', { state: states[0] })); });
    expect(back).toHaveBeenCalledTimes(2);
  });
  it('keeps the sub-page a project opened when that project unmounts under it (I4)', async () => {
    function Layer({ id }: { readonly id: string }): null {
      const navigation = useMobileNavigationHistory();
      useEffect(() => navigation.pushLayer({ id, kind: 'page', onBack: () => undefined }), [id, navigation]);
      return null;
    }
    const pushed: string[] = [];
    const states: Record<string, unknown> = {};
    const push = window.history.pushState.bind(window.history);
    vi.spyOn(window.history, 'pushState').mockImplementation((state, unused, url) => {
      const id = String((state as { ezterminalNavigation?: { layerId?: string } } | null)?.ezterminalNavigation?.layerId);
      pushed.push(id);
      states[id] = state;
      push(state, unused, url);
    });
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const show = async (layers: readonly string[]): Promise<void> => {
      await act(async () => {
        root.render(<MobileNavigationHistoryProvider>{layers.map((id) => <Layer key={id} id={id} />)}</MobileNavigationHistoryProvider>);
        for (let index = 0; index < 5; index += 1) await Promise.resolve();
      });
    };
    await show(['shell', 'project']);
    await show(['shell', 'project', 'files']);
    // The project screen gives way to Files: only its own layer goes.
    await show(['shell', 'files']);
    expect(go).toHaveBeenCalledWith(-2);
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate', { state: states.shell })); });
    expect(pushed).toEqual(['shell', 'project', 'files', 'files']);
  });
});
