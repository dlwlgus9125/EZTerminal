// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteDeviceEntry } from '../../shared/ipc';
import { AppI18nProvider } from '../i18n';
import { RemoteDeviceRoster } from './RemoteDeviceRoster';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(
  desktopApi?: { readonly listRemoteDevices: () => Promise<readonly RemoteDeviceEntry[]> },
): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <RemoteDeviceRoster desktopApi={desktopApi} />
      </AppI18nProvider>,
    );
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

describe('RemoteDeviceRoster', () => {
  it('distinguishes a missing IPC boundary from a genuine empty roster', async () => {
    await render(undefined);
    expect(host!.querySelector('[data-testid="remote-device-unavailable"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="remote-device-empty"]')).toBeNull();
  });

  it('shows unavailable when a live roster read fails', async () => {
    const read = deferred<readonly RemoteDeviceEntry[]>();
    await render({ listRemoteDevices: () => read.promise });
    expect(host!.querySelector('[data-testid="remote-device-loading"]')).not.toBeNull();

    await act(async () => {
      read.reject(new Error('IPC unavailable'));
      await read.promise.catch(() => undefined);
    });
    expect(host!.querySelector('[data-testid="remote-device-unavailable"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="remote-device-empty"]')).toBeNull();
  });

  it('keeps polling single-flight so an older read cannot overwrite a newer roster', async () => {
    vi.useFakeTimers();
    const first = deferred<readonly RemoteDeviceEntry[]>();
    const listRemoteDevices = vi.fn(() => first.promise);
    await render({ listRemoteDevices });
    expect(listRemoteDevices).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(listRemoteDevices).toHaveBeenCalledOnce();

    await act(async () => {
      first.resolve([]);
      await first.promise;
    });
    expect(host!.querySelector('[data-testid="remote-device-empty"]')).not.toBeNull();
  });
});
