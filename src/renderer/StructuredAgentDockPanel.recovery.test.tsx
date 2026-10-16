// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonCommand, type DaemonCommand, type DaemonCommandReceipt, type DaemonSnapshot } from '../shared/daemon-protocol';
import type { ChatSessionState, ChatStateResult, ChatStateSnapshot, ChatStateScope, ChatStateWrite } from '../shared/chat-state';
import { StructuredAgentDockPanel } from './StructuredAgentDockPanel';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import type { ChatStateAccess } from './chat-recovery';
import { clearSessionViewStates } from './session-view-state';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = '2026-10-13T08:00:00.000Z';
const scope = { projectId: 'real-project', sessionId: 'session-1' };
const revision = { revision: 1, createdAt: NOW, updatedAt: NOW };
const snapshot: DaemonSnapshot = {
  protocolVersion: 12, revision: 2, eventSequence: 0, generatedAt: NOW,
  runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
  projects: [{ ...revision, id: scope.projectId, name: 'Project', source: 'native' }],
  workspaces: [{ ...revision, id: 'workspace', projectId: scope.projectId, name: 'Main', kind: 'local', rootPath: 'C:\\Project' }],
  sessions: [{ ...revision, id: scope.sessionId, projectId: scope.projectId, workspaceId: 'workspace', kind: 'agent', title: 'Agent', state: 'running', source: 'structured' }],
  agents: [{ ...revision, sessionId: scope.sessionId, providerId: 'codex', providerSessionId: 'provider-1', state: 'idle', permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: true }],
  providers: [{ ...revision, id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], reviewDigest: 'review', enabled: true, health: 'ready' }],
  agentRelations: [], turns: [], transcriptHeads: [], approvals: [], schedules: [], heartbeats: [],
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function flush() { await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }); }
function input(): HTMLTextAreaElement { return container.querySelector('[data-testid="structured-agent-composer-input"]')!; }
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function fixture(state: ChatSessionState = { draft: { text: 'Original draft' } }) {
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
  const props = { params: { historyId: `structured-session-${scope.sessionId}`, projectId: 'untrusted-param-project' }, api: { id: 'dock-1', setTitle: vi.fn(), updateParameters: vi.fn() } } as unknown as IDockviewPanelProps;
  const render = () => act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><StructuredAgentDockPanel {...props} capabilities={capabilities} chatStateAccess={chat} /></AppI18nProvider>));
  return { chat, send, render, stored: () => stored };
}

describe('desktop encrypted chat recovery integration', () => {
  it('uses authoritative session scope and stores an exact envelope before dispatch', async () => {
    const { chat, send, render, stored } = fixture();
    render(); await flush();
    expect(chat.chatStateRead).toHaveBeenCalledWith(scope);
    expect(input().value).toBe('Original draft');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
    await flush();
    expect(send).toHaveBeenCalledOnce();
    const firstWrite = vi.mocked(chat.chatStateWrite).mock.calls.find((call) => call[1].state.pendingSubmit);
    expect(firstWrite?.[1].state.pendingSubmit?.command).toEqual(send.mock.calls[0]?.[0]);
    expect(vi.mocked(chat.chatStateWrite).mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(stored().state.pendingSubmit).toBeUndefined();
    expect(input().value).toBe('');
  });

  it('keeps editing available while loading recovery and preserves that new draft', async () => {
    const { chat, render, stored, send } = fixture();
    let release!: () => void;
    vi.mocked(chat.chatStateRead).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, snapshot: stored() }); }));
    render(); await flush();
    expect(input().disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.disabled).toBe(true);
    type('Typed while loading');
    await act(async () => release()); await flush();
    expect(input().value).toBe('Typed while loading');
    expect(stored().state.draft.text).toBe('Typed while loading');
    expect(send).not.toHaveBeenCalled();
  });

  it('never dispatches when encrypted pending storage fails and keeps the unsent draft', async () => {
    const { chat, send, render } = fixture();
    vi.mocked(chat.chatStateWrite).mockResolvedValue({ ok: false, error: 'unavailable', message: 'Secure storage unavailable' });
    render(); await flush();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('Original draft');
    expect(container.textContent).toContain('Check stored state');
  });

  it('restores an uncertain envelope without sending, then explicitly reconciles the same ID and preserves a newer draft', async () => {
    const command = createDaemonCommand({ type: 'agent.submit', commandId: 'exact-restored', idempotencyKey: 'exact-key', expectedRevision: 1, issuedAt: NOW,
      principal: { kind: 'desktop', id: 'renderer-agent-ui' }, payload: { sessionId: scope.sessionId, prompt: 'Already sent' } });
    const { send, render, stored } = fixture({ draft: { text: 'New unsent draft' }, pendingSubmit: { command, mode: 'send', recordedAt: NOW } });
    render(); await flush();
    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('New unsent draft');
    act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Check delivery')!.click());
    await flush();
    expect(send).toHaveBeenCalledWith(command);
    expect(stored().state).toEqual({ draft: { text: 'New unsent draft' } });
    expect(input().value).toBe('New unsent draft');
  });

  it('persists newer input typed while the original message receipt is pending', async () => {
    const { send, render, stored } = fixture();
    let acknowledge!: () => void;
    send.mockImplementationOnce((command) => new Promise((resolve) => { acknowledge = () => resolve({ ok: true, status: 'applied', commandId: command.commandId, revision: 3, eventSequence: 1 }); }));
    render(); await flush();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.click());
    await flush();
    type('Another unsent message'); await flush();
    await act(async () => acknowledge()); await flush();
    expect(input().value).toBe('Another unsent message');
    expect(stored().state.draft.text).toBe('Another unsent message');
    expect(stored().state.pendingSubmit).toBeUndefined();
  });

  it('shows a CAS conflict without overwriting the stored draft or sending', async () => {
    const { chat, send, render } = fixture();
    render(); await flush();
    vi.mocked(chat.chatStateWrite).mockResolvedValueOnce({ ok: false, error: 'stale', revision: 8, message: 'conflict' });
    vi.mocked(chat.chatStateRead).mockResolvedValueOnce({ ok: true, snapshot: { version: 1, scope, revision: 8, state: { draft: { text: 'Other window draft' } }, updatedAt: NOW } } satisfies ChatStateResult);
    type('Local edited draft'); await flush();
    expect(input().value).toBe('Local edited draft');
    expect(container.textContent).toContain('Other window draft');
    expect(container.textContent).toContain('Keep this draft');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-send"]')!.disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});
