// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../../src/renderer/i18n';
import type { DaemonApproval, DaemonTranscriptItem } from '../../src/shared/daemon-protocol';
import { MobileStructuredAgentSession } from './MobileStructuredAgentSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const assistant: DaemonTranscriptItem = {
  id: 'assistant-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  sequence: 1,
  kind: 'assistant-message',
  text: 'Ready for a direct follow-up.',
  isDelta: false,
  isSensitive: false,
  createdAt: '2026-09-04T09:30:00.000Z',
};

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
});

describe('MobileStructuredAgentSession', () => {
  it('presents a semantic transcript and sends directly through callback props', async () => {
    const onBack = vi.fn();
    const onSend = vi.fn(async () => ({ ok: true as const }));
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <MobileStructuredAgentSession
          sessionId="session-1"
          title="Mobile structured Agent"
          providerId="codex"
          providerLabel="Codex"
          workspace={{ id: 'workspace-1', label: 'Main checkout', kind: 'local' }}
          permissionPreset="plan"
          state="idle"
          items={[assistant]}
          onBack={onBack}
          onSend={onSend}
        />
      </AppI18nProvider>,
    ));

    expect(container.querySelector('[data-kind="assistant-message"]')?.textContent)
      .toContain('Ready for a direct follow-up.');
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'Run the next check');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
    await flush();
    expect(onSend).toHaveBeenCalledWith('Run the next check');

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders archived history without unavailable mutation controls', () => {
    const approval: DaemonApproval = {
      id: 'approval-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      providerRequestId: 'provider-request-1',
      risk: 'write',
      title: 'Historical approval',
      state: 'pending',
      revision: 1,
      createdAt: '2026-09-04T09:30:00.000Z',
      updatedAt: '2026-09-04T09:30:00.000Z',
    };
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <MobileStructuredAgentSession
          sessionId="session-1"
          title="Archived mobile Agent"
          providerId="codex"
          providerLabel="Codex"
          workspace={{ id: 'workspace-1', label: 'Main checkout', kind: 'local' }}
          permissionPreset="plan"
          state="archived"
          items={[assistant]}
          approvals={[approval]}
          historyOnly
          onBack={() => undefined}
          onSend={async () => ({ ok: true })}
          onResolveApproval={async () => ({ ok: true })}
          onArchive={async () => ({ ok: true })}
        />
      </AppI18nProvider>,
    ));

    expect(container.querySelector('[data-history-only="true"]')).not.toBeNull();
    expect(container.textContent).toContain('Ready for a direct follow-up.');
    expect(container.querySelector('[data-testid="structured-agent-composer-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="structured-agent-lifecycle"]')).toBeNull();
    expect(container.querySelector('.structured-agent-approval__actions')).toBeNull();
  });
});
