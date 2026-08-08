// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteDesktopHostStatus } from '../shared/ipc';
import type { CapabilityAccess } from './capability-access';
import { useRemoteDesktopHostStatus } from './RemoteDesktopStatusCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

function status(overrides: Partial<RemoteDesktopHostStatus> = {}): RemoteDesktopHostStatus {
  return {
    state: 'active',
    service: 'ready',
    controllerName: 'phone',
    connectedAt: 1_000,
    localAddress: '127.0.0.1',
    peerAddress: '127.0.0.2',
    framesPerSecond: 30,
    roundTripTimeMs: 10,
    bitrateKbps: 2_000,
    qualityTier: 'high',
    errorCode: null,
    ...overrides,
  };
}

describe('useRemoteDesktopHostStatus', () => {
  it('coalesces telemetry to a frame but commits authority changes immediately', () => {
    const frames: FrameRequestCallback[] = [];
    const cancelled = new Set<number>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => cancelled.add(handle));
    let emit: ((next: RemoteDesktopHostStatus) => void) | null = null;
    const capabilities = {
      remoteDesktop: {
        observe: (onStatus: (next: RemoteDesktopHostStatus) => void) => {
          emit = onStatus;
          return () => undefined;
        },
      },
    } as unknown as CapabilityAccess;
    const renders: Array<RemoteDesktopHostStatus | null> = [];

    function Harness(): JSX.Element {
      const current = useRemoteDesktopHostStatus(capabilities);
      renders.push(current);
      return <div>{current?.framesPerSecond ?? 'empty'}</div>;
    }

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
    act(() => emit?.(status()));
    const rendersAfterSeed = renders.length;

    act(() => {
      emit?.(status({ framesPerSecond: 31 }));
      emit?.(status({ framesPerSecond: 32 }));
      emit?.(status({ framesPerSecond: 33 }));
    });
    expect(renders).toHaveLength(rendersAfterSeed);
    expect(host.textContent).toBe('30');

    act(() => frames.shift()?.(performance.now()));
    expect(renders).toHaveLength(rendersAfterSeed + 1);
    expect(host.textContent).toBe('33');

    act(() => emit?.(status({ state: 'reconnecting', framesPerSecond: 34 })));
    expect(renders).toHaveLength(rendersAfterSeed + 2);
    expect(host.textContent).toBe('34');

    act(() => emit?.(status({ state: 'reconnecting', framesPerSecond: 35 })));
    act(() => emit?.(status({ state: 'error', framesPerSecond: 36, errorCode: 'lost' })));
    expect(host.textContent).toBe('36');
    expect(cancelled.size).toBeGreaterThan(0);
  });
});
