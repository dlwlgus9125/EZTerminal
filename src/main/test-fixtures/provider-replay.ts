/**
 * Replays recorded provider protocol traffic (test/fixtures/provider-capture,
 * written by scripts/capture-provider-fixtures.mjs) through the production
 * Claude and Codex adapters, then projects the adapter events into the
 * transcript items and approvals DaemonAgentRuntime would persist.
 *
 * The recording drives the adapter: a recorded prompt submits, a recorded
 * interrupt interrupts, a recorded approval request waits for the adapter's
 * own answer. Only the provider side of the wire is replayed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ApprovalResponse } from '../../shared/approval-request';
import type { DaemonApproval, DaemonTranscriptItem, PermissionPreset } from '../../shared/daemon-protocol';
import type { DeltaCoalescerOptions } from '../delta-coalescer';
import type { AgentProviderAdapter, AgentProviderEvent, ProviderSessionHandle } from '../agent-provider-adapter';
import {
  ClaudeProviderAdapter,
  MemoryClaudeProviderEnablementStore,
  type ClaudeAuthenticationPath,
  type ClaudeQueryFactory,
  type ClaudeQuerySession,
} from '../claude-provider-adapter';
import {
  CodexJsonRpcError,
  type CodexAppServerConnection,
  type CodexConnectionClose,
  type CodexNotificationHandler,
  type CodexServerRequestHandler,
} from '../codex-app-server-client';
import { CodexProviderAdapter } from '../codex-provider-adapter';
import { nativeChildSessionId, routedChildItem, subagentResultItem, subagentStartItems } from '../native-subagent-projection';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const PROVIDER_CAPTURE_DIRECTORY = path.resolve(directory, '../../../test/fixtures/provider-capture');
export const PROVIDER_GOLDEN_DIRECTORY = path.resolve(directory, '../../renderer/chat/fixtures');

const REPLAY_NOW = '2026-10-01T09:00:00.000Z';
const REPLAY_SESSION_ID = 'replay-session';
const REPLAY_WORKSPACE_ID = 'replay-workspace';
const REPLAY_TURN_ID = 'replay-turn-1';
const REPLAY_COMMAND_ID = 'replay-command-1';
const REPLAY_TIMEOUT_MS = 15_000;
/** Any absolute path: a provided queryFactory never spawns the executable. */
const REPLAY_CLAUDE_EXECUTABLE = path.resolve('/replay/claude.exe');
const REPLAY_WORKSPACE_ROOT = path.resolve('/replay-workspace');

type JsonObject = Record<string, unknown>;

export interface ProviderCaptureMeta {
  readonly dir: 'meta';
  readonly provider: 'claude' | 'codex';
  readonly scenario: string;
  readonly prompt: string;
  readonly capturedAt: string;
  readonly capturedWith: Readonly<Record<string, string>>;
  readonly launch?: JsonObject;
  readonly providerSessionId?: string;
  readonly clientUserMessageUuid?: string;
  readonly clientUserMessageId?: string;
  readonly preset?: PermissionPreset;
  readonly model?: string;
  readonly aborted?: string;
  readonly error?: string;
}

