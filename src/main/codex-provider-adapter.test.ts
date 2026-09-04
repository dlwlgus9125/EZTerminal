import { describe, expect, it, vi } from 'vitest';

import type {
  AgentProviderEvent,
  ProviderSessionContext,
} from './agent-provider-adapter';
import type {
  CodexAppServerConnection,
  CodexConnectionClose,
  CodexNotificationHandler,
  CodexRpcRequestOptions,
  CodexServerRequestContext,
  CodexServerRequestHandler,
} from './codex-app-server-client';
import {
  CODEX_APP_SERVER_BASELINE_VERSION,
  CodexProviderAdapter,
} from './codex-provider-adapter';

interface RequestRecord {
  readonly method: string;
  readonly params: unknown;
  readonly options?: CodexRpcRequestOptions;
}

class FakeCodexConnection implements CodexAppServerConnection {
  readonly requests: RequestRecord[] = [];
  readonly notifications: Array<{ readonly method: string; readonly params?: unknown }> = [];
  readonly notificationHandlers = new Map<string, Set<CodexNotificationHandler>>();
  readonly serverHandlers = new Map<string, CodexServerRequestHandler>();
  readonly closeListeners = new Set<(event: CodexConnectionClose) => void>();
  requestImpl: (method: string, params: unknown, options?: CodexRpcRequestOptions) => Promise<unknown>
    = async (method) => { throw new Error(`Unexpected request: ${method}`); };
  disposeImpl: () => Promise<void> = async () => undefined;
  disposed = false;

