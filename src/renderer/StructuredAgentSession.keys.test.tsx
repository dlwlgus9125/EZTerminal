// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApproval } from '../shared/daemon-protocol';
import { resetPlanAccessForTests } from './agent-plan-access';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from './StructuredAgentSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-19T09:30:00.000Z';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearSessionViewStates();
  localStorage.clear();
  resetPlanAccessForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(node: ReactNode): void {
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}>{node}</AppI18nProvider>));
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const commandApproval: DaemonApproval = {
  id: 'approval-command', sessionId: 'session-keys', providerRequestId: 'request-command', risk: 'danger', title: 'Run command',
  state: 'pending', request: { v: 1, kind: 'command', command: 'rm notes.md' }, revision: 1, createdAt: NOW, updatedAt: NOW,
};

function panel(overrides: Partial<StructuredAgentSessionPanelProps> = {}): JSX.Element {
  return (
    <StructuredAgentSessionPanel
      sessionId="session-keys"
      title="Keys"
      providerId="claude"
      providerLabel="Claude"
      workspace={{ id: 'workspace-1', label: 'App', kind: 'local' }}
      permissionPreset="standard"
      state="idle"
      items={[]}
      onSend={async () => ({ ok: true })}
      onChangeSettings={async () => ({ ok: true })}
      {...overrides}
    />
  );
}

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

const input = (): HTMLTextAreaElement => container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;

