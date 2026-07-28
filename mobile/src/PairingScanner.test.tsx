import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PairingScanner } from './PairingScanner';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DECODE_INTERVAL_FOR_TEST_MS = 250;

const qrDecoder = vi.hoisted(() => vi.fn());
const capacitorApp = vi.hoisted(() => {
  const appStateListeners = new Set<(event: { readonly isActive: boolean }) => void>();
  const pauseListeners = new Set<() => void>();
  const addListener = vi.fn(async (
    eventName: string,
    listener: ((event: { readonly isActive: boolean }) => void) | (() => void),
  ) => {
    if (eventName === 'appStateChange') {
      appStateListeners.add(listener as (event: { readonly isActive: boolean }) => void);
    }
    if (eventName === 'pause') pauseListeners.add(listener as () => void);
    return {
      remove: vi.fn(async () => {
        appStateListeners.delete(listener as (event: { readonly isActive: boolean }) => void);
        pauseListeners.delete(listener as () => void);
      }),
    };
  });
  return { addListener, appStateListeners, pauseListeners };
});

vi.mock('@capacitor/app', () => ({
  App: { addListener: capacitorApp.addListener },
}));
vi.mock('jsqr', () => ({ default: qrDecoder }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  qrDecoder.mockReset();
  capacitorApp.addListener.mockClear();
  capacitorApp.appStateListeners.clear();
  capacitorApp.pauseListeners.clear();
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

  it('fails closed when video playback never settles', async () => {
    vi.useFakeTimers();
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
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => new Promise<void>(() => undefined));

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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(
      container.querySelector('[data-testid="pairing-scan-error"]')
        ?.getAttribute('data-camera-error'),
    ).toBe('unavailable');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops the camera exactly once and closes when the app enters the background', async () => {
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
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onClose = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MobileNavigationHistoryProvider>
          <PairingScanner onDetected={vi.fn()} onClose={onClose} />
        </MobileNavigationHistoryProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(capacitorApp.appStateListeners.size).toBe(1);
    expect(stop).not.toHaveBeenCalled();

    act(() => {
      [...capacitorApp.appStateListeners][0]?.({ isActive: false });
      [...capacitorApp.appStateListeners][0]?.({ isActive: false });
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => root!.unmount());
    root = null;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('ignores a permission-dialog pause, then closes on pause after camera acquisition', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D);
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    let resolveCamera: ((value: MediaStream) => void) | undefined;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => {
          resolveCamera = resolve;
        })),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onClose = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MobileNavigationHistoryProvider>
          <PairingScanner onDetected={vi.fn()} onClose={onClose} />
        </MobileNavigationHistoryProvider>,
      );
      await Promise.resolve();
    });

    expect(capacitorApp.pauseListeners.size).toBe(1);
    act(() => [...capacitorApp.pauseListeners][0]?.());
    expect(onClose).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    await act(async () => {
      resolveCamera?.(stream);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      [...capacitorApp.pauseListeners][0]?.();
      [...capacitorApp.pauseListeners][0]?.();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('fails closed and stops a late camera stream when app-state monitoring cannot start', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D);
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    let resolveCamera: ((value: MediaStream) => void) | undefined;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => {
          resolveCamera = resolve;
        })),
      },
    });
    capacitorApp.addListener.mockRejectedValueOnce(new Error('listener unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onClose = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MobileNavigationHistoryProvider>
          <PairingScanner onDetected={vi.fn()} onClose={onClose} />
        </MobileNavigationHistoryProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    await act(async () => {
      resolveCamera?.(stream);
      await Promise.resolve();
    });

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'unavailable'],
    ['NotReadableError', 'unavailable'],
  ])('classifies %s camera start failures as %s', async (name, expectedError) => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('camera start failed', name);
        }),
      },
    });

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

    expect(
      container.querySelector('[data-testid="pairing-scan-error"]')
        ?.getAttribute('data-camera-error'),
    ).toBe(expectedError);
  });

  it('fails closed when a playing camera never produces a usable frame', async () => {
    vi.useFakeTimers();
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
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();

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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(
      container.querySelector('[data-testid="pairing-scan-error"]')
        ?.getAttribute('data-camera-error'),
    ).toBe('unavailable');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops and reports unavailable when the active camera track ends', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D);
    const stop = vi.fn();
    let onEnded: (() => void) | undefined;
    const track = {
      stop,
      addEventListener: vi.fn((eventName: string, listener: () => void) => {
        if (eventName === 'ended') onEnded = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const stream = {
      getTracks: () => [track],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();

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

    expect(onEnded).toBeTypeOf('function');
    act(() => onEnded?.());

    expect(
      container.querySelector('[data-testid="pairing-scan-error"]')
        ?.getAttribute('data-camera-error'),
    ).toBe('unavailable');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops and reports unavailable when sampling a ready frame throws', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(() => {
        throw new DOMException('frame disappeared', 'InvalidStateError');
      }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(480);
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();

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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_FOR_TEST_MS);
    });

    expect(
      container.querySelector('[data-testid="pairing-scan-error"]')
        ?.getAttribute('data-camera-error'),
    ).toBe('unavailable');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('decodes a valid pairing URI, stops once, and delivers the exact connection', async () => {
    vi.useFakeTimers();
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(4),
        width: 1,
        height: 1,
      })),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(480);
    qrDecoder.mockReturnValue({
      data: 'ezterminal://pair?endpoint=ws%3A%2F%2F100.84.12.7%3A7420&code=7C2F-91KD',
    });
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onDetected = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MobileNavigationHistoryProvider>
          <PairingScanner onDetected={onDetected} onClose={vi.fn()} />
        </MobileNavigationHistoryProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_FOR_TEST_MS);
    });

    expect(qrDecoder).toHaveBeenCalledOnce();
    expect(onDetected).toHaveBeenCalledExactlyOnceWith({
      endpoint: 'ws://100.84.12.7:7420',
      code: '7C2F-91KD',
    });
    expect(stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops and reports unreadable for a QR that is not a pairing URI', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(4),
        width: 1,
        height: 1,
      })),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(480);
    qrDecoder.mockReturnValue({ data: 'https://example.com/not-ezterminal' });
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onDetected = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MobileNavigationHistoryProvider>
          <PairingScanner onDetected={onDetected} onClose={vi.fn()} />
        </MobileNavigationHistoryProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_FOR_TEST_MS);
    });

    expect(onDetected).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="pairing-scan-error"]')
        ?.getAttribute('data-camera-error'),
    ).toBe('unreadable');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
