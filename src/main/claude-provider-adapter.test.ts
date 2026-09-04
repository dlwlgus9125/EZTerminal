import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentProviderEvent, ProviderSessionContext } from './agent-provider-adapter';
import {
  CLAUDE_AGENT_SDK_BUNDLED_CLI_VERSION,
  ClaudeProviderAdapter,
  ClaudeProviderError,
  MemoryClaudeProviderEnablementStore,
  classifyClaudeAuthentication,
  classifyClaudeProviderError,
  resolveBundledClaudeExecutable,
  resolveClaudeExecutable,
  type ClaudeProviderEnablement,
  type ClaudeQuerySession,
} from './claude-provider-adapter';

const enabledPolicy: ClaudeProviderEnablement = {
  enabled: true,
  termsAccepted: true,
  commercialUseApproved: true,
  authenticationPath: 'api-key-environment',
  anthropicThirdPartyApproval: false,
};

const context: ProviderSessionContext = {
  sessionId: 'agent-session-1',
  workspaceId: 'workspace-1',
  workspaceRoot: path.resolve('fixture-workspace'),
  model: 'sonnet',
  permissionPreset: 'standard',
};

const executablePath = path.resolve('fixtures', process.platform === 'win32' ? 'claude.exe' : 'claude');
const providerSessionId = '11111111-1111-4111-8111-111111111111';

class FakeClaudeQuery implements ClaudeQuerySession {
  readonly inputOptions: Options;
  readonly input: AsyncIterable<SDKUserMessage>;
  readonly permissionModes: string[] = [];
  readonly models: Array<string | undefined> = [];
  closeCount = 0;
  interruptCount = 0;
  interruptReceipt: { still_queued?: readonly string[] } | undefined;
  supported = [{
    value: 'sonnet',
    displayName: 'Claude Sonnet',
    description: 'Balanced model',
    supportsEffort: true,
  }];

  private readonly messages: SDKMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  private ended = false;
  private readonly endOnClose: boolean;
  private readonly account: Record<string, unknown> | undefined;

  constructor(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
    endOnClose = true,
    apiKeySource = 'ANTHROPIC_API_KEY',
    account?: Record<string, unknown>,
  ) {
    this.input = input;
    this.inputOptions = options;
    this.endOnClose = endOnClose;
    this.account = account;
    this.emit({
      type: 'system',
      subtype: 'init',
      uuid: 'provider-init',
      session_id: options.sessionId ?? options.resume ?? providerSessionId,
      apiKeySource,
    });
  }