export interface JsonRpcFrame {
  readonly jsonrpc?: string;
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type ProviderCaptureLine = { readonly t: number } & (
  | { readonly dir: 'sdk'; readonly msg: SDKMessage }
  | {
      readonly dir: 'canUseTool';
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      readonly options: JsonObject & { readonly toolUseID: string; readonly requestId: string };
      readonly response: PermissionResult;
    }
  | { readonly dir: 'initializationResult'; readonly result: { readonly account?: JsonObject } }
  | { readonly dir: 'prompt'; readonly msg: SDKUserMessage }
  | {
      readonly dir: 'control';
      readonly op: 'interrupt' | 'interrupt-result' | 'close';
      readonly result?: unknown;
      readonly error?: string;
    }
  | { readonly dir: 'out' | 'in'; readonly frame: JsonRpcFrame }
  | { readonly dir: 'in-unparsed'; readonly line: string }
);

export interface ProviderCaptureFixture {
  readonly name: string;
  readonly meta: ProviderCaptureMeta;
  readonly lines: readonly ProviderCaptureLine[];
}

export interface ProviderReplayGolden {
  readonly provider: 'claude' | 'codex';
  readonly scenario: string;
  readonly capturedWith: Readonly<Record<string, string>>;
  /** What DaemonAgentRuntime would persist, in store order. */
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals: readonly DaemonApproval[];
  /** The adapter's own answers to provider approval requests, in order. */
  readonly providerResponses: readonly unknown[];
  /** Provider-native subagents the runtime would show; their rows are in `items` under their own session. */
  readonly sessions?: readonly ProjectedSubagentSession[];
}

export interface ProjectedSubagentSession {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly providerChildId: string;
  readonly title: string;
  readonly subagentType?: string;
  readonly background?: boolean;
  readonly state: 'starting' | 'working' | 'blocked' | 'done' | 'error';
}

export function listProviderCaptureFixtures(captureDirectory = PROVIDER_CAPTURE_DIRECTORY): string[] {
  return readdirSync(captureDirectory)
    .filter((entry) => entry.endsWith('.ndjson'))
    .map((entry) => entry.slice(0, -'.ndjson'.length))
    .sort();
}

export function readProviderCaptureFixture(
  name: string,
  captureDirectory = PROVIDER_CAPTURE_DIRECTORY,
): ProviderCaptureFixture {
  const [meta, ...lines] = readFileSync(path.join(captureDirectory, `${name}.ndjson`), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JsonObject);
  if (meta?.dir !== 'meta') throw new Error(`${name}: the first line must be the capture meta record.`);
  return {
    name,
    meta: meta as unknown as ProviderCaptureMeta,
    lines: lines as unknown as ProviderCaptureLine[],
  };
}

export interface ProviderReplayOptions {
  /** Sees every adapter event, including ones the golden does not record (usage). */
  readonly onEvent?: (event: AgentProviderEvent) => void;
}

export async function replayProviderFixture(
  fixture: ProviderCaptureFixture,
  options: ProviderReplayOptions = {},
): Promise<ProviderReplayGolden> {
  const replay = fixture.meta.provider === 'claude' ? replayClaude(fixture, options) : replayCodex(fixture, options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      replay,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${fixture.name}: replay did not finish within ${String(REPLAY_TIMEOUT_MS)}ms.`)),
          REPLAY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shared replay plumbing

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T = void>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

/** Replaces recorded client identities with the ones the live adapter chose. */
function remapStrings<T>(value: T, replacements: ReadonlyMap<string, string>): T {
  if (replacements.size === 0) return value;
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return replacements.get(entry) ?? entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, visit(child)]));
    }
    return entry;
  };
  return visit(value) as T;
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${String(++next)}`;
}

interface ReplayHarness {
  readonly projection: RuntimeProjection;
  readonly providerResponses: unknown[];
  readonly failures: unknown[];
  /** Approval decisions queued by the fake provider just before it asks. */
  readonly decisions: ReplayDecision[];
  handle?: ProviderSessionHandle;
  readonly onEvent?: (event: AgentProviderEvent) => void;
  run(operation: () => Promise<unknown>): void;
}

interface ReplayDecision {
  readonly decision: 'allow' | 'deny';
  /** The richer answer the recorded user gave (question answers, plan approval). */
  readonly response?: ApprovalResponse;
}

/**
 * Streaming flushes only at block/item boundaries during replay: the timer
 * never fires, so goldens do not depend on wall-clock batching.
 */
export const REPLAY_DELTA_COALESCER: DeltaCoalescerOptions = {
  schedule: () => undefined,
  cancel: () => undefined,
};

/** The user's recorded Claude answer, expressed as the response the UI would send. */
function claudeRecordedDecision(toolName: string, response: PermissionResult): ReplayDecision {
  if (response.behavior !== 'allow') {
    const message = typeof response.message === 'string' ? response.message : '';
    return message && message !== 'Denied by the user.'
      ? { decision: 'deny', response: { kind: 'feedback', message } }
      : { decision: 'deny' };
  }
  const answers = (response.updatedInput as { answers?: unknown } | undefined)?.answers;
  if (toolName === 'AskUserQuestion' && answers && typeof answers === 'object') {
    return { decision: 'allow', response: { kind: 'answers', answers: answers as Record<string, string> } };
  }
  if (toolName === 'ExitPlanMode') return { decision: 'allow', response: { kind: 'plan', mode: 'standard' } };
  return { decision: 'allow' };
}

function createHarness(fixture: ProviderCaptureFixture, options: ProviderReplayOptions): ReplayHarness {
  const harness: ReplayHarness = {
    projection: new RuntimeProjection(fixture.meta.provider, REPLAY_SESSION_ID),
    providerResponses: [],
    failures: [],
    decisions: [],
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    run(operation) {
      operation().catch((error: unknown) => harness.failures.push(error));
    },
  };
  return harness;
}

/**
 * Answers approvals the way the runtime would after the recorded user choice:
 * through the projection (pending -> allowed/denied), then the adapter.
 */
function subscribeHarness(adapter: AgentProviderAdapter, harness: ReplayHarness): () => void {
  return adapter.subscribe((event) => {
    harness.onEvent?.(event);
    const providerSessionId = harness.handle?.providerSessionId ?? '';
    const answer = harness.projection.apply(event, providerSessionId);
    if (event.kind !== 'approval-requested') return;
    const recorded = harness.decisions.shift() ?? { decision: 'deny' };
    // A stale approval is denied by the runtime without asking the user.
    const decision = answer === 'stale' ? 'deny' : recorded.decision;
    const response = answer === 'stale' ? undefined : recorded.response;
    setImmediate(() => harness.run(async () => {
      if (answer !== 'stale') harness.projection.resolveApproval(event.providerRequestId, decision, providerSessionId);
      await adapter.resolveApproval({
        sessionId: event.sessionId,
        providerSessionId,
        providerRequestId: event.providerRequestId,
        decision,
        ...(response ? { response } : {}),
      });
    }));
  });
}

function goldenFor(fixture: ProviderCaptureFixture, harness: ReplayHarness): ProviderReplayGolden {
  if (harness.failures.length) {
    const detail = harness.failures.map((error) => (error instanceof Error ? error.message : String(error))).join('; ');
    throw new Error(`${fixture.name}: adapter operations failed during replay: ${detail}`);
  }
  const sessions = harness.projection.subagentList();
  return {
    provider: fixture.meta.provider,
    scenario: fixture.meta.scenario,
    capturedWith: fixture.meta.capturedWith,
    ...(sessions.length ? { sessions } : {}),
    items: harness.projection.items,
    approvals: harness.projection.approvalList(),
    providerResponses: harness.providerResponses,
  };
}

// ---------------------------------------------------------------------------
// Claude Agent SDK replay

function claudeAuthenticationPath(fixture: ProviderCaptureFixture): ClaudeAuthenticationPath {
  const init = fixture.lines.find((line) => line.dir === 'initializationResult');
  const account = init?.dir === 'initializationResult' ? init.result.account : undefined;
  if (account?.apiProvider === 'firstParty' && (account.subscriptionType || account.tokenSource)) {
    return 'existing-claude-ai-login';
  }
  return account?.apiKeySource === 'ANTHROPIC_API_KEY' ? 'api-key-environment' : 'existing-cli-environment';
}

class ClaudeReplaySession implements ClaudeQuerySession {
  private readonly closed = deferred();
  private isClosed = false;
  private readonly interruptCalled = deferred();
  private readonly signal = new AbortController();

  constructor(
    private readonly fixture: ProviderCaptureFixture,
    private readonly input: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options },
    private readonly harness: ReplayHarness,
    private readonly drive: { submit(): void; interrupt(): void; finished(): void },
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    const prompt = this.input.prompt[Symbol.asyncIterator]();
    const replacements = new Map<string, string>();
    for (const line of this.fixture.lines) {
      if (this.isClosed) return;
      if (line.dir === 'prompt') {
        this.drive.submit();
        const next = await Promise.race([prompt.next(), this.closed.promise.then(() => undefined)]);
        if (!next || next.done) return;
        for (const key of ['uuid', 'session_id'] as const) {
          const recorded = line.msg[key];
          const live = next.value[key];
          if (recorded && live) replacements.set(recorded, live);
        }
      } else if (line.dir === 'sdk') {
        yield remapStrings(line.msg, replacements);
        await settle();
      } else if (line.dir === 'canUseTool') {
        const canUseTool = this.input.options.canUseTool;
        if (!canUseTool) throw new Error(`${this.fixture.name}: the adapter registered no canUseTool callback.`);
        this.harness.decisions.push(claudeRecordedDecision(line.toolName, line.response));
        const result = await canUseTool(line.toolName, line.input, {
          ...line.options,
          signal: this.signal.signal,
        } as Parameters<typeof canUseTool>[2]);
        this.harness.providerResponses.push({ toolName: line.toolName, result });
      } else if (line.dir === 'control' && line.op === 'interrupt') {
        this.drive.interrupt();
        await Promise.race([this.interruptCalled.promise, this.closed.promise]);
      } else if (line.dir === 'control' && line.op === 'close') {
        break;
      }
    }
    this.drive.finished();
    // Ending the stream means the CLI exited; a live session stays open.
    await this.closed.promise;
  }

  async interrupt(): Promise<{ readonly still_queued?: readonly string[] } | undefined> {
    this.interruptCalled.resolve();
    const recorded = this.fixture.lines.find((line) => line.dir === 'control' && line.op === 'interrupt-result');
    return recorded?.dir === 'control' && recorded.result && typeof recorded.result === 'object'
      ? recorded.result as { readonly still_queued?: readonly string[] }
      : undefined;
  }

  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}

