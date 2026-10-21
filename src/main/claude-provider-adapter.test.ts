import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentProviderEvent, ProviderSessionContext } from './agent-provider-adapter';
import {
  CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION,
  ClaudeProviderAdapter,
  ClaudeProviderError,
  MemoryClaudeProviderEnablementStore,
  classifyClaudeAuthentication,
  classifyClaudeProviderError,
  recordedClaudeChange,
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
  readonly flagSettings: Array<{ readonly effortLevel?: string | null }> = [];
  closeCount = 0;
  interruptCount = 0;
  interruptReceipt: { still_queued?: readonly string[] } | undefined;
  returnImpl: () => Promise<void> = async () => undefined;
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
    emitInitialization = true,
  ) {
    this.input = input;
    this.inputOptions = options;
    this.endOnClose = endOnClose;
    this.account = account;
    if (emitInitialization) this.emit({
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

  async applyFlagSettings(settings: { readonly effortLevel?: string | null }): Promise<void> {
    this.flagSettings.push(settings);
  }

  async initializationResult(): Promise<unknown> {
    return { models: this.supported, ...(this.account ? { account: this.account } : {}) };
  }

  /** What the real CLI reports after merging the user's settings (sdk.mjs get_settings). */
  applied: { readonly model?: string; readonly effort?: string | null } = { model: 'claude-opus-5-5', effort: 'xhigh' };

  async getSettings(): Promise<unknown> {
    // Launch options win over the user's settings, as in the CLI.
    return { effective: {}, sources: [], applied: {
      model: this.inputOptions.model ?? this.applied.model, effort: this.inputOptions.effort ?? this.applied.effort,
    } };
  }

  async supportedModels(): Promise<typeof this.supported> {
    return this.supported;
  }

  close(): void {
    this.closeCount += 1;
    if (this.endOnClose) this.end();
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    await this.returnImpl();
    return { done: true, value: undefined };
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
  readonly emitInitialization?: boolean;
  readonly shutdownTimeoutMs?: number;
  readonly historyReader?: NonNullable<ConstructorParameters<typeof ClaudeProviderAdapter>[0]>['historyReader'];
  readonly now?: () => Date;
  readonly enableTaskTools?: boolean;
} = {}): {
  readonly adapter: ClaudeProviderAdapter;
  readonly query: FakeClaudeQuery;
  readonly queries: FakeClaudeQuery[];
  readonly events: AgentProviderEvent[];
} {
  let fakeQuery: FakeClaudeQuery | undefined;
  const queries: FakeClaudeQuery[] = [];
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
        options.emitInitialization,
      );
      queries.push(fakeQuery);
      return fakeQuery;
    },
    extensionCommand: async () => '[]',
    historyReader: options.historyReader,
    initializationTimeoutMs: 100,
    operationTimeoutMs: 100,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 20,
    now: options.now ?? (() => new Date('2026-09-04T00:00:00.000Z')),
    // Deltas flush only at boundaries, as in replay, so assertions see deterministic rows.
    deltaCoalescer: { schedule: () => undefined, cancel: () => undefined },
    ...(options.enableTaskTools === undefined ? {} : { enableTaskTools: options.enableTaskTools }),
  });
  adapter.subscribe((event) => events.push(event));
  return {
    adapter,
    get query() {
      if (!fakeQuery) throw new Error('query not created');
      return fakeQuery;
    },
    queries,
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

describe('Claude executable version gate', () => {
  async function probeWithVersion(version: string): Promise<boolean> {
    const adapter = new ClaudeProviderAdapter({
      enablementStore: new MemoryClaudeProviderEnablementStore(enabledPolicy),
      resolveExecutable: async () => executablePath,
      readExecutableVersion: async () => version,
    });
    return (await adapter.probe()).available;
  }

  it('accepts an installed CLI newer than the minimum supported version', async () => {
    await expect(probeWithVersion('2.1.261')).resolves.toBe(true);
    await expect(probeWithVersion('2.2.0')).resolves.toBe(true);
    await expect(probeWithVersion(CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION)).resolves.toBe(true);
  });

  it('rejects older, next-major, prerelease and unreadable versions', async () => {
    await expect(probeWithVersion('2.1.259')).resolves.toBe(false);
    await expect(probeWithVersion('3.0.0')).resolves.toBe(false);
    await expect(probeWithVersion('2.1.261-rc.1')).resolves.toBe(false);
    await expect(probeWithVersion('unknown')).resolves.toBe(false);
  });

  it('explains why an incompatible executable version was rejected', async () => {
    const adapter = new ClaudeProviderAdapter({
      enablementStore: new MemoryClaudeProviderEnablementStore(enabledPolicy),
      resolveExecutable: async () => executablePath,
      readExecutableVersion: async () => '2.1.259',
    });

    const probe = await adapter.probe();

    expect(probe.available).toBe(false);
    expect(probe.unavailableReason).toContain('CLAUDE_EXECUTABLE_INVALID');
    expect(probe.unavailableReason).toContain('2.1.259');
    expect(probe.unavailableReason).toContain(CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION);
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

  it('launches a CLI that auto-updated after review within the supported range', async () => {
    const reviewedExecutable = await realpath(process.execPath);
    const queryFactory = vi.fn(() => {
      throw new Error('query reached');
    });
    const adapter = new ClaudeProviderAdapter({
      enablementStore: new MemoryClaudeProviderEnablementStore(enabledPolicy),
      queryFactory,
      readExecutableVersion: async () => '2.1.289',
    });
    adapter.setLaunchDescriptor({
      providerId: 'claude',
      protocol: 'claude-agent-sdk',
      executablePath: reviewedExecutable,
      executableVersion: CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION,
      argv: [
        '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
        '--permission-prompt-tool', 'stdio',
      ],
      environmentVariableNames: [
        'PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'ANTHROPIC_API_KEY',
      ],
      reviewDigest: 'a'.repeat(64),
    });

    await adapter.createSession(context).catch(() => undefined);
    expect(queryFactory).toHaveBeenCalled();
  });

  it('fails before SDK process creation when the CLI updates outside the supported range', async () => {
    const reviewedExecutable = await realpath(process.execPath);
    const queryFactory = vi.fn(() => {
      throw new Error('query must not start');
    });
    const adapter = new ClaudeProviderAdapter({
      enablementStore: new MemoryClaudeProviderEnablementStore(enabledPolicy),
      queryFactory,
      readExecutableVersion: async () => '3.0.0',
    });
    adapter.setLaunchDescriptor({
      providerId: 'claude',
      protocol: 'claude-agent-sdk',
      executablePath: reviewedExecutable,
      executableVersion: CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION,
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
  it('removes the complete tool catalog for planning and carries the exact managed reasoning and environment', async () => {
    const fixture = makeAdapter();
    await fixture.adapter.createSession({ ...context, permissionPreset: 'plan', toolsDisabled: true, managedExecution: true,
      reasoningEffort: 'high', environment: { EZTERMINAL_RUN_ID: 'R', PORT: '4001' } });
    expect(fixture.query.inputOptions).toMatchObject({ tools: [], disallowedTools: ['*'], settingSources: [], mcpServers: {}, plugins: [], agents: {},
      permissionMode: 'plan', effort: 'high', env: { EZTERMINAL_RUN_ID: 'R', PORT: '4001' } });
    await expect(fixture.query.inputOptions.canUseTool!('Bash', { command: 'echo unsafe' }, { signal: new AbortController().signal, toolUseID: 'blocked', requestId: 'request-blocked' })).resolves.toMatchObject({ behavior: 'deny' });
    await fixture.adapter.dispose();
    const worker = makeAdapter();
    await worker.adapter.createSession({ ...context, managedExecution: true, reasoningEffort: 'high', environment: { PORT: '4002' } });
    expect(worker.query.inputOptions).toMatchObject({ disallowedTools: ['Agent', 'Task'], effort: 'high', env: { PORT: '4002' } });
    expect(worker.query.inputOptions).not.toHaveProperty('tools');
    await worker.adapter.dispose();
  });
  it('creates and resumes through the SDK using an absolute executable and allowlisted environment', async () => {
    const created = makeAdapter();
    const handle = await created.adapter.createSession(context);

    expect(handle).toEqual({
      sessionId: context.sessionId,
      providerSessionId,
      model: 'sonnet',
      reasoningEffort: 'xhigh',
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
        timeout: 300_000,
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

  it('opens an approved native subscription session from zero-turn control evidence before system/init', async () => {
    const fixture = makeAdapter({ emitInitialization: false, policy: { ...enabledPolicy, authenticationPath: 'existing-claude-ai-login', anthropicThirdPartyApproval: true }, account: { apiProvider: 'firstParty', subscriptionType: 'pro' } });
    await expect(fixture.adapter.createSession(context)).resolves.toMatchObject({ providerSessionId });
    expect(fixture.events.some(event => event.kind === 'turn-started' || event.kind === 'transcript')).toBe(false);
    await fixture.adapter.dispose();
  });

  it('fails closed on ambiguous zero-turn auth and rechecks a conflicting later init source', async () => {
    const policy = { ...enabledPolicy, authenticationPath: 'existing-claude-ai-login' as const, anthropicThirdPartyApproval: true };
    const ambiguous = makeAdapter({ emitInitialization: false, policy, account: { apiProvider: 'firstParty' } });
    await expect(ambiguous.adapter.createSession(context)).rejects.toMatchObject({ code: 'CLAUDE_AUTHENTICATION_FAILED' });
    await ambiguous.adapter.dispose();
    const fixture = makeAdapter({ emitInitialization: false, policy, account: { apiProvider: 'firstParty', subscriptionType: 'pro' } });
    await fixture.adapter.createSession(context);
    fixture.query.emit({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'session-state', state: 'failed' }));
    expect(fixture.query.inputOptions.abortController?.signal.aborted).toBe(true);
    await fixture.adapter.dispose();
  });

  it('reports the model and effort the CLI applies to a session on provider defaults', async () => {
    const fixture = makeAdapter();
    const { model: unused, ...defaults } = context;
    void unused;
    await expect(fixture.adapter.createSession(defaults)).resolves.toMatchObject({ model: 'claude-opus-5-5', reasoningEffort: 'xhigh' });
    // The CLI already runs at that effort, so the first message does not re-apply it.
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-1', commandId: 'command-1', prompt: 'Hi', reasoningEffort: 'xhigh' });
    expect(fixture.query.flagSettings).toEqual([]);
    await fixture.adapter.dispose();
  });

  it('keeps explicitly chosen settings over what the CLI defaults to', async () => {
    const fixture = makeAdapter();
    await expect(fixture.adapter.createSession({ ...context, reasoningEffort: 'low' })).resolves.toMatchObject({ model: 'sonnet', reasoningEffort: 'low' });
    await fixture.adapter.dispose();
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
    const launched = fixture.query;
    // Every session with tools may later switch to Full access: the CLI accepts bypassPermissions
    // only when launched with the flag. The mode itself is still the chosen one.
    expect(launched.inputOptions).toMatchObject({ permissionMode: 'default', allowDangerouslySkipPermissions: true });
    await expect(fixture.adapter.setSettings({
      sessionId: context.sessionId,
      providerSessionId,
      model: 'opus',
      permissionPreset: 'full-access',
    })).resolves.toMatchObject({ model: 'opus', permissionPreset: 'full-access' });
    // Full access takes effect at once, in the same provider session.
    expect(launched.permissionModes).toEqual(['bypassPermissions']);
    expect(launched.closeCount).toBe(0);
    expect(fixture.queries).toHaveLength(1);
    await fixture.adapter.dispose();
  });

  it('keeps a session without tools unarmed', async () => {
    const fixture = makeAdapter();
    await fixture.adapter.createSession({ ...context, toolsDisabled: true });
    expect(fixture.query.inputOptions).toMatchObject({ allowDangerouslySkipPermissions: false });
    await fixture.adapter.dispose();
  });

  // Entering plan straight from bypassPermissions makes Claude ask for read-only commands it would
  // otherwise run while planning (real CLI 2.1.289 probe); passing through default keeps that.
  it('leaves Full access through default before entering plan', async () => {
    const fixture = makeAdapter();
    await fixture.adapter.createSession({ ...context, permissionPreset: 'full-access' });
    await fixture.adapter.setSettings({ sessionId: context.sessionId, providerSessionId, permissionPreset: 'plan' });
    expect(fixture.query.permissionModes).toEqual(['default', 'plan']);
    await fixture.adapter.setSettings({ sessionId: context.sessionId, providerSessionId, permissionPreset: 'standard' });
    await fixture.adapter.setSettings({ sessionId: context.sessionId, providerSessionId, permissionPreset: 'plan' });
    expect(fixture.query.permissionModes).toEqual(['default', 'plan', 'default', 'plan']);
    await fixture.adapter.dispose();
  });

  // The CLI does not answer a mode change while one of its permission requests is open.
  it('refuses a permission change while an approval is waiting', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-wait', commandId: 'command-wait', prompt: 'Go' });
    const pending = fixture.query.inputOptions.canUseTool!('Bash', { command: 'rm notes.md' }, {
      signal: new AbortController().signal, toolUseID: 'toolu_wait', requestId: 'wait',
    });
    await vi.waitFor(() => expect(fixture.events.filter((event) => event.kind === 'approval-requested')).toHaveLength(1));
    await expect(fixture.adapter.setSettings({ sessionId: context.sessionId, providerSessionId, permissionPreset: 'full-access' }))
      .rejects.toMatchObject({ code: 'CLAUDE_INVALID_REQUEST' });
    expect(fixture.query.permissionModes).toEqual([]);
    await fixture.adapter.resolveApproval({ sessionId: context.sessionId, providerSessionId, providerRequestId: 'wait', decision: 'deny' });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    await fixture.adapter.dispose();
  });

  it('applies a changed reasoning effort before the next message', async () => {
    const fixture = makeAdapter();
    await fixture.adapter.createSession({ ...context, reasoningEffort: 'high' });
    expect(fixture.query.inputOptions).toMatchObject({ effort: 'high' });
    const send = (id: string, reasoningEffort: string) => fixture.adapter.submit({
      sessionId: context.sessionId, providerSessionId, turnId: `turn-${id}`, commandId: `command-${id}`, prompt: 'Go', reasoningEffort,
    });
    await send('1', 'high');
    await send('2', 'max');
    await send('3', 'max');
    expect(fixture.query.flagSettings).toEqual([{ effortLevel: 'max' }]);
    await fixture.adapter.dispose();
  });

  it('switches an armed Full access session in place, without relaunching', async () => {
    const fixture = makeAdapter();
    await fixture.adapter.createSession({ ...context, permissionPreset: 'full-access' });
    expect(fixture.query.inputOptions).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    await fixture.adapter.setSettings({ sessionId: context.sessionId, providerSessionId, permissionPreset: 'standard' });
    await fixture.adapter.setSettings({ sessionId: context.sessionId, providerSessionId, permissionPreset: 'full-access' });
    expect(fixture.queries).toHaveLength(1);
    expect(fixture.query.permissionModes).toEqual(['default', 'bypassPermissions']);
    await fixture.adapter.dispose();
  });

  it('sends SDK image blocks and quoted reply context', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    const inputIterator = fixture.query.input[Symbol.asyncIterator]();
    await fixture.adapter.submit({
      sessionId: context.sessionId, providerSessionId, turnId: 'turn-context', commandId: 'command-context', prompt: 'Review',
      context: {
        replyTo: { messageId: 'earlier', text: 'Prior answer' },
        attachments: [{ id: 'a', name: 'screen.png', kind: 'image', mimeType: 'image/png', data: 'YWJj' }],
      },
    });
    const submitted = await inputIterator.next();
    expect(submitted.value?.message.content).toEqual([
      { type: 'text', text: expect.stringContaining('Prior answer') },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
    ]);
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
    // The runtime already persisted the submitted prompt; the adapter does not echo it.
    expect(transcript.map((item) => item.kind)).toEqual([
      'reasoning',
      'assistant-message',
      'tool-call',
      'tool-result',
    ]);
    expect(JSON.stringify(transcript)).toContain('sk-ant-this-must-not-persist');
    expect(JSON.stringify(transcript)).toContain('ANTHROPIC_API_KEY=secret');
    expect(transcript.find((item) => item.kind === 'tool-result')?.text).toBe('ANTHROPIC_API_KEY=secret');
    expect(transcript.find((item) => item.kind === 'tool-call')?.text).toContain('src/main.ts');
    expect(transcript.find((item) => item.kind === 'reasoning')?.payload).toEqual({ v: 1, type: 'reasoning' });
    expect(transcript.find((item) => item.kind === 'assistant-message')?.messageId).toBe('claude_msg:provider-turn-1:1');
    expect(transcript.find((item) => item.kind === 'tool-call')?.payload).toEqual({
      v: 1, type: 'tool', callId: 'tool-1', name: 'Read', category: 'read', phase: 'call', status: 'running', target: 'src/main.ts',
    });
    expect(transcript.find((item) => item.kind === 'tool-result')?.payload).toEqual({
      v: 1, type: 'tool', callId: 'tool-1', name: 'Read', category: 'read', phase: 'result', status: 'completed',
    });
    await fixture.adapter.dispose();
  });

  it('bridges permission prompts with a structured request built from the tool input only', async () => {
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

    // Approval detail is local and archive-redacted (docs/design/agent-collaboration.md),
    // so the command is shown; the SDK's own title/description strings are not used.
    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({
        kind: 'approval-requested',
        providerRequestId: 'approval-1',
        risk: 'danger',
        title: 'Run command',
        detail: 'curl -H "x-api-key: sk-ant-secret" example.test',
        request: { v: 1, callId: 'tool-secret', kind: 'command', command: 'curl -H "x-api-key: sk-ant-secret" example.test' },
      }));
    });
    expect(JSON.stringify(fixture.events)).not.toContain('Run command containing');
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

  it('publishes Agent-tool subagents only and routes their messages to them', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    const parentMessage = { type: 'assistant', uuid: 'agent-call', session_id: providerSessionId, parent_tool_use_id: null,
      message: { id: 'msg_parent', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'inspect', subagent_type: 'Explore', prompt: 'Read the modules.' } }] } };
    fixture.query.emit(parentMessage);
    // A background shell command is a task too, but not a subagent.
    fixture.query.emit({ type: 'system', subtype: 'task_started', uuid: 'bash-start', session_id: providerSessionId, task_id: 'b1234abcd', task_type: 'local_bash', description: 'sleep' });
    fixture.query.emit({ type: 'system', subtype: 'task_started', uuid: 'task-start', session_id: providerSessionId, task_id: 'a0123456789abcdef',
      tool_use_id: 'toolu_agent', task_type: 'local_agent', subagent_type: 'Explore', description: 'inspect', prompt: 'Read the modules.', is_backgrounded: true });
    fixture.query.emit({ type: 'assistant', uuid: 'child-call', session_id: providerSessionId, parent_tool_use_id: 'toolu_agent',
      message: { id: 'msg_child', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.ts' } }] } });
    fixture.query.emit({ type: 'user', uuid: 'child-result', session_id: providerSessionId, parent_tool_use_id: 'toolu_agent',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'export const a = 1;' }] } });
    fixture.query.emit({ type: 'assistant', uuid: 'child-text', session_id: providerSessionId, parent_tool_use_id: 'toolu_agent',
      message: { id: 'msg_child_2', content: [{ type: 'text', text: 'a.ts exports a.' }] } });
    fixture.query.emit({ type: 'system', subtype: 'task_progress', uuid: 'task-progress', session_id: providerSessionId, task_id: 'a0123456789abcdef', description: 'inspect', summary: 'Reviewing modules' });
    fixture.query.emit({ type: 'system', subtype: 'task_notification', uuid: 'bash-done', session_id: providerSessionId, task_id: 'b1234abcd', status: 'completed', summary: 'sleep done' });
    fixture.query.emit({ type: 'system', subtype: 'task_notification', uuid: 'task-done', session_id: providerSessionId, task_id: 'a0123456789abcdef', status: 'completed', summary: 'a.ts exports a.' });

    await vi.waitFor(() => {
      const children = fixture.events.filter((event) => event.kind === 'native-subagent');
      expect(children).toEqual([
        expect.objectContaining({ providerChildId: 'a0123456789abcdef', title: 'inspect', subagentType: 'Explore', toolUseId: 'toolu_agent',
          instruction: 'Read the modules.', background: true, state: 'starting' }),
        expect.objectContaining({ providerChildId: 'a0123456789abcdef', state: 'working', summary: 'Reviewing modules' }),
        expect.objectContaining({ providerChildId: 'a0123456789abcdef', state: 'done', summary: 'a.ts exports a.' }),
      ]);
    });
    const routed = fixture.events.filter((event): event is Extract<AgentProviderEvent, { kind: 'transcript' }> => event.kind === 'transcript' && event.providerChildId !== undefined);
    expect(routed.map((event) => [event.item.kind, event.providerChildId, event.item.turnId])).toEqual([
      ['tool-call', 'a0123456789abcdef', undefined],
      ['tool-result', 'a0123456789abcdef', undefined],
      ['assistant-message', 'a0123456789abcdef', undefined],
    ]);
    // Nothing from inside the subagent lands in the parent.
    expect(fixture.events.some((event) => event.kind === 'transcript' && !event.providerChildId && /Read|exports/u.test(event.item.text) && event.item.kind !== 'tool-call')).toBe(false);
    expect(fixture.events.some((event) => event.kind === 'transcript' && event.item.kind === 'child-summary')).toBe(false);
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

  it('ends a user-interrupted turn as interrupted without a provider failure (claude-interrupt L29-L32)', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    const inputIterator = fixture.query.input[Symbol.asyncIterator]();
    await fixture.adapter.submit({
      sessionId: context.sessionId, providerSessionId, turnId: 'turn-stop', commandId: 'command-stop', prompt: 'Write an essay',
    });
    const clientUuid = (await inputIterator.next()).value!.uuid as string;
    fixture.query.interruptReceipt = { still_queued: [] };
    await fixture.adapter.interrupt(context.sessionId, providerSessionId);
    fixture.query.emit({
      type: 'user', uuid: 'synthetic-interrupt', session_id: providerSessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    });
    fixture.query.emit({
      type: 'result', subtype: 'error_during_execution', uuid: 'aborted-result', session_id: providerSessionId,
      user_message_uuid: clientUuid, user_message_uuids: [clientUuid], is_error: true, terminal_reason: 'aborted_streaming',
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    });
    fixture.query.emit({ type: 'command_lifecycle', command_uuid: clientUuid, state: 'cancelled', uuid: 'lifecycle', session_id: providerSessionId });
    // Messages are handled in order, so this marker proves the result was processed.
    fixture.query.emit({ type: 'system', subtype: 'task_started', uuid: 'marker', session_id: providerSessionId, task_id: 'marker', task_type: 'local_agent' });

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'native-subagent', providerChildId: 'marker' }));
    });
    expect(fixture.events.filter((event) => event.kind === 'session-state').at(-1)).toMatchObject({ state: 'interrupted' });
    expect(fixture.events.filter((event) => event.kind === 'turn-finished')).toEqual([
      expect.objectContaining({ turnId: 'turn-stop', outcome: 'interrupted' }),
    ]);
    expect(fixture.events.filter((event) => event.kind === 'provider-error')).toEqual([]);
    expect(fixture.events).not.toContainEqual(expect.objectContaining({ kind: 'session-state', state: 'failed' }));
    await fixture.adapter.dispose();
  });

  it('streams text deltas under the final block messageId and flushes them before any other row', async () => {
    let clock = Date.parse('2026-09-04T00:00:00.000Z');
    const fixture = makeAdapter({ now: () => new Date(clock) });
    await start(fixture);
    const inputIterator = fixture.query.input[Symbol.asyncIterator]();
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-stream', commandId: 'command-stream', prompt: 'Explain' });
    const clientUuid = (await inputIterator.next()).value!.uuid as string;
    const stream = (event: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
      fixture.query.emit({ type: 'stream_event', event, parent_tool_use_id: null, uuid: `stream-${String(clock)}`, session_id: providerSessionId, ...extra });
    };
    fixture.query.emit({ type: 'command_lifecycle', command_uuid: clientUuid, state: 'started', uuid: 'started', session_id: providerSessionId });
    stream({ type: 'message_start', message: { id: 'msg_1' } }, { user_message_uuid: clientUuid, user_message_uuids: [clientUuid] });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } });
    // Let the block start be consumed at the old clock before time passes.
    await new Promise((resolve) => setImmediate(resolve));
    clock += 1_500;
    fixture.query.emit({ type: 'assistant', uuid: 'a-0', session_id: providerSessionId, parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'thinking', thinking: '' }] } });
    stream({ type: 'content_block_stop', index: 0 });
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } });
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '\n\n' } });
    // A tool result interleaving with a streaming block must not overtake the buffered text.
    fixture.query.emit({ type: 'user', uuid: 'r-0', session_id: providerSessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_earlier', content: 'ok' }] } });
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } });
    fixture.query.emit({ type: 'assistant', uuid: 'a-1', session_id: providerSessionId, parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello\n\nworld' }] } });
    stream({ type: 'content_block_stop', index: 1 });
    stream({ type: 'message_stop' });
    fixture.query.emit({ type: 'result', subtype: 'success', uuid: 'result', session_id: providerSessionId, user_message_uuid: clientUuid, is_error: false });

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'turn-finished', turnId: 'turn-stream', outcome: 'completed' }));
    });
    const transcript = fixture.events
      .filter((event): event is Extract<AgentProviderEvent, { kind: 'transcript' }> => event.kind === 'transcript')
      .map((event) => event.item);
    expect(transcript.map(({ kind, text, isDelta, messageId, turnId }) => ({ kind, text, isDelta, messageId, turnId }))).toEqual([
      { kind: 'reasoning', text: '', isDelta: false, messageId: undefined, turnId: 'turn-stream' },
      { kind: 'assistant-message', text: 'Hello\n\n', isDelta: true, messageId: 'claude_msg:msg_1:1', turnId: 'turn-stream' },
      { kind: 'tool-result', text: 'ok', isDelta: false, messageId: undefined, turnId: 'turn-stream' },
      { kind: 'assistant-message', text: 'world', isDelta: true, messageId: 'claude_msg:msg_1:1', turnId: 'turn-stream' },
      { kind: 'assistant-message', text: 'Hello\n\nworld', isDelta: false, messageId: 'claude_msg:msg_1:1', turnId: 'turn-stream' },
    ]);
    expect(transcript[0]?.payload).toEqual({ v: 1, type: 'reasoning', durationMs: 1_500 });
    expect(new Set(transcript.map((item) => item.id)).size).toBe(transcript.length);
    await fixture.adapter.dispose();
  });

  it('keeps late text of an interrupted turn on that turn while the next one is queued', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    const inputIterator = fixture.query.input[Symbol.asyncIterator]();
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-a', commandId: 'command-a', prompt: 'First' });
    const uuidA = (await inputIterator.next()).value!.uuid as string;
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-b', commandId: 'command-b', prompt: 'Second' });
    const uuidB = (await inputIterator.next()).value!.uuid as string;
    fixture.query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } }, parent_tool_use_id: null,
      uuid: 's-a', session_id: providerSessionId, user_message_uuid: uuidA, user_message_uuids: [uuidA] });
    fixture.query.emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, parent_tool_use_id: null, uuid: 's-b', session_id: providerSessionId });
    fixture.query.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part' } }, parent_tool_use_id: null, uuid: 's-c', session_id: providerSessionId });
    await vi.waitFor(() => expect(fixture.events.some((event) => event.kind === 'turn-started' && event.turnId === 'turn-b')).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    fixture.query.interruptReceipt = { still_queued: [uuidB] };
    await fixture.adapter.interrupt(context.sessionId, providerSessionId);
    fixture.query.emit({ type: 'assistant', uuid: 'late', session_id: providerSessionId, parent_tool_use_id: null, message: { id: 'msg_a', content: [{ type: 'text', text: 'Partial' }] } });
    fixture.query.emit({ type: 'system', subtype: 'task_started', uuid: 'marker', session_id: providerSessionId, task_id: 'marker', task_type: 'local_agent' });

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'native-subagent', providerChildId: 'marker' }));
    });
    const texts = fixture.events
      .filter((event): event is Extract<AgentProviderEvent, { kind: 'transcript' }> => event.kind === 'transcript')
      .map(({ item }) => ({ text: item.text, turnId: item.turnId, isDelta: item.isDelta }));
    expect(texts).toEqual([
      { text: 'Part', turnId: 'turn-a', isDelta: true },
      { text: 'Partial', turnId: 'turn-a', isDelta: false },
    ]);
    expect(fixture.events.filter((event) => event.kind === 'turn-finished')).toEqual([
      expect.objectContaining({ turnId: 'turn-a', outcome: 'interrupted' }),
    ]);
    await fixture.adapter.dispose();
  });

  it('answers questions, approves plans in the chosen mode and denies with feedback', async () => {
    const fixture = makeAdapter();
    await fixture.adapter.createSession({ ...context, permissionPreset: 'plan' });
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-ask', commandId: 'command-ask', prompt: 'Ask' });
    const canUseTool = fixture.query.inputOptions.canUseTool!;
    const ask = (tool: string, input: Record<string, unknown>, id: string): ReturnType<typeof canUseTool> => canUseTool(tool, input, {
      signal: new AbortController().signal, toolUseID: `toolu_${id}`, requestId: id,
    });
    const questionInput = { questions: [{ question: 'Formal or casual?', header: 'Tone', multiSelect: false,
      options: [{ label: 'Formal', description: 'Polite' }, { label: 'Casual' }] }] };
    const question = ask('AskUserQuestion', questionInput, 'q');
    const plan = ask('ExitPlanMode', { plan: '# Plan\n- step', planFilePath: 'C:\\plans\\p.md' }, 'p');
    const write = ask('Write', { file_path: 'C:\\repo\\notes.md', content: 'one\ntwo\n' }, 'w');

    await vi.waitFor(() => expect(fixture.events.filter((event) => event.kind === 'approval-requested')).toHaveLength(3));
    expect(fixture.events.filter((event) => event.kind === 'approval-requested')).toEqual([
      expect.objectContaining({ providerRequestId: 'q', risk: 'read', title: 'Answer a question', detail: 'Formal or casual?',
        request: { v: 1, callId: 'toolu_q', kind: 'question', questions: [{ question: 'Formal or casual?', header: 'Tone', multiSelect: false,
          options: [{ label: 'Formal', description: 'Polite' }, { label: 'Casual' }] }] } }),
      expect.objectContaining({ providerRequestId: 'p', risk: 'write', title: 'Approve plan', detail: '# Plan',
        request: { v: 1, callId: 'toolu_p', kind: 'plan', markdown: '# Plan\n- step', filePath: 'C:\\plans\\p.md' } }),
      expect.objectContaining({ providerRequestId: 'w', risk: 'write', title: 'Edit notes.md', detail: 'C:\\repo\\notes.md',
        request: { v: 1, callId: 'toolu_w', kind: 'file-change', files: [{ path: 'C:\\repo\\notes.md', diff: '@@\n+one\n+two' }] } }),
    ]);

    const decide = (providerRequestId: string, decision: 'allow' | 'deny', response: NonNullable<Parameters<typeof fixture.adapter.resolveApproval>[0]['response']>) =>
      fixture.adapter.resolveApproval({ sessionId: context.sessionId, providerSessionId, providerRequestId, decision, response });
    await decide('q', 'allow', { kind: 'answers', answers: { 'Formal or casual?': 'Casual' } });
    await decide('p', 'allow', { kind: 'plan', mode: 'full-access' });
    await decide('w', 'deny', { kind: 'feedback', message: 'Put it under docs/ instead.' });

    await expect(question).resolves.toEqual({ behavior: 'allow', toolUseID: 'toolu_q',
      updatedInput: { ...questionInput, answers: { 'Formal or casual?': 'Casual' } } });
    await expect(plan).resolves.toMatchObject({ behavior: 'allow', updatedInput: { plan: '# Plan\n- step' } });
    await expect(write).resolves.toEqual({ behavior: 'deny', message: 'Put it under docs/ instead.', toolUseID: 'toolu_w' });
    // A plan approved with Full access runs the rest of the turn, and every later one, in bypass:
    // the session was launched able to switch, so nothing waits for a relaunch.
    expect(fixture.query.permissionModes).toEqual(['bypassPermissions']);
    await expect(fixture.adapter.setSettings({ sessionId: context.sessionId, providerSessionId })).resolves.toMatchObject({ permissionPreset: 'full-access' });
    expect(fixture.queries).toHaveLength(1);

    const planTurn = (await fixture.query.input[Symbol.asyncIterator]().next()).value as SDKUserMessage;
    fixture.query.emit({ type: 'result', subtype: 'success', uuid: 'result-ask', session_id: providerSessionId,
      user_message_uuid: planTurn.uuid, user_message_uuids: [planTurn.uuid], is_error: false });
    await vi.waitFor(() => expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'turn-finished', turnId: 'turn-ask' })));
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-next', commandId: 'command-next', prompt: 'Next' });
    expect(fixture.queries).toHaveLength(1);
    await fixture.adapter.dispose();
  });

  it('lets a plan turn nobody watches finish with its plan instead of waiting for approval', async () => {
    const fixture = makeAdapter();
    await fixture.adapter.createSession({ ...context, permissionPreset: 'plan' });
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-plan', commandId: 'command-plan', prompt: 'Plan it', attended: false });
    const plan = fixture.query.inputOptions.canUseTool!('ExitPlanMode', { plan: '# Plan\n- step' }, {
      signal: new AbortController().signal, toolUseID: 'toolu_plan', requestId: 'plan',
    });
    await expect(plan).resolves.toMatchObject({ behavior: 'deny', toolUseID: 'toolu_plan', message: expect.stringContaining('end your turn with the full plan') });
    const question = fixture.query.inputOptions.canUseTool!('AskUserQuestion', { questions: [{ question: 'Which file?', multiSelect: false, options: [{ label: 'a' }] }] }, {
      signal: new AbortController().signal, toolUseID: 'toolu_question', requestId: 'question',
    });
    await expect(question).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('state that assumption') });
    expect(fixture.events.some((event) => event.kind === 'approval-requested')).toBe(false);
    await fixture.adapter.dispose();
  });

  it('allows for this conversation with the CLI suggestions kept to the session, and stops asking for edits', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-session', commandId: 'command-session', prompt: 'Edit' });
    const write = fixture.query.inputOptions.canUseTool!('Write', { file_path: 'C:\\repo\\notes.md', content: 'one' }, {
      signal: new AbortController().signal, toolUseID: 'toolu_write', requestId: 'write',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' }],
    });
    await vi.waitFor(() => expect(fixture.events.some((event) => event.kind === 'approval-requested')).toBe(true));
    await fixture.adapter.resolveApproval({ sessionId: context.sessionId, providerSessionId, providerRequestId: 'write', decision: 'allow', response: { kind: 'session' } });
    await expect(write).resolves.toMatchObject({
      behavior: 'allow',
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
    });
    await fixture.adapter.dispose();
  });

  it('tracks TodoWrite lists and MultiEdit file counts in structured payloads', async () => {
    const fixture = makeAdapter();
    await start(fixture);
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId: 'turn-todo', commandId: 'command-todo', prompt: 'Track' });
    fixture.query.emit({ type: 'assistant', uuid: 'a-todo', session_id: providerSessionId, parent_tool_use_id: null, message: { id: 'msg_t', content: [
      { type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [
        { content: 'Read', status: 'completed', activeForm: 'Reading' },
        { content: 'Edit', status: 'in_progress', activeForm: 'Editing' },
      ] } },
      { type: 'tool_use', id: 'toolu_multi', name: 'MultiEdit', input: { file_path: 'C:\\repo\\a.ts', edits: [
        { old_string: 'a', new_string: 'b\nc' },
        { old_string: 'd\ne', new_string: 'f' },
      ] } },
    ] } });
    fixture.query.emit({ type: 'user', uuid: 'u-multi', session_id: providerSessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_multi', content: 'Applied 2 edits' }] } });
    fixture.query.emit({ type: 'system', subtype: 'task_started', uuid: 'marker', session_id: providerSessionId, task_id: 'marker', task_type: 'local_agent' });

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'native-subagent', providerChildId: 'marker' }));
    });
    const transcript = fixture.events
      .filter((event): event is Extract<AgentProviderEvent, { kind: 'transcript' }> => event.kind === 'transcript')
      .map((event) => event.item);
    expect(transcript.find((item) => item.kind === 'notice')).toMatchObject({
      text: '- [x] Read\n- [ ] Edit (in progress)',
      payload: { v: 1, type: 'todo', source: 'claude-todowrite', items: [
        { text: 'Read', status: 'completed', active: 'Reading' },
        { text: 'Edit', status: 'in_progress', active: 'Editing' },
      ] },
    });
    expect(transcript.find((item) => item.kind === 'tool-result')?.payload).toEqual({
      v: 1, type: 'tool', callId: 'toolu_multi', name: 'MultiEdit', category: 'edit', phase: 'result', status: 'completed',
      files: [{ path: 'C:\\repo\\a.ts', kind: 'update', added: 3, removed: 3 }],
    });
    await fixture.adapter.dispose();
  });

  it('streams and exposes task tools only to tool-enabled sessions', async () => {
    const conversation = makeAdapter();
    await start(conversation);
    expect(conversation.query.inputOptions).toMatchObject({ includePartialMessages: true, env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } });
    await conversation.adapter.dispose();

    const planning = makeAdapter();
    await planning.adapter.createSession({ ...context, toolsDisabled: true });
    expect(planning.query.inputOptions.includePartialMessages).toBe(false);
    expect(planning.query.inputOptions.env).not.toHaveProperty('CLAUDE_CODE_ENABLE_TODO_TOOLS');
    await planning.adapter.dispose();

    const optedOut = makeAdapter({ enableTaskTools: false });
    await start(optedOut);
    expect(optedOut.query.inputOptions.env).not.toHaveProperty('CLAUDE_CODE_ENABLE_TODO_TOOLS');
    await optedOut.adapter.dispose();
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

  it('excludes SDK query creation during deactivation and lets dispose win the race', async () => {
    const fixture = makeAdapter({ shutdownTimeoutMs: 500 });
    await start(fixture);
    const firstQuery = fixture.query;
    let releaseReturn!: () => void;
    const returnBlocked = new Promise<void>((resolve) => {
      releaseReturn = resolve;
    });
    firstQuery.returnImpl = () => returnBlocked;

    const deactivating = fixture.adapter.deactivate();
    const resuming = fixture.adapter.resumeSession({
      ...context,
      sessionId: 'agent-session-2',
      providerSessionId,
    });
    const disposing = fixture.adapter.dispose();
    releaseReturn();
    await deactivating;
    await expect(resuming).rejects.toMatchObject({ code: 'CLAUDE_PROVIDER_DISABLED' });
    await disposing;
    expect(fixture.query).toBe(firstQuery);
  });

  it('waits for SDK deactivation before resolving a concurrent model listing', async () => {
    const fixture = makeAdapter({ shutdownTimeoutMs: 500 });
    await start(fixture);
    const firstQuery = fixture.query;
    let releaseReturn!: () => void;
    const returnBlocked = new Promise<void>((resolve) => {
      releaseReturn = resolve;
    });
    firstQuery.returnImpl = () => returnBlocked;
    const supportedModels = vi.spyOn(firstQuery, 'supportedModels');

    const deactivating = fixture.adapter.deactivate();
    let listingSettled = false;
    const listing = fixture.adapter.listModels().finally(() => {
      listingSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listingSettled).toBe(false);
    expect(supportedModels).not.toHaveBeenCalled();

    releaseReturn();
    await deactivating;
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ id: 'sonnet', displayName: 'Claude Sonnet' }),
    ]);
    await fixture.adapter.dispose();
  });
});