  emit(message: unknown): void {
    const value = message as SDKMessage;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.messages.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async interrupt(): Promise<{ still_queued?: readonly string[] } | undefined> {
    this.interruptCount += 1;
    return this.interruptReceipt;
  }

  async setPermissionMode(mode: NonNullable<Options['permissionMode']>): Promise<void> {
    this.permissionModes.push(mode);
  }

  async setModel(model?: string): Promise<void> {
    this.models.push(model);
  }

  async initializationResult(): Promise<unknown> {
    return { models: this.supported, ...(this.account ? { account: this.account } : {}) };
  }

  async supportedModels(): Promise<typeof this.supported> {
    return this.supported;
  }

  close(): void {
    this.closeCount += 1;
    if (this.endOnClose) this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async (): Promise<IteratorResult<SDKMessage>> => {
        const message = this.messages.shift();
        if (message) return { done: false, value: message };
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<SDKMessage>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function makeAdapter(options: {
  readonly policy?: ClaudeProviderEnablement;
  readonly endOnClose?: boolean;
  readonly apiKeySource?: string;
  readonly account?: Record<string, unknown>;
  readonly historyReader?: NonNullable<ConstructorParameters<typeof ClaudeProviderAdapter>[0]>['historyReader'];
} = {}): {
  readonly adapter: ClaudeProviderAdapter;
  readonly query: FakeClaudeQuery;
  readonly events: AgentProviderEvent[];
} {
  let fakeQuery: FakeClaudeQuery | undefined;
  const events: AgentProviderEvent[] = [];
  const adapter = new ClaudeProviderAdapter({
    enablementStore: new MemoryClaudeProviderEnablementStore(options.policy ?? enabledPolicy),
    resolveExecutable: async () => executablePath,
    readExecutableVersion: async () => '2.1.260',
    createId: () => providerSessionId,
    queryFactory: ({ prompt, options: queryOptions }) => {
      fakeQuery = new FakeClaudeQuery(
        prompt,
        queryOptions,
        options.endOnClose,
        options.apiKeySource,
        options.account,
      );
      return fakeQuery;
    },
    historyReader: options.historyReader,
    initializationTimeoutMs: 100,
    operationTimeoutMs: 100,
    shutdownTimeoutMs: 20,
    now: () => new Date('2026-09-04T00:00:00.000Z'),
  });
  adapter.subscribe((event) => events.push(event));
  return {
    adapter,
    get query() {
      if (!fakeQuery) throw new Error('query not created');
      return fakeQuery;
    },
    events,
  };
}

async function start(fixture: ReturnType<typeof makeAdapter>): Promise<void> {
  await fixture.adapter.createSession(context);
}

describe('Claude executable resolution', () => {
  it('resolves a Windows npm shim to the actual absolute native executable', async () => {
    const directory = 'C:\\Users\\tester\\AppData\\Roaming\\npm';
    const shim = path.win32.join(directory, 'claude.cmd');
    const native = path.win32.join(
      directory,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    const files = new Set([shim.toLocaleLowerCase('en-US'), native.toLocaleLowerCase('en-US')]);

    const result = await resolveClaudeExecutable({
      platform: 'win32',
      pathValue: directory,
      isFile: async (candidate) => files.has(candidate.toLocaleLowerCase('en-US')),
      realpath: async (candidate) => candidate,
    });

    expect(result).toBe(native);
    expect(result).not.toMatch(/\.(?:cmd|ps1)$/iu);
    expect(path.win32.isAbsolute(result!)).toBe(true);
  });

  it('rejects relative configured paths and Windows shims without a native target', async () => {
    await expect(resolveClaudeExecutable({
      configuredPath: 'claude',
      platform: 'win32',
      isFile: async () => true,
    })).resolves.toBeNull();
    await expect(resolveClaudeExecutable({
      configuredPath: 'C:\\bin\\claude.cmd',
      platform: 'win32',
      isFile: async (candidate) => candidate.endsWith('claude.cmd'),
      realpath: async (candidate) => candidate,
    })).resolves.toBeNull();
  });
});

describe('Claude provider review and enablement', () => {
  it('is disabled by default and exposes required review notices without credentials', async () => {
    const adapter = new ClaudeProviderAdapter({
      resolveExecutable: async () => executablePath,
      readExecutableVersion: async () => '2.1.260',
    });

    const probe = await adapter.probe();

    expect(probe).toMatchObject({
      providerId: 'claude',
      displayName: 'Claude Agent',
      protocol: 'claude-agent-sdk',
      available: false,
      executablePath,
      executableVersion: '2.1.260',
    });
    expect(probe.unavailableReason).toContain('CLAUDE_PROVIDER_DISABLED');
    expect(probe.reviewNotices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'anthropic-commercial-terms', level: 'required' }),
      expect.objectContaining({ id: 'anthropic-third-party-claude-ai', level: 'required' }),
    ]));
    expect(probe.displayName).toBe('Claude Agent');
    expect(probe.environmentVariableNames).not.toContain('ANTHROPIC_API_KEY');
    expect(probe.environmentVariableNames).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(JSON.stringify(probe)).not.toMatch(/ANTHROPIC_API_KEY=/u);
  });

  it('aborts an in-flight executable version probe promptly', async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const adapter = new ClaudeProviderAdapter({
      enablementStore: new MemoryClaudeProviderEnablementStore(enabledPolicy),
      resolveExecutable: async () => executablePath,
      readExecutableVersion: async (_path, _environment, signal) => {
        observedSignal = signal;
        markStarted?.();
        return new Promise<never>(() => undefined);
      },
    });
    const controller = new AbortController();

    const pending = adapter.probe(controller.signal);
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CLAUDE_OPERATION_ABORTED' });
    expect(observedSignal?.aborted).toBe(true);
    await adapter.dispose();
  });

  it('persists enablement only after the full terms and commercial gate passes', async () => {
    const saves: ClaudeProviderEnablement[] = [];
    const store = {
      load: async () => ({ ...enabledPolicy, enabled: false }),
      save: async (value: ClaudeProviderEnablement) => { saves.push(value); },
    };
    const adapter = new ClaudeProviderAdapter({ enablementStore: store });

    await expect(adapter.setEnablement({
      ...enabledPolicy,
      termsAccepted: false,
    })).rejects.toMatchObject({ code: 'CLAUDE_TERMS_REQUIRED' });
    await expect(adapter.setEnablement({
      ...enabledPolicy,
      commercialUseApproved: false,
    })).rejects.toMatchObject({ code: 'CLAUDE_COMMERCIAL_APPROVAL_REQUIRED' });
    expect(saves).toEqual([]);

    await expect(adapter.setEnablement(enabledPolicy)).resolves.toEqual(enabledPolicy);
    expect(saves).toEqual([enabledPolicy]);
  });

  it('requires prior Anthropic approval for an existing claude.ai login', async () => {
    const adapter = new ClaudeProviderAdapter();

    await expect(adapter.setEnablement({
      ...enabledPolicy,
      authenticationPath: 'existing-claude-ai-login',
      anthropicThirdPartyApproval: false,
    })).rejects.toMatchObject({
      code: 'CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED',
      message: expect.stringMatching(/third-party product.*prior Anthropic approval/iu),
    });

    await expect(adapter.setEnablement({
      ...enabledPolicy,
      authenticationPath: 'existing-claude-ai-login',
      anthropicThirdPartyApproval: true,
    })).resolves.toMatchObject({ enabled: true, anthropicThirdPartyApproval: true });
  });

  it('classifies helper, managed-key, cloud, and first-party auth without account identity output', () => {
    expect(classifyClaudeAuthentication('existing-cli-environment', 'apiKeyHelper', {
      account: { email: 'private@example.test', apiProvider: 'firstParty' },
    })).toBeNull();
    expect(classifyClaudeAuthentication('existing-cli-environment', '/login managed key', {
      account: { organization: 'private-org' },
    })).toBeNull();
    expect(classifyClaudeAuthentication('existing-cli-environment', 'none', {
      account: { apiProvider: 'gateway' },
    })).toBeNull();
    expect(classifyClaudeAuthentication('existing-cli-environment', 'none', {
      account: { apiProvider: 'firstParty', subscriptionType: 'pro' },
    })).toBe('CLAUDE_AUTHENTICATION_FAILED');
    expect(classifyClaudeAuthentication('existing-claude-ai-login', 'none', {
      account: { apiProvider: 'firstParty', subscriptionType: 'pro' },
    })).toBeNull();
  });

  it('fails before SDK process creation when the reviewed CLI version drifts', async () => {
    const bundledExecutable = await resolveBundledClaudeExecutable();
    expect(bundledExecutable).not.toBeNull();
    const queryFactory = vi.fn(() => {
      throw new Error('query must not start');
    });
    const adapter = new ClaudeProviderAdapter({
      enablementStore: new MemoryClaudeProviderEnablementStore(enabledPolicy),
      queryFactory,
      readExecutableVersion: async () => '2.1.261',
    });
    adapter.setLaunchDescriptor({
      providerId: 'claude',
      protocol: 'claude-agent-sdk',
      executablePath: bundledExecutable!,
      executableVersion: CLAUDE_AGENT_SDK_BUNDLED_CLI_VERSION,
      argv: [
        '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
        '--permission-prompt-tool', 'stdio',
      ],
      environmentVariableNames: [
        'PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'ANTHROPIC_API_KEY',
      ],
      reviewDigest: 'a'.repeat(64),
    });

    await expect(adapter.createSession(context)).rejects.toMatchObject({
      code: 'CLAUDE_EXECUTABLE_INVALID',
    });
    expect(queryFactory).not.toHaveBeenCalled();
  });

  it('does not start the SDK query when shutdown aborts readiness verification', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const queryFactory = vi.fn(() => {
      throw new Error('query must not start');
    });
    const adapter = new ClaudeProviderAdapter({
      enablementStore: new MemoryClaudeProviderEnablementStore(enabledPolicy),
      resolveExecutable: async () => executablePath,
      readExecutableVersion: async (_path, _environment, signal) => {
        markStarted?.();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new ClaudeProviderError('CLAUDE_OPERATION_ABORTED', true)),
            { once: true },
          );
        });
      },
      queryFactory,
    });
    const controller = new AbortController();

    const pending = adapter.createSession(context, controller.signal);
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CLAUDE_OPERATION_ABORTED' });
    expect(queryFactory).not.toHaveBeenCalled();
    await adapter.dispose();
  });
});