  async initializationResult(): Promise<unknown> {
    const recorded = this.fixture.lines.find((line) => line.dir === 'initializationResult');
    if (recorded?.dir !== 'initializationResult') throw new Error(`${this.fixture.name}: no initialization result was recorded.`);
    return { account: recorded.result.account };
  }

  async supportedModels(): Promise<[]> {
    return [];
  }

  close(): void {
    this.isClosed = true;
    this.signal.abort();
    this.closed.resolve();
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    return { done: true, value: undefined };
  }
}

async function replayClaude(fixture: ProviderCaptureFixture, options: ProviderReplayOptions): Promise<ProviderReplayGolden> {
  const harness = createHarness(fixture, options);
  const finished = deferred();
  const sessionCreated = deferred();
  const queryFactory: ClaudeQueryFactory = (input) => new ClaudeReplaySession(fixture, input, harness, {
    submit: () => harness.run(async () => {
      await sessionCreated.promise;
      harness.projection.submit(REPLAY_TURN_ID, REPLAY_COMMAND_ID, fixture.meta.prompt);
      await adapter.submit({
        sessionId: REPLAY_SESSION_ID,
        providerSessionId: harness.handle!.providerSessionId,
        turnId: REPLAY_TURN_ID,
        commandId: REPLAY_COMMAND_ID,
        prompt: fixture.meta.prompt,
      });
    }),
    interrupt: () => harness.run(async () => {
      harness.projection.interruptRequested();
      await adapter.interrupt(REPLAY_SESSION_ID, harness.handle!.providerSessionId);
    }),
    finished: () => finished.resolve(),
  });
  const adapter = new ClaudeProviderAdapter({
    enablementStore: new MemoryClaudeProviderEnablementStore({
      enabled: true,
      termsAccepted: true,
      commercialUseApproved: true,
      authenticationPath: claudeAuthenticationPath(fixture),
      anthropicThirdPartyApproval: true,
    }),
    queryFactory,
    resolveExecutable: async () => REPLAY_CLAUDE_EXECUTABLE,
    readExecutableVersion: async () => fixture.meta.capturedWith.cli ?? 'unknown',
    historyReader: async () => [],
    createId: sequentialIds('replay-claude'),
    now: () => new Date(REPLAY_NOW),
    shutdownTimeoutMs: 1_000,
    deltaCoalescer: REPLAY_DELTA_COALESCER,
  });
  const unsubscribe = subscribeHarness(adapter, harness);
  try {
    harness.handle = await adapter.createSession({
      sessionId: REPLAY_SESSION_ID,
      workspaceId: REPLAY_WORKSPACE_ID,
      workspaceRoot: REPLAY_WORKSPACE_ROOT,
      permissionPreset: claudePermissionPreset(fixture),
    });
    sessionCreated.resolve();
    await finished.promise;
    await settle();
    await adapter.disposeSession(REPLAY_SESSION_ID, harness.handle.providerSessionId);
    return goldenFor(fixture, harness);
  } finally {
    unsubscribe();
    await adapter.dispose();
  }
}

