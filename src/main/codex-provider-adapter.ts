import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import type {
  DaemonTranscriptItem,
  PermissionPreset,
} from '../shared/daemon-protocol';
import type { ProviderLaunchDescriptor } from '../shared/daemon-provider';
import type {
  AgentProviderAdapter,
  AgentProviderEvent,
  AgentProviderEventListener,
  ProviderApprovalDecision,
  ProviderModel,
  ProviderProbeResult,
  ProviderReconciliationInput,
  ProviderReconciliationResult,
  ProviderSessionContext,
  ProviderSessionHandle,
  ProviderSubmitInput,
} from './agent-provider-adapter';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerConnection,
  type CodexJsonRpcId,
  type CodexServerRequestContext,
} from './codex-app-server-client';
import {
  buildProviderProcessEnvironment,
  sameEnvironmentVariableSet,
  sanitizeProviderDiagnostic,
} from './provider-process-security';

export const CODEX_APP_SERVER_BASELINE_VERSION = '0.152.1';
const MAX_MODELS = 2_000;
const MAX_MODEL_PAGES = 40;
const MAX_SEMANTIC_TEXT = 1024 * 1024;
const MAX_PROBE_OUTPUT = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const CODEX_APP_SERVER_ARGV = ['app-server'] as const;
const CODEX_ENVIRONMENT_VARIABLE_NAMES = [
  'PATH',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const;

type JsonObject = Record<string, unknown>;

export interface CodexCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface SessionState {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly workspaceRoot: string;
  model?: string;
  permissionPreset: PermissionPreset;
  nextTranscriptSequence: number;
  activeTurn?: {
    readonly localTurnId: string;
    readonly commandId: string;
    providerTurnId?: string;
    startedEmitted: boolean;
    interruptRequest?: {
      readonly promise: Promise<void>;
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
      dispatched: boolean;
      settled: boolean;
    };
  };
  readonly completedItemKeys: Set<string>;
  readonly nativeStateByChild: Map<string, string>;
}

type ApprovalKind = 'command' | 'file-change' | 'permissions' | 'legacy-command' | 'legacy-file-change';

interface PendingApproval {
  readonly providerRequestId: string;
  readonly kind: ApprovalKind;
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly turnId?: string;
  readonly params: JsonObject;
  readonly resolve: (response: unknown) => void;
}

export interface CodexProviderAdapterOptions {
  readonly connection?: CodexAppServerConnection;
  readonly connectionFactory?: (options: CodexAppServerClientOptions) => CodexAppServerConnection;
  readonly executable?: string;
  readonly clientOptions?: Omit<
    CodexAppServerClientOptions,
    'command' | 'argv' | 'environment' | 'beforeSpawn'
  >;
  readonly resolveExecutable?: (command: string, signal?: AbortSignal) => Promise<string>;
  readonly runCommand?: (command: string, argv: readonly string[], signal?: AbortSignal) => Promise<CodexCommandResult>;
  readonly probeTimeoutMs?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedText(value: unknown, maximum = MAX_SEMANTIC_TEXT): string {
  const raw = typeof value === 'string'
    ? value
    : !Array.isArray(value)
      ? ''
      : value.flatMap((entry): string[] => {
    if (typeof entry === 'string') return [entry];
    const object = asObject(entry);
    const text = asString(object?.text) ?? asString(object?.content);
    return text ? [text] : [];
  }).join('\n');
  return sanitizeProviderDiagnostic(raw, { maxLength: maximum }).text;
}

function opaqueId(namespace: string, ...parts: readonly string[]): string {
  return `${namespace}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}

function permissionStartSettings(permissionPreset: PermissionPreset): JsonObject {
  switch (permissionPreset) {
    case 'plan':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'standard':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
}

function permissionUpdateSettings(permissionPreset: PermissionPreset, workspaceRoot: string): JsonObject {
  switch (permissionPreset) {
    case 'plan':
      return {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      };
    case 'standard':
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [workspaceRoot],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case 'full-access':
      return {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
  }
}

function threadIdFromParams(params: JsonObject): string | undefined {
  return asString(params.threadId) ?? asString(params.conversationId);
}

function turnStatus(value: unknown): 'completed' | 'interrupted' | 'failed' {
  return value === 'interrupted' ? 'interrupted' : value === 'failed' ? 'failed' : 'completed';
}

function reconciliationTurnState(
  value: unknown,
): 'working' | 'blocked' | 'completed' | 'interrupted' | 'failed' {
  switch (value) {
    case 'completed':
      return 'completed';
    case 'interrupted':
    case 'cancelled':
      return 'interrupted';
    case 'failed':
      return 'failed';
    case 'blocked':
    case 'waitingForApproval':
      return 'blocked';
    default:
      return 'working';
  }
}

function nativeState(value: unknown): 'starting' | 'working' | 'blocked' | 'done' | 'error' {
  switch (value) {
    case 'pendingInit':
    case 'started':
      return 'starting';
    case 'running':
    case 'inProgress':
    case 'interacted':
      return 'working';
    case 'completed':
    case 'shutdown':
      return 'done';
    case 'interrupted':
    case 'errored':
    case 'notFound':
    case 'failed':
      return 'error';
    default:
      return 'working';
  }
}

function abortError(): Error {
  const error = new Error('Codex executable probe was cancelled.');
  error.name = 'AbortError';
  return error;
}

function probeTimeoutError(timeoutMs: number): Error {
  return new Error(`Codex executable verification exceeded ${String(timeoutMs)}ms.`);
}

async function withProbeDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => {
      reject(abortError());
      controller.abort();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timedOut = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(probeTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      cancelled,
      timedOut,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

async function runExternalCommand(
  command: string,
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<CodexCommandResult> {
  if (signal?.aborted) throw abortError();
  return new Promise<CodexCommandResult>((resolve, reject) => {
    const child = crossSpawn(command, [...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildProviderProcessEnvironment([]),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
    };
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next, 'utf8') > MAX_PROBE_OUTPUT) {
        if (!child.killed) child.kill();
        finish(new Error(`Command ${command} produced too much output.`));
      }
      return next.slice(-MAX_PROBE_OUTPUT);
    };
    const onAbort = (): void => {
      if (!child.killed) child.kill();
      finish(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(undefined, code ?? -1));
  });
}

async function canonicalExecutable(
  command: string,
  runCommand: (command: string, argv: readonly string[], signal?: AbortSignal) => Promise<CodexCommandResult>,
  signal?: AbortSignal,
): Promise<string> {
  if (path.isAbsolute(command)) return fs.realpath(command);
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const located = await runCommand(locator, [command], signal);
  if (located.exitCode !== 0) throw new Error(located.stderr.trim() || `${command} was not found on PATH.`);
  const candidates = located.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  const selected = process.platform === 'win32'
    ? candidates.find((entry) => /\.(?:exe|cmd)$/iu.test(entry)) ?? candidates[0]
    : candidates[0];
  if (!selected || !path.isAbsolute(selected)) throw new Error(`${command} did not resolve to an absolute executable path.`);
  return fs.realpath(selected);
}

function parseVersion(output: string): string | undefined {
  return /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(output)?.[1];
}

function compatibleVersion(version: string): boolean {
  const match = /^0\.152\.(\d+)$/u.exec(version);
  return match !== null && Number(match[1]) >= 1;
}

function orchestrationConfig(context: ProviderSessionContext): JsonObject | undefined {
  if (!context.orchestration) return undefined;
  if (!context.orchestration.bearerToken.trim()) throw new Error('Orchestration bearer token must not be empty.');
  const endpoint = new URL(context.orchestration.endpoint);
  if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
    throw new Error('Orchestration endpoint must be an HTTP(S) URL without embedded credentials.');
  }
  return {
    mcp_servers: {
      ezterminal_orchestration: {
        url: endpoint.toString(),
        http_headers: { Authorization: `Bearer ${context.orchestration.bearerToken}` },
      },
    },
  };
}

/** Structured Codex adapter targeting the observed 0.152.1 app-server schema. */
export class CodexProviderAdapter implements AgentProviderAdapter {
  readonly providerId = 'codex';

  private readonly executable: string;
  private connection: CodexAppServerConnection | undefined;
  private readonly providedConnection: boolean;
  private readonly connectionFactory: (options: CodexAppServerClientOptions) => CodexAppServerConnection;
  private readonly clientOptions: CodexProviderAdapterOptions['clientOptions'];
  private readonly resolveExecutable: (command: string, signal?: AbortSignal) => Promise<string>;
  private readonly runCommand: (command: string, argv: readonly string[], signal?: AbortSignal) => Promise<CodexCommandResult>;
  private readonly probeTimeoutMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly listeners = new Set<AgentProviderEventListener>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionIdByProviderId = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly unregister: Array<() => void> = [];
  private launchDescriptor: ProviderLaunchDescriptor | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lifecycleGeneration = 0;
  private deactivatePromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: CodexProviderAdapterOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.runCommand = options.runCommand ?? runExternalCommand;
    this.resolveExecutable = options.resolveExecutable
      ?? ((command, signal) => canonicalExecutable(command, this.runCommand, signal));
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.probeTimeoutMs) || this.probeTimeoutMs < 1) {
      throw new Error('probeTimeoutMs must be a positive integer.');
    }
    this.connection = options.connection;
    this.providedConnection = options.connection !== undefined;
    this.connectionFactory = options.connectionFactory ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
    this.clientOptions = options.clientOptions;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    if (this.connection) this.installConnectionHandlers(this.connection);
  }

  setLaunchDescriptor(descriptor: ProviderLaunchDescriptor): void {
    if (
      descriptor.providerId !== this.providerId
      || descriptor.protocol !== 'codex-app-server'
      || !path.isAbsolute(descriptor.executablePath)
      || descriptor.argv.length !== CODEX_APP_SERVER_ARGV.length
      || !descriptor.argv.every((value, index) => value === CODEX_APP_SERVER_ARGV[index])
      || !sameEnvironmentVariableSet(descriptor.environmentVariableNames, CODEX_ENVIRONMENT_VARIABLE_NAMES)
      || !compatibleVersion(descriptor.executableVersion)
      || !/^[a-f0-9]{64}$/u.test(descriptor.reviewDigest)
    ) {
      throw new Error('The reviewed Codex launch descriptor is incompatible.');
    }
    const changed = this.launchDescriptor !== undefined
      && JSON.stringify(this.launchDescriptor) !== JSON.stringify(descriptor);
    if (changed && this.sessions.size > 0) {
      throw new Error('Stop active Codex sessions before changing the reviewed executable.');
    }
    this.launchDescriptor = { ...descriptor, argv: [...descriptor.argv], environmentVariableNames: [...descriptor.environmentVariableNames] };
    if (changed && !this.providedConnection) this.resetOwnedConnection();
  }

  async probe(signal?: AbortSignal): Promise<ProviderProbeResult> {
    try {
      const { executablePath, result } = await withProbeDeadline(
        signal,
        this.probeTimeoutMs,
        async (deadlineSignal) => {
          const executablePath = await this.resolveExecutable(this.executable, deadlineSignal);
          const result = await this.runCommand(executablePath, ['--version'], deadlineSignal);
          return { executablePath, result };
        },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Codex exited with code ${result.exitCode}.`);
      const executableVersion = parseVersion(`${result.stdout}\n${result.stderr}`);
      if (!executableVersion) throw new Error('Codex did not report a semantic version.');
      const compatible = compatibleVersion(executableVersion);
      return {
        providerId: this.providerId,
        displayName: 'Codex',
        protocol: 'codex-app-server',
        available: compatible,
        executablePath,
        executableVersion,
        argv: CODEX_APP_SERVER_ARGV,
        environmentVariableNames: CODEX_ENVIRONMENT_VARIABLE_NAMES,
        capabilities: [
          'create', 'resume', 'interrupt', 'model-change', 'permission-change',
          'approvals', 'native-subagents', 'history-reconciliation',
        ],
        authenticationState: 'first-launch',
        authenticationDetail: 'Codex authentication is verified by app-server when the first Agent session starts.',
        ...(compatible ? {} : {
          unavailableReason: `Codex ${executableVersion} has not been reviewed for the ${CODEX_APP_SERVER_BASELINE_VERSION} app-server contract.`,
        }),
      };
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      return {
        providerId: this.providerId,
        displayName: 'Codex',
        protocol: 'codex-app-server',
        available: false,
        executablePath: this.executable,
        executableVersion: 'unknown',
        argv: CODEX_APP_SERVER_ARGV,
        environmentVariableNames: CODEX_ENVIRONMENT_VARIABLE_NAMES,
        capabilities: [
          'create', 'resume', 'interrupt', 'model-change', 'permission-change',
          'approvals', 'native-subagents', 'history-reconciliation',
        ],
        authenticationState: 'unavailable',
        authenticationDetail: 'Codex authentication cannot be checked until a compatible executable is available.',
        unavailableReason: sanitizeProviderDiagnostic(error).text,
      };
    }
  }

  async listModels(signal?: AbortSignal): Promise<readonly ProviderModel[]> {
    this.assertActive();
    await this.ensureConnection(signal);
    const models: ProviderModel[] = [];
    const seenModels = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES && models.length < MAX_MODELS; page += 1) {
      const result = asObject(await this.requireConnection().request('model/list', {
        limit: Math.min(100, MAX_MODELS - models.length),
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      }, { signal }));
      for (const value of asArray(result?.data)) {
        const model = asObject(value);
        const id = asString(model?.model) ?? asString(model?.id);
        if (!id || seenModels.has(id) || model?.hidden === true) continue;
        seenModels.add(id);
        models.push({
          id,
          displayName: asString(model?.displayName) ?? id,
          ...(asString(model?.description) ? { description: asString(model?.description) } : {}),
          supportsReasoning: asArray(model?.supportedReasoningEfforts).length > 0,
          isDefault: model?.isDefault === true,
        });
      }
      const nextCursor = asString(result?.nextCursor);
      if (!nextCursor) return models;
      if (seenCursors.has(nextCursor)) throw new Error('Codex model pagination repeated a cursor.');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (cursor) throw new Error(`Codex model catalog exceeds the ${MAX_MODELS}-model safety bound.`);
    return models;
  }

  async createSession(context: ProviderSessionContext, signal?: AbortSignal): Promise<ProviderSessionHandle> {
    this.assertSessionContext(context);
    this.assertActive();
    const lifecycleGeneration = await this.ensureConnection(signal);
    if (this.sessions.has(context.sessionId)) throw new Error(`Codex session ${context.sessionId} already exists.`);
    this.emit({ kind: 'session-state', sessionId: context.sessionId, state: 'starting' });
    try {
      const config = orchestrationConfig(context);
      const result = asObject(await this.requireConnection().request('thread/start', {
        cwd: context.workspaceRoot,
        runtimeWorkspaceRoots: [context.workspaceRoot],
        ...(context.model ? { model: context.model } : {}),
        ...permissionStartSettings(context.permissionPreset),
        ...(config ? { config } : {}),
        ephemeral: false,
        historyMode: 'paginated',
        threadSource: 'ezterminal',
      }, { signal }));
      const thread = asObject(result?.thread);
      const providerSessionId = asString(thread?.id);
      if (!providerSessionId) throw new Error('Codex thread/start returned no thread id.');
      this.assertLifecycleGeneration(lifecycleGeneration);
      const state = this.registerSession(context, providerSessionId, asString(result?.model) ?? context.model);
      this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'idle' });
      return this.handleFor(state);
    } catch (error) {
      this.emit({
        kind: 'session-state', sessionId: context.sessionId, state: 'failed',
        detail: sanitizeProviderDiagnostic(error, {
          explicitSecrets: context.orchestration ? [context.orchestration.bearerToken] : [],
        }).text,
      });
      throw error;
    }
  }

  async resumeSession(
    context: ProviderSessionContext & { readonly providerSessionId: string },
    signal?: AbortSignal,
  ): Promise<ProviderSessionHandle> {
    this.assertSessionContext(context);
    this.assertActive();
    const lifecycleGeneration = await this.ensureConnection(signal);
    if (this.sessions.has(context.sessionId)) throw new Error(`Codex session ${context.sessionId} already exists.`);
    this.emit({ kind: 'session-state', sessionId: context.sessionId, state: 'starting' });
    try {
      const config = orchestrationConfig(context);
      const result = asObject(await this.requireConnection().request('thread/resume', {
        threadId: context.providerSessionId,
        cwd: context.workspaceRoot,
        runtimeWorkspaceRoots: [context.workspaceRoot],
        ...(context.model ? { model: context.model } : {}),
        ...permissionStartSettings(context.permissionPreset),
        ...(config ? { config } : {}),
        excludeTurns: true,
      }, { signal }));
      const thread = asObject(result?.thread);
      const resumedId = asString(thread?.id);
      if (!resumedId || resumedId !== context.providerSessionId) {
        throw new Error('Codex thread/resume returned a different thread id.');
      }
      this.assertLifecycleGeneration(lifecycleGeneration);
      const state = this.registerSession(context, resumedId, asString(result?.model) ?? context.model);
      this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'idle' });
      return this.handleFor(state);
    } catch (error) {
      this.emit({
        kind: 'session-state', sessionId: context.sessionId, state: 'failed',
        detail: sanitizeProviderDiagnostic(error, {
          explicitSecrets: context.orchestration ? [context.orchestration.bearerToken] : [],
        }).text,
      });
      throw error;
    }
  }

  async submit(input: ProviderSubmitInput, signal?: AbortSignal): Promise<void> {
    this.assertActive();
    if (!input.prompt.trim()) throw new Error('Codex prompt must not be empty.');
    if (!input.turnId.trim() || !input.commandId.trim()) throw new Error('Codex turn identity is incomplete.');
    const state = this.requireSession(input.sessionId, input.providerSessionId);
    if (state.activeTurn) throw new Error(`Codex session ${input.sessionId} already has an active turn.`);
    state.activeTurn = {
      localTurnId: input.turnId,
      commandId: input.commandId,
      startedEmitted: false,
    };
    this.emit({ kind: 'session-state', sessionId: input.sessionId, state: 'working' });
    try {
      const result = asObject(await this.requireConnection().request('turn/start', {
        threadId: input.providerSessionId,
        clientUserMessageId: input.commandId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      }, { signal }));
      const turn = asObject(result?.turn);
      const providerTurnId = asString(turn?.id);
      if (!providerTurnId) throw new Error('Codex turn/start returned no turn id.');
      const activeTurn = state.activeTurn;
      if (!activeTurn || activeTurn.commandId !== input.commandId) return;
      activeTurn.providerTurnId = providerTurnId;
      this.dispatchPendingInterrupt(state, activeTurn);
      this.emitTurnStarted(state, activeTurn);
    } catch (error) {
      if (state.activeTurn?.commandId === input.commandId) {
        this.settlePendingInterrupt(state.activeTurn, error);
        state.activeTurn = undefined;
      }
      this.emit({
        kind: 'provider-error',
        sessionId: input.sessionId,
        code: 'turn-start-failed',
        message: sanitizeProviderDiagnostic(error).text,
        recoverable: true,
      });
      throw error;
    }
  }

  interrupt(sessionId: string, providerSessionId: string): Promise<void> {
    this.assertActive();
    const state = this.requireSession(sessionId, providerSessionId);
    const activeTurn = state.activeTurn;
    if (!activeTurn) {
      return Promise.reject(new Error(`Codex session ${sessionId} has no interruptible provider turn.`));
    }
    if (!activeTurn.interruptRequest) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      activeTurn.interruptRequest = {
        promise,
        resolve,
        reject,
        dispatched: false,
        settled: false,
      };
    }
    this.dispatchPendingInterrupt(state, activeTurn);
    return activeTurn.interruptRequest.promise;
  }

  async setSettings(input: {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly model?: string;
    readonly permissionPreset?: PermissionPreset;
  }): Promise<ProviderSessionHandle> {
    this.assertActive();
    const state = this.requireSession(input.sessionId, input.providerSessionId);
    if (input.model === undefined && input.permissionPreset === undefined) return this.handleFor(state);
    if (input.model !== undefined && !input.model.trim()) throw new Error('Codex model must not be empty.');
    await this.requireConnection().request('thread/settings/update', {
      threadId: input.providerSessionId,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.permissionPreset === undefined
        ? {}
        : permissionUpdateSettings(input.permissionPreset, state.workspaceRoot)),
    });
    if (input.model !== undefined) state.model = input.model;
    if (input.permissionPreset !== undefined) state.permissionPreset = input.permissionPreset;
    return this.handleFor(state);
  }

  async resolveApproval(input: ProviderApprovalDecision): Promise<void> {
    this.assertActive();
    const pending = this.pendingApprovals.get(input.providerRequestId);
    if (!pending) throw new Error(`Codex approval ${input.providerRequestId} is no longer pending.`);
    if (pending.sessionId !== input.sessionId || pending.providerSessionId !== input.providerSessionId) {
      throw new Error('Codex approval does not belong to this session.');
    }
    this.pendingApprovals.delete(input.providerRequestId);
    pending.resolve(this.approvalResponse(pending, input.decision));
    this.emit({ kind: 'session-state', sessionId: input.sessionId, state: 'working' });
  }

  subscribe(listener: AgentProviderEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reconcile(
    input: ProviderReconciliationInput,
    signal?: AbortSignal,
  ): Promise<ProviderReconciliationResult> {
    this.assertActive();
    await this.ensureConnection(signal);
    const result = asObject(await this.requireConnection().request('thread/read', {
      threadId: input.providerSessionId,
      includeTurns: true,
    }, { signal }));
    const thread = asObject(result?.thread);
    if (asString(thread?.id) !== input.providerSessionId) throw new Error('Codex thread/read returned a different thread.');
    const turns = asArray(thread?.turns).flatMap((value): JsonObject[] => {
      const turn = asObject(value);
      return turn ? [turn] : [];
    });
    const byCommand = new Map<string, JsonObject>();
    for (const turn of turns) {
      for (const itemValue of asArray(turn.items)) {
        const item = asObject(itemValue);
        if (item?.type !== 'userMessage') continue;
        const clientId = asString(item.clientId);
        if (clientId) byCommand.set(clientId, turn);
      }
    }
    const live = this.sessions.get(input.sessionId);
    const commands = input.unsettledCommands.map((command) => {
      const turn = byCommand.get(command.commandId);
      const providerTurnId = asString(turn?.id);
      if (!turn || !providerTurnId) {
        // thread/read with includeTurns is the authoritative turn history. A
        // missing clientUserMessageId was not delivered and is safe to queue.
        return { commandId: command.commandId, state: 'not-applied' as const };
      }
      const turnState = reconciliationTurnState(turn.status);
      if (
        live
        && command.turnId
        && (turnState === 'working' || turnState === 'blocked')
      ) {
        live.activeTurn = {
          localTurnId: command.turnId,
          commandId: command.commandId,
          providerTurnId,
          startedEmitted: true,
        };
      }
      return {
        commandId: command.commandId,
        state: 'applied' as const,
        providerTurnId,
        turnState,
      };
    });
    let sequence = 0;
    const transcriptItems: DaemonTranscriptItem[] = [];
    for (const turn of turns) {
      const providerTurnId = asString(turn.id) ?? this.idFactory();
      const createdAt = this.turnTime(turn);
      for (const itemValue of asArray(turn.items)) {
        const item = asObject(itemValue);
        if (!item) continue;
        const mapped = this.transcriptFromItem(
          input.sessionId,
          providerTurnId,
          item,
          ++sequence,
          createdAt,
          false,
        );
        if (mapped) transcriptItems.push(mapped);
        else sequence -= 1;
      }
    }
    return { commands, transcriptItems };
  }

  async disposeSession(sessionId: string, providerSessionId: string): Promise<void> {
    const state = this.requireSession(sessionId, providerSessionId);
    if (state.activeTurn) {
      this.settlePendingInterrupt(
        state.activeTurn,
        new Error(`Codex session ${sessionId} stopped before its interrupt could be delivered.`),
      );
      state.activeTurn = undefined;
    }
    for (const approval of [...this.pendingApprovals.values()]) {
      if (approval.sessionId !== sessionId) continue;
      this.pendingApprovals.delete(approval.providerRequestId);
      approval.resolve(this.approvalResponse(approval, 'deny'));
    }
    try {
      await this.requireConnection().request('thread/unsubscribe', { threadId: providerSessionId });
    } finally {
      const stillOwnsSession = this.sessions.get(state.sessionId) === state;
      if (stillOwnsSession) this.sessions.delete(state.sessionId);
      if (
        stillOwnsSession
        && this.sessionIdByProviderId.get(state.providerSessionId) === state.sessionId
      ) {
        this.sessionIdByProviderId.delete(state.providerSessionId);
      }
    }
  }

  deactivate(): Promise<void> {
    if (this.deactivatePromise) return this.deactivatePromise;
    this.lifecycleGeneration += 1;
    const operation = this.enqueueLifecycle(async () => {
      const connection = this.connection;
      this.connection = undefined;
      for (const approval of this.pendingApprovals.values()) {
        approval.resolve(this.approvalResponse(approval, 'deny'));
      }
      this.pendingApprovals.clear();
      for (const unregister of this.unregister.splice(0)) unregister();
      for (const state of this.sessions.values()) {
        if (!state.activeTurn) continue;
        this.settlePendingInterrupt(
          state.activeTurn,
          new Error(`Codex session ${state.sessionId} was deactivated before its interrupt could be delivered.`),
        );
        state.activeTurn = undefined;
      }
      this.sessions.clear();
      this.sessionIdByProviderId.clear();
      await connection?.dispose();
    }).finally(() => {
      if (this.deactivatePromise === operation) this.deactivatePromise = null;
    });
    this.deactivatePromise = operation;
    return operation;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const operation = this.deactivate().then(() => {
      this.listeners.clear();
    });
    this.disposePromise = operation;
    return operation;
  }

  private ensureConnection(signal?: AbortSignal): Promise<number> {
    return this.enqueueLifecycle(() => {
      this.assertActive();
      if (signal?.aborted) throw abortError();
      if (!this.connection) {
        const descriptor = this.launchDescriptor;
        if (!descriptor) {
          throw new Error('Codex must be enabled from a persisted executable review before launch.');
        }
        const connection = this.connectionFactory({
          ...this.clientOptions,
          command: descriptor.executablePath,
          argv: descriptor.argv,
          environment: buildProviderProcessEnvironment(descriptor.environmentVariableNames),
          beforeSpawn: (launchSignal) => this.verifyLaunchDescriptor(descriptor, launchSignal),
        });
        this.connection = connection;
        this.installConnectionHandlers(connection);
      }
      return this.lifecycleGeneration;
    });
  }

  private enqueueLifecycle<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertLifecycleGeneration(generation: number): void {
    this.assertActive();
    if (generation !== this.lifecycleGeneration) {
      throw new Error('Codex provider lifecycle changed while the operation was starting.');
    }
  }

  private requireConnection(): CodexAppServerConnection {
    if (!this.connection) throw new Error('Codex app-server is not initialized.');
    return this.connection;
  }

  private async verifyLaunchDescriptor(
    descriptor: ProviderLaunchDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    await withProbeDeadline(signal, this.probeTimeoutMs, async (deadlineSignal) => {
      const canonical = await fs.realpath(descriptor.executablePath);
      if (deadlineSignal.aborted) throw abortError();
      const samePath = process.platform === 'win32'
        ? canonical.toLocaleLowerCase('en-US') === descriptor.executablePath.toLocaleLowerCase('en-US')
        : canonical === descriptor.executablePath;
      if (!samePath) throw new Error('Codex executable realpath changed after review. Inspect the provider again.');
      const result = await this.runCommand(canonical, ['--version'], deadlineSignal);
      const version = parseVersion(`${result.stdout}\n${result.stderr}`);
      if (result.exitCode !== 0 || version !== descriptor.executableVersion || !compatibleVersion(version)) {
        throw new Error('Codex executable version changed after review. Inspect the provider again.');
      }
    });
  }

  private resetOwnedConnection(): void {
    if (this.providedConnection || !this.connection) return;
    for (const unregister of this.unregister.splice(0)) unregister();
    const connection = this.connection;
    this.connection = undefined;
    void connection.dispose();
  }

  private installConnectionHandlers(connection: CodexAppServerConnection): void {
    this.unregister.push(
      connection.onNotification('*', (params, method) => this.handleNotification(method, params)),
      connection.onClose((event) => {
        if (event.expected || this.disposed) return;
        for (const approval of this.pendingApprovals.values()) {
          approval.resolve(this.approvalResponse(approval, 'deny'));
        }
        this.pendingApprovals.clear();
        for (const state of this.sessions.values()) {
          if (state.activeTurn) {
            this.settlePendingInterrupt(state.activeTurn, new Error(event.message));
            state.activeTurn = undefined;
          }
          this.emit({
            kind: 'provider-error', sessionId: state.sessionId, code: 'app-server-exited',
            message: sanitizeProviderDiagnostic(event.message).text, recoverable: true,
          });
          this.emit({
            kind: 'session-state',
            sessionId: state.sessionId,
            state: 'failed',
            detail: sanitizeProviderDiagnostic(event.message).text,
          });
        }
      }),
    );
    const approvalMethods: ReadonlyArray<readonly [string, ApprovalKind]> = [
      ['item/commandExecution/requestApproval', 'command'],
      ['item/fileChange/requestApproval', 'file-change'],
      ['item/permissions/requestApproval', 'permissions'],
      ['execCommandApproval', 'legacy-command'],
      ['applyPatchApproval', 'legacy-file-change'],
    ];
    for (const [method, kind] of approvalMethods) {
      this.unregister.push(connection.onServerRequest(
        method,
        (params, context) => this.handleApproval(kind, params, context),
      ));
    }
  }

  private handleApproval(kind: ApprovalKind, value: unknown, context: CodexServerRequestContext): Promise<unknown> {
    const params = asObject(value);
    const providerSessionId = params ? threadIdFromParams(params) : undefined;
    const sessionId = providerSessionId ? this.sessionIdByProviderId.get(providerSessionId) : undefined;
    if (!params || !providerSessionId || !sessionId) {
      throw new Error('Codex approval referenced an unknown session.');
    }
    const explicitId = asString(params.approvalId);
    const providerRequestId = `${kind}:${explicitId ?? this.rpcIdKey(context.id)}`;
    if (this.pendingApprovals.has(providerRequestId)) throw new Error('Codex repeated a pending approval id.');
    return new Promise<unknown>((resolve) => {
      const pending: PendingApproval = {
        providerRequestId,
        kind,
        sessionId,
        providerSessionId,
        ...(asString(params.turnId) ? { turnId: asString(params.turnId) } : {}),
        params,
        resolve,
      };
      this.pendingApprovals.set(providerRequestId, pending);
      const detail = this.approvalDetail(kind, params);
      this.emit({
        kind: 'approval-requested',
        sessionId,
        ...(pending.turnId ? { turnId: this.localTurnId(sessionId, pending.turnId) } : {}),
        providerRequestId,
        risk: kind === 'file-change' || kind === 'legacy-file-change' ? 'write' : 'danger',
        title: this.approvalTitle(kind),
        ...(detail ? { detail } : {}),
      });
      this.emit({ kind: 'session-state', sessionId, state: 'blocked' });
    });
  }

  private approvalResponse(pending: PendingApproval, decision: 'allow' | 'deny'): unknown {
    if (pending.kind === 'legacy-command' || pending.kind === 'legacy-file-change') {
      return {
        decision: decision === 'allow'
          ? 'approved'
          : { denied: { rejection: 'Denied by the user in EZTerminal.' } },
      };
    }
    if (pending.kind === 'permissions') {
      const requested = asObject(pending.params.permissions);
      return {
        permissions: decision === 'allow' ? {
          ...(requested?.network ? { network: requested.network } : {}),
          ...(requested?.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        } : {},
        scope: 'turn',
      };
    }
    return { decision: decision === 'allow' ? 'accept' : 'decline' };
  }

  private approvalTitle(kind: ApprovalKind): string {
    switch (kind) {
      case 'command':
      case 'legacy-command':
        return 'Run command';
      case 'file-change':
      case 'legacy-file-change':
        return 'Apply file changes';
      case 'permissions':
        return 'Grant additional permissions';
    }
  }

  private approvalDetail(kind: ApprovalKind, params: JsonObject): string {
    if (kind === 'command') return boundedText(params.command, 4_000) || boundedText(params.reason, 4_000);
    if (kind === 'legacy-command') return asArray(params.command).filter((value): value is string => typeof value === 'string').join(' ').slice(0, 4_000);
    return boundedText(params.reason, 4_000) || boundedText(params.grantRoot, 4_000);
  }

  private handleNotification(method: string, value: unknown): void {
    const params = asObject(value);
    if (!params) return;
    const providerSessionId = asString(params.threadId);
    const sessionId = providerSessionId ? this.sessionIdByProviderId.get(providerSessionId) : undefined;
    const state = sessionId ? this.sessions.get(sessionId) : undefined;
    if (method === 'error') {
      const error = asObject(params.error);
      const message = sanitizeProviderDiagnostic(
        asString(error?.message) ?? 'Codex reported an unknown error.',
      ).text;
      if (state && params.willRetry !== true) {
        this.clearActiveTurn(state, new Error(message));
      }
      this.emit({
        kind: 'provider-error',
        ...(sessionId ? { sessionId } : {}),
        code: 'codex-turn-error',
        message,
        recoverable: params.willRetry === true,
      });
      return;
    }
    if (!state) return;
    switch (method) {
      case 'thread/status/changed':
        this.handleThreadStatus(state, asObject(params.status));
        return;
      case 'turn/started':
        this.handleTurnStarted(state, asObject(params.turn));
        return;
      case 'turn/completed':
        this.handleTurnCompleted(state, asObject(params.turn));
        return;
      case 'item/started':
      case 'item/completed':
        this.handleItem(state, asString(params.turnId), asObject(params.item), method === 'item/completed');
        return;
      case 'item/agentMessage/delta':
        this.emitDelta(state, params, 'assistant-message');
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/plan/delta':
        this.emitDelta(state, params, 'reasoning');
        return;
      default:
        return;
    }
  }

  private handleThreadStatus(state: SessionState, status: JsonObject | undefined): void {
    switch (status?.type) {
      case 'active':
        this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'working' });
        break;
      case 'idle':
        this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'idle' });
        break;
      case 'systemError':
        this.clearActiveTurn(state, new Error('Codex entered a terminal system error state.'));
        this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'failed' });
        break;
      case 'notLoaded':
        this.clearActiveTurn(state, new Error('Codex unloaded the active thread.'));
        this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'interrupted' });
        break;
      default:
        break;
    }
  }

  private handleTurnStarted(state: SessionState, turn: JsonObject | undefined): void {
    if (!turn) return;
    const providerTurnId = asString(turn?.id);
    if (!providerTurnId) return;
    if (!state.activeTurn) {
      const commandId = this.commandIdFromTurn(turn) ?? `provider:${providerTurnId}`;
      state.activeTurn = {
        localTurnId: `provider:${providerTurnId}`,
        commandId,
        providerTurnId,
        startedEmitted: false,
      };
    } else if (this.turnMatchesActive(state.activeTurn, turn, providerTurnId)) {
      state.activeTurn.providerTurnId ??= providerTurnId;
    } else {
      return;
    }
    this.dispatchPendingInterrupt(state, state.activeTurn);
    this.emitTurnStarted(state, state.activeTurn);
  }

  private dispatchPendingInterrupt(
    state: SessionState,
    active: NonNullable<SessionState['activeTurn']>,
  ): void {
    const pending = active.interruptRequest;
    if (!pending || pending.dispatched || pending.settled || !active.providerTurnId) return;
    pending.dispatched = true;
    const providerTurnId = active.providerTurnId;
    void Promise.resolve().then(() => this.requireConnection().request('turn/interrupt', {
      threadId: state.providerSessionId,
      turnId: providerTurnId,
    })).then(
      () => this.settlePendingInterrupt(active),
      (error) => {
        if (!this.settlePendingInterrupt(active, error)) return;
        this.emit({
          kind: 'provider-error',
          sessionId: state.sessionId,
          code: 'turn-interrupt-failed',
          message: sanitizeProviderDiagnostic(error).text,
          recoverable: true,
        });
      },
    );
  }

  private settlePendingInterrupt(
    active: NonNullable<SessionState['activeTurn']>,
    error?: unknown,
  ): boolean {
    const pending = active.interruptRequest;
    if (!pending || pending.settled) return false;
    pending.settled = true;
    if (error === undefined) {
      pending.resolve();
      return true;
    }
    pending.reject(error instanceof Error ? error : new Error(sanitizeProviderDiagnostic(error).text));
    return true;
  }

  private clearActiveTurn(state: SessionState, error: Error): void {
    const active = state.activeTurn;
    if (!active) return;
    this.settlePendingInterrupt(active, error);
    if (state.activeTurn === active) state.activeTurn = undefined;
  }

  private turnMatchesActive(
    active: NonNullable<SessionState['activeTurn']>,
    turn: JsonObject,
    providerTurnId: string,
  ): boolean {
    const commandId = this.commandIdFromTurn(turn);
    if (active.providerTurnId) {
      return active.providerTurnId === providerTurnId
        && (commandId === undefined || commandId === active.commandId);
    }
    return commandId === active.commandId;
  }

  private emitTurnStarted(state: SessionState, active: NonNullable<SessionState['activeTurn']>): void {
    if (active.startedEmitted) return;
    active.startedEmitted = true;
    this.emit({
      kind: 'turn-started',
      sessionId: state.sessionId,
      turnId: active.localTurnId,
      ...(active.providerTurnId ? { providerTurnId: active.providerTurnId } : {}),
      commandId: active.commandId,
    });
  }

  private handleTurnCompleted(state: SessionState, turn: JsonObject | undefined): void {
    if (!turn) return;
    const providerTurnId = asString(turn?.id);
    if (!providerTurnId) return;
    const active = state.activeTurn;
    const matchingActive = active && this.turnMatchesActive(active, turn, providerTurnId)
      ? active
      : undefined;
    if (matchingActive) {
      matchingActive.providerTurnId ??= providerTurnId;
      this.settlePendingInterrupt(matchingActive);
    }
    for (const itemValue of asArray(turn?.items)) {
      this.handleItem(state, providerTurnId, asObject(itemValue), true);
    }
    const outcome = turnStatus(turn?.status);
    const error = asObject(turn?.error);
    const summary = this.lastAssistantText(turn);
    const errorCode = this.codexErrorCode(error?.codexErrorInfo);
    this.emit({
      kind: 'turn-finished',
      sessionId: state.sessionId,
      turnId: matchingActive?.localTurnId ?? `provider:${providerTurnId}`,
      outcome,
      ...(summary ? { summary } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
    if (active && !matchingActive) return;
    if (state.activeTurn === matchingActive) state.activeTurn = undefined;
    this.emit({
      kind: 'session-state',
      sessionId: state.sessionId,
      state: outcome === 'failed' ? 'failed' : outcome === 'interrupted' ? 'interrupted' : 'idle',
      ...(asString(error?.message)
        ? { detail: sanitizeProviderDiagnostic(asString(error?.message)).text }
        : {}),
    });
  }

  private handleItem(
    state: SessionState,
    providerTurnId: string | undefined,
    item: JsonObject | undefined,
    completed: boolean,
  ): void {
    const itemId = asString(item?.id);
    const itemType = asString(item?.type);
    if (!providerTurnId || !item || !itemId || !itemType) return;
    if (itemType === 'collabAgentToolCall' || itemType === 'subAgentActivity') {
      this.emitNativeSubagents(state, item, completed);
    }
    if (completed) {
      const key = `${providerTurnId}:${itemId}:${itemType}`;
      if (state.completedItemKeys.has(key)) return;
      state.completedItemKeys.add(key);
    }
    const transcript = this.transcriptFromItem(
      state.sessionId,
      providerTurnId,
      item,
      ++state.nextTranscriptSequence,
      this.isoNow(),
      !completed,
    );
    if (!transcript) {
      state.nextTranscriptSequence -= 1;
      return;
    }
    this.emit({ kind: 'transcript', item: transcript });
  }

  private emitDelta(
    state: SessionState,
    params: JsonObject,
    kind: 'assistant-message' | 'reasoning',
  ): void {
    const delta = boundedText(params.delta);
    const providerTurnId = asString(params.turnId);
    const providerItemId = asString(params.itemId);
    if (!delta || !providerTurnId || !providerItemId) return;
    state.nextTranscriptSequence += 1;
    this.emit({
      kind: 'transcript',
      item: {
        id: opaqueId('codex_delta', state.providerSessionId, providerTurnId, providerItemId, String(state.nextTranscriptSequence)),
        sessionId: state.sessionId,
        ...(this.localTurnId(state.sessionId, providerTurnId) ? { turnId: this.localTurnId(state.sessionId, providerTurnId) } : {}),
        sequence: state.nextTranscriptSequence,
        kind,
        text: delta,
        isDelta: true,
        isSensitive: true,
        createdAt: this.isoNow(),
      },
    });
  }

  private transcriptFromItem(
    sessionId: string,
    providerTurnId: string,
    item: JsonObject,
    sequence: number,
    createdAt: string,
    started: boolean,
  ): DaemonTranscriptItem | undefined {
    const providerItemId = asString(item.id);
    const type = asString(item.type);
    if (!providerItemId || !type) return undefined;
    let kind: DaemonTranscriptItem['kind'];
    let text = '';
    let isSensitive = false;
    switch (type) {
      case 'userMessage':
        if (started) return undefined;
        kind = 'user-message';
        text = boundedText(item.content);
        break;
      case 'agentMessage':
        if (started) return undefined;
        kind = 'assistant-message';
        text = boundedText(item.text);
        break;
      case 'reasoning':
        if (started) return undefined;
        kind = 'reasoning';
        text = [...asArray(item.summary), ...asArray(item.content)]
          .filter((value): value is string => typeof value === 'string').join('\n').slice(0, MAX_SEMANTIC_TEXT);
        break;
      case 'plan':
        if (started) return undefined;
        kind = 'reasoning';
        text = boundedText(item.text);
        break;
      case 'commandExecution':
        kind = started ? 'tool-call' : 'tool-result';
        text = started
          ? `$ ${boundedText(item.command, 16_000)}`
          : boundedText(item.aggregatedOutput) || `Command ${asString(item.status) ?? 'completed'}.`;
        isSensitive = true;
        break;
      case 'fileChange':
        kind = started ? 'tool-call' : 'tool-result';
        text = this.fileChangeText(item);
        break;
      case 'mcpToolCall':
      case 'dynamicToolCall':
        kind = started ? 'tool-call' : 'tool-result';
        text = `${asString(item.server) ? `${asString(item.server)}/` : ''}${asString(item.tool) ?? 'tool'}: ${asString(item.status) ?? (started ? 'started' : 'completed')}`;
        break;
      case 'functionCallOutput':
        if (started) return undefined;
        kind = 'tool-result';
        text = `${asString(item.name) ?? 'function'} completed.`;
        break;
      case 'collabAgentToolCall':
        kind = 'notice';
        text = `${asString(item.tool) ?? 'Agent action'}: ${asString(item.status) ?? (started ? 'started' : 'completed')}`;
        break;
      case 'subAgentActivity':
        kind = 'notice';
        text = `Sub-agent ${asString(item.kind) ?? 'activity'}.`;
        break;
      case 'webSearch':
        kind = started ? 'tool-call' : 'tool-result';
        text = `Web search ${started ? 'started' : 'completed'}.`;
        break;
      case 'imageView':
      case 'imageGeneration':
        kind = started ? 'tool-call' : 'tool-result';
        text = `${type === 'imageView' ? 'Image view' : 'Image generation'} ${started ? 'started' : 'completed'}.`;
        break;
      case 'enteredReviewMode':
      case 'exitedReviewMode':
      case 'contextCompaction':
      case 'sleep':
      case 'hookPrompt':
        if (started) return undefined;
        kind = 'notice';
        text = type === 'enteredReviewMode'
          ? 'Entered review mode.'
          : type === 'exitedReviewMode'
            ? 'Exited review mode.'
            : type === 'contextCompaction'
              ? 'Context compacted.'
              : type === 'sleep'
                ? 'Agent waited.'
                : 'Provider hook supplied additional context.';
        break;
      default:
        return undefined;
    }
    if (!text) return undefined;
    const sanitized = sanitizeProviderDiagnostic(text, { maxLength: MAX_SEMANTIC_TEXT });
    text = sanitized.text;
    isSensitive ||= sanitized.redacted
      || kind === 'user-message'
      || kind === 'assistant-message'
      || kind === 'reasoning';
    const localTurnId = this.localTurnId(sessionId, providerTurnId);
    return {
      id: opaqueId('codex_item', sessionId, providerTurnId, providerItemId, started ? 'started' : 'completed'),
      sessionId,
      ...(localTurnId ? { turnId: localTurnId } : {}),
      sequence,
      kind,
      text: text.slice(0, MAX_SEMANTIC_TEXT),
      isDelta: false,
      isSensitive,
      createdAt,
    };
  }

  private emitNativeSubagents(state: SessionState, item: JsonObject, completed: boolean): void {
    if (item.type === 'subAgentActivity') {
      const childId = asString(item.agentThreadId);
      if (!childId) return;
      this.emitNativeSubagent(state, childId, path.basename(asString(item.agentPath) ?? childId), nativeState(item.kind));
      return;
    }
    const receiverIds = asArray(item.receiverThreadIds).filter((value): value is string => typeof value === 'string');
    const states = asObject(item.agentsStates);
    const childIds = new Set([...receiverIds, ...Object.keys(states ?? {})]);
    for (const childId of childIds) {
      const childState = asObject(states?.[childId]);
      this.emitNativeSubagent(
        state,
        childId,
        boundedText(item.prompt, 120).split(/\r?\n/u)[0] || asString(item.tool) || 'Codex sub-agent',
        nativeState(childState?.status ?? item.status ?? (completed ? 'completed' : 'inProgress')),
        asString(childState?.message)
          ? sanitizeProviderDiagnostic(asString(childState?.message), { maxLength: 2_000 }).text
          : undefined,
      );
    }
  }

  private emitNativeSubagent(
    state: SessionState,
    childId: string,
    title: string,
    childState: 'starting' | 'working' | 'blocked' | 'done' | 'error',
    summary?: string,
  ): void {
    const signature = `${childState}\0${summary ?? ''}`;
    if (state.nativeStateByChild.get(childId) === signature) return;
    state.nativeStateByChild.set(childId, signature);
    this.emit({
      kind: 'native-subagent',
      sessionId: state.sessionId,
      providerChildId: childId,
      title: title.slice(0, 200),
      state: childState,
      ...(summary ? { summary: summary.slice(0, 2_000) } : {}),
    });
  }

  private fileChangeText(item: JsonObject): string {
    const changes = asArray(item.changes).flatMap((value): string[] => {
      const change = asObject(value);
      const changePath = asString(change?.path);
      return changePath ? [changePath] : [];
    });
    return changes.length > 0 ? `Changed ${changes.join(', ')}`.slice(0, MAX_SEMANTIC_TEXT) : 'File changes updated.';
  }

  private commandIdFromTurn(turn: JsonObject): string | undefined {
    for (const value of asArray(turn.items)) {
      const item = asObject(value);
      if (item?.type !== 'userMessage') continue;
      const clientId = asString(item.clientId);
      if (clientId) return clientId;
    }
    return undefined;
  }

  private lastAssistantText(turn: JsonObject): string {
    const items = [...asArray(turn.items)].reverse();
    for (const value of items) {
      const item = asObject(value);
      if (item?.type === 'agentMessage') return boundedText(item.text, 2_000);
    }
    return '';
  }

  private registerSession(context: ProviderSessionContext, providerSessionId: string, model?: string): SessionState {
    const existingOwner = this.sessionIdByProviderId.get(providerSessionId);
    if (existingOwner && existingOwner !== context.sessionId) {
      throw new Error(`Codex thread ${providerSessionId} is already attached to another EZTerminal session.`);
    }
    const state: SessionState = {
      sessionId: context.sessionId,
      providerSessionId,
      workspaceRoot: context.workspaceRoot,
      ...(model ? { model } : {}),
      permissionPreset: context.permissionPreset,
      nextTranscriptSequence: 0,
      completedItemKeys: new Set(),
      nativeStateByChild: new Map(),
    };
    this.sessions.set(context.sessionId, state);
    this.sessionIdByProviderId.set(providerSessionId, context.sessionId);
    return state;
  }

  private requireSession(sessionId: string, providerSessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state || state.providerSessionId !== providerSessionId) throw new Error(`Codex session ${sessionId} is not attached.`);
    return state;
  }

  private handleFor(state: SessionState): ProviderSessionHandle {
    return {
      sessionId: state.sessionId,
      providerSessionId: state.providerSessionId,
      ...(state.model ? { model: state.model } : {}),
      permissionPreset: state.permissionPreset,
    };
  }

  private localTurnId(sessionId: string, providerTurnId: string): string | undefined {
    const active = this.sessions.get(sessionId)?.activeTurn;
    return active?.providerTurnId === providerTurnId ? active.localTurnId : undefined;
  }

  private turnTime(turn: JsonObject): string {
    const timestamp = typeof turn.startedAt === 'number' ? turn.startedAt : undefined;
    if (timestamp === undefined || !Number.isFinite(timestamp)) return this.isoNow();
    const date = new Date(timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp);
    return Number.isFinite(date.valueOf()) ? date.toISOString() : this.isoNow();
  }

  private codexErrorCode(value: unknown): string | undefined {
    const direct = asString(value);
    if (direct) return direct;
    const object = asObject(value);
    return object ? Object.keys(object)[0] : undefined;
  }

  private isoNow(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new Error('Codex adapter clock returned an invalid Date.');
    return value.toISOString();
  }

  private rpcIdKey(id: CodexJsonRpcId): string {
    return `${typeof id === 'number' ? 'n' : 's'}:${String(id)}`;
  }

  private assertSessionContext(context: ProviderSessionContext): void {
    if (!context.sessionId.trim() || !context.workspaceId.trim()) throw new Error('Codex session identity is incomplete.');
    if (!path.isAbsolute(context.workspaceRoot)) throw new Error('Codex workspace root must be absolute.');
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Codex provider adapter is disposed.');
  }

  private emit(event: AgentProviderEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Provider lifecycle must not be controlled by renderer/listener failures.
      }
    }
  }
}
