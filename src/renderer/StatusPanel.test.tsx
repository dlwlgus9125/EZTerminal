// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalApi, SystemStatsSnapshot } from '../shared/ipc';
import { createCapabilityAccess } from './capability-access';
import { StatusPanel } from './StatusPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null;

const snapshot: SystemStatsSnapshot = {
  at: Date.UTC(2026, 6, 26, 12, 34, 56),
  cpu: { loadPct: 37.4, cores: [12, 63] },
  mem: { usedBytes: 4 * 1073741824, totalBytes: 8 * 1073741824 },
  memDetail: {
    availableBytes: 3 * 1073741824,
    cachedBytes: 1 * 1073741824,
    swapUsedBytes: 512 * 1048576,
    swapTotalBytes: 2 * 1073741824,
  },
  net: { iface: 'Ethernet-fixture', rxSec: 2 * 1048576, txSec: 512 * 1024 },
  disks: [{ mount: 'C:', usedBytes: 75 * 1073741824, sizeBytes: 100 * 1073741824 }],
  procs: [{ pid: 42, name: 'fixture-node.exe', cpuPct: 9.5, memBytes: 256 * 1048576 }],
  conns: [{
    proto: 'TCP',
    local: '127.0.0.1:2026',
    peer: '127.0.0.1:3030',
    state: 'ESTABLISHED',
    process: 'fixture-node.exe',
  }],
};

function makeCore(history: readonly SystemStatsSnapshot[] = []) {
  let statsListener: ((next: SystemStatsSnapshot) => void) | null = null;
  return {
    getStatsHistory: vi.fn(async () => history),
    onStatsUpdate: vi.fn((listener: (next: SystemStatsSnapshot) => void) => {
      statsListener = listener;
      return vi.fn();
    }),
    subscribePackets: vi.fn(),
    unsubscribePackets: vi.fn(),
    emitStats(next: SystemStatsSnapshot): void {
      statsListener?.(next);
    },
  };
}

async function render(core: ReturnType<typeof makeCore>): Promise<void> {
  const capabilities = createCapabilityAccess({
    readCore: () => core as unknown as EzTerminalApi,
    readDesktop: () => undefined,
  });
  await act(async () => {
    root?.render(<StatusPanel capabilities={capabilities} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(testId: string): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StatusPanel rendering', () => {
  it('renders every status section from a deterministic snapshot', async () => {
    await render(makeCore([snapshot]));

    for (const section of ['cpu', 'mem', 'net', 'conns', 'disk', 'proc']) {
      expect(container.querySelector(`[data-testid="status-section-${section}"]`)).not.toBeNull();
    }
    expect(container.querySelectorAll('[data-testid="status-cpu-cores"] .status-core-row')).toHaveLength(2);
    expect(container.querySelector('[data-testid="status-mem-detail"]')?.textContent).toContain('4.0 GB');
    expect(container.querySelector('[data-testid="status-section-net"]')?.textContent).toContain('Ethernet-fixture');
    expect(container.querySelector('[data-testid="status-section-disk"]')?.textContent).toContain('75%');
    expect(container.querySelector('[data-testid="status-section-proc"]')?.textContent).toContain('fixture-node.exe');
    expect(container.querySelector('[data-testid="status-section-conns"]')?.textContent).toContain('ESTABLISHED');
    expect(
      container.querySelector<HTMLTimeElement>('[data-testid="status-last-updated"]')?.dateTime,
    ).toBe(new Date(snapshot.at).toISOString());
  });

  it('reports an unavailable monitor instead of measuring forever when the initial read fails', async () => {
    const core = makeCore();
    core.getStatsHistory.mockRejectedValueOnce(new Error('stats bridge unavailable'));

    await render(core);

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Measuring');
  });

  it('marks the last successful sample stale when the live subscription fails', async () => {
    const core = makeCore([snapshot]);
    core.onStatsUpdate.mockImplementationOnce(() => {
      throw new Error('stats subscription unavailable');
    });

    await render(core);

    expect(container.querySelector('[data-testid="status-panel"]')?.getAttribute('data-state')).toBe(
      'unavailable',
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="status-section-net"]')?.textContent).toContain(
      'Ethernet-fixture',
    );
    expect(
      container.querySelector<HTMLTimeElement>('[data-testid="status-last-updated"]')?.dateTime,
    ).toBe(new Date(snapshot.at).toISOString());
  });

  it('returns to current data after a fresh snapshot follows an initial read error', async () => {
    const core = makeCore();
    core.getStatsHistory.mockRejectedValueOnce(new Error('stats history unavailable'));
    await render(core);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      core.emitStats(snapshot);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="status-panel"]')?.getAttribute('data-state')).toBe(
      'healthy',
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="status-section-net"]')?.textContent).toContain(
      'Ethernet-fixture',
    );
  });
});

describe('StatusPanel packet handoff', () => {
  it('acknowledges once, subscribes only while open, and re-subscribes without a second prompt', async () => {
    const core = makeCore();
    await render(core);

    expect(container.querySelector('[data-testid="status-packet-view"]')).toBeNull();
    await click('status-packet-toggle');
    expect(container.querySelector('[data-testid="status-packet-ack-confirm"]')).not.toBeNull();
    expect(core.subscribePackets).not.toHaveBeenCalled();

    await click('status-packet-ack-confirm');
    expect(localStorage.getItem('ezterminal.packetAckSeen')).toBe('1');
    expect(core.subscribePackets).toHaveBeenCalledOnce();

    await click('status-packet-toggle');
    expect(container.querySelector('[data-testid="status-packet-view"]')).toBeNull();
    expect(core.unsubscribePackets).toHaveBeenCalledOnce();

    await click('status-packet-toggle');
    expect(container.querySelector('[data-testid="status-packet-ack-confirm"]')).toBeNull();
    expect(core.subscribePackets).toHaveBeenCalledTimes(2);
  });

  it('requires trusted source AND origin, and closes superseded packet ports', async () => {
    const core = makeCore();
    localStorage.setItem('ezterminal.packetAckSeen', '1');
    await render(core);
    await click('status-packet-toggle');
    expect(core.subscribePackets).toHaveBeenCalledTimes(1);

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

    act(() => root?.unmount());
    root = null;
    expect(replacementPort.close).toHaveBeenCalledTimes(1);
    expect(core.unsubscribePackets).toHaveBeenCalledTimes(1);
  });
});
