import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandType,
  type DaemonPrincipal,
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
  readonly now?: () => Date;
  readonly shutdownStepTimeoutMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
  readonly revokeOrchestrationForSession?: (sessionId: string) => void;
  readonly conversationContext?: import('./daemon-agent-runtime').DaemonAgentRuntimeOptions['conversationContext'];
  readonly conversationWritable?: import('./daemon-agent-runtime').DaemonAgentRuntimeOptions['conversationWritable'];
  readonly subagentRecordExists?: import('./daemon-agent-runtime').DaemonAgentRuntimeOptions['subagentRecordExists'];
  readonly agentUsageStore?: import('./daemon-agent-runtime').DaemonAgentRuntimeOptions['agentUsageStore'];
  readonly conversationFolders?: import('./daemon-agent-runtime').DaemonAgentRuntimeOptions['conversationFolders'];
  readonly preparedSessionSettings?: import('./daemon-agent-runtime').DaemonAgentRuntimeOptions['preparedSessionSettings'];
  readonly phaseSettings?: import('./daemon-agent-runtime').DaemonAgentRuntimeOptions['phaseSettings'];
  readonly pendingSettingsStore?: import('./daemon-agent-runtime').DaemonAgentRuntimeOptions['pendingSettingsStore'];
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
    executeCommand: (command) => routerRef.current!.execute(command),
    now,
    idFactory: (() => {
      let id = 0;
      return () => `runtime-id-${++id}`;
    })(),
    ...options,
  });
  const router = new DaemonCommandRouter(store, {
    handlers: runtime.handlers(),
    agentUsage: (snapshot) => runtime.agentUsage(snapshot),
    sideQuestionSessions: (snapshot) => runtime.sideQuestionSessionIds(snapshot),
    pendingAgentSettings: (snapshot) => runtime.pendingAgentSettings(snapshot),
  });
  routerRef.current = router;
  await runtime.start();

  let commandSequence = 0;
  const executeWithoutSettling = async <T extends DaemonCommandType>(
    type: T,
    payload: Parameters<typeof createDaemonCommand<T>>[0]['payload'],
    principal: DaemonPrincipal = { kind: 'desktop', id: 'test' },
  ) => {
    const suffix = ++commandSequence;
    const receipt = await router.execute(createDaemonCommand({
      commandId: `command-${suffix}`,
      idempotencyKey: `test:${suffix}`,
      expectedRevision: store.getRevision(),
      issuedAt: '2026-09-04T10:00:00.000Z',
      principal,
      type,
      payload,
    }));
    return receipt;
  };
  const execute = async <T extends DaemonCommandType>(
    type: T,
    payload: Parameters<typeof createDaemonCommand<T>>[0]['payload'],
    principal?: DaemonPrincipal,
  ) => {
    const receipt = await executeWithoutSettling(type, payload, principal);
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

type RuntimeHarness = Awaited<ReturnType<typeof harness>>;

async function archiveWorkspaceOrProject(
  h: RuntimeHarness,
  owner: 'Workspace' | 'Project',
): Promise<void> {
  if (owner === 'Workspace') {
    const workspace = h.router.getSnapshot().workspaces.find((entry) => entry.id === 'workspace-1')!;
    await h.router.applySystemCommit({ mutations: [{
      kind: 'workspace.upsert',
      value: {
        id: workspace.id,
        projectId: workspace.projectId,
        name: workspace.name,
        kind: workspace.kind,
        rootPath: workspace.rootPath,
        archivedAt: '2026-09-04T10:01:00.000Z',
      },
    }] });
    return;
  }
  const project = h.router.getSnapshot().projects.find((entry) => entry.id === 'project-1')!;
  await h.router.applySystemCommit({ mutations: [{
    kind: 'project.upsert',
    value: {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      source: project.source,
      archivedAt: '2026-09-04T10:01:00.000Z',
    },
  }] });
}

describe('DaemonAgentRuntime conversation folders', () => {
  const createChat = (h: RuntimeHarness, initialPrompt = 'Read both folders.') => h.execute('agent.create', {
    sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'standard', initialPrompt,
  });
  const finishTurn = async (h: RuntimeHarness): Promise<void> => {
    const turn = h.router.getSnapshot().turns.filter((entry) => entry.sessionId === 'agent-1').at(-1)!;
    h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
    await h.runtime.whenIdle();
    h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'idle' });
    await h.runtime.whenIdle();
  };

  it('starts the provider session with the project folders and sends the current ones with every turn', async () => {
    let additional: string[] = ['C:\\Shared'];
    const conversationFolders = vi.fn(async () => ({ primary: 'C:\\Demo', additional, missing: [] }));
    const h = await harness({ conversationFolders });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await createChat(h);
      expect(conversationFolders).toHaveBeenCalledWith(expect.anything(), { projectId: 'project-1', workspaceId: 'workspace-1' });
      expect(h.codex.createSession).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: 'C:\\Demo', additionalRoots: ['C:\\Shared'] }), expect.any(AbortSignal));
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ additionalRoots: ['C:\\Shared'] }), expect.any(AbortSignal));

      await finishTurn(h);
      additional = [];
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'The folder was removed.' });
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'The folder was removed.', additionalRoots: [] }), expect.any(AbortSignal));
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('resumes a rehydrated session with the folders as they are now', async () => {
    let additional: string[] = ['C:\\Shared'];
    const h = await harness({ conversationFolders: async () => ({ primary: 'C:\\Demo', additional, missing: [] }) });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await createChat(h);
      await finishTurn(h);
      additional = ['C:\\Shared', 'C:\\Docs'];
      await h.execute('provider.disable', { providerId: 'codex' });
      await h.enable(h.codex, 'codex');
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'After re-enable.' });
      expect(h.codex.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'agent-1', additionalRoots: ['C:\\Shared', 'C:\\Docs'],
      }), expect.any(AbortSignal));
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('gives a tool-free session no extra folders', async () => {
    const h = await harness({
      conversationFolders: async () => ({ primary: 'C:\\Demo', additional: ['C:\\Shared'], missing: [] }),
      preparedSessionSettings: () => ({ toolsDisabled: true }),
    });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await createChat(h);
      expect(vi.mocked(h.codex.createSession).mock.calls[0]![0]).not.toHaveProperty('additionalRoots');
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ additionalRoots: [] }), expect.any(AbortSignal));
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('keeps the session to its working folder when the folders cannot be read', async () => {
    const reportError = vi.fn();
    const h = await harness({ conversationFolders: async () => { throw new Error('store unavailable'); }, reportError });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await createChat(h);
      expect(vi.mocked(h.codex.createSession).mock.calls[0]![0]).not.toHaveProperty('additionalRoots');
      expect(vi.mocked(h.codex.submit).mock.calls.at(-1)![0]).not.toHaveProperty('additionalRoots');
      expect(reportError).toHaveBeenCalledWith('conversation folders', expect.any(Error));
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });
});

