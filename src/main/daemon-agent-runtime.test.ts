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
import { DaemonStore } from './daemon-store';

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

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
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
    return router.execute(createDaemonCommand({
      commandId: `command-${suffix}`,
      idempotencyKey: `test:${suffix}`,
      expectedRevision: store.getRevision(),
      issuedAt: '2026-09-04T10:00:00.000Z',
      principal: { kind: 'desktop', id: 'test' },
      type,
      payload,
    }));
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
  return { store, router, runtime, providers, codex, claude, execute, enable, prepareWorkspace };
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

  it('enforces four global active turns and pumps the fifth in FIFO order', async () => {
    const h = await harness();
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
    expect(h.router.getSnapshot().turns.filter((turn) => turn.state === 'queued')).toHaveLength(1);
    const first = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-1')!;
    h.codex.emit({
      kind: 'turn-finished',
      sessionId: 'agent-1',
      turnId: first.id,
      outcome: 'completed',
    });
    await flush();

    expect(h.codex.submit).toHaveBeenCalledTimes(5);
    expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'agent-5',
      prompt: 'Task 5',
    }));
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
    await flush();
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
    await flush();
    const approval = h.router.getSnapshot().approvals[0]!;
    expect(approval).toMatchObject({ state: 'pending', providerRequestId: 'provider-approval-1' });

    await h.execute('permission.resolve', { approvalId: approval.id, decision: 'allow' });
    expect(h.codex.resolveApproval).toHaveBeenCalledWith(expect.objectContaining({
      providerRequestId: 'provider-approval-1',
      decision: 'allow',
    }));
    expect(h.router.getSnapshot().approvals[0]).toMatchObject({ state: 'allowed' });
    await h.runtime.dispose();
    await h.store.close();
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
    await flush();

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
