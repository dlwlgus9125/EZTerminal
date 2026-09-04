// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApproval, DaemonTranscriptItem } from '../shared/daemon-protocol';
import {
  StructuredAgentComposer,
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  StructuredAgentTranscript,
  coalesceStructuredAgentTranscript,
} from './StructuredAgentSession';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T09:30:00.000Z';

function transcriptItem(
  id: string,
  sequence: number,
  kind: DaemonTranscriptItem['kind'],
  text: string,
  overrides: Partial<DaemonTranscriptItem> = {},
): DaemonTranscriptItem {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    sequence,
    kind,
    text,
    isDelta: false,
    isSensitive: false,
    createdAt: NOW,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode): void {
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      {node}
    </AppI18nProvider>,
  ));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setValue(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event('change', { bubbles: true }));
    control.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('StructuredAgentDraftPanel', () => {
  it('does not create anything before first Send and preserves the typed prompt after a failure', async () => {
    const onCreate = vi.fn(async () => ({ ok: false as const, message: 'Provider unavailable' }));
    render(
      <StructuredAgentDraftPanel
        providers={[{ id: 'codex', label: 'Codex', models: [{ id: 'gpt-5', label: 'GPT-5' }] }]}
        workspaces={[{ id: 'workspace-1', label: 'Feature worktree', kind: 'worktree' }]}
        onCreate={onCreate}
      />,
    );

    expect(onCreate).not.toHaveBeenCalled();
    const prompt = container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-first-prompt"]')!;
    setValue(prompt, 'Implement the semantic session UI');
    act(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
    await flush();

    expect(onCreate).toHaveBeenCalledWith({
      providerId: 'codex',
      workspaceId: 'workspace-1',
      permissionPreset: 'standard',
      initialPrompt: 'Implement the semantic session UI',
    });
    expect(prompt.value).toBe('Implement the semantic session UI');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Provider unavailable');
  });

  it('exposes accessible loading, empty-option, and validation states', () => {
    render(
      <StructuredAgentDraftPanel
        providers={[]}
        workspaces={[]}
        loading
        loadError="Daemon unavailable"
        onRetry={() => undefined}
        onCreate={async () => ({ ok: true })}
      />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Daemon unavailable');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')?.disabled).toBe(true);
    expect(container.querySelector('label[for]')?.getAttribute('for')).toBeTruthy();
  });
});

describe('StructuredAgentTranscript', () => {
  it('coalesces adjacent deltas and preserves kind semantics and sensitive redaction', () => {
    const items = [
      transcriptItem('delta-a', 1, 'assistant-message', 'Structured ', { isDelta: true }),
      transcriptItem('delta-b', 2, 'assistant-message', 'reply', { isDelta: true }),
      transcriptItem('secret', 3, 'tool-result', 'TOKEN=secret', { isSensitive: true }),
      transcriptItem('reasoning', 4, 'reasoning', 'Inspect constraints'),
    ];
    expect(coalesceStructuredAgentTranscript(items)).toHaveLength(3);

    render(<StructuredAgentTranscript items={items} providerLabel="Codex" />);
    const assistant = container.querySelector('[data-kind="assistant-message"]');
    expect(assistant?.textContent).toContain('Structured reply');
    expect(assistant?.querySelector('[role="status"]')?.textContent).toContain('Streaming');
    expect(container.querySelector('[data-kind="tool-result"]')?.textContent).toContain('Sensitive output hidden');
    expect(container.textContent).not.toContain('TOKEN=secret');
    expect(container.querySelector('[data-kind="reasoning"] details')).not.toBeNull();
    expect(container.querySelector('ol')?.getAttribute('aria-label')).toBe('Agent transcript');
  });

  it('renders approval state and delivers an explicit decision', async () => {
    const onResolve = vi.fn(async () => ({ ok: true as const }));
    const approval: DaemonApproval = {
      id: 'approval-1',
      sessionId: 'session-1',
      providerRequestId: 'provider-1',
      risk: 'danger',
      title: 'Run deployment command?',
      state: 'pending',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    render(
      <StructuredAgentTranscript
        items={[transcriptItem('approval-1', 1, 'approval', approval.title)]}
        approvals={[approval]}
        providerLabel="Codex"
        onResolveApproval={onResolve}
      />,
    );
    const allow = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Allow')!;
    act(() => allow.click());
    await flush();
    expect(onResolve).toHaveBeenCalledWith('approval-1', 'allow');
  });

  it('distinguishes loading, empty, and stale error states', () => {
    render(<StructuredAgentTranscript items={[]} providerLabel="Codex" loading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading transcript');
    render(<StructuredAgentTranscript items={[]} providerLabel="Codex" />);
    expect(container.querySelector('[data-testid="structured-agent-empty"]')?.textContent).toContain('No messages yet');
    render(<StructuredAgentTranscript items={[]} providerLabel="Codex" error="Transcript failed" />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Transcript failed');
  });
});

describe('StructuredAgentComposer', () => {
  it('keeps FIFO Send available while busy and requires an explicit Interrupt & Send action', async () => {
    const onSend = vi.fn(async () => ({ ok: false as const, message: 'Queue unavailable' }));
    const onInterrupt = vi.fn(async () => ({ ok: true as const }));
    render(
      <StructuredAgentComposer
        busy
        queuedCount={2}
        onSend={onSend}
        onInterruptAndSend={onInterrupt}
      />,
    );
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;
    setValue(input, 'Follow up after the current turn');
    const queue = container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!;
    const interrupt = container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-interrupt-send"]')!;
    expect(queue.textContent).toContain('Queue message');
    expect(interrupt.textContent).toContain('Interrupt & Send');

    act(() => queue.click());
    await flush();
    expect(onSend).toHaveBeenCalledWith('Follow up after the current turn');
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(input.value).toBe('Follow up after the current turn');

    act(() => interrupt.click());
    await flush();
    expect(onInterrupt).toHaveBeenCalledWith('Follow up after the current turn');
    expect(input.value).toBe('');
  });
});

describe('StructuredAgentSessionPanel', () => {
  it('updates model and permissions through the session settings callback and exposes the child slot', async () => {
    const onChangeSettings = vi.fn(async () => ({ ok: true as const }));
    render(
      <StructuredAgentSessionPanel
        sessionId="session-1"
        title="Structured Agent"
        providerId="codex"
        providerLabel="Codex"
        workspace={{ id: 'workspace-1', label: 'Feature', kind: 'worktree' }}
        model="gpt-5"
        modelOptions={[{ id: 'gpt-5', label: 'GPT-5' }, { id: 'gpt-6', label: 'GPT-6' }]}
        permissionPreset="standard"
        state="idle"
        items={[]}
        childTrack={<span>Reserved child projection</span>}
        onSend={async () => ({ ok: true })}
        onChangeSettings={onChangeSettings}
      />,
    );
    expect(container.querySelector('[data-testid="structured-agent-child-track"]')?.textContent)
      .toContain('Reserved child projection');
    const model = container.querySelector<HTMLSelectElement>('[data-testid="structured-agent-live-model"]')!;
    setValue(model, 'gpt-6');
    await flush();
    expect(onChangeSettings).toHaveBeenCalledWith({ model: 'gpt-6', permissionPreset: 'standard' });
  });
});
