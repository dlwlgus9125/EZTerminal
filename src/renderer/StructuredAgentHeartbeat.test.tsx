// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHeartbeat } from '../shared/daemon-protocol';
import { AppI18nProvider } from './i18n';
import { StructuredAgentHeartbeat } from './StructuredAgentHeartbeat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T09:30:00.000Z';

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('StructuredAgentHeartbeat', () => {
  it('requires explicit background-host confirmation before enabling and saving', async () => {
    const onEnableHost = vi.fn(async () => ({ ok: true as const }));
    const onSave = vi.fn(async () => ({ ok: true as const }));

    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentHeartbeat
          sessionId="agent-1"
          automationReady={false}
          onEnableHost={onEnableHost}
          onSave={onSave}
          onRunNow={vi.fn(async () => ({ ok: true as const }))}
        />
      </AppI18nProvider>,
    ));

    act(() => container.querySelector<HTMLButtonElement>('.structured-agent-heartbeat__summary')!.click());
    act(() => container.querySelector<HTMLInputElement>('[data-testid="structured-agent-heartbeat-enabled"]')!.click());
    act(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(onEnableHost).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="structured-agent-heartbeat-host-confirm"]')).not.toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-heartbeat-enable-host"]')!.click());
    await flush();

    expect(onEnableHost).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      cron: '*/15 * * * *',
      enabled: true,
    }));
  });

  it('runs an enabled heartbeat without changing its saved definition', async () => {
    const value: DaemonHeartbeat = {
      sessionId: 'agent-1',
      prompt: 'Check blockers.',
      cron: '0 * * * *',
      timezone: 'Asia/Seoul',
      enabled: true,
      pending: false,
      nextRunAt: '2026-09-04T10:00:00.000Z',
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const onRunNow = vi.fn(async () => ({ ok: true as const }));
    const onSave = vi.fn(async () => ({ ok: true as const }));

    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentHeartbeat
          sessionId="agent-1"
          value={value}
          automationReady
          onEnableHost={vi.fn(async () => ({ ok: true as const }))}
          onSave={onSave}
          onRunNow={onRunNow}
        />
      </AppI18nProvider>,
    ));
    act(() => container.querySelector<HTMLButtonElement>('.structured-agent-heartbeat__summary')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-heartbeat-run"]')!.click());
    await flush();

    expect(onRunNow).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
});
