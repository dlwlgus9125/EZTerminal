// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionState, ChatStateResult, ChatStateScope, ChatStateSnapshot, ChatStateWrite } from '../shared/chat-state';
import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot, DaemonTranscriptItem } from '../shared/daemon-protocol';
import { LONG_RUN_CAPABILITY, type SteeredMessage } from '../shared/long-run';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import type { ChatStateAccess } from './chat-recovery';
import { chatCopy, formatClock } from './chat/copy';
import { inLongSession, LIMIT_STOP, limitStory, RESUME_AT } from './chat/long-run/long-run-fixtures';
import { AppI18nProvider } from './i18n';
import { clearRendererRecoveryState } from './renderer-recovery-state';
import { clearSessionViewStates } from './session-view-state';
import { StructuredAgentDockPanel } from './StructuredAgentDockPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-11-01T06:00:00.000Z';
const SESSION = 'session-long-run';
const scope = { projectId: 'project-1', sessionId: SESSION };
const stamp = { revision: 1, createdAt: NOW, updatedAt: NOW };

function snapshotWith(patch: Partial<DaemonSnapshot>, agent: Partial<DaemonSnapshot['agents'][number]>): DaemonSnapshot {
  return {
    protocolVersion: 12, revision: 2, eventSequence: 0, generatedAt: NOW, capabilities: [LONG_RUN_CAPABILITY, 'agent-queue'], longRunSupport: { codex: true },
    runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{ ...stamp, id: scope.projectId, name: 'Project', source: 'native' }],
    workspaces: [{ ...stamp, id: 'workspace', projectId: scope.projectId, name: 'Main', kind: 'local', rootPath: 'C:\\Project' }],
    sessions: [{ ...stamp, id: SESSION, projectId: scope.projectId, workspaceId: 'workspace', kind: 'agent', title: 'Agent', state: 'running', source: 'structured' }],
    agents: [{ ...stamp, sessionId: SESSION, providerId: 'codex', providerSessionId: 'provider-1', state: 'working', currentTurnId: 'turn-run', permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: true, ...agent }],
    providers: [{ ...stamp, id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], reviewDigest: 'review', enabled: true, health: 'ready' }],
    agentRelations: [], turns: [{ ...stamp, id: 'turn-run', sessionId: SESSION, commandId: 'c', state: 'working', startedAt: NOW }], transcriptHeads: [], approvals: [], schedules: [], heartbeats: [],
    ...patch,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearRendererRecoveryState();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); });
}

const applied = (command: DaemonCommand): DaemonCommandReceipt => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 3, eventSequence: 1 });

function mount(options: { readonly snapshot?: DaemonSnapshot; readonly transcript?: readonly DaemonTranscriptItem[]; readonly state?: ChatSessionState } = {}) {
  const snapshot = options.snapshot ?? snapshotWith({}, {});
  let stored: ChatStateSnapshot = { version: 1, scope, revision: 0, state: options.state ?? { draft: { text: '' } }, updatedAt: null };
  const chat: ChatStateAccess = {
    chatStateRead: async (): Promise<ChatStateResult> => ({ ok: true, snapshot: structuredClone(stored) }),
    chatStateWrite: async (_scope: ChatStateScope, request: ChatStateWrite): Promise<ChatStateResult> => {
      stored = structuredClone({ ...stored, revision: stored.revision + 1, state: request.state, updatedAt: NOW });
      return { ok: true, snapshot: stored };
    },
  };
  const send = vi.fn(async (command: DaemonCommand) => applied(command));
  const capabilities: CapabilityAccess = {
    ...rendererCapabilities,
    daemon: {
      ...rendererCapabilities.daemon, getAvailability: async () => ({ state: 'ready', supportedSchemaVersion: 4, currentSchemaVersion: 4 }),
      getSnapshot: async () => snapshot, getTranscript: async (_session: string, after = 0, limit = 500) => (options.transcript ?? []).filter((entry) => entry.sequence > after).slice(0, limit), sendCommand: send, observeEvents: () => () => undefined,
    },
    structuredProviders: { ...rendererCapabilities.structuredProviders, listModels: async () => ({ ok: true, value: [] }) },
  };
  const props = { params: { historyId: `structured-session-${SESSION}`, projectId: scope.projectId }, api: { id: 'dock-long-run', setTitle: vi.fn(), updateParameters: vi.fn() } } as unknown as IDockviewPanelProps;
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><StructuredAgentDockPanel {...props} capabilities={capabilities} chatStateAccess={chat} /></AppI18nProvider>));
  return { send };
}

