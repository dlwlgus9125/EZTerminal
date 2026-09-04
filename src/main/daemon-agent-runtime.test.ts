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

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Operation did not settle within ${String(timeoutMs)}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function fakeAdapter(
  providerId: string,
  protocol: ProviderProbeResult['protocol'],
): AgentProviderAdapter & {
  emit(event: AgentProviderEvent): void;
  ownerOf(providerSessionId: string): string | undefined;
  deactivate(): Promise<void>;
} {
  const listeners = new Set<(event: AgentProviderEvent) => void>();
  const sessionOwners = new Map<string, string>();
  const identity = probe(providerId, protocol);
  let sequence = 0;
  return {
    providerId,
    probe: vi.fn(async () => identity),
    listModels: vi.fn(async () => []),
    createSession: vi.fn(async (context) => {
      const providerSessionId = `${providerId}-session-${++sequence}`;
      sessionOwners.set(providerSessionId, context.sessionId);
      return {
        sessionId: context.sessionId,
        providerSessionId,
        model: context.model,
        permissionPreset: context.permissionPreset,
      };
    }),
    resumeSession: vi.fn(async (context) => {
      const existingOwner = sessionOwners.get(context.providerSessionId);
      if (existingOwner && existingOwner !== context.sessionId) {
        throw new Error(`Provider Session is already attached to ${existingOwner}.`);
      }
      sessionOwners.set(context.providerSessionId, context.sessionId);
      return {
        sessionId: context.sessionId,
        providerSessionId: context.providerSessionId,
        model: context.model,
        permissionPreset: context.permissionPreset,
      };
    }),
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
    disposeSession: vi.fn(async (sessionId, providerSessionId) => {
      const existingOwner = sessionOwners.get(providerSessionId);
      if (!existingOwner) return;
      if (existingOwner !== sessionId) {
        throw new Error(`Provider Session belongs to ${existingOwner}.`);
      }
      sessionOwners.delete(providerSessionId);
    }),
    deactivate: vi.fn(async () => {
      sessionOwners.clear();
    }),
    dispose: vi.fn(async () => undefined),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    ownerOf: (providerSessionId) => sessionOwners.get(providerSessionId),
  };
}

