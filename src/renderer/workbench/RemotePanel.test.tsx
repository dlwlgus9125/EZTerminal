// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteRuntimeStatus } from '../../shared/ipc';
import type { PairingCode } from '../../shared/pairing';
import {
  rendererCapabilities,
  type CapabilityAccess,
  type RemotePairingObserver,
} from '../capability-access';
import { AppI18nProvider } from '../i18n';
import { RemotePanel, type RemotePanelDesktopApi } from './RemotePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function capabilities(): CapabilityAccess {
  return {
    ...rendererCapabilities,
    snapshot: () => ({ core: 'available', desktop: 'available' }),
    remoteDesktop: {
      observe: (listener) => {
        listener({
          state: 'idle',
          service: 'ready',
          controllerName: null,
          connectedAt: null,
          localAddress: null,
          peerAddress: null,
          framesPerSecond: null,
          roundTripTimeMs: null,
          bitrateKbps: null,
          qualityTier: null,
          errorCode: null,
        });
        return () => undefined;
      },
      disconnect: async () => true,
    },
    remotePairing: {
      observe: (observer) => {
        observer.onConnectionInfo({ urls: ['ws://100.86.12.4:8765'], port: 8_765 });
        observer.onSecurity({ state: 'ready', error: null });
        observer.onToken('fixture-token');
        observer.onRuntime({
          desiredEnabled: true,
          state: 'running',
          port: 8_765,
          errorCode: null,
          error: null,
        });
        return () => undefined;
      },
      rotateToken: async () => 'fixture-token',
    },
    sshForwards: {
      list: async () => [],
      stop: async () => ({ ok: true, forwards: [] }),
    },
  };
}

const RUNNING: RemoteRuntimeStatus = {
  desiredEnabled: true,
  state: 'running',
  port: 8_765,
  errorCode: null,
  error: null,
};

const STOPPED: RemoteRuntimeStatus = {
  desiredEnabled: false,
  state: 'off',
  port: 8_765,
  errorCode: null,
  error: null,
};

