// @vitest-environment jsdom

import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewPanelApi } from 'dockview-react';

import { type DockPanelHost, useDockPanelHost } from './use-dock-panel-host';

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

function Probe({
  panelApi,
  onHost,
}: {
  readonly panelApi: DockviewPanelApi;
  readonly onHost: (host: DockPanelHost) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const host = useDockPanelHost(ref, panelApi);
  useEffect(() => {
    onHost(host);
  }, [host, onHost]);
  return <div ref={ref} data-testid="host-probe" />;
}

describe('useDockPanelHost', () => {
  it('tracks a live panel DOM node when Dockview reparents it into an auxiliary document', async () => {
    let locationListener: (() => void) | null = null;
    const panelApi = {
      onDidLocationChange: vi.fn((listener: () => void) => {
        locationListener = listener;
        return { dispose: vi.fn() };
      }),
    } as unknown as DockviewPanelApi;
    const hosts: DockPanelHost[] = [];
    await act(async () => {
      root.render(<Probe panelApi={panelApi} onHost={(host) => hosts.push(host)} />);
      await Promise.resolve();
    });
    expect(hosts.at(-1)?.ownerDocument).toBe(document);

    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const auxiliary = frame.contentWindow!;
    Object.defineProperty(auxiliary, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });

    await act(async () => {
      auxiliary.document.body.appendChild(container);
      locationListener?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hosts.at(-1)?.ownerDocument).toBe(auxiliary.document);
    expect(hosts.at(-1)?.ownerWindow).toBe(auxiliary);
    expect(hosts.at(-1)?.revision).toBeGreaterThan(0);
    frame.remove();
  });
});