describe('Claude zero-turn capabilities', () => {
  it('loads native settings and closes an ephemeral query with no prompt or transcript', async () => {
    const fixture = makeAdapter();
    const catalog = await fixture.adapter.listCapabilities(context.workspaceRoot);
    expect(catalog.models[0]?.id).toBe('sonnet');
    expect(fixture.query.inputOptions).toMatchObject({ persistSession: false, settingSources: ['user', 'project', 'local'], cwd: context.workspaceRoot });
    expect(await fixture.query.input[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    expect(fixture.query.closeCount).toBe(1);
    expect(fixture.events).toEqual([]);
    await fixture.adapter.dispose();
  });

  it('launches one CLI for callers asking about the same folder at once', async () => {
    const fixture = makeAdapter();
    let initialize!: () => void;
    const initialized = new Promise<void>((resolve) => { initialize = resolve; });
    const original = FakeClaudeQuery.prototype.initializationResult;
    const held = vi.spyOn(FakeClaudeQuery.prototype, 'initializationResult').mockImplementation(async function (this: FakeClaudeQuery) {
      await initialized;
      return original.call(this);
    });
    onTestFinished(() => held.mockRestore());
    const giveUp = new AbortController();
    const first = fixture.adapter.listCapabilities(context.workspaceRoot, giveUp.signal);
    const second = fixture.adapter.listCapabilities(context.workspaceRoot);
    await vi.waitFor(() => expect(fixture.queries.length).toBeGreaterThan(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    // One caller giving up does not stop the launch the others wait on.
    giveUp.abort();
    await expect(first).rejects.toMatchObject({ code: 'CLAUDE_OPERATION_ABORTED' });
    initialize();
    await expect(second).resolves.toMatchObject({ models: [expect.objectContaining({ id: 'sonnet' })] });
    expect(fixture.queries).toHaveLength(1);

    // Without a live chat, models are discovered by a launch in the app's folder.
    const models = await Promise.all([fixture.adapter.listModels(), fixture.adapter.listModels()]);
    expect(models).toEqual([[expect.objectContaining({ id: 'sonnet' })], [expect.objectContaining({ id: 'sonnet' })]]);
    expect(fixture.queries.map((query) => query.inputOptions.cwd)).toEqual([context.workspaceRoot, process.cwd()]);
    // Nothing is kept once the launch ends: a later caller sees current settings.
    await fixture.adapter.listCapabilities(context.workspaceRoot);
    expect(fixture.queries).toHaveLength(3);
    await fixture.adapter.dispose();
  });
});

describe('Claude usage', () => {
  async function submitted(fixture: ReturnType<typeof makeAdapter>, turnId: string): Promise<string> {
    await start(fixture);
    const inputIterator = fixture.query.input[Symbol.asyncIterator]();
    await fixture.adapter.submit({ sessionId: context.sessionId, providerSessionId, turnId, commandId: `command-${turnId}`, prompt: 'Hi' });
    return (await inputIterator.next()).value!.uuid as string;
  }

  function assistant(uuid: string, model: string, usage: Record<string, unknown>, parent: string | null = null): Record<string, unknown> {
    return {
      type: 'assistant', uuid, session_id: providerSessionId, parent_tool_use_id: parent,
      message: { id: `msg-${uuid}`, model, usage, content: [{ type: 'text', text: 'ok' }] },
    };
  }

  it('reports the plan windows, then the reply context from the main request before the turn finishes', async () => {
    const fixture = makeAdapter();
    const clientUuid = await submitted(fixture, 'turn-usage');
    fixture.query.emit({
      type: 'rate_limit_event', uuid: 'rl', session_id: providerSessionId,
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 100 }, seven_day: { utilization: 0.26, resetsAt: 200 } } },
    });
    fixture.query.emit({ ...assistant('main', 'claude-opus-5-5', { input_tokens: 60_000, cache_read_input_tokens: 8_000, output_tokens: 900 }), user_message_uuid: clientUuid });
    // A subagent's request and a local command's output do not fill this conversation's context.
    fixture.query.emit(assistant('child', 'claude-haiku-4-5', { input_tokens: 190_000 }, 'toolu_agent'));
    fixture.query.emit(assistant('local', '<synthetic>', { input_tokens: 5 }));
    fixture.query.emit({
      type: 'result', subtype: 'success', uuid: 'result', session_id: providerSessionId, user_message_uuid: clientUuid, is_error: false,
      modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 }, 'claude-opus-5-5': { contextWindow: 200_000 } },
    });

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'turn-finished', turnId: 'turn-usage' }));
    });
    const relevant = fixture.events.filter((event) => event.kind === 'usage' || event.kind === 'turn-finished');
    expect(relevant).toEqual([
      { kind: 'usage', limits: { fiveHour: { usedPercent: 12, resetsAt: 100_000 }, weekly: { usedPercent: 26, resetsAt: 200_000 } } },
      { kind: 'usage', sessionId: context.sessionId, contextPercent: 34 },
      expect.objectContaining({ kind: 'turn-finished', turnId: 'turn-usage', outcome: 'completed' }),
    ]);
    await fixture.adapter.dispose();
  });

  it('sends no reply usage for a failed reply and still reports a rejected limit', async () => {
    const fixture = makeAdapter();
    const clientUuid = await submitted(fixture, 'turn-failed');
    fixture.query.emit({
      type: 'rate_limit_event', uuid: 'rl', session_id: providerSessionId,
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 100 },
    });
    fixture.query.emit({
      type: 'result', subtype: 'error_during_execution', uuid: 'result', session_id: providerSessionId,
      user_message_uuid: clientUuid, is_error: true, errors: ['rate_limit'],
    });

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'turn-finished', turnId: 'turn-failed', outcome: 'failed' }));
    });
    expect(fixture.events.filter((event) => event.kind === 'usage')).toEqual([
      { kind: 'usage', limits: { fiveHour: { usedPercent: 100, resetsAt: 100_000 } } },
    ]);
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'provider-error', code: 'CLAUDE_RATE_LIMITED' }));
    await fixture.adapter.dispose();
  });

  it('reports no context for a reply stopped before any answer', async () => {
    const fixture = makeAdapter();
    const clientUuid = await submitted(fixture, 'turn-stopped');
    fixture.query.interruptReceipt = { still_queued: [] };
    await fixture.adapter.interrupt(context.sessionId, providerSessionId);
    fixture.query.emit({
      type: 'result', subtype: 'error_during_execution', uuid: 'aborted-result', session_id: providerSessionId,
      user_message_uuid: clientUuid, is_error: true, terminal_reason: 'aborted_streaming',
    });
    fixture.query.emit({ type: 'system', subtype: 'task_started', uuid: 'marker', session_id: providerSessionId, task_id: 'marker', task_type: 'local_agent' });

    await vi.waitFor(() => {
      expect(fixture.events).toContainEqual(expect.objectContaining({ kind: 'native-subagent', providerChildId: 'marker' }));
    });
    expect(fixture.events.filter((event) => event.kind === 'usage')).toEqual([]);
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

  it('labels a timeout Claude reports as Claude\'s, not as an EZTerminal deadline', () => {
    for (const input of ['Request timed out.', { error: 'timeout', message: 'API request timeout' }]) {
      const error = classifyClaudeProviderError(input);
      expect(error.code).toBe('CLAUDE_REPORTED_TIMEOUT');
      expect(error.recoverable).toBe(true);
      expect(error.message).toContain('not an EZTerminal time limit');
      expect(error.message).not.toContain('safety deadline');
    }
  });
});