const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => container.querySelector<T>(`[data-testid="${id}"]`);
const input = (): HTMLTextAreaElement => byId<HTMLTextAreaElement>('structured-agent-composer-input')!;

function type(text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().setSelectionRange(text.length, text.length);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(id: string): Promise<void> {
  await act(async () => { byId(id)!.click(); await Promise.resolve(); });
  await flush();
}

const commands = (send: ReturnType<typeof mount>['send']): DaemonCommand[] => send.mock.calls.map(([command]) => command);

describe('a message while a turn runs', () => {
  it('goes into that turn, and the box empties', async () => {
    const { send } = mount();
    await flush();
    type('That file only.');
    await click('structured-agent-send');
    expect(commands(send)).toMatchObject([{ type: 'agent.steer', payload: { sessionId: SESSION, turnId: 'turn-run', prompt: 'That file only.' } }]);
    expect(input().value).toBe('');
  });

  it('shows nothing in the transcript until it lands', async () => {
    mount();
    await flush();
    type('That file only.');
    await click('structured-agent-send');
    expect(container.querySelector('.chat-transcript, [data-testid="structured-agent-transcript"]')?.textContent ?? '').not.toContain('That file only.');
  });

  it('queues on a host without long-run-v1, as it does today', async () => {
    const { send } = mount({ snapshot: snapshotWith({ capabilities: ['agent-queue'] }, {}) });
    await flush();
    type('That file only.');
    await click('structured-agent-send');
    expect(commands(send)).toMatchObject([{ type: 'agent.submit', payload: { prompt: 'That file only.' } }]);
    expect(commands(send)[0]!.payload).not.toHaveProperty('notSteered');
  });

  it('queues on an AI below its measured version', async () => {
    const { send } = mount({ snapshot: snapshotWith({ longRunSupport: { codex: false } }, {}) });
    await flush();
    type('That file only.');
    await click('structured-agent-send');
    expect(commands(send)[0]?.type).toBe('agent.submit');
  });

  it('queues while the conversation has no turn of its own running', async () => {
    const { send } = mount({ snapshot: snapshotWith({ turns: [] }, { state: 'queued', currentTurnId: undefined }) });
    await flush();
    type('That file only.');
    await click('structured-agent-send');
    expect(commands(send)[0]?.type).toBe('agent.submit');
  });

  it('sends a command through the queue, which says why', async () => {
    const { send } = mount();
    await flush();
    type('/compact');
    await click('structured-agent-send');
    expect(commands(send)).toMatchObject([{ type: 'agent.submit', payload: { prompt: '/compact', notSteered: true } }]);
  });

  it('sends a reply through the queue, which says why', async () => {
    const replyTo = { messageId: 'm-1', text: 'That part.' };
    const { send } = mount({ state: { draft: { text: 'Look again.', replyTo } } });
    await flush();
    await click('structured-agent-send');
    expect(commands(send)).toMatchObject([{ type: 'agent.submit', payload: { prompt: 'Look again.', notSteered: true, context: { replyTo } } }]);
  });

  it('leaves 끊고 보내기 as it was: it stops the turn', async () => {
    const { send } = mount();
    await flush();
    type('Stop, do this first.');
    await click('structured-agent-interrupt-send');
    expect(commands(send)).toMatchObject([{ type: 'agent.interrupt-and-submit', payload: { prompt: 'Stop, do this first.' } }]);
  });
});

describe('the tray', () => {
  const FAILED: SteeredMessage = { id: 'steer-1', text: 'That file only.', state: 'failed', failure: 'refused', sentAt: NOW };
  const tray = (): DaemonSnapshot => snapshotWith({ steers: { [SESSION]: [FAILED] } }, {});

  it('shows what the snapshot holds, and sends a failed message to the queue by the person\'s word', async () => {
    const { send } = mount({ snapshot: tray() });
    await flush();
    expect(byId('chat-steer-tray')?.textContent).toContain('That file only.');
    await click('chat-steer-to-queue');
    expect(commands(send)).toMatchObject([{ type: 'agent.steer-settle', payload: { sessionId: SESSION, steerId: FAILED.id, action: 'queue' } }]);
  });

  it('puts it back in the box once the host lets it go', async () => {
    const { send } = mount({ snapshot: tray() });
    await flush();
    await click('chat-steer-to-box');
    expect(commands(send)).toMatchObject([{ type: 'agent.steer-settle', payload: { steerId: FAILED.id, action: 'box' } }]);
    expect(input().value).toBe('That file only.');
  });

  it('keeps it out of the box while the host still holds it', async () => {
    const { send } = mount({ snapshot: tray() });
    send.mockImplementation(async (command) => ({ ok: false, status: 'rejected', commandId: command.commandId, revision: 3, error: { code: 'invalid-state', message: 'HOST TEXT', retryable: false } }));
    await flush();
    await click('chat-steer-to-box');
    expect(input().value).toBe('');
    expect(container.textContent).toContain(chatCopy('en').longRun.steer.messageChanged);
    expect(container.textContent).not.toContain('HOST TEXT');
  });
});

describe('a limit card', () => {
  const stopped = (): { readonly snapshot: DaemonSnapshot; readonly transcript: readonly DaemonTranscriptItem[] } => {
    const fixture = inLongSession(limitStory('en', 'waiting', { provider: 'codex' }), SESSION);
    const limit = { stopId: LIMIT_STOP, turnId: 'turn-limit', providerId: 'codex', phase: 'waiting' as const, window: 'five-hour' as const, stoppedAt: NOW, resumeAt: RESUME_AT };
    const transcriptHeads = [{ sessionId: SESSION, lastSequence: fixture.items.length, itemCount: fixture.items.length }];
    return { transcript: fixture.items, snapshot: snapshotWith({ turns: [...fixture.turns], transcriptHeads, usageLimits: { [SESSION]: limit } }, { state: 'idle', currentTurnId: undefined }) };
  };

  it('reads from its row and presses through to the host', async () => {
    const { send } = mount(stopped());
    await flush();
    expect(byId('chat-usage-limit-card')).not.toBeNull();
    await click('chat-limit-limit-auto-off');
    expect(commands(send)).toMatchObject([{ type: 'long-run.limit-action', payload: { sessionId: SESSION, stopId: LIMIT_STOP, action: 'auto-off' } }]);
  });

  it('says what the host would not do in the app\'s own words, never the host\'s', async () => {
    const { send } = mount(stopped());
    send.mockImplementation(async (command) => ({ ok: false, status: 'rejected', commandId: command.commandId, revision: 3, error: { code: 'invalid-state', message: 'HOST TEXT', retryable: false } }));
    await flush();
    await click('chat-limit-limit-auto-off');
    expect(byId('structured-agent-wrap-up-error')?.textContent).toContain(chatCopy('en').longRun.limit.cardChanged);
    expect(byId('structured-agent-wrap-up-error')?.textContent).not.toContain('HOST TEXT');
  });

  it('sends Enter as a new message while a clock runs: no turn runs to go into', async () => {
    const { send } = mount(stopped());
    await flush();
    type('I will do it myself.');
    await click('structured-agent-send');
    expect(commands(send)).toMatchObject([{ type: 'agent.submit', payload: { prompt: 'I will do it myself.' } }]);
  });

  it('puts the clock in the header, in the same words as the list', async () => {
    mount(stopped());
    await flush();
    expect(container.querySelector('.structured-agent-state')?.textContent).toContain(`Limit wait · ${formatClock(RESUME_AT, 'en')}`);
    expect(container.querySelector('.structured-agent-state')?.getAttribute('data-state')).not.toBe('blocked');
  });

  it('stays a record on a host without long-run-v1: no buttons', async () => {
    const { snapshot, transcript } = stopped();
    mount({ snapshot: { ...snapshot, capabilities: ['agent-queue'] }, transcript });
    await flush();
    expect(byId('chat-usage-limit-card')).not.toBeNull();
    expect(byId('chat-limit-limit-auto-off')).toBeNull();
  });
});
