// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EzTerminalApi, EzTerminalDesktopApi } from '../shared/ipc';
import { useDesktopAppearance } from './useDesktopAppearance';
import { useTerminalPreferences } from './useTerminalPreferences';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalApi = window.ezterminal;
const originalDesktop = window.ezterminalDesktop;

function setApi(value: EzTerminalApi) {
  Object.defineProperty(window, 'ezterminal', { configurable: true, value });
}

function setDesktop(value: EzTerminalDesktopApi | undefined) {
  Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  setApi(originalApi);
  setDesktop(originalDesktop);
  delete document.documentElement.dataset.theme;
});

function mount(component: JSX.Element) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(component));
}

describe('desktop preference ownership', () => {
  it('keeps a user theme/scale choice when the persisted startup values arrive later', async () => {
    const mods = deferred<[]>();
    const scale = deferred<number>();
    const getTheme = vi.fn(async () => 'matrix');
    setApi({
      getTheme,
      setTheme: vi.fn(async () => undefined),
      getUiScale: () => scale.promise,
      setUiScale: vi.fn(async () => undefined),
      getScrollback: async () => 10_000,
    } as unknown as EzTerminalApi);
    setDesktop({
      getAvailableThemes: () => mods.promise,
      getFont: async () => undefined,
      getEffectToggles: async () => ({}),
      getRollbar: async () => undefined,
      getEffectParams: async () => undefined,
    } as unknown as EzTerminalDesktopApi);
    let state!: ReturnType<typeof useDesktopAppearance>;
    const t = ((key: string) => key) as TFunction;
    function Harness() {
      state = useDesktopAppearance({ t });
      return <span>{state.theme}:{state.uiScale}</span>;
    }
    mount(<Harness />);
    expect(getTheme).not.toHaveBeenCalled();
    act(() => {
      state.selectTheme('dark');
      state.changeUiScale(120);
    });
    await act(async () => {
      mods.resolve([]);
      scale.resolve(100);
    });
    expect(getTheme).toHaveBeenCalledOnce();
    expect(host!.textContent).toBe('dark:120');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.ezterminal.setTheme).toHaveBeenCalledWith('dark');
  });

  it('allows only one pending paste confirmation and settles it on unmount', async () => {
    setDesktop(undefined);
    let state!: ReturnType<typeof useTerminalPreferences>;
    function Harness() {
      state = useTerminalPreferences();
      return null;
    }
    mount(<Harness />);
    const risk = { multiline: true, large: false, lineCount: 2, byteLength: 4, shouldWarn: true };
    let first!: Promise<boolean>;
    act(() => { first = state.requestPasteConfirmation(risk); });
    await expect(state.requestPasteConfirmation(risk)).resolves.toBe(false);
    expect(state.pendingPasteConfirmation?.ownerDocument).toBe(document);
    act(() => root!.unmount());
    root = undefined;
    await expect(first).resolves.toBe(false);
  });
});
