// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApproval, DaemonTranscriptItem } from '../shared/daemon-protocol';
import {
  StructuredAgentComposer,
  StructuredAgentChildTrack,
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  StructuredAgentTranscript,
  coalesceStructuredAgentTranscript,
} from './StructuredAgentSession';
import { AppI18nProvider } from './i18n';
import { AgentResultsOwnerContext } from './agent-results/AgentResultsContext';
import { readResultsSource, resetResultsSourcesForTests } from './agent-results/results-source-store';
import { clearSessionViewStates } from './session-view-state';
import { encodeFileChanges } from '../shared/conversation-changes';

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

it('uses the completed provider message as authority without duplicating streamed text', () => {
  const items = [
    transcriptItem('a1', 1, 'assistant-message', 'Hello ', { messageId: 'a', isDelta: true }),
    transcriptItem('b1', 2, 'tool-result', 'TOKEN=', { messageId: 'b', isDelta: true, isSensitive: true }),
    transcriptItem('a2', 3, 'assistant-message', 'world', { messageId: 'a', isDelta: true }),
    transcriptItem('b2', 4, 'tool-result', 'secret', { messageId: 'b', isDelta: true, isSensitive: true }),
    transcriptItem('a3', 5, 'assistant-message', 'Hello world!', { messageId: 'a' }),
    transcriptItem('b3', 6, 'tool-result', 'TOKEN=secret', { messageId: 'b', isSensitive: true }),
  ];
  expect(coalesceStructuredAgentTranscript(items).map((item) => item.text)).toEqual(['Hello world!', 'TOKEN=secret']);
});

