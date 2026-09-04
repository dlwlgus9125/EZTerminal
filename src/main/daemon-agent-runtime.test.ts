import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonCommand,
  type DaemonCommandType,
} from '../shared/daemon-protocol';
import type {
  AgentProviderAdapter,
  AgentProviderEvent,
  ProviderProbeResult,
} from './agent-provider-adapter';
import { DaemonAgentRuntime } from './daemon-agent-runtime';
import { DaemonCommandRouter } from './daemon-command-router';
import { AgentProviderRegistry, createProviderReviewDigest } from './agent-provider-registry';
import { MAX_TRANSCRIPT_BATCH_UTF8_BYTES, DaemonStore } from './daemon-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

function probe(providerId: string, protocol: ProviderProbeResult['protocol']): ProviderProbeResult {
  return {
    providerId,
    displayName: providerId === 'claude' ? 'Claude Agent' : 'Codex',
    protocol,
    available: true,
    executablePath: `C:\\Tools\\${providerId}.exe`,
    executableVersion: '1.0.0',
    argv: protocol === 'codex-app-server' ? ['app-server'] : [],
    environmentVariableNames: ['PATH'],
    capabilities: ['create', 'resume', 'interrupt', 'model-change', 'permission-change', 'approvals'],
  };
}

function fakeAdapter(
  providerId: string,
  protocol: ProviderProbeResult['protocol'],
): AgentProviderAdapter & { emit(event: AgentProviderEvent): void } {
  const listeners = new Set<(event: AgentProviderEvent) => void>();
  const identity = probe(providerId, protocol);
  let sequence = 0;
  return {
    providerId,
    probe: vi.fn(async () => identity),
    listModels: vi.fn(async () => []),
    createSession: vi.fn(async (context) => ({
      sessionId: context.sessionId,
      providerSessionId: `${providerId}-session-${++sequence}`,
      model: context.model,
      permissionPreset: context.permissionPreset,
    })),
    resumeSession: vi.fn(async (context) => ({
      sessionId: context.sessionId,
      providerSessionId: context.providerSessionId,
      model: context.model,
      permissionPreset: context.permissionPreset,
    })),
    submit: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    setSettings: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      providerSessionId: input.providerSessionId,
      model: input.model,
      permissionPreset: input.permissionPreset ?? 'standard',
    })),
    resolveApproval: vi.fn(async () => undefined),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    reconcile: vi.fn(async () => ({ commands: [], transcriptItems: [] })),
    disposeSession: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

async function harness(options: {
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-agent-runtime-'));
  temporaryDirectories.push(directory);
  const store = new DaemonStore(directory);
  await store.init();
  const codex = fakeAdapter('codex', 'codex-app-server');
  const claude = fakeAdapter('claude', 'claude-agent-sdk');
  const providers = new AgentProviderRegistry([codex, claude]);
  const routerRef: { current?: DaemonCommandRouter } = {};
  const runtime = new DaemonAgentRuntime({
    providers,
    getSnapshot: () => routerRef.current!.getSnapshot(),
    applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
    readTranscript: (sessionId, afterSequence, limit) => (
      routerRef.current!.readTranscript(sessionId, afterSequence, limit)
    ),
    findCommand: (commandId) => store.findCommand(commandId)?.command,
    now: () => new Date('2026-09-04T10:00:00.000Z'),
    idFactory: (() => {
      let id = 0;
      return () => `runtime-id-${++id}`;
    })(),
    ...options,
  });
  const router = new DaemonCommandRouter(store, { handlers: runtime.handlers() });
  routerRef.current = router;
  await runtime.start();

  let commandSequence = 0;
  const execute = async <T extends DaemonCommandType>(
    type: T,
    payload: Parameters<typeof createDaemonCommand<T>>[0]['payload'],
  ) => {
    const suffix = ++commandSequence;
    const receipt = await router.execute(createDaemonCommand({
      commandId: `command-${suffix}`,
      idempotencyKey: `test:${suffix}`,
      expectedRevision: store.getRevision(),
      issuedAt: '2026-09-04T10:00:00.000Z',
      principal: { kind: 'desktop', id: 'test' },
      type,
      payload,
    }));
    await runtime.whenIdle();
    return receipt;
  };
  const enable = async (adapter: typeof codex, providerId: 'codex' | 'claude') => {
    const inspected = await providers.inspect(providerId);
    if (!inspected.ok) throw new Error(inspected.message);
    const current = inspected.value.probe;
    return execute('provider.enable', {
      providerId: current.providerId,
      displayName: current.displayName,
      protocol: current.protocol,
      executablePath: current.executablePath,
      executableVersion: current.executableVersion,
      argv: current.argv,
      environmentVariableNames: current.environmentVariableNames,
      capabilities: current.capabilities,
      reviewDigest: createProviderReviewDigest(await adapter.probe()),
    });
  };
  const prepareWorkspace = async () => {
    await execute('project.create', { projectId: 'project-1', name: 'Demo', rootPath: 'C:\\Demo' });
    await execute('workspace.create', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      name: 'Local',
      kind: 'local',
      rootPath: 'C:\\Demo',
    });
  };
  return { directory, store, router, runtime, providers, codex, claude, execute, enable, prepareWorkspace };
}