// Restarts, stores and provider fakes: a test here takes seconds on a slow Windows runner (6-7 s seen), over the 5 s default.
describe('DaemonAgentRuntime', { timeout: 20_000 }, () => {
  it('binds host stage references to the accepted transcript and provider turn while rejecting forged client references', async () => {
    const reference = { projectId: 'project-1', subprojectId: 'sub', nodeId: 'stage', graphRevision: 3, fingerprint: 'a'.repeat(64), title: 'Plan', document: 'Saved document', instructions: '', references: [] };
    const context = vi.fn(async (_projectId: string, sessionId: string) => sessionId === 'stage-chat' ? reference : undefined);
    const h = await harness({ conversationContext: context });
    try {
      await h.prepareWorkspace(); await h.enable(h.codex, 'codex');
      await h.execute('agent.create', { sessionId: 'stage-chat', workspaceId: 'workspace-1', providerId: 'codex', title: 'Stage', permissionPreset: 'plan' });
      expect(await h.execute('agent.submit', { sessionId: 'stage-chat', prompt: 'Explain', context: { workflow: reference } })).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
      expect(await h.execute('agent.submit', { sessionId: 'stage-chat', prompt: 'Explain' })).toMatchObject({ ok: true });
      expect(h.codex.submit).toHaveBeenCalledWith(expect.objectContaining({ context: { workflow: reference } }), expect.anything());
      expect(h.store.getTranscript('stage-chat').find(item => item.kind === 'user-message')?.context?.workflow).toEqual(reference);
      await h.execute('agent.create', { sessionId: 'general', workspaceId: 'workspace-1', providerId: 'codex', title: 'General', permissionPreset: 'plan' });
      await h.execute('agent.submit', { sessionId: 'general', prompt: 'Question' });
      expect(h.store.getTranscript('general').find(item => item.kind === 'user-message')?.context?.workflow).toBeUndefined();
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });
  it('persists attachments with the accepted turn and rejects cross-session reply references', async () => {
    const h = await harness();
    try {
      await h.prepareWorkspace();
      await h.enable(h.codex, 'codex');
      expect((await h.execute('agent.create', {
        sessionId: 'chat-context', workspaceId: 'workspace-1',
        providerId: 'codex', title: 'Context', permissionPreset: 'standard',
      })).ok).toBe(true);
      await h.store.appendTranscriptBatch([{
        id: 'reply-source', sessionId: 'chat-context', kind: 'assistant-message', text: 'Earlier answer', isDelta: false, isSensitive: false,
      }]);
      const context = {
        replyTo: { messageId: 'reply-source', text: 'Earlier answer' },
        attachments: [{ id: 'a', name: 'notes.txt', kind: 'text' as const, mimeType: 'text/plain', data: 'Requirement' }],
      };
      expect((await h.execute('agent.submit', { sessionId: 'chat-context', prompt: 'Review', context })).ok).toBe(true);
      expect(h.codex.submit).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Review', context }), expect.anything());
      expect(h.store.getTranscript('chat-context').find((item) => item.kind === 'user-message')?.context).toEqual(context);
      expect((await h.execute('agent.create', {
        sessionId: 'other-chat', workspaceId: 'workspace-1',
        providerId: 'codex', title: 'Other', permissionPreset: 'standard',
      })).ok).toBe(true);
      expect(await h.execute('agent.submit', { sessionId: 'other-chat', prompt: 'Review', context })).toMatchObject({
        ok: false, error: { code: 'invalid-command' },
      });
      expect(h.store.getTranscript('other-chat')).toHaveLength(0);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
    const reopened = new DaemonStore(h.directory);
    await reopened.init();
    try {
      expect(reopened.getTranscript('chat-context').find((item) => item.kind === 'user-message')?.context?.attachments?.[0]?.data).toBe('Requirement');
    } finally { await reopened.close(); }
  });

  it.each(['Workspace', 'Project'] as const)(
    'ignores provider-native child events after a %s owner archive',
    async (owner) => {
      const h = await harness();
      try {
        await h.enable(h.codex, 'codex');
        await h.prepareWorkspace();
        await h.router.applySystemCommit({
          mutations: [{ kind: 'runtime.update', value: { orchestrationToolsEnabled: true } }],
        });
        await h.execute('agent.create', {
          sessionId: 'native-parent',
          workspaceId: 'workspace-1',
          title: 'Native parent',
          providerId: 'codex',
          permissionPreset: 'standard',
          initialPrompt: 'Own provider-native children.',
        });
        h.codex.emit({
          kind: 'native-subagent',
          sessionId: 'native-parent',
          providerChildId: 'terminal-native-child',
          title: 'Terminal native child',
          state: 'done',
        });
        await h.runtime.whenIdle();
        const terminalChildId = h.router.getSnapshot().agentRelations[0]!.childSessionId;

        await archiveWorkspaceOrProject(h, owner);
        h.codex.emit({
          kind: 'native-subagent',
          sessionId: 'native-parent',
          providerChildId: 'late-new-native-child',
          title: 'Late new native child',
          state: 'working',
        });
        h.codex.emit({
          kind: 'native-subagent',
          sessionId: 'native-parent',
          providerChildId: 'terminal-native-child',
          title: 'Terminal native child',
          state: 'working',
        });
        await h.runtime.whenIdle();

        expect(h.router.getSnapshot().sessions.find((session) => session.id === terminalChildId))
          .toMatchObject({ state: 'completed' });
        expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === terminalChildId))
          .toMatchObject({ state: 'done' });
        expect(h.router.getSnapshot().agentRelations).toHaveLength(1);
        expect(h.router.getSnapshot().sessions).toHaveLength(2);
      } finally {
        await h.runtime.dispose();
        await h.store.close();
      }
    },
  );

  it.each(['Workspace', 'Project'] as const)(
    'does not rehydrate a Session when %s archive wins the resumeSession race',
    async (owner) => {
      const h = await harness();
      let releaseResume: (() => void) | undefined;
      try {
        await h.enable(h.codex, 'codex');
        await h.prepareWorkspace();
        await h.execute('agent.create', {
          sessionId: 'resume-source',
          workspaceId: 'workspace-1',
          title: 'Resume source',
          providerId: 'codex',
          permissionPreset: 'standard',
          initialPrompt: 'Finish before transfer.',
        });
        const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'resume-source')!;
        const providerSessionId = h.router.getSnapshot().agents.find((agent) => (
          agent.sessionId === 'resume-source'
        ))!.providerSessionId!;
        h.codex.emit({
          kind: 'turn-finished',
          sessionId: 'resume-source',
          turnId: sourceTurn.id,
          outcome: 'completed',
        });
        await h.runtime.whenIdle();
        h.codex.emit({ kind: 'session-state', sessionId: 'resume-source', state: 'completed' });
        await h.runtime.whenIdle();

        const originalResume = vi.mocked(h.codex.resumeSession).getMockImplementation()!;
        let reportResumeStarted!: () => void;
        const resumeStarted = new Promise<void>((resolve) => { reportResumeStarted = resolve; });
        const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
        vi.mocked(h.codex.resumeSession).mockImplementationOnce(async (...args) => {
          reportResumeStarted();
          await resumeGate;
          return originalResume(...args);
        });
        await expect(h.executeWithoutSettling('agent.resume', {
          sessionId: 'resume-destination',
          sourceSessionId: 'resume-source',
          workspaceId: 'workspace-1',
          providerId: 'codex',
          providerSessionId,
          title: 'Resume destination',
          permissionPreset: 'standard',
        })).resolves.toMatchObject({ ok: true, status: 'applied' });
        await resumeStarted;
        await archiveWorkspaceOrProject(h, owner);

        releaseResume?.();
        releaseResume = undefined;
        await h.runtime.whenIdle();

        expect(h.router.getSnapshot().sessions.find((session) => session.id === 'resume-destination'))
          .toMatchObject({ state: 'starting' });
        expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'resume-destination'))
          .toMatchObject({ state: 'starting', providerSessionId });
        expect(h.codex.ownerOf(providerSessionId)).toBeUndefined();
      } finally {
        releaseResume?.();
        await h.runtime.dispose();
        await h.store.close();
      }
    },
  );

  it('rejects an active Workspace whose owner Project is archived', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      const project = h.router.getSnapshot().projects.find((entry) => entry.id === 'project-1')!;
      await h.router.applySystemCommit({ mutations: [{
        kind: 'project.upsert',
        value: {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          source: project.source,
          archivedAt: '2026-09-04T10:01:00.000Z',
        },
      }] });

      await expect(h.execute('agent.create', {
        sessionId: 'agent-after-project-archive',
        workspaceId: 'workspace-1',
        title: 'Agent after Project archive',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'This must not reach the archived Project.',
      })).resolves.toMatchObject({
        ok: false,
        status: 'rejected',
        error: { code: 'not-found' },
      });
      expect(h.codex.createSession).not.toHaveBeenCalled();
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('lets an active turn finish but rejects new turns after its Workspace access is archived', async () => {
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
        initialPrompt: 'Finish the current turn.',
      });
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      await h.execute('agent.submit', {
        sessionId: 'agent-1',
        prompt: 'This queued turn must not start after access is revoked.',
      });
      const queuedTurn = h.router.getSnapshot().turns.find((entry) => (
        entry.sessionId === 'agent-1' && entry.id !== turn.id
      ))!;
      expect(queuedTurn.state).toBe('queued');

      const workspace = h.router.getSnapshot().workspaces.find((entry) => entry.id === 'workspace-1')!;
      await h.router.applySystemCommit({ mutations: [{
        kind: 'workspace.upsert',
        value: {
          id: workspace.id,
          projectId: workspace.projectId,
          name: workspace.name,
          kind: workspace.kind,
          rootPath: workspace.rootPath,
          archivedAt: '2026-09-04T10:01:00.000Z',
        },
      }] });

      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().turns.find((entry) => entry.id === queuedTurn.id)).toMatchObject({
        state: 'failed',
        errorCode: 'queue-state-invalid',
      });

      await expect(h.execute('agent.submit', {
        sessionId: 'agent-1',
        prompt: 'This must not reach the revoked Workspace.',
      })).resolves.toMatchObject({
        ok: false,
        status: 'rejected',
        error: { code: 'not-found' },
      });
      expect(h.codex.submit).toHaveBeenCalledTimes(1);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('shows the last saved usage before any reply, refreshes clients when it changes, and saves it', async () => {
    const weekly = { usedPercent: 26, resetsAt: 1_000 };
    const saved: unknown[] = [];
    const h = await harness({
      agentUsageStore: {
        load: async () => ({ version: 1, providers: { codex: { weekly, observedAt: 5 } }, contexts: {} }),
        save: async (state) => { saved.push(state); },
      },
    });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'standard',
        initialPrompt: 'Work.',
      });
      // The saved limits show as soon as the conversation exists, and for a conversation not started yet.
      expect(h.router.getSnapshot().agentUsage).toEqual({ 'agent-1': { weekly, limitsObservedAt: 5 } });
      expect(h.router.getSnapshot().providerUsage).toEqual({ codex: { weekly, limitsObservedAt: 5 } });

      const seenOnRefresh: unknown[] = [];
      const unsubscribe = h.router.onEvent((event) => {
        if (event.kind === 'entity.upserted') seenOnRefresh.push(h.router.getSnapshot().agentUsage?.['agent-1']);
      });
      h.codex.emit({ kind: 'usage', sessionId: 'agent-1', contextPercent: 3 });
      await h.runtime.whenIdle();
      unsubscribe();

      const now = Date.parse('2026-09-04T10:00:00.000Z');
      expect(seenOnRefresh).toEqual([{ weekly, limitsObservedAt: 5, contextPercent: 3, contextObservedAt: now }]);
      expect(saved.at(-1)).toEqual({ version: 1, providers: { codex: { weekly, observedAt: 5 } }, contexts: { 'agent-1': { percent: 3, observedAt: now } } });

      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      await h.execute('agent.archive', { sessionId: 'agent-1' });
      expect(h.router.getSnapshot().agentUsage).toBeUndefined();
      expect(h.router.getSnapshot().providerUsage).toEqual({ codex: { weekly, limitsObservedAt: 5 } });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

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

  it('records the model and effort a provider applies when the user chose neither', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    vi.mocked(h.codex.createSession).mockImplementationOnce(async (context) => ({
      sessionId: context.sessionId, providerSessionId: 'codex-defaults', model: 'gpt-6-astra', reasoningEffort: 'high', permissionPreset: context.permissionPreset,
    }));
    await h.execute('agent.create', {
      sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Hi.',
    });
    expect(h.router.getSnapshot().agents[0]).toMatchObject({ sessionId: 'agent-1', model: 'gpt-6-astra', reasoningEffort: 'high' });
    await h.runtime.dispose();
    await h.store.close();
  });

  it('keeps a chosen effort when a resumed provider session reports its own default', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-source', workspaceId: 'workspace-1', title: 'Source', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Go.',
      });
      const sourceTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'agent-source')!;
      const providerSessionId = h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-source')!.providerSessionId!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-source', turnId: sourceTurn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-source', state: 'completed' });
      await h.runtime.whenIdle();
      vi.mocked(h.codex.resumeSession).mockImplementationOnce(async (context) => ({
        sessionId: context.sessionId, providerSessionId: context.providerSessionId, reasoningEffort: 'medium', permissionPreset: context.permissionPreset,
      }));
      await h.execute('agent.resume', {
        sessionId: 'agent-resumed', sourceSessionId: 'agent-source', workspaceId: 'workspace-1', providerId: 'codex',
        providerSessionId, title: 'Resumed', permissionPreset: 'standard', reasoningEffort: 'xhigh',
      });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-resumed')).toMatchObject({ reasoningEffort: 'xhigh' });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
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

  it('archives a background task once recorded as a Claude subagent, with evidence, and can restore it', async () => {
    const first = await harness();
    let restartedRuntime: DaemonAgentRuntime | undefined;
    let restartedStore: DaemonStore | undefined;
    try {
      await first.enable(first.claude, 'claude');
      await first.prepareWorkspace();
      await first.execute('agent.create', {
        sessionId: 'lead',
        workspaceId: 'workspace-1',
        title: 'Lead',
        providerId: 'claude',
        permissionPreset: 'standard',
        initialPrompt: 'Lead the work.',
      });
      for (const providerChildId of ['bgouojd3c', 'a0123456789abcdef']) {
        first.claude.emit({ kind: 'native-subagent', sessionId: 'lead', providerChildId, title: 'Claude subagent', state: 'done' });
      }
      await first.runtime.whenIdle();
      const childOf = (providerChildId: string) => first.router.getSnapshot().agents.find((agent) => agent.providerSessionId === providerChildId)!.sessionId;
      const shell = childOf('bgouojd3c');
      const real = childOf('a0123456789abcdef');
      // What builds before this change stored for every task: one lifecycle notice.
      await first.router.applySystemCommit({ mutations: [{ kind: 'transcript.append', items: [shell, real].map((sessionId) => ({
        id: `old-notice-${sessionId}`, sessionId, kind: 'notice' as const, text: 'Subagent completed.', isDelta: false, isSensitive: false,
      })) }] });
      await first.runtime.dispose();
      await first.store.close();

      restartedStore = new DaemonStore(first.directory, { now: () => new Date('2026-09-04T10:01:00.000Z') });
      await restartedStore.init();
      const store = restartedStore;
      const providers = new AgentProviderRegistry([fakeAdapter('codex', 'codex-app-server'), fakeAdapter('claude', 'claude-agent-sdk')]);
      const routerRef: { current?: DaemonCommandRouter } = {};
      const evidence = vi.fn((input: { readonly childProviderSessionId: string }) => input.childProviderSessionId.startsWith('a'));
      restartedRuntime = new DaemonAgentRuntime({
        providers,
        getSnapshot: () => routerRef.current!.getSnapshot(),
        applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
        applySystemTransition: (transition) => routerRef.current!.applySystemTransition(transition),
        readTranscript: (sessionId, afterSequence, limit) => routerRef.current!.readTranscript(sessionId, afterSequence, limit),
        findCommand: (commandId) => store.findCommand(commandId)?.command,
        findMigrationReceipt: (id) => store.getMigrationReceipt(id),
        subagentRecordExists: evidence,
        now: () => new Date('2026-09-04T10:01:00.000Z'),
      });
      const router = new DaemonCommandRouter(store, { handlers: restartedRuntime.handlers() });
      routerRef.current = router;
      await restartedRuntime.start();

      expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'claude', childProviderSessionId: 'bgouojd3c' }));
      const session = (id: string) => router.getSnapshot().sessions.find((entry) => entry.id === id)!;
      expect(session(shell)).toMatchObject({ state: 'archived' });
      expect(session(real).state).not.toBe('archived');
      expect(store.listMigrationReceipts('provider-native-repair')).toEqual([
        expect.objectContaining({ detail: expect.objectContaining({ sessionId: shell, providerSessionId: 'bgouojd3c' }) }),
      ]);

      expect(await restartedRuntime.restoreProviderNativeRepair()).toEqual([shell]);
      expect(session(shell).state).toBe('completed');
      expect(session(shell).archivedAt).toBeUndefined();
    } finally {
      await restartedRuntime?.dispose();
      await restartedStore?.close();
    }
  });

  it('archives nothing when the provider record cannot be read', async () => {
    const h = await harness({ subagentRecordExists: () => undefined });
    try {
      await h.enable(h.claude, 'claude');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'lead', workspaceId: 'workspace-1', title: 'Lead', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Lead.',
      });
      h.claude.emit({ kind: 'native-subagent', sessionId: 'lead', providerChildId: 'bgouojd3c', title: 'Claude subagent', state: 'done' });
      await h.runtime.whenIdle();
      await (h.runtime as unknown as { settleProviderNativeChildren(): Promise<void> }).settleProviderNativeChildren();
      expect(h.router.getSnapshot().sessions.some((entry) => entry.state === 'archived')).toBe(false);
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
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
      expect(codex.resumeSession).not.toHaveBeenCalled();

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
      expect(codex.resumeSession).toHaveBeenCalledOnce();
      expect(codex.resumeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'agent-1', providerSessionId }), expect.any(AbortSignal));
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

  it('shows a provider-native subagent with orchestration off: link, instruction, its own rows and one result', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'lead',
      workspaceId: 'workspace-1',
      title: 'Lead',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Lead the work.',
    });
    expect(h.router.getSnapshot().runtime.orchestrationToolsEnabled).toBe(false);

    h.codex.emit({
      kind: 'native-subagent',
      sessionId: 'lead',
      providerChildId: 'native-1',
      title: 'Native reviewer',
      state: 'starting',
      toolUseId: 'call-1',
      subagentType: 'reviewer',
      instruction: 'Review the change without editing.',
    });
    await h.runtime.whenIdle();
    const child = h.router.getSnapshot().agentRelations[0]!.childSessionId;
    h.codex.emit({ kind: 'transcript', providerChildId: 'native-1', item: {
      id: 'child-row', sessionId: 'lead', turnId: 'not-the-childs', sequence: 1, kind: 'assistant-message',
      text: 'The change is safe.', isDelta: false, isSensitive: true, createdAt: '2026-10-17T00:00:00.000Z',
    } });
    // A row for a subagent that was never shown is dropped, not put in the parent.
    h.codex.emit({ kind: 'transcript', providerChildId: 'unknown', item: {
      id: 'stray-row', sessionId: 'lead', sequence: 2, kind: 'assistant-message',
      text: 'Stray.', isDelta: false, isSensitive: true, createdAt: '2026-10-17T00:00:00.000Z',
    } });
    h.codex.emit({ kind: 'native-subagent', sessionId: 'lead', providerChildId: 'native-1', title: 'Native reviewer', state: 'working', summary: 'Reading the diff' });
    h.codex.emit({ kind: 'native-subagent', sessionId: 'lead', providerChildId: 'native-1', title: 'Native reviewer', state: 'done', toolUseId: 'call-1', summary: 'The native review completed safely.' });
    h.codex.emit({ kind: 'native-subagent', sessionId: 'lead', providerChildId: 'native-1', title: 'Native reviewer', state: 'done', toolUseId: 'call-1', summary: 'The native review completed safely.' });
    await h.runtime.whenIdle();

    expect(h.router.getSnapshot().agentRelations[0]).toMatchObject({ owner: 'provider-native', parentSessionId: 'lead' });
    expect(h.router.getSnapshot().sessions.find((session) => session.id === child)).toMatchObject({ state: 'completed', title: 'Native reviewer' });
    const parentRows = h.router.readTranscript('lead');
    expect(parentRows.filter((item) => item.relatedSessionId === child).map((item) => [item.kind, (item.payload as { role?: string } | undefined)?.role])).toEqual([
      ['notice', 'link'],
      ['child-summary', 'result'],
    ]);
    expect(parentRows.some((item) => /Reading the diff|The change is safe|Stray/u.test(item.text))).toBe(false);
    const childRows = h.router.readTranscript(child);
    expect(childRows.map((item) => [item.kind, item.text, item.turnId])).toEqual([
      ['user-message', 'Review the change without editing.', undefined],
      ['assistant-message', 'The change is safe.', undefined],
    ]);
    await h.runtime.dispose();
    await h.store.close();
  });

  it('keeps a subagent approval on the parent, labelled, and not tied to the parent turn', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'lead',
      workspaceId: 'workspace-1',
      title: 'Lead',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Lead the work.',
    });
    h.codex.emit({ kind: 'native-subagent', sessionId: 'lead', providerChildId: 'native-1', title: 'Delete README', state: 'working' });
    await h.runtime.whenIdle();
    const child = h.router.getSnapshot().agentRelations[0]!.childSessionId;
    h.codex.emit({
      kind: 'approval-requested',
      sessionId: 'lead',
      providerChildId: 'native-1',
      providerRequestId: 'request-1',
      risk: 'danger',
      title: 'Run command',
      detail: 'Remove-Item README.md',
      request: { v: 1, kind: 'command', command: 'Remove-Item README.md' },
    });
    await h.runtime.whenIdle();
    const approval = h.router.getSnapshot().approvals.find((entry) => entry.providerRequestId === 'request-1')!;
    expect(approval).toMatchObject({ sessionId: 'lead', state: 'pending', detail: 'Delete README: Remove-Item README.md' });
    expect(approval.turnId).toBeUndefined();
    expect(approval.request).toMatchObject({ kind: 'command', subagent: { sessionId: child, title: 'Delete README' } });
    await h.runtime.dispose();
    await h.store.close();
  });

  it('shows more provider-native subagents than the managed tree allows', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'lead',
      workspaceId: 'workspace-1',
      title: 'Lead',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Lead the work.',
    });
    for (let index = 0; index < 22; index += 1) {
      h.codex.emit({ kind: 'native-subagent', sessionId: 'lead', providerChildId: `native-${String(index)}`, title: `Worker ${String(index)}`, state: 'working' });
    }
    await h.runtime.whenIdle();
    expect(h.router.getSnapshot().agentRelations.filter((relation) => relation.owner === 'provider-native')).toHaveLength(22);
    expect(h.router.readTranscript('lead').some((item) => item.kind === 'error')).toBe(false);
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

  it('lets a person hand work off with orchestration off and reports the result back once', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'lead', workspaceId: 'workspace-1', title: 'Lead', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Build it.',
      });
      const leadTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'lead')!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'lead', turnId: leadTurn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().runtime.orchestrationToolsEnabled).toBe(false);

      // An agent cannot, the person can.
      expect(await h.execute('agent.create', {
        sessionId: 'agent-made', workspaceId: 'workspace-1', title: 'Agent made', providerId: 'codex', permissionPreset: 'standard',
        initialPrompt: 'No.', parentSessionId: 'lead',
      }, { kind: 'mcp', id: 'session-lead', sessionId: 'lead' })).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      expect(await h.execute('agent.create', {
        sessionId: 'reviewer', workspaceId: 'workspace-1', title: 'Review the change', providerId: 'codex', permissionPreset: 'plan',
        reasoningEffort: 'high', initialPrompt: 'Review the login change.', parentSessionId: 'lead', reportBack: true,
      })).toMatchObject({ ok: true });
      const snapshot = h.router.getSnapshot();
      expect(snapshot.agentRelations).toEqual([expect.objectContaining({ parentSessionId: 'lead', childSessionId: 'reviewer', owner: 'managed' })]);
      expect(snapshot.agents.find((agent) => agent.sessionId === 'reviewer')).toMatchObject({ reasoningEffort: 'high', orchestrationEnabled: false });
      expect(h.router.readTranscript('reviewer')[0]).toMatchObject({
        kind: 'notice', relatedSessionId: 'lead', payload: { type: 'subagent', role: 'link', parentSessionId: 'lead', reportBack: true },
      });

      const reviewTurn = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'reviewer')!;
      // The parent hears the child's answer, not the provider's status line.
      h.codex.emit({ kind: 'transcript', item: {
        id: 'review-answer', sessionId: 'reviewer', turnId: reviewTurn.id, sequence: 1, kind: 'assistant-message',
        text: 'One edge case is unhandled.', isDelta: false, isSensitive: true, createdAt: '2026-10-17T00:00:00.000Z',
      } });
      // The first try loses a revision race; the retry is a new command and lands.
      const execute = h.router.execute.bind(h.router);
      let conflicted = false;
      vi.spyOn(h.router, 'execute').mockImplementation(async (value: unknown) => {
        const command = value as DaemonCommand;
        if (!conflicted && command.type === 'agent.submit' && command.payload.reportOf) {
          conflicted = true;
          return { ok: false, status: 'rejected', commandId: command.commandId, revision: 0,
            error: { code: 'revision-conflict', message: 'Snapshot advanced', retryable: true } };
        }
        return execute(command);
      });
      h.codex.emit({ kind: 'turn-finished', sessionId: 'reviewer', turnId: reviewTurn.id, outcome: 'completed', summary: 'Codex completed the turn.' });
      await h.runtime.whenIdle();
      expect(conflicted).toBe(true);
      const leadRows = h.router.readTranscript('lead');
      expect(leadRows.filter((item) => item.kind === 'child-summary')).toEqual([]);
      const report = leadRows.find((item) => item.kind === 'user-message' && item.payload?.type === 'subagent');
      expect(report?.text).not.toContain('Codex completed the turn.');
      expect(report).toMatchObject({
        text: expect.stringMatching(/handed work to a subagent \("Review the change"\)[^]*One edge case is unhandled\./u),
        payload: { type: 'subagent', role: 'result', childSessionId: 'reviewer', title: 'Review the change', state: 'done' },
      });
      // The report lands in a conversation a person runs: a plan there still asks the person.
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: 'lead', prompt: expect.stringContaining('One edge case is unhandled.'), attended: true,
      }), expect.any(AbortSignal));

      // Only the host sends a report; a client cannot label its own message as one.
      expect(await h.execute('agent.submit', { sessionId: 'lead', prompt: 'Pretend result.', reportOf: 'reviewer' }))
        .toMatchObject({ ok: false, error: { code: 'invalid-command' } });

      // Further turns of the child do not report again; the parent gets the usual summary.
      await h.execute('agent.submit', { sessionId: 'reviewer', prompt: 'Check once more.' });
      const second = h.router.getSnapshot().turns.find((turn) => turn.sessionId === 'reviewer' && turn.id !== reviewTurn.id)!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'reviewer', turnId: second.id, outcome: 'completed', summary: 'Still one.' });
      await h.runtime.whenIdle();
      const after = h.router.readTranscript('lead');
      expect(after.filter((item) => item.kind === 'user-message' && item.payload?.type === 'subagent')).toHaveLength(1);
      expect(after.filter((item) => item.kind === 'child-summary')).toEqual([expect.objectContaining({ text: 'Still one.' })]);
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
      }, { kind: 'mcp', id: 'session-disabled-parent', sessionId: 'disabled-parent' });
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

  it('fails a turn at once when the provider session cannot start, since the prompt never left', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    vi.mocked(h.codex.createSession).mockRejectedValueOnce(Object.assign(
      new Error('The Claude executable path or version no longer matches the pinned Agent SDK review.'),
      { code: 'CLAUDE_EXECUTABLE_INVALID' },
    ));
    await h.execute('agent.create', {
      sessionId: 'agent-1',
      workspaceId: 'workspace-1',
      title: 'Agent',
      providerId: 'codex',
      permissionPreset: 'standard',
      initialPrompt: 'Read the README.',
    });
    await h.runtime.whenIdle();
    const snapshot = h.router.getSnapshot();
    expect(snapshot.turns[0]).toMatchObject({ state: 'failed', errorCode: 'CLAUDE_EXECUTABLE_INVALID' });
    expect(snapshot.agents[0]).toMatchObject({ state: 'idle' });
    expect(snapshot.agents[0]?.currentTurnId).toBeUndefined();
    expect(snapshot.sessions[0]?.state).not.toBe('delivery-uncertain');
    expect(h.codex.submit).not.toHaveBeenCalled();
    await h.runtime.dispose();
    await h.store.close();
  });

  it('leaves plan mode for the mode chosen when a plan is approved', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'agent-1',
      workspaceId: 'workspace-1',
      title: 'Agent',
      providerId: 'codex',
      permissionPreset: 'plan',
      initialPrompt: 'Plan a change.',
    });
    const turn = h.router.getSnapshot().turns[0]!;
    h.codex.emit({
      kind: 'approval-requested',
      sessionId: 'agent-1',
      turnId: turn.id,
      providerRequestId: 'provider-plan-1',
      risk: 'write',
      title: 'Approve plan',
      request: { v: 1, kind: 'plan', callId: 'call-plan', markdown: '- step' },
    });
    await h.runtime.whenIdle();
    const approval = h.router.getSnapshot().approvals[0]!;
    expect(h.router.getSnapshot().agents[0]).toMatchObject({ permissionPreset: 'plan' });

    await h.execute('permission.resolve', {
      approvalId: approval.id, decision: 'allow', response: { kind: 'plan', mode: 'full-access' },
    });
    expect(h.codex.resolveApproval).toHaveBeenCalledWith(expect.objectContaining({
      providerRequestId: 'provider-plan-1',
      decision: 'allow',
      response: { kind: 'plan', mode: 'full-access' },
    }));
    expect(h.router.getSnapshot().agents[0]).toMatchObject({ permissionPreset: 'full-access', state: 'working' });
    await h.runtime.dispose();
    await h.store.close();
  });

  it('leaves plan mode for asking before running when a client approves a plan without choosing', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'plan', initialPrompt: 'Plan a change.',
    });
    const turn = h.router.getSnapshot().turns[0]!;
    h.codex.emit({
      kind: 'approval-requested', sessionId: 'agent-1', turnId: turn.id, providerRequestId: 'provider-plan-1', risk: 'write', title: 'Approve plan',
      request: { v: 1, kind: 'plan', callId: 'call-plan', markdown: '- step' },
    });
    await h.runtime.whenIdle();
    await h.execute('permission.resolve', { approvalId: h.router.getSnapshot().approvals[0]!.id, decision: 'allow' });
    // The CLI leaves plan mode for asking before running; the preset must not stay `plan`.
    expect(h.router.getSnapshot().agents[0]).toMatchObject({ permissionPreset: 'standard' });
    await h.runtime.dispose();
    await h.store.close();
  });

  it('runs a plan Codex proposed once the person approves it, and retires it when they type instead', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'plan', initialPrompt: 'Plan a change.',
    });
    const propose = async (id: string): Promise<string> => {
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1' && !['completed', 'failed', 'interrupted'].includes(entry.state));
      if (turn) h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      h.codex.emit({ kind: 'approval-requested', sessionId: 'agent-1', providerRequestId: `proposed-plan:${id}`, risk: 'write', title: 'Approve plan',
        request: { v: 1, kind: 'plan', markdown: '- step' } });
      await h.runtime.whenIdle();
      return h.router.getSnapshot().approvals.find((approval) => approval.providerRequestId === `proposed-plan:${id}`)!.id;
    };
    const first = await propose('provider-turn-1');
    expect(h.router.getSnapshot().agents[0]).toMatchObject({ state: 'blocked' });

    // Typing instead retires the proposal, as in Codex.
    await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Also cover the README.' });
    expect(h.router.getSnapshot().approvals.find((approval) => approval.id === first)).toMatchObject({ state: 'expired' });

    const second = await propose('provider-turn-2');
    await h.execute('permission.resolve', { approvalId: second, decision: 'allow', response: { kind: 'plan', mode: 'standard' } });
    await vi.waitFor(() => expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'agent-1', prompt: 'Implement the plan above.', attended: true,
    }), expect.anything()));
    expect(h.router.getSnapshot().agents[0]).toMatchObject({ permissionPreset: 'standard' });
    await h.runtime.dispose();
    await h.store.close();
  });

  it('tells the provider whether a person sent the turn', async () => {
    const h = await harness();
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', {
      sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'plan', initialPrompt: 'Plan a change.',
    });
    expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'agent-1', attended: true }), expect.anything());
    await h.execute('agent.create', {
      sessionId: 'agent-phone', workspaceId: 'workspace-1', title: 'Phone', providerId: 'codex', permissionPreset: 'plan', initialPrompt: 'Plan from the phone.',
    }, { kind: 'android', id: 'phone' });
    expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'agent-phone', attended: true }), expect.anything());
    // A delegated child works on its own, although a person handed the work off.
    await h.execute('agent.create', {
      sessionId: 'agent-child', workspaceId: 'workspace-1', title: 'Child', providerId: 'codex', permissionPreset: 'plan',
      initialPrompt: 'Plan the tests.', parentSessionId: 'agent-1',
    });
    expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'agent-child', attended: false }), expect.anything());
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
          messageId: 'provider-message',
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
    expect(providerDeltas.map((item) => item.messageId)).toEqual(['provider-message', 'provider-message']);
    expect(providerDeltas.map((item) => item.isDelta)).toEqual([false, true]);
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

  it('keeps a Claude cancel fence through unscoped api_retry and running events', async () => {
    const h = await harness();
    try {
      await h.enable(h.claude, 'claude');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'claude',
        permissionPreset: 'standard',
        initialPrompt: 'Cancel before Claude retries.',
      });
      const turn = h.router.getSnapshot().turns[0]!;
      await h.execute('agent.cancel', { sessionId: 'agent-1' });
      expect(h.router.getSnapshot().turns[0]).toMatchObject({
        id: turn.id,
        state: 'delivery-uncertain',
        errorCode: 'interrupt-requested',
      });

      h.claude.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        code: 'CLAUDE_RATE_LIMITED',
        message: 'Claude API retry after rate limiting.',
        recoverable: true,
      });
      h.claude.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'working' });
      await h.runtime.whenIdle();

      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'delivery-uncertain' })],
        agents: [expect.objectContaining({
          sessionId: 'agent-1',
          currentTurnId: turn.id,
          state: 'delivery-uncertain',
        })],
        turns: [expect.objectContaining({
          id: turn.id,
          state: 'delivery-uncertain',
          errorCode: 'interrupt-requested',
        })],
      });
      expect(h.router.readTranscript('agent-1')).toContainEqual(expect.objectContaining({
        turnId: turn.id,
        kind: 'error',
        text: 'Claude API retry after rate limiting.',
      }));
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('keeps a persisted Claude cancel fence through api_retry and running after restart', async () => {
    const first = await harness();
    let restartedRuntime: DaemonAgentRuntime | undefined;
    let restartedStore: DaemonStore | undefined;
    let firstStoreClosed = false;
    try {
      await first.enable(first.claude, 'claude');
      await first.prepareWorkspace();
      await first.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'claude',
        permissionPreset: 'standard',
        initialPrompt: 'Persist the Claude cancellation.',
      });
      const turn = first.router.getSnapshot().turns[0]!;
      await first.execute('agent.cancel', { sessionId: 'agent-1' });
      expect(first.router.getSnapshot().turns[0]).toMatchObject({
        id: turn.id,
        state: 'delivery-uncertain',
        errorCode: 'interrupt-requested',
      });
      await first.runtime.dispose('process-loss');
      await first.store.close();
      firstStoreClosed = true;

      restartedStore = new DaemonStore(first.directory, {
        now: () => new Date('2026-09-04T10:00:00.000Z'),
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
        now: () => new Date('2026-09-04T10:00:00.000Z'),
      });
      const router = new DaemonCommandRouter(store, { handlers: restartedRuntime.handlers() });
      routerRef.current = router;
      await restartedRuntime.start();
      await restartedRuntime.whenIdle();
      expect(router.getSnapshot().turns[0]).toMatchObject({
        id: turn.id,
        state: 'delivery-uncertain',
        errorCode: 'interrupt-requested',
      });

      claude.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        code: 'CLAUDE_RATE_LIMITED',
        message: 'Claude API retry after restart.',
        recoverable: true,
      });
      claude.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'working' });
      await restartedRuntime.whenIdle();

      expect(router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'delivery-uncertain' })],
        agents: [expect.objectContaining({
          sessionId: 'agent-1',
          currentTurnId: turn.id,
          state: 'delivery-uncertain',
        })],
        turns: [expect.objectContaining({
          id: turn.id,
          state: 'delivery-uncertain',
          errorCode: 'interrupt-requested',
        })],
      });
      expect(router.readTranscript('agent-1')).toContainEqual(expect.objectContaining({
        turnId: turn.id,
        kind: 'error',
        text: 'Claude API retry after restart.',
      }));
    } finally {
      await restartedRuntime?.dispose('process-loss');
      await restartedStore?.close();
      await first.runtime.dispose('process-loss');
      if (!firstStoreClosed) await first.store.close();
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

  it.each([
    ['codex', 'codex'] as const,
    ['claude', 'claude'] as const,
  ])('does not let a late %s interrupt rejection mark its pumped successor uncertain', async (_label, providerId) => {
    const h = await harness();
    let rejectInterrupt!: (error: Error) => void;
    try {
      const adapter = providerId === 'codex' ? h.codex : h.claude;
      await h.enable(adapter, providerId);
      await h.prepareWorkspace();
      const interruptBlocked = new Promise<void>((_resolve, reject) => {
        rejectInterrupt = reject;
      });
      vi.mocked(adapter.interrupt).mockReturnValueOnce(interruptBlocked);
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId,
        permissionPreset: 'standard',
        initialPrompt: 'First turn.',
      });
      const first = h.router.getSnapshot().turns[0]!;
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Successor turn.' });
      const successor = h.router.getSnapshot().turns.find((turn) => turn.id !== first.id)!;

      await expect(h.executeWithoutSettling('agent.interrupt', { sessionId: 'agent-1' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      await vi.waitFor(() => expect(adapter.interrupt).toHaveBeenCalledOnce());
      adapter.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: first.id,
        outcome: 'interrupted',
      });
      await vi.waitFor(() => {
        expect(h.router.getSnapshot().agents[0]).toMatchObject({
          currentTurnId: successor.id,
          state: 'working',
        });
      });

      rejectInterrupt(new Error('late predecessor interrupt failure'));
      await h.runtime.whenIdle();

      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'running' })],
        agents: [expect.objectContaining({
          sessionId: 'agent-1',
          currentTurnId: successor.id,
          state: 'working',
        })],
        turns: expect.arrayContaining([
          expect.objectContaining({ id: first.id, state: 'interrupted' }),
          expect.objectContaining({ id: successor.id, state: 'working' }),
        ]),
      });
    } finally {
      rejectInterrupt?.(new Error('test cleanup'));
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it.each([
    'provider-error-last',
    'request-catch-last',
  ] as const)('preserves cancel intent when interrupt failure commits settle in %s order', async (order) => {
    const h = await harness();
    let rejectInterrupt!: (error: Error) => void;
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      const interruptBlocked = new Promise<void>((_resolve, reject) => {
        rejectInterrupt = reject;
      });
      vi.mocked(h.codex.interrupt).mockReturnValueOnce(interruptBlocked);
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Preserve this cancellation.',
      });
      const turn = h.router.getSnapshot().turns[0]!;
      await expect(h.executeWithoutSettling('agent.cancel', { sessionId: 'agent-1' }))
        .resolves.toMatchObject({ ok: true, status: 'applied' });
      await vi.waitFor(() => expect(h.codex.interrupt).toHaveBeenCalledOnce());
      const providerFailure: AgentProviderEvent = {
        kind: 'provider-error',
        sessionId: 'agent-1',
        code: 'turn-interrupt-failed',
        message: 'interrupt transport failed',
        recoverable: true,
      };

      if (order === 'provider-error-last') {
        rejectInterrupt(new Error('interrupt transport failed'));
        await h.runtime.whenIdle();
        h.codex.emit(providerFailure);
        await h.runtime.whenIdle();
      } else {
        h.codex.emit(providerFailure);
        await vi.waitFor(() => {
          expect(h.router.readTranscript('agent-1')).toContainEqual(expect.objectContaining({
            kind: 'error',
            text: 'interrupt transport failed',
          }));
        });
        expect(h.router.getSnapshot().turns[0]).toMatchObject({ errorCode: 'interrupt-requested' });
        rejectInterrupt(new Error('interrupt transport failed'));
        await h.runtime.whenIdle();
      }
      const errorCode = 'interrupt-failed';
      expect(h.router.getSnapshot().turns[0]).toMatchObject({
        state: 'delivery-uncertain',
        errorCode,
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
          errorCode,
          providerTurnId: 'provider-turn-late',
        })],
      });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('keeps a persisted Provider interrupt failure fenced after process-loss restart', async () => {
    const first = await harness();
    let restartedRuntime: DaemonAgentRuntime | undefined;
    let restartedStore: DaemonStore | undefined;
    let firstStoreClosed = false;
    try {
      await first.enable(first.codex, 'codex');
      await first.prepareWorkspace();
      vi.mocked(first.codex.interrupt).mockRejectedValueOnce(new Error('interrupt transport failed'));
      await first.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Persist this cancellation.',
      });
      const turn = first.router.getSnapshot().turns[0]!;
      await first.execute('agent.cancel', { sessionId: 'agent-1' });
      first.codex.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        code: 'turn-interrupt-failed',
        message: 'interrupt transport failed',
        recoverable: true,
      });
      await first.runtime.whenIdle();
      expect(first.router.getSnapshot().turns[0]).toMatchObject({
        state: 'delivery-uncertain',
        errorCode: 'interrupt-failed',
      });
      await first.runtime.dispose('process-loss');
      await first.store.close();
      firstStoreClosed = true;

      restartedStore = new DaemonStore(first.directory, {
        now: () => new Date('2026-09-04T10:00:00.000Z'),
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
        now: () => new Date('2026-09-04T10:00:00.000Z'),
      });
      const router = new DaemonCommandRouter(store, { handlers: restartedRuntime.handlers() });
      routerRef.current = router;
      await restartedRuntime.start();
      await restartedRuntime.whenIdle();

      codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'working' });
      codex.emit({
        kind: 'turn-started',
        sessionId: 'agent-1',
        turnId: turn.id,
        providerTurnId: 'provider-turn-after-restart',
        commandId: turn.commandId,
      });
      await restartedRuntime.whenIdle();

      expect(router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'delivery-uncertain' })],
        agents: [expect.objectContaining({ sessionId: 'agent-1', state: 'delivery-uncertain' })],
        turns: [expect.objectContaining({
          id: turn.id,
          state: 'delivery-uncertain',
          errorCode: 'interrupt-failed',
          providerTurnId: 'provider-turn-after-restart',
        })],
      });
    } finally {
      await restartedRuntime?.dispose();
      await restartedStore?.close();
      await first.runtime.dispose('process-loss');
      if (!firstStoreClosed) await first.store.close();
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

  it('scopes Provider errors to the exact durable turn and pumps only after the current turn fails', async () => {
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
      const first = h.router.getSnapshot().turns[0]!;
      h.codex.emit({
        kind: 'turn-started',
        sessionId: 'agent-1',
        turnId: first.id,
        providerTurnId: 'provider-first',
        commandId: first.commandId,
      });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Current turn.' });
      h.codex.emit({
        kind: 'turn-finished',
        sessionId: 'agent-1',
        turnId: first.id,
        outcome: 'completed',
      });
      await h.runtime.whenIdle();
      const current = h.router.getSnapshot().turns.find((turn) => turn.id !== first.id)!;
      h.codex.emit({
        kind: 'turn-started',
        sessionId: 'agent-1',
        turnId: current.id,
        providerTurnId: 'provider-current',
        commandId: current.commandId,
      });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Queued turn.' });
      const queued = h.router.getSnapshot().turns.find((turn) => (
        turn.id !== first.id && turn.id !== current.id
      ))!;

      h.codex.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        turnScope: { providerTurnId: 'provider-first' },
        code: 'late-predecessor-error',
        message: 'The predecessor reported late.',
        recoverable: false,
      });
      h.codex.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        turnScope: { providerTurnId: 'provider-unknown' },
        code: 'unmapped-error',
        message: 'This turn is not attached.',
        recoverable: false,
      });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot()).toMatchObject({
        agents: [expect.objectContaining({ currentTurnId: current.id, state: 'working', queuedTurnCount: 1 })],
        turns: expect.arrayContaining([
          expect.objectContaining({ id: first.id, state: 'completed' }),
          expect.objectContaining({ id: current.id, state: 'working' }),
          expect.objectContaining({ id: queued.id, state: 'queued' }),
        ]),
      });

      h.codex.emit({
        kind: 'approval-requested',
        sessionId: 'agent-1',
        turnId: current.id,
        providerRequestId: 'current-approval',
        risk: 'danger',
        title: 'Current approval',
      });
      await h.runtime.whenIdle();
      h.codex.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        turnScope: { turnId: current.id, providerTurnId: 'provider-current' },
        code: 'current-turn-error',
        message: 'Only the current turn failed.',
        recoverable: false,
      });
      await h.runtime.whenIdle();

      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'running' })],
        agents: [expect.objectContaining({
          sessionId: 'agent-1', currentTurnId: queued.id, state: 'working', queuedTurnCount: 0,
        })],
        turns: expect.arrayContaining([
          expect.objectContaining({ id: first.id, state: 'completed' }),
          expect.objectContaining({ id: current.id, state: 'failed', errorCode: 'current-turn-error' }),
          expect.objectContaining({ id: queued.id, state: 'working' }),
        ]),
        approvals: [expect.objectContaining({ providerRequestId: 'current-approval', state: 'expired' })],
      });
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('does not overwrite a durable interrupt fence with a scoped recoverable Provider error', async () => {
    const h = await harness();
    let resolveInterrupt!: () => void;
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      const interruptBlocked = new Promise<void>((resolve) => { resolveInterrupt = resolve; });
      vi.mocked(h.codex.interrupt).mockReturnValueOnce(interruptBlocked);
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Preserve the cancellation fence.',
      });
      const turn = h.router.getSnapshot().turns[0]!;
      await h.executeWithoutSettling('agent.cancel', { sessionId: 'agent-1' });
      await vi.waitFor(() => expect(h.codex.interrupt).toHaveBeenCalledOnce());
      expect(h.router.getSnapshot().turns[0]).toMatchObject({
        id: turn.id,
        state: 'delivery-uncertain',
        errorCode: 'interrupt-requested',
      });

      h.codex.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        turnScope: { turnId: turn.id },
        code: 'codex-turn-error',
        message: 'Retrying after cancellation.',
        recoverable: true,
      });
      await vi.waitFor(() => {
        expect(h.router.getSnapshot().turns[0]).toMatchObject({
          id: turn.id,
          state: 'delivery-uncertain',
          errorCode: 'interrupt-requested',
        });
      });
      resolveInterrupt();
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().turns[0]).toMatchObject({
        state: 'delivery-uncertain',
        errorCode: 'interrupt-requested',
      });
    } finally {
      resolveInterrupt?.();
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('retains session-wide recovery for an ordinary unscoped recoverable Provider error', async () => {
    const h = await harness();
    try {
      await h.enable(h.claude, 'claude');
      await h.prepareWorkspace();
      await h.execute('agent.create', {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Agent',
        providerId: 'claude',
        permissionPreset: 'standard',
        initialPrompt: 'Retry without a cancellation.',
      });
      const turn = h.router.getSnapshot().turns[0]!;

      h.claude.emit({
        kind: 'provider-error',
        sessionId: 'agent-1',
        code: 'CLAUDE_RATE_LIMITED',
        message: 'Claude will retry this ordinary turn.',
        recoverable: true,
      });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'delivery-uncertain' })],
        agents: [expect.objectContaining({ sessionId: 'agent-1', state: 'delivery-uncertain' })],
        turns: [expect.objectContaining({
          id: turn.id,
          state: 'delivery-uncertain',
          errorCode: 'CLAUDE_RATE_LIMITED',
        })],
      });

      h.claude.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'working' });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [expect.objectContaining({ id: 'agent-1', state: 'running' })],
        agents: [expect.objectContaining({ sessionId: 'agent-1', state: 'working' })],
        turns: [expect.objectContaining({ id: turn.id, state: 'working' })],
      });
      expect(h.router.getSnapshot().turns[0]).not.toHaveProperty('errorCode');
    } finally {
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('closes the turn, Agent, Session, and pending approvals on a session-wide terminal provider error', async () => {
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

  it('lets a long turn run with no elapsed-time limit', async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
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
        initialPrompt: 'Long task.',
      });
      await h.runtime.whenIdle();

      // The running turn gets no deadline; only the person or the AI ends it.
      expect(timeouts.mock.calls.some(([, delay]) => (delay ?? 0) >= 60 * 60_000)).toBe(false);
      expect(h.codex.interrupt).not.toHaveBeenCalled();
      expect(h.router.getSnapshot()).toMatchObject({
        sessions: [{ id: 'agent-1', state: 'running' }],
        agents: [{ sessionId: 'agent-1', state: 'working' }],
        turns: [{ sessionId: 'agent-1', state: 'working' }],
      });
    } finally {
      timeouts.mockRestore();
      await h.runtime.dispose();
      await h.store.close();
    }
  });
});


