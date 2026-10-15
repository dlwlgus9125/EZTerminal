import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseApprovalRequest } from '../shared/approval-request';
import type { DaemonTranscriptItem } from '../shared/daemon-protocol';
import type { ProviderLaunchDescriptor } from '../shared/daemon-provider';
import { parseTranscriptPayload } from '../shared/transcript-payload';
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
  type CodexProviderAdapterOptions,
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

const launchDescriptor = (
  overrides: Partial<ProviderLaunchDescriptor> = {},
): ProviderLaunchDescriptor => ({
  providerId: 'codex',
  protocol: 'codex-app-server',
  executablePath: 'C:\\Tools\\codex.exe',
  executableVersion: CODEX_APP_SERVER_BASELINE_VERSION,
  argv: ['app-server'],
  environmentVariableNames: [
    'PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ],
  reviewDigest: 'a'.repeat(64),
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
  adapter.setLaunchDescriptor(launchDescriptor());
  return adapter;
}

async function launchPreflightAdapter(
  runCommand: NonNullable<CodexProviderAdapterOptions['runCommand']>,
): Promise<CodexProviderAdapter> {
  const connection = new FakeCodexConnection();
  let verifyBeforeSpawn: ((signal?: AbortSignal) => Promise<void>) | undefined;
  connection.requestImpl = async (method) => {
    await verifyBeforeSpawn?.();
    verifyBeforeSpawn = undefined;
    if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
    throw new Error(`Unexpected request: ${method}`);
  };
  const adapter = new CodexProviderAdapter({
    connectionFactory: (options) => {
      verifyBeforeSpawn = options.beforeSpawn;
      return connection;
    },
    runCommand,
  });
  adapter.setLaunchDescriptor(launchDescriptor({
    executablePath: await fs.realpath(process.execPath),
  }));
  return adapter;
}

function bufferedLifecycleState(
  adapter: CodexProviderAdapter,
  sessionId = 'session-1',
): { readonly size: number; readonly overflowed: boolean } {
  const sessions = (adapter as unknown as {
    readonly sessions: Map<string, {
      readonly preResponseLifecycle: Map<string, unknown>;
      readonly preResponseLifecycleOverflowed: boolean;
    }>;
  }).sessions;
  const state = sessions.get(sessionId);
  return {
    size: state?.preResponseLifecycle.size ?? 0,
    overflowed: state?.preResponseLifecycleOverflowed ?? false,
  };
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
  it('revalidates selected skill identities and sends native skill input on the first turn', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    connection.requestImpl = async (method) => {
      if (method === 'skills/list') return { data: [{ skills: [{ name: 'review', path: 'C:/skills/review/SKILL.md', enabled: true }] }] };
      if (method === 'turn/start') return { turn: { id: 'native-turn' } };
      return {};
    };
    await adapter.submit({ sessionId: 'session-1', providerSessionId: 'thread-1', turnId: 'turn-1', commandId: 'command-1', prompt: '$review Inspect', context: { skills: [{ providerId: 'codex', id: 'C:/skills/review/SKILL.md', name: 'review', invocation: '$review' }] } });
    expect(connection.requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({ input: [{ type: 'text', text: '$review Inspect' }, { type: 'skill', name: 'review', path: 'C:/skills/review/SKILL.md' }] });
    await adapter.dispose();
  });

  it('does not submit a turn when a selected skill is removed or disabled', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    connection.requestImpl = async () => ({ data: [{ skills: [{ name: 'review', path: 'C:/skills/review/SKILL.md', enabled: false }] }] });
    await expect(adapter.submit({ sessionId: 'session-1', providerSessionId: 'thread-1', turnId: 'turn-1', commandId: 'command-1', prompt: '$review Inspect', context: { skills: [{ providerId: 'codex', id: 'C:/skills/review/SKILL.md', name: 'review', invocation: '$review' }] } })).rejects.toThrow('unavailable');
    expect(connection.requests.some((entry) => entry.method === 'turn/start')).toBe(false);
    await adapter.dispose();
  });
  it('discovers skills, installed plugins, models and MCP without a thread or turn', async () => {
    const connection = new FakeCodexConnection();
    connection.requestImpl = async (method) => {
      if (method === 'model/list') return { data: [{ id: 'native-model', displayName: 'Native model' }] };
      if (method === 'skills/list') return { data: [{ skills: [{ name: 'review', path: 'C:/skills/review/SKILL.md', enabled: true, scope: 'user' }] }] };
      if (method === 'plugin/installed') return { marketplaces: [{ name: 'local', plugins: [{ id: 'off@local', name: 'Off plugin', installed: true, enabled: false }] }] };
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'docs', authStatus: 'notLoggedIn' }] };
      if (method === 'config/read') return { config: { mcp_servers: { docs: { command: 'docs' }, off: { command: 'off', enabled: false } } }, origins: { mcp_servers: { name: { type: 'user' } } } };
      throw new Error(`Forbidden zero-turn method: ${method}`);
    };
    const adapter = new CodexProviderAdapter({ connection });
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const result = await adapter.listCapabilities(process.cwd());
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', invocation: '$review', enabled: true }),
      expect.objectContaining({ kind: 'plugin', id: 'off@local', enabled: false }),
      expect.objectContaining({ kind: 'mcp', id: 'docs' }),
      expect.objectContaining({ kind: 'mcp', id: 'off', enabled: false, status: 'disabled' }),
    ]));
    expect(result.issues).toEqual([]);
    expect(connection.requests.map((entry) => entry.method).sort()).toEqual(['config/read', 'mcpServerStatus/list', 'model/list', 'plugin/installed', 'skills/list']);
    expect(connection.requests.find((entry) => entry.method === 'config/read')?.params).toEqual({ cwd: process.cwd(), includeLayers: false });
    expect(events).toEqual([]);
    await adapter.dispose();
  });
  it('rejects unsupported tool-free planning before connecting while preserving managed execution settings', async () => {
    const connection = new FakeCodexConnection();
    const adapter = new CodexProviderAdapter({ connection });
    await expect(adapter.createSession(context({ toolsDisabled: true, permissionPreset: 'plan' }))).rejects.toThrow(/verified tool-free/u);
    await expect(adapter.resumeSession({ ...context({ toolsDisabled: true }), providerSessionId: 'old' })).rejects.toThrow(/verified tool-free/u);
    expect(connection.requests).toEqual([]);
    connection.requestImpl = async () => ({ thread: { id: 'managed-thread' }, model: 'gpt-5.6-sol' });
    await adapter.createSession(context({ managedExecution: true, reasoningEffort: 'high', environment: { EZTERMINAL_RUN_ID: 'R', PORT: '4001' } }));
    expect(connection.requests[0]?.params).toMatchObject({ config: { model_reasoning_effort: 'high', 'features.multi_agent': false,
      'shell_environment_policy.set': { EZTERMINAL_RUN_ID: 'R', PORT: '4001' } } });
    await adapter.dispose();
  });
  it('probes the minimum supported executable without starting app-server', async () => {
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

  it.each(['0.152.0', '0.151.99'])('fails closed for Codex %s below the supported minimum', async (version) => {
    const adapter = new CodexProviderAdapter({
      connection: new FakeCodexConnection(),
      resolveExecutable: async () => 'C:\\Tools\\codex.exe',
      runCommand: async () => ({ stdout: `codex-cli ${version}`, stderr: '', exitCode: 0 }),
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      available: false,
      executableVersion: version,
      unavailableReason: `Codex ${version} is older than the minimum supported ${CODEX_APP_SERVER_BASELINE_VERSION} app-server version.`,
    });
    expect(() => adapter.setLaunchDescriptor(launchDescriptor({ executableVersion: version })))
      .toThrow(/incompatible/u);
    await adapter.dispose();
  });

  it('fails closed for malformed, unlabeled, and unsuccessful version commands', async () => {
    const malformed = new CodexProviderAdapter({
      connection: new FakeCodexConnection(),
      resolveExecutable: async () => 'C:\\Tools\\codex.exe',
      runCommand: async () => ({
        stdout: 'dependency warning 9.9.9\ncodex-cli 0.153.4-invalid..version',
        stderr: '',
        exitCode: 0,
      }),
    });
    await expect(malformed.probe()).resolves.toMatchObject({
      available: false,
      executableVersion: 'unknown',
      unavailableReason: 'Codex did not report a semantic version.',
    });
    await malformed.dispose();

    const unsuccessful = new CodexProviderAdapter({
      connection: new FakeCodexConnection(),
      resolveExecutable: async () => 'C:\\Tools\\codex.exe',
      runCommand: async () => ({ stdout: 'codex-cli 0.153.4', stderr: 'version command failed', exitCode: 9 }),
    });
    await expect(unsuccessful.probe()).resolves.toMatchObject({
      available: false,
      executableVersion: 'unknown',
      unavailableReason: 'version command failed',
    });
    await unsuccessful.dispose();
  });

  it('reports a missing Codex binary', async () => {
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

  it.each([
    '0.152.2',
    '0.153.4',
    '1.0.0',
    '0.153.4+dist.1',
  ])('keeps compatible Codex %s available without a per-release allowlist', async (version) => {
    const adapter = new CodexProviderAdapter({
      connection: new FakeCodexConnection(),
      resolveExecutable: async () => 'C:\\Tools\\codex.exe',
      runCommand: async () => ({ stdout: `codex-cli ${version}`, stderr: '', exitCode: 0 }),
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      available: true,
      executableVersion: version,
    });
    expect(() => adapter.setLaunchDescriptor(launchDescriptor({ executableVersion: version })))
      .not.toThrow();
    await adapter.dispose();
  });

  it('fails closed for a future prerelease', async () => {
    const version = '0.153.0-alpha.1';
    const adapter = new CodexProviderAdapter({
      connection: new FakeCodexConnection(),
      resolveExecutable: async () => 'C:\\Tools\\codex.exe',
      runCommand: async () => ({ stdout: `codex-cli ${version}`, stderr: '', exitCode: 0 }),
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      available: false,
      executableVersion: version,
      unavailableReason: `Codex ${version} is a prerelease; install stable Codex ${CODEX_APP_SERVER_BASELINE_VERSION} or newer.`,
    });
    expect(() => adapter.setLaunchDescriptor(launchDescriptor({ executableVersion: version })))
      .toThrow(/incompatible/u);
    await adapter.dispose();
  });

  it('keeps an approved Codex launch usable after a compatible in-place update', async () => {
    const adapter = await launchPreflightAdapter(
      async () => ({ stdout: 'codex-cli 0.153.4', stderr: '', exitCode: 0 }),
    );

    await expect(adapter.createSession(context())).resolves.toMatchObject({
      providerSessionId: 'thread-1',
    });
    await adapter.dispose();
  });

  it.each([
    {
      condition: 'the installed version is below the minimum',
      runCommand: async () => ({ stdout: 'codex-cli 0.152.0', stderr: '', exitCode: 0 }),
      expectedMessage: `Codex 0.152.0 is older than the minimum supported ${CODEX_APP_SERVER_BASELINE_VERSION} app-server version. Update Codex, then try again.`,
    },
    {
      condition: 'the version output is malformed',
      runCommand: async () => ({ stdout: 'codex-cli 0.153.4-invalid..version', stderr: '', exitCode: 0 }),
      expectedMessage: 'Codex version check returned no valid semantic version before launch. Reinstall or update Codex, then try again.',
    },
    {
      condition: 'the version command fails',
      runCommand: async () => ({ stdout: 'codex-cli 0.153.4', stderr: 'version command failed', exitCode: 9 }),
      expectedMessage: 'Codex version check failed before launch (version command failed). Reinstall or update Codex, then try again.',
    },
    {
      condition: 'the version command cannot start',
      runCommand: async (): Promise<never> => { throw new Error('spawn failed'); },
      expectedMessage: 'Codex version check failed before launch (spawn failed). Reinstall or update Codex, then try again.',
    },
  ])('fails launch closed with an actionable error when $condition', async ({ runCommand, expectedMessage }) => {
    const adapter = await launchPreflightAdapter(runCommand);

    await expect(adapter.createSession(context())).rejects.toThrow(expectedMessage);
    await adapter.dispose();
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
              { id: 'id-a', model: 'gpt-a', displayName: 'GPT A', description: 'Reasoning', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], isDefault: true },
              { id: 'hidden', model: 'hidden', hidden: true },
            ],
            nextCursor: 'page-2',
          };
    };
    const adapter = new CodexProviderAdapter({ connection });
    await expect(adapter.listModels()).resolves.toEqual([
      { id: 'gpt-a', displayName: 'GPT A', description: 'Reasoning', supportsReasoning: true, reasoningEfforts: ['high'], isDefault: true },
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

  it('sends real image inputs and quoted file context to Codex', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    connection.requestImpl = async () => ({ turn: { id: 'provider-turn-context' } });
    await adapter.submit({
      sessionId: 'session-1', providerSessionId: 'thread-1', turnId: 'local-context', commandId: 'command-context', prompt: 'Review',
      context: { attachments: [
        { id: 'image', name: 'screen.png', kind: 'image', mimeType: 'image/png', data: 'YWJj' },
        { id: 'text', name: 'notes.txt', kind: 'text', mimeType: 'text/plain', data: 'Requirements' },
      ] },
    });
    expect(connection.requests.at(-1)).toMatchObject({ params: { input: [
      { type: 'text', text: expect.stringContaining('Requirements') },
      { type: 'image', url: 'data:image/png;base64,YWJj' },
    ] } });
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

  it('preserves original assistant and command output with stable streaming message identity', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    connection.requestImpl = async () => ({ turn: { id: 'provider-turn-1', status: 'inProgress', items: [] } });
    await adapter.submit({
      sessionId: 'session-1', providerSessionId: 'thread-1', turnId: 'local-turn-1',
      commandId: 'raw-output-command', prompt: 'Show the output',
    });
    await connection.emitNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'provider-turn-1', itemId: 'assistant-raw', delta: 'TOKEN=secret',
    });
    await connection.emitNotification('item/completed', {
      threadId: 'thread-1', turnId: 'provider-turn-1',
      item: { id: 'assistant-raw', type: 'agentMessage', text: 'TOKEN=secret\nOriginal output' },
    });
    await connection.emitNotification('item/started', {
      threadId: 'thread-1', turnId: 'provider-turn-1',
      item: { id: 'command-raw', type: 'commandExecution', command: 'echo TOKEN=secret', status: 'inProgress' },
    });
    await connection.emitNotification('item/completed', {
      threadId: 'thread-1', turnId: 'provider-turn-1',
      item: { id: 'command-raw', type: 'commandExecution', command: 'echo TOKEN=secret',
        aggregatedOutput: 'TOKEN=secret\n', status: 'completed' },
    });
    const items = events.filter((event) => event.kind === 'transcript').map((event) => event.item);
    expect(items).toMatchObject([
      { kind: 'assistant-message', text: 'TOKEN=secret', isDelta: true },
      { kind: 'assistant-message', text: 'TOKEN=secret\nOriginal output', isDelta: false },
      { kind: 'tool-call', text: '$ echo TOKEN=secret' },
      { kind: 'tool-result', text: 'TOKEN=secret\n' },
    ]);
    expect(items[0].messageId).toBeTruthy();
    expect(items[1].messageId).toBe(items[0].messageId);
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

  it('round-trips native MCP tool approval without persisting a permission grant', async () => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    const events: AgentProviderEvent[] = [];
    adapter.subscribe(event => events.push(event));
    const params = { threadId: 'thread-1', turnId: 'provider-turn', serverName: 'ezterminal_orchestration', mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: { commandId: 'preview-1' } },
      message: 'Allow the MCP server to run preview_workflow?', requestedSchema: { type: 'object', properties: {} } };
    const approval = connection.serverRequest('mcpServer/elicitation/request', 'mcp-1', params);
    await Promise.resolve();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'approval-requested', providerRequestId: 'mcp-tool:s:mcp-1', title: 'Run MCP tool', detail: expect.stringContaining('preview_workflow') }));
    await expect(adapter.resolveApproval({ sessionId: 'other-session', providerSessionId: 'thread-1', providerRequestId: 'mcp-tool:s:mcp-1', decision: 'allow' })).rejects.toThrow('does not belong');
    await adapter.resolveApproval({ sessionId: 'session-1', providerSessionId: 'thread-1', providerRequestId: 'mcp-tool:s:mcp-1', decision: 'allow' });
    await expect(approval).resolves.toEqual({ action: 'accept', content: {}, _meta: null });
    const denied = connection.serverRequest('mcpServer/elicitation/request', 'mcp-2', params);
    await adapter.resolveApproval({ sessionId: 'session-1', providerSessionId: 'thread-1', providerRequestId: 'mcp-tool:s:mcp-2', decision: 'deny' });
    await expect(denied).resolves.toEqual({ action: 'decline', content: null, _meta: null });
    const closed = connection.serverRequest('mcpServer/elicitation/request', 'mcp-3', params);
    await adapter.dispose();
    await expect(closed).resolves.toEqual({ action: 'decline', content: null, _meta: null });
  });

  it('rejects unsupported MCP forms instead of treating data collection as binary approval', async () => {
    const connection = new FakeCodexConnection(); const adapter = await attachedAdapter(connection);
    const params = { threadId: 'thread-1', serverName: 'external', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } };
    await expect(connection.serverRequest('mcpServer/elicitation/request', 'form-1', params)).rejects.toThrow('MCP form');
    await expect(connection.serverRequest('mcpServer/elicitation/request', 'form-2', { ...params, mode: 'url' })).rejects.toThrow('MCP form');
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

  it.each([
    ['null', null],
    ['a scalar', 'updated'],
    ['an array', []],
  ])('does not mutate local settings when thread/settings/update returns %s', async (_label, result) => {
    const connection = new FakeCodexConnection();
    const adapter = await attachedAdapter(connection);
    connection.requestImpl = async (method) => {
      if (method === 'thread/settings/update') return result;
      throw new Error(`Unexpected request: ${method}`);
    };

    try {
      await expect(adapter.setSettings({
        sessionId: 'session-1',
        providerSessionId: 'thread-1',
        model: 'gpt-new',
        permissionPreset: 'full-access',
      })).rejects.toThrow(/thread\/settings\/update returned an invalid result/u);
      await expect(adapter.setSettings({
        sessionId: 'session-1',
        providerSessionId: 'thread-1',
      })).resolves.toMatchObject({
        model: 'gpt-5.6-sol',
        permissionPreset: 'standard',
      });
    } finally {
      await adapter.dispose();
    }
  });

  it('queues an interrupt until turn identity arrives and sends it exactly once across notification and response', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([]);

    await connection.emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-1', items: [] },
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

  it.each([
    ['null', null],
    ['a scalar', true],
    ['an array', []],
  ])('rejects an interrupt when turn/interrupt returns %s', async (_label, result) => {
    const fixture = await pendingTurnFixture(async () => result);
    const { adapter, interrupting, resolveTurnStart, submitting } = fixture;
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const interruptFailure = expect(interrupting).rejects.toThrow(
      /turn\/interrupt returned an invalid result/u,
    );

    resolveTurnStart({ turn: { id: 'provider-turn-1' } });

    try {
      await submitting;
      await interruptFailure;
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'provider-error',
        code: 'turn-interrupt-failed',
        message: expect.stringContaining('turn/interrupt returned an invalid result'),
      }));
    } finally {
      await adapter.dispose();
    }
  });

  it('settles a pending interrupt without dispatch when the provider completes first', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'provider-turn-1',
        status: 'completed',
        items: [],
      },
    });
    resolveTurnStart({ turn: { id: 'provider-turn-1' } });
    await expect(Promise.all([submitting, interrupting])).resolves.toEqual([undefined, undefined]);
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-finished',
      turnId: 'turn-1',
      outcome: 'completed',
    }));
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
        items: [],
      },
    });
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'provider-predecessor',
        status: 'completed',
        items: [],
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

  it('does not let a turn-scoped predecessor error capture a pending current interrupt', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    let interruptSettled = false;
    void interrupting.finally(() => { interruptSettled = true; });

    await connection.emitNotification('error', {
      threadId: 'thread-1',
      turnId: 'provider-predecessor',
      error: { message: 'late predecessor error' },
      willRetry: false,
    });
    expect(interruptSettled).toBe(false);

    resolveTurnStart({ turn: { id: 'provider-current' } });
    await Promise.all([submitting, interrupting]);
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread-1', turnId: 'provider-current' } }),
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'provider-error',
      turnScope: expect.objectContaining({ providerTurnId: 'provider-predecessor' }),
    }));
    await connection.emitNotification('error', {
      threadId: 'thread-1',
      turnId: 'provider-predecessor',
      error: { message: 'late predecessor error after response' },
      willRetry: false,
    });
    expect(events).toContainEqual({
      kind: 'provider-error',
      sessionId: 'session-1',
      turnScope: { providerTurnId: 'provider-predecessor' },
      code: 'codex-turn-error',
      message: 'late predecessor error after response',
      recoverable: false,
    });
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'provider-current', status: 'completed', items: [] },
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-finished', turnId: 'turn-1', outcome: 'completed',
    }));
    await adapter.dispose();
  });

  it('replays a matching turn-scoped error only after the response confirms ownership', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const interruptFailure = expect(interrupting).rejects.toThrow('current turn failed before response');

    await connection.emitNotification('error', {
      threadId: 'thread-1',
      turnId: 'provider-current',
      error: { message: 'current turn failed before response' },
      willRetry: false,
    });
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'provider-error' }));
    resolveTurnStart({ turn: { id: 'provider-current' } });
    await Promise.all([submitting, interruptFailure]);

    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([]);
    expect(events).toContainEqual({
      kind: 'provider-error',
      sessionId: 'session-1',
      turnScope: { turnId: 'turn-1', providerTurnId: 'provider-current' },
      code: 'codex-turn-error',
      message: 'current turn failed before response',
      recoverable: false,
    });
    expect(events.filter((event) => (
      event.kind === 'turn-started' || event.kind === 'provider-error'
    )).map((event) => event.kind)).toEqual(['turn-started', 'provider-error']);
    await adapter.dispose();
  });

  it('preserves a buffered terminal completion under same-turn retryable error flood', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'provider-current', status: 'completed', items: [] },
    });
    for (let index = 0; index < 12; index += 1) {
      await connection.emitNotification('error', {
        threadId: 'thread-1',
        turnId: 'provider-current',
        error: { message: `retry ${String(index)}` },
        willRetry: true,
      });
    }

    resolveTurnStart({ turn: { id: 'provider-current' } });
    await expect(Promise.all([submitting, interrupting])).resolves.toEqual([undefined, undefined]);
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([]);
    await adapter.dispose();
  });

  it('fails safe without interrupting when the confirmed turn was evicted from the bounded buffer', async () => {
    const { adapter, connection, submitting, interrupting, resolveTurnStart } = await pendingTurnFixture();
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const interruptFailure = expect(interrupting).rejects.toThrow(/lifecycle buffer overflowed/i);
    for (let index = 0; index < 9; index += 1) {
      await connection.emitNotification('turn/completed', {
        threadId: 'thread-1',
        turn: { id: `provider-${String(index)}`, status: 'completed', items: [] },
      });
    }
    expect(bufferedLifecycleState(adapter)).toEqual({ size: 8, overflowed: true });

    resolveTurnStart({ turn: { id: 'provider-0' } });
    await Promise.all([submitting, interruptFailure]);
    expect(connection.requests.filter((request) => request.method === 'turn/interrupt')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'provider-error',
      turnScope: { turnId: 'turn-1', providerTurnId: 'provider-0' },
      code: 'codex-lifecycle-buffer-overflow',
      recoverable: true,
    }));
    expect(bufferedLifecycleState(adapter)).toEqual({ size: 0, overflowed: false });
    await adapter.dispose();
  });

  it.each([
    'start-failure',
    'terminal-status',
    'connection-close',
    'deactivate',
    'dispose-session',
  ] as const)('clears pre-response lifecycle state on %s', async (terminal) => {
    const fixture = await pendingTurnFixture();
    const {
      adapter, connection, submitting, interrupting, resolveTurnStart, rejectTurnStart,
    } = fixture;
    const submitSettled = submitting.catch(() => undefined);
    const interruptSettled = interrupting.catch(() => undefined);
    await connection.emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'buffered-provider-turn', items: [] },
    });
    expect(bufferedLifecycleState(adapter)).toEqual({ size: 1, overflowed: false });

    switch (terminal) {
      case 'start-failure':
        rejectTurnStart(new Error('turn/start failed'));
        break;
      case 'terminal-status':
        await connection.emitNotification('thread/status/changed', {
          threadId: 'thread-1',
          status: { type: 'systemError' },
        });
        resolveTurnStart({ turn: { id: 'provider-after-terminal' } });
        break;
      case 'connection-close':
        connection.crash('connection closed');
        resolveTurnStart({ turn: { id: 'provider-after-close' } });
        break;
      case 'deactivate':
        await adapter.deactivate();
        resolveTurnStart({ turn: { id: 'provider-after-deactivate' } });
        break;
      case 'dispose-session':
        await adapter.disposeSession('session-1', 'thread-1').catch(() => undefined);
        resolveTurnStart({ turn: { id: 'provider-after-dispose' } });
        break;
    }
    await Promise.all([submitSettled, interruptSettled]);
    expect(bufferedLifecycleState(adapter)).toEqual({ size: 0, overflowed: false });
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
      turnScope: { turnId: 'turn-1', providerTurnId: 'provider-turn-1' },
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
      turnId: 'provider-terminal',
      error: { message: 'terminal provider error' },
      willRetry: false,
    });
    expect(terminalOutcome).toBe('pending');
    terminal.resolveTurnStart({ turn: { id: 'provider-terminal' } });
    await terminal.submitting;
    await terminal.interrupting.catch(() => undefined);
    expect(terminalOutcome).toBe('rejected');
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
      turnId: 'provider-turn-1',
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

  it('publishes reviewable patches only for completed file changes during reconciliation', async () => {
    const connection = new FakeCodexConnection();
    connection.requestImpl = async () => ({ thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'inProgress', items:
      ['completed', 'inProgress', 'failed', 'declined'].map(status => ({ id: status, type: 'fileChange', status, changes: [{ path: `${status}.ts`, diff: '@@ -1 +1 @@\n-old\n+new' }] })),
    }] } });
    const adapter = new CodexProviderAdapter({ connection });
    try {
      const result = await adapter.reconcile({ sessionId: 'session-1', providerSessionId: 'thread-1', unsettledCommands: [] });
      expect(result.transcriptItems?.filter(item => item.text.startsWith('{"type":"ezterminal.file-changes.v1"'))).toHaveLength(1);
      expect(result.transcriptItems?.[0].text).toContain('completed.ts');
    } finally { await adapter.dispose(); }
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

