// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../../shared/daemon-protocol';
import type { ChatSessionState, ChatStateResult, ChatStateScope, ChatStateSnapshot, ChatStateWrite } from '../../shared/chat-state';
import { rendererCapabilities, type CapabilityAccess } from '../capability-access';
import type { ChatStateAccess } from '../chat-recovery';
import { AppI18nProvider } from '../i18n';
import { clearSessionViewStates } from '../session-view-state';
import { StructuredAgentDockPanel } from '../StructuredAgentDockPanel';
import { TerminalConversationComposer } from './TerminalConversationComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-27T08:00:00.000Z';
const scope = { projectId: 'real-project', sessionId: 'session-1' };
const revision = { revision: 1, createdAt: NOW, updatedAt: NOW };
const snapshot: DaemonSnapshot = {
  protocolVersion: 12, revision: 2, eventSequence: 0, generatedAt: NOW,
  runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
  projects: [{ ...revision, id: scope.projectId, name: 'Project', source: 'native' }],
  workspaces: [{ ...revision, id: 'workspace', projectId: scope.projectId, name: 'Main', kind: 'local', rootPath: 'C:\\Project' }],
  sessions: [{ ...revision, id: scope.sessionId, projectId: scope.projectId, workspaceId: 'workspace', kind: 'agent', title: 'Fix the font preview', state: 'running', source: 'structured' }],
  agents: [{ ...revision, sessionId: scope.sessionId, providerId: 'codex', providerSessionId: 'provider-1', state: 'idle', permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: true }],
  providers: [{ ...revision, id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], reviewDigest: 'review', enabled: true, health: 'ready' }],
  agentRelations: [], turns: [], transcriptHeads: [], approvals: [], schedules: [], heartbeats: [],
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

async function flush(): Promise<void> {
  await act(async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); });
}

function fixture(state: ChatSessionState = { draft: { text: '' } }) {
  let stored: ChatStateSnapshot = { version: 1, scope, revision: 0, state, updatedAt: null };
  const chat: ChatStateAccess = {
    chatStateRead: vi.fn(async (): Promise<ChatStateResult> => ({ ok: true, snapshot: structuredClone(stored) })),
    chatStateWrite: vi.fn(async (_scope: ChatStateScope, request: ChatStateWrite): Promise<ChatStateResult> => {
      if (stored.revision !== request.expectedRevision) return { ok: false, error: 'stale', message: 'conflict' };
      stored = structuredClone({ ...stored, revision: stored.revision + 1, state: request.state, updatedAt: NOW });
      return { ok: true, snapshot: stored };
    }),
  };
  const send = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 3, eventSequence: 1 }));
  const capabilities: CapabilityAccess = { ...rendererCapabilities,
    daemon: { ...rendererCapabilities.daemon, getAvailability: async () => ({ state: 'ready', supportedSchemaVersion: 4, currentSchemaVersion: 4 }),
      getSnapshot: async () => snapshot, getTranscript: async () => [], sendCommand: send, observeEvents: () => () => undefined },
    structuredProviders: { ...rendererCapabilities.structuredProviders, listModels: async () => ({ ok: true, value: [] }) },
  };
  const onSent = vi.fn();
  const props = { params: { historyId: `structured-session-${scope.sessionId}` }, api: { id: 'dock-1', setTitle: vi.fn(), updateParameters: vi.fn() } } as unknown as IDockviewPanelProps;
  const render = (): void => act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <div data-testid="tab"><StructuredAgentDockPanel {...props} capabilities={capabilities} chatStateAccess={chat} /></div>
      <div data-testid="terminal">
        <TerminalConversationComposer sessionId={scope.sessionId} snapshot={snapshot} capabilities={capabilities} chatStateAccess={chat} onSent={onSent} />
      </div>
    </AppI18nProvider>,
  ));
  return { chat, send, onSent, render, stored: () => stored };
}

const inputIn = (where: 'tab' | 'terminal'): HTMLTextAreaElement =>
  container.querySelector(`[data-testid="${where}"] [data-testid="structured-agent-composer-input"]`)!;
const sendIn = (where: 'tab' | 'terminal'): HTMLButtonElement =>
  container.querySelector(`[data-testid="${where}"] [data-testid="structured-agent-send"]`)!;
