import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MobileRemoteDesktopView,
  mapVideoPoint,
  measureVideoViewport,
} from './MobileRemoteDesktopView';
import type {
  DesktopControlCommand,
  DesktopPointerCommand,
  DesktopPresentationAdapter,
  DesktopPresentationSnapshot,
} from './remote-desktop-presentation-adapter';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
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

function activePresentationHarness(): {
  adapter: DesktopPresentationAdapter;
  sendControl: ReturnType<typeof vi.fn<(command: DesktopControlCommand) => boolean>>;
  sendPointer: ReturnType<typeof vi.fn<(command: DesktopPointerCommand) => boolean>>;
} {
  const snapshot: DesktopPresentationSnapshot = {
    phase: 'active',
    detail: null,
    displays: [{
      id: 'primary',
      name: 'Primary display',
      width: 1_920,
      height: 1_080,
      rotationDegrees: 0,
      primary: true,
    }],
    selectedDisplayId: 'primary',
    capabilities: {
      ctrlAltDelete: false,
      clipboardText: true,
      directTouch: true,
      multiMonitor: true,
      adaptiveViewport: true,
    },
    status: null,
    clipboardFeedback: 'none',
    appliedView: null,
  };
  const sendControl = vi.fn<(command: DesktopControlCommand) => boolean>(() => true);
  const sendPointer = vi.fn<(command: DesktopPointerCommand) => boolean>(() => true);
  const adapter: DesktopPresentationAdapter = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    start: vi.fn(),
    attachVideo: vi.fn(),
    setViewport: vi.fn(),
    setQualityPreference: vi.fn(() => true),
    resume: vi.fn(),
    sendControl,
    sendPointer,
    selectDisplay: vi.fn(() => true),
    sendLocalClipboard: vi.fn(async () => undefined),
    copyRemoteClipboard: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
  return { adapter, sendControl, sendPointer };
}

function physicalMouseMove(
  target: Element,
  { clientX, clientY }: { clientX: number; clientY: number },
): void {
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    buttons: { value: 0 },
  });
  target.dispatchEvent(event);
}

function physicalMouseButton(
  target: Element,
  type: 'pointerdown' | 'pointerup',
  button: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    clientX: 50,
    clientY: 50,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    buttons: { value: type === 'pointerdown' ? 1 : 0 },
  });
  target.dispatchEvent(event);
}