function claudePermissionPreset(fixture: ProviderCaptureFixture): PermissionPreset {
  const mode = fixture.meta.launch?.permissionMode;
  return mode === 'plan' ? 'plan' : mode === 'bypassPermissions' ? 'full-access' : 'standard';
}

// ---------------------------------------------------------------------------
// Codex app-server replay

interface PendingCall {
  readonly method: string;
  readonly params: unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class CodexReplayConnection implements CodexAppServerConnection {
  private readonly notificationHandlers = new Map<string, Set<CodexNotificationHandler>>();
  private readonly serverRequestHandlers = new Map<string, CodexServerRequestHandler>();
  private readonly closeListeners = new Set<(event: CodexConnectionClose) => void>();
  private readonly calls: PendingCall[] = [];
  private callArrived = deferred();

  constructor(private readonly fixture: ProviderCaptureFixture) {}

  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.calls.push({ method, params, resolve, reject });
      this.callArrived.resolve();
    });
  }

  async notify(): Promise<void> {}

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
    this.serverRequestHandlers.set(method, handler);
    return () => this.serverRequestHandlers.delete(method);
  }

  onClose(listener: (event: CodexConnectionClose) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    for (const call of this.calls.splice(0)) call.reject(new Error('Codex replay connection stopped.'));
    for (const listener of [...this.closeListeners]) listener({ expected: true, message: 'Codex replay connection stopped.' });
  }

  /** Walks the recording; each recorded client request waits for the adapter to make it. */
  async run(harness: ReplayHarness, trigger: (method: string) => void): Promise<void> {
    const bound = new Map<string | number, PendingCall>();
    const skipped = new Set<string | number>();
    const replacements = new Map<string, string>();
    for (const line of this.fixture.lines) {
      if (line.dir === 'out') {
        const frame = line.frame;
        if (!frame.method || frame.id === undefined) continue;
        // The transport (CodexAppServerClient) owns the handshake, not the adapter.
        if (frame.method === 'initialize') {
          skipped.add(frame.id);
          continue;
        }
        trigger(frame.method);
        const call = await this.takeCall(frame.method);
        const recordedClientId = (frame.params as JsonObject | undefined)?.clientUserMessageId;
        const liveClientId = (call.params as JsonObject | undefined)?.clientUserMessageId;
        if (typeof recordedClientId === 'string' && typeof liveClientId === 'string') {
          replacements.set(recordedClientId, liveClientId);
        }
        bound.set(frame.id, call);
        continue;
      }
      if (line.dir !== 'in') continue;
      const frame = remapStrings(line.frame, replacements);
      const isMethod = typeof frame.method === 'string' && !('result' in frame) && !('error' in frame);
      if (!isMethod) {
        if (frame.id === undefined || skipped.has(frame.id)) continue;
        const call = bound.get(frame.id);
        if (!call) throw new Error(`${this.fixture.name}: response ${String(frame.id)} has no recorded request.`);
        bound.delete(frame.id);
        if (frame.error) call.reject(new CodexJsonRpcError(call.method, frame.error.code, frame.error.message, frame.error.data));
        else call.resolve(frame.result);
        await settle();
        continue;
      }
      const method = frame.method!;
      if (frame.id !== undefined) {
        const handler = this.serverRequestHandlers.get(method);
        if (!handler) {
          // CodexAppServerClient rejects unregistered server requests with -32601.
          harness.providerResponses.push({ method, error: { code: -32601 } });
          continue;
        }
        harness.decisions.push(recordedCodexReplayDecision(this.fixture, frame.id, frame.params));
        try {
          harness.providerResponses.push({ method, result: await handler(frame.params, { id: frame.id, method }) });
        } catch (error) {
          harness.providerResponses.push({ method, error: { code: -32000, message: (error as Error).message } });
        }
        await settle();
        continue;
      }
      for (const handler of [
        ...(this.notificationHandlers.get(method) ?? []),
        ...(this.notificationHandlers.get('*') ?? []),
      ]) {
        await handler(frame.params, method);
      }
      await settle();
    }
  }

  private async takeCall(method: string): Promise<PendingCall> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const index = this.calls.findIndex((call) => call.method === method);
      if (index >= 0) return this.calls.splice(index, 1)[0]!;
      if (Date.now() > deadline) {
        throw new Error(`${this.fixture.name}: the adapter never sent recorded request ${method}.`);
      }
      this.callArrived = deferred();
      await Promise.race([this.callArrived.promise, new Promise((resolve) => setTimeout(resolve, 50))]);
    }
  }
}