it('persists empty Agents across restart and dispatches only the first submitted message once', async () => {
  const h = await harness();
  let restoredStore: DaemonStore | undefined;
  let restoredRuntime: DaemonAgentRuntime | undefined;
  let closed = false;
  try {
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    for (const sessionId of ['empty-agent', 'archive-empty']) {
      expect((await h.execute('agent.create', {
        sessionId, workspaceId: 'workspace-1', title: 'Codex', providerId: 'codex', permissionPreset: 'standard',
      })).ok).toBe(true);
    }
    expect(h.codex.createSession).not.toHaveBeenCalled();
    expect(h.codex.submit).not.toHaveBeenCalled();
    expect(h.router.getSnapshot().turns).toEqual([]);
    expect(h.router.readTranscript('empty-agent', 0, 100)).toEqual([]);
    expect((await h.execute('agent.set-settings', { sessionId: 'empty-agent', model: 'chosen-model', permissionPreset: 'plan' })).ok).toBe(true);
    expect(h.codex.setSettings).not.toHaveBeenCalled();
    expect((await h.execute('agent.archive', { sessionId: 'archive-empty' })).ok).toBe(true);
    await h.runtime.dispose('process-loss');
    await h.store.close(); closed = true;
    const store = new DaemonStore(h.directory); restoredStore = store;
    await store.init();
    const codex = fakeAdapter('codex', 'codex-app-server');
    const registry = new AgentProviderRegistry([codex]);
    const runtime: DaemonAgentRuntime = new DaemonAgentRuntime({
      providers: registry,
      getSnapshot: () => router.getSnapshot(),
      applySystemCommit: (commit) => router.applySystemCommit(commit),
      applySystemTransition: (transition) => router.applySystemTransition(transition),
      readTranscript: (id, sequence, limit) => router.readTranscript(id, sequence, limit),
      findCommand: (id) => store.findCommand(id)?.command,
    });
    restoredRuntime = runtime;
    const router: DaemonCommandRouter = new DaemonCommandRouter(store, { handlers: runtime.handlers() });
    await runtime.start(); await runtime.whenIdle();
    expect(codex.createSession).not.toHaveBeenCalled();
    expect(codex.resumeSession).not.toHaveBeenCalled();
    expect(router.getSnapshot().agents.find((agent) => agent.sessionId === 'empty-agent'))
      .toMatchObject({ state: 'idle', queuedTurnCount: 0, model: 'chosen-model', permissionPreset: 'plan' });
    const command = createDaemonCommand({
      commandId: 'first-message', idempotencyKey: 'first-message', expectedRevision: store.getRevision(),
      issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'test' },
      type: 'agent.submit', payload: { sessionId: 'empty-agent', prompt: 'Start now.' },
    });
    expect((await router.execute(command)).ok).toBe(true);
    await runtime.whenIdle();
    expect((await router.execute(command)).ok).toBe(true);
    await runtime.whenIdle();
    expect(codex.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: 'chosen-model', permissionPreset: 'plan' }), expect.anything());
    expect(codex.submit).toHaveBeenCalledOnce();
    expect(codex.submit).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Start now.' }), expect.anything());
    expect(router.getSnapshot().turns).toHaveLength(1);
  } finally {
    await restoredRuntime?.dispose(); await restoredStore?.close();
    if (!closed) { await h.runtime.dispose(); await h.store.close(); }
  }
});


