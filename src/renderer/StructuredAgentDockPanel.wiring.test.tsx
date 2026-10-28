// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApproval, DaemonCommand, DaemonEvent, DaemonSnapshot, DaemonTranscriptItem } from '../shared/daemon-protocol';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { AppI18nProvider } from './i18n';
import { STRUCTURED_AGENT_SESSION_PREFIX, StructuredAgentDockPanel } from './StructuredAgentDockPanel';
import { clearRendererRecoveryState } from './renderer-recovery-state';
import { getStructuredAgentTabStatuses, structuredTabStatus } from './structured-agent-tab-status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-15T09:30:00.000Z';
const SESSION = 'session-wired';

function snapshotWith(patch: Partial<DaemonSnapshot>): DaemonSnapshot {
  return {
    protocolVersion: 12, revision: 4, eventSequence: 9, generatedAt: NOW,
    runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{ id: 'project-1', name: 'EZTerminal', source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW }],
    workspaces: [{
      id: 'project-1.root-1.workspace-1', projectId: 'project-1', name: 'Main', kind: 'local',
      rootPath: 'C:\\Working\\main', revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    sessions: [{
      id: SESSION, projectId: 'project-1', workspaceId: 'project-1.root-1.workspace-1', kind: 'agent', title: 'Wired agent',
      state: 'running', source: 'structured', revision: 2, createdAt: NOW, updatedAt: NOW,
    }],
    agents: [{
      sessionId: SESSION, providerId: 'claude', providerSessionId: 'provider-session', model: 'opus', permissionPreset: 'plan',
      state: 'blocked', queuedTurnCount: 0, orchestrationEnabled: true, revision: 2, createdAt: NOW, updatedAt: NOW,
    }],
    agentRelations: [], turns: [], transcriptHeads: [], approvals: [],
    providers: [{
      id: 'claude', displayName: 'Claude', protocol: 'claude-agent-sdk', executablePath: 'claude',
      executableVersion: '2.1.260', argv: [], environmentVariableNames: [], capabilities: ['model:opus'],
      enabled: true, health: 'ready', revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    schedules: [], heartbeats: [],
    ...patch,
  };
}

/** Every 100th item is a prompt; the rest are empty reasoning rows the chat hides, so few rows render. */
function item(sequence: number): DaemonTranscriptItem {
  const prompt = sequence % 100 === 1;
  return {
    id: `item-${sequence}`, sessionId: SESSION, sequence, kind: prompt ? 'user-message' : 'reasoning',
    text: prompt ? `Prompt ${sequence}` : '', isDelta: false, isSensitive: false, createdAt: NOW,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

function mount(access: CapabilityAccess): void {
  const props = {
    capabilities: access,
    params: { historyId: `${STRUCTURED_AGENT_SESSION_PREFIX}${SESSION}`, projectId: 'project-1', rootId: 'root-1', workspaceId: 'workspace-1' },
    api: { id: 'wired-agent', setTitle: vi.fn(), updateParameters: vi.fn() },
  } as unknown as IDockviewPanelProps & { capabilities: CapabilityAccess };
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><StructuredAgentDockPanel {...props} /></AppI18nProvider>));
}

function daemon(snapshot: DaemonSnapshot, transcript: readonly DaemonTranscriptItem[], overrides: Partial<CapabilityAccess['daemon']> = {}) {
  const getTranscript = vi.fn(async (_session: string, after = 0, limit = 500) => transcript.filter((entry) => entry.sequence > after).slice(0, limit));
  const getSnapshot = vi.fn(async () => snapshot);
  const sendCommand = vi.fn(async (command: DaemonCommand) => ({ ok: true as const, status: 'applied' as const, commandId: command.commandId, revision: 5, eventSequence: 10 }));
  let emit: (event: DaemonEvent) => void = () => undefined;
  const access: CapabilityAccess = {
    ...rendererCapabilities,
    daemon: {
      getAvailability: async () => ({ state: 'ready' as const, supportedSchemaVersion: 3, currentSchemaVersion: 3 }),
      getSnapshot,
      getTranscript,
      sendCommand,
      observeEvents: (listener) => { emit = listener; return () => undefined; },
      getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      ...overrides,
    },
    structuredProviders: { ...rendererCapabilities.structuredProviders, listModels: async () => ({ ok: true, value: [] }) },
  };
  return { access, getTranscript, getSnapshot, sendCommand, emit: (event: DaemonEvent) => emit(event) };
}

beforeEach(() => {
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

describe('StructuredAgentDockPanel wiring', () => {
  it('opens a long conversation at its tail and loads earlier pages on request', async () => {
    const transcript = Array.from({ length: 2003 }, (_, index) => item(index + 1));
    const { access, getTranscript } = daemon(snapshotWith({
      transcriptHeads: [{ sessionId: SESSION, lastSequence: 2003, itemCount: 2003 }],
    }), transcript);
    mount(access);
    await flush();

    expect(getTranscript.mock.calls[0]).toEqual([SESSION, 503, 500]);
    expect(getTranscript.mock.calls.some(([, after]) => after === 0)).toBe(false);
    expect(container.textContent).toContain('Prompt 2001');
    expect(container.textContent).not.toContain('Prompt 401');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-load-earlier"]')!.click());
    await flush();
    expect(getTranscript).toHaveBeenCalledWith(SESSION, 3, 500);
    expect(container.textContent).toContain('Prompt 401');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-load-earlier"]')!.click());
    await flush();
    expect(getTranscript).toHaveBeenCalledWith(SESSION, 0, 3);
    expect(container.textContent).toContain('Prompt 1');
    expect(container.querySelector('[data-testid="chat-load-earlier"]')).toBeNull();
  });

  it('extends a tail that holds no prompt (old streamed-delta sessions)', async () => {
    const transcript = Array.from({ length: 2000 }, (_, index): DaemonTranscriptItem => (index === 0 ? item(1) : {
      ...item(index + 1), kind: 'assistant-message', isDelta: true, messageId: 'reply', text: 'x',
    }));
    const { access, getTranscript } = daemon(snapshotWith({
      transcriptHeads: [{ sessionId: SESSION, lastSequence: 2000, itemCount: 2000 }],
    }), transcript);
    mount(access);
    await flush();
    await flush();

    expect(getTranscript.mock.calls[0]).toEqual([SESSION, 500, 500]);
    expect(getTranscript).toHaveBeenCalledWith(SESSION, 0, 500);
    expect(container.textContent).toContain('Prompt 1');
  });

  it('syncs transcript appends without re-reading the snapshot', async () => {
    const transcript = [item(1)];
    const { access, getSnapshot, getTranscript, emit } = daemon(snapshotWith({
      transcriptHeads: [{ sessionId: SESSION, lastSequence: 1, itemCount: 1 }],
    }), transcript);
    mount(access);
    await flush();
    const snapshots = getSnapshot.mock.calls.length;

    transcript.push({ ...item(2), kind: 'assistant-message', text: 'Streaming reply', isDelta: true, messageId: 'reply' });
    act(() => emit({
      protocolVersion: 12, eventId: 'event-2', sequence: 11, revision: 5, occurredAt: NOW,
      kind: 'transcript.appended', payload: { sessionId: SESSION, fromSequence: 2, toSequence: 2 },
    }));
    await flush();
    expect(getTranscript).toHaveBeenCalledWith(SESSION, 1, 500);
    expect(container.textContent).toContain('Streaming reply');
    expect(getSnapshot.mock.calls.length).toBe(snapshots);

    act(() => emit({
      protocolVersion: 12, eventId: 'event-3', sequence: 12, revision: 6, occurredAt: NOW,
      kind: 'entity.upserted', payload: { entityType: 'agent', entityId: SESSION },
    }));
    await flush();
    expect(getSnapshot.mock.calls.length).toBe(snapshots + 1);
  });

  it('asks for a provider’s models once while snapshots keep changing, and keeps the answer', async () => {
    const base = snapshotWith({ transcriptHeads: [{ sessionId: SESSION, lastSequence: 1, itemCount: 1 }] });
    let revision = base.revision;
    const { access, emit } = daemon(base, [item(1)], { getSnapshot: vi.fn(async () => ({ ...base, revision: ++revision })) });
    type Listing = Awaited<ReturnType<CapabilityAccess['structuredProviders']['listModels']>>;
    let answer!: (value: Listing) => void;
    const listModels = vi.fn(() => new Promise<Listing>((resolve) => { answer = resolve; }));
    mount({ ...access, structuredProviders: { ...access.structuredProviders, listModels } });
    await flush();
    expect(listModels).toHaveBeenCalledTimes(1);

    // Claude answers by launching its CLI, which takes seconds; the daemon changes the snapshot many times meanwhile.
    for (let index = 0; index < 3; index += 1) {
      act(() => emit({
        protocolVersion: 12, eventId: `event-models-${index}`, sequence: 20 + index, revision: 20 + index, occurredAt: NOW,
        kind: 'entity.upserted', payload: { entityType: 'agent', entityId: SESSION },
      }));
      await flush();
    }
    expect(listModels).toHaveBeenCalledTimes(1);

    act(() => answer({ ok: true, value: [{ id: 'opus', displayName: 'Opus from the CLI', supportsReasoning: true, isDefault: true }] }));
    await flush();
    expect(container.querySelector('[data-testid="structured-agent-live-model"]')?.textContent).toContain('Opus from the CLI');
    act(() => emit({
      protocolVersion: 12, eventId: 'event-models-after', sequence: 30, revision: 30, occurredAt: NOW,
      kind: 'entity.upserted', payload: { entityType: 'agent', entityId: SESSION },
    }));
    await flush();
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('publishes its tab status and clears it when the panel closes', async () => {
    const { access } = daemon(snapshotWith({ transcriptHeads: [{ sessionId: SESSION, lastSequence: 1, itemCount: 1 }] }), [item(1)]);
    mount(access);
    await flush();
    expect(getStructuredAgentTabStatuses().get('wired-agent')).toEqual({ status: 'blocked', provider: 'claude', providerLabel: 'Claude' });
    act(() => root.unmount());
    expect(getStructuredAgentTabStatuses().has('wired-agent')).toBe(false);
    root = createRoot(container);
  });

  it('maps managed Agent states to tab dots', () => {
    expect(structuredTabStatus('working', false)).toBe('working');
    expect(structuredTabStatus('delivery-uncertain', false)).toBe('blocked');
    expect(structuredTabStatus('idle', false)).toBeUndefined();
    expect(structuredTabStatus('idle', true)).toBe('done');
    expect(structuredTabStatus('archived', false)).toBeUndefined();
  });

  const planApproval: DaemonApproval = {
    id: 'approval-plan', sessionId: SESSION, providerRequestId: 'request-plan', risk: 'write', title: 'Approve plan',
    state: 'pending', request: { v: 1, kind: 'plan', callId: 'call-plan', markdown: '- Add farewell()' },
    revision: 1, createdAt: NOW, updatedAt: NOW,
  };

  it.each([
    { capabilities: ['approval-response-v1'], response: { kind: 'plan', mode: 'standard' } },
    { capabilities: [], response: undefined },
  ])('sends an approval response only to hosts that accept it ($capabilities)', async ({ capabilities, response }) => {
    const { access, sendCommand } = daemon(snapshotWith({
      capabilities, approvals: [planApproval],
      transcriptHeads: [{ sessionId: SESSION, lastSequence: 1, itemCount: 1 }],
    }), [item(1)]);
    mount(access);
    await flush();

    const approve = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Run this plan');
    expect(approve).toBeDefined();
    act(() => approve!.click());
    await flush();
    const resolve = sendCommand.mock.calls.map(([command]) => command).find((command) => command.type === 'permission.resolve');
    expect(resolve?.payload).toEqual({ approvalId: 'approval-plan', decision: 'allow', ...(response ? { response } : {}) });
  });
});

describe('StructuredAgentDockPanel command authority', () => {
  it('builds a command on the snapshot after the last commit, not on a read already in flight', async () => {
    const base = snapshotWith({
      agents: [{
        sessionId: SESSION, providerId: 'claude', providerSessionId: 'provider-session', model: 'opus', permissionPreset: 'standard',
        state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true, revision: 2, createdAt: NOW, updatedAt: NOW,
      }],
      transcriptHeads: [{ sessionId: SESSION, lastSequence: 1, itemCount: 1 }],
    });
    let revision = base.revision;
    let hold = false;
    let release: (() => void) | undefined;
    const getSnapshot = vi.fn(() => {
      const current = { ...base, revision };
      if (!hold) return Promise.resolve(current);
      hold = false;
      return new Promise<DaemonSnapshot>((resolve) => { release = () => resolve(current); });
    });
    const { access, sendCommand, emit } = daemon(base, [item(1)], { getSnapshot });
    mount(access);
    await flush();

    // A refresh starts; before it answers, a command commits and the revision moves on.
    hold = true;
    act(() => emit({
      protocolVersion: 12, eventId: 'event-race', sequence: 30, revision: 30, occurredAt: NOW,
      kind: 'entity.upserted', payload: { entityType: 'agent', entityId: SESSION },
    }));
    await flush();
    revision += 1;
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-live-plan"]')!.click());
    await flush();
    release?.();
    await flush();
    const settings = sendCommand.mock.calls.map(([command]) => command).find((command) => command.type === 'agent.set-settings');
    expect(settings?.expectedRevision).toBe(revision);
  });
});

describe('StructuredAgentDockPanel queued settings (agent-settings-v2)', () => {
  it('shows the next request on the pills, the running turn on the line, and cancels or rescopes on the host', async () => {
    const { access, sendCommand } = daemon(snapshotWith({
      capabilities: ['agent-effort-v1', 'agent-settings-v2'],
      agents: [{
        sessionId: SESSION, providerId: 'claude', providerSessionId: 'provider-session', model: 'opus', permissionPreset: 'standard', reasoningEffort: 'high',
        state: 'working', currentTurnId: 'turn-1', queuedTurnCount: 0, orchestrationEnabled: true, revision: 2, createdAt: NOW, updatedAt: NOW,
      }],
      turns: [{ id: 'turn-1', sessionId: SESSION, commandId: 'command-1', state: 'working', revision: 1, createdAt: NOW, updatedAt: NOW }],
      pendingAgentSettings: { [SESSION]: { reasoningEffort: 'medium', effortScope: 'keep' } },
      transcriptHeads: [{ sessionId: SESSION, lastSequence: 1, itemCount: 1 }],
    }), [item(1)]);
    mount(access);
    await flush();

    const line = container.querySelector('[data-testid="structured-agent-pending-settings"]');
    expect(line?.textContent).toContain('This turn');
    expect(line?.textContent).toContain('High');
    expect(line?.textContent).toContain('Medium');
    expect(container.querySelector('[data-testid="structured-agent-live-effort"]')?.textContent).toContain('Medium');

    act(() => container.querySelector<HTMLInputElement>('input[type="radio"][value="once"]')!.click());
    await flush();
    act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel change')!.click());
    await flush();
    const payloads = sendCommand.mock.calls.map(([command]) => command).filter((command) => command.type === 'agent.set-settings').map((command) => command.payload);
    expect(payloads).toEqual([
      { sessionId: SESSION, reasoningEffort: 'medium', scope: 'once' },
      { sessionId: SESSION, clearPending: true },
    ]);
  });
});
