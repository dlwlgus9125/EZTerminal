// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonEvent,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
} from '../shared/daemon-protocol';
import { LAYOUT_SCHEMA_VERSION } from '../shared/layout-schema';
import {
  RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES,
  RENDERER_RECOVERY_VERSION,
  type RendererRecoveryCheckpoint,
} from '../shared/renderer-recovery';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import {
  mergeOptimisticTranscript,
  STRUCTURED_AGENT_DRAFT_PREFIX,
  STRUCTURED_AGENT_SESSION_PREFIX,
  StructuredAgentDockPanel,
} from './StructuredAgentDockPanel';
import { AppI18nProvider } from './i18n';
import {
  clearRendererRecoveryState,
  peekRendererRecoveryStructuredAgentCreate,
  seedRendererRecoveryState,
} from './renderer-recovery-state';
import { StructuredAgentCreateRecoveryRegistry } from './structured-agent-create-recovery';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T09:30:00.000Z';
const getReadyAvailability = () => Promise.resolve({
  state: 'ready' as const,
  supportedSchemaVersion: 3,
  currentSchemaVersion: 3,
});

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
  clearRendererRecoveryState();
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
    const createRecoveryRegistry = new StructuredAgentCreateRecoveryRegistry();
    const persistCreateRecovery = vi.fn(async () => true);
    const props = {
      createRecoveryRegistry,
      persistCreateRecovery,
      params,
      api: {
        id: 'agent-session-structured-draft-test',
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
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    expect(sent).toHaveLength(1);
    expect(persistCreateRecovery.mock.invocationCallOrder[0])
      .toBeLessThan(sendDaemonCommand.mock.invocationCallOrder[0]!);
    expect(sent[0]).toMatchObject({
      protocolVersion: 12,
      expectedRevision: 4,
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.create',
      payload: {
        workspaceId: 'project-1.root-1.workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
      },
    });
    expect(updateParameters).toHaveBeenCalledWith(expect.objectContaining({
      historyId: expect.stringMatching(new RegExp(`^${STRUCTURED_AGENT_SESSION_PREFIX}`)),
      provider: 'codex',
    }));
    expect(setTitle).toHaveBeenCalledWith('Codex');
    expect(container.querySelector('[data-testid="structured-agent-session"]')).not.toBeNull();
    expect(setSubscribed).toHaveBeenNthCalledWith(1, true);
  });

  it('does not cross the transport boundary when main rejects pre-send recovery escrow', async () => {
    const sendDaemonCommand = vi.fn();
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        getDaemonSnapshot: vi.fn(async () => snapshot),
        getDaemonTranscript: vi.fn(async () => []),
        sendDaemonCommand,
        onDaemonEvent: vi.fn(() => () => undefined),
        setDaemonEventsSubscribed: vi.fn(async () => undefined),
      },
    });
    const createRecoveryRegistry = new StructuredAgentCreateRecoveryRegistry();
    const persistCreateRecovery = vi.fn(async () => false);
    const params = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}escrow-failure`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const props = {
      createRecoveryRegistry,
      persistCreateRecovery,
      params,
      api: {
        id: 'agent-session-structured-draft-escrow-failure',
        getParameters: () => params,
        updateParameters: vi.fn(),
        setTitle: vi.fn(),
      },
    } as unknown as IDockviewPanelProps;
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    expect(persistCreateRecovery).toHaveBeenCalledOnce();
    expect(sendDaemonCommand).not.toHaveBeenCalled();
    expect(createRecoveryRegistry.blocksWorkspaceReplacement()).toBe(false);
    expect(container.textContent).toContain('No command was sent');
  });

  it('fails closed before send when recovery registry is already at checkpoint capacity', async () => {
    const sendDaemonCommand = vi.fn(async (command: DaemonCommand) => ({
      ok: true as const,
      status: 'applied' as const,
      commandId: command.commandId,
      revision: snapshot.revision + 1,
      eventSequence: snapshot.eventSequence + 1,
    }));
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        getDaemonSnapshot: vi.fn(async () => snapshot),
        getDaemonTranscript: vi.fn(async () => []),
        sendDaemonCommand,
        onDaemonEvent: vi.fn(() => () => undefined),
        setDaemonEventsSubscribed: vi.fn(async () => undefined),
      },
    });
    const createRecoveryRegistry = new StructuredAgentCreateRecoveryRegistry();
    for (let index = 0; index < RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES; index += 1) {
      const commandId = `existing-command-${index}`;
      const sessionId = `existing-agent-${index}`;
      createRecoveryRegistry.register({
        panelId: `agent-session-structured-draft-existing-${index}`,
        historyId: `structured-draft-existing-${index}`,
        sessionId,
        phase: 'sending',
        command: createDaemonCommand({
          commandId,
          idempotencyKey: commandId,
          expectedRevision: snapshot.revision,
          issuedAt: NOW,
          principal: { kind: 'desktop', id: 'renderer-agent-ui' },
          type: 'agent.create',
          payload: {
            sessionId,
            workspaceId: 'project-1.root-1.workspace-1',
            title: `Existing Agent ${index}`,
            providerId: 'codex',
            permissionPreset: 'standard',
            initialPrompt: `Keep existing recovery ${index}`,
          },
        }),
      });
    }
    const clearRecovery = vi.spyOn(createRecoveryRegistry, 'clear');
    const persistCreateRecovery = vi.fn(async () => true);
    const params = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}overflow`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const props = {
      createRecoveryRegistry,
      persistCreateRecovery,
      params,
      api: {
        id: 'agent-session-structured-draft-overflow',
        getParameters: () => params,
        updateParameters: vi.fn(),
        setTitle: vi.fn(),
      },
    } as unknown as IDockviewPanelProps;
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    expect(sendDaemonCommand).not.toHaveBeenCalled();
    expect(persistCreateRecovery).not.toHaveBeenCalled();
    expect(createRecoveryRegistry.list()).toHaveLength(
      RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES,
    );
    expect(createRecoveryRegistry.get('agent-session-structured-draft-overflow')).toBeUndefined();
    expect(createRecoveryRegistry.get('agent-session-structured-draft-existing-0')).toBeDefined();
    expect(clearRecovery).toHaveBeenCalledWith(
      'agent-session-structured-draft-overflow',
      expect.stringMatching(/^command-/u),
    );
    expect(container.textContent).toContain('No command was sent');
  });

  it('locks an uncertain draft and replays its exact create command after a fresh snapshot check', async () => {
    const sent: DaemonCommand[] = [];
    const getSnapshot = vi.fn(async () => snapshot);
    const sendCommand = vi.fn(async (command: DaemonCommand) => {
      sent.push(command);
      if (sent.length === 1) {
        return {
          ok: false as const,
          status: 'delivery-uncertain' as const,
          commandId: command.commandId,
          revision: snapshot.revision,
          error: {
            code: 'delivery-uncertain' as const,
            message: 'The connection closed before acknowledgement.',
            retryable: true,
          },
        };
      }
      return {
        ok: true as const,
        status: 'replayed' as const,
        commandId: command.commandId,
        revision: snapshot.revision + 1,
        eventSequence: snapshot.eventSequence + 1,
      };
    });
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getAvailability: getReadyAvailability,
        getSnapshot,
        getTranscript: async () => [],
        sendCommand,
        observeEvents: () => () => undefined,
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      },
      structuredProviders: {
        ...rendererCapabilities.structuredProviders,
        listModels: async () => ({ ok: true, value: [] }),
      },
    };
    let params: Record<string, unknown> = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}uncertain`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const updateParameters = vi.fn((next: Record<string, unknown>) => { params = next; });
    const setTitle = vi.fn();
    const createRecoveryRegistry = new StructuredAgentCreateRecoveryRegistry();
    const props = {
      capabilities: access,
      createRecoveryRegistry,
      persistCreateRecovery: vi.fn(async () => true),
      params,
      api: {
        id: 'agent-session-structured-draft-uncertain',
        getParameters: () => params,
        updateParameters,
        setTitle,
      },
    } as unknown as IDockviewPanelProps & { capabilities: CapabilityAccess };
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    expect(sent).toHaveLength(1);
    const originalCommand = sent[0]!;
    expect(originalCommand.type).toBe('agent.create');
    if (originalCommand.type !== 'agent.create') throw new Error('Expected agent.create.');
    expect(updateParameters).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('This exact draft is locked');
    expect(container.querySelector<HTMLSelectElement>('[data-testid="structured-agent-provider"]')?.disabled)
      .toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[data-testid="structured-agent-model"]')?.disabled)
      .toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[data-testid="structured-agent-workspace"]')?.disabled)
      .toBe(true);
    expect(container.querySelector<HTMLFieldSetElement>('.structured-agent-permissions')?.disabled)
      .toBe(true);
    expect(container.querySelector('[data-testid="structured-agent-first-prompt"]')).toBeNull();
    const retrySend = container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!;
    expect(retrySend.disabled).toBe(false);

    act(() => retrySend.click());
    await flush();
    await flush();

    expect(sent).toHaveLength(2);
    expect(getSnapshot.mock.invocationCallOrder[2])
      .toBeLessThan(sendCommand.mock.invocationCallOrder[1]!);
    const replayedCommand = sent[1]!;
    expect(replayedCommand.type).toBe('agent.create');
    if (replayedCommand.type !== 'agent.create') throw new Error('Expected agent.create replay.');
    expect(replayedCommand).toBe(originalCommand);
    expect(replayedCommand.commandId).toBe(originalCommand.commandId);
    expect(replayedCommand.idempotencyKey).toBe(originalCommand.idempotencyKey);
    expect(replayedCommand.payload.sessionId).toBe(originalCommand.payload.sessionId);
    expect(new Set(sent.map((command) => command.commandId))).toEqual(new Set([originalCommand.commandId]));
    expect(new Set(sent.map((command) => command.type === 'agent.create'
      ? command.payload.sessionId
      : 'unexpected'))).toEqual(new Set([originalCommand.payload.sessionId]));

    expect(updateParameters).toHaveBeenCalledOnce();
    expect(updateParameters).toHaveBeenCalledWith(expect.objectContaining({
      historyId: `${STRUCTURED_AGENT_SESSION_PREFIX}${originalCommand.payload.sessionId}`,
      provider: 'codex',
    }));
    expect(setTitle).toHaveBeenCalledWith('Codex');
    expect(container.querySelectorAll('[data-testid="structured-agent-session"]')).toHaveLength(1);
    expect(container.querySelector('[data-session-id]')?.getAttribute('data-session-id'))
      .toBe(originalCommand.payload.sessionId);
    expect(container.querySelector('[data-kind="user-message"]')).toBeNull();
  });

  it('retains an uncertain exact create across panel unmount and remount', async () => {
    const registry = new StructuredAgentCreateRecoveryRegistry();
    const sent: DaemonCommand[] = [];
    const getSnapshot = vi.fn(async () => snapshot);
    const sendCommand = vi.fn(async (command: DaemonCommand) => {
      sent.push(command);
      if (sent.length === 1) {
        return {
          ok: false as const,
          status: 'delivery-uncertain' as const,
          commandId: command.commandId,
          revision: snapshot.revision,
          error: {
            code: 'delivery-uncertain' as const,
            message: 'The connection closed before acknowledgement.',
            retryable: true,
          },
        };
      }
      return {
        ok: true as const,
        status: 'replayed' as const,
        commandId: command.commandId,
        revision: snapshot.revision + 1,
        eventSequence: snapshot.eventSequence + 1,
      };
    });
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getAvailability: getReadyAvailability,
        getSnapshot,
        getTranscript: async () => [],
        sendCommand,
        observeEvents: () => () => undefined,
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      },
      structuredProviders: {
        ...rendererCapabilities.structuredProviders,
        listModels: async () => ({ ok: true, value: [] }),
      },
    };
    let params: Record<string, unknown> = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}remount`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const updateParameters = vi.fn((next: Record<string, unknown>) => { params = next; });
    const panelProps = {
      capabilities: access,
      createRecoveryRegistry: registry,
      persistCreateRecovery: vi.fn(async () => true),
      params,
      api: {
        id: 'agent-session-structured-draft-remount',
        getParameters: () => params,
        updateParameters,
        setTitle: vi.fn(),
      },
    } as unknown as IDockviewPanelProps & {
      capabilities: CapabilityAccess;
      createRecoveryRegistry: StructuredAgentCreateRecoveryRegistry;
    };
    const render = (): void => {
      root.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <StructuredAgentDockPanel {...panelProps} />
        </AppI18nProvider>,
      );
    };
    act(render);
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    const originalCommand = sent[0]!;
    expect(originalCommand.type).toBe('agent.create');
    if (originalCommand.type !== 'agent.create') throw new Error('Expected agent.create.');
    expect(registry.get('agent-session-structured-draft-remount')?.command).toBe(originalCommand);
    expect(registry.blocksPanelClose('agent-session-structured-draft-remount')).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    act(render);
    await flush();

    expect(container.querySelector('[data-testid="structured-agent-first-prompt"]')).toBeNull();
    expect(container.querySelector('[data-testid="structured-agent-first-prompt"]')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>(
      '[data-testid="structured-agent-create"]',
    )!.click());
    await flush();
    await flush();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(originalCommand);
    expect(new Set(sent.map((command) => command.commandId))).toEqual(new Set([originalCommand.commandId]));
    expect(new Set(sent.map((command) => command.type === 'agent.create'
      ? command.payload.sessionId
      : 'unexpected'))).toEqual(new Set([originalCommand.payload.sessionId]));
    expect(registry.get('agent-session-structured-draft-remount')).toBeUndefined();
    expect(updateParameters).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('[data-testid="structured-agent-session"]')).toHaveLength(1);
  });

  it('restores a crash checkpoint through StrictMode and consumes it only after registry transfer', async () => {
    const registry = new StructuredAgentCreateRecoveryRegistry();
    const command = createDaemonCommand({
      commandId: 'command-crash-recovery',
      idempotencyKey: 'command-crash-recovery',
      expectedRevision: snapshot.revision,
      issuedAt: NOW,
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.create',
      payload: {
        sessionId: 'agent-crash-recovery',
        workspaceId: 'project-1.root-1.workspace-1',
        title: 'Recover after renderer crash',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Recover after renderer crash',
      },
    });
    const checkpoint: RendererRecoveryCheckpoint = {
      version: RENDERER_RECOVERY_VERSION,
      savedAt: Date.parse(NOW),
      layout: {
        schemaVersion: LAYOUT_SCHEMA_VERSION,
        savedAt: NOW,
        layout: {
          grid: {
            root: { type: 'branch', data: [] },
            width: 800,
            height: 600,
            orientation: 'HORIZONTAL',
          },
          panels: {
            'agent-session-structured-draft-crash-recovery': {
              id: 'agent-session-structured-draft-crash-recovery',
              contentComponent: 'agent-session',
              renderer: 'always',
              params: { historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}crash-recovery` },
            },
          },
        },
      },
      panes: [],
      structuredAgentCreates: [{
        panelId: 'agent-session-structured-draft-crash-recovery',
        historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}crash-recovery`,
        sessionId: 'agent-crash-recovery',
        phase: 'delivery-uncertain',
        command,
      }],
      activePanelId: 'agent-session-structured-draft-crash-recovery',
    };
    seedRendererRecoveryState(checkpoint);
    const sendCommand = vi.fn(async () => ({
      ok: true as const,
      status: 'replayed' as const,
      commandId: command.commandId,
      revision: snapshot.revision + 1,
      eventSequence: snapshot.eventSequence + 1,
    }));
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getAvailability: getReadyAvailability,
        getSnapshot: async () => snapshot,
        getTranscript: async () => [],
        sendCommand,
        observeEvents: () => () => undefined,
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      },
      structuredProviders: {
        ...rendererCapabilities.structuredProviders,
        listModels: async () => ({ ok: true, value: [] }),
      },
    };
    const params = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}crash-recovery`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const props = {
      capabilities: access,
      createRecoveryRegistry: registry,
      persistCreateRecovery: vi.fn(async () => true),
      params,
      api: {
        id: 'agent-session-structured-draft-crash-recovery',
        getParameters: () => params,
        updateParameters: vi.fn(),
        setTitle: vi.fn(),
      },
    } as unknown as IDockviewPanelProps & {
      capabilities: CapabilityAccess;
      createRecoveryRegistry: StructuredAgentCreateRecoveryRegistry;
    };

    act(() => root.render(
      <StrictMode>
        <AppI18nProvider locale="en" languages={['en']}>
          <StructuredAgentDockPanel {...props} />
        </AppI18nProvider>
      </StrictMode>,
    ));
    await flush();

    expect(container.querySelector('[data-testid="structured-agent-first-prompt"]')).toBeNull();
    expect(registry.get('agent-session-structured-draft-crash-recovery')?.command).toBe(command);
    expect(peekRendererRecoveryStructuredAgentCreate('agent-session-structured-draft-crash-recovery')).toBeUndefined();

    act(() => container.querySelector<HTMLButtonElement>(
      '[data-testid="structured-agent-create"]',
    )!.click());
    await flush();
    await flush();

    expect(sendCommand).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith(command);
    expect(registry.get('agent-session-structured-draft-crash-recovery')).toBeUndefined();
    expect(container.querySelectorAll('[data-testid="structured-agent-session"]')).toHaveLength(1);
  });

  it('does not create from a cached display snapshot when the fresh read fails', async () => {
    const getSnapshot = vi.fn()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValue(new Error('offline'));
    const sendCommand = vi.fn();
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getAvailability: getReadyAvailability,
        getSnapshot,
        getTranscript: async () => [],
        sendCommand,
        observeEvents: () => () => undefined,
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      },
      structuredProviders: {
        ...rendererCapabilities.structuredProviders,
        listModels: async () => ({ ok: true, value: [] }),
      },
    };
    const params = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}fresh-required`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const props = {
      capabilities: access,
      params,
      api: {
        id: 'agent-session-fresh-required',
        getParameters: () => params,
        updateParameters: vi.fn(),
        setTitle: vi.fn(),
      },
    } as unknown as IDockviewPanelProps & { capabilities: CapabilityAccess };
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(container.textContent).toContain('The Agent daemon is unavailable.');
    expect(container.querySelector('[data-testid="structured-agent-draft"]')).not.toBeNull();
  });

  it('keeps an uncertain recovery escrowed when its fresh confirmation is unavailable', async () => {
    const registry = new StructuredAgentCreateRecoveryRegistry();
    let snapshotUnavailable = false;
    const getSnapshot = vi.fn(async () => snapshotUnavailable ? null : snapshot);
    const sendCommand = vi.fn(async (command: DaemonCommand) => ({
      ok: false as const,
      status: 'delivery-uncertain' as const,
      commandId: command.commandId,
      revision: snapshot.revision,
      error: {
        code: 'delivery-uncertain' as const,
        message: 'The connection closed before acknowledgement.',
        retryable: true,
      },
    }));
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getAvailability: getReadyAvailability,
        getSnapshot,
        getTranscript: async () => [],
        sendCommand,
        observeEvents: () => () => undefined,
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      },
      structuredProviders: {
        ...rendererCapabilities.structuredProviders,
        listModels: async () => ({ ok: true, value: [] }),
      },
    };
    const params = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}unavailable-recovery`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const props = {
      capabilities: access,
      createRecoveryRegistry: registry,
      persistCreateRecovery: vi.fn(async () => true),
      params,
      api: {
        id: 'agent-session-structured-draft-unavailable-recovery',
        getParameters: () => params,
        updateParameters: vi.fn(),
        setTitle: vi.fn(),
      },
    } as unknown as IDockviewPanelProps & {
      capabilities: CapabilityAccess;
      createRecoveryRegistry: StructuredAgentCreateRecoveryRegistry;
    };
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    expect(sendCommand).toHaveBeenCalledOnce();
    const originalCommand = sendCommand.mock.calls[0]![0];
    snapshotUnavailable = true;
    act(() => container.querySelector<HTMLButtonElement>(
      '[data-testid="structured-agent-create"]',
    )!.click());
    await flush();

    expect(sendCommand).toHaveBeenCalledOnce();
    expect(registry.get('agent-session-structured-draft-unavailable-recovery')?.command).toBe(originalCommand);
    expect(registry.blocksPanelClose('agent-session-structured-draft-unavailable-recovery')).toBe(true);
    expect([...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(' '))
      .toContain('Delivery was not retried');
    expect(container.querySelector('[data-testid="structured-agent-first-prompt"]')).toBeNull();
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
        getAvailability: getReadyAvailability,
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

  it('reopens archived history with retry and related navigation but no mutation affordances', async () => {
    const sessionId = 'session-archived';
    const childSessionId = 'session-related';
    const archivedSnapshot: DaemonSnapshot = {
      ...snapshot,
      sessions: [{
        id: sessionId,
        projectId: 'project-1',
        workspaceId: 'project-1.root-1.workspace-1',
        kind: 'agent',
        title: 'Archived daemon history',
        state: 'archived',
        source: 'structured',
        archivedAt: NOW,
        revision: 3,
        createdAt: NOW,
        updatedAt: NOW,
      }, {
        id: childSessionId,
        projectId: 'project-1',
        workspaceId: 'project-1.root-1.workspace-1',
        kind: 'agent',
        title: 'Related Agent',
        state: 'idle',
        source: 'structured',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      agents: [{
        sessionId,
        providerId: 'codex',
        permissionPreset: 'standard',
        state: 'archived',
        queuedTurnCount: 0,
        orchestrationEnabled: true,
        revision: 3,
        createdAt: NOW,
        updatedAt: NOW,
      }, {
        sessionId: childSessionId,
        providerId: 'codex',
        permissionPreset: 'standard',
        state: 'idle',
        queuedTurnCount: 0,
        orchestrationEnabled: true,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      agentRelations: [{
        id: 'archived-related',
        treeId: sessionId,
        parentSessionId: sessionId,
        childSessionId,
        owner: 'managed',
        depth: 1,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      approvals: [{
        id: 'approval-history',
        sessionId,
        turnId: 'turn-history',
        providerRequestId: 'provider-history',
        risk: 'write',
        title: 'Historical approval',
        state: 'pending',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      transcriptHeads: [{ sessionId, lastSequence: 2, itemCount: 2 }],
    };
    const notice: DaemonTranscriptItem = {
      id: 'notice-related',
      sessionId,
      sequence: 1,
      kind: 'notice',
      text: 'A related Agent retained useful context.',
      isDelta: false,
      isSensitive: false,
      relatedSessionId: childSessionId,
      createdAt: NOW,
    };
    const getSnapshot = vi.fn(async () => archivedSnapshot);
    const getTranscript = vi.fn(async (_sessionId: string, afterSequence = 0) => {
      if (afterSequence === 0) return [notice];
      throw new Error('incomplete archived transcript');
    });
    const sendCommand = vi.fn();
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getAvailability: getReadyAvailability,
        getSnapshot,
        getTranscript,
        sendCommand,
        observeEvents: () => () => undefined,
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
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
      params: { historyId: `${STRUCTURED_AGENT_SESSION_PREFIX}${sessionId}` },
      api: { id: 'archived-agent', setTitle: vi.fn(), updateParameters: vi.fn() },
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
    await flush();

    expect(container.querySelector('[data-history-only="true"]')).not.toBeNull();
    expect(container.textContent).toContain('A related Agent retained useful context.');
    expect(container.querySelector('[data-testid="structured-agent-composer-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="structured-agent-lifecycle"]')).toBeNull();
    expect(container.querySelector('[data-testid="structured-agent-heartbeat"]')).toBeNull();
    expect(container.querySelector('.structured-agent-approval__actions')).toBeNull();

    const related = container.querySelector<HTMLButtonElement>('.structured-agent-message__child-link')!;
    act(() => related.click());
    expect(onOpenSession).toHaveBeenCalledWith({
      sessionId: childSessionId,
      title: 'Related Agent',
      providerLabel: 'Codex',
    });

    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Retry'))!;
    const snapshotCalls = getSnapshot.mock.calls.length;
    act(() => retry.click());
    await flush();
    expect(getSnapshot.mock.calls.length).toBeGreaterThan(snapshotCalls);
    expect(sendCommand).not.toHaveBeenCalled();
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

  it('replaces draft and lifecycle controls with trusted Desktop safe-mode guidance', async () => {
    const getSnapshot = vi.fn(async () => snapshot);
    const sendCommand = vi.fn();
    const access: CapabilityAccess = {
      ...rendererCapabilities,
      daemon: {
        getAvailability: async () => ({
          state: 'legacy-only-safe-mode',
          initializationCode: 'unsafe-path',
          databaseDisposition: 'preserved',
          supportedSchemaVersion: 3,
          recoveryPath: 'C:\\trusted\\daemon-recovery',
        }),
        getSnapshot,
        getTranscript: async () => [],
        sendCommand,
        observeEvents: () => () => undefined,
        getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
        setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      },
    };
    const props = {
      capabilities: access,
      params: { historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}safe-mode` },
      api: { id: 'safe-agent', setTitle: vi.fn(), updateParameters: vi.fn() },
    } as unknown as IDockviewPanelProps & { capabilities: CapabilityAccess };

    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    expect(container.querySelector('[data-testid="structured-agent-safe-mode"]')).not.toBeNull();
    expect(container.textContent).toContain('Existing terminal sessions remain available');
    expect(container.textContent).toContain('C:\\trusted\\daemon-recovery');
    expect(container.querySelector('[data-testid="structured-agent-draft-submit"]')).toBeNull();
    expect(container.querySelector('[data-testid="structured-agent-archive"]')).toBeNull();
    expect([...container.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('Retry'))).toBe(false);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
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
        getAvailability: getReadyAvailability,
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