function type(where: 'tab' | 'terminal', text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(inputIn(where), text);
    inputIn(where).dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('TerminalConversationComposer', () => {
  it('shows only the message box with the conversation\'s own settings', async () => {
    const { render } = fixture();
    render(); await flush();
    const terminal = container.querySelector('[data-testid="terminal"]')!;
    expect(terminal.querySelector('[data-presentation="composer"]')).not.toBeNull();
    expect(terminal.querySelector('.structured-agent-session-header')).toBeNull();
    expect(terminal.querySelector('.chat-transcript, [data-testid="structured-agent-transcript"]')).toBeNull();
    expect(terminal.querySelector('[data-testid="structured-agent-live-model"]')).not.toBeNull();
    expect(terminal.querySelector('[data-testid="structured-agent-live-permission"]')).not.toBeNull();
    expect(inputIn('terminal')).not.toBeNull();
  });

  it('shares one draft with the conversation tab: typing in either shows in both, with no conflict', async () => {
    const { chat, render, stored } = fixture({ draft: { text: 'Saved earlier' } });
    render(); await flush();
    expect(vi.mocked(chat.chatStateRead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chat.chatStateRead)).toHaveBeenCalledWith(scope);
    expect(inputIn('terminal').value).toBe('Saved earlier');
    type('terminal', 'Typed in the terminal'); await flush();
    expect(inputIn('tab').value).toBe('Typed in the terminal');
    type('tab', 'Typed in the tab'); await flush();
    expect(inputIn('terminal').value).toBe('Typed in the tab');
    expect(stored().state.draft.text).toBe('Typed in the tab');
    expect(container.textContent).not.toContain('Another window changed');
  });

  it('sends once from the terminal and clears both boxes', async () => {
    const { send, onSent, render, stored } = fixture({ draft: { text: 'Summarize the git log' } });
    render(); await flush();
    act(() => sendIn('terminal').click());
    await flush();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: 'agent.submit', payload: { sessionId: scope.sessionId, prompt: 'Summarize the git log' } });
    expect(onSent).toHaveBeenCalledWith(scope.sessionId);
    expect(inputIn('terminal').value).toBe('');
    expect(inputIn('tab').value).toBe('');
    expect(stored().state.pendingSubmit).toBeUndefined();
  });

  it('refuses a send from the tab while the terminal\'s message is still being delivered', async () => {
    const { send, render } = fixture({ draft: { text: 'First' } });
    let acknowledge!: () => void;
    send.mockImplementationOnce((command) => new Promise((resolve) => {
      acknowledge = () => resolve({ ok: true, status: 'applied', commandId: command.commandId, revision: 3, eventSequence: 1 });
    }));
    render(); await flush();
    act(() => sendIn('terminal').click());
    await flush();
    type('tab', 'Second'); await flush();
    // The tab sees the terminal's message in flight (one escrow), not a conflicting draft.
    const tab = container.querySelector('[data-testid="tab"]')!;
    expect(Array.from(tab.querySelectorAll('button')).some((button) => button.textContent === 'Check delivery')).toBe(true);
    expect(container.textContent).not.toContain('Another window changed');
    act(() => sendIn('tab').click());
    await flush();
    expect(send).toHaveBeenCalledOnce();
    await act(async () => acknowledge()); await flush();
    expect(send).toHaveBeenCalledOnce();
    expect(inputIn('tab').value).toBe('Second');
  });

  it('finds a queued message far back in the transcript and offers Stop only once every queued message is known', async () => {
    const turnRecord = { revision: 1, createdAt: NOW, updatedAt: NOW };
    const working: DaemonSnapshot = {
      ...snapshot,
      capabilities: ['agent-queue'],
      agents: [{ ...snapshot.agents[0]!, state: 'working', queuedTurnCount: 1 }],
      turns: [
        { ...turnRecord, id: 'turn-now', sessionId: scope.sessionId, commandId: 'c-now', state: 'working' },
        { ...turnRecord, id: 'turn-queued', sessionId: scope.sessionId, commandId: 'c-queued', state: 'queued', enqueueSequence: 2 },
      ] as DaemonSnapshot['turns'],
      transcriptHeads: [{ sessionId: scope.sessionId, lastSequence: 900, itemCount: 900 }] as unknown as DaemonSnapshot['transcriptHeads'],
    };
    const { chat } = fixture();
    const reads: Array<[number, number]> = [];
    const queuedAt = (sequence: number): CapabilityAccess => ({ ...rendererCapabilities,
      daemon: { ...rendererCapabilities.daemon, getSnapshot: async () => working, sendCommand: vi.fn(), observeEvents: () => () => undefined,
        getTranscript: async (_session: string, after = 0, limit = 0) => {
          reads.push([after, limit]);
          return sequence > after && sequence <= after + limit ? [{
            id: 'm-queued', sessionId: scope.sessionId, sequence, kind: 'user-message', text: 'Then update the docs', turnId: 'turn-queued',
            isDelta: false, isSensitive: false, createdAt: NOW,
          }] : [];
        } },
      structuredProviders: { ...rendererCapabilities.structuredProviders, listModels: async () => ({ ok: true, value: [] }) },
    });
    const show = async (capabilities: CapabilityAccess): Promise<void> => {
      act(() => root.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <TerminalConversationComposer sessionId={scope.sessionId} snapshot={working} capabilities={capabilities} chatStateAccess={chat} />
        </AppI18nProvider>,
      ));
      await flush();
    };
    await show(queuedAt(5));
    expect(container.querySelector('.chat-queue__item')?.textContent).toContain('Then update the docs');
    expect(container.querySelector('[data-testid="structured-agent-stop"]')).not.toBeNull();
    expect(reads[0]).toEqual([400, 500]);

    act(() => root.unmount());
    root = createRoot(container);
    // Further back than the composer looks: the message is unknown, so Stop (which would drop it) is not offered.
    await show(queuedAt(-1));
    expect(container.querySelector('.chat-queue__item')).toBeNull();
    expect(container.querySelector('[data-testid="structured-agent-stop"]')).toBeNull();
  });

  it('reads the queue again on the next snapshot after a failed read', async () => {
    const turnRecord = { revision: 1, createdAt: NOW, updatedAt: NOW };
    const working = (revision: number): DaemonSnapshot => ({
      ...snapshot, revision,
      capabilities: ['agent-queue'],
      agents: [{ ...snapshot.agents[0]!, state: 'working', queuedTurnCount: 1 }],
      turns: [
        { ...turnRecord, id: 'turn-now', sessionId: scope.sessionId, commandId: 'c-now', state: 'working' },
        { ...turnRecord, id: 'turn-queued', sessionId: scope.sessionId, commandId: 'c-queued', state: 'queued', enqueueSequence: 2 },
      ] as DaemonSnapshot['turns'],
      transcriptHeads: [{ sessionId: scope.sessionId, lastSequence: 10, itemCount: 10 }] as unknown as DaemonSnapshot['transcriptHeads'],
    });
    const { chat } = fixture();
    let fail = true;
    let reads = 0;
    const capabilities: CapabilityAccess = { ...rendererCapabilities,
      daemon: { ...rendererCapabilities.daemon, sendCommand: vi.fn(), observeEvents: () => () => undefined,
        getTranscript: async () => {
          reads += 1;
          if (fail) throw new Error('host busy');
          return [{ id: 'm', sessionId: scope.sessionId, sequence: 9, kind: 'user-message', text: 'Then update the docs', turnId: 'turn-queued',
            isDelta: false, isSensitive: false, createdAt: NOW }];
        } },
      structuredProviders: { ...rendererCapabilities.structuredProviders, listModels: async () => ({ ok: true, value: [] }) },
    };
    const show = async (revision: number): Promise<void> => {
      act(() => root.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <TerminalConversationComposer sessionId={scope.sessionId} snapshot={working(revision)} capabilities={capabilities} chatStateAccess={chat} />
        </AppI18nProvider>,
      ));
      await flush();
    };
    await show(3);
    expect(container.querySelector('[data-testid="structured-agent-stop"]')).toBeNull();
    fail = false;
    // A fresh snapshot with the same revision (the host came back): read again.
    await show(3);
    expect(container.querySelector('.chat-queue__item')?.textContent).toContain('Then update the docs');
    expect(container.querySelector('[data-testid="structured-agent-stop"]')).not.toBeNull();
    // Once found, more snapshots do not read again.
    const afterSuccess = reads;
    await show(4);
    await show(5);
    expect(reads).toBe(afterSuccess);
  });

  it('says so when the conversation is gone', async () => {
    const { chat } = fixture();
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <TerminalConversationComposer sessionId="gone" snapshot={snapshot} chatStateAccess={chat} />
      </AppI18nProvider>,
    ));
    await flush();
    expect(container.querySelector('[data-testid="terminal-ai-missing"]')).not.toBeNull();
  });
});