/**
 * The recorded Codex answer as the UI would send it: plan-mode questions carry
 * the chosen labels, keyed by question text as the question card keys them.
 */
function recordedCodexReplayDecision(fixture: ProviderCaptureFixture, id: string | number, params: unknown): ReplayDecision {
  const answer = fixture.lines.find((line) => line.dir === 'out' && line.frame.id === id && !line.frame.method);
  const recorded = answer?.dir === 'out' ? (answer.frame.result as JsonObject | undefined)?.answers as Record<string, { answers?: unknown }> | undefined : undefined;
  if (recorded && Object.keys(recorded).length > 0) {
    const questions = ((params as { questions?: unknown } | undefined)?.questions ?? []) as readonly { id?: string; question?: string }[];
    const answers = Object.fromEntries(questions.flatMap((question) => {
      const chosen = question.id ? recorded[question.id]?.answers : undefined;
      return question.question && Array.isArray(chosen) && typeof chosen[0] === 'string' ? [[question.question, chosen[0]]] : [];
    }));
    return { decision: 'allow', response: { kind: 'answers', answers } };
  }
  return { decision: recordedCodexDecision(fixture, id) };
}

function recordedCodexDecision(fixture: ProviderCaptureFixture, id: string | number): 'allow' | 'deny' {
  const answer = fixture.lines.find((line) => (
    line.dir === 'out' && line.frame.id === id && !line.frame.method
  ));
  const result = answer?.dir === 'out' ? answer.frame.result as JsonObject | undefined : undefined;
  if (result?.decision === 'accept' || result?.decision === 'acceptForSession' || result?.decision === 'approved') return 'allow';
  if (result?.action === 'accept') return 'allow';
  const permissions = result?.permissions as JsonObject | undefined;
  return permissions && Object.keys(permissions).length > 0 ? 'allow' : 'deny';
}