function physicalKey(
  target: Element,
  type: 'keydown' | 'keyup',
  code: string,
  key = code,
): void {
  target.dispatchEvent(new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code,
    key,
  }));
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

  it('measures the rendered video area in physical pixels and clamps extremes', () => {
    const element = {
      getBoundingClientRect: () => ({
        width: 390,
        height: 720,
      } as DOMRect),
    };
    expect(measureVideoViewport(element, 3)).toEqual({
      pixelWidth: 1_170,
      pixelHeight: 2_160,
    });
    expect(measureVideoViewport(element, 20)).toEqual({
      pixelWidth: 4_096,
      pixelHeight: 4_096,
    });
    expect(measureVideoViewport({
      getBoundingClientRect: () => ({ width: 0, height: 720 } as DOMRect),
    }, 3)).toBeNull();
  });

  it('renders a distinct busy state and returns without creating WebRTC', async () => {
    const transport = busyTransport();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MobileRemoteDesktopView transport={transport as unknown as WsEzTerminalTransport} onClose={onClose} />);
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-start"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="mobile-pc-state"][data-phase="busy"]')).toBeTruthy();
    expect(container.textContent).toContain('Galaxy A');
    expect(transport.stopDesktopControl).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('.mob-pc-back')!.click());
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
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-start"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(transport.startDesktopControl).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="mobile-pc-state"][data-phase="busy"]')).toBeTruthy();
  });

  it('focuses the active remote surface and routes physical keyboard key transitions', async () => {
    const { adapter, sendControl } = activePresentationHarness();
    await act(async () => {
      root.render(
        <MobileRemoteDesktopView
          transport={busyTransport() as unknown as WsEzTerminalTransport}
          onClose={() => undefined}
          presentationAdapterFactory={() => adapter}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-start"]')!.click();
      await Promise.resolve();
    });

    const viewport = container.querySelector<HTMLDivElement>('.mobile-pc-video-viewport')!;
    act(() => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyA',
        key: 'a',
      }));
      viewport.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code: 'KeyA',
        key: 'a',
      }));
    });

    expect(document.activeElement).toBe(viewport);
    expect(sendControl.mock.calls.map(([command]) => command)).toEqual([
      { type: 'key', code: 'KeyA', down: true, modifiers: [] },
      { type: 'key', code: 'KeyA', down: false, modifiers: [] },
    ]);
  });

  it('routes physical mouse hover movement without requiring a prior button press', async () => {
    const { adapter, sendPointer } = activePresentationHarness();
    await act(async () => {
      root.render(
        <MobileRemoteDesktopView
          transport={busyTransport() as unknown as WsEzTerminalTransport}
          onClose={() => undefined}
          presentationAdapterFactory={() => adapter}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-start"]')!.click();
      await Promise.resolve();
    });

    const viewport = container.querySelector<HTMLDivElement>('.mobile-pc-video-viewport')!;
    act(() => {
      physicalMouseMove(viewport, { clientX: 10, clientY: 10 });
      physicalMouseMove(viewport, { clientX: 20, clientY: 15 });
    });

    expect(sendPointer).toHaveBeenCalledOnce();
    expect(sendPointer.mock.calls[0]?.[0]).toMatchObject({
      type: 'pointer-relative',
    });
    expect(sendPointer.mock.calls[0]?.[0]).not.toMatchObject({ dx: 0, dy: 0 });
  });

  it('forwards supported hardware keys and releases held keys when the surface loses focus', async () => {
    const { adapter, sendControl } = activePresentationHarness();
    await act(async () => {
      root.render(
        <MobileRemoteDesktopView
          transport={busyTransport() as unknown as WsEzTerminalTransport}
          onClose={() => undefined}
          presentationAdapterFactory={() => adapter}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-start"]')!.click();
      await Promise.resolve();
    });

    const viewport = container.querySelector<HTMLDivElement>('.mobile-pc-video-viewport')!;
    act(() => {
      physicalKey(viewport, 'keydown', 'ControlLeft', 'Control');
      physicalKey(viewport, 'keydown', 'KeyA', 'a');
      physicalKey(viewport, 'keydown', 'F12');
      physicalKey(viewport, 'keydown', 'AudioVolumeUp');
      viewport.blur();
    });

    expect(sendControl.mock.calls.map(([command]) => command)).toEqual([
      { type: 'key', code: 'ControlLeft', down: true, modifiers: [] },
      { type: 'key', code: 'KeyA', down: true, modifiers: [] },
      { type: 'key', code: 'F12', down: true, modifiers: [] },
      { type: 'key', code: 'ControlLeft', down: false, modifiers: [] },
      { type: 'key', code: 'KeyA', down: false, modifiers: [] },
      { type: 'key', code: 'F12', down: false, modifiers: [] },
    ]);
  });

  it('maps physical mouse buttons, drag movement, and both wheel axes', async () => {
    const { adapter, sendControl, sendPointer } = activePresentationHarness();
    await act(async () => {
      root.render(
        <MobileRemoteDesktopView
          transport={busyTransport() as unknown as WsEzTerminalTransport}
          onClose={() => undefined}
          presentationAdapterFactory={() => adapter}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-start"]')!.click();
      await Promise.resolve();
    });

    const viewport = container.querySelector<HTMLDivElement>('.mobile-pc-video-viewport')!;
    viewport.setPointerCapture = vi.fn();
    act(() => {
      physicalMouseButton(viewport, 'pointerdown', 0);
      physicalMouseMove(viewport, { clientX: 60, clientY: 55 });
      physicalMouseButton(viewport, 'pointerup', 0);
      physicalMouseButton(viewport, 'pointerdown', 2);
      physicalMouseButton(viewport, 'pointerup', 2);
      physicalMouseButton(viewport, 'pointerdown', 1);
      physicalMouseButton(viewport, 'pointerup', 1);
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: 12,
        deltaY: -24,
      }));
    });

    expect(sendControl.mock.calls.map(([command]) => command)).toEqual([
      { type: 'pointer-button', button: 'left', down: true },
      { type: 'pointer-button', button: 'left', down: false },
      { type: 'pointer-button', button: 'right', down: true },
      { type: 'pointer-button', button: 'right', down: false },
      { type: 'pointer-button', button: 'middle', down: true },
      { type: 'pointer-button', button: 'middle', down: false },
      { type: 'wheel', deltaX: 12, deltaY: -24 },
    ]);
    expect(sendPointer.mock.calls[0]?.[0]).toMatchObject({ type: 'pointer-relative' });
  });

  it('uses absolute physical mouse hover coordinates in Direct touch mode', async () => {
    window.localStorage.setItem('ezterminal.pcControl.preferences.v2', JSON.stringify({
      version: 2,
      inputMode: 'direct',
      qualityPreference: 'balanced',
      handleEdge: 'right',
      handleY: 0.5,
    }));
    const { adapter, sendPointer } = activePresentationHarness();
    await act(async () => {
      root.render(
        <MobileRemoteDesktopView
          transport={busyTransport() as unknown as WsEzTerminalTransport}
          onClose={() => undefined}
          presentationAdapterFactory={() => adapter}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-start"]')!.click();
      await Promise.resolve();
    });

    const viewport = container.querySelector<HTMLDivElement>('.mobile-pc-video-viewport')!;
    viewport.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    act(() => physicalMouseMove(viewport, { clientX: 25, clientY: 50 }));

    expect(sendPointer).toHaveBeenCalledOnce();
    expect(sendPointer.mock.calls[0]?.[0]).toMatchObject({ type: 'pointer-absolute' });
    const command = sendPointer.mock.calls[0]?.[0];
    if (command?.type !== 'pointer-absolute') throw new Error('expected absolute pointer command');
    expect(command.x).toBeCloseTo(0.25);
    expect(command.y).toBeCloseTo(0.5);
  });
});