async function harness(options: {
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly now?: () => Date;
  readonly shutdownStepTimeoutMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
  readonly revokeOrchestrationForSession?: (sessionId: string) => void;
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-agent-runtime-'));
  temporaryDirectories.push(directory);
  const now = options.now ?? (() => new Date('2026-09-04T10:00:00.000Z'));
  const store = new DaemonStore(directory, { now });
  await store.init();
  const codex = fakeAdapter('codex', 'codex-app-server');
  const claude = fakeAdapter('claude', 'claude-agent-sdk');
  const providers = new AgentProviderRegistry([codex, claude]);
  const routerRef: { current?: DaemonCommandRouter } = {};
  const runtime = new DaemonAgentRuntime({
    providers,
    getSnapshot: () => routerRef.current!.getSnapshot(),
    applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
    applySystemTransition: (transition) => routerRef.current!.applySystemTransition(transition),
    readTranscript: (sessionId, afterSequence, limit) => (
      routerRef.current!.readTranscript(sessionId, afterSequence, limit)
    ),
    findCommand: (commandId) => store.findCommand(commandId)?.command,
    now,
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
  const executeWithoutSettling = async <T extends DaemonCommandType>(
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
    return receipt;
  };
  const execute = async <T extends DaemonCommandType>(
    type: T,
    payload: Parameters<typeof createDaemonCommand<T>>[0]['payload'],
  ) => {
    const receipt = await executeWithoutSettling(type, payload);
    await runtime.whenIdle();
    return receipt;
  };
  const enableWithoutSettling = async (adapter: typeof codex, providerId: 'codex' | 'claude') => {
    const inspected = await providers.inspect(providerId);
    if (!inspected.ok) throw new Error(inspected.message);
    const current = inspected.value.probe;
    return executeWithoutSettling('provider.enable', {
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
  const enable = async (adapter: typeof codex, providerId: 'codex' | 'claude') => {
    const receipt = await enableWithoutSettling(adapter, providerId);
    await runtime.whenIdle();
    return receipt;
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
  return {
    directory,
    store,
    router,
    runtime,
    providers,
    codex,
    claude,
    execute,
    executeWithoutSettling,
    enable,
    enableWithoutSettling,
    prepareWorkspace,
  };
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
    }), expect.any(AbortSignal));
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

  it('transfers a stopped Provider Session handle exactly once when resuming', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-source',
        workspaceId: 'workspace-1',
        title: 'Stopped Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish this turn.',
      });
      const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-source')!;
      const providerSessionId = h.router.getSnapshot().agents.find((agent) => (
        agent.sessionId === 'agent-source'
      ))!.providerSessionId!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-source',
        turnId: sourceTurn.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-source', state: 'completed' });
      await h.runtime.whenIdle();

      const first = await h.execute('agent.resume', {
        sessionId: 'agent-resumed',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        providerSessionId,
        title: 'Resumed Agent',
        permissionPreset: 'standard',
      });
      expect(first).toMatchObject({ ok: true, status: 'applied' });
      expect(h.router.getSnapshot().sessions.find((session) => session.id === 'agent-source'))
        .toMatchObject({ state: 'completed' });
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-source'))
        .toMatchObject({ state: 'done' });
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-source'))
        .not.toHaveProperty('providerSessionId');
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-resumed'))
        .toMatchObject({ state: 'idle', providerSessionId });
      expect(h.router.getSnapshot().agents.filter((agent) => agent.providerSessionId === providerSessionId))
        .toHaveLength(1);
      expect(h.codex.disposeSession).toHaveBeenCalledWith('agent-source', providerSessionId);
      expect(h.codex.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-resumed', providerSessionId,
      }), expect.any(AbortSignal));
      expect(vi.mocked(h.codex.disposeSession).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(h.codex.resumeSession).mock.invocationCallOrder[0]!);
      expect(h.codex.ownerOf(providerSessionId)).toBe('agent-resumed');

      const repeated = await h.execute('agent.resume', {
        sessionId: 'agent-resumed-again',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        providerSessionId,
        title: 'Improper duplicate',
        permissionPreset: 'standard',
      });
      expect(repeated).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      expect(h.router.getSnapshot().sessions.some((session) => session.id === 'agent-resumed-again')).toBe(false);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('keeps the destination as sole durable owner when Provider reattachment fails', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-source',
        workspaceId: 'workspace-1',
        title: 'Source Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish before resume.',
      });
      const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-source')!;
      const providerSessionId = h.router.getSnapshot().agents.find((agent) => (
        agent.sessionId === 'agent-source'
      ))!.providerSessionId!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-source',
        turnId: sourceTurn.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-source', state: 'completed' });
      await h.runtime.whenIdle();
      vi.mocked(h.codex.resumeSession).mockRejectedValueOnce(new Error('Provider reattachment failed.'));

      const receipt = await h.execute('agent.resume', {
        sessionId: 'agent-destination',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        providerSessionId,
        title: 'Destination Agent',
        permissionPreset: 'standard',
      });

      expect(receipt).toMatchObject({ ok: true, status: 'applied' });
      expect(h.codex.disposeSession).toHaveBeenCalledWith('agent-source', providerSessionId);
      expect(vi.mocked(h.codex.disposeSession).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(h.codex.resumeSession).mock.invocationCallOrder[0]!);
      expect(h.codex.ownerOf(providerSessionId)).toBeUndefined();
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-source'))
        .not.toHaveProperty('providerSessionId');
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-destination'))
        .toMatchObject({ state: 'delivery-uncertain', providerSessionId });
      expect(h.router.getSnapshot().agents.filter((agent) => agent.providerSessionId === providerSessionId))
        .toHaveLength(1);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('harmlessly repeats Provider cleanup when resuming an already-disposed archived source', async () => {
    const reportError = vi.fn();
    const h = await harness({ reportError });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-source',
        workspaceId: 'workspace-1',
        title: 'Archived source',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish before archive.',
      });
      const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-source')!;
      const providerSessionId = h.router.getSnapshot().agents.find((agent) => (
        agent.sessionId === 'agent-source'
      ))!.providerSessionId!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-source',
        turnId: sourceTurn.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-source', state: 'completed' });
      await h.runtime.whenIdle();
      expect(await h.execute('agent.archive', { sessionId: 'agent-source' }))
        .toMatchObject({ ok: true });
      expect(h.codex.ownerOf(providerSessionId)).toBeUndefined();
      vi.mocked(h.codex.disposeSession).mockRejectedValueOnce(new Error('Provider Session is already disposed.'));

      const receipt = await h.execute('agent.resume', {
        sessionId: 'agent-destination',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        providerSessionId,
        title: 'Destination Agent',
        permissionPreset: 'standard',
      });

      expect(receipt).toMatchObject({ ok: true, status: 'applied' });
      expect(h.codex.disposeSession).toHaveBeenCalledTimes(2);
      expect(vi.mocked(h.codex.disposeSession).mock.invocationCallOrder[1])
        .toBeLessThan(vi.mocked(h.codex.resumeSession).mock.invocationCallOrder[0]!);
      expect(reportError).toHaveBeenCalledWith(
        'dispose source Provider Session agent-source before resume',
        expect.any(Error),
      );
      expect(h.codex.ownerOf(providerSessionId)).toBe('agent-destination');
      expect(h.router.getSnapshot().sessions.find((session) => session.id === 'agent-source'))
        .toMatchObject({ state: 'archived' });
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-source'))
        .not.toHaveProperty('providerSessionId');
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-destination'))
        .toMatchObject({ state: 'idle', providerSessionId });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it.each(['codex', 'claude'] as const)(
    'serializes archive cleanup before transferring the same %s Provider Session handle',
    async (providerId) => {
      const h = await harness();
      const adapter = h[providerId];
      let releaseArchiveCleanup: (() => void) | undefined;
      try {
        await h.enable(adapter, providerId);
        await h.prepareWorkspace();
        await h.execute('agent.create', {
          sessionId: 'agent-source',
          workspaceId: 'workspace-1',
          title: 'Source Agent',
          providerId,
          permissionPreset: 'standard',
          initialPrompt: 'Finish before archive.',
        });
        const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-source')!;
        const providerSessionId = h.router.getSnapshot().agents.find((agent) => (
          agent.sessionId === 'agent-source'
        ))!.providerSessionId!;
        adapter.emit({
          kind: 'turn-finished',
          sessionId: 'agent-source',
          turnId: sourceTurn.id,
          outcome: 'completed',
        });
        await h.runtime.whenIdle();
        adapter.emit({ kind: 'session-state', sessionId: 'agent-source', state: 'completed' });
        await h.runtime.whenIdle();

        const originalDispose = vi.mocked(adapter.disposeSession).getMockImplementation()!;
        let markArchiveCleanupStarted!: () => void;
        const archiveCleanupStarted = new Promise<void>((resolve) => {
          markArchiveCleanupStarted = resolve;
        });
        const archiveCleanupBlocked = new Promise<void>((resolve) => {
          releaseArchiveCleanup = resolve;
        });
        vi.mocked(adapter.disposeSession).mockImplementationOnce(async (...args) => {
          markArchiveCleanupStarted();
          await archiveCleanupBlocked;
          await originalDispose(...args);
        });

        await expect(h.executeWithoutSettling('agent.archive', { sessionId: 'agent-source' }))
          .resolves.toMatchObject({ ok: true, status: 'applied' });
        await archiveCleanupStarted;
        await expect(h.executeWithoutSettling('agent.resume', {
          sessionId: 'agent-destination',
          sourceSessionId: 'agent-source',
          workspaceId: 'workspace-1',
          providerId,
          providerSessionId,
          title: 'Destination Agent',
          permissionPreset: 'standard',
        })).resolves.toMatchObject({ ok: true, status: 'applied' });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(adapter.resumeSession).not.toHaveBeenCalled();
        releaseArchiveCleanup?.();
        releaseArchiveCleanup = undefined;
        await h.runtime.whenIdle();

        expect(adapter.ownerOf(providerSessionId)).toBe('agent-destination');
        expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-source'))
          .not.toHaveProperty('providerSessionId');
        expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-destination'))
          .toMatchObject({ state: 'idle', providerSessionId });
      } finally {
        releaseArchiveCleanup?.();
        await h.runtime.dispose();
        await h.store.close();
      }
    },
  );

  it('drains queued handle cleanup captured before Provider disable during shutdown', async () => {
    const h = await harness();
    let releaseArchiveCleanup: (() => void) | undefined;
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-source',
        workspaceId: 'workspace-1',
        title: 'Source Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish before archive.',
      });
      const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-source')!;
      const providerSessionId = h.router.getSnapshot().agents.find((agent) => (
        agent.sessionId === 'agent-source'
      ))!.providerSessionId!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-source',
        turnId: sourceTurn.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-source', state: 'completed' });
      await h.runtime.whenIdle();

      const originalDispose = vi.mocked(h.codex.disposeSession).getMockImplementation()!;
      let markArchiveCleanupStarted!: () => void;
      const archiveCleanupStarted = new Promise<void>((resolve) => {
        markArchiveCleanupStarted = resolve;
      });
      const archiveCleanupBlocked = new Promise<void>((resolve) => {
        releaseArchiveCleanup = resolve;
      });
      vi.mocked(h.codex.disposeSession).mockImplementationOnce(async (...args) => {
        markArchiveCleanupStarted();
        await archiveCleanupBlocked;
        await originalDispose(...args);
      });

      await expect(h.executeWithoutSettling('agent.archive', { sessionId: 'agent-source' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      await archiveCleanupStarted;
      await expect(h.executeWithoutSettling('agent.archive', { sessionId: 'agent-source' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      await expect(h.executeWithoutSettling('provider.disable', { providerId: 'codex' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });

      const disposal = h.runtime.dispose('process-loss');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.codex.dispose).not.toHaveBeenCalled();
      releaseArchiveCleanup?.();
      releaseArchiveCleanup = undefined;
      await settleWithin(disposal);

      expect(h.codex.disposeSession).toHaveBeenCalledTimes(2);
      expect(h.codex.deactivate).toHaveBeenCalledOnce();
      expect(h.codex.dispose).toHaveBeenCalledOnce();
      expect(vi.mocked(h.codex.disposeSession).mock.invocationCallOrder[1])
        .toBeLessThan(vi.mocked(h.codex.deactivate).mock.invocationCallOrder[0]!);
      expect(vi.mocked(h.codex.deactivate).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(h.codex.dispose).mock.invocationCallOrder[0]!);
      expect(h.codex.ownerOf(providerSessionId)).toBeUndefined();
    } finally {
      releaseArchiveCleanup?.();
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('revokes every idle Session token and deactivates the captured Provider after disable commits', async () => {
    const revokeOrchestrationForSession = vi.fn();
    const h = await harness({ revokeOrchestrationForSession });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      for (const sessionId of ['agent-1', 'agent-2']) {
        await h.execute('agent.create', {
          sessionId,
          workspaceId: 'workspace-1',
          title: sessionId,
          providerId: 'codex',
          permissionPreset: 'standard',
          initialPrompt: `Finish ${sessionId}.`,
        });
        const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === sessionId)!;
        h.codex.emit({ kind: 'turn-finished', sessionId, turnId: turn.id, outcome: 'completed' });
        await h.runtime.whenIdle();
        h.codex.emit({ kind: 'session-state', sessionId, state: 'idle' });
        await h.runtime.whenIdle();
      }
      let providerEnabledDuringDeactivate: boolean | undefined;
      const originalDeactivate = vi.mocked(h.codex.deactivate).getMockImplementation()!;
      vi.mocked(h.codex.deactivate).mockImplementationOnce(async () => {
        providerEnabledDuringDeactivate = h.router.getSnapshot().providers.find((entry) => (
          entry.id === 'codex'
        ))?.enabled;
        await originalDeactivate();
      });

      await expect(h.execute('provider.disable', { providerId: 'codex' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });

      expect(h.router.getSnapshot().providers.find((entry) => entry.id === 'codex'))
        .toMatchObject({ enabled: false, health: 'unknown' });
      expect(providerEnabledDuringDeactivate).toBe(false);
      expect(revokeOrchestrationForSession.mock.calls).toEqual([
        ['agent-1'],
        ['agent-2'],
      ]);
      expect(h.codex.deactivate).toHaveBeenCalledOnce();
      expect(h.codex.ownerOf('codex-session-1')).toBeUndefined();
      expect(h.codex.ownerOf('codex-session-2')).toBeUndefined();

      await expect(h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Must stay disabled.' }))
        .resolves.toMatchObject({
          ok: false,
          status: 'rejected',
          error: { code: 'provider-unavailable' },
        });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('finishes disable cleanup and rehydrates idle Sessions before the first submit after re-enable', async () => {
    const h = await harness();
    let releaseDeactivate: (() => void) | undefined;
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish before disable.',
      });
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      const providerSessionId = h.router.getSnapshot().agents[0]!.providerSessionId!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'idle' });
      await h.runtime.whenIdle();
      vi.mocked(h.codex.resumeSession).mockClear();
      vi.mocked(h.codex.submit).mockClear();
      vi.mocked(h.codex.deactivate).mockClear();

      const originalDeactivate = vi.mocked(h.codex.deactivate).getMockImplementation()!;
      let markDeactivateStarted!: () => void;
      const deactivateStarted = new Promise<void>((resolve) => {
        markDeactivateStarted = resolve;
      });
      const deactivateBlocked = new Promise<void>((resolve) => {
        releaseDeactivate = resolve;
      });
      vi.mocked(h.codex.deactivate).mockImplementationOnce(async () => {
        markDeactivateStarted();
        await deactivateBlocked;
        await originalDeactivate();
      });

      await expect(h.executeWithoutSettling('provider.disable', { providerId: 'codex' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      await settleWithin(deactivateStarted);
      await expect(h.enableWithoutSettling(h.codex, 'codex'))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      await expect(h.executeWithoutSettling('agent.submit', {
        sessionId: 'agent-1',
        prompt: 'First turn after re-enable.',
      })).resolves.toMatchObject({ ok: true, status: 'applied' });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(h.codex.resumeSession).not.toHaveBeenCalled();
      expect(h.codex.submit).not.toHaveBeenCalled();
      releaseDeactivate?.();
      releaseDeactivate = undefined;
      await h.runtime.whenIdle();

      expect(h.codex.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-1',
        providerSessionId,
      }), expect.any(AbortSignal));
      expect(h.codex.submit).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-1',
        providerSessionId,
        prompt: 'First turn after re-enable.',
      }), expect.any(AbortSignal));
      expect(vi.mocked(h.codex.deactivate).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(h.codex.resumeSession).mock.invocationCallOrder[0]!);
      expect(vi.mocked(h.codex.resumeSession).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(h.codex.submit).mock.invocationCallOrder[0]!);
    } finally {
      releaseDeactivate?.();
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('skips stale rehydration when a second disable supersedes an enable behind blocked cleanup', async () => {
    const h = await harness();
    let releaseDeactivate: (() => void) | undefined;
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish before lifecycle changes.',
      });
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'idle' });
      await h.runtime.whenIdle();
      vi.mocked(h.codex.resumeSession).mockClear();
      vi.mocked(h.codex.submit).mockClear();

      const originalDeactivate = vi.mocked(h.codex.deactivate).getMockImplementation()!;
      let markDeactivateStarted!: () => void;
      const deactivateStarted = new Promise<void>((resolve) => {
        markDeactivateStarted = resolve;
      });
      const deactivateBlocked = new Promise<void>((resolve) => {
        releaseDeactivate = resolve;
      });
      vi.mocked(h.codex.deactivate).mockImplementationOnce(async () => {
        markDeactivateStarted();
        await deactivateBlocked;
        await originalDeactivate();
      });

      await expect(h.executeWithoutSettling('provider.disable', { providerId: 'codex' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      await settleWithin(deactivateStarted);
      await expect(h.enableWithoutSettling(h.codex, 'codex'))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      await expect(h.executeWithoutSettling('provider.disable', { providerId: 'codex' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });

      releaseDeactivate?.();
      releaseDeactivate = undefined;
      await h.runtime.whenIdle();

      expect(h.codex.resumeSession).not.toHaveBeenCalled();
      expect(h.codex.submit).not.toHaveBeenCalled();
      expect(h.router.getSnapshot()).toMatchObject({
        providers: [expect.objectContaining({ id: 'codex', enabled: false })],
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'idle' })],
        agents: [expect.objectContaining({ sessionId: 'agent-1', state: 'idle', queuedTurnCount: 0 })],
      });
    } finally {
      releaseDeactivate?.();
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('rejects disabling a Provider while one of its Agent turns is active', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Active Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Keep working.',
      });

      await expect(h.execute('provider.disable', { providerId: 'codex' }))
        .resolves.toMatchObject({
          ok: false,
          status: 'rejected',
          error: { code: 'invalid-state' },
        });
      expect(h.router.getSnapshot().providers.find((provider) => provider.id === 'codex'))
        .toMatchObject({ enabled: true });
      expect(h.codex.deactivate).not.toHaveBeenCalled();
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('rejects active, missing, cross-Project, and mismatched resume sources', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.enable(h.claude, 'claude');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-source',
        workspaceId: 'workspace-1',
        title: 'Source Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish before resume.',
      });
      const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-source')!;
      const providerSessionId = h.router.getSnapshot().agents.find((agent) => (
        agent.sessionId === 'agent-source'
      ))!.providerSessionId!;
      const active = await h.execute('agent.resume', {
        sessionId: 'active-copy',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        providerSessionId,
        title: 'Active copy',
        permissionPreset: 'standard',
      });
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-source',
        turnId: sourceTurn.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-source', state: 'completed' });
      await h.runtime.whenIdle();
      await h.execute('project.create', { projectId: 'project-2', name: 'Other', rootPath: 'C:\\Other' });
      await h.execute('workspace.create', {
        workspaceId: 'workspace-2',
        projectId: 'project-2',
        name: 'Other',
        kind: 'local',
        rootPath: 'C:\\Other',
      });

      const missing = await h.execute('agent.resume', {
        sessionId: 'missing-copy',
        sourceSessionId: 'missing-source',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        providerSessionId,
        title: 'Missing copy',
        permissionPreset: 'standard',
      });
      const crossProject = await h.execute('agent.resume', {
        sessionId: 'cross-project-copy',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-2',
        providerId: 'codex',
        providerSessionId,
        title: 'Cross Project copy',
        permissionPreset: 'standard',
      });
      const providerMismatch = await h.execute('agent.resume', {
        sessionId: 'provider-mismatch-copy',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-1',
        providerId: 'claude',
        providerSessionId,
        title: 'Provider mismatch copy',
        permissionPreset: 'standard',
      });
      const handleMismatch = await h.execute('agent.resume', {
        sessionId: 'handle-mismatch-copy',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        providerSessionId: 'different-provider-handle',
        title: 'Handle mismatch copy',
        permissionPreset: 'standard',
      });

      expect(active).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } });
      for (const receipt of [crossProject, providerMismatch, handleMismatch]) {
        expect(receipt).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      }
      expect(h.codex.resumeSession).not.toHaveBeenCalled();
      expect(h.claude.resumeSession).not.toHaveBeenCalled();
      expect(h.router.getSnapshot().sessions.filter((session) => session.id.endsWith('-copy'))).toEqual([]);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('rejects resume when another Agent already claims the Provider Session handle', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-source',
        workspaceId: 'workspace-1',
        title: 'Source Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish before resume.',
      });
      const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-source')!;
      const providerSessionId = h.router.getSnapshot().agents.find((agent) => (
        agent.sessionId === 'agent-source'
      ))!.providerSessionId!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-source',
        turnId: sourceTurn.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-source', state: 'completed' });
      await h.runtime.whenIdle();
      await h.router.applySystemCommit({ mutations: [
        { kind: 'session.upsert', value: {
          id: 'agent-duplicate-owner',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          kind: 'agent',
          title: 'Duplicate owner',
          state: 'completed',
          source: 'structured',
        } },
        { kind: 'agent.upsert', value: {
          sessionId: 'agent-duplicate-owner',
          providerId: 'codex',
          providerSessionId,
          permissionPreset: 'standard',
          state: 'done',
          queuedTurnCount: 0,
          orchestrationEnabled: false,
        } },
      ] });

      const receipt = await h.execute('agent.resume', {
        sessionId: 'agent-destination',
        sourceSessionId: 'agent-source',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        providerSessionId,
        title: 'Destination',
        permissionPreset: 'standard',
      });

      expect(receipt).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      expect(h.router.getSnapshot().sessions.some((session) => session.id === 'agent-destination')).toBe(false);
      expect(h.router.getSnapshot().agents.filter((agent) => agent.providerSessionId === providerSessionId))
        .toHaveLength(2);
      expect(h.codex.resumeSession).not.toHaveBeenCalled();
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('durably interrupts active Agent work when the runtime is explicitly disposed', async () => {
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
        initialPrompt: 'Keep working until Quit.',
      });
      const turn = h.router.getSnapshot().turns[0]!;
      h.codex.emit({
        kind: 'approval-requested',
        sessionId: 'agent-1',
        turnId: turn.id,
        providerRequestId: 'quit-approval',
        risk: 'write',
        title: 'Pending write',
      });
      await h.runtime.whenIdle();
      await h.execute('agent.submit', {
        sessionId: 'agent-1',
        prompt: 'This queued turn must not survive Quit.',
      });
      const queuedTurn = h.router.getSnapshot().turns.find((candidate) => candidate.id !== turn.id)!;
      await h.router.applySystemCommit({ mutations: [
        { kind: 'schedule.upsert', value: {
          id: 'schedule-1',
          name: 'Scheduled work',
          workspaceId: 'workspace-1',
          providerId: 'codex',
          permissionPreset: 'standard',
          prompt: 'Run later.',
          cron: '* * * * *',
          timezone: 'UTC',
          enabled: false,
          runCount: 1,
        } },
        { kind: 'schedule-run.upsert', value: {
          id: 'schedule-run-1',
          scheduleId: 'schedule-1',
          sessionId: 'agent-1',
          state: 'running',
          scheduledFor: '2026-09-04T09:59:00.000Z',
          startedAt: '2026-09-04T10:00:00.000Z',
        } },
      ] });

      const dispose = h.runtime.dispose();
      expect(h.runtime.dispose()).toBe(dispose);
      await dispose;

      const afterQuit = h.router.getSnapshot();
      expect(afterQuit).toMatchObject({
        sessions: [{ id: 'agent-1', state: 'idle' }],
        agents: [{ sessionId: 'agent-1', state: 'idle', queuedTurnCount: 0 }],
        approvals: [{
          providerRequestId: 'quit-approval',
          state: 'expired',
          resolvedAt: '2026-09-04T10:00:00.000Z',
        }],
      });
      expect(afterQuit.turns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: turn.id,
          state: 'interrupted',
          finishedAt: '2026-09-04T10:00:00.000Z',
          errorCode: 'explicit-quit',
        }),
        expect.objectContaining({
          id: queuedTurn.id,
          state: 'interrupted',
          finishedAt: '2026-09-04T10:00:00.000Z',
          errorCode: 'explicit-quit',
        }),
      ]));
      expect(afterQuit.agents[0]).not.toHaveProperty('currentTurnId');
      expect(h.router.getScheduleRuns()).toEqual([
        expect.objectContaining({
          id: 'schedule-run-1',
          state: 'interrupted',
          finishedAt: '2026-09-04T10:00:00.000Z',
          errorCode: 'explicit-quit',
        }),
      ]);
      expect(h.codex.interrupt).toHaveBeenCalledOnce();
      expect(h.codex.interrupt).toHaveBeenCalledWith('agent-1', 'codex-session-1');
      expect(h.codex.dispose).toHaveBeenCalledOnce();

      const revisionAfterQuit = afterQuit.revision;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: turn.id,
        outcome: 'completed',
      });
      h.codex.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        code: 'late-provider-error',
        message: 'Late provider event after shutdown.',
        recoverable: false,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.router.getSnapshot().revision).toBe(revisionAfterQuit);
      expect(h.router.getSnapshot().turns.find((candidate) => candidate.id === turn.id))
        .toMatchObject({ state: 'interrupted', errorCode: 'explicit-quit' });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('aborts a gated provider enable so the durable Quit transition cannot starve', async () => {
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
        initialPrompt: 'Keep working during provider review.',
      });
      const claudeProbe = probe('claude', 'claude-agent-sdk');
      let observedSignal: AbortSignal | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      vi.mocked(h.claude.probe).mockImplementation(async (signal) => {
        observedSignal = signal;
        markStarted?.();
        return new Promise<never>((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error('probe did not observe shutdown')), 1_500);
          signal?.addEventListener('abort', () => {
            clearTimeout(fallback);
            reject(new Error('probe aborted'));
          }, { once: true });
        });
      });
      const enable = h.router.execute(createDaemonCommand({
        commandId: 'command-enable-during-quit',
        idempotencyKey: 'test:enable-during-quit',
        expectedRevision: h.store.getRevision(),
        issuedAt: '2026-09-04T10:00:00.000Z',
        principal: { kind: 'desktop', id: 'test' },
        type: 'provider.enable',
        payload: {
          providerId: claudeProbe.providerId,
          displayName: claudeProbe.displayName,
          protocol: claudeProbe.protocol,
          executablePath: claudeProbe.executablePath,
          executableVersion: claudeProbe.executableVersion,
          argv: claudeProbe.argv,
          environmentVariableNames: claudeProbe.environmentVariableNames,
          capabilities: claudeProbe.capabilities,
          reviewDigest: createProviderReviewDigest(claudeProbe),
        },
      }));
      await started;

      h.router.beginShutdown();
      h.runtime.beginShutdown();
      const disposal = h.runtime.dispose();
      const [receipt] = await settleWithin(Promise.all([enable, disposal]));

      expect(observedSignal?.aborted).toBe(true);
      expect(receipt).toMatchObject({
        ok: false,
        status: 'rejected',
        error: { code: 'invalid-state' },
      });
      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [{ id: 'agent-1', state: 'idle' }],
        agents: [{ sessionId: 'agent-1', state: 'idle', queuedTurnCount: 0 }],
        turns: [{ sessionId: 'agent-1', state: 'interrupted', errorCode: 'explicit-quit' }],
      });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('does not leave one active turn working after explicit disposal', async () => {
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
        initialPrompt: 'Stop this on Quit.',
      });

      await h.runtime.dispose();

      expect(h.router.getSnapshot().turns).toEqual([
        expect.objectContaining({ state: 'interrupted', errorCode: 'explicit-quit' }),
      ]);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('preserves delivery uncertainty and treats an in-flight submit conservatively on explicit Quit', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      for (const sessionId of ['agent-1', 'agent-2']) {
        await h.execute('agent.create', {
          sessionId,
          workspaceId: 'workspace-1',
          title: sessionId,
          providerId: 'codex',
          permissionPreset: 'standard',
          initialPrompt: `Start ${sessionId}.`,
        });
      }
      const before = h.router.getSnapshot();
      const uncertainSession = before.sessions.find((session) => session.id === 'agent-1')!;
      const uncertainAgent = before.agents.find((agent) => agent.sessionId === 'agent-1')!;
      const uncertainTurn = before.turns.find((turn) => turn.sessionId === 'agent-1')!;
      const submittingSession = before.sessions.find((session) => session.id === 'agent-2')!;
      const submittingAgent = before.agents.find((agent) => agent.sessionId === 'agent-2')!;
      const submittingTurn = before.turns.find((turn) => turn.sessionId === 'agent-2')!;
      await h.router.applySystemCommit({ mutations: [
        { kind: 'session.upsert', value: {
          id: uncertainSession.id,
          projectId: uncertainSession.projectId,
          workspaceId: uncertainSession.workspaceId,
          kind: uncertainSession.kind,
          title: uncertainSession.title,
          state: 'delivery-uncertain',
          source: uncertainSession.source,
        } },
        { kind: 'agent.upsert', value: {
          sessionId: uncertainAgent.sessionId,
          providerId: uncertainAgent.providerId,
          ...(uncertainAgent.providerSessionId
            ? { providerSessionId: uncertainAgent.providerSessionId }
            : {}),
          ...(uncertainAgent.model ? { model: uncertainAgent.model } : {}),
          permissionPreset: uncertainAgent.permissionPreset,
          state: 'delivery-uncertain',
          currentTurnId: uncertainTurn.id,
          queuedTurnCount: 0,
          orchestrationEnabled: uncertainAgent.orchestrationEnabled,
        } },
        { kind: 'turn.upsert', value: {
          id: uncertainTurn.id,
          sessionId: uncertainTurn.sessionId,
          commandId: uncertainTurn.commandId,
          ...(uncertainTurn.enqueueSequence !== undefined
            ? { enqueueSequence: uncertainTurn.enqueueSequence }
            : {}),
          state: 'delivery-uncertain',
          ...(uncertainTurn.startedAt ? { startedAt: uncertainTurn.startedAt } : {}),
          errorCode: 'provider-reconciliation-required',
        } },
        { kind: 'session.upsert', value: {
          id: submittingSession.id,
          projectId: submittingSession.projectId,
          workspaceId: submittingSession.workspaceId,
          kind: submittingSession.kind,
          title: submittingSession.title,
          state: 'running',
          source: submittingSession.source,
        } },
        { kind: 'agent.upsert', value: {
          sessionId: submittingAgent.sessionId,
          providerId: submittingAgent.providerId,
          ...(submittingAgent.providerSessionId
            ? { providerSessionId: submittingAgent.providerSessionId }
            : {}),
          ...(submittingAgent.model ? { model: submittingAgent.model } : {}),
          permissionPreset: submittingAgent.permissionPreset,
          state: 'working',
          currentTurnId: submittingTurn.id,
          queuedTurnCount: 0,
          orchestrationEnabled: submittingAgent.orchestrationEnabled,
        } },
        { kind: 'turn.upsert', value: {
          id: submittingTurn.id,
          sessionId: submittingTurn.sessionId,
          commandId: submittingTurn.commandId,
          ...(submittingTurn.enqueueSequence !== undefined
            ? { enqueueSequence: submittingTurn.enqueueSequence }
            : {}),
          state: 'submitting',
          ...(submittingTurn.startedAt ? { startedAt: submittingTurn.startedAt } : {}),
        } },
      ] });

      await h.runtime.dispose();

      const after = h.router.getSnapshot();
      expect(after.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'agent-1', state: 'delivery-uncertain' }),
        expect.objectContaining({ id: 'agent-2', state: 'delivery-uncertain' }),
      ]));
      expect(after.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'agent-1',
          state: 'delivery-uncertain',
          currentTurnId: uncertainTurn.id,
          queuedTurnCount: 0,
        }),
        expect.objectContaining({
          sessionId: 'agent-2',
          state: 'delivery-uncertain',
          currentTurnId: submittingTurn.id,
          queuedTurnCount: 0,
        }),
      ]));
      expect(after.turns.find((turn) => turn.id === uncertainTurn.id)).toMatchObject({
        state: 'delivery-uncertain',
        errorCode: 'provider-reconciliation-required',
      });
      expect(after.turns.find((turn) => turn.id === uncertainTurn.id)).not.toHaveProperty('finishedAt');
      expect(after.turns.find((turn) => turn.id === submittingTurn.id)).toMatchObject({
        state: 'delivery-uncertain',
        errorCode: 'explicit-quit-delivery-uncertain',
      });
      expect(after.turns.find((turn) => turn.id === submittingTurn.id)).not.toHaveProperty('finishedAt');
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('persists the interrupted state even when provider shutdown exceeds its bound', async () => {
    const reportError = vi.fn();
    const h = await harness({ shutdownStepTimeoutMs: 5, reportError });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Provider cleanup will stall.',
      });
      vi.mocked(h.codex.interrupt).mockImplementation(() => new Promise<void>(() => undefined));
      vi.mocked(h.codex.dispose).mockRejectedValue(new Error('provider dispose failed'));

      await expect(h.runtime.dispose()).resolves.toBeUndefined();

      expect(h.router.getSnapshot().turns[0]).toMatchObject({
        state: 'interrupted',
        errorCode: 'explicit-quit',
      });
      expect(reportError.mock.calls.map(([context]) => context)).toEqual(expect.arrayContaining([
        'interrupt provider Agent work',
        'dispose Agent providers',
      ]));
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('does not report exact shutdown completion when the durable transition fails', async () => {
    const h = await harness();
    const failure = new Error('SQLite transition failed');
    vi.spyOn(h.router, 'applySystemTransition').mockRejectedValueOnce(failure);

    await expect(h.runtime.dispose()).rejects.toBe(failure);
    expect(h.codex.dispose).toHaveBeenCalledOnce();
    expect(h.claude.dispose).toHaveBeenCalledOnce();
    await h.runtime.dispose().catch(() => undefined);
    await h.store.close();
  });

  it('rehydrates an explicitly stopped Session and accepts a follow-up Send after restart', async () => {
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
        initialPrompt: 'Pause for application Quit.',
      });
      const originalTurn = first.router.getSnapshot().turns[0]!;
      const providerSessionId = first.router.getSnapshot().agents[0]!.providerSessionId!;
      await first.runtime.dispose();
      expect(first.router.getSnapshot()).toMatchObject({
        sessions: [{ id: 'agent-1', state: 'idle' }],
        agents: [{
          sessionId: 'agent-1',
          state: 'idle',
          providerSessionId,
          queuedTurnCount: 0,
        }],
        turns: [{ id: originalTurn.id, state: 'interrupted', errorCode: 'explicit-quit' }],
      });
      await first.store.close();

      restartedStore = new DaemonStore(first.directory, {
        now: () => new Date('2026-09-04T10:01:00.000Z'),
      });
      await restartedStore.init();
      const codex = fakeAdapter('codex', 'codex-app-server');
      const claude = fakeAdapter('claude', 'claude-agent-sdk');
      const providers = new AgentProviderRegistry([codex, claude]);
      const routerRef: { current?: DaemonCommandRouter } = {};
      const store = restartedStore;
      restartedRuntime = new DaemonAgentRuntime({
        providers,
        getSnapshot: () => routerRef.current!.getSnapshot(),
        applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
        applySystemTransition: (transition) => routerRef.current!.applySystemTransition(transition),
        readTranscript: (sessionId, afterSequence, limit) => (
          routerRef.current!.readTranscript(sessionId, afterSequence, limit)
        ),
        findCommand: (commandId) => store.findCommand(commandId)?.command,
        now: () => new Date('2026-09-04T10:01:00.000Z'),
      });
      const router = new DaemonCommandRouter(store, { handlers: restartedRuntime.handlers() });
      routerRef.current = router;

      await restartedRuntime.start();
      expect(codex.resumeSession).toHaveBeenCalledOnce();
      expect(codex.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-1',
        providerSessionId,
      }), expect.any(AbortSignal));

      const receipt = await router.execute(createDaemonCommand({
        commandId: 'command-after-restart',
        idempotencyKey: 'test:after-restart',
        expectedRevision: router.getSnapshot().revision,
        issuedAt: '2026-09-04T10:01:00.000Z',
        principal: { kind: 'desktop', id: 'test' },
        type: 'agent.submit',
        payload: { sessionId: 'agent-1', prompt: 'Continue after restart.' },
      }));
      await restartedRuntime.whenIdle();

      expect(receipt).toMatchObject({ ok: true, status: 'applied' });
      expect(codex.createSession).not.toHaveBeenCalled();
      expect(codex.submit).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-1',
        providerSessionId,
        prompt: 'Continue after restart.',
      }), expect.any(AbortSignal));
      expect(router.getSnapshot()).toMatchObject({
        sessions: [{ id: 'agent-1', state: 'running' }],
        agents: [{ sessionId: 'agent-1', state: 'working', providerSessionId }],
      });
      expect(router.getSnapshot().turns).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: originalTurn.id, state: 'interrupted' }),
        expect.objectContaining({ commandId: 'command-after-restart', state: 'working' }),
      ]));
    } finally {
      await restartedRuntime?.dispose();
      await restartedStore?.close();
      await first.runtime.dispose();
      await first.store.close();
    }
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
    }), expect.any(AbortSignal));
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
    h.claude.emit({
      kind: 'turn-finished',
      sessionId: 'child',
      turnId: childTurn.id,
      outcome: 'completed',
      summary: 'The design review found one lifecycle edge.',
    });
    await h.runtime.whenIdle();
    expect(h.router.readTranscript('lead')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'child-summary',
        text: 'The design review found one lifecycle edge.',
        relatedSessionId: 'child',
      }),
    ]));
    await h.execute('agent.submit', { sessionId: 'child', prompt: 'Check one more edge case.' });

    expect(h.claude.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'child',
      prompt: 'Check one more edge case.',
    }), expect.any(AbortSignal));
    await h.runtime.dispose();
    await h.store.close();
  });

  it('cancels a globally queued Agent before a later slot can submit it', async () => {
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
      const queuedTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-5')!;
      expect(queuedTurn.state).toBe('queued');

      await expect(h.execute('agent.cancel', { sessionId: 'agent-5' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      expect(h.router.getSnapshot().turns.find((turn) => turn.id === queuedTurn.id))
        .toMatchObject({ state: 'interrupted', finishedAt: '2026-09-04T10:00:00.000Z' });
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-5'))
        .toMatchObject({ state: 'idle', queuedTurnCount: 0 });

      const first = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-1')!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: first.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();

      expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.sessionId))
        .toEqual(['agent-1', 'agent-2', 'agent-3', 'agent-4']);
      expect(h.router.getSnapshot().turns.find((turn) => turn.id === queuedTurn.id))
        .toMatchObject({ state: 'interrupted' });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('disposes a newly created Provider handle when Cancel wins the submitting attachment race', async () => {
    const h = await harness();
    let releaseCreate: (() => void) | undefined;
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      const originalCreate = vi.mocked(h.codex.createSession).getMockImplementation()!;
      let markCreateStarted!: () => void;
      const createStarted = new Promise<void>((resolve) => {
        markCreateStarted = resolve;
      });
      const createBlocked = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      vi.mocked(h.codex.createSession).mockImplementationOnce(async (...args) => {
        markCreateStarted();
        await createBlocked;
        return originalCreate(...args);
      });

      await expect(h.executeWithoutSettling('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Do not dispatch after Stop.',
      })).resolves.toMatchObject({ ok: true, status: 'applied' });
      await settleWithin(createStarted);
      expect(h.router.getSnapshot()).toMatchObject({
        agents: [expect.objectContaining({
          sessionId: 'agent-1',
          state: 'starting',
          currentTurnId: expect.any(String),
        })],
        turns: [expect.objectContaining({ sessionId: 'agent-1', state: 'submitting' })],
      });
      expect(h.router.getSnapshot().agents[0]).not.toHaveProperty('providerSessionId');

      await expect(h.executeWithoutSettling('agent.cancel', { sessionId: 'agent-1' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      releaseCreate?.();
      releaseCreate = undefined;
      await h.runtime.whenIdle();

      expect(h.codex.submit).not.toHaveBeenCalled();
      expect(h.codex.disposeSession).toHaveBeenCalledWith('agent-1', 'codex-session-1');
      expect(h.codex.ownerOf('codex-session-1')).toBeUndefined();
      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'idle' })],
        agents: [expect.objectContaining({
          sessionId: 'agent-1',
          state: 'idle',
          queuedTurnCount: 0,
        })],
        turns: [expect.objectContaining({
          sessionId: 'agent-1',
          state: 'interrupted',
          errorCode: 'cancelled',
        })],
      });
      expect(h.router.getSnapshot().agents[0]).not.toHaveProperty('currentTurnId');
      expect(h.router.getSnapshot().agents[0]).not.toHaveProperty('providerSessionId');
    } finally {
      releaseCreate?.();
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('projects provider-native completion summaries onto the parent without resurrecting the child', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
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

    h.codex.emit({
      kind: 'native-subagent',
      sessionId: 'lead',
      providerChildId: 'native-1',
      title: 'Native reviewer',
      state: 'done',
    });
    await h.runtime.whenIdle();
    const child = h.router.getSnapshot().agentRelations[0]!.childSessionId;
    h.codex.emit({
      kind: 'native-subagent',
      sessionId: 'lead',
      providerChildId: 'native-1',
      title: 'Native reviewer',
      state: 'done',
      summary: 'The native review completed safely.',
    });
    await h.runtime.whenIdle();

    expect(h.router.getSnapshot().sessions.find((session) => session.id === child))
      .toMatchObject({ state: 'completed' });
    expect(h.router.readTranscript('lead')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'child-summary',
        text: 'The native review completed safely.',
        relatedSessionId: child,
      }),
    ]));
    expect(h.router.readTranscript(child)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'notice', relatedSessionId: 'lead' }),
    ]));
    await h.runtime.dispose();
    await h.store.close();
  });

  it('rejects daemon mutations of provider-native subagents and their provider sessions', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
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
      h.codex.emit({
        kind: 'native-subagent',
        sessionId: 'lead',
        providerChildId: 'native-1',
        title: 'Native reviewer',
        state: 'working',
      });
      await h.runtime.whenIdle();
      const nativeSessionId = h.router.getSnapshot().agentRelations.find((relation) => (
        relation.owner === 'provider-native' && relation.parentSessionId === 'lead'
      ))!.childSessionId;
      h.codex.emit({
        kind: 'native-subagent',
        sessionId: nativeSessionId,
        providerChildId: 'nested-native',
        title: 'Nested native reviewer',
        state: 'working',
      });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().agentRelations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          parentSessionId: nativeSessionId,
          owner: 'provider-native',
          depth: 2,
        }),
      ]));

      const receipts = [
        await h.execute('session.update', { sessionId: nativeSessionId, title: 'Renamed native child' }),
        await h.execute('agent.submit', { sessionId: nativeSessionId, prompt: 'Do more.' }),
        await h.execute('agent.interrupt-and-submit', { sessionId: nativeSessionId, prompt: 'Replace it.' }),
        await h.execute('agent.interrupt', { sessionId: nativeSessionId }),
        await h.execute('agent.set-settings', { sessionId: nativeSessionId, model: 'gpt-5.6' }),
        await h.execute('agent.cancel', { sessionId: nativeSessionId }),
        await h.execute('agent.archive', { sessionId: nativeSessionId }),
        await h.execute('agent.detach', { sessionId: nativeSessionId }),
        await h.execute('agent.resume', {
          sessionId: 'resumed-native',
          sourceSessionId: nativeSessionId,
          workspaceId: 'workspace-1',
          providerId: 'codex',
          providerSessionId: 'native-1',
          title: 'Improper native resume',
          permissionPreset: 'standard',
        }),
        await h.execute('agent.create', {
          sessionId: 'native-child',
          workspaceId: 'workspace-1',
          title: 'Improper managed child',
          providerId: 'codex',
          permissionPreset: 'standard',
          initialPrompt: 'Do not dispatch.',
          parentSessionId: nativeSessionId,
        }),
      ];

      for (const receipt of receipts) {
        expect(receipt).toMatchObject({
          ok: false,
          status: 'rejected',
          error: {
            code: 'invalid-state',
            retryable: false,
            details: { owner: 'provider-native', sessionId: nativeSessionId },
          },
        });
      }
      expect(h.router.getSnapshot().agentRelations.find((relation) => (
        relation.childSessionId === nativeSessionId
      ))).not.toHaveProperty('detachedAt');
      expect(h.router.getSnapshot().sessions.find((session) => session.id === nativeSessionId))
        .toMatchObject({ state: 'running' });
      expect(h.codex.interrupt).not.toHaveBeenCalled();
      expect(h.codex.resumeSession).not.toHaveBeenCalled();
      expect(h.codex.disposeSession).not.toHaveBeenCalled();
      expect(h.codex.submit).toHaveBeenCalledTimes(1);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('requires a live orchestration-enabled managed parent before creating a child', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'disabled-parent',
        workspaceId: 'workspace-1',
        title: 'Disabled parent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'No orchestration capability.',
      });
      await h.router.applySystemCommit({
        mutations: [{ kind: 'runtime.update', value: { orchestrationToolsEnabled: true } }],
      });

      const disabled = await h.execute('agent.create', {
        sessionId: 'disabled-child',
        workspaceId: 'workspace-1',
        title: 'Disabled child',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Must not run.',
        parentSessionId: 'disabled-parent',
      });
      expect(disabled).toMatchObject({
        ok: false,
        error: { code: 'invalid-state' },
      });

      await h.execute('agent.create', {
        sessionId: 'terminal-parent',
        workspaceId: 'workspace-1',
        title: 'Terminal parent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Finish.',
      });
      const terminalTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'terminal-parent')!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'terminal-parent',
        turnId: terminalTurn.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'terminal-parent', state: 'completed' });
      await h.runtime.whenIdle();
      const terminal = await h.execute('agent.create', {
        sessionId: 'terminal-child',
        workspaceId: 'workspace-1',
        title: 'Terminal child',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Must not run.',
        parentSessionId: 'terminal-parent',
      });
      expect(terminal).toMatchObject({ ok: false, error: { code: 'invalid-state' } });

      expect(await h.execute('agent.archive', { sessionId: 'terminal-parent' }))
        .toMatchObject({ ok: true });
      expect(h.router.getSnapshot().sessions.find((session) => session.id === 'terminal-parent'))
        .toMatchObject({ state: 'archived', archivedAt: '2026-09-04T10:00:00.000Z' });
      const archived = await h.execute('agent.create', {
        sessionId: 'archived-child',
        workspaceId: 'workspace-1',
        title: 'Archived child',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Must not run.',
        parentSessionId: 'terminal-parent',
      });
      expect(archived).toMatchObject({ ok: false, error: { code: 'invalid-state' } });

      h.codex.emit({
        kind: 'native-subagent',
        sessionId: 'terminal-parent',
        providerChildId: 'late-native',
        title: 'Late native child',
        state: 'working',
      });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().agentRelations.some((relation) => (
        relation.parentSessionId === 'terminal-parent'
      ))).toBe(false);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('rebases a detached subtree and enforces depth from the new root', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.router.applySystemCommit({
        mutations: [{ kind: 'runtime.update', value: { orchestrationToolsEnabled: true } }],
      });
      const create = (sessionId: string, parentSessionId?: string) => h.execute('agent.create', {
        sessionId,
        workspaceId: 'workspace-1',
        title: sessionId,
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: sessionId,
        ...(parentSessionId ? { parentSessionId } : {}),
      });
      await create('lead');
      await create('detached-root', 'lead');
      await create('depth-1', 'detached-root');
      h.codex.emit({
        kind: 'native-subagent',
        sessionId: 'depth-1',
        providerChildId: 'native-descendant',
        title: 'Native descendant',
        state: 'working',
      });
      await h.runtime.whenIdle();
      const nativeDescendantId = h.router.getSnapshot().agentRelations.find((relation) => (
        relation.parentSessionId === 'depth-1' && relation.owner === 'provider-native'
      ))!.childSessionId;
      await create('depth-2', 'depth-1');
      await create('depth-3', 'depth-2');

      expect(await h.execute('agent.detach', { sessionId: 'detached-root' }))
        .toMatchObject({ ok: true });
      expect(h.router.getSnapshot().agentRelations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          parentSessionId: 'lead',
          childSessionId: 'detached-root',
          detachedAt: '2026-09-04T10:00:00.000Z',
        }),
        expect.objectContaining({
          treeId: 'detached-root',
          parentSessionId: 'detached-root',
          childSessionId: 'depth-1',
          depth: 1,
        }),
        expect.objectContaining({
          treeId: 'detached-root',
          parentSessionId: 'depth-1',
          childSessionId: 'depth-2',
          depth: 2,
        }),
        expect.objectContaining({
          treeId: 'detached-root',
          parentSessionId: 'depth-2',
          childSessionId: 'depth-3',
          depth: 3,
        }),
        expect.objectContaining({
          treeId: 'detached-root',
          parentSessionId: 'depth-1',
          childSessionId: nativeDescendantId,
          owner: 'provider-native',
          depth: 2,
        }),
      ]));

      expect(await create('depth-4', 'depth-3')).toMatchObject({ ok: true });
      expect(await create('depth-overflow', 'depth-4')).toMatchObject({
        ok: false,
        error: { code: 'tree-depth-limit' },
      });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('preserves detached-subtree node and recent-creation accounting', async () => {
    let current = new Date('2026-09-04T10:00:00.000Z');
    const h = await harness({ now: () => current });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.router.applySystemCommit({
        mutations: [{ kind: 'runtime.update', value: { orchestrationToolsEnabled: true } }],
      });
      const create = (sessionId: string, parentSessionId?: string) => h.execute('agent.create', {
        sessionId,
        workspaceId: 'workspace-1',
        title: sessionId,
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: sessionId,
        ...(parentSessionId ? { parentSessionId } : {}),
      });
      await create('lead');
      await create('detached-root', 'lead');
      for (let index = 1; index <= 11; index += 1) {
        await create(`recent-${index}`, 'detached-root');
      }
      await h.execute('agent.detach', { sessionId: 'detached-root' });
      expect(await create('recent-12', 'detached-root')).toMatchObject({ ok: true });
      expect(await create('recent-overflow', 'detached-root')).toMatchObject({
        ok: false,
        error: { code: 'child-rate-limit' },
      });
      for (let index = 1; index <= 11; index += 1) {
        await create(`source-${index}`, 'lead');
      }
      expect(await create('source-overflow', 'lead')).toMatchObject({
        ok: false,
        error: { code: 'child-rate-limit' },
      });

      current = new Date('2026-09-04T10:11:00.000Z');
      for (let index = 13; index <= 14; index += 1) {
        await create(`node-${index}`, 'detached-root');
      }
      expect(await create('node-15', 'detached-root')).toMatchObject({ ok: true });
      expect(await create('node-overflow', 'detached-root')).toMatchObject({
        ok: false,
        error: { code: 'tree-node-limit' },
      });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
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

  it('interrupts only the active turn, preserves queued FIFO turns, and keeps the provider Session resumable', async () => {
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
        initialPrompt: 'First turn.',
      });
      const providerSessionId = h.router.getSnapshot().agents[0]!.providerSessionId;
      const first = h.router.getSnapshot().turns[0]!;
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Second turn.' });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Third turn.' });

      expect(await h.execute('agent.interrupt', { sessionId: 'agent-1' })).toMatchObject({ ok: true });
      expect(h.codex.interrupt).toHaveBeenCalledWith('agent-1', providerSessionId);
      expect(h.codex.disposeSession).not.toHaveBeenCalled();
      expect(h.router.getSnapshot().agents[0]).toMatchObject({
        currentTurnId: first.id,
        queuedTurnCount: 2,
        providerSessionId,
      });
      expect(h.router.getSnapshot().turns.filter((turn) => turn.state === 'queued')).toHaveLength(2);

      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: first.id,
        outcome: 'interrupted',
      });
      await h.runtime.whenIdle();

      expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.prompt)).toEqual([
        'First turn.',
        'Second turn.',
      ]);
      const second = h.router.getSnapshot().turns.find((turn) => (
        turn.id !== first.id && turn.state === 'working'
      ))!;
      expect(h.router.getSnapshot().agents[0]).toMatchObject({
        state: 'working',
        currentTurnId: second.id,
        queuedTurnCount: 1,
        providerSessionId,
      });
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: second.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.prompt)).toEqual([
        'First turn.',
        'Second turn.',
        'Third turn.',
      ]);
      const third = h.router.getSnapshot().turns.find((turn) => (
        ![first.id, second.id].includes(turn.id)
      ))!;
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: third.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'interrupted' });
      await h.runtime.whenIdle();

      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [{ id: 'agent-1', state: 'idle' }],
        agents: [{ sessionId: 'agent-1', state: 'idle', queuedTurnCount: 0, providerSessionId }],
      });
      expect(h.router.getSnapshot().agents[0]).not.toHaveProperty('currentTurnId');
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Post-interrupt turn.' });
      expect(h.codex.createSession).toHaveBeenCalledOnce();
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({
        providerSessionId,
        prompt: 'Post-interrupt turn.',
      }), expect.any(AbortSignal));
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('aborts startup rehydration and waits for it before the durable Quit transition', async () => {
    const first = await harness();
    let firstStoreClosed = false;
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
        initialPrompt: 'Resume this during startup.',
      });
      await first.runtime.dispose('process-loss');
      await first.store.close();
      firstStoreClosed = true;

      restartedStore = new DaemonStore(first.directory);
      await restartedStore.init();
      const codex = fakeAdapter('codex', 'codex-app-server');
      const claude = fakeAdapter('claude', 'claude-agent-sdk');
      let observedSignal: AbortSignal | undefined;
      let markStarted: (() => void) | undefined;
      const resumeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
      vi.mocked(codex.resumeSession).mockImplementation(async (_context, signal) => {
        observedSignal = signal;
        markStarted?.();
        return new Promise<never>((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error('rehydration did not observe shutdown')), 1_500);
          signal?.addEventListener('abort', () => {
            clearTimeout(fallback);
            reject(new Error('rehydration aborted'));
          }, { once: true });
        });
      });
      const providers = new AgentProviderRegistry([codex, claude]);
      const routerRef: { current?: DaemonCommandRouter } = {};
      const store = restartedStore;
      restartedRuntime = new DaemonAgentRuntime({
        providers,
        getSnapshot: () => routerRef.current!.getSnapshot(),
        applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
        applySystemTransition: (transition) => routerRef.current!.applySystemTransition(transition),
        readTranscript: (sessionId, afterSequence, limit) => (
          routerRef.current!.readTranscript(sessionId, afterSequence, limit)
        ),
        findCommand: (commandId) => store.findCommand(commandId)?.command,
      });
      const router = new DaemonCommandRouter(store, { handlers: restartedRuntime.handlers() });
      routerRef.current = router;

      const startup = restartedRuntime.start();
      await resumeStarted;
      router.beginShutdown();
      restartedRuntime.beginShutdown();
      const disposal = restartedRuntime.dispose();
      await settleWithin(Promise.all([startup, disposal]));

      expect(observedSignal?.aborted).toBe(true);
      expect(codex.resumeSession).toHaveBeenCalledOnce();
      expect(codex.reconcile).not.toHaveBeenCalled();
      expect(router.getSnapshot()).toMatchObject({
        sessions: [{ id: 'agent-1', state: 'idle' }],
        agents: [{ sessionId: 'agent-1', state: 'idle', queuedTurnCount: 0 }],
        turns: [{ sessionId: 'agent-1', state: 'interrupted', errorCode: 'explicit-quit' }],
      });
      expect(codex.dispose).toHaveBeenCalledOnce();
    } finally {
      await restartedRuntime?.dispose();
      await restartedStore?.close();
      await first.runtime.dispose('process-loss');
      if (!firstStoreClosed) await first.store.close();
    }
  });

  it('cancels the active turn and every queued successor without pumping them later', async () => {
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
        initialPrompt: 'First turn.',
      });
      const providerSessionId = h.router.getSnapshot().agents[0]!.providerSessionId;
      const first = h.router.getSnapshot().turns[0]!;
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Second turn.' });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Third turn.' });
      const successors = h.router.getSnapshot().turns.filter((turn) => turn.id !== first.id);

      await expect(h.execute('agent.cancel', { sessionId: 'agent-1' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });

      expect(h.codex.interrupt).toHaveBeenCalledWith('agent-1', providerSessionId);
      expect(h.router.getSnapshot().agents[0]).toMatchObject({
        currentTurnId: first.id,
        queuedTurnCount: 0,
        providerSessionId,
      });
      expect(successors).toHaveLength(2);
      for (const successor of successors) {
        expect(h.router.getSnapshot().turns.find((turn) => turn.id === successor.id))
          .toMatchObject({ state: 'interrupted', finishedAt: '2026-09-04T10:00:00.000Z' });
      }

      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: first.id,
        outcome: 'interrupted',
      });
      await h.runtime.whenIdle();
      expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.prompt)).toEqual(['First turn.']);
      expect(h.router.getSnapshot().agents[0]).toMatchObject({ state: 'idle', queuedTurnCount: 0 });
      expect(h.router.getSnapshot().agents[0]).not.toHaveProperty('currentTurnId');
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('does not let late start or working events erase a durable cancel intent', async () => {
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
        initialPrompt: 'Cancel during provider acceptance.',
      });
      const turn = h.router.getSnapshot().turns[0]!;

      await expect(h.execute('agent.cancel', { sessionId: 'agent-1' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      expect(h.router.getSnapshot().turns[0]).toMatchObject({
        id: turn.id,
        state: 'delivery-uncertain',
        errorCode: 'interrupt-requested',
      });

      h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'working' });
      h.codex.emit({
        kind: 'turn-started',
        sessionId: 'agent-1',
        turnId: turn.id,
        providerTurnId: 'provider-turn-late',
        commandId: turn.commandId,
      });
      await h.runtime.whenIdle();

      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'delivery-uncertain' })],
        agents: [expect.objectContaining({ sessionId: 'agent-1', state: 'delivery-uncertain' })],
        turns: [expect.objectContaining({
          id: turn.id,
          state: 'delivery-uncertain',
          errorCode: 'interrupt-requested',
          providerTurnId: 'provider-turn-late',
        })],
      });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('preserves durable interrupt intent after delivery failure and late provider events', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      vi.mocked(h.codex.interrupt).mockRejectedValueOnce(new Error('interrupt transport failed'));
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Interrupt this turn.',
      });
      const turn = h.router.getSnapshot().turns[0]!;

      await expect(h.execute('agent.interrupt', { sessionId: 'agent-1' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      expect(h.router.getSnapshot().turns[0]).toMatchObject({
        state: 'delivery-uncertain',
        errorCode: 'interrupt-failed',
      });

      h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'working' });
      h.codex.emit({
        kind: 'turn-started',
        sessionId: 'agent-1',
        turnId: turn.id,
        providerTurnId: 'provider-turn-late',
        commandId: turn.commandId,
      });
      await h.runtime.whenIdle();

      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'delivery-uncertain' })],
        agents: [expect.objectContaining({ sessionId: 'agent-1', state: 'delivery-uncertain' })],
        turns: [expect.objectContaining({
          id: turn.id,
          state: 'delivery-uncertain',
          errorCode: 'interrupt-failed',
          providerTurnId: 'provider-turn-late',
        })],
      });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('terminalizes queued successors when cancellation cannot reach an unavailable Provider', async () => {
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
        initialPrompt: 'Active turn.',
      });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Queued successor.' });
      const before = h.router.getSnapshot();
      const provider = before.providers.find((entry) => entry.id === 'codex')!;
      const active = before.turns.find((turn) => turn.id === before.agents[0]!.currentTurnId)!;
      const successor = before.turns.find((turn) => turn.state === 'queued')!;
      await h.router.applySystemCommit({
        mutations: [{
          kind: 'provider.upsert',
          value: {
            id: provider.id,
            displayName: provider.displayName,
            protocol: provider.protocol,
            executablePath: provider.executablePath,
            executableVersion: provider.executableVersion,
            argv: provider.argv,
            environmentVariableNames: provider.environmentVariableNames,
            capabilities: provider.capabilities,
            enabled: false,
            health: 'unknown',
          },
        }],
      });

      await expect(h.execute('agent.cancel', { sessionId: 'agent-1' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });

      expect(h.codex.interrupt).not.toHaveBeenCalled();
      expect(h.router.getSnapshot().turns.find((turn) => turn.id === successor.id)).toMatchObject({
        state: 'interrupted',
        errorCode: 'cancelled',
      });
      expect(h.router.getSnapshot().turns.find((turn) => turn.id === active.id)).toMatchObject({
        state: 'delivery-uncertain',
        errorCode: 'cancel-provider-unavailable',
      });
      expect(h.router.getSnapshot().agents[0]).toMatchObject({
        state: 'delivery-uncertain',
        queuedTurnCount: 0,
      });
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
      await first.router.applySystemCommit((snapshot) => {
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
      await first.runtime.dispose('process-loss');
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
        applySystemTransition: (transition) => routerRef.current!.applySystemTransition(transition),
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
      }), expect.any(AbortSignal));
      expect(codex.reconcile).toHaveBeenCalledWith(expect.objectContaining({
        unsettledCommands: [expect.objectContaining({
          commandId: originalTurn.commandId,
          turnId: originalTurn.id,
          state: 'working',
        })],
      }), expect.any(AbortSignal));
      expect(codex.createSession).toHaveBeenCalledOnce();
      expect(codex.createSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-2',
      }), expect.any(AbortSignal));
      expect(codex.submit).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-1',
        turnId: originalTurn.id,
        commandId: originalTurn.commandId,
        prompt: 'Recover this exact prompt.',
      }), expect.any(AbortSignal));
      expect(codex.submit).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-2',
        prompt: 'Recover the pre-provider claim.',
      }), expect.any(AbortSignal));
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