  request(method: string, params: unknown = {}, options?: CodexRpcRequestOptions): Promise<unknown> {
    this.requests.push({ method, params, ...(options ? { options } : {}) });
    return this.requestImpl(method, params, options);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(method: string, handler: CodexNotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  onServerRequest(method: string, handler: CodexServerRequestHandler): () => void {
    this.serverHandlers.set(method, handler);
    return () => {
      if (this.serverHandlers.get(method) === handler) this.serverHandlers.delete(method);
    };
  }

  onClose(listener: (event: CodexConnectionClose) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async emitNotification(method: string, params: unknown): Promise<void> {
    const handlers = [
      ...(this.notificationHandlers.get(method) ?? []),
      ...(this.notificationHandlers.get('*') ?? []),
    ];
    await Promise.all(handlers.map(async (handler) => handler(params, method)));
  }

  serverRequest(method: string, id: string | number, params: unknown): Promise<unknown> {
    const handler = this.serverHandlers.get(method);
    if (!handler) return Promise.reject(new Error(`No handler for ${method}`));
    const context: CodexServerRequestContext = { id, method };
    return Promise.resolve(handler(params, context));
  }

  crash(message = 'app server crashed'): void {
    for (const listener of [...this.closeListeners]) listener({ expected: false, message });
  }

  async dispose(): Promise<void> {
    await this.disposeImpl();
    this.disposed = true;
  }
}

const context = (overrides: Partial<ProviderSessionContext> = {}): ProviderSessionContext => ({
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  workspaceRoot: 'C:\\Working\\EZTerminal',
  model: 'gpt-5.6-sol',
  permissionPreset: 'standard',
  ...overrides,
});

async function attachedAdapter(connection: FakeCodexConnection): Promise<CodexProviderAdapter> {
  connection.requestImpl = async (method) => {
    if (method === 'thread/start') return {
      thread: { id: 'thread-1' },
      model: 'gpt-5.6-sol',
    };
    throw new Error(`Unexpected request: ${method}`);
  };
  const adapter = new CodexProviderAdapter({
    connection,
    now: () => new Date('2026-09-04T03:00:00.000Z'),
  });
  await adapter.createSession(context());
  return adapter;
}

function reviewedAdapter(connectionFactory: () => CodexAppServerConnection): CodexProviderAdapter {
  const adapter = new CodexProviderAdapter({ connectionFactory });
  adapter.setLaunchDescriptor({
    providerId: 'codex',
    protocol: 'codex-app-server',
    executablePath: 'C:\\Tools\\codex.exe',
    executableVersion: CODEX_APP_SERVER_BASELINE_VERSION,
    argv: ['app-server'],
    environmentVariableNames: [
      'PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    ],
    reviewDigest: 'a'.repeat(64),
  });
  return adapter;
}

async function pendingTurnFixture(
  interruptImpl: () => Promise<unknown> = async () => ({}),
): Promise<{
  readonly adapter: CodexProviderAdapter;
  readonly connection: FakeCodexConnection;
  readonly submitting: Promise<void>;
  readonly interrupting: Promise<void>;
  readonly resolveTurnStart: (value: unknown) => void;
  readonly rejectTurnStart: (reason: unknown) => void;
}> {
  const connection = new FakeCodexConnection();
  const adapter = await attachedAdapter(connection);
  let resolveTurnStart!: (value: unknown) => void;
  let rejectTurnStart!: (reason: unknown) => void;
  const turnStart = new Promise<unknown>((resolve, reject) => {
    resolveTurnStart = resolve;
    rejectTurnStart = reject;
  });
  connection.requestImpl = async (method) => {
    if (method === 'turn/start') return turnStart;
    if (method === 'turn/interrupt') return interruptImpl();
    throw new Error(`Unexpected request: ${method}`);
  };
  const submitting = adapter.submit({
    sessionId: 'session-1', providerSessionId: 'thread-1', turnId: 'turn-1', commandId: 'command-1', prompt: 'Work',
  });
  await vi.waitFor(() => expect(connection.requests.some((request) => request.method === 'turn/start')).toBe(true));
  return {
    adapter,
    connection,
    submitting,
    interrupting: adapter.interrupt('session-1', 'thread-1'),
    resolveTurnStart,
    rejectTurnStart,
  };
}

describe('CodexProviderAdapter', () => {
  it('probes a canonical reviewed 0.152.x executable without starting app-server', async () => {
    const connection = new FakeCodexConnection();
    const resolveExecutable = vi.fn(async () => 'C:\\Tools\\codex.exe');
    const runCommand = vi.fn(async () => ({ stdout: 'codex-cli 0.152.1\n', stderr: '', exitCode: 0 }));
    const adapter = new CodexProviderAdapter({ connection, resolveExecutable, runCommand });

    await expect(adapter.probe()).resolves.toEqual({
      providerId: 'codex',
      displayName: 'Codex',
      protocol: 'codex-app-server',
      available: true,
      executablePath: 'C:\\Tools\\codex.exe',
      executableVersion: CODEX_APP_SERVER_BASELINE_VERSION,
      argv: ['app-server'],
      environmentVariableNames: ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'],
      capabilities: [
        'create', 'resume', 'interrupt', 'model-change', 'permission-change',
        'approvals', 'native-subagents', 'history-reconciliation',
      ],
      authenticationState: 'first-launch',
      authenticationDetail: 'Codex authentication is verified by app-server when the first Agent session starts.',
    });
    expect(resolveExecutable).toHaveBeenCalledWith('codex', expect.any(AbortSignal));
    expect(runCommand).toHaveBeenCalledWith(
      'C:\\Tools\\codex.exe',
      ['--version'],
      expect.any(AbortSignal),
    );
    expect(connection.requests).toEqual([]);
    await adapter.dispose();
  });

  it('forwards cancellation to an in-flight executable probe', async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const adapter = new CodexProviderAdapter({
      connection: new FakeCodexConnection(),
      resolveExecutable: async () => 'C:\\Tools\\codex.exe',
      runCommand: async (_command, _argv, signal) => {
        observedSignal = signal;
        markStarted?.();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    });
    const controller = new AbortController();

    const pending = adapter.probe(controller.signal);
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
    await adapter.dispose();
  });

  it('bounds executable verification even when an injected command ignores abort', async () => {
    let observedSignal: AbortSignal | undefined;
    const adapter = new CodexProviderAdapter({
      connection: new FakeCodexConnection(),
      probeTimeoutMs: 20,
      resolveExecutable: async () => 'C:\\Tools\\codex.exe',
      runCommand: async (_command, _argv, signal) => {
        observedSignal = signal;
        return new Promise<never>(() => undefined);
      },
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      available: false,
      unavailableReason: 'Codex executable verification exceeded 20ms.',
    });
    expect(observedSignal?.aborted).toBe(true);
    await adapter.dispose();
  });

  it('fails closed for an unreviewed protocol version and reports a missing binary', async () => {
    const connection = new FakeCodexConnection();
    const newer = new CodexProviderAdapter({
      connection,
      resolveExecutable: async () => 'C:\\Tools\\codex.exe',
      runCommand: async () => ({ stdout: 'codex-cli 0.153.0', stderr: '', exitCode: 0 }),
    });
    await expect(newer.probe()).resolves.toMatchObject({
      available: false,
      executableVersion: '0.153.0',
      unavailableReason: expect.stringContaining('has not been reviewed'),
    });
    await newer.dispose();

    const missingConnection = new FakeCodexConnection();
    const missing = new CodexProviderAdapter({
      connection: missingConnection,
      resolveExecutable: async () => { throw new Error('codex was not found on PATH'); },
    });
    await expect(missing.probe()).resolves.toMatchObject({
      available: false,
      executablePath: 'codex',
      executableVersion: 'unknown',
      unavailableReason: 'codex was not found on PATH',
    });
    await missing.dispose();
  });

  it('lists and normalizes every visible model page with cursor-loop protection', async () => {
    const connection = new FakeCodexConnection();
    connection.requestImpl = async (method, params) => {
      if (method !== 'model/list') throw new Error(`Unexpected request: ${method}`);
      return (params as { cursor?: string }).cursor
        ? {
            data: [{ id: 'id-b', model: 'gpt-b', displayName: 'GPT B', description: '', hidden: false, supportedReasoningEfforts: [], isDefault: false }],
            nextCursor: null,
          }
        : {
            data: [
              { id: 'id-a', model: 'gpt-a', displayName: 'GPT A', description: 'Reasoning', hidden: false, supportedReasoningEfforts: [{}], isDefault: true },
              { id: 'hidden', model: 'hidden', hidden: true },
            ],
            nextCursor: 'page-2',
          };
    };
    const adapter = new CodexProviderAdapter({ connection });
    await expect(adapter.listModels()).resolves.toEqual([
      { id: 'gpt-a', displayName: 'GPT A', description: 'Reasoning', supportsReasoning: true, isDefault: true },
      { id: 'gpt-b', displayName: 'GPT B', supportsReasoning: false, isDefault: false },
    ]);
    expect(connection.requests).toHaveLength(2);
    await adapter.dispose();
  });

  it('creates a durable thread with reviewed permissions and ephemeral session MCP credentials', async () => {
    const connection = new FakeCodexConnection();
    connection.requestImpl = async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
      throw new Error(`Unexpected request: ${method}`);
    };
    const adapter = new CodexProviderAdapter({ connection });
    const events: unknown[] = [];
    adapter.subscribe((event) => events.push(event));

    await expect(adapter.createSession(context({
      orchestration: { endpoint: 'http://127.0.0.1:43111/mcp', bearerToken: 'session-secret' },
    }))).resolves.toEqual({
      sessionId: 'session-1',
      providerSessionId: 'thread-1',
      model: 'gpt-5.6-sol',
      permissionPreset: 'standard',
    });
    expect(connection.requests[0]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: 'C:\\Working\\EZTerminal',
        runtimeWorkspaceRoots: ['C:\\Working\\EZTerminal'],
        model: 'gpt-5.6-sol',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ephemeral: false,
        historyMode: 'paginated',
        threadSource: 'ezterminal',
        config: {
          mcp_servers: {
            ezterminal_orchestration: {
              url: 'http://127.0.0.1:43111/mcp',
              http_headers: { Authorization: 'Bearer session-secret' },
            },
          },
        },
      },
    });
    expect(events).toEqual([
      { kind: 'session-state', sessionId: 'session-1', state: 'starting' },
      { kind: 'session-state', sessionId: 'session-1', state: 'idle' },
    ]);
    await adapter.dispose();
  });

  it('resumes the exact provider thread and does not hydrate legacy full history', async () => {
    const connection = new FakeCodexConnection();
    connection.requestImpl = async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-existing' }, model: 'gpt-5.6-sol' };
      throw new Error(`Unexpected request: ${method}`);
    };
    const adapter = new CodexProviderAdapter({ connection });
    await adapter.resumeSession({
      ...context({ permissionPreset: 'plan' }),
      providerSessionId: 'thread-existing',
    });
    expect(connection.requests[0]).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'thread-existing',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        excludeTurns: true,
      },
    });
    await adapter.dispose();
  });

  it('submits clientUserMessageId, maps streaming semantics, and emits one turn lifecycle', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    connection.requestImpl = async (method) => {
      if (method !== 'turn/start') throw new Error(`Unexpected request: ${method}`);
      await connection.emitNotification('turn/started', {
        threadId: 'thread-1',
        turn: { id: 'provider-turn-1', status: 'inProgress', items: [] },
      });
      return { turn: { id: 'provider-turn-1', status: 'inProgress', items: [] } };
    };

    await adapter.submit({
      sessionId: 'session-1',
      providerSessionId: 'thread-1',
      turnId: 'local-turn-1',
      commandId: 'command-idempotency-1',
      prompt: 'Implement the feature',
    });
    expect(connection.requests.at(-1)).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'command-idempotency-1',
        input: [{ type: 'text', text: 'Implement the feature', text_elements: [] }],
      },
    });
    expect(events.filter((event) => event.kind === 'turn-started')).toEqual([{
      kind: 'turn-started',
      sessionId: 'session-1',
      turnId: 'local-turn-1',
      providerTurnId: 'provider-turn-1',
      commandId: 'command-idempotency-1',
    }]);

    await connection.emitNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'provider-turn-1', itemId: 'assistant-1', delta: 'Work',
    });
    await connection.emitNotification('item/completed', {
      threadId: 'thread-1', turnId: 'provider-turn-1', completedAtMs: 1,
      item: { id: 'assistant-1', type: 'agentMessage', text: 'Work complete', phase: null },
    });
    await connection.emitNotification('item/started', {
      threadId: 'thread-1', turnId: 'provider-turn-1', startedAtMs: 1,
      item: {
        id: 'collab-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress',
        receiverThreadIds: ['child-thread'], prompt: 'Inspect tests', agentsStates: {
          'child-thread': { status: 'running', message: null },
        },
      },
    });
    await connection.emitNotification('item/completed', {
      threadId: 'thread-1', turnId: 'provider-turn-1', completedAtMs: 2,
      item: {
        id: 'activity-1', type: 'subAgentActivity', kind: 'completed',
        agentThreadId: 'child-thread', agentPath: 'root/child',
      },
    });
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'provider-turn-1',
        status: 'completed',
        error: null,
        items: [{ id: 'assistant-1', type: 'agentMessage', text: 'Work complete', phase: null }],
      },
    });

    const transcriptEvents = events.filter((event) => event.kind === 'transcript');
    expect(transcriptEvents.map((event) => event.item)).toMatchObject([
      { sessionId: 'session-1', turnId: 'local-turn-1', sequence: 1, kind: 'assistant-message', text: 'Work', isDelta: true },
      { sessionId: 'session-1', turnId: 'local-turn-1', sequence: 2, kind: 'assistant-message', text: 'Work complete', isDelta: false },
      { sessionId: 'session-1', turnId: 'local-turn-1', sequence: 3, kind: 'notice' },
      { sessionId: 'session-1', turnId: 'local-turn-1', sequence: 4, kind: 'notice' },
    ]);
    expect(events.filter((event) => event.kind === 'native-subagent')).toEqual([
      {
        kind: 'native-subagent', sessionId: 'session-1', providerChildId: 'child-thread',
        title: 'Inspect tests', state: 'working',
      },
      {
        kind: 'native-subagent', sessionId: 'session-1', providerChildId: 'child-thread',
        title: 'child', state: 'done',
      },
    ]);
    expect(events.filter((event) => event.kind === 'turn-finished')).toEqual([{
      kind: 'turn-finished', sessionId: 'session-1', turnId: 'local-turn-1', outcome: 'completed', summary: 'Work complete',
    }]);
    await adapter.dispose();
  });

  it('round-trips modern, permission, and legacy approval server requests', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    const commandApproval = connection.serverRequest('item/commandExecution/requestApproval', 'rpc-command', {
      threadId: 'thread-1', turnId: 'provider-turn', itemId: 'item-1',
      approvalId: 'callback-1', command: 'git status', reason: 'Needs command access',
    });
    expect(events.at(-2)).toMatchObject({
      kind: 'approval-requested', sessionId: 'session-1', providerRequestId: 'command:callback-1',
      risk: 'danger', title: 'Run command', detail: 'git status',
    });
    await adapter.resolveApproval({
      sessionId: 'session-1', providerSessionId: 'thread-1',
      providerRequestId: 'command:callback-1', decision: 'allow',
    });
    await expect(commandApproval).resolves.toEqual({ decision: 'accept' });

    const permissionApproval = connection.serverRequest('item/permissions/requestApproval', 22, {
      threadId: 'thread-1', turnId: 'provider-turn', itemId: 'item-2',
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    await adapter.resolveApproval({
      sessionId: 'session-1', providerSessionId: 'thread-1',
      providerRequestId: 'permissions:n:22', decision: 'deny',
    });
    await expect(permissionApproval).resolves.toEqual({ permissions: {}, scope: 'turn' });

    const legacyApproval = connection.serverRequest('execCommandApproval', 'legacy-1', {
      conversationId: 'thread-1', callId: 'call-1', approvalId: null,
      command: ['git', 'push'], cwd: 'C:\\Working\\EZTerminal', reason: null,
    });
    await adapter.resolveApproval({
      sessionId: 'session-1', providerSessionId: 'thread-1',
      providerRequestId: 'legacy-command:s:legacy-1', decision: 'deny',
    });
    await expect(legacyApproval).resolves.toEqual({
      decision: { denied: { rejection: 'Denied by the user in EZTerminal.' } },
    });
    await adapter.dispose();
  });

  it('updates model and permission policy, interrupts the provider turn, then unsubscribes', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    connection.requestImpl = async (method) => {
      if (method === 'turn/start') return { turn: { id: 'provider-turn-1' } };
      if (method === 'thread/settings/update' || method === 'turn/interrupt') return {};
      if (method === 'thread/unsubscribe') return { status: 'notLoaded' };
      throw new Error(`Unexpected request: ${method}`);
    };
    await adapter.submit({
      sessionId: 'session-1', providerSessionId: 'thread-1', turnId: 'turn-1', commandId: 'command-1', prompt: 'Work',
    });
    await adapter.interrupt('session-1', 'thread-1');
    expect(connection.requests.at(-1)).toMatchObject({
      method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'provider-turn-1' },
    });
    await expect(adapter.setSettings({
      sessionId: 'session-1', providerSessionId: 'thread-1', model: 'gpt-new', permissionPreset: 'full-access',
    })).resolves.toMatchObject({ model: 'gpt-new', permissionPreset: 'full-access' });
    expect(connection.requests.at(-1)).toMatchObject({
      method: 'thread/settings/update',
      params: {
        threadId: 'thread-1', model: 'gpt-new', approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    });
    await adapter.disposeSession('session-1', 'thread-1');
    expect(connection.requests.at(-1)).toMatchObject({ method: 'thread/unsubscribe', params: { threadId: 'thread-1' } });
    await adapter.dispose();
  });

  it('queues an interrupt until turn identity arrives and sends it exactly once across notification and response', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([]);

    await connection.emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-1', items: [{ type: 'userMessage', clientId: 'command-1' }] },
    });
    resolveTurnStart({ turn: { id: 'provider-turn-1' } });
    await Promise.all([submitting, interrupting]);

    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([
      expect.objectContaining({
        method: 'turn/interrupt',
        params: { threadId: 'thread-1', turnId: 'provider-turn-1' },
      }),
    ]);
    await adapter.dispose();
  });

  it('dispatches a pending interrupt when turn/start response supplies identity first', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    resolveTurnStart({ turn: { id: 'provider-turn-1' } });
    await Promise.all([submitting, interrupting]);

    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread-1', turnId: 'provider-turn-1' } }),
    ]);
    await adapter.dispose();
  });

  it('settles a pending interrupt without dispatch when the provider completes first', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'provider-turn-1',
        status: 'completed',
        items: [{ type: 'userMessage', clientId: 'command-1' }],
      },
    });
    await expect(interrupting).resolves.toBeUndefined();
    resolveTurnStart({ turn: { id: 'provider-turn-1' } });
    await expect(submitting).resolves.toBeUndefined();
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([]);
    await adapter.dispose();
  });

  it('does not let delayed predecessor lifecycle events capture a pending current interrupt', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    let interruptSettled = false;
    void interrupting.then(
      () => { interruptSettled = true; },
      () => { interruptSettled = true; },
    );

    await connection.emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: {
        id: 'provider-predecessor',
        items: [{ type: 'userMessage', clientId: 'command-predecessor' }],
      },
    });
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'provider-predecessor',
        status: 'completed',
        items: [{ type: 'userMessage', clientId: 'command-predecessor' }],
      },
    });

    expect(interruptSettled).toBe(false);
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([]);
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'turn-started',
      turnId: 'turn-1',
      providerTurnId: 'provider-predecessor',
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'turn-finished',
      turnId: 'turn-1',
    }));

    resolveTurnStart({ turn: { id: 'provider-current' } });
    await Promise.all([submitting, interrupting]);
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([
      expect.objectContaining({
        params: { threadId: 'thread-1', turnId: 'provider-current' },
      }),
    ]);
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'provider-current', status: 'interrupted', items: [] },
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-finished',
      turnId: 'turn-1',
      outcome: 'interrupted',
    }));
    await adapter.dispose();
  });

  it('reports a queued interrupt delivery failure and settles its waiter', async () => {
    const fixture = await pendingTurnFixture(async () => { throw new Error('interrupt transport failed'); });
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = fixture;
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const interruptFailure = expect(interrupting).rejects.toThrow('interrupt transport failed');
    await connection.emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-1', items: [{ type: 'userMessage', clientId: 'command-1' }] },
    });
    await interruptFailure;
    expect(events).toContainEqual({
      kind: 'provider-error',
      sessionId: 'session-1',
      code: 'turn-interrupt-failed',
      message: 'interrupt transport failed',
      recoverable: true,
    });
    resolveTurnStart({ turn: { id: 'provider-turn-1' } });
    await submitting;
    await adapter.dispose();
  });

  it('does not report a late interrupt RPC failure after authoritative turn completion', async () => {
    let rejectInterrupt!: (reason: Error) => void;
    const interruptRequest = new Promise<unknown>((_resolve, reject) => {
      rejectInterrupt = reject;
    });
    const fixture = await pendingTurnFixture(async () => interruptRequest);
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = fixture;
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await connection.emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-1', items: [{ type: 'userMessage', clientId: 'command-1' }] },
    });
    await vi.waitFor(() => expect(connection.requests.some((request) => request.method === 'turn/interrupt')).toBe(true));
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-1', status: 'completed', items: [] },
    });
    await expect(interrupting).resolves.toBeUndefined();
    rejectInterrupt(new Error('late interrupt failure'));
    await Promise.resolve();
    expect(events).not.toContainEqual(expect.objectContaining({ code: 'turn-interrupt-failed' }));

    resolveTurnStart({ turn: { id: 'provider-turn-1' } });
    await submitting;
    await adapter.dispose();
  });

  it('settles a pending interrupt when turn start fails or the adapter deactivates', async () => {
    const fixture = await pendingTurnFixture();
    const { adapter, connection, submitting, interrupting, rejectTurnStart } = fixture;
    rejectTurnStart(new Error('turn/start failed'));
    await expect(submitting).rejects.toThrow('turn/start failed');
    await expect(interrupting).rejects.toThrow('turn/start failed');

    connection.requestImpl = async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-2' } };
      throw new Error(`Unexpected request: ${method}`);
    };
    await adapter.resumeSession({ ...context({ sessionId: 'session-2' }), providerSessionId: 'thread-2' });
    let resolveSecondStart!: (value: unknown) => void;
    const secondStart = new Promise<unknown>((resolve) => {
      resolveSecondStart = resolve;
    });
    connection.requestImpl = async (method) => {
      if (method === 'turn/start') return secondStart;
      throw new Error(`Unexpected request: ${method}`);
    };
    const secondSubmit = adapter.submit({
      sessionId: 'session-2', providerSessionId: 'thread-2', turnId: 'turn-2', commandId: 'command-2', prompt: 'Work again',
    });
    await vi.waitFor(() => expect(connection.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2));
    const secondInterrupt = adapter.interrupt('session-2', 'thread-2');
    await adapter.deactivate();
    await expect(secondInterrupt).rejects.toThrow(/deactivat|stopped|disposed/i);
    resolveSecondStart({ turn: { id: 'provider-turn-2' } });
    await expect(secondSubmit).resolves.toBeUndefined();
    await adapter.dispose();
  });

  it.each([
    ['systemError', 'failed'],
    ['notLoaded', 'interrupted'],
  ] as const)('rejects a pending interrupt and clears active ownership on terminal %s status', async (
    status,
    expectedState,
  ) => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    const states: string[] = [];
    adapter.subscribe((event) => {
      if (event.kind === 'session-state') states.push(event.state);
    });
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    void interrupting.then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    await connection.emitNotification('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: status },
    });
    expect(outcome).toBe('rejected');
    resolveTurnStart({ turn: { id: 'provider-turn-after-terminal-status' } });
    await submitting;
    await interrupting.catch(() => undefined);

    expect(states).toContain(expectedState);
    await expect(adapter.interrupt('session-1', 'thread-1')).rejects.toThrow(/no interruptible provider turn/i);
    await adapter.dispose();
  });

  it('settles pending ownership on a nonretry error but preserves it for idle and retryable signals', async () => {
    const terminal = await pendingTurnFixture();
    let terminalOutcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    void terminal.interrupting.then(
      () => { terminalOutcome = 'resolved'; },
      () => { terminalOutcome = 'rejected'; },
    );
    await terminal.connection.emitNotification('error', {
      threadId: 'thread-1',
      error: { message: 'terminal provider error' },
      willRetry: false,
    });
    expect(terminalOutcome).toBe('rejected');
    terminal.resolveTurnStart({ turn: { id: 'provider-turn-after-terminal-error' } });
    await terminal.submitting;
    await terminal.interrupting.catch(() => undefined);
    await expect(terminal.adapter.interrupt('session-1', 'thread-1'))
      .rejects.toThrow(/no interruptible provider turn/i);
    await terminal.adapter.dispose();

    const retryable = await pendingTurnFixture();
    let retryableSettled = false;
    void retryable.interrupting.then(
      () => { retryableSettled = true; },
      () => { retryableSettled = true; },
    );
    await retryable.connection.emitNotification('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'idle' },
    });
    await retryable.connection.emitNotification('error', {
      threadId: 'thread-1',
      error: { message: 'retrying provider error' },
      willRetry: true,
    });
    expect(retryableSettled).toBe(false);

    await retryable.connection.emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: {
        id: 'provider-turn-1',
        items: [{ type: 'userMessage', clientId: 'command-1' }],
      },
    });
    retryable.resolveTurnStart({ turn: { id: 'provider-turn-1' } });
    await Promise.all([retryable.submitting, retryable.interrupting]);
    expect(retryable.connection.requests.filter((request) => request.method === 'turn/interrupt'))
      .toHaveLength(1);
    await retryable.adapter.dispose();
  });

  it('deactivates the app-server connection without permanently disposing the adapter', async () => {
    const firstConnection = new FakeCodexConnection();
    firstConnection.requestImpl = async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
      throw new Error(`Unexpected first-connection request: ${method}`);
    };
    const secondConnection = new FakeCodexConnection();
    secondConnection.requestImpl = async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
      throw new Error(`Unexpected second-connection request: ${method}`);
    };
    const connections = [firstConnection, secondConnection];
    const connectionFactory = vi.fn(() => connections.shift()!);
    const adapter = reviewedAdapter(connectionFactory);
    await adapter.createSession(context());

    await adapter.deactivate();

    expect(firstConnection.disposed).toBe(true);
    await expect(adapter.resumeSession({
      ...context({ sessionId: 'session-2' }),
      providerSessionId: 'thread-1',
    })).resolves.toMatchObject({ sessionId: 'session-2', providerSessionId: 'thread-1' });
    expect(connectionFactory).toHaveBeenCalledTimes(2);
    expect(secondConnection.requests).toEqual([
      expect.objectContaining({ method: 'thread/resume', params: expect.objectContaining({ threadId: 'thread-1' }) }),
    ]);
    await adapter.dispose();
    expect(secondConnection.disposed).toBe(true);
  });

  it('excludes connection creation during deactivation and lets dispose win the race', async () => {
    const firstConnection = new FakeCodexConnection();
    firstConnection.requestImpl = async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
      throw new Error(`Unexpected first-connection request: ${method}`);
    };
    let releaseDispose!: () => void;
    const disposeBlocked = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    firstConnection.disposeImpl = () => disposeBlocked;
    const secondConnection = new FakeCodexConnection();
    secondConnection.requestImpl = async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
      throw new Error(`Unexpected second-connection request: ${method}`);
    };
    const connectionFactory = vi.fn()
      .mockReturnValueOnce(firstConnection)
      .mockReturnValueOnce(secondConnection);
    const adapter = reviewedAdapter(connectionFactory);
    await adapter.createSession(context());

    const deactivating = adapter.deactivate();
    const resuming = adapter.resumeSession({
      ...context({ sessionId: 'session-2' }),
      providerSessionId: 'thread-1',
    });
    const disposing = adapter.dispose();
    releaseDispose();
    await deactivating;
    await expect(resuming).rejects.toThrow(/disposed/);
    await disposing;
    expect(connectionFactory).toHaveBeenCalledTimes(1);
    expect(secondConnection.disposed).toBe(false);
  });

  it('waits for deactivation before listing models on a replacement connection', async () => {
    const firstConnection = new FakeCodexConnection();
    firstConnection.requestImpl = async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      throw new Error(`Unexpected first-connection request: ${method}`);
    };
    let releaseDispose!: () => void;
    const disposeBlocked = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    firstConnection.disposeImpl = () => disposeBlocked;
    const secondConnection = new FakeCodexConnection();
    secondConnection.requestImpl = async (method) => {
      if (method === 'model/list') return { data: [{ id: 'gpt-new', displayName: 'GPT New' }] };
      throw new Error(`Unexpected second-connection request: ${method}`);
    };
    const connectionFactory = vi.fn()
      .mockReturnValueOnce(firstConnection)
      .mockReturnValueOnce(secondConnection);
    const adapter = reviewedAdapter(connectionFactory);
    await adapter.createSession(context());

    const deactivating = adapter.deactivate();
    const listing = adapter.listModels();
    expect(connectionFactory).toHaveBeenCalledTimes(1);
    releaseDispose();
    await deactivating;
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ id: 'gpt-new', displayName: 'GPT New' }),
    ]);
    expect(connectionFactory).toHaveBeenCalledTimes(2);
    await adapter.dispose();
    expect(secondConnection.disposed).toBe(true);
  });

  it('keeps replacement notification routing when an overlapping source disposal finishes late', async () => {
    const connection = new FakeCodexConnection();
    let releaseFirstUnsubscribe!: () => void;
    const firstUnsubscribe = new Promise<void>((resolve) => {
      releaseFirstUnsubscribe = resolve;
    });
    let unsubscribeCount = 0;
    connection.requestImpl = async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
      if (method === 'thread/resume') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
      if (method === 'thread/unsubscribe') {
        unsubscribeCount += 1;
        if (unsubscribeCount === 1) await firstUnsubscribe;
        return { status: 'notLoaded' };
      }
      throw new Error(`Unexpected request: ${method}`);
    };
    const adapter = new CodexProviderAdapter({ connection });
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.createSession(context({ sessionId: 'session-source' }));

    const lateDisposal = adapter.disposeSession('session-source', 'thread-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await adapter.disposeSession('session-source', 'thread-1');
    await adapter.resumeSession({
      ...context({ sessionId: 'session-destination' }),
      providerSessionId: 'thread-1',
    });
    events.length = 0;
    releaseFirstUnsubscribe();
    await lateDisposal;
    await connection.emitNotification('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'active' },
    });

    expect(events).toEqual([
      { kind: 'session-state', sessionId: 'session-destination', state: 'working' },
    ]);
    await adapter.dispose();
  });

  it('reconciles delivered command IDs and semantic transcript through thread/read', async () => {
    const connection = new FakeCodexConnection();
    connection.requestImpl = async (method) => {
      if (method !== 'thread/read') throw new Error(`Unexpected request: ${method}`);
      return {
        thread: {
          id: 'thread-1',
          turns: [{
            id: 'provider-turn-1',
            startedAt: 1_788_000_000,
            status: 'completed',
            items: [
              { id: 'user-1', type: 'userMessage', clientId: 'command-delivered', content: [{ type: 'text', text: 'hello' }] },
              { id: 'agent-1', type: 'agentMessage', text: 'hi' },
              { id: 'tool-1', type: 'commandExecution', command: 'pwd', status: 'completed', aggregatedOutput: 'C:\\Working' },
            ],
          }],
        },
      };
    };
    const adapter = new CodexProviderAdapter({ connection });
    await expect(adapter.reconcile({
      sessionId: 'session-1',
      providerSessionId: 'thread-1',
      unsettledCommands: [
        { commandId: 'command-delivered', idempotencyKey: 'key-1', type: 'agent.submit' },
        { commandId: 'command-unknown', idempotencyKey: 'key-2', type: 'agent.submit' },
      ],
    })).resolves.toMatchObject({
      commands: [
        { commandId: 'command-delivered', state: 'applied', providerTurnId: 'provider-turn-1' },
        { commandId: 'command-unknown', state: 'not-applied' },
      ],
      transcriptItems: [
        { sequence: 1, sessionId: 'session-1', kind: 'user-message', text: 'hello' },
        { sequence: 2, sessionId: 'session-1', kind: 'assistant-message', text: 'hi' },
        { sequence: 3, sessionId: 'session-1', kind: 'tool-result', text: 'C:\\Working', isSensitive: true },
      ],
    });
    expect(connection.requests).toMatchObject([{
      method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true },
    }]);
    await adapter.dispose();
  });

  it('surfaces an unexpected app-server exit for every attached session and disposes once', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    connection.crash('codex process exited');
    expect(events).toEqual([
      {
        kind: 'provider-error', sessionId: 'session-1', code: 'app-server-exited',
        message: 'codex process exited', recoverable: true,
      },
      { kind: 'session-state', sessionId: 'session-1', state: 'failed', detail: 'codex process exited' },
    ]);
    await adapter.dispose();
    await adapter.dispose();
    expect(connection.disposed).toBe(true);
    await expect(adapter.listModels()).rejects.toThrow(/disposed/);
  });
});