describe('DaemonAgentRuntime', () => {
  it('creates the durable Agent Session only with its first submitted prompt', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    expect(h.router.getSnapshot().sessions).toEqual([]);

    const receipt = await h.execute('agent.create', {
      sessionId: 'agent-1',
      workspaceId: 'workspace-1',
      title: 'Agent',
      providerId: 'codex',
      model: 'gpt-5.6',
      permissionPreset: 'standard',
      initialPrompt: 'Inspect the project.',
    });

    expect(receipt).toMatchObject({ ok: true, status: 'applied' });
    expect(h.codex.createSession).toHaveBeenCalledOnce();
    expect(h.codex.submit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'agent-1',
      commandId: expect.stringMatching(/^command-/u),
      prompt: 'Inspect the project.',
    }));
    expect(h.router.getSnapshot()).toMatchObject({
      sessions: [{ id: 'agent-1', kind: 'agent', state: 'running' }],
      agents: [{ sessionId: 'agent-1', providerId: 'codex', state: 'working' }],
      turns: [{ sessionId: 'agent-1', state: 'working' }],
    });
    expect(h.router.readTranscript('agent-1')).toEqual([
      expect.objectContaining({ kind: 'user-message', text: 'Inspect the project.' }),
    ]);
    await h.runtime.dispose();
    await h.store.close();
  });

  it('enforces four global active turns and pumps queued turns in durable FIFO order', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    for (let index = 1; index <= 6; index += 1) {
      await h.execute('agent.create', {
        sessionId: `agent-${index}`,
        workspaceId: 'workspace-1',
        title: `Agent ${index}`,
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: `Task ${index}`,
      });
    }

    expect(h.codex.submit).toHaveBeenCalledTimes(4);
    expect(h.router.getSnapshot().turns.filter((turn) => turn.state === 'queued')).toHaveLength(2);
    const first = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-1')!;
    h.codex.emit({
      kind: 'turn-finished',
      sessionId: 'agent-1',
      turnId: first.id,
      outcome: 'completed',
    });
    await h.runtime.whenIdle();

    expect(h.codex.submit).toHaveBeenCalledTimes(5);
    expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'agent-5',
      prompt: 'Task 5',
    }));
    const second = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-2')!;
    h.codex.emit({
      kind: 'turn-finished',
      sessionId: 'agent-2',
      turnId: second.id,
      outcome: 'completed',
    });
    await h.runtime.whenIdle();

    expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.sessionId)).toEqual([
      'agent-1',
      'agent-2',
      'agent-3',
      'agent-4',
      'agent-5',
      'agent-6',
    ]);
    expect(h.router.getSnapshot().turns.filter((turn) => (
      ['submitting', 'working', 'blocked'].includes(turn.state)
    ))).toHaveLength(4);
    await h.runtime.dispose();
    await h.store.close();
  });

  it('creates a cross-provider managed child and accepts direct user instructions', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.enable(h.claude, 'claude');
    await h.prepareWorkspace();
    await h.router.applySystemCommit({
      mutations: [{ kind: 'runtime.update', value: { orchestrationToolsEnabled: true } }],
    });
    await h.execute('agent.create', {
      sessionId: 'lead',
      workspaceId: 'workspace-1',
      title: 'Lead',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Lead the work.',
    });
    await h.execute('agent.create', {
      sessionId: 'child',
      workspaceId: 'workspace-1',
      title: 'Claude child',
      providerId: 'claude',
      permissionPreset: 'plan',
      initialPrompt: 'Review the design.',
      parentSessionId: 'lead',
    });

    expect(h.router.getSnapshot().agentRelations).toEqual([
      expect.objectContaining({
        parentSessionId: 'lead',
        childSessionId: 'child',
        owner: 'managed',
        depth: 1,
      }),
    ]);
    const childTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'child')!;
    h.claude.emit({ kind: 'turn-finished', sessionId: 'child', turnId: childTurn.id, outcome: 'completed' });
    await h.runtime.whenIdle();
    await h.execute('agent.submit', { sessionId: 'child', prompt: 'Check one more edge case.' });

    expect(h.claude.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'child',
      prompt: 'Check one more edge case.',
    }));
    await h.runtime.dispose();
    await h.store.close();
  });

  it('persists approval state and forwards the exact provider request decision', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'agent-1',
      workspaceId: 'workspace-1',
      title: 'Agent',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Edit a file.',
    });
    const turn = h.router.getSnapshot().turns[0]!;
    h.codex.emit({
      kind: 'approval-requested',
      sessionId: 'agent-1',
      turnId: turn.id,
      providerRequestId: 'provider-approval-1',
      risk: 'write',
      title: 'Edit src/app.ts',
    });
    await h.runtime.whenIdle();
    const approval = h.router.getSnapshot().approvals[0]!;
    expect(approval).toMatchObject({ state: 'pending', providerRequestId: 'provider-approval-1' });

    h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'working' });
    await h.runtime.whenIdle();
    expect(h.router.getSnapshot()).toMatchObject({
      sessions: [{ id: 'agent-1', state: 'needs-attention' }],
      agents: [{ sessionId: 'agent-1', state: 'blocked' }],
      turns: [{ id: turn.id, state: 'blocked' }],
    });

    await h.execute('permission.resolve', { approvalId: approval.id, decision: 'allow' });
    expect(h.codex.resolveApproval).toHaveBeenCalledWith(expect.objectContaining({
      providerRequestId: 'provider-approval-1',
      decision: 'allow',
    }));
    expect(h.router.getSnapshot().approvals[0]).toMatchObject({ state: 'allowed' });

    h.codex.emit({
      kind: 'approval-requested',
      sessionId: 'agent-1',
      turnId: turn.id,
      providerRequestId: 'provider-approval-1',
      risk: 'write',
      title: 'Edit src/app.ts',
    });
    await h.runtime.whenIdle();
    expect(h.router.getSnapshot().approvals).toEqual([
      expect.objectContaining({ state: 'allowed', providerRequestId: 'provider-approval-1' }),
    ]);
    expect(h.router.getSnapshot()).toMatchObject({
      sessions: [{ id: 'agent-1', state: 'running' }],
      agents: [{ sessionId: 'agent-1', state: 'working', currentTurnId: turn.id }],
    });
    expect(h.codex.resolveApproval).toHaveBeenCalledTimes(2);
    await h.runtime.dispose();
    await h.store.close();
  });

  it('absorbs synchronous and duplicate provider lifecycle events without resurrecting a terminal turn', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    const largeProviderDelta = 'x'.repeat(MAX_TRANSCRIPT_BATCH_UTF8_BYTES + 1);
    vi.mocked(h.codex.submit).mockImplementation(async (input) => {
      h.codex.emit({
        kind: 'turn-started',
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerTurnId: 'provider-turn-1',
        commandId: input.commandId,
      });
      h.codex.emit({
        kind: 'transcript',
        item: {
          id: 'provider-message-1',
          sessionId: input.sessionId,
          turnId: input.turnId,
          sequence: 1,
          kind: 'assistant-message',
          text: largeProviderDelta,
          isDelta: false,
          isSensitive: false,
          createdAt: '2026-09-04T10:00:00.000Z',
        },
      });
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: input.sessionId,
        turnId: input.turnId,
        outcome: 'completed',
        summary: 'Immediate summary',
      });
    });

    await h.execute('agent.create', {
      sessionId: 'agent-1',
      workspaceId: 'workspace-1',
      title: 'Agent',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Fast task.',
    });
    const turn = h.router.getSnapshot().turns[0]!;
    expect(turn).toMatchObject({ state: 'completed', providerTurnId: 'provider-turn-1' });

    h.codex.emit({
      kind: 'turn-started',
      sessionId: 'agent-1',
      turnId: turn.id,
      providerTurnId: 'provider-turn-1',
      commandId: turn.commandId,
    });
    h.codex.emit({
      kind: 'turn-finished',
      sessionId: 'agent-1',
      turnId: turn.id,
      outcome: 'completed',
      summary: 'Immediate summary',
    });
    await h.runtime.whenIdle();

    expect(h.router.getSnapshot().turns[0]).toMatchObject({ state: 'completed' });
    expect(h.router.getSnapshot().agents[0]).not.toHaveProperty('currentTurnId');
    expect(h.router.readTranscript('agent-1').filter((item) => item.text === 'Immediate summary')).toHaveLength(1);
    const providerDeltas = h.router.readTranscript('agent-1').filter((item) => item.kind === 'assistant-message');
    expect(providerDeltas.map((item) => item.text).join('')).toBe(largeProviderDelta);
    expect(providerDeltas.every((item) => (
      Buffer.byteLength(item.text, 'utf8') <= MAX_TRANSCRIPT_BATCH_UTF8_BYTES
    ))).toBe(true);
    await h.runtime.dispose();
    await h.store.close();
  });

  it('does not let a delayed predecessor completion clear the replacement turn', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'First task.',
      });
      const predecessor = h.router.getSnapshot().turns[0]!;
      vi.mocked(h.codex.interrupt).mockRejectedValueOnce(new Error('Provider pipe raced with the interrupt.'));
      await h.execute('agent.interrupt-and-submit', {
        sessionId: 'agent-1',
        prompt: 'Replacement task.',
      });
      const replacement = h.router.getSnapshot().turns.find((turn) => turn.id !== predecessor.id)!;

      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: predecessor.id,
        outcome: 'interrupted',
      });
      await h.runtime.whenIdle();

      expect(h.router.getSnapshot().agents[0]?.currentTurnId).toBe(replacement.id);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('never dispatches a queued turn after its Agent Session is cancelled', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      for (let index = 1; index <= 5; index += 1) {
        await h.execute('agent.create', {
          sessionId: `agent-${index}`,
          workspaceId: 'workspace-1',
          title: `Agent ${index}`,
          providerId: 'codex',
          permissionPreset: 'standard',
          initialPrompt: `Task ${index}`,
        });
      }
      expect(h.codex.submit).toHaveBeenCalledTimes(4);

      await h.execute('agent.cancel', { sessionId: 'agent-5' });
      const first = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-1')!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: first.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();

      expect(h.codex.submit).toHaveBeenCalledTimes(4);
      const snapshot = h.router.getSnapshot();
      expect(snapshot.sessions.find((session) => session.id === 'agent-5'))
        .toMatchObject({ state: 'interrupted' });
      expect(snapshot.agents.find((agent) => agent.sessionId === 'agent-5'))
        .toMatchObject({ state: 'interrupted', queuedTurnCount: 0 });
      expect(snapshot.turns.find((turn) => turn.sessionId === 'agent-5'))
        .toMatchObject({ state: 'interrupted' });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('rehydrates provider sessions, recovers unattached claims, and reconciles unsettled work after restart', async () => {
    const first = await harness();
    let restartedRuntime: DaemonAgentRuntime | undefined;
    let restartedStore: DaemonStore | undefined;
    try {
      await first.enable(first.codex, 'codex');
      await first.prepareWorkspace();
      await first.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Recover this exact prompt.',
      });
      const originalTurn = first.router.getSnapshot().turns[0]!;
      const providerSessionId = first.router.getSnapshot().agents[0]!.providerSessionId!;
      await first.execute('agent.create', {
        sessionId: 'agent-2',
        workspaceId: 'workspace-1',
        title: 'Agent with unattached claim',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Recover the pre-provider claim.',
      });
      await first.router.applySystemTransition((snapshot) => {
        const session = snapshot.sessions.find((entry) => entry.id === 'agent-2')!;
        const agent = snapshot.agents.find((entry) => entry.sessionId === 'agent-2')!;
        const turn = snapshot.turns.find((entry) => entry.sessionId === 'agent-2')!;
        return { mutations: [
          { kind: 'session.upsert', value: {
            id: session.id,
            projectId: session.projectId,
            workspaceId: session.workspaceId,
            kind: session.kind,
            title: session.title,
            state: 'starting',
            source: session.source,
          } },
          { kind: 'agent.upsert', value: {
            sessionId: agent.sessionId,
            providerId: agent.providerId,
            ...(agent.model ? { model: agent.model } : {}),
            permissionPreset: agent.permissionPreset,
            state: 'starting',
            currentTurnId: turn.id,
            queuedTurnCount: 0,
            orchestrationEnabled: agent.orchestrationEnabled,
          } },
          { kind: 'turn.upsert', value: {
            id: turn.id,
            sessionId: turn.sessionId,
            commandId: turn.commandId,
            ...(turn.enqueueSequence ? { enqueueSequence: turn.enqueueSequence } : {}),
            state: 'submitting',
            startedAt: '2026-09-04T10:00:00.000Z',
          } },
        ] };
      });
      await first.runtime.dispose();
      await first.store.close();

      restartedStore = new DaemonStore(first.directory);
      await restartedStore.init();
      const codex = fakeAdapter('codex', 'codex-app-server');
      const claude = fakeAdapter('claude', 'claude-agent-sdk');
      vi.mocked(codex.reconcile).mockImplementation(async (input) => ({
        commands: input.unsettledCommands.map((command) => ({
          commandId: command.commandId,
          state: 'not-applied' as const,
        })),
        transcriptItems: Array.from({ length: 130 }, (_, index) => ({
          id: `reconciled-${index + 1}`,
          sessionId: input.sessionId,
          turnId: originalTurn.id,
          sequence: index + 2,
          kind: 'assistant-message' as const,
          text: `Recovered ${index + 1}`,
          isDelta: true,
          isSensitive: false,
          createdAt: '2026-09-04T10:00:00.000Z',
        })),
      }));
      const providers = new AgentProviderRegistry([codex, claude]);
      const routerRef: { current?: DaemonCommandRouter } = {};
      const store = restartedStore;
      restartedRuntime = new DaemonAgentRuntime({
        providers,
        getSnapshot: () => routerRef.current!.getSnapshot(),
        applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
        readTranscript: (sessionId, afterSequence, limit) => (
          routerRef.current!.readTranscript(sessionId, afterSequence, limit)
        ),
        findCommand: (commandId) => store.findCommand(commandId)?.command,
        now: () => new Date('2026-09-04T10:00:00.000Z'),
      });
      const router = new DaemonCommandRouter(store, { handlers: restartedRuntime.handlers() });
      routerRef.current = router;

      await restartedRuntime.start();
      await restartedRuntime.whenIdle();

      expect(codex.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-1',
        providerSessionId,
      }));
      expect(codex.reconcile).toHaveBeenCalledWith(expect.objectContaining({
        unsettledCommands: [expect.objectContaining({
          commandId: originalTurn.commandId,
          turnId: originalTurn.id,
          state: 'working',
        })],
      }));
      expect(codex.createSession).toHaveBeenCalledOnce();
      expect(codex.createSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-2',
      }));
      expect(codex.submit).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-1',
        turnId: originalTurn.id,
        commandId: originalTurn.commandId,
        prompt: 'Recover this exact prompt.',
      }));
      expect(codex.submit).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-2',
        prompt: 'Recover the pre-provider claim.',
      }));
      expect(vi.mocked(codex.submit).mock.calls.map(([input]) => input.sessionId))
        .toEqual(['agent-1', 'agent-2']);
      expect(router.readTranscript('agent-1', 0, 500)).toHaveLength(131);
      expect(router.getSnapshot()).toMatchObject({
        sessions: [
          { id: 'agent-1', state: 'running' },
          { id: 'agent-2', state: 'running' },
        ],
        agents: [
          { sessionId: 'agent-1', state: 'working', currentTurnId: originalTurn.id },
          { sessionId: 'agent-2', state: 'working' },
        ],
      });
      expect(router.getSnapshot().turns.every((turn) => turn.state === 'working')).toBe(true);
    } finally {
      await restartedRuntime?.dispose();
      await restartedStore?.close();
      await first.runtime.dispose();
      await first.store.close();
    }
  });

  it('closes the turn, Agent, Session, and pending approvals on a terminal provider error', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Fail safely.',
      });
      const turn = h.router.getSnapshot().turns[0]!;
      h.codex.emit({
        kind: 'approval-requested',
        sessionId: 'agent-1',
        turnId: turn.id,
        providerRequestId: 'dangerous-request',
        risk: 'danger',
        title: 'Dangerous action',
      });
      await h.runtime.whenIdle();

      const error = {
        kind: 'provider-error' as const,
        sessionId: 'agent-1',
        code: 'provider-crashed',
        message: 'Provider process exited.',
        recoverable: false,
      };
      h.codex.emit(error);
      h.codex.emit(error);
      await h.runtime.whenIdle();

      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [{ id: 'agent-1', state: 'failed' }],
        agents: [{ sessionId: 'agent-1', state: 'error' }],
        turns: [{ id: turn.id, state: 'failed', errorCode: 'provider-crashed' }],
        approvals: [{ providerRequestId: 'dangerous-request', state: 'expired' }],
      });
      expect(h.router.getSnapshot().agents[0]).not.toHaveProperty('currentTurnId');
      expect(h.router.readTranscript('agent-1').filter((item) => item.kind === 'error')).toHaveLength(1);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('interrupts and marks a turn failed at the two-hour safety timeout', async () => {
    let expire: (() => void) | undefined;
    const h = await harness({
      setTimer: ((callback: () => void) => {
        expire = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: vi.fn(),
    });
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'agent-1',
      workspaceId: 'workspace-1',
      title: 'Agent',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Long task.',
    });

    expect(expire).toBeTypeOf('function');
    expire?.();
    await h.runtime.whenIdle();

    expect(h.codex.interrupt).toHaveBeenCalledOnce();
    expect(h.router.getSnapshot()).toMatchObject({
      sessions: [{ id: 'agent-1', state: 'failed' }],
      agents: [{ sessionId: 'agent-1', state: 'error' }],
      turns: [{ sessionId: 'agent-1', state: 'failed', errorCode: 'background-turn-timeout' }],
    });
    await h.runtime.dispose();
    await h.store.close();
  });
});