describe('recorded Claude file changes', () => {
  const fragment = { path: 'C:/w/src/app.ts', coverage: 'fragment' as const, patch: '-a\n+b' };

  it('uses the SDK hunks for the same file and the created content for a new file', () => {
    expect(recordedClaudeChange(fragment, {
      filePath: 'C:/w/src/app.ts',
      structuredPatch: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ['-a', '+b'] }],
    })).toEqual({ path: 'C:/w/src/app.ts', coverage: 'patch', patch: '@@ -4,1 +4,1 @@\n-a\n+b' });
    expect(recordedClaudeChange({ ...fragment, patch: '+x' }, { type: 'create', filePath: 'C:/w/src/app.ts', content: 'x\n', structuredPatch: [] }))
      .toEqual({ path: 'C:/w/src/app.ts', coverage: 'patch', patch: '@@ -0,0 +1,1 @@\n+x' });
  });

  it('keeps the fragment when the structured result is about another file, missing or malformed', () => {
    expect(recordedClaudeChange(fragment, { filePath: 'C:/w/other.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] })).toBe(fragment);
    expect(recordedClaudeChange(fragment, undefined)).toBe(fragment);
    expect(recordedClaudeChange(fragment, { filePath: 'C:/w/src/app.ts', structuredPatch: [{ oldStart: 'x' }] })).toBe(fragment);
  });
});
