// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenClawAgentSession, OpenClawStatus } from '../shared/openclaw';
import type { CapabilityAccess, OpenClawAccess } from './capability-access';
import { OpenClawPanel } from './OpenClawPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const SESSION: OpenClawAgentSession = {
  key: 'telegram:release',
  sessionId: 'oc-release',
  status: 'working',
  model: 'claude-sonnet-4',
  updatedAt: 1_753_680_000_000,
  hasActiveRun: true,
  lastChannel: 'telegram',
  totalTokens: 18_420,
};

const NEW_SESSION: OpenClawAgentSession = {
  ...SESSION,
  key: 'slack:current',
  sessionId: 'oc-current',
  lastChannel: 'slack',
  totalTokens: 24_100,
};

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('HTMLInputElement.value setter unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeCapabilities(
  status: OpenClawStatus,
  overrides: Partial<OpenClawAccess> = {},
): { capabilities: CapabilityAccess; openClaw: OpenClawAccess } {
  const openClaw = {
    observeDrawer: vi.fn((observer) => {
      observer.onStatus(status);
      return vi.fn();
    }),
    observeChat: vi.fn(() => vi.fn()),
    observeVisibility: vi.fn(() => vi.fn()),
    getStatus: vi.fn(async () => status),
    runLifecycle: vi.fn(async () => ({ ok: true })),
    runAutostart: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(async () => []),
    getConfig: vi.fn(async () => ({
      'agents.defaults.model': 'fixture/old-model',
      'gateway.port': '18789',
    })),
    setConfig: vi.fn(async () => ({ ok: true, restartRequired: false })),
    getMode: vi.fn(async () => 'auto' as const),
    setMode: vi.fn(async () => true),
    setChatSurface: vi.fn(() => true),
    openChat: vi.fn(() => true),
    reloadChat: vi.fn(() => true),
    openChatExternal: vi.fn(async () => true),
    ...overrides,
  } as OpenClawAccess;
  return {
    openClaw,
    capabilities: {
      snapshot: () => ({ core: 'unavailable', desktop: 'available' }),
      openClaw,
    } as unknown as CapabilityAccess,
  };
}