function pendingApproval(id: string): DaemonApproval {
  return {
    id, sessionId: 'skin-session', providerRequestId: `provider-${id}`, risk: 'write', title: 'Write the file?',
    state: 'pending', revision: 1, createdAt: NOW, updatedAt: NOW,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode, locale: 'en' | 'ko' = 'en'): void {
  act(() => root.render(
    <AppI18nProvider locale={locale} languages={[locale]}>
      {node}
    </AppI18nProvider>,
  ));
}

/** Desktop keeps session actions and the skin choice in the header's overflow menu. */
function openSessionMenu(): void {
  if (!document.querySelector('[role="menu"]')) act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-menu"]')!.click());
}

function chooseSkin(skin: 'bubble' | 'cli'): void {
  openSessionMenu();
  act(() => document.querySelector<HTMLButtonElement>(`[data-testid="structured-agent-skin-${skin}"]`)!.click());
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
  clearSessionViewStates();
  localStorage.removeItem('ezterminal.chat.skin');
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
  it('saves the remaining draft when /resume immediately leaves the stage form', async () => {
    const save = vi.fn();
    const create = vi.fn(async () => ({ ok: true as const }));
    function StageForm(): JSX.Element {
      const [history, setHistory] = useState(false);
      return history ? <p>History</p> : <StructuredAgentDraftPanel
        providers={[{ id: 'codex', label: 'Codex', models: [] }]}
        workspaces={[{ id: 'workspace-1', label: 'Workspace', kind: 'local' }]}
        initialDraftText="/resume keep my question" onFormStateChange={save}
        onOpenHistory={() => setHistory(true)} onCreate={create} />;
    }
    render(<StageForm />);
    act(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
    await flush();
    expect(container.textContent).toBe('History');
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ draft: expect.objectContaining({ text: 'keep my question' }) }));
    expect(create).not.toHaveBeenCalled();
  });
  it('never sends /clear as a first prompt from a draft, where starting over is unavailable', async () => {
    const create = vi.fn(async () => ({ ok: true as const }));
    for (const text of ['/clear', '/clear fix the build']) {
      render(<StructuredAgentDraftPanel
        providers={[{ id: 'codex', label: 'Codex', models: [] }]}
        workspaces={[{ id: 'workspace-1', label: 'Workspace', kind: 'local' }]}
        initialDraftText={text} onCreate={create} />);
      act(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
      await flush();
    }
    expect(create).not.toHaveBeenCalled();
  });
  it('creates an empty Agent only on Create and preserves selection after a failure', async () => {
    const onCreate = vi.fn(async () => ({ ok: false as const, message: 'Provider unavailable' }));
    render(
      <StructuredAgentDraftPanel
        providers={[{ id: 'codex', label: 'Codex', models: [{ id: 'gpt-5', label: 'GPT-5' }] }]}
        workspaces={[{ id: 'workspace-1', label: 'Feature worktree', kind: 'worktree' }]}
        onCreate={onCreate}
      />,
    );

    expect(onCreate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="structured-agent-first-prompt"]')).toBeNull();
    act(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
    await flush();

    expect(onCreate).toHaveBeenCalledWith({
      providerId: 'codex',
      workspaceId: 'workspace-1',
      permissionPreset: 'standard',
    });
    expect(container.querySelector<HTMLSelectElement>('[data-testid="structured-agent-provider"]')?.value).toBe('codex');
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

  it('locks an uncertain delivery draft but keeps exact-command recovery available', async () => {
    const onCreate = vi.fn(async () => ({ ok: false as const, message: 'Still checking delivery' }));
    render(
      <StructuredAgentDraftPanel
        providers={[{
          id: 'codex',
          label: 'Codex',
          models: [{ id: 'gpt-5', label: 'GPT-5' }],
          disabled: true,
        }]}
        workspaces={[{ id: 'workspace-1', label: 'Feature worktree', kind: 'worktree' }]}
        initialProviderId="codex"
        initialModel="gpt-5"
        initialPermissionPreset="plan"
        initialPrompt="Recover this exact Agent"
        deliveryRecovery
        onCreate={onCreate}
      />,
    );

    expect(container.querySelector<HTMLSelectElement>('[data-testid="structured-agent-provider"]')?.disabled)
      .toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[data-testid="structured-agent-model"]')?.disabled)
      .toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-recovery-prompt"]')?.readOnly)
      .toBe(true);
    const send = container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!;
    expect(send.disabled).toBe(false);
    act(() => send.click());
    await flush();
    expect(onCreate).toHaveBeenCalledWith({
      providerId: 'codex',
      model: 'gpt-5',
      workspaceId: 'workspace-1',
      permissionPreset: 'plan',
      initialPrompt: 'Recover this exact Agent',
    });
  });
});

describe('StructuredAgentTranscript', () => {
  it('shows a sensitive-marked provider reply verbatim', () => {
    render(<StructuredAgentTranscript providerLabel="Codex" items={[
      transcriptItem('reply', 1, 'assistant-message', 'Original reply TOKEN=secret', { isSensitive: true }),
    ]} />);
    expect(container.querySelector('[data-kind="assistant"]')?.textContent).toContain('Original reply TOKEN=secret');
  });

  it('coalesces adjacent deltas and preserves original output and kind semantics', () => {
    const items = [
      transcriptItem('delta-a', 1, 'assistant-message', 'Structured ', { isDelta: true }),
      transcriptItem('delta-b', 2, 'assistant-message', 'reply', { isDelta: true }),
      transcriptItem('secret', 3, 'tool-result', 'TOKEN=secret', { isSensitive: true }),
      transcriptItem('reasoning', 4, 'reasoning', 'Inspect constraints'),
    ];
    expect(coalesceStructuredAgentTranscript(items)).toHaveLength(3);

    render(<StructuredAgentTranscript items={items} providerLabel="Codex" />);
    const assistant = container.querySelector('[data-kind="assistant"]');
    expect(assistant?.textContent).toContain('Structured reply');
    // Without turn records a delta-only message is still streaming.
    expect(assistant?.querySelector('[data-streaming]')).not.toBeNull();
    // Tool output and reasoning live in one activity run; output stays verbatim.
    const run = container.querySelector<HTMLButtonElement>('[data-kind="activity"] .chat-run__header')!;
    act(() => run.click());
    const lines = Array.from(container.querySelectorAll<HTMLButtonElement>('.chat-tool__line'));
    act(() => lines.forEach((line) => { if (!line.disabled) line.click(); }));
    expect(container.querySelector('[data-kind="activity"]')?.textContent).toContain('TOKEN=secret');
    expect(container.querySelector('[data-kind="activity"]')?.textContent).toContain('Inspect constraints');
    expect(container.textContent).not.toContain('Sensitive output hidden');
    expect(container.querySelector('ol.chat-rows')?.getAttribute('aria-label')).toBe('Conversation');
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
        items={[]}
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

  it('opens any transcript relation through the same session callback', () => {
    const onOpen = vi.fn();
    render(
      <StructuredAgentTranscript
        items={[transcriptItem('related', 1, 'notice', 'A related session has context.', {
          relatedSessionId: 'child-session',
        })]}
        providerLabel="Codex"
        onOpenRelatedSession={onOpen}
      />,
    );
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-kind="child"] button'))[0]!;
    expect(button.textContent).toContain('Open Agent');
    act(() => button.click());
    expect(onOpen).toHaveBeenCalledWith('child-session');
  });
});

describe('StructuredAgentChildTrack', () => {
  it('exposes direct child identity, state, ownership, and stable selection', () => {
    const onSelect = vi.fn();
    render(
      <StructuredAgentChildTrack
        items={[
          {
            sessionId: 'managed-child',
            title: 'Accessibility review',
            providerLabel: 'Codex',
            state: 'idle',
            owner: 'managed',
          },
          {
            sessionId: 'native-child',
            title: 'Provider search worker',
            providerLabel: 'Claude Code',
            state: 'working',
            owner: 'provider-native',
          },
        ]}
        onSelectSession={onSelect}
      />,
    );

    const children = Array.from(container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="structured-agent-child"]',
    ));
    expect(children).toHaveLength(2);
    // Work in flight comes before an idle child.
    const [native, managed] = children;
    expect(native?.textContent).toContain('Provider search worker');
    expect(managed?.textContent).toContain('Accessibility review');
    expect(managed?.textContent).toContain('Codex');
    // The state reads in the UI language, not as the raw protocol value.
    expect(managed?.textContent).toContain('Ready');
    expect(managed?.textContent).toContain('Managed');
    expect(native?.textContent).toContain('Provider-owned');
    expect(native?.textContent).toContain('Read only');
    act(() => managed!.click());
    expect(onSelect).toHaveBeenCalledWith('managed-child');
  });

  it('shows what needs attention first and folds the rest behind "+N more"', () => {
    const states = ['done', 'done', 'working', 'done', 'blocked', 'done', 'error'] as const;
    render(
      <StructuredAgentChildTrack
        items={states.map((state, index) => ({ sessionId: `child-${index}`, title: `Child ${index}`, providerLabel: 'Claude', state, owner: 'provider-native' as const }))}
        onSelectSession={vi.fn()}
      />,
    );
    const titles = (): string[] => Array.from(container.querySelectorAll('[data-testid="structured-agent-child"] .structured-agent-child__title')).map((node) => node.textContent ?? '');
    expect(titles()).toEqual(['Child 4', 'Child 6', 'Child 2', 'Child 0']);
    const more = container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-child-more"]')!;
    expect(more.textContent).toBe('+3 more');
    act(() => more.click());
    expect(titles()).toHaveLength(7);
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('StructuredAgentComposer', () => {
  it('restores each session draft without leaking it into a different session', () => {
    const show = (sessionId: string) => render(<StructuredAgentSessionPanel
      sessionId={sessionId} title={sessionId} providerId="codex" providerLabel="Codex"
      workspace={{ id: 'main', label: 'Main', kind: 'local' }} permissionPreset="standard" state="idle"
      items={[]} onSend={async () => ({ ok: true })}
    />);
    const input = () => container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;
    show('session-a'); setValue(input(), 'Unsent draft for A');
    show('session-b'); expect(input().value).toBe(''); setValue(input(), 'Unsent draft for B');
    show('session-a'); expect(input().value).toBe('Unsent draft for A');
    show('session-b'); expect(input().value).toBe('Unsent draft for B');
  });
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
    const model = container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-live-model"]')!;
    expect(model.getAttribute('aria-label')).toContain('GPT-5');
    act(() => model.click());
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('GPT-6'))!;
    act(() => option.click());
    await flush();
    // Only what changed: the host refuses a permission change during a turn, but not an unchanged one.
    expect(onChangeSettings).toHaveBeenCalledWith({ model: 'gpt-6' });
    expect(model.getAttribute('aria-label')).toContain('GPT-6');
  });

  it('shows a resumed conversation model the provider list does not name', () => {
    render(
      <StructuredAgentSessionPanel
        sessionId="session-1"
        title="Resumed"
        providerId="claude"
        providerLabel="Claude"
        workspace={{ id: 'workspace-1', label: 'Feature', kind: 'worktree' }}
        model="claude-opus-5-5"
        modelOptions={[]}
        permissionPreset="full-access"
        state="idle"
        items={[]}
        onSend={async () => ({ ok: true })}
        onChangeSettings={async () => ({ ok: true })}
      />,
    );
    expect(container.querySelector('[data-testid="structured-agent-live-model"]')?.getAttribute('aria-label')).toContain('claude-opus-5-5');
  });

  it('names a concrete model by the provider alias that resolves to it', () => {
    render(
      <StructuredAgentSessionPanel
        sessionId="session-1"
        title="Defaults"
        providerId="claude"
        providerLabel="Claude"
        workspace={{ id: 'workspace-1', label: 'Feature', kind: 'worktree' }}
        model="claude-opus-5-5"
        modelOptions={[
          { id: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-5-5', isDefault: true },
          { id: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
          { id: 'sonnet', label: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
        ]}
        permissionPreset="standard"
        state="idle"
        items={[]}
        onSend={async () => ({ ok: true })}
        onChangeSettings={async () => ({ ok: true })}
      />,
    );
    const pill = container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-live-model"]')!;
    expect(pill.getAttribute('aria-label')).toContain('Opus 5.5');
    act(() => pill.click());
    const rows = [...container.querySelectorAll('[role="menuitemradio"]')].map((item) => `${item.getAttribute('aria-checked')}:${item.textContent}`);
    expect(rows).toEqual(['false:Default (recommended)', 'true:Opus 5.5', 'false:Sonnet 5.5']);
  });

  it('guards lifecycle actions, reports failure, and preserves a typed draft', async () => {
    const onCancel = vi.fn(async () => ({ ok: false as const, message: 'Stop failed safely' }));
    const onDetach = vi.fn(async () => ({ ok: true as const }));
    render(
      <StructuredAgentSessionPanel
        sessionId="session-1"
        title="Managed child"
        providerId="codex"
        providerLabel="Codex"
        workspace={{ id: 'workspace-1', label: 'Feature', kind: 'worktree' }}
        permissionPreset="standard"
        state="working"
        items={[]}
        onSend={async () => ({ ok: true })}
        onCancel={onCancel}
        onArchive={async () => ({ ok: true })}
        onDetach={onDetach}
      />,
    );
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;
    setValue(input, 'Keep this draft');
    openSessionMenu();
    expect(container.querySelector('[data-testid="structured-agent-archive"]')).toBeNull();

    // Stop lives in the composer: Esc (or the stop button once the draft is empty).
    const escape = (): void => act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    escape();
    expect(container.querySelector('[data-testid="structured-agent-menu"]')?.getAttribute('aria-busy')).toBe('true');
    openSessionMenu();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-detach"]')?.disabled).toBe(true);
    escape();
    await flush();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Stop failed safely');
    expect(input.value).toBe('Keep this draft');
    openSessionMenu();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-detach"]')!.click());
    await flush();
    expect(onDetach).toHaveBeenCalledOnce();
  });

  it('renders provider-owned and terminal sessions as read-only in English and Korean', () => {
    render(
      <StructuredAgentSessionPanel
        sessionId="native-child"
        title="Native child"
        providerId="claude"
        providerLabel="Claude Code"
        workspace={{ id: 'workspace-1', label: 'Feature', kind: 'worktree' }}
        permissionPreset="standard"
        state="working"
        owner="provider-native"
        items={[]}
        onSend={async () => ({ ok: true })}
        onCancel={async () => ({ ok: true })}
        onDetach={async () => ({ ok: true })}
      />,
    );
    openSessionMenu();
    expect(container.querySelector('[data-testid="structured-agent-detach"]')).toBeNull();
    expect(container.querySelector('[data-testid="structured-agent-archive"]')).toBeNull();
    expect(container.querySelector('[data-testid="structured-agent-stop"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="structured-agent-composer-disabled-reason"]')?.textContent)
      .toContain('owned by the provider');
    expect(container.querySelector('[data-testid="structured-agent-live-model-value"]')).not.toBeNull();

    render(
      <StructuredAgentSessionPanel
        sessionId="archived-child"
        title="Archived child"
        providerId="codex"
        providerLabel="Codex"
        workspace={{ id: 'workspace-1', label: 'Feature', kind: 'worktree' }}
        permissionPreset="standard"
        state="archived"
        items={[]}
        onSend={async () => ({ ok: true })}
      />,
      'ko',
    );
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="structured-agent-composer-disabled-reason"]')?.textContent)
      .toContain('보관된 세션');
  });
});

it('uses Enter to send once on desktop, preserves IME/newlines, and requires Send on mobile', async () => {
  const onSend = vi.fn(async () => ({ ok: true as const }));
  render(<StructuredAgentComposer busy={false} onSend={onSend} />);
  const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
  setValue(input, 'First message');
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  });
  expect(onSend).not.toHaveBeenCalled();
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await flush(); expect(onSend).toHaveBeenCalledExactlyOnceWith('First message');
  render(<StructuredAgentComposer busy={false} onSend={onSend} variant="mobile" />);
  setValue(input, 'Mobile message');
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(onSend).toHaveBeenCalledOnce();
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
  await flush(); expect(onSend).toHaveBeenLastCalledWith('Mobile message');
});

describe('message-based chat skins', () => {
  const workspace = { id: 'workspace-1', label: 'Main', kind: 'local' } as const;
  const panel = (props: Partial<Parameters<typeof StructuredAgentSessionPanel>[0]> = {}) => <StructuredAgentSessionPanel
    sessionId="skin-session" title="Same conversation" providerId="codex" providerLabel="Codex"
    workspace={workspace} permissionPreset="standard" state="idle" items={[]}
    onSend={async () => ({ ok: true })} {...props}
  />;
  const input = () => container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;

  it('takes a queued request only after acknowledgement, blocks concurrent sends and restores the parked attachment draft', async () => {
    let acknowledge!: (value: { ok: true }) => void;
    const onQueueAction = vi.fn(() => new Promise<{ ok: true }>(resolve => { acknowledge = resolve; }));
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const attachment = { id: 'a', name: 'notes.txt', mimeType: 'text/plain', kind: 'text' as const, data: 'Saved notes' };
    render(panel({ state: 'working', queuedCount: 1, queueItems: [{ turnId: 'queued', revision: 4, text: 'Queued question' }], onQueueAction, onSend,
      supportsMessageContext: true, draftState: { text: 'Original draft', attachments: [attachment], selectionStart: 3, selectionEnd: 3 } }));
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Edit')!.click());
    expect(input().value).toBe('Original draft');
    act(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => acknowledge({ ok: true }));
    expect(input().value).toBe('Queued question');
    act(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
    await flush();
    expect(onSend).toHaveBeenCalledWith('Queued question');
    expect(input().value).toBe('Original draft');
    expect(input().selectionStart).toBe(3);
    expect(container.textContent).toContain('notes.txt');
  });

  it('quotes actual patch lines into the existing draft without sending and keeps review state across skins', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const items = [transcriptItem('patch', 2, 'tool-result', encodeFileChanges([{ path: 'src/a.ts', patch: '@@ -8 +8 @@\n-old\n+new', coverage: 'patch' }])!, { sessionId: 'skin-session' })];
    render(panel({ items, onSend, skin: 'bubble' }));
    setValue(input(), 'My question\n');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-review-changes"]')!.click());
    await flush();
    const patch = document.querySelector('[data-testid="conversation-change-review"]')!;
    act(() => patch.querySelector<HTMLButtonElement>('[data-kind="add"]')!.click());
    render(panel({ items, onSend, skin: 'cli' }));
    expect(document.querySelector('[data-kind="add"][aria-pressed="true"]')).not.toBeNull();
    act(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Quote selected lines')!.click());
    await flush();
    expect(input().value).toContain('My question'); expect(input().value).toContain('src/a.ts'); expect(input().value).toContain('+new');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('desktop with a Results tab: the header, change cards and file links open it; review comments reach the draft without sending', async () => {
    const open = vi.fn();
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const items = [
      transcriptItem('ask', 1, 'user-message', 'Change it', { sessionId: 'skin-session' }),
      transcriptItem('call', 2, 'tool-call', 'apply', { sessionId: 'skin-session', payload: { v: 1, type: 'tool', callId: 'c1', name: 'fileChange', category: 'edit', phase: 'call', status: 'running' } }),
      transcriptItem('patch', 3, 'tool-result', encodeFileChanges([{ path: 'src/a.ts', patch: '@@ -8 +8 @@\n-old\n+new', coverage: 'patch' }])!, {
        sessionId: 'skin-session', payload: { v: 1, type: 'tool', callId: 'c1', name: 'fileChange', category: 'edit', phase: 'result', status: 'completed', files: [{ path: 'src/a.ts', kind: 'update', added: 1, removed: 1 }] },
      }),
      transcriptItem('answer', 4, 'assistant-message', 'Edited `src/a.ts` as asked.', { sessionId: 'skin-session' }),
    ];
    render(
      <AgentResultsOwnerContext.Provider value={{ ownerPanelId: 'agent-session-x', open }}>
        {panel({ items, onSend, skin: 'bubble', workspace: { ...workspace, path: 'C:\\work' } })}
      </AgentResultsOwnerContext.Provider>,
    );
    await flush();
    expect(container.querySelector('[data-testid="structured-agent-review-changes"]')).toBeNull();
    expect(document.querySelector('[data-testid="conversation-change-review"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-results"]')!.click());
    expect(open).toHaveBeenLastCalledWith({ activate: true, target: { section: 'changes' } });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-changes-open-results"]')!.click());
    expect(open).toHaveBeenLastCalledWith({ activate: true, target: { section: 'changes', turnId: 'turn-1' } });
    act(() => container.querySelector<HTMLButtonElement>('.chat-changes__file')!.click());
    expect(open).toHaveBeenLastCalledWith({ activate: true, target: { section: 'changes', turnId: 'turn-1', path: 'src/a.ts' } });
    const link = Array.from(container.querySelectorAll('.chat-md button, .chat-md a')).find((element) => element.textContent === 'src/a.ts');
    expect(link).toBeTruthy();
    act(() => (link as HTMLElement).click());
    expect(open).toHaveBeenLastCalledWith({ activate: true, target: { section: 'files', path: 'src/a.ts' } });
    // The Results tab reads the model and draft access this panel publishes.
    const source = readResultsSource('agent-session-x');
    expect(source?.model?.rows.some((row) => row.kind === 'changes')).toBe(true);
    setValue(input(), 'Keep my words. ');
    act(() => source!.insertIntoDraft!('Review comments (1)\n- src/a.ts:8 — fine\n'));
    await flush();
    expect(input().value).toContain('Keep my words.');
    expect(input().value).toContain('src/a.ts:8 — fine');
    expect(onSend).not.toHaveBeenCalled();
    resetResultsSourcesForTests();
  });

  it('changes only the presentation and preserves message, input, selection, tool and approval elements', () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const onResolve = vi.fn(async () => ({ ok: true as const }));
    render(panel({ onSend, onResolveApproval: onResolve, approvals: [pendingApproval('approval')], items: [
      transcriptItem('message-1', 1, 'user-message', 'Keep this conversation'),
      transcriptItem('tool', 2, 'tool-result', 'Long output '.repeat(150)),
    ] }));
    const originalMessage = container.querySelector('[data-message-id="message-1"]');
    const originalInput = input();
    act(() => container.querySelector<HTMLButtonElement>('.chat-run__header')!.click());
    act(() => container.querySelector<HTMLButtonElement>('.chat-tool__line')!.click());
    expect(container.querySelector('.chat-output__pre')?.textContent).toContain('Long output');
    setValue(input(), 'Unsent draft');
    act(() => input().setSelectionRange(2, 6));
    chooseSkin('cli');
    expect(container.querySelector('[data-testid="structured-agent-session"]')?.getAttribute('data-skin')).toBe('cli');
    expect(input()).toBe(originalInput);
    expect(input().value).toBe('Unsent draft');
    expect([input().selectionStart, input().selectionEnd]).toEqual([2, 6]);
    expect(container.querySelector('[data-message-id="message-1"]')).not.toBeNull();
    expect(originalMessage).not.toBeNull();
    // The expanded tool output survives the skin switch (shared disclosure state).
    expect(container.querySelector('.chat-output__pre')?.textContent).toContain('Long output');
    expect(container.querySelector('.chat-dock')).not.toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
    expect(localStorage.getItem('ezterminal.chat.skin')).toBe('cli');
    chooseSkin('bubble');
    expect(input()).toBe(originalInput);
  });

  it('retains logical message elements across final streaming chunks and replies with the first daemon item ID', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const items = [transcriptItem('first-chunk', 1, 'assistant-message', 'Hello ', { messageId: 'provider-message', isDelta: true })];
    render(panel({ items, onSend, supportsMessageContext: true }));
    const article = container.querySelector('[data-message-id="provider-message"]');
    render(panel({ items: [...items, transcriptItem('last-chunk', 2, 'assistant-message', 'Hello world', { messageId: 'provider-message' })], onSend, supportsMessageContext: true }));
    expect(container.querySelector('[data-message-id="provider-message"]')).toBe(article);
    const reply = container.querySelector<HTMLButtonElement>('[data-message-id="provider-message"] button[aria-label="Reply"]')!;
    act(() => reply.click());
    setValue(input(), 'Explain this');
    chooseSkin('cli');
    expect(container.querySelector('.structured-agent-composer__reply')?.textContent).toContain('Hello world');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
    await flush();
    expect(onSend).toHaveBeenCalledWith('Explain this', { replyTo: { messageId: 'first-chunk', text: 'Hello world' } });
  });

  it('preserves a newer draft typed while the previous send is awaiting its receipt', async () => {
    let resolve!: (result: { ok: true }) => void;
    const onSend = vi.fn(() => new Promise<{ ok: true }>((done) => { resolve = done; }));
    render(panel({ onSend }));
    setValue(input(), 'First message');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
    setValue(input(), 'Next unsent message');
    await act(async () => resolve({ ok: true }));
    expect(input().value).toBe('Next unsent message');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('First message');
  });

  it('keeps attachments through skin changes and sends them in the same message context', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const attachment = { id: 'attachment-1', name: 'requirements.md', kind: 'text' as const, mimeType: 'text/markdown', data: 'Keep the existing terminal.' };
    render(panel({ onSend, supportsMessageContext: true, draftState: { text: 'Read this', attachments: [attachment] } }));
    chooseSkin('cli');
    expect(container.querySelector('.structured-agent-composer__attachments')?.textContent).toContain(attachment.name);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
    await flush();
    expect(onSend).toHaveBeenCalledWith('Read this', { attachments: [attachment] });
    expect(input().value).toBe('');
    expect(container.querySelector('.structured-agent-composer__attachments')).toBeNull();
  });

  it('supports an offline draft while locking host settings, approval and transmission', () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const onDraftChange = vi.fn();
    const onResolve = vi.fn(async () => ({ ok: true as const }));
    render(panel({ disabled: true, allowDraftWhenDisabled: true, variant: 'mobile', sendDisabled: true,
      sendDisabledReason: 'Offline — reconnect and send explicitly', onSend, onDraftChange,
      onChangeSettings: async () => ({ ok: true }), onResolveApproval: onResolve,
      approvals: [pendingApproval('approval')], items: [] }));
    expect(input().disabled).toBe(false);
    setValue(input(), 'Offline draft');
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Offline draft' }));
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[data-testid="structured-agent-live-permission"]')?.disabled).toBe(true);
    const allow = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Allow')!;
    expect(allow.disabled).toBe(true);
    act(() => { allow.click(); container.querySelector<HTMLFormElement>('form')!.requestSubmit(); });
    expect(onSend).not.toHaveBeenCalled(); expect(onResolve).not.toHaveBeenCalled();
    render(panel({ disabled: true, allowDraftWhenDisabled: true, state: 'archived' }));
    expect(input().disabled).toBe(true);
  });

  it('blocks repeated transmission of an uncertain send until explicit receipt reconciliation', async () => {
    const onSend = vi.fn(async () => ({ ok: false as const, message: 'Receipt lost', deliveryUncertain: true }));
    const onReconcileDelivery = vi.fn(async () => ({ ok: true as const }));
    render(panel({ onSend, onReconcileDelivery }));
    setValue(input(), 'Keep exact request');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
    await flush();
    expect(input().value).toBe('Keep exact request');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')?.disabled).toBe(true);
    act(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
    expect(onSend).toHaveBeenCalledOnce();
    const check = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Check delivery')!;
    act(() => check.click());
    await flush();
    expect(onReconcileDelivery).toHaveBeenCalledOnce();
    expect(input().value).toBe('');
  });
});