describe('ClaudeProviderAdapter sessions', () => {
  it('creates and resumes through the SDK using an absolute executable and allowlisted environment', async () => {
    const created = makeAdapter();
    const handle = await created.adapter.createSession(context);

    expect(handle).toEqual({
      sessionId: context.sessionId,
      providerSessionId,
      model: 'sonnet',
      permissionPreset: 'standard',
    });
    expect(created.query.inputOptions).toMatchObject({
      cwd: context.workspaceRoot,
      pathToClaudeCodeExecutable: executablePath,
      permissionMode: 'default',
      sessionId: providerSessionId,
      model: 'sonnet',
    });
    expect(created.query.inputOptions.env).toMatchObject({
      CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2',
    });
    expect(created.query.inputOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(created.query.inputOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(created.query.inputOptions).not.toHaveProperty('resume');
    expect(path.isAbsolute(created.query.inputOptions.pathToClaudeCodeExecutable!)).toBe(true);
    await created.adapter.dispose();

    const resumed = makeAdapter();
    await resumed.adapter.resumeSession({ ...context, providerSessionId });
    expect(resumed.query.inputOptions).toMatchObject({
      resume: providerSessionId,
      pathToClaudeCodeExecutable: executablePath,
    });
    expect(resumed.query.inputOptions).not.toHaveProperty('sessionId');
    expect(resumed.query.inputOptions.env).toBeDefined();
    await resumed.adapter.dispose();
  });

  it('passes the ephemeral orchestration endpoint and bearer header as an SDK HTTP MCP server', async () => {
    const fixture = makeAdapter();
    const bearerToken = 'session-only-secret';

    await fixture.adapter.createSession({
      ...context,
      orchestration: {
        endpoint: 'http://127.0.0.1:43111/mcp',
        bearerToken,
      },
    });

    expect(fixture.query.inputOptions.mcpServers).toEqual({
      ezterminal_orchestration: {
        type: 'http',
        url: 'http://127.0.0.1:43111/mcp',
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
    });
    expect(fixture.query.inputOptions.env).toBeDefined();
    expect(fixture.query.inputOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    await fixture.adapter.dispose();
  });

  it('rejects unsafe orchestration endpoints before starting the SDK query', async () => {
    const fixture = makeAdapter();

    await expect(fixture.adapter.createSession({
      ...context,
      orchestration: {
        endpoint: 'file:///tmp/not-http',
        bearerToken: 'must-never-appear-in-an-error',
      },
    })).rejects.toMatchObject({
      code: 'CLAUDE_INVALID_REQUEST',
      message: expect.not.stringContaining('must-never-appear-in-an-error'),
    });
    expect(() => fixture.query).toThrow('query not created');
  });

  it('fails closed when API-key mode does not report an environment API key', async () => {
    const fixture = makeAdapter({ apiKeySource: 'none' });

    await expect(fixture.adapter.createSession(context)).rejects.toMatchObject({
      code: 'CLAUDE_AUTHENTICATION_FAILED',
    });
    expect(fixture.query.inputOptions.env).toBeDefined();
    expect(fixture.query.inputOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(fixture.query.inputOptions.abortController?.signal.aborted).toBe(true);
    expect(fixture.events).toContainEqual(expect.objectContaining({
      kind: 'provider-error',
      code: 'CLAUDE_AUTHENTICATION_FAILED',
    }));
  });

  it('uses existing non-claude.ai CLI authentication without reading credentials', async () => {
    const fixture = makeAdapter({
      policy: {
        ...enabledPolicy,
        authenticationPath: 'existing-cli-environment',
      },
      apiKeySource: 'none',
      account: { apiProvider: 'bedrock' },
    });

    await expect(fixture.adapter.createSession(context)).resolves.toMatchObject({
      providerSessionId,
    });
    expect(fixture.query.inputOptions.env).toBeDefined();
    expect(fixture.query.inputOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    await fixture.adapter.dispose();
  });

  it('fails closed for ambiguous none auth and requires approved login mode for first-party OAuth', async () => {
    const ambiguous = makeAdapter({
      policy: { ...enabledPolicy, authenticationPath: 'existing-cli-environment' },
      apiKeySource: 'none',
    });
    await expect(ambiguous.adapter.createSession(context)).rejects.toMatchObject({
      code: 'CLAUDE_AUTHENTICATION_FAILED',
    });

    const wrongMode = makeAdapter({
      policy: { ...enabledPolicy, authenticationPath: 'existing-cli-environment' },
      apiKeySource: 'none',
      account: {
        apiProvider: 'firstParty',
        subscriptionType: 'pro',
        email: 'must-not-leave-adapter@example.test',
      },
    });
    await expect(wrongMode.adapter.createSession(context)).rejects.toMatchObject({
      code: 'CLAUDE_AUTHENTICATION_FAILED',
      message: expect.not.stringContaining('example.test'),
    });

    const approved = makeAdapter({
      policy: {
        ...enabledPolicy,
        authenticationPath: 'existing-claude-ai-login',
        anthropicThirdPartyApproval: true,
      },
      apiKeySource: 'none',
      account: {
        apiProvider: 'firstParty',
        subscriptionType: 'pro',
        email: 'must-not-leave-adapter@example.test',
      },
    });
    await expect(approved.adapter.createSession(context)).resolves.toMatchObject({ providerSessionId });
    expect(JSON.stringify(approved.events)).not.toContain('example.test');
    expect(approved.query.inputOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    await approved.adapter.dispose();
  });

  it('lists SDK models and applies model and permission settings', async () => {
    const fixture = makeAdapter();
    await start(fixture);

    await expect(fixture.adapter.listModels()).resolves.toEqual([
      {
        id: 'sonnet',
        displayName: 'Claude Sonnet',
        description: 'Balanced model',
        supportsReasoning: true,
        isDefault: true,
      },
    ]);
    await expect(fixture.adapter.setSettings({
      sessionId: context.sessionId,
      providerSessionId,
      model: 'opus',
      permissionPreset: 'full-access',
    })).resolves.toMatchObject({ model: 'opus', permissionPreset: 'full-access' });
    expect(fixture.query.models).toEqual(['opus']);
    expect(fixture.query.permissionModes).toEqual(['bypassPermissions']);
    await fixture.adapter.dispose();
  });

  it('normalizes assistant text, reasoning, tool calls/results, and turn completion', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    const inputIterator = fixture.query.input[Symbol.asyncIterator]();
    await fixture.adapter.submit({
      sessionId: context.sessionId,
      providerSessionId,
      turnId: 'turn-1',
      commandId: 'command-1',
      prompt: 'Inspect the project',
    });
    const submitted = await inputIterator.next();
    const clientUuid = submitted.value!.uuid as string;

    fixture.query.emit({
      type: 'assistant',
      uuid: 'assistant-wire-1',
      session_id: providerSessionId,
      user_message_uuid: clientUuid,
      parent_tool_use_id: null,
      message: {
        id: 'provider-turn-1',
        content: [
          { type: 'thinking', thinking: 'checking architecture' },
          { type: 'text', text: 'Never print sk-ant-this-must-not-persist' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/main.ts' } },
        ],
      },
    });
    fixture.query.emit({
      type: 'user',
      uuid: 'tool-result-1',
      session_id: providerSessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ANTHROPIC_API_KEY=secret' }],
      },
    });
    fixture.query.emit({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: providerSessionId,
      user_message_uuid: clientUuid,
      user_message_uuids: [clientUuid],
      is_error: false,
    });

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({
        kind: 'turn-finished',
        turnId: 'turn-1',
        outcome: 'completed',
      }));
    });
    const transcript = fixture.events
      .filter((event): event is Extract<AgentProviderEvent, { kind: 'transcript' }> => event.kind === 'transcript')
      .map((event) => event.item);
    expect(transcript.map((item) => item.kind)).toEqual([
      'user-message',
      'reasoning',
      'assistant-message',
      'tool-call',
      'tool-result',
    ]);
    expect(JSON.stringify(transcript)).not.toContain('sk-ant-this-must-not-persist');
    expect(JSON.stringify(transcript)).not.toContain('ANTHROPIC_API_KEY=secret');
    expect(transcript.find((item) => item.kind === 'tool-result')?.text).toBe('Read completed.');
    await fixture.adapter.dispose();
  });

  it('bridges permission prompts without putting raw tool input in events', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    await fixture.adapter.submit({
      sessionId: context.sessionId,
      providerSessionId,
      turnId: 'turn-approval',
      commandId: 'command-approval',
      prompt: 'Run the requested check',
    });
    const permissionController = new AbortController();
    const permission = fixture.query.inputOptions.canUseTool!(
      'Bash',
      { command: 'curl -H "x-api-key: sk-ant-secret" example.test' },
      {
        signal: permissionController.signal,
        toolUseID: 'tool-secret',
        requestId: 'approval-1',
        title: 'Run command containing sk-ant-secret',
        description: 'ANTHROPIC_API_KEY=secret',
      },
    );

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({
        kind: 'approval-requested',
        providerRequestId: 'approval-1',
        risk: 'danger',
        title: 'Claude requests Bash',
      }));
    });
    expect(JSON.stringify(fixture.events)).not.toContain('sk-ant-secret');
    expect(JSON.stringify(fixture.events)).not.toContain('ANTHROPIC_API_KEY=secret');

    await fixture.adapter.resolveApproval({
      sessionId: context.sessionId,
      providerSessionId,
      providerRequestId: 'approval-1',
      decision: 'allow',
    });
    await expect(permission).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-secret',
      updatedInput: { command: expect.stringContaining('curl') },
    });
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'session-state', state: 'working' }));
    await fixture.adapter.dispose();
  });

  it('publishes native subagent lifecycle events', async () => {
    const fixture = makeAdapter();
    await start(fixture);

    fixture.query.emit({
      type: 'system',
      subtype: 'task_started',
      uuid: 'task-start',
      session_id: providerSessionId,
      task_id: 'child-1',
      subagent_type: 'Explore',
      description: 'inspect',
    });
    fixture.query.emit({
      type: 'system',
      subtype: 'task_progress',
      uuid: 'task-progress',
      session_id: providerSessionId,
      task_id: 'child-1',
      description: 'inspect',
      summary: 'Reviewing modules',
    });
    fixture.query.emit({
      type: 'system',
      subtype: 'task_notification',
      uuid: 'task-done',
      session_id: providerSessionId,
      task_id: 'child-1',
      status: 'completed',
      summary: 'done',
    });

    await vi.waitFor(() => {
      const children = fixture.events.filter((event) => event.kind === 'native-subagent');
      expect(children).toEqual([
        expect.objectContaining({ providerChildId: 'child-1', title: 'Claude Explore', state: 'starting' }),
        expect.objectContaining({ providerChildId: 'child-1', state: 'working' }),
        expect.objectContaining({ providerChildId: 'child-1', state: 'done' }),
      ]);
    });
    await fixture.adapter.dispose();
  });

  it('interrupts the active turn exactly once', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    await fixture.adapter.submit({
      sessionId: context.sessionId,
      providerSessionId,
      turnId: 'turn-interrupt',
      commandId: 'command-interrupt',
      prompt: 'Keep working',
    });

    await fixture.adapter.interrupt(context.sessionId, providerSessionId);
    fixture.query.emit({
      type: 'result',
      subtype: 'error_during_execution',
      uuid: 'late-result',
      session_id: providerSessionId,
      is_error: true,
      terminal_reason: 'aborted_tools',
    });

    await vi.waitFor(() => {
      const finished = fixture.events.filter((event) =>
        event.kind === 'turn-finished' && event.turnId === 'turn-interrupt');
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ outcome: 'interrupted' });
    });
    expect(fixture.query.interruptCount).toBe(1);
    await fixture.adapter.dispose();
  });

  it('reconciles deterministic submitted UUIDs from provider history', async () => {
    const live = makeAdapter();
    await start(live);
    const inputIterator = live.query.input[Symbol.asyncIterator]();
    await live.adapter.submit({
      sessionId: context.sessionId,
      providerSessionId,
      turnId: 'turn-history',
      commandId: 'command-history',
      prompt: 'Persist me',
    });
    const clientUuid = (await inputIterator.next()).value!.uuid as string;
    await live.adapter.dispose();

    const recovered = makeAdapter({
      historyReader: async () => [{
        type: 'user',
        uuid: clientUuid,
        session_id: providerSessionId,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'user', content: 'Persist me' },
      }],
    });
    await expect(recovered.adapter.reconcile({
      sessionId: context.sessionId,
      providerSessionId,
      unsettledCommands: [
        { commandId: 'command-history', idempotencyKey: 'one', type: 'agent.submit' },
        { commandId: 'command-never-sent', idempotencyKey: 'two', type: 'agent.submit' },
      ],
    })).resolves.toMatchObject({
      commands: [
        { commandId: 'command-history', state: 'applied' },
        { commandId: 'command-never-sent', state: 'not-applied' },
      ],
      transcriptItems: [expect.objectContaining({ kind: 'user-message', text: 'Persist me' })],
    });
  });

  it('aborts and closes a stuck SDK stream within a bounded shutdown', async () => {
    const fixture = makeAdapter({ endOnClose: false });
    await start(fixture);
    const signal = fixture.query.inputOptions.abortController!.signal;

    await expect(fixture.adapter.disposeSession(context.sessionId, providerSessionId)).resolves.toBeUndefined();
    await expect(fixture.adapter.disposeSession(context.sessionId, providerSessionId)).resolves.toBeUndefined();

    expect(signal.aborted).toBe(true);
    expect(fixture.query.closeCount).toBe(1);
  });

  it('deactivates every SDK query while keeping the adapter reusable', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    const firstQuery = fixture.query;
    const firstSignal = firstQuery.inputOptions.abortController!.signal;

    await fixture.adapter.deactivate();

    expect(firstSignal.aborted).toBe(true);
    expect(firstQuery.closeCount).toBe(1);
    await expect(fixture.adapter.resumeSession({
      ...context,
      sessionId: 'agent-session-2',
      providerSessionId,
    })).resolves.toMatchObject({ sessionId: 'agent-session-2', providerSessionId });
    expect(fixture.query).not.toBe(firstQuery);
    expect(fixture.query.inputOptions.resume).toBe(providerSessionId);
    await fixture.adapter.dispose();
  });
});

describe('Claude error classification', () => {
  it.each([
    ['authentication_failed', 'CLAUDE_AUTHENTICATION_FAILED'],
    ['oauth_org_not_allowed', 'CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED'],
    ['rate_limit', 'CLAUDE_RATE_LIMITED'],
    ['overloaded', 'CLAUDE_OVERLOADED'],
    ['model_not_found', 'CLAUDE_MODEL_NOT_FOUND'],
  ] as const)('maps %s to a stable non-secret code', (input, expected) => {
    const error = classifyClaudeProviderError(input);
    expect(error).toBeInstanceOf(ClaudeProviderError);
    expect(error.code).toBe(expected);
    expect(error.message.length).toBeGreaterThan(0);
  });
});
