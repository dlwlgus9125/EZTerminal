import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import type {
  DaemonTranscriptItem,
  PermissionPreset,
} from '../shared/daemon-protocol';
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

export const CODEX_APP_SERVER_BASELINE_VERSION = '0.152.1';
const MAX_MODELS = 2_000;
const MAX_MODEL_PAGES = 40;
const MAX_SEMANTIC_TEXT = 1024 * 1024;
const MAX_PROBE_OUTPUT = 64 * 1024;

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
  readonly executable?: string;
  readonly clientOptions?: Omit<CodexAppServerClientOptions, 'command'>;
  readonly resolveExecutable?: (command: string, signal?: AbortSignal) => Promise<string>;
  readonly runCommand?: (command: string, argv: readonly string[], signal?: AbortSignal) => Promise<CodexCommandResult>;
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
  if (typeof value === 'string') return value.slice(0, maximum);
  if (!Array.isArray(value)) return '';
  return value.flatMap((entry): string[] => {
    if (typeof entry === 'string') return [entry];
    const object = asObject(entry);
    const text = asString(object?.text) ?? asString(object?.content);
    return text ? [text] : [];
  }).join('\n').slice(0, maximum);
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
  private readonly connection: CodexAppServerConnection;
  private readonly resolveExecutable: (command: string, signal?: AbortSignal) => Promise<string>;
  private readonly runCommand: (command: string, argv: readonly string[], signal?: AbortSignal) => Promise<CodexCommandResult>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly listeners = new Set<AgentProviderEventListener>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionIdByProviderId = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly unregister: Array<() => void> = [];
  private disposed = false;

  constructor(options: CodexProviderAdapterOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.runCommand = options.runCommand ?? runExternalCommand;
    this.resolveExecutable = options.resolveExecutable
      ?? ((command, signal) => canonicalExecutable(command, this.runCommand, signal));
    this.connection = options.connection ?? new CodexAppServerClient({
      ...options.clientOptions,
      command: this.executable,
    });
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.installConnectionHandlers();
  }

  async probe(signal?: AbortSignal): Promise<ProviderProbeResult> {
    try {
      const executablePath = await this.resolveExecutable(this.executable, signal);
      const result = await this.runCommand(executablePath, ['--version'], signal);
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
        argv: ['app-server'],
        environmentVariableNames: ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'],
        capabilities: [
          'create', 'resume', 'interrupt', 'model-change', 'permission-change',
          'approvals', 'native-subagents', 'history-reconciliation',
        ],
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
        argv: ['app-server'],
        environmentVariableNames: ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'],
        capabilities: [
          'create', 'resume', 'interrupt', 'model-change', 'permission-change',
          'approvals', 'native-subagents', 'history-reconciliation',
        ],
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(signal?: AbortSignal): Promise<readonly ProviderModel[]> {
    this.assertActive();
    const models: ProviderModel[] = [];
    const seenModels = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES && models.length < MAX_MODELS; page += 1) {
      const result = asObject(await this.connection.request('model/list', {
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
    if (this.sessions.has(context.sessionId)) throw new Error(`Codex session ${context.sessionId} already exists.`);
    this.emit({ kind: 'session-state', sessionId: context.sessionId, state: 'starting' });
    try {
      const config = orchestrationConfig(context);
      const result = asObject(await this.connection.request('thread/start', {
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
      const state = this.registerSession(context, providerSessionId, asString(result?.model) ?? context.model);
      this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'idle' });
      return this.handleFor(state);
    } catch (error) {
      this.emit({
        kind: 'session-state', sessionId: context.sessionId, state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
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
    if (this.sessions.has(context.sessionId)) throw new Error(`Codex session ${context.sessionId} already exists.`);
    this.emit({ kind: 'session-state', sessionId: context.sessionId, state: 'starting' });
    try {
      const config = orchestrationConfig(context);
      const result = asObject(await this.connection.request('thread/resume', {
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
      const state = this.registerSession(context, resumedId, asString(result?.model) ?? context.model);
      this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'idle' });
      return this.handleFor(state);
    } catch (error) {
      this.emit({
        kind: 'session-state', sessionId: context.sessionId, state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
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
      const result = asObject(await this.connection.request('turn/start', {
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
      this.emitTurnStarted(state, activeTurn);
    } catch (error) {
      if (state.activeTurn?.commandId === input.commandId) state.activeTurn = undefined;
      this.emit({
        kind: 'provider-error',
        sessionId: input.sessionId,
        code: 'turn-start-failed',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
      throw error;
    }
  }

  async interrupt(sessionId: string, providerSessionId: string): Promise<void> {
    this.assertActive();
    const state = this.requireSession(sessionId, providerSessionId);
    const providerTurnId = state.activeTurn?.providerTurnId;
    if (!providerTurnId) throw new Error(`Codex session ${sessionId} has no interruptible provider turn.`);
    await this.connection.request('turn/interrupt', { threadId: providerSessionId, turnId: providerTurnId });
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
    await this.connection.request('thread/settings/update', {
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
    const result = asObject(await this.connection.request('thread/read', {
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
    for (const approval of [...this.pendingApprovals.values()]) {
      if (approval.sessionId !== sessionId) continue;
      this.pendingApprovals.delete(approval.providerRequestId);
      approval.resolve(this.approvalResponse(approval, 'deny'));
    }
    try {
      await this.connection.request('thread/unsubscribe', { threadId: providerSessionId });
    } finally {
      this.sessions.delete(state.sessionId);
      this.sessionIdByProviderId.delete(state.providerSessionId);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const approval of this.pendingApprovals.values()) {
      approval.resolve(this.approvalResponse(approval, 'deny'));
    }
    this.pendingApprovals.clear();
    for (const unregister of this.unregister.splice(0)) unregister();
    this.sessions.clear();
    this.sessionIdByProviderId.clear();
    this.listeners.clear();
    await this.connection.dispose();
  }

  private installConnectionHandlers(): void {
    this.unregister.push(
      this.connection.onNotification('*', (params, method) => this.handleNotification(method, params)),
      this.connection.onClose((event) => {
        if (event.expected || this.disposed) return;
        for (const approval of this.pendingApprovals.values()) {
          approval.resolve(this.approvalResponse(approval, 'deny'));
        }
        this.pendingApprovals.clear();
        for (const state of this.sessions.values()) {
          this.emit({
            kind: 'provider-error', sessionId: state.sessionId, code: 'app-server-exited',
            message: event.message, recoverable: true,
          });
          this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'failed', detail: event.message });
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
      this.unregister.push(this.connection.onServerRequest(
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
      this.emit({
        kind: 'provider-error',
        ...(sessionId ? { sessionId } : {}),
        code: 'codex-turn-error',
        message: asString(error?.message) ?? 'Codex reported an unknown error.',
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
        this.emit({ kind: 'session-state', sessionId: state.sessionId, state: 'failed' });
        break;
      case 'notLoaded':
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
    } else {
      state.activeTurn.providerTurnId = providerTurnId;
    }
    this.emitTurnStarted(state, state.activeTurn);
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
      turnId: active?.localTurnId ?? `provider:${providerTurnId}`,
      outcome,
      ...(summary ? { summary } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
    if (state.activeTurn?.providerTurnId === providerTurnId || state.activeTurn === active) state.activeTurn = undefined;
    this.emit({
      kind: 'session-state',
      sessionId: state.sessionId,
      state: outcome === 'failed' ? 'failed' : outcome === 'interrupted' ? 'interrupted' : 'idle',
      ...(asString(error?.message) ? { detail: asString(error?.message) } : {}),
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
        isSensitive: false,
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
        asString(childState?.message),
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