describe('conversation keyboard', () => {
  it('stops a turn with Esc from anywhere in the conversation, but not from a field', async () => {
    const onCancel = vi.fn(async () => ({ ok: true as const }));
    render(panel({ state: 'working', onCancel }));
    key(container.querySelector('[data-testid="structured-agent-session"] header')!, { key: 'Escape' });
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);

    const field = document.createElement('input');
    container.querySelector('header')!.append(field);
    key(field, { key: 'Escape' });
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('moves from the message box to a waiting decision with Shift+Tab, and Esc folds it back', async () => {
    render(panel({ state: 'blocked', approvals: [commandApproval], onResolveApproval: async () => ({ ok: true }) }));
    expect(container.querySelector('[data-testid="structured-agent-composer-hint"]')?.textContent).toContain('waiting decision');
    input().focus();
    key(input(), { key: 'Tab', shiftKey: true });
    const allow = container.querySelector<HTMLButtonElement>('.chat-dock [data-dock-primary]')!;
    expect(document.activeElement).toBe(allow);

    key(allow, { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(container.querySelector('.chat-dock--collapsed')).not.toBeNull();
    expect(document.activeElement).toBe(input());
  });
});

describe('stopping with queued messages', () => {
  it('hands queued messages back to the message box instead of dropping them', async () => {
    const calls: string[] = [];
    const onQueueAction = vi.fn(async (_item: unknown, action: string) => { calls.push(`queue:${action}`); return { ok: true as const }; });
    const onCancel = vi.fn(async () => { calls.push('cancel'); return { ok: true as const }; });
    const queued = { queuedCount: 1, queueItems: [{ turnId: 'turn-2', revision: 3, text: 'Then update the README.' }], onQueueAction, onCancel };
    render(panel({ state: 'working', ...queued }));
    key(input(), { key: 'Escape' });
    await flush();
    await flush();
    expect(calls).toEqual(['queue:take', 'cancel']);
    // The stop settles; the box takes input again and gets the message back.
    render(panel({ state: 'interrupted', ...queued, queuedCount: 0, queueItems: [] }));
    render(panel({ state: 'idle', ...queued, queuedCount: 0, queueItems: [] }));
    await flush();
    expect(input().value).toBe('Then update the README.');
  });
});

describe('Codex approvals', () => {
  it('denies, then interrupts and sends the feedback, since Codex takes no feedback', async () => {
    const onResolveApproval = vi.fn(async () => ({ ok: true as const }));
    const onInterruptAndSend = vi.fn(async () => ({ ok: true as const }));
    render(panel({ providerId: 'codex', providerLabel: 'Codex', state: 'blocked', approvals: [commandApproval], approvalResponses: true, onResolveApproval, onInterruptAndSend }));
    const feedbackButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Deny with feedback…')!;
    act(() => feedbackButton.click());
    const field = container.querySelector<HTMLTextAreaElement>('.chat-dock__feedback textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Keep the file; rename it instead.');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => container.querySelector<HTMLFormElement>('.chat-dock__feedback')!.requestSubmit());
    await flush();
    await flush();
    expect(onResolveApproval).toHaveBeenCalledWith('approval-command', 'deny');
    expect(onInterruptAndSend).toHaveBeenCalledWith('Keep the file; rename it instead.');
  });
});

describe('allowing for the conversation', () => {
  it('offers it only where the host can, and sends it as the session answer', async () => {
    const onResolveApproval = vi.fn(async () => ({ ok: true as const }));
    render(panel({ state: 'blocked', approvals: [commandApproval], approvalResponses: true, onResolveApproval }));
    expect(container.querySelector('[data-testid="chat-dock-allow-session"]')).toBeNull();
    render(panel({ state: 'blocked', approvals: [commandApproval], approvalResponses: true, approvalSession: true, onResolveApproval }));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="chat-dock-allow-session"]')!;
    expect(button.textContent).toBe('Allow for this conversation');
    act(() => button.click());
    await flush();
    expect(onResolveApproval).toHaveBeenCalledWith('approval-command', 'allow', { kind: 'session' });
  });
});

describe('conversation commands', () => {
  function type(text: string): void {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
      input().setSelectionRange(text.length, text.length);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('runs /plan and /new from the message box instead of sending them', async () => {
    const onChangeSettings = vi.fn(async () => ({ ok: true as const }));
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const onNewConversation = vi.fn();
    render(panel({ onChangeSettings, onSend, onNewConversation }));
    type('/');
    const labels = [...container.querySelectorAll('[data-testid="agent-completion"] [role="option"]')].map((option) => option.textContent ?? '');
    expect(labels.some((label) => label.startsWith('/plan'))).toBe(true);
    expect(labels.some((label) => label.startsWith('/model'))).toBe(true);
    type('/plan');
    key(input(), { key: 'Escape' });
    key(input(), { key: 'Enter' });
    await flush();
    expect(onChangeSettings).toHaveBeenCalledWith({ permissionPreset: 'plan' });
    expect(input().value).toBe('');
    type('/new');
    key(input(), { key: 'Escape' });
    key(input(), { key: 'Enter' });
    await flush();
    expect(onNewConversation).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('runs /clear here, and never sends it to the model where it cannot run', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const onClearConversation = vi.fn();
    const submit = (): void => {
      type('/clear');
      key(input(), { key: 'Escape' });
      key(input(), { key: 'Enter' });
    };
    render(panel({ onSend, onClearConversation }));
    submit();
    await flush();
    expect(onClearConversation).toHaveBeenCalledOnce();
    expect(input().value).toBe('');

    // Mid-turn it waits for the turn; a surface without it (Android, a draft) holds it back.
    render(panel({ onSend, onClearConversation, state: 'working', onInterruptAndSend: onSend }));
    submit();
    await flush();
    render(panel({ onSend }));
    submit();
    await flush();
    expect(onClearConversation).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(input().value).toBe('/clear');
  });

  // Claude treats "/clear <text>" as its own /clear and silently starts another session.
  it('starts over with /clear <text> and hands the text to the new conversation instead of sending it', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    const onClearConversation = vi.fn();
    render(panel({ onSend, onClearConversation }));
    type('/clear fix the build');
    key(input(), { key: 'Escape' });
    key(input(), { key: 'Enter' });
    await flush();
    expect(onClearConversation).toHaveBeenCalledWith('fix the build');
    expect(onSend).not.toHaveBeenCalled();
    expect(input().value).toBe('');

    // Mid-turn it waits for the turn and keeps the typed text; nothing reaches the model.
    render(panel({ onSend, onClearConversation, state: 'working', onInterruptAndSend: onSend }));
    type('/clear fix the build');
    key(input(), { key: 'Escape' });
    key(input(), { key: 'Enter' });
    await flush();
    expect(onClearConversation).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(input().value).toBe('/clear fix the build');
  });
});

describe('conversation menu', () => {
  it('holds the extra actions a surface adds', () => {
    const onSelect = vi.fn();
    render(panel({ menuItems: [{ label: 'Continue in terminal', onSelect }] }));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-menu"]')!.click());
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Continue in terminal')!;
    act(() => item.click());
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