async function render(capabilities: CapabilityAccess): Promise<void> {
  await act(async () => {
    root.render(
      <OpenClawPanel
        onOpenChat={vi.fn()}
        capabilities={capabilities}
      />,
    );
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
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OpenClawPanel', () => {
  it('shows installation guidance without operational controls when the CLI is absent', async () => {
    const { capabilities } = makeCapabilities({ state: 'not-installed', port: 18789 });

    await render(capabilities);

    expect(container.querySelector('[data-testid="openclaw-state"]')?.getAttribute('data-state'))
      .toBe('not-installed');
    expect(container.querySelector('[data-testid="openclaw-guidance"]')?.textContent)
      .toContain('npm i -g openclaw');
    expect(container.querySelector('[data-testid="btn-openclaw-start"]')).toBeNull();
    expect(container.querySelector('[data-testid="openclaw-config-save"]')).toBeNull();
    expect(container.querySelector('[data-testid="openclaw-autostart-row"]')).toBeNull();
  });

  it('saves both allowlisted settings and shows the restart-required banner', async () => {
    const setConfig = vi.fn(async () => ({ ok: true, restartRequired: true }));
    const { capabilities } = makeCapabilities(
      { state: 'stopped', port: 18789 },
      { setConfig },
    );
    await render(capabilities);

    act(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>('[data-testid="openclaw-config-model"]')!,
        'fixture/new-model',
      );
      setInputValue(
        container.querySelector<HTMLInputElement>('[data-testid="openclaw-config-port"]')!,
        '19001',
      );
    });
    await click('openclaw-config-save');

    expect(setConfig.mock.calls).toEqual([
      ['agents.defaults.model', 'fixture/new-model'],
      ['gateway.port', '19001'],
    ]);
    expect(container.querySelector('[data-testid="openclaw-restart-banner"]')).not.toBeNull();
  });

  it('requires a second autostart click before invoking install and reports the result', async () => {
    const runAutostart = vi.fn(async () => ({ ok: true }));
    const { capabilities } = makeCapabilities(
      { state: 'stopped', port: 18789 },
      { runAutostart },
    );
    await render(capabilities);

    await click('btn-openclaw-autostart-install');
    expect(runAutostart).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="btn-openclaw-autostart-install-confirm"]')).not.toBeNull();

    await click('btn-openclaw-autostart-install-confirm');
    expect(runAutostart).toHaveBeenCalledWith('install');
    expect(container.querySelector('[data-testid="openclaw-autostart-result"]')?.textContent?.trim())
      .not.toBe('');
  });

  it('keeps session polling single-flight while the previous RPC is unresolved', async () => {
    vi.useFakeTimers();
    const pending = deferred<readonly OpenClawAgentSession[]>();
    const listSessions = vi.fn(() => pending.promise);
    const { capabilities } = makeCapabilities(
      { state: 'running', port: 18_789 },
      { listSessions },
    );

    await render(capabilities);
    expect(listSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(listSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve([]);
      await pending.promise;
    });
  });

  it('shows an honest loading state until the first session snapshot arrives', async () => {
    const pending = deferred<readonly OpenClawAgentSession[]>();
    const { capabilities } = makeCapabilities(
      { state: 'running', port: 18_789 },
      { listSessions: vi.fn(() => pending.promise) },
    );

    await render(capabilities);

    expect(container.querySelector('[data-testid="openclaw-sessions-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="openclaw-sessions-empty"]')).toBeNull();

    await act(async () => {
      pending.resolve([]);
      await pending.promise;
    });
  });

  it('retains the last snapshot and marks it stale when a later poll fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T05:00:00.000Z'));
    const listSessions = vi.fn()
      .mockResolvedValueOnce([SESSION])
      .mockRejectedValueOnce(new Error('timeout'));
    const { capabilities } = makeCapabilities(
      { state: 'running', port: 18_789 },
      { listSessions },
    );

    await render(capabilities);
    expect(container.querySelector('[data-testid="openclaw-session-row"]')?.textContent)
      .toContain('telegram:release');
    expect(container.querySelector('[data-testid="openclaw-sessions-updated"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="openclaw-sessions-error"]')?.getAttribute('role'))
      .toBe('alert');
    expect(container.querySelector('[data-testid="openclaw-session-row"]')?.textContent)
      .toContain('telegram:release');
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a late %s from an older running generation',
    async (lateOutcome) => {
      const oldRequest = deferred<readonly OpenClawAgentSession[]>();
      let pushStatus: ((status: OpenClawStatus) => void) | undefined;
      const listSessions = vi.fn()
        .mockImplementationOnce(() => oldRequest.promise)
        .mockResolvedValueOnce([NEW_SESSION]);
      const { capabilities } = makeCapabilities(
        { state: 'running', port: 18_789 },
        {
          observeDrawer: (observer) => {
            pushStatus = observer.onStatus;
            observer.onStatus({ state: 'running', port: 18_789 });
            return vi.fn();
          },
          listSessions,
        },
      );

      await render(capabilities);
      expect(listSessions).toHaveBeenCalledTimes(1);

      await act(async () => {
        pushStatus?.({ state: 'stopped', port: 18_789 });
        await Promise.resolve();
      });
      await act(async () => {
        pushStatus?.({ state: 'running', port: 18_789 });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(listSessions).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-testid="openclaw-session-row"]')?.textContent)
        .toContain('slack:current');

      await act(async () => {
        if (lateOutcome === 'resolve') oldRequest.resolve([SESSION]);
        else oldRequest.reject(new Error('late timeout'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector('[data-testid="openclaw-session-row"]')?.textContent)
        .toContain('slack:current');
      expect(container.querySelector('[data-testid="openclaw-sessions-error"]')).toBeNull();
    },
  );
});
