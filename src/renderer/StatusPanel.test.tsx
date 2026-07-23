// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalApi } from '../shared/ipc';
import { createCapabilityAccess } from './capability-access';
import { StatusPanel } from './StatusPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('StatusPanel packet handoff', () => {
  it('requires trusted source AND origin, and closes superseded packet ports', async () => {
    const subscribePackets = vi.fn();
    const unsubscribePackets = vi.fn();
    const core = {
      getStatsHistory: vi.fn(async () => []),
      onStatsUpdate: vi.fn(() => vi.fn()),
      subscribePackets,
      unsubscribePackets,
    } as unknown as EzTerminalApi;
    const capabilities = createCapabilityAccess({
      readCore: () => core,
      readDesktop: () => undefined,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    localStorage.setItem('ezterminal.packetAckSeen', '1');

    await act(async () => {
      root.render(<StatusPanel capabilities={capabilities} />);
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="status-packet-toggle"]')!.click();
      await Promise.resolve();
    });
    expect(subscribePackets).toHaveBeenCalledTimes(1);

    const foreignSourcePort = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
    } as unknown as MessagePort;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { _ezPacketPort: true },
        origin: window.location.origin,
        source: null,
        ports: [foreignSourcePort],
      }));
    });
    expect(foreignSourcePort.start).not.toHaveBeenCalled();
    expect(foreignSourcePort.close).toHaveBeenCalledOnce();

    const foreignOriginPort = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
    } as unknown as MessagePort;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { _ezPacketPort: true },
        origin: 'https://foreign.invalid',
        source: window,
        ports: [foreignOriginPort],
      }));
    });
    expect(foreignOriginPort.start).not.toHaveBeenCalled();
    expect(foreignOriginPort.close).toHaveBeenCalledOnce();

    const firstPort = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
    } as unknown as MessagePort;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { _ezPacketPort: true },
        origin: window.location.origin,
        source: window,
        ports: [firstPort],
      }));
    });
    expect(firstPort.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(firstPort.start).toHaveBeenCalledTimes(1);

    const replacementPort = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
    } as unknown as MessagePort;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { _ezPacketPort: true },
        origin: window.location.origin,
        source: window,
        ports: [replacementPort],
      }));
    });
    expect(firstPort.close).toHaveBeenCalledOnce();
    expect(replacementPort.start).toHaveBeenCalledOnce();

    act(() => root.unmount());
    expect(replacementPort.close).toHaveBeenCalledTimes(1);
    expect(unsubscribePackets).toHaveBeenCalledTimes(1);
  });
});
