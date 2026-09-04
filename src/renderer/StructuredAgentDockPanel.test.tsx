// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DaemonCommand,
  DaemonEvent,
  DaemonSnapshot,
  DaemonTranscriptItem,
} from '../shared/daemon-protocol';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import {
  mergeOptimisticTranscript,
  STRUCTURED_AGENT_DRAFT_PREFIX,
  STRUCTURED_AGENT_SESSION_PREFIX,
  StructuredAgentDockPanel,
} from './StructuredAgentDockPanel';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T09:30:00.000Z';

const snapshot: DaemonSnapshot = {
  protocolVersion: 12,
  revision: 4,
  eventSequence: 9,
  generatedAt: NOW,
  runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
  projects: [{
    id: 'project-1', name: 'EZTerminal', source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW,
  }],
  workspaces: [{
    id: 'project-1.root-1.workspace-other', projectId: 'project-1', name: 'Other', kind: 'worktree',
    rootPath: 'C:\\Working\\other', revision: 1, createdAt: NOW, updatedAt: NOW,
  }, {
    id: 'project-1.root-1.workspace-1', projectId: 'project-1', name: 'Stage 2', kind: 'worktree',
    rootPath: 'C:\\Working\\stage2', revision: 1, createdAt: NOW, updatedAt: NOW,
  }],
  sessions: [],
  agents: [],
  agentRelations: [],
  turns: [],
  transcriptHeads: [],
  approvals: [],
  providers: [{
    id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex',
    executableVersion: '1.0.0', argv: [], environmentVariableNames: [], capabilities: ['model:gpt-5'],
    enabled: true, health: 'ready', revision: 1, createdAt: NOW, updatedAt: NOW,
  }],
  schedules: [],
  heartbeats: [],
};

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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
  Object.defineProperty(window, 'ezterminal', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

describe('StructuredAgentDockPanel', () => {
  it('resolves a raw project workspace to its daemon namespace before the first agent.create', async () => {
    const sent: DaemonCommand[] = [];
    const sendDaemonCommand = vi.fn(async (command: DaemonCommand) => {
      sent.push(command);
      return {
        ok: true as const,
        status: 'applied' as const,
        commandId: command.commandId,
        revision: 5,
        eventSequence: 10,
      };
    });
    const setSubscribed = vi.fn(async () => undefined);
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        getDaemonSnapshot: vi.fn(async () => snapshot),
        getDaemonTranscript: vi.fn(async () => []),
        sendDaemonCommand,
        onDaemonEvent: vi.fn(() => () => undefined),
        setDaemonEventsSubscribed: setSubscribed,
      },
    });

    let params: Record<string, unknown> = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}test`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const updateParameters = vi.fn((next: Record<string, unknown>) => { params = next; });
    const setTitle = vi.fn();
    const props = {
      params,
      api: {
        id: 'agent-session-draft',
        getParameters: () => params,
        updateParameters,
        setTitle,
      },
    } as unknown as IDockviewPanelProps;
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    expect(sendDaemonCommand).not.toHaveBeenCalled();
    const prompt = container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-first-prompt"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(prompt, 'Create only after this send');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      prompt.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      protocolVersion: 12,
      expectedRevision: 4,
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.create',
      payload: {
        workspaceId: 'project-1.root-1.workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Create only after this send',
      },
    });
    expect(updateParameters).toHaveBeenCalledWith(expect.objectContaining({
      historyId: expect.stringMatching(new RegExp(`^${STRUCTURED_AGENT_SESSION_PREFIX}`)),
      provider: 'codex',
    }));
    expect(setTitle).toHaveBeenCalledWith('Create only after this send');
    expect(container.querySelector('[data-testid="structured-agent-session"]')).not.toBeNull();
    expect(setSubscribed).toHaveBeenNthCalledWith(1, true);
  });

  it('pages persisted transcript forward and incrementally catches transcript events', async () => {
    const sessionId = 'session-restored';
    const restoredSnapshot: DaemonSnapshot = {
      ...snapshot,
      sessions: [{
        id: sessionId,
        projectId: 'project-1',
        workspaceId: 'project-1.root-1.workspace-1',
        kind: 'agent',
        title: 'Persisted agent',
        state: 'running',
        source: 'structured',
        revision: 2,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      agents: [{
        sessionId,
        providerId: 'codex',
        providerSessionId: 'provider-session-1',
        model: 'gpt-5',
        permissionPreset: 'standard',
        state: 'working',
        queuedTurnCount: 0,
        orchestrationEnabled: true,
        revision: 2,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      transcriptHeads: [{ sessionId, lastSequence: 3, itemCount: 3 }],
    };
    const transcript: DaemonTranscriptItem[] = [
      { id: 'message-1', sessionId, sequence: 1, kind: 'user-message', text: 'Persisted prompt', isDelta: false, isSensitive: false, createdAt: NOW },
      { id: 'message-2a', sessionId, sequence: 2, kind: 'assistant-message', text: 'First ', isDelta: true, isSensitive: false, createdAt: NOW },
      { id: 'message-2b', sessionId, sequence: 3, kind: 'assistant-message', text: 'answer', isDelta: true, isSensitive: false, createdAt: NOW },
    ];
    const getTranscript = vi.fn(async (_sessionId: string, afterSequence = 0) => {
      if (afterSequence === 0) return transcript.slice(0, 2);
      return transcript.filter((item) => item.sequence > afterSequence);
    });
    let onDaemonEvent!: (event: DaemonEvent) => void;
    const stopEvents = vi.fn();
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getSnapshot: async () => restoredSnapshot,
        getTranscript,
        sendCommand: async (command) => ({
          ok: true,
          status: 'applied',
          commandId: command.commandId,
          revision: 5,
          eventSequence: 10,
        }),
        observeEvents: (listener) => {
          onDaemonEvent = listener;
          return stopEvents;
        },
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      },
      structuredProviders: {
        ...rendererCapabilities.structuredProviders,
        listModels: async () => ({ ok: true, value: [] }),
      },
    };
    const props = {
      capabilities: access,
      params: {
        historyId: `${STRUCTURED_AGENT_SESSION_PREFIX}${sessionId}`,
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
      },
      api: { id: 'persisted-agent', setTitle: vi.fn(), updateParameters: vi.fn() },
    } as unknown as IDockviewPanelProps & { capabilities: CapabilityAccess };
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();
    await flush();

    expect(getTranscript).toHaveBeenCalledWith(sessionId, 0, 500);
    expect(getTranscript).toHaveBeenCalledWith(sessionId, 2, 500);
    expect(container.textContent).toContain('Persisted prompt');
    expect(container.textContent).toContain('First answer');

    transcript.push({
      id: 'message-3',
      sessionId,
      sequence: 4,
      kind: 'tool-result',
      text: 'Incremental result',
      isDelta: false,
      isSensitive: false,
      createdAt: NOW,
    });
    act(() => onDaemonEvent({
      protocolVersion: 12,
      eventId: 'event-4',
      sequence: 10,
      revision: 5,
      occurredAt: NOW,
      kind: 'transcript.appended',
      payload: { sessionId, fromSequence: 4, toSequence: 4 },
    }));
    await flush();

    expect(getTranscript).toHaveBeenCalledWith(sessionId, 3, 500);
    expect(container.textContent).toContain('Incremental result');

    act(() => root.unmount());
    expect(stopEvents).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it('drops an optimistic user item once its persisted turn is represented', () => {
    const sessionId = 'session-1';
    const optimistic: DaemonTranscriptItem = {
      id: 'local-command-1',
      sessionId,
      sequence: 1,
      kind: 'user-message',
      text: 'Do the work',
      isDelta: false,
      isSensitive: false,
      createdAt: NOW,
    };
    const authoritative: DaemonTranscriptItem = {
      id: 'message-stable',
      sessionId,
      turnId: 'turn-stable',
      sequence: 7,
      kind: 'user-message',
      text: 'Do the work',
      isDelta: false,
      isSensitive: false,
      createdAt: NOW,
    };
    const withTurn: DaemonSnapshot = {
      ...snapshot,
      turns: [{
        id: 'turn-stable',
        sessionId,
        commandId: 'command-1',
        state: 'working',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    };

    expect(mergeOptimisticTranscript([authoritative], [optimistic], withTurn)).toEqual([authoritative]);
  });

  it('opens direct children and sends guarded lifecycle commands through the v12 authority', async () => {
    const parentSession = {
      id: 'agent-parent', projectId: 'project-1', workspaceId: 'project-1.root-1.workspace-1', kind: 'agent' as const,
      title: 'Parent', state: 'idle' as const, source: 'structured' as const,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    };
    const childSession = {
      ...parentSession,
      id: 'agent-child', title: 'Child implementation',
    };
    const grandchildSession = {
      ...parentSession,
      id: 'agent-native', title: 'Native reviewer', state: 'running' as const,
    };
    const baseAgent = {
      providerId: 'codex', model: 'gpt-5', permissionPreset: 'standard' as const,
      state: 'idle' as const, queuedTurnCount: 0, orchestrationEnabled: true,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    };
    const childSnapshot: DaemonSnapshot = {
      ...snapshot,
      sessions: [parentSession, childSession, grandchildSession],
      agents: [
        { ...baseAgent, sessionId: parentSession.id },
        { ...baseAgent, sessionId: childSession.id },
        { ...baseAgent, sessionId: grandchildSession.id, state: 'working' },
      ],
      agentRelations: [{
        id: 'relation-child', treeId: parentSession.id, parentSessionId: parentSession.id,
        childSessionId: childSession.id, owner: 'managed', depth: 1,
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }, {
        id: 'relation-native', treeId: parentSession.id, parentSessionId: childSession.id,
        childSessionId: grandchildSession.id, owner: 'provider-native', depth: 2,
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    };
    const commands: DaemonCommand[] = [];
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getSnapshot: async () => childSnapshot,
        getTranscript: async () => [],
        sendCommand: async (command) => {
          commands.push(command);
          return {
            ok: true, status: 'applied', commandId: command.commandId,
            revision: childSnapshot.revision + 1, eventSequence: childSnapshot.eventSequence + 1,
          };
        },
        observeEvents: () => () => undefined,
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: true }),
      },
      structuredProviders: {
        ...rendererCapabilities.structuredProviders,
        listModels: async () => ({ ok: true, value: [] }),
      },
    };
    const onOpenSession = vi.fn();
    const props = {
      capabilities: access,
      onOpenSession,
      params: { historyId: `${STRUCTURED_AGENT_SESSION_PREFIX}${childSession.id}` },
      api: { id: 'child-agent', setTitle: vi.fn(), updateParameters: vi.fn() },
    } as unknown as IDockviewPanelProps & {
      capabilities: CapabilityAccess;
      onOpenSession: typeof onOpenSession;
    };

    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-child"]')!.click());
    expect(onOpenSession).toHaveBeenCalledWith({
      sessionId: grandchildSession.id,
      title: grandchildSession.title,
      providerLabel: 'Codex',
    });

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-detach"]')!.click());
    await flush();
    expect(commands.at(-1)).toMatchObject({
      protocolVersion: 12,
      expectedRevision: childSnapshot.revision,
      type: 'agent.detach',
      payload: { sessionId: childSession.id },
    });
  });
});
