import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PairingScanner } from './PairingScanner';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('PairingScanner camera lifecycle', () => {
  it('stops the camera and reports failure when video playback cannot start', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D);
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('play failed'));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MobileNavigationHistoryProvider>
          <PairingScanner onDetected={vi.fn()} onClose={vi.fn()} />
        </MobileNavigationHistoryProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="pairing-scan-error"]')).toBeTruthy();
  });

  it('does not start a decoder after unmount while video playback is pending', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D);
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    let resolvePlayback: (() => void) | undefined;
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      () => new Promise<void>((resolve) => {
        resolvePlayback = resolve;
      }),
    );
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MobileNavigationHistoryProvider>
          <PairingScanner onDetected={vi.fn()} onClose={vi.fn()} />
        </MobileNavigationHistoryProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledOnce();

    act(() => root!.unmount());
    root = null;
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => {
      resolvePlayback?.();
      await Promise.resolve();
    });

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
