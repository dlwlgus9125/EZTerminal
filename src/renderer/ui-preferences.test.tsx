// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalDesktopApi } from '../shared/ipc';
import { DEFAULT_UI_PREFERENCES, type UiPreferences } from '../shared/ui-preferences';
import { DesktopUiPreferencesProvider, useUiPreferences } from './ui-preferences';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let context!: ReturnType<typeof useUiPreferences>;

function Probe(): JSX.Element {
  context = useUiPreferences();
  return <output data-testid="preferences">{JSON.stringify(context.preferences)}</output>;
}

async function renderProvider(api: EzTerminalDesktopApi): Promise<void> {
  Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value: api });
  await act(async () => {
    root.render(<DesktopUiPreferencesProvider><Probe /></DesktopUiPreferencesProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(context.ready).toBe(true);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('DesktopUiPreferencesProvider write serialization', () => {
  it('finishes initial loading without overwriting a local change made first', async () => {
    const initialLoad = deferred<UiPreferences>();
    const api = {
      getUiPreferences: vi.fn(() => initialLoad.promise),
      setUiPreferences: vi.fn(async (patch: Partial<UiPreferences>) => ({
        ...DEFAULT_UI_PREFERENCES,
        ...patch,
      })),
    } as unknown as EzTerminalDesktopApi;
    Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value: api });
    act(() => {
      root.render(<DesktopUiPreferencesProvider><Probe /></DesktopUiPreferencesProvider>);
    });

    let update!: Promise<void>;
    act(() => { update = context.updatePreferences({ locale: 'ko' }); });
    initialLoad.resolve({ ...DEFAULT_UI_PREFERENCES });
    await act(async () => { await update; });

    expect(context.ready).toBe(true);
    expect(context.preferences.locale).toBe('ko');
  });

  it('does not let an earlier response erase a newer queued field change', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let persisted: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
    let callCount = 0;
    const setUiPreferences = vi.fn(async (patch: Partial<UiPreferences>): Promise<UiPreferences> => {
      callCount += 1;
      if (callCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      persisted = { ...persisted, ...patch };
      return { ...persisted };
    });
    const api = {
      getUiPreferences: vi.fn(async () => ({ ...persisted })),
      setUiPreferences,
    } as unknown as EzTerminalDesktopApi;
    await renderProvider(api);

    let first!: Promise<void>;
    act(() => { first = context.updatePreferences({ locale: 'ko' }); });
    await firstStarted.promise;

    let second!: Promise<void>;
    act(() => { second = context.updatePreferences({ density: 'compact' }); });
    releaseFirst.resolve();
    await act(async () => { await Promise.all([first, second]); });

    expect(setUiPreferences).toHaveBeenNthCalledWith(1, { locale: 'ko' });
    expect(setUiPreferences).toHaveBeenNthCalledWith(2, { density: 'compact' });
    expect(context.preferences).toEqual({ locale: 'ko', density: 'compact', sidebarWidth: 320 });
  });

  it('runs a later write after one IPC write rejects', async () => {
    let persisted: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
    const setUiPreferences = vi.fn(async (patch: Partial<UiPreferences>): Promise<UiPreferences> => {
      if (setUiPreferences.mock.calls.length === 1) throw new Error('transient IPC failure');
      persisted = { ...persisted, ...patch };
      return { ...persisted };
    });
    const api = {
      getUiPreferences: vi.fn(async () => ({ ...persisted })),
      setUiPreferences,
    } as unknown as EzTerminalDesktopApi;
    await renderProvider(api);

    let first!: Promise<void>;
    act(() => { first = context.updatePreferences({ locale: 'ko' }); });
    await act(async () => { await expect(first).rejects.toThrow('transient IPC failure'); });

    let second!: Promise<void>;
    act(() => { second = context.updatePreferences({ density: 'comfortable' }); });
    await act(async () => { await expect(second).resolves.toBeUndefined(); });

    expect(setUiPreferences).toHaveBeenCalledTimes(2);
    expect(context.preferences.density).toBe('comfortable');
  });

  it('asks main to refresh a system-locale native menu after languagechange', async () => {
    const refreshNativeMenuLocale = vi.fn(async () => undefined);
    const api = {
      getUiPreferences: vi.fn(async () => ({ ...DEFAULT_UI_PREFERENCES })),
      setUiPreferences: vi.fn(),
      refreshNativeMenuLocale,
    } as unknown as EzTerminalDesktopApi;
    await renderProvider(api);

    act(() => window.dispatchEvent(new Event('languagechange')));
    await act(async () => { await Promise.resolve(); });

    expect(refreshNativeMenuLocale).toHaveBeenCalledTimes(1);
  });
});
