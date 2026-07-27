// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenClawStatus } from '../shared/openclaw';
import type { CapabilityAccess, OpenClawAccess } from './capability-access';
import { OpenClawPanel } from './OpenClawPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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
    setChatVisible: vi.fn(() => true),
    openChat: vi.fn(() => true),
    closeChat: vi.fn(() => true),
    reloadChat: vi.fn(() => true),
    setChatBounds: vi.fn(() => true),
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
});