function controlledCapabilities(): {
  readonly access: CapabilityAccess;
  readonly emitConnectionInfo: (urls: readonly string[]) => void;
  readonly emitRuntime: (runtime: RemoteRuntimeStatus) => void;
} {
  const observers: RemotePairingObserver[] = [];
  const base = capabilities();
  return {
    access: {
      ...base,
      remotePairing: {
        ...base.remotePairing,
        observe: (observer) => {
          observers.push(observer);
          observer.onConnectionInfo({ urls: [], port: 8_765 });
          observer.onSecurity({ state: 'ready', error: null });
          observer.onToken('fixture-token');
          observer.onRuntime(RUNNING);
          return () => undefined;
        },
      },
    },
    emitConnectionInfo: (urls) => {
      for (const observer of observers) observer.onConnectionInfo({ urls: [...urls], port: 8_765 });
    },
    emitRuntime: (runtime) => {
      for (const observer of observers) observer.onRuntime(runtime);
    },
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('RemotePanel pairing seed ordering', () => {
  it('preserves a pairing seed that resolves before the endpoint seed becomes ready', async () => {
    const controlled = controlledCapabilities();
    const seeded = { code: 'SEED-READY', expiresAt: Date.now() + 240_000 };
    const issuePairingCode = vi.fn(async () => ({
      code: 'UNNECESSARY-REISSUE',
      expiresAt: Date.now() + 240_000,
    }));
    const desktopApi: RemotePanelDesktopApi = {
      getPairingCode: async () => seeded,
      issuePairingCode,
      listRemoteDevices: async () => [],
      onPairingCodeChanged: () => () => undefined,
      onPairingRedeemed: () => () => undefined,
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <RemotePanel capabilities={controlled.access} desktopApi={desktopApi} />
        </AppI18nProvider>,
      );
      await Promise.resolve();
    });
    act(() => controlled.emitConnectionInfo(['ws://100.86.12.4:8765']));
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="open-pairing-qr"]')!.click();
      await Promise.resolve();
    });

    expect(issuePairingCode).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="pairing-code"]')?.textContent)
      .toBe('SEED-READY');
  });

  it('does not let a late initial seed overwrite a newer pairing push', async () => {
    const seed = deferred<PairingCode | null>();
    let onChanged: ((code: PairingCode | null) => void) | undefined;
    const desktopApi: RemotePanelDesktopApi = {
      getPairingCode: () => seed.promise,
      issuePairingCode: async () => ({ code: 'ISSUE-NEW', expiresAt: Date.now() + 240_000 }),
      listRemoteDevices: async () => [],
      onPairingCodeChanged: (listener) => {
        onChanged = listener;
        return () => undefined;
      },
      onPairingRedeemed: () => () => undefined,
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <RemotePanel capabilities={capabilities()} desktopApi={desktopApi} />
        </AppI18nProvider>,
      );
    });

    const pushed = { code: 'PUSH-NEW', expiresAt: Date.now() + 240_000 };
    await act(async () => {
      onChanged?.(pushed);
      seed.resolve({ code: 'SEED-OLD', expiresAt: Date.now() + 240_000 });
      await seed.promise;
    });
    act(() => {
      host!.querySelector<HTMLButtonElement>('[data-testid="open-pairing-qr"]')!.click();
    });

    expect(document.body.querySelector('[data-testid="pairing-code"]')?.textContent).toBe('PUSH-NEW');
  });

  it('requires both a running listener and a non-empty endpoint before issuing or opening a QR', async () => {
    const controlled = controlledCapabilities();
    const issuePairingCode = vi.fn(async () => ({
      code: 'ISSUED',
      expiresAt: Date.now() + 240_000,
    }));
    const desktopApi: RemotePanelDesktopApi = {
      getPairingCode: async () => null,
      issuePairingCode,
      listRemoteDevices: async () => [],
      onPairingCodeChanged: () => () => undefined,
      onPairingRedeemed: () => () => undefined,
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <RemotePanel capabilities={controlled.access} desktopApi={desktopApi} />
        </AppI18nProvider>,
      );
    });

    const open = host.querySelector<HTMLButtonElement>('[data-testid="open-pairing-qr"]')!;
    expect(open.disabled).toBe(true);
    act(() => open.click());
    expect(issuePairingCode).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="pairing-qr-dialog"]')).toBeNull();

    act(() => controlled.emitConnectionInfo(['', '  ', 'ws://100.86.12.4:8765']));
    expect(open.disabled).toBe(false);
    await act(async () => {
      open.click();
      await Promise.resolve();
    });

    expect(issuePairingCode).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[data-testid="pairing-code"]')?.textContent).toBe('ISSUED');
  });

  it('closes the dialog and clears code state immediately when the listener stops', async () => {
    const controlled = controlledCapabilities();
    let onChanged: ((code: PairingCode | null) => void) | undefined;
    const issuePairingCode = vi.fn(async () => ({
      code: 'FRESH',
      expiresAt: Date.now() + 240_000,
    }));
    const desktopApi: RemotePanelDesktopApi = {
      getPairingCode: async () => null,
      issuePairingCode,
      listRemoteDevices: async () => [],
      onPairingCodeChanged: (listener) => {
        onChanged = listener;
        return () => undefined;
      },
      onPairingRedeemed: () => () => undefined,
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <RemotePanel capabilities={controlled.access} desktopApi={desktopApi} />
        </AppI18nProvider>,
      );
    });
    act(() => controlled.emitConnectionInfo(['ws://100.86.12.4:8765']));
    const open = host.querySelector<HTMLButtonElement>('[data-testid="open-pairing-qr"]')!;
    await act(async () => {
      open.click();
      await Promise.resolve();
    });
    expect(document.body.querySelector('[data-testid="pairing-code"]')?.textContent).toBe('FRESH');

    act(() => {
      controlled.emitRuntime(STOPPED);
      onChanged?.({ code: 'STALE', expiresAt: Date.now() + 240_000 });
    });
    expect(open.disabled).toBe(true);
    expect(document.body.querySelector('[data-testid="pairing-qr-dialog"]')).toBeNull();

    act(() => controlled.emitRuntime(RUNNING));
    await act(async () => {
      open.click();
      await Promise.resolve();
    });
    expect(issuePairingCode).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[data-testid="pairing-code"]')?.textContent).toBe('FRESH');
  });
});
