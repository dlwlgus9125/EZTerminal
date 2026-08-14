// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IDockviewPanelProps } from 'dockview-react';

import type { OpenClawStatus } from '../shared/openclaw';
import type {
  CapabilityAccess,
  OpenClawAccess,
  OpenClawChatObserver,
} from './capability-access';
import { useNativeOverlayRegistration } from './native-overlay';
import { OpenClawChatPanel } from './OpenClawChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
  unobserve(): void {}
}

let container: HTMLDivElement;
let root: Root;

function makeCapabilities(
  observeChat: (observer: OpenClawChatObserver) => () => void,
): { capabilities: CapabilityAccess; openClaw: OpenClawAccess } {
  const openClaw = {
    observeDrawer: vi.fn(() => vi.fn()),
    observeChat: vi.fn(observeChat),
    observeVisibility: vi.fn(() => vi.fn()),
    getStatus: vi.fn(async () => null),
    runLifecycle: vi.fn(async () => ({ ok: true })),
    runAutostart: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(async () => []),
    getConfig: vi.fn(async () => null),
    setConfig: vi.fn(async () => null),
    getMode: vi.fn(async () => 'auto' as const),
    setMode: vi.fn(async () => true),
    setChatSurface: vi.fn(() => true),
    openChat: vi.fn(() => true),
    reloadChat: vi.fn(() => true),
    openChatExternal: vi.fn(async () => true),
  } as OpenClawAccess;
  return {
    openClaw,
    capabilities: {
      snapshot: () => ({ core: 'unavailable', desktop: 'available' }),
      openClaw,
    } as unknown as CapabilityAccess,
  };
}

function dockProps(): IDockviewPanelProps {
  return {
    api: {
      isVisible: true,
      onDidVisibilityChange: vi.fn(() => ({ dispose: vi.fn() })),
    },
  } as unknown as IDockviewPanelProps;
}

async function render(capabilities: CapabilityAccess): Promise<void> {
  await act(async () => {
    root.render(<OpenClawChatPanel {...dockProps()} capabilities={capabilities} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function RegisteredOverlay({ active = true }: { readonly active?: boolean }): null {
  useNativeOverlayRegistration(active);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenClawChatPanel unavailable state', () => {
  it('shows an actionable retry state when observing the native chat bridge fails', async () => {
    const running: OpenClawStatus = { state: 'running', port: 18789 };
    const { capabilities, openClaw } = makeCapabilities((observer) => {
      observer.onStatus(running);
      observer.onError?.(new Error('chat bridge unavailable'));
      return vi.fn();
    });

    await render(capabilities);

    const reconnect = container.querySelector('[data-testid="openclaw-chat-reconnect"]');
    expect(reconnect).not.toBeNull();
    expect(reconnect?.textContent).toContain('Chat could not be opened');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="openclaw-chat-reconnect-btn"]')!.click();
      await Promise.resolve();
    });
    expect(openClaw.reloadChat).toHaveBeenCalledOnce();
  });

  it('hides the native view until every registered DOM overlay closes', async () => {
    const running: OpenClawStatus = { state: 'running', port: 18789 };
    const { capabilities, openClaw } = makeCapabilities((observer) => {
      observer.onStatus(running);
      return vi.fn();
    });
    const props = dockProps();
    const renderOverlays = async (ids: readonly string[]): Promise<void> => {
      await act(async () => {
        root.render(
          <>
            <OpenClawChatPanel {...props} capabilities={capabilities} />
            {ids.map((id) => <RegisteredOverlay key={id} />)}
          </>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    await renderOverlays([]);
    expect(openClaw.setChatSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ mounted: true, windowName: 'main', visible: true }),
    );

    await renderOverlays(['dialog']);
    expect(openClaw.setChatSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false }),
    );

    await renderOverlays(['dialog', 'toast']);
    expect(openClaw.setChatSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false }),
    );

    await renderOverlays(['toast']);
    expect(openClaw.setChatSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false }),
    );

    await renderOverlays([]);
    expect(openClaw.setChatSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true }),
    );
  });
});