describe('conversation queue management', () => {
  it('takes a queued request without losing its transcript, rejects stale and cross-session edits, and replays once', async () => {
    const h = await harness();
    try {
      await h.prepareWorkspace(); await h.enable(h.codex, 'codex');
      await h.execute('agent.create', { sessionId: 'queue-chat', workspaceId: 'workspace-1', title: 'Queue', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Running' });
      await h.execute('agent.submit', { sessionId: 'queue-chat', prompt: 'Take me back' });
      const queued = h.router.getSnapshot().turns.find(turn => turn.state === 'queued')!;
      expect(await h.execute('agent.queue', { sessionId: 'other', turnId: queued.id, turnRevision: queued.revision, action: 'take' })).toMatchObject({ ok: false });
      expect(await h.execute('agent.queue', { sessionId: 'queue-chat', turnId: queued.id, turnRevision: queued.revision - 1, action: 'take' })).toMatchObject({ ok: false });
      const command = createDaemonCommand({ commandId: 'queue-take-once', idempotencyKey: 'queue-take-once', expectedRevision: h.store.getRevision(), issuedAt: '2026-09-04T10:00:00.000Z', principal: { kind: 'desktop', id: 'test' }, type: 'agent.queue', payload: { sessionId: 'queue-chat', turnId: queued.id, turnRevision: queued.revision, action: 'take' } });
      expect(await h.router.execute(command)).toMatchObject({ ok: true });
      expect(await h.router.execute(command)).toMatchObject({ ok: true });
      expect(h.router.getSnapshot().turns.find(turn => turn.id === queued.id)).toMatchObject({ state: 'interrupted', errorCode: 'queue-taken' });
      expect(h.router.getSnapshot().agents[0].queuedTurnCount).toBe(0);
      expect(h.store.getTranscript('queue-chat').some(item => item.turnId === queued.id && item.text === 'Take me back')).toBe(true);
      expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.prompt)).toEqual(['Running']);
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });
  it('runs the selected request next without duplicating it or reordering the rest', async () => {
    const h = await harness();
    try {
      await h.prepareWorkspace(); await h.enable(h.codex, 'codex');
      await h.execute('agent.create', { sessionId: 'queue-chat', workspaceId: 'workspace-1', title: 'Queue', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Running' });
      await h.execute('agent.submit', { sessionId: 'queue-chat', prompt: 'Second' });
      await h.execute('agent.submit', { sessionId: 'queue-chat', prompt: 'Chosen' });
      const before = h.router.getSnapshot();
      const current = before.turns.find(turn => turn.state === 'working')!;
      const chosen = before.turns.filter(turn => turn.state === 'queued').sort((a,b) => a.enqueueSequence! - b.enqueueSequence!).at(-1)!;
      expect(await h.execute('agent.queue', { sessionId: 'queue-chat', turnId: chosen.id, turnRevision: chosen.revision, action: 'run-next' })).toMatchObject({ ok: true });
      h.codex.emit({ kind: 'turn-finished', sessionId: 'queue-chat', turnId: current.id, outcome: 'interrupted' });
      await h.runtime.whenIdle();
      expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.prompt)).toEqual(['Running', 'Chosen']);
      expect(await h.execute('agent.queue', { sessionId: 'queue-chat', turnId: chosen.id, turnRevision: chosen.revision, action: 'remove' })).toMatchObject({ ok: false });
      h.codex.emit({ kind: 'turn-finished', sessionId: 'queue-chat', turnId: chosen.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.prompt)).toEqual(['Running', 'Chosen', 'Second']);
      expect(h.router.getSnapshot().turns).toHaveLength(3);
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });
});

// `/clear` replaces a conversation in its tab; its provider process should not live on until quit.
describe('releasing an idle conversation\'s provider', () => {
  async function idleAgent(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Hello' });
    const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
    h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
    await h.runtime.whenIdle();
    h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'idle' });
    await h.runtime.whenIdle();
    return h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-1')!.providerSessionId!;
  }

  it('stops the provider without changing what is stored, once, and reattaches on the next message', async () => {
    const h = await harness();
    try {
      const providerSessionId = await idleAgent(h);
      const before = h.router.getSnapshot();
      expect(await h.execute('agent.release', { sessionId: 'agent-1' })).toMatchObject({ ok: true });
      await h.runtime.whenIdle();
      expect(h.codex.disposeSession).toHaveBeenCalledWith('agent-1', providerSessionId);
      expect(h.codex.ownerOf(providerSessionId)).toBeUndefined();
      const after = h.router.getSnapshot();
      expect(after.sessions).toEqual(before.sessions);
      expect(after.agents).toEqual(before.agents);
      expect(after.turns).toEqual(before.turns);
      expect(await h.execute('agent.release', { sessionId: 'agent-1' })).toMatchObject({ ok: true });
      await h.runtime.whenIdle();
      expect(h.codex.disposeSession).toHaveBeenCalledTimes(1);
      vi.mocked(h.codex.resumeSession).mockClear();
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Again' });
      await h.runtime.whenIdle();
      expect(h.codex.resumeSession).toHaveBeenCalledTimes(1);
      expect(vi.mocked(h.codex.submit).mock.calls.map(([input]) => input.prompt)).toContain('Again');
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('refuses while a turn runs or an approval waits, leaving the provider attached', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Working' });
      expect(await h.execute('agent.release', { sessionId: 'agent-1' })).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      const turn = h.router.getSnapshot().turns[0]!;
      h.codex.emit({ kind: 'approval-requested', sessionId: 'agent-1', turnId: turn.id, providerRequestId: 'waiting', risk: 'write', title: 'Pending write' });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      if (h.router.getSnapshot().approvals.some((approval) => approval.state === 'pending')) {
        expect(await h.execute('agent.release', { sessionId: 'agent-1' })).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      }
      expect(h.codex.disposeSession).not.toHaveBeenCalled();
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });
});

// Switching to Full access may relaunch the provider; a message sent right after must wait for it.
describe('ordering a settings change before the next message', () => {
  it('sends the next message only after the provider applied the new settings', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Hello' });
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      h.codex.emit({ kind: 'session-state', sessionId: 'agent-1', state: 'idle' });
      await h.runtime.whenIdle();
      const order: string[] = [];
      let finishSettings!: () => void;
      const settingsHeld = new Promise<void>((resolve) => { finishSettings = resolve; });
      const originalSetSettings = vi.mocked(h.codex.setSettings).getMockImplementation()!;
      vi.mocked(h.codex.setSettings).mockImplementationOnce(async (input) => { order.push('settings:start'); await settingsHeld; order.push('settings:done'); return originalSetSettings(input); });
      vi.mocked(h.codex.submit).mockImplementation(async (input) => { order.push(`submit:${input.prompt}`); });
      await h.executeWithoutSettling('agent.set-settings', { sessionId: 'agent-1', permissionPreset: 'full-access' });
      await h.executeWithoutSettling('agent.submit', { sessionId: 'agent-1', prompt: 'Right after' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(['settings:start']);
      finishSettings();
      await h.runtime.whenIdle();
      expect(order).toEqual(['settings:start', 'settings:done', 'submit:Right after']);
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-1')?.state).not.toBe('delivery-uncertain');
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });
});

describe('side questions (/btw) on a live conversation', () => {
  async function claudeAgent(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
    h.claude.askSideQuestion = vi.fn(async () => ({ text: 'It was src/config.ts.', synthetic: false }));
    await h.enable(h.claude, 'claude');
    await h.prepareWorkspace();
    await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Hello' });
    const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
    h.claude.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
    await h.runtime.whenIdle();
    return h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-1')!.providerSessionId!;
  }
  const question = { sessionId: 'agent-1', question: 'Which file?', history: [{ question: 'q1', answer: 'a1' }] };

  it('lists a conversation only while its provider is attached, with one event per change', async () => {
    const h = await harness();
    try {
      h.claude.askSideQuestion = vi.fn();
      await h.enable(h.claude, 'claude');
      await h.prepareWorkspace();
      expect(h.router.getSnapshot().sideQuestionSessionIds).toBeUndefined();
      const listener = vi.fn();
      h.router.onEvent(listener);
      await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Hello' });
      expect(h.router.getSnapshot().sideQuestionSessionIds).toEqual(['agent-1']);
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      h.claude.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      listener.mockClear();
      expect(await h.execute('agent.release', { sessionId: 'agent-1' })).toMatchObject({ ok: true });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().sideQuestionSessionIds).toBeUndefined();
      expect(listener.mock.calls.filter(([event]) => event.kind === 'entity.upserted' && event.payload?.entityType === 'agent' && event.payload.entityId === 'agent-1')).toHaveLength(1);
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('never lists a provider whose adapter has no side questions', async () => {
    const h = await harness();
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Hello' });
      expect(h.router.getSnapshot().agents[0]?.providerSessionId).toBeTruthy();
      expect(h.router.getSnapshot().sideQuestionSessionIds).toBeUndefined();
      await expect(h.runtime.askSideQuestion(question, new AbortController().signal)).rejects.toMatchObject({ code: 'not-live' });
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('asks the attached provider session and changes nothing stored', async () => {
    const h = await harness();
    try {
      const providerSessionId = await claudeAgent(h);
      const before = h.router.getSnapshot();
      const transcript = h.router.readTranscript('agent-1').length;
      const signal = new AbortController().signal;
      await expect(h.runtime.askSideQuestion(question, signal)).resolves.toEqual({ text: 'It was src/config.ts.', synthetic: false });
      expect(h.claude.askSideQuestion).toHaveBeenCalledWith({ sessionId: 'agent-1', providerSessionId, question: 'Which file?', history: [{ question: 'q1', answer: 'a1' }] }, signal);
      await h.runtime.whenIdle();
      const after = h.router.getSnapshot();
      expect([after.revision, after.eventSequence, after.turns]).toEqual([before.revision, before.eventSequence, before.turns]);
      expect(h.router.readTranscript('agent-1')).toHaveLength(transcript);
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('refuses a released or archived conversation without attaching it again', async () => {
    const h = await harness();
    try {
      await claudeAgent(h);
      await h.execute('agent.release', { sessionId: 'agent-1' });
      await h.runtime.whenIdle();
      vi.mocked(h.claude.resumeSession).mockClear();
      vi.mocked(h.claude.createSession).mockClear();
      const revision = h.router.getSnapshot().revision;
      await expect(h.runtime.askSideQuestion(question, new AbortController().signal)).rejects.toMatchObject({ code: 'not-live' });
      await h.runtime.whenIdle();
      expect(h.claude.resumeSession).not.toHaveBeenCalled();
      expect(h.claude.createSession).not.toHaveBeenCalled();
      expect(h.claude.askSideQuestion).not.toHaveBeenCalled();
      expect(h.router.getSnapshot().revision).toBe(revision);
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Again' });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().sideQuestionSessionIds).toEqual(['agent-1']);
      const again = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1' && entry.state !== 'completed')!;
      h.claude.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: again.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      expect(await h.execute('agent.archive', { sessionId: 'agent-1' })).toMatchObject({ ok: true });
      await h.runtime.whenIdle();
      expect(h.router.getSnapshot().sideQuestionSessionIds).toBeUndefined();
      await expect(h.runtime.askSideQuestion(question, new AbortController().signal)).rejects.toMatchObject({ code: 'not-live' });
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });
});

// agent-settings-v2: a person changes settings while a turn runs; they wait for the next request.
describe('settings queued for the next request', () => {
  async function workingAgent(h: Awaited<ReturnType<typeof harness>>) {
    await h.enable(h.codex, 'codex');
    await h.prepareWorkspace();
    await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', model: 'model-a', permissionPreset: 'standard', reasoningEffort: 'high', initialPrompt: 'Hello' });
    return h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
  }
  async function finish(h: Awaited<ReturnType<typeof harness>>, turnId: string) {
    h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId, outcome: 'completed' });
    await h.runtime.whenIdle();
  }
  const agentOf = (h: Awaited<ReturnType<typeof harness>>) => h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-1')!;

  it('keeps the record for the running turn and applies model and permission before the next request', async () => {
    const h = await harness();
    try {
      const turn = await workingAgent(h);
      expect((await h.execute('agent.set-settings', { sessionId: 'agent-1', model: 'model-b', permissionPreset: 'full-access' })).ok).toBe(true);
      // The running turn (and any child it starts) still uses the record.
      expect(agentOf(h)).toMatchObject({ model: 'model-a', permissionPreset: 'standard' });
      expect(h.router.getSnapshot().pendingAgentSettings).toEqual({ 'agent-1': { model: 'model-b', permissionPreset: 'full-access' } });
      expect(h.codex.setSettings).not.toHaveBeenCalled();
      await finish(h, turn.id);
      const order: string[] = [];
      const originalSetSettings = vi.mocked(h.codex.setSettings).getMockImplementation()!;
      vi.mocked(h.codex.setSettings).mockImplementationOnce(async (input) => { order.push('settings'); return originalSetSettings(input); });
      vi.mocked(h.codex.submit).mockImplementationOnce(async () => { order.push('submit'); });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Next' });
      expect(order).toEqual(['settings', 'submit']);
      expect(h.codex.setSettings).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'agent-1', model: 'model-b', permissionPreset: 'full-access' }));
      expect(agentOf(h)).toMatchObject({ model: 'model-b', permissionPreset: 'full-access' });
      expect(h.router.getSnapshot().pendingAgentSettings).toBeUndefined();
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('still refuses an agent changing model or permission during a turn', async () => {
    const h = await harness();
    try {
      await workingAgent(h);
      expect(await h.execute('agent.set-settings', { sessionId: 'agent-1', permissionPreset: 'full-access' }, { kind: 'cli', id: 'agent-shell' }))
        .toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      expect(h.router.getSnapshot().pendingAgentSettings).toBeUndefined();
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('drops what waits when the person cancels it', async () => {
    const h = await harness();
    try {
      await workingAgent(h);
      await h.execute('agent.set-settings', { sessionId: 'agent-1', reasoningEffort: 'low', scope: 'keep' });
      expect(h.router.getSnapshot().pendingAgentSettings).toEqual({ 'agent-1': { reasoningEffort: 'low', effortScope: 'keep' } });
      expect((await h.execute('agent.set-settings', { sessionId: 'agent-1', clearPending: true })).ok).toBe(true);
      expect(h.router.getSnapshot().pendingAgentSettings).toBeUndefined();
      expect(agentOf(h).reasoningEffort).toBe('high');
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('sends a one-request effort once, then the record effort again explicitly', async () => {
    const h = await harness();
    try {
      const turn = await workingAgent(h);
      await finish(h, turn.id);
      await h.execute('agent.set-settings', { sessionId: 'agent-1', reasoningEffort: 'low', scope: 'once' });
      expect(h.router.getSnapshot().pendingAgentSettings).toEqual({ 'agent-1': { reasoningEffort: 'low', effortScope: 'once' } });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Quick question' });
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Quick question', reasoningEffort: 'low' }), expect.anything());
      const quick = agentOf(h).currentTurnId!;
      expect(agentOf(h).reasoningEffort).toBe('high');
      expect(h.router.getSnapshot().pendingAgentSettings).toEqual({ 'agent-1': { runningEffort: 'low', runningTurnId: quick } });
      await finish(h, quick);
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Back to work' });
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Back to work', reasoningEffort: 'high' }), expect.anything());
      expect(h.router.getSnapshot().pendingAgentSettings).toBeUndefined();
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('applies a kept effort to the record when the next request starts', async () => {
    const h = await harness();
    try {
      const turn = await workingAgent(h);
      await h.execute('agent.set-settings', { sessionId: 'agent-1', reasoningEffort: 'medium' });
      expect(agentOf(h).reasoningEffort).toBe('high');
      await finish(h, turn.id);
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Next' });
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Next', reasoningEffort: 'medium' }), expect.anything());
      expect(agentOf(h).reasoningEffort).toBe('medium');
      expect(h.codex.setSettings).not.toHaveBeenCalled();
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('starts an approved Codex plan with the linked implement agent, unless the person queued an effort', async () => {
    const phaseSettings = vi.fn((_providerId: string, phase: 'plan' | 'implement') => (phase === 'implement' ? { reasoningEffort: 'medium' } : { reasoningEffort: 'xhigh' }));
    const h = await harness({ phaseSettings });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'codex', permissionPreset: 'plan', reasoningEffort: 'xhigh', initialPrompt: 'Plan a change.' });
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      h.codex.emit({ kind: 'approval-requested', sessionId: 'agent-1', providerRequestId: 'proposed-plan:t1', risk: 'write', title: 'Approve plan', request: { v: 1, kind: 'plan', markdown: '- step' } });
      await h.runtime.whenIdle();
      const approvalId = h.router.getSnapshot().approvals.find((approval) => approval.providerRequestId === 'proposed-plan:t1')!.id;
      await h.execute('permission.resolve', { approvalId, decision: 'allow', response: { kind: 'plan', mode: 'standard' } });
      await vi.waitFor(() => expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Implement the plan above.', reasoningEffort: 'medium' }), expect.anything()));
      expect(phaseSettings).toHaveBeenCalledWith('codex', 'implement');
      expect(agentOf(h)).toMatchObject({ permissionPreset: 'standard', reasoningEffort: 'medium' });
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  describe('an approved Claude plan', () => {
    async function claudePlan(implementEffort: string) {
      const h = await harness({ phaseSettings: (_providerId, phase) => (phase === 'implement' ? { reasoningEffort: implementEffort } : undefined) });
      const approvePlanEndingTurn = vi.fn(async () => undefined);
      h.claude.approvePlanEndingTurn = approvePlanEndingTurn;
      await h.enable(h.claude, 'claude');
      await h.prepareWorkspace();
      await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', providerId: 'claude', permissionPreset: 'plan', reasoningEffort: 'high', initialPrompt: 'Plan a change.' });
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      h.claude.emit({ kind: 'approval-requested', sessionId: 'agent-1', turnId: turn.id, providerRequestId: 'plan-1', risk: 'write', title: 'Approve plan', request: { v: 1, kind: 'plan', callId: 'call', markdown: '- step' } });
      await h.runtime.whenIdle();
      const approvalId = h.router.getSnapshot().approvals.find((approval) => approval.providerRequestId === 'plan-1')!.id;
      expect((await h.execute('permission.resolve', { approvalId, decision: 'allow', response: { kind: 'plan', mode: 'standard' } })).ok).toBe(true);
      return { h, turn, approvePlanEndingTurn };
    }

    it('ends the plan turn when the implement agent changes the effort, then sends the implementation with it', async () => {
      const { h, turn, approvePlanEndingTurn } = await claudePlan('medium');
      try {
        expect(approvePlanEndingTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'agent-1', providerRequestId: 'plan-1', response: { kind: 'plan', mode: 'standard' } }));
        expect(h.claude.resolveApproval).not.toHaveBeenCalled();
        expect(agentOf(h).permissionPreset).toBe('standard');
        expect(h.router.getSnapshot().pendingAgentSettings).toEqual({ 'agent-1': { reasoningEffort: 'medium', effortScope: 'keep' } });
        // Nothing more is sent while the plan turn is still ending.
        expect(h.claude.submit).toHaveBeenCalledTimes(1);

        h.claude.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
        await h.runtime.whenIdle();
        await vi.waitFor(() => expect(h.claude.submit).toHaveBeenCalledTimes(2));
        expect(h.claude.submit).toHaveBeenLastCalledWith(expect.objectContaining({
          prompt: 'Your plan was approved. Implement it now.', reasoningEffort: 'medium', attended: true,
        }), expect.anything());
        expect(agentOf(h)).toMatchObject({ permissionPreset: 'standard', reasoningEffort: 'medium' });
        expect(h.router.getSnapshot().pendingAgentSettings).toBeUndefined();
        const transcript = h.router.readTranscript('agent-1', 0, 500);
        expect(transcript.filter((item) => item.kind === 'user-message').at(-1)?.text).toBe('Your plan was approved. Implement it now.');
      } finally { await h.runtime.dispose(); await h.store.close(); }
    });

    it('continues the same turn as before when the implement agent changes nothing', async () => {
      const { h, turn, approvePlanEndingTurn } = await claudePlan('high');
      try {
        expect(approvePlanEndingTurn).not.toHaveBeenCalled();
        expect(h.claude.resolveApproval).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: 'plan-1', decision: 'allow', response: { kind: 'plan', mode: 'standard' } }));
        h.claude.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
        await h.runtime.whenIdle();
        expect(h.claude.submit).toHaveBeenCalledTimes(1);
        expect(h.router.getSnapshot().pendingAgentSettings).toBeUndefined();
      } finally { await h.runtime.dispose(); await h.store.close(); }
    });

    it('sends no implementation when the person stopped the plan turn', async () => {
      const { h, turn, approvePlanEndingTurn } = await claudePlan('medium');
      try {
        expect(approvePlanEndingTurn).toHaveBeenCalled();
        h.claude.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'interrupted' });
        await h.runtime.whenIdle();
        expect(h.claude.submit).toHaveBeenCalledTimes(1);
      } finally { await h.runtime.dispose(); await h.store.close(); }
    });
  });

  it('takes the plan agent effort when plan mode turns on between turns', async () => {
    const h = await harness({ phaseSettings: (_providerId, phase) => (phase === 'plan' ? { reasoningEffort: 'xhigh' } : { reasoningEffort: 'medium' }) });
    try {
      const turn = await workingAgent(h);
      await finish(h, turn.id);
      await h.execute('agent.set-settings', { sessionId: 'agent-1', permissionPreset: 'plan' });
      expect(agentOf(h)).toMatchObject({ permissionPreset: 'plan', reasoningEffort: 'xhigh' });
      await h.execute('agent.set-settings', { sessionId: 'agent-1', permissionPreset: 'standard' });
      expect(agentOf(h)).toMatchObject({ permissionPreset: 'standard', reasoningEffort: 'medium' });
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('lets an effort picked while idle wait, so its scope can still change, and applies it at the next request', async () => {
    const h = await harness();
    try {
      const turn = await workingAgent(h);
      await finish(h, turn.id);
      await h.execute('agent.set-settings', { sessionId: 'agent-1', reasoningEffort: 'low', scope: 'keep' });
      expect(agentOf(h).reasoningEffort).toBe('high');
      expect(h.router.getSnapshot().pendingAgentSettings).toEqual({ 'agent-1': { reasoningEffort: 'low', effortScope: 'keep' } });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Next' });
      expect(h.codex.submit).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Next', reasoningEffort: 'low' }), expect.anything());
      expect(agentOf(h).reasoningEffort).toBe('low');
      // Without a scope (an older client or an agent), an idle effort change applies at once.
      await finish(h, agentOf(h).currentTurnId!);
      await h.execute('agent.set-settings', { sessionId: 'agent-1', reasoningEffort: 'medium' });
      expect(agentOf(h).reasoningEffort).toBe('medium');
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('never links a phase agent into a prepared workflow session', async () => {
    const phaseSettings = vi.fn(() => ({ reasoningEffort: 'low' }));
    const h = await harness({ phaseSettings, preparedSessionSettings: (sessionId) => (sessionId === 'agent-1' ? { managedExecution: true } : undefined) });
    try {
      await h.enable(h.claude, 'claude');
      await h.prepareWorkspace();
      await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Stage', providerId: 'claude', permissionPreset: 'plan', initialPrompt: 'Plan.' });
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      h.claude.emit({ kind: 'approval-requested', sessionId: 'agent-1', turnId: turn.id, providerRequestId: 'plan-1', risk: 'write', title: 'Approve plan', request: { v: 1, kind: 'plan', callId: 'call', markdown: '- step' } });
      await h.runtime.whenIdle();
      await h.execute('permission.resolve', { approvalId: h.router.getSnapshot().approvals[0]!.id, decision: 'allow' });
      expect(phaseSettings).not.toHaveBeenCalled();
      expect(h.router.getSnapshot().pendingAgentSettings).toBeUndefined();
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('gives no restart notice for a one-request effort that was only running', async () => {
    const saved: unknown[] = [];
    const h = await harness({ pendingSettingsStore: { load: async () => ({ 'agent-1': { runningEffort: 'low', runningTurnId: 'turn-x' } }), save: async (value) => { saved.push(value); } } });
    try {
      await workingAgent(h);
      expect(h.router.readTranscript('agent-1', 0, 500).some((item) => item.text.includes('restarted'))).toBe(false);
      await vi.waitFor(() => expect(saved).toContainEqual({}));
      await h.execute('agent.set-settings', { sessionId: 'agent-1', reasoningEffort: 'low', scope: 'once' });
      await h.execute('agent.set-settings', { sessionId: 'agent-1', clearPending: true });
      // Nothing waits any more: the marker holds no session.
      await vi.waitFor(() => expect(saved.at(-1)).toEqual({}));
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('gives a chain conversation the permission of the workflow stage about to run', async () => {
    let stageAccess: 'plan' | 'standard' = 'plan';
    const h = await harness({ preparedSessionSettings: (sessionId) => (sessionId === 'agent-1' ? { managedExecution: true, permissionPreset: stageAccess } : undefined) });
    try {
      await h.enable(h.codex, 'codex');
      await h.prepareWorkspace();
      await h.execute('agent.create', { sessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Stage', providerId: 'codex', permissionPreset: 'plan', initialPrompt: 'Plan.' });
      expect(h.codex.setSettings).not.toHaveBeenCalled();
      const turn = h.router.getSnapshot().turns.find((entry) => entry.sessionId === 'agent-1')!;
      h.codex.emit({ kind: 'turn-finished', sessionId: 'agent-1', turnId: turn.id, outcome: 'completed' });
      await h.runtime.whenIdle();
      // The next stage of the chain writes: the host switches the conversation before sending its turn.
      stageAccess = 'standard';
      const order: string[] = [];
      const originalSetSettings = vi.mocked(h.codex.setSettings).getMockImplementation()!;
      vi.mocked(h.codex.setSettings).mockImplementationOnce(async (input) => { order.push(`settings:${input.permissionPreset}`); return originalSetSettings(input); });
      vi.mocked(h.codex.submit).mockImplementationOnce(async () => { order.push('submit'); });
      await h.execute('agent.submit', { sessionId: 'agent-1', prompt: 'Build it.' }, { kind: 'desktop', id: 'planning-runtime' });
      expect(order).toEqual(['settings:standard', 'submit']);
      expect(h.router.getSnapshot().agents.find((agent) => agent.sessionId === 'agent-1')?.permissionPreset).toBe('standard');
    } finally { await h.runtime.dispose(); await h.store.close(); }
  });

  it('says in the conversation that queued settings were dropped by a restart', async () => {
    const saved: unknown[] = [];
    const h = await harness({ pendingSettingsStore: { load: async () => undefined, save: async (value) => { saved.push(value); } } });
    let closed = false;
    let restored: { runtime: DaemonAgentRuntime; store: DaemonStore } | undefined;
    try {
      await workingAgent(h);
      await h.execute('agent.set-settings', { sessionId: 'agent-1', reasoningEffort: 'low', scope: 'keep' });
      await vi.waitFor(() => expect(saved.at(-1)).toEqual({ 'agent-1': { reasoningEffort: 'low', effortScope: 'keep' } }));
      await h.runtime.dispose('process-loss');
      await h.store.close(); closed = true;
      const store = new DaemonStore(h.directory);
      await store.init();
      const routerRef: { current?: DaemonCommandRouter } = {};
      const runtime = new DaemonAgentRuntime({
        providers: new AgentProviderRegistry([fakeAdapter('codex', 'codex-app-server')]),
        getSnapshot: () => routerRef.current!.getSnapshot(),
        applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
        applySystemTransition: (transition) => routerRef.current!.applySystemTransition(transition),
        readTranscript: (id, sequence, limit) => routerRef.current!.readTranscript(id, sequence, limit),
        findCommand: (id) => store.findCommand(id)?.command,
        pendingSettingsStore: { load: async () => saved.at(-1), save: async (value) => { saved.push(value); } },
      });
      restored = { runtime, store };
      routerRef.current = new DaemonCommandRouter(store, { handlers: runtime.handlers(), pendingAgentSettings: (snapshot) => runtime.pendingAgentSettings(snapshot) });
      await runtime.start(); await runtime.whenIdle();
      expect(routerRef.current.readTranscript('agent-1', 0, 500).some((item) => item.kind === 'notice' && item.text.includes('cleared when EZTerminal restarted'))).toBe(true);
      expect(routerRef.current.getSnapshot().pendingAgentSettings).toBeUndefined();
      await vi.waitFor(() => expect(saved.at(-1)).toEqual({}));
    } finally {
      if (restored) { await restored.runtime.dispose(); await restored.store.close(); }
      if (!closed) { await h.runtime.dispose(); await h.store.close(); }
    }
  });
});