async function replayCodex(fixture: ProviderCaptureFixture, options: ProviderReplayOptions): Promise<ProviderReplayGolden> {
  const harness = createHarness(fixture, options);
  const connection = new CodexReplayConnection(fixture);
  const adapter = new CodexProviderAdapter({
    connection,
    now: () => new Date(REPLAY_NOW),
    idFactory: sequentialIds('replay-codex'),
    deltaCoalescer: REPLAY_DELTA_COALESCER,
  });
  const unsubscribe = subscribeHarness(adapter, harness);
  const commandId = fixture.meta.clientUserMessageId ?? REPLAY_COMMAND_ID;
  const trigger = (method: string): void => {
    switch (method) {
      case 'thread/start':
        harness.run(async () => {
          harness.handle = await adapter.createSession({
            sessionId: REPLAY_SESSION_ID,
            workspaceId: REPLAY_WORKSPACE_ID,
            workspaceRoot: REPLAY_WORKSPACE_ROOT,
            permissionPreset: fixture.meta.preset ?? 'standard',
          });
        });
        return;
      case 'turn/start':
        harness.projection.submit(REPLAY_TURN_ID, commandId, fixture.meta.prompt);
        harness.run(() => adapter.submit({
          sessionId: REPLAY_SESSION_ID,
          providerSessionId: harness.handle!.providerSessionId,
          turnId: REPLAY_TURN_ID,
          commandId,
          prompt: fixture.meta.prompt,
        }));
        return;
      case 'turn/interrupt':
        harness.projection.interruptRequested();
        harness.run(() => adapter.interrupt(REPLAY_SESSION_ID, harness.handle!.providerSessionId));
        return;
      case 'thread/unsubscribe':
        harness.run(() => adapter.disposeSession(REPLAY_SESSION_ID, harness.handle!.providerSessionId));
        return;
      default:
        return;
    }
  };
  try {
    await connection.run(harness, trigger);
    await settle();
    return goldenFor(fixture, harness);
  } finally {
    unsubscribe();
    await adapter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Runtime projection
//
// DaemonAgentRuntime does not export its event-to-store mapping, so this is a
// minimal replica of handleProviderEvent's transcript and approval effects
// (plus the store's id-dedupe and per-session sequence assignment) for a
// single-turn session. Agent/session state and timers are not modelled.

type TurnState = 'submitting' | 'working' | 'blocked' | 'delivery-uncertain' | 'completed' | 'interrupted' | 'failed';

const TERMINAL_TURN_STATES = new Set<TurnState>(['completed', 'interrupted', 'failed']);
const MAX_CHILD_SUMMARY_LENGTH = 2_000;

/** Same derivation as daemon-agent-runtime.ts stableId. */
function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

interface ProjectedTurn {
  readonly id: string;
  readonly commandId: string;
  state: TurnState;
  providerTurnId?: string;
  interruptPending: boolean;
}

type TranscriptInput = Omit<DaemonTranscriptItem, 'sequence' | 'createdAt'> & { readonly createdAt?: string };

class RuntimeProjection {
  readonly items: DaemonTranscriptItem[] = [];
  private readonly approvals = new Map<string, DaemonApproval>();
  private readonly subagents = new Map<string, ProjectedSubagentSession>();
  private readonly subagentCalls = new Map<string, string>();
  private turn: ProjectedTurn | undefined;
  private currentTurnId: string | undefined;

  constructor(private readonly providerId: string, private readonly sessionId: string) {}

  approvalList(): DaemonApproval[] {
    return [...this.approvals.values()];
  }

  subagentList(): ProjectedSubagentSession[] {
    return [...this.subagents.values()];
  }

  /** agent.submit acceptance writes the user's message before provider dispatch. */
  submit(turnId: string, commandId: string, prompt: string): void {
    this.turn = { id: turnId, commandId, state: 'submitting', interruptPending: false };
    this.currentTurnId = turnId;
    this.append({
      id: stableId('message', commandId, 'user'),
      sessionId: this.sessionId,
      turnId,
      kind: 'user-message',
      text: prompt,
      isDelta: false,
      isSensitive: false,
    });
  }

  /** agent.interrupt fences the active turn as delivery-uncertain/interrupt-requested. */
  interruptRequested(): void {
    const turn = this.activeTurn();
    if (!turn || turn.id !== this.currentTurnId) return;
    turn.state = 'delivery-uncertain';
    turn.interruptPending = true;
  }

  resolveApproval(providerRequestId: string, decision: 'allow' | 'deny', providerSessionId: string): void {
    const id = stableId('approval', this.providerId, providerSessionId, this.sessionId, providerRequestId);
    const approval = this.approvals.get(id);
    if (!approval || approval.state !== 'pending') {
      throw new Error(`Approval ${providerRequestId} is not pending in the runtime projection.`);
    }
    this.setApproval(approval, decision === 'allow' ? 'allowed' : 'denied');
    const turn = this.activeTurn();
    if (turn && !turn.interruptPending) turn.state = 'working';
  }

  /** Returns 'stale' for an approval the runtime would deny without asking. */
  apply(event: AgentProviderEvent, providerSessionId: string): 'stale' | undefined {
    switch (event.kind) {
      case 'transcript': {
        const item = event.item;
        if (item.sessionId !== this.sessionId) return undefined;
        if (event.providerChildId) {
          // DaemonAgentRuntime.routeSubagentTranscript: only into a shown subagent.
          const childId = nativeChildSessionId(this.providerId, item.sessionId, event.providerChildId);
          if (this.subagents.has(childId)) this.append(routedChildItem(item, childId));
          return undefined;
        }
        if (item.turnId !== undefined && item.turnId !== this.turn?.id) return undefined;
        this.append({
          id: item.id,
          ...(item.messageId ? { messageId: item.messageId } : {}),
          sessionId: item.sessionId,
          ...(item.turnId ? { turnId: item.turnId } : {}),
          kind: item.kind,
          text: item.text,
          isDelta: item.isDelta,
          isSensitive: item.isSensitive,
          ...(item.relatedSessionId ? { relatedSessionId: item.relatedSessionId } : {}),
          ...(item.context ? { context: item.context } : {}),
          ...(item.payload ? { payload: item.payload } : {}),
          createdAt: item.createdAt,
        });
        return undefined;
      }
      case 'session-state': {
        if (event.state === 'failed') {
          this.terminateActive('failed');
          this.expireApprovals(undefined, true);
          this.currentTurnId = undefined;
          return undefined;
        }
        const turn = this.activeTurn();
        if (!turn || turn.id !== this.currentTurnId || turn.interruptPending) return undefined;
        if (event.state === 'blocked') turn.state = 'blocked';
        else if (event.state === 'working' && turn.state !== 'blocked') turn.state = 'working';
        return undefined;
      }
      case 'turn-started': {
        const turn = this.turn;
        if (!turn || (turn.id !== event.turnId && turn.commandId !== event.commandId)) return undefined;
        if (TERMINAL_TURN_STATES.has(turn.state)) return undefined;
        if (event.providerTurnId) turn.providerTurnId = event.providerTurnId;
        if (!turn.interruptPending) turn.state = 'working';
        this.currentTurnId = turn.id;
        return undefined;
      }
      case 'turn-finished': {
        const providerTurnId = event.turnId.startsWith('provider:') ? event.turnId.slice('provider:'.length) : undefined;
        const turn = this.turn;
        if (!turn || (turn.id !== event.turnId && (providerTurnId === undefined || turn.providerTurnId !== providerTurnId))) {
          return undefined;
        }
        if (TERMINAL_TURN_STATES.has(turn.state)) return undefined;
        turn.state = event.outcome;
        if (this.currentTurnId === turn.id) {
          this.expireApprovals(turn.id, true);
          this.currentTurnId = undefined;
        }
        const summary = event.summary?.trim().slice(0, MAX_CHILD_SUMMARY_LENGTH);
        if (summary) {
          this.append({
            id: stableId('turn-summary', this.providerId, this.sessionId, turn.id, event.outcome, summary),
            sessionId: this.sessionId,
            turnId: turn.id,
            kind: 'notice',
            text: summary,
            isDelta: false,
            isSensitive: false,
          });
        }
        return undefined;
      }
      case 'approval-requested': {
        const id = stableId('approval', this.providerId, providerSessionId, event.sessionId, event.providerRequestId);
        if (this.approvals.has(id)) return undefined;
        // A subagent's request is labelled with it and not tied to the parent's turn.
        const subagent = event.providerChildId
          ? this.subagents.get(nativeChildSessionId(this.providerId, event.sessionId, event.providerChildId))
          : undefined;
        const turnId = event.providerChildId ? undefined : event.turnId ?? this.currentTurnId;
        const turn = turnId !== undefined && this.turn?.id === turnId ? this.turn : undefined;
        const request = event.request && subagent
          ? { ...event.request, subagent: { sessionId: subagent.sessionId, title: subagent.title } }
          : event.request;
        const detail = subagent ? `${subagent.title}: ${event.detail ?? event.title}` : event.detail;
        const stale = (event.turnId !== undefined && (!turn || TERMINAL_TURN_STATES.has(turn.state)))
          || (turn !== undefined && this.currentTurnId !== turn.id);
        this.approvals.set(id, {
          id,
          sessionId: event.sessionId,
          ...(turn ? { turnId: turn.id } : {}),
          providerRequestId: event.providerRequestId,
          risk: event.risk,
          title: event.title,
          ...(detail ? { detail } : {}),
          ...(request ? { request } : {}),
          state: stale ? 'expired' : 'pending',
          ...(stale ? { resolvedAt: REPLAY_NOW } : {}),
          revision: 1,
          createdAt: REPLAY_NOW,
          updatedAt: REPLAY_NOW,
        });
        if (!stale && turn) turn.state = 'blocked';
        return stale ? 'stale' : undefined;
      }
      case 'provider-error':
        this.applyProviderError(event);
        return undefined;
      case 'native-subagent':
        this.applySubagent(event);
        return undefined;
      case 'usage':
        return undefined;
    }
  }

  private applyProviderError(event: Extract<AgentProviderEvent, { kind: 'provider-error' }>): void {
    if (event.sessionId !== this.sessionId) return;
    if (event.turnScope) {
      const scope = event.turnScope;
      const turn = this.turn && (scope.turnId
        ? this.turn.id === scope.turnId
          && (!scope.providerTurnId || !this.turn.providerTurnId || this.turn.providerTurnId === scope.providerTurnId)
        : this.turn.providerTurnId === scope.providerTurnId)
        ? this.turn
        : undefined;
      if (!turn || TERMINAL_TURN_STATES.has(turn.state)) return;
      const isCurrent = this.currentTurnId === turn.id;
      if (event.recoverable) {
        if (!turn.interruptPending) turn.state = 'delivery-uncertain';
      } else {
        turn.state = 'failed';
        this.expireApprovals(turn.id, isCurrent);
        if (isCurrent) this.currentTurnId = undefined;
      }
      this.append({
        id: stableId('provider-error', this.providerId, this.sessionId, turn.id, event.code, event.message),
        sessionId: this.sessionId,
        turnId: turn.id,
        kind: 'error',
        text: event.message,
        isDelta: false,
        isSensitive: false,
      });
      return;
    }
    const turn = this.currentTurnId !== undefined && this.turn?.id === this.currentTurnId ? this.turn : undefined;
    if (!event.recoverable) {
      this.terminateActive('failed');
      this.expireApprovals(undefined, true);
      this.currentTurnId = undefined;
    } else if (turn && !TERMINAL_TURN_STATES.has(turn.state) && !turn.interruptPending) {
      turn.state = 'delivery-uncertain';
    }
    this.append({
      id: stableId('provider-error', this.providerId, this.sessionId, event.code, event.message),
      sessionId: this.sessionId,
      ...(turn ? { turnId: turn.id } : {}),
      kind: 'error',
      text: event.message,
      isDelta: false,
      isSensitive: false,
    });
  }

  private activeTurn(): ProjectedTurn | undefined {
    return this.turn && !TERMINAL_TURN_STATES.has(this.turn.state) ? this.turn : undefined;
  }

  private terminateActive(state: 'failed' | 'interrupted'): void {
    const turn = this.activeTurn();
    if (turn) turn.state = state;
  }

  private expireApprovals(turnId: string | undefined, includeUnscoped: boolean): void {
    for (const approval of this.approvals.values()) {
      if (approval.state !== 'pending') continue;
      if (turnId === undefined || approval.turnId === turnId || (includeUnscoped && approval.turnId === undefined)) {
        this.setApproval(approval, 'expired');
      }
    }
  }

  private setApproval(approval: DaemonApproval, state: DaemonApproval['state']): void {
    this.approvals.set(approval.id, {
      ...approval,
      state,
      resolvedAt: REPLAY_NOW,
      revision: approval.revision + 1,
      updatedAt: REPLAY_NOW,
    });
  }

  /** DaemonAgentRuntime.handleNativeSubagent, without session/agent state and limits. */
  private applySubagent(event: Extract<AgentProviderEvent, { kind: 'native-subagent' }>): void {
    if (event.sessionId !== this.sessionId) return;
    const childId = nativeChildSessionId(this.providerId, event.sessionId, event.providerChildId);
    const nestedParentId = event.parentProviderChildId
      ? nativeChildSessionId(this.providerId, event.sessionId, event.parentProviderChildId)
      : undefined;
    let child = this.subagents.get(childId);
    if (!child) {
      const parentSessionId = nestedParentId && this.subagents.has(nestedParentId) ? nestedParentId : this.sessionId;
      child = {
        sessionId: childId,
        parentSessionId,
        providerChildId: event.providerChildId,
        title: event.title,
        ...(event.subagentType ? { subagentType: event.subagentType } : {}),
        ...(event.background !== undefined ? { background: event.background } : {}),
        state: event.state,
      };
      this.subagents.set(childId, child);
      if (event.toolUseId) this.subagentCalls.set(childId, event.toolUseId);
      for (const item of subagentStartItems({
        providerId: this.providerId,
        rootSessionId: event.sessionId,
        parentSessionId,
        childSessionId: childId,
        providerChildId: event.providerChildId,
        title: event.title,
        ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
        ...(event.subagentType ? { subagentType: event.subagentType } : {}),
        ...(event.background !== undefined ? { background: event.background } : {}),
        ...(event.instruction ? { instruction: event.instruction } : {}),
        ...(parentSessionId === this.sessionId && this.currentTurnId ? { parentTurnId: this.currentTurnId } : {}),
        createdAt: REPLAY_NOW,
      })) this.append(item);
    }
    const terminal = child.state === 'done' || child.state === 'error';
    if (!terminal) this.subagents.set(childId, { ...child, state: event.state });
    if ((event.state === 'done' || event.state === 'error') && event.summary) {
      const result = subagentResultItem({
        providerId: this.providerId,
        rootSessionId: event.sessionId,
        parentSessionId: child.parentSessionId,
        childSessionId: childId,
        providerChildId: event.providerChildId,
        ...(event.toolUseId ?? this.subagentCalls.get(childId) ? { toolUseId: event.toolUseId ?? this.subagentCalls.get(childId)! } : {}),
        state: event.state,
        summary: event.summary,
        ...(child.parentSessionId === this.sessionId && this.currentTurnId ? { parentTurnId: this.currentTurnId } : {}),
        createdAt: REPLAY_NOW,
      });
      if (result) this.append(result);
    }
  }

  /** DaemonStore.appendTranscriptItems: a known id is a no-op; sequence is per session. */
  private append(input: TranscriptInput): void {
    if (this.items.some((item) => item.id === input.id)) return;
    const previous = this.items.filter((item) => item.sessionId === input.sessionId).length;
    this.items.push({ ...input, sequence: previous + 1, createdAt: input.createdAt ?? REPLAY_NOW });
  }
}