describe('CodexProviderAdapter structured transcript', () => {
  const workspaceRoot = path.resolve('/codex-workspace');
  const inWorkspace = (...parts: string[]): string => path.join(workspaceRoot, ...parts);
  const powershell = String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command`;

  async function startedTurn(options: Partial<CodexProviderAdapterOptions> = {}) {
    const connection = new FakeCodexConnection();
    connection.requestImpl = async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' };
      if (method === 'turn/start') return { turn: { id: 'provider-turn-1', status: 'inProgress', items: [] } };
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected request: ${method}`);
    };
    const adapter = new CodexProviderAdapter({
      connection,
      now: () => new Date('2026-09-04T03:00:00.000Z'),
      // Deltas flush only at item boundaries, never on a timer.
      deltaCoalescer: { schedule: () => undefined, cancel: () => undefined },
      ...options,
    });
    const events: AgentProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.createSession(context({ workspaceRoot }));
    await adapter.submit({
      sessionId: 'session-1', providerSessionId: 'thread-1', turnId: 'local-turn-1', commandId: 'command-1', prompt: 'Work',
    });
    const notify = (method: string, params: Record<string, unknown>): Promise<void> => connection.emitNotification(
      method,
      { threadId: 'thread-1', turnId: 'provider-turn-1', ...params },
    );
    const transcript = (): DaemonTranscriptItem[] => events.flatMap((event) => event.kind === 'transcript' ? [event.item] : []);
    return { adapter, connection, events, notify, transcript };
  }

  function expectValidPayloads(items: readonly DaemonTranscriptItem[]): void {
    for (const item of items) {
      if (item.payload !== undefined) expect(parseTranscriptPayload(item.payload), `${item.id} payload`).toBeDefined();
    }
  }

  it('coalesces streamed deltas into one row per message and flushes before later items and on interrupt', async () => {
    const { adapter, notify, transcript } = await startedTurn();
    for (const delta of ['Hel', 'lo', ' world']) await notify('item/agentMessage/delta', { itemId: 'msg-1', delta });
    await notify('item/commandExecution/outputDelta', { itemId: 'exec-1', delta: 'streamed output' });
    expect(transcript()).toEqual([]);
    await notify('item/started', {
      startedAtMs: 10, item: { id: 'exec-1', type: 'commandExecution', command: 'pwd', status: 'inProgress', commandActions: [] },
    });
    await notify('item/plan/delta', { itemId: 'plan-1', delta: '- step one' });
    await notify('item/plan/delta', { itemId: 'plan-1', delta: '\n- step two' });
    await adapter.interrupt('session-1', 'thread-1');
    expect(transcript()).toMatchObject([
      { sequence: 1, turnId: 'local-turn-1', kind: 'assistant-message', text: 'Hello world', isDelta: true },
      { sequence: 2, turnId: 'local-turn-1', kind: 'tool-call', text: '$ pwd' },
      { sequence: 3, turnId: 'local-turn-1', kind: 'reasoning', text: '- step one\n- step two', isDelta: true, payload: { v: 1, type: 'plan' } },
    ]);
    expectValidPayloads(transcript());
    await adapter.dispose();
  });

  it('drops the echo of a prompt this adapter submitted but keeps other user messages', async () => {
    const { adapter, notify, transcript } = await startedTurn();
    await notify('item/completed', {
      completedAtMs: 1, item: { id: 'user-1', type: 'userMessage', clientId: 'command-1', content: [{ type: 'text', text: 'Work' }] },
    });
    await notify('item/completed', {
      completedAtMs: 2, item: { id: 'user-2', type: 'userMessage', clientId: 'elsewhere', content: [{ type: 'text', text: 'From elsewhere' }] },
    });
    expect(transcript()).toHaveLength(1);
    expect(transcript()[0]).toMatchObject({ kind: 'user-message', text: 'From elsewhere' });
    await adapter.dispose();
  });

  it('unwraps the shell wrapper, keeps the exit code, and classifies commands from their parsed actions', async () => {
    const { adapter, notify, transcript } = await startedTurn();
    const commands = [
      {
        id: 'search', status: 'failed', exitCode: 1,
        command: String.raw`${powershell} "rg -n --hidden -g '"'!.git'"' '\\bgreet\\b' ."`,
        commandActions: [{ type: 'search', command: 'rg', query: 'greet', path: 'src' }],
      },
      { id: 'list', status: 'completed', exitCode: 0, aggregatedOutput: 'a\nb\n', command: `/bin/bash -lc 'ls -la' bash`,
        commandActions: [{ type: 'listFiles', command: 'ls -la', path: null }] },
      { id: 'cmd', status: 'completed', exitCode: 0, aggregatedOutput: 'x', command: 'cmd.exe /c dir /b', commandActions: [] },
      // Unbalanced quoting falls back to Codex's own parse of the command.
      { id: 'read', status: 'declined', command: `${powershell} 'Get-Content a.txt`,
        commandActions: [{ type: 'read', command: 'Get-Content a.txt', name: 'a.txt', path: inWorkspace('a.txt') }] },
    ];
    for (const command of commands) {
      await notify('item/started', { startedAtMs: 1, item: { ...command, type: 'commandExecution', status: 'inProgress', exitCode: null } });
      await notify('item/completed', { completedAtMs: 2, item: { ...command, type: 'commandExecution', cwd: workspaceRoot, durationMs: 7 } });
    }
    expect(transcript().map((item) => [item.kind, item.text])).toEqual([
      ['tool-call', String.raw`$ rg -n --hidden -g '!.git' '\bgreet\b' .`],
      ['tool-result', 'Exit code 1'],
      ['tool-call', '$ ls -la'],
      ['tool-result', 'a\nb\n'],
      ['tool-call', '$ dir /b'],
      ['tool-result', 'x'],
      ['tool-call', '$ Get-Content a.txt'],
      ['tool-result', 'Command declined.'],
    ]);
    expect(transcript().filter((item) => item.kind === 'tool-result').map((item) => item.payload)).toEqual([
      { v: 1, type: 'tool', callId: 'search', name: 'commandExecution', category: 'search', phase: 'result', status: 'failed',
        target: 'greet · src', query: 'greet', command: String.raw`rg -n --hidden -g '!.git' '\bgreet\b' .`, cwd: workspaceRoot,
        exitCode: 1, durationMs: 7 },
      { v: 1, type: 'tool', callId: 'list', name: 'commandExecution', category: 'list', phase: 'result', status: 'completed',
        target: 'ls -la', command: 'ls -la', cwd: workspaceRoot, exitCode: 0, durationMs: 7 },
      { v: 1, type: 'tool', callId: 'cmd', name: 'commandExecution', category: 'command', phase: 'result', status: 'completed',
        target: 'dir /b', command: 'dir /b', cwd: workspaceRoot, exitCode: 0, durationMs: 7 },
      { v: 1, type: 'tool', callId: 'read', name: 'commandExecution', category: 'read', phase: 'result', status: 'denied',
        target: inWorkspace('a.txt'), command: 'Get-Content a.txt', cwd: workspaceRoot, durationMs: 7 },
    ]);
    expect(transcript()[0]?.payload).toMatchObject({ phase: 'call', status: 'running' });
    expectValidPayloads(transcript());
    await adapter.dispose();
  });

  it('clips oversized command payloads to their schema bounds', async () => {
    const { adapter, notify, transcript } = await startedTurn();
    await notify('item/started', {
      startedAtMs: 1, item: { id: 'long', type: 'commandExecution', command: `echo ${'x'.repeat(10_000)}`, status: 'inProgress', cwd: 'C:\\'.repeat(1_500) },
    });
    const payload = transcript()[0]?.payload;
    expect(payload?.type === 'tool' ? [payload.command?.length, payload.cwd?.length, payload.target?.length] : undefined).toEqual([8_000, 2_000, 160]);
    expectValidPayloads(transcript());
    await adapter.dispose();
  });

  it('describes file changes with per-file kinds and line counts', async () => {
    const { adapter, notify, transcript } = await startedTurn();
    const item = {
      id: 'patch-1', type: 'fileChange', changes: [
        { path: inWorkspace('notes.md'), kind: { type: 'add' }, diff: 'one\ntwo\n' },
        { path: inWorkspace('src', 'old.ts'), kind: { type: 'update', move_path: inWorkspace('src', 'new.ts') }, diff: '@@ -1,2 +1,2 @@\n-a\n+b\n c\n' },
        { path: inWorkspace('gone.txt'), kind: { type: 'delete' }, diff: 'x\n' },
      ],
    };
    await notify('item/started', { startedAtMs: 1, item: { ...item, status: 'inProgress' } });
    await notify('item/completed', { completedAtMs: 4, item: { ...item, status: 'declined' } });
    expect(transcript().map((entry) => entry.text)).toEqual([
      `Add notes.md\nMove ${path.join('src', 'old.ts')} → ${path.join('src', 'new.ts')}\nDelete gone.txt`,
      'File changes declined.',
    ]);
    expect(transcript()[1]?.payload).toEqual({
      v: 1, type: 'tool', callId: 'patch-1', name: 'fileChange', category: 'edit', phase: 'result', status: 'denied',
      target: '3 files', durationMs: 3, files: [
        { path: inWorkspace('notes.md'), kind: 'add', added: 2, removed: 0 },
        { path: inWorkspace('src', 'old.ts'), kind: 'rename', added: 1, removed: 1 },
        { path: inWorkspace('gone.txt'), kind: 'delete', added: 0, removed: 1 },
      ],
    });
    expectValidPayloads(transcript());
    await adapter.dispose();
  });

  it('closes open tool calls as interrupted when the turn is interrupted', async () => {
    const { adapter, connection, events, notify, transcript } = await startedTurn();
    await notify('item/started', {
      startedAtMs: 100, item: { id: 'exec-1', type: 'commandExecution', command: 'sleep 60', status: 'inProgress', commandActions: [] },
    });
    await notify('item/started', { startedAtMs: 101, item: { id: 'ws-1', type: 'webSearch', query: '', action: null, results: null } });
    await notify('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Partial' });
    await connection.emitNotification('turn/completed', {
      threadId: 'thread-1', turn: { id: 'provider-turn-1', status: 'interrupted', items: [] },
    });
    expect(transcript().map((item) => [item.kind, item.text, item.payload?.type === 'tool' ? item.payload.status : undefined])).toEqual([
      ['tool-call', '$ sleep 60', 'running'],
      ['tool-call', 'Search the web', 'running'],
      ['assistant-message', 'Partial', undefined],
      ['tool-result', 'Command interrupted.', 'interrupted'],
      ['tool-result', 'Web search interrupted.', 'interrupted'],
    ]);
    const finished = events.findIndex((event) => event.kind === 'turn-finished');
    expect(finished).toBeGreaterThan(events.findLastIndex((event) => event.kind === 'transcript' && event.item.kind === 'tool-result'));
    const rows = transcript().length;
    await notify('item/completed', {
      completedAtMs: 200, item: { id: 'exec-1', type: 'commandExecution', command: 'sleep 60', status: 'failed', exitCode: 1 },
    });
    expect(transcript()).toHaveLength(rows);
    await adapter.dispose();
  });

  it('times empty reasoning only when both lifecycle edges were seen', async () => {
    const { adapter, notify, transcript } = await startedTurn();
    await notify('item/started', { startedAtMs: 1_000, item: { id: 'rs-1', type: 'reasoning', summary: [], content: [] } });
    await notify('item/completed', { completedAtMs: 4_500, item: { id: 'rs-1', type: 'reasoning', summary: [], content: [] } });
    await notify('item/completed', { completedAtMs: 5_000, item: { id: 'rs-2', type: 'reasoning', summary: [], content: [] } });
    expect(transcript()).toEqual([
      expect.objectContaining({ kind: 'reasoning', text: '', isDelta: false, payload: { v: 1, type: 'reasoning', durationMs: 3_500 } }),
    ]);
    await notify('item/completed', { completedAtMs: 6_000, item: { id: 'plan-1', type: 'plan', text: '- one\n- two' } });
    expect(transcript().at(-1)).toMatchObject({ kind: 'reasoning', text: '- one\n- two', payload: { v: 1, type: 'plan', markdown: '- one\n- two' } });
    await adapter.dispose();
  });

  it('enables update_plan and turns each plan revision into a todo notice', async () => {
    const { adapter, connection, notify, transcript } = await startedTurn();
    expect(connection.requests[0]).toMatchObject({ method: 'thread/start', params: { config: { 'tools.update_plan': { enabled: true } } } });
    await notify('turn/plan/updated', { explanation: null, plan: [
      { step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }, { step: 'Ship', status: 'pending' },
    ] });
    await notify('turn/plan/updated', { explanation: 'All done', plan: [
      { step: 'Read', status: 'completed' }, { step: 'Write', status: 'completed' }, { step: 'Ship', status: 'completed' },
    ] });
    const [first, second] = transcript();
    expect(first).toMatchObject({
      turnId: 'local-turn-1', kind: 'notice', text: '- [x] Read\n- [ ] Write (in progress)\n- [ ] Ship',
      payload: { v: 1, type: 'todo', source: 'codex-plan', items: [
        { text: 'Read', status: 'completed' }, { text: 'Write', status: 'in_progress' }, { text: 'Ship', status: 'pending' },
      ] },
    });
    expect(second).toMatchObject({ text: 'All done\n- [x] Read\n- [x] Write\n- [x] Ship', payload: { explanation: 'All done' } });
    expect(first?.id).not.toBe(second?.id);
    expectValidPayloads(transcript());
    await adapter.dispose();

    const disabled = await startedTurn({ enableUpdatePlan: false });
    expect(Object.keys((disabled.connection.requests[0]?.params as { config: object }).config)).not.toContain('tools.update_plan');
    await disabled.adapter.dispose();
  });

  it('describes approvals with the unwrapped command and the file diff from the started item', async () => {
    const { adapter, connection, events, notify } = await startedTurn();
    const approvals = (): Extract<AgentProviderEvent, { kind: 'approval-requested' }>[] => events.flatMap((event) => (
      event.kind === 'approval-requested' ? [event] : []
    ));
    const command = connection.serverRequest('item/commandExecution/requestApproval', 7, {
      threadId: 'thread-1', turnId: 'provider-turn-1', itemId: 'exec-9', startedAtMs: 1, reason: 'Outside the workspace',
      command: String.raw`${powershell} "Remove-Item -LiteralPath '..\\x.txt'"`, cwd: workspaceRoot,
    });
    expect(approvals()[0]).toMatchObject({
      title: 'Run command', detail: String.raw`Remove-Item -LiteralPath '..\x.txt'`,
      request: { v: 1, kind: 'command', callId: 'exec-9', command: String.raw`Remove-Item -LiteralPath '..\x.txt'`, cwd: workspaceRoot, reason: 'Outside the workspace' },
    });
    await adapter.resolveApproval({
      sessionId: 'session-1', providerSessionId: 'thread-1', providerRequestId: 'command:n:7', decision: 'deny',
      response: { kind: 'feedback', message: 'Use the recycle bin' },
    });
    await expect(command).resolves.toEqual({ decision: 'decline' });

    await notify('item/started', { startedAtMs: 1, item: { id: 'patch-1', type: 'fileChange', status: 'inProgress', changes: [
      { path: inWorkspace('notes.md'), kind: { type: 'add' }, diff: 'hello\n' },
    ] } });
    const fileChange = connection.serverRequest('item/fileChange/requestApproval', 8, {
      threadId: 'thread-1', turnId: 'provider-turn-1', itemId: 'patch-1', startedAtMs: 2, reason: null, grantRoot: null,
    });
    expect(approvals()[1]).toMatchObject({
      title: 'Apply file changes', risk: 'write',
      request: { v: 1, kind: 'file-change', callId: 'patch-1', files: [{ path: inWorkspace('notes.md'), kind: 'add', diff: 'hello\n' }] },
    });
    await adapter.resolveApproval({ sessionId: 'session-1', providerSessionId: 'thread-1', providerRequestId: 'file-change:n:8', decision: 'allow' });
    await expect(fileChange).resolves.toEqual({ decision: 'accept' });
    for (const approval of approvals()) expect(parseApprovalRequest(approval.request)).toBeDefined();
    await adapter.dispose();
  });

  it('maps MCP calls and web searches to structured payloads with readable results', async () => {
    const { adapter, notify, transcript } = await startedTurn();
    const mcp = { id: 'mcp-1', type: 'mcpToolCall', server: 'github', tool: 'search_issues', arguments: { q: 'bug' } };
    await notify('item/started', { startedAtMs: 1, item: { ...mcp, status: 'inProgress' } });
    await notify('item/completed', { completedAtMs: 2, item: { ...mcp, status: 'completed', durationMs: 42, result: { content: [] } } });
    await notify('item/started', { startedAtMs: 3, item: { id: 'ws-1', type: 'webSearch', query: '', action: null, results: null } });
    await notify('item/completed', { completedAtMs: 9, item: {
      id: 'ws-1', type: 'webSearch', query: 'node lts', action: { type: 'search', query: null, queries: ['node lts'] },
      results: [
        { type: 'text_result', title: 'Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases' },
        { type: 'text_result', title: 'EOL', url: 'https://nodejs.org/en/about/eol' },
      ],
    } });
    await notify('item/completed', { completedAtMs: 10, item: {
      id: 'ws-2', type: 'webSearch', query: '', action: { type: 'openPage', url: 'https://example.com/docs/page' }, results: null,
    } });
    const items = transcript();
    expect(items.map((item) => item.payload?.type === 'tool' ? [item.payload.category, item.payload.phase, item.payload.status, item.payload.target] : undefined)).toEqual([
      ['mcp', 'call', 'running', 'github / search_issues'],
      ['mcp', 'result', 'completed', 'github / search_issues'],
      ['web', 'call', 'running', undefined],
      ['web', 'result', 'completed', 'node lts'],
      ['web', 'result', 'completed', 'example.com/docs/page'],
    ]);
    expect(items[1]?.payload).toMatchObject({ name: 'search_issues', server: 'github', durationMs: 42 });
    expect(items.slice(2).map((item) => item.text)).toEqual([
      'Search the web',
      '1. Node.js Releases\n   https://nodejs.org/en/about/previous-releases\n2. EOL\n   https://nodejs.org/en/about/eol',
      'Opened https://example.com/docs/page',
    ]);
    expect(items[3]?.payload).toMatchObject({ query: 'node lts', durationMs: 6 });
    expectValidPayloads(items);
    await adapter.dispose();
  });
});
