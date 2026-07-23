import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileRemoteDesktopView, mapVideoPoint } from './MobileRemoteDesktopView';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function busyTransport() {
  return {
    startDesktopControl: vi.fn(async () => ({
      kind: 'desktop-control-start-result', requestId: '1', ok: false,
      reason: 'busy', controllerName: 'Galaxy A',
    })),
    stopDesktopControl: vi.fn(),
    onDesktopSignal: vi.fn(() => () => undefined),
    onDesktopStatus: vi.fn(() => () => undefined),
    onDesktopEnded: vi.fn(() => () => undefined),
    onConnectionStateChange: vi.fn(() => () => undefined),
  };
}

describe('MobileRemoteDesktopView', () => {
  it('maps pointer coordinates through contain letterboxing and centered zoom', () => {
    const viewport = {
      left: 0, top: 0, right: 100, bottom: 100,
      width: 100, height: 100, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    expect(mapVideoPoint(50, 50, viewport, 200, 100, 1)).toEqual({ x: 0.5, y: 0.5 });
    expect(mapVideoPoint(50, 0, viewport, 200, 100, 1)).toEqual({ x: 0.5, y: 0 });
    expect(mapVideoPoint(0, 50, viewport, 200, 100, 2)).toEqual({ x: 0.25, y: 0.5 });
  });

  it('renders a distinct busy state and returns without creating WebRTC', async () => {
    const transport = busyTransport();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MobileRemoteDesktopView transport={transport as unknown as WsEzTerminalTransport} onClose={onClose} />);
      await Promise.resolve();
    });
    expect(container.querySelector('.mobile-pc-state--busy')).toBeTruthy();
    expect(container.textContent).toContain('Galaxy A');
    expect(transport.stopDesktopControl).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('.mobile-pc-toolbar button')!.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps one in-flight start alive through the StrictMode effect replay', async () => {
    const transport = busyTransport();
    await act(async () => {
      root.render(
        <StrictMode>
          <MobileRemoteDesktopView
            transport={transport as unknown as WsEzTerminalTransport}
            onClose={() => undefined}
          />
        </StrictMode>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(transport.startDesktopControl).toHaveBeenCalledOnce();
    expect(container.querySelector('.mobile-pc-state--busy')).toBeTruthy();
  });
});
