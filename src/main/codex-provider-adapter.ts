import { DeltaCoalescer, type DeltaCoalescerOptions } from './delta-coalescer';
import { PROPOSED_PLAN_REQUEST_PREFIX, clipApprovalBody, type ApprovalRequest, type ApprovalResponse } from '../shared/approval-request';
import { encodeFileChanges } from '../shared/conversation-changes';
import type { TodoItem, ToolCategory, ToolPayload, TranscriptPayload } from '../shared/transcript-payload';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import crossSpawn from 'cross-spawn';
import { promptWithChatContext } from '../shared/chat-message';
import type { AgentCapabilityItem, AgentExtensionCommand, ProviderCapabilityCatalog } from '../shared/agent-capabilities';
import { codexMcpArguments, runNativeExtensionCommand } from './agent-native-extensions';

import type {
  DaemonTranscriptItem,
  PermissionPreset,
} from '../shared/daemon-protocol';
import {
  CODEX_FIRST_LAUNCH_AUTHENTICATION_DETAIL,
  type ProviderLaunchDescriptor,
} from '../shared/daemon-provider';
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
import { compareSemanticVersions, semanticVersion } from './provider-version';
import { providerTranscriptText } from './provider-transcript';

export const CODEX_APP_SERVER_BASELINE_VERSION = '0.152.1';
const MAX_MODELS = 2_000;
const MAX_MODEL_PAGES = 40;
const MAX_SEMANTIC_TEXT = 1024 * 1024;
const MAX_PROBE_OUTPUT = 64 * 1024;
const MAX_PRE_RESPONSE_LIFECYCLE_TURNS = 8;
const MAX_STARTED_ITEMS = 64;
const MAX_SUBMITTED_COMMANDS = 64;
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

type PreResponseLifecycleEvent =
  | { readonly kind: 'started'; readonly turn: JsonObject }
  | { readonly kind: 'completed'; readonly turn: JsonObject }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly recoverable: boolean;
    };

interface PreResponseLifecycleRecord {
  started?: Extract<PreResponseLifecycleEvent, { readonly kind: 'started' }>;
  retryableError?: Extract<PreResponseLifecycleEvent, { readonly kind: 'error' }>;
  terminal?: Extract<PreResponseLifecycleEvent, { readonly kind: 'completed' | 'error' }>;
}

export interface CodexCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface StartedItem {
  readonly providerTurnId: string;
  readonly item: JsonObject;
  readonly startedAtMs?: number;
}

interface SessionState {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly workspaceRoot: string;
  model?: string;
  readonly reasoningEffort?: string;
  permissionPreset: PermissionPreset;
  /** Codex's collaboration mode on this thread; a plan turn leaves it in plan until a turn asks for default. */
  threadMode?: 'plan' | 'default';
  /** Said once per session that this Codex cannot plan, so plan mode runs read-only. */
  planUnsupportedNoticed?: boolean;
  /** The last plan Codex proposed in the current turn. */
  proposedPlan?: { readonly providerTurnId: string; readonly markdown: string };
  nextTranscriptSequence: number;
  activeTurn?: {
    readonly localTurnId: string;
    readonly commandId: string;
    providerTurnId?: string;
    startedEmitted: boolean;
    /** A person's turn in Codex plan mode: its proposed plan is asked about when it ends. */
    planMode?: boolean;
    interruptRequest?: {
      readonly promise: Promise<void>;
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
      dispatched: boolean;
      settled: boolean;
    };
  };
  readonly preResponseLifecycle: Map<string, PreResponseLifecycleRecord>;
  preResponseLifecycleOverflowed: boolean;
  readonly completedItemKeys: Set<string>;
  readonly nativeStateByChild: Map<string, string>;
  readonly deltas: DeltaCoalescer;
  /** In-flight items by id: reasoning timing, the diff a file approval lacks, rows to close on interrupt. */
  readonly startedItems: Map<string, StartedItem>;
  /** The runtime already persisted these prompts, so Codex's echo of them is dropped. */
  readonly submittedCommandIds: Set<string>;
  readonly planRevisions: Map<string, number>;
  /**
   * Set on the shadow state of a sub-agent thread: its rows belong to that
   * sub-agent (the daemon re-homes them), its turns are not the parent's.
   */
  readonly subagentOf?: string;
  /** The state that started this sub-agent (the session's own, or another sub-agent's). */
  readonly subagentParent?: SessionState;
  readonly subagentTitle?: string;
  /** The sub-agent's latest answer, sent back to its parent when it finishes. */
  lastAgentMessage?: string;
}

type ApprovalKind = 'command' | 'file-change' | 'permissions' | 'mcp-tool' | 'legacy-command' | 'legacy-file-change' | 'user-input' | 'proposed-plan';

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
  /** Streaming batch timing; replay passes a scheduler that never fires so goldens are deterministic. */
  readonly deltaCoalescer?: DeltaCoalescerOptions;
  /** Enable Codex's `update_plan` tool so plan progress arrives as turn/plan/updated (default true). */
  readonly enableUpdatePlan?: boolean;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function requireObjectResult(method: string, value: unknown): JsonObject {
  const result = asObject(value);
  if (!result) throw new Error(`Codex ${method} returned an invalid result.`);
  return result;
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

/** Codex's request_user_input questions, bounded like the question card (4 questions, 8 options). */
function userInputQuestions(params: JsonObject): readonly {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
}[] {
  return asArray(params.questions).flatMap((value) => {
    const question = asObject(value);
    const id = asString(question?.id);
    const text = asString(question?.question);
    if (!question || !id || !text) return [];
    const header = asString(question.header);
    const options = asArray(question.options).flatMap((option) => {
      const label = asString(asObject(option)?.label);
      const description = asString(asObject(option)?.description);
      return label ? [{ label, ...(description ? { description } : {}) }] : [];
    }).slice(0, 8);
    return [{ id, question: text, ...(header ? { header } : {}), options }];
  }).slice(0, 4);
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

/** The inverse of permissionStartSettings(), for a turn context recorded in a Codex rollout. */
export function presetForCodexTurnContext(approvalPolicy: string | undefined, sandbox: string | undefined): PermissionPreset {
  if (sandbox === 'danger-full-access' && approvalPolicy === 'never') return 'full-access';
  if (sandbox === 'read-only') return 'plan';
  return 'standard';
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

/** Codex names the spawning collab tool `spawn_agent` (app-server) or `spawnAgent` (older payloads). */
const SPAWN_AGENT_TOOLS = new Set(['spawn_agent', 'spawnAgent']);

/** `/root/read_readme_title` → `read readme title`. */
function subagentTitle(agentPath: string): string {
  const name = path.basename(agentPath).replace(/[_-]+/gu, ' ').trim();
  return name || 'Codex sub-agent';
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
  for (const line of output.split(/\r?\n/u)) {
    const candidate = /^codex-cli\s+(\S+)(?:\s+.*)?$/u.exec(line.trim())?.[1];
    if (candidate && semanticVersion(candidate)) return candidate;
  }
  return undefined;
}

function compatibleVersion(version: string | undefined): boolean {
  if (!version) return false;
  const candidate = semanticVersion(version);
  const minimum = semanticVersion(CODEX_APP_SERVER_BASELINE_VERSION);
  if (!candidate || !minimum) return false;
  if (candidate.prerelease !== undefined) return false;
  return compareSemanticVersions(candidate, minimum) >= 0;
}

function incompatibleVersionReason(version: string): string {
  if (semanticVersion(version)?.prerelease !== undefined) {
    return `Codex ${version} is a prerelease; install stable Codex ${CODEX_APP_SERVER_BASELINE_VERSION} or newer.`;
  }
  return `Codex ${version} is older than the minimum supported ${CODEX_APP_SERVER_BASELINE_VERSION} app-server version.`;
}

function versionCheckFailure(detail: unknown): Error {
  const reason = sanitizeProviderDiagnostic(detail, { maxLength: 1_024 }).text.trim()
    || 'the version command did not provide an error';
  return new Error(`Codex version check failed before launch (${reason}). Reinstall or update Codex, then try again.`);
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
        // Codex stops a tool call after 60s by default; wait_agent may hold up to 240s.
        tool_timeout_sec: 300,
      },
    },
  };
}

const TOOL_ITEM_TYPES = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'imageGeneration',
]);

/** Shells Codex wraps commands in, and the flag after which the user-visible command starts. */
const SHELL_WRAPPERS: ReadonlyArray<{ readonly shell: RegExp; readonly flag: RegExp; readonly script: boolean }> = [
  { shell: /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/iu, flag: /^-(?:c|command)$/iu, script: false },
  { shell: /(?:^|[\\/])cmd(?:\.exe)?$/iu, flag: /^\/c$/iu, script: false },
  // `sh -c script arg0 …`: only the script is the command; later words are its positional arguments.
  { shell: /(?:^|[\\/])(?:ba|z|da|k)?sh(?:\.exe)?$/iu, flag: /^-[a-z]*c$/u, script: true },
];

function clip(value: string, limit = 2_000): string {
  return clipApprovalBody(value, limit);
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function firstLine(value: string, limit = 160): string {
  const line = value.split(/\r?\n/u, 1)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Splits Codex's shell-quoted argv display (POSIX quoting); bare backslashes stay literal for Windows paths. */
function shellWords(value: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
    } else if (quote === '"') {
      const next = value[index + 1];
      if (char === '"') quote = undefined;
      else if (char === '\\' && next !== undefined && '"\\$`'.includes(next)) current += value[++index];
      else current += char;
    } else if (/\s/u.test(char)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      inWord = true;
      if (char === "'" || char === '"') quote = char;
      else current += char;
    }
  }
  if (quote) return undefined;
  if (inWord) words.push(current);
  return words;
}

function commandActions(source: JsonObject): JsonObject[] {
  return asArray(source.commandActions).flatMap((value): JsonObject[] => {
    const action = asObject(value);
    return action ? [action] : [];
  });
}

/** The command the agent asked for, without the `powershell.exe -Command '…'` wrapper Codex reports. */
function displayCommand(source: JsonObject): string {
  const raw = providerTranscriptText(source.command);
  const words = shellWords(raw);
  if (!words) {
    const parsed = new Set(commandActions(source).map((action) => asString(action.command)));
    const [only] = parsed;
    return parsed.size === 1 && only ? only : raw;
  }
  const wrapper = SHELL_WRAPPERS.find(({ shell }) => shell.test(words[0] ?? ''));
  const flag = wrapper ? words.findIndex((word, index) => index > 0 && wrapper.flag.test(word)) : -1;
  if (!wrapper || flag < 1 || flag >= words.length - 1) return raw;
  return wrapper.script ? words[flag + 1]! : words.slice(flag + 1).join(' ');
}

/** Category and subject from Codex's best-effort parse (`read`, `listFiles`, `search`, `unknown`). */
function commandShape(source: JsonObject, command: string): {
  readonly category: ToolCategory;
  readonly target?: string;
  readonly query?: string;
} {
  const actions = commandActions(source);
  const all = (type: string): boolean => actions.length > 0 && actions.every((action) => action.type === type);
  if (all('read')) {
    const targets = actions.flatMap((action) => asString(action.path) ?? asString(action.name) ?? []);
    return { category: 'read', target: targets.join(', ') || firstLine(command) };
  }
  if (all('search')) {
    const query = asString(actions[0]?.query);
    const scope = asString(actions[0]?.path);
    return {
      category: 'search',
      target: query ? (scope ? `${query} · ${scope}` : query) : scope ?? firstLine(command),
      ...(query ? { query } : {}),
    };
  }
  if (all('listFiles')) return { category: 'list', target: asString(actions[0]?.path) ?? firstLine(command) };
  return { category: 'command', target: firstLine(command) };
}

function toolStatus(value: unknown, started: boolean): NonNullable<ToolPayload['status']> {
  switch (value) {
    case 'inProgress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'declined': return 'denied';
    case 'interrupted': return 'interrupted';
    default: return started ? 'running' : 'completed';
  }
}

/** A schema-valid tool payload: strings clipped to their bounds, empty fields omitted. */
function toolPayload(input: {
  readonly callId: string;
  readonly name: string;
  readonly category: ToolCategory;
  readonly started: boolean;
  readonly status: unknown;
  readonly target?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly files?: NonNullable<ToolPayload['files']>;
  readonly query?: string;
  readonly server?: string;
}): ToolPayload {
  const payload: ToolPayload = {
    v: 1,
    type: 'tool',
    callId: clip(input.callId),
    name: clip(input.name),
    category: input.category,
    phase: input.started ? 'call' : 'result',
    status: toolStatus(input.status, input.started),
  };
  if (input.target) payload.target = clip(input.target);
  if (input.command) payload.command = clip(input.command, 8_000);
  if (input.cwd) payload.cwd = clip(input.cwd);
  if (input.exitCode !== undefined) payload.exitCode = input.exitCode;
  if (input.durationMs !== undefined) payload.durationMs = input.durationMs;
  if (input.files?.length) payload.files = input.files.slice(0, 200);
  if (input.query) payload.query = clip(input.query);
  if (input.server) payload.server = clip(input.server);
  return payload;
}

interface FileChange {
  readonly path: string;
  readonly kind?: 'add' | 'update' | 'delete' | 'rename';
  readonly movePath?: string;
  readonly diff: string;
}

function fileChanges(item: JsonObject): FileChange[] {
  return asArray(item.changes).flatMap((value): FileChange[] => {
    const change = asObject(value);
    const filePath = asString(change?.path);
    if (!change || !filePath) return [];
    const kind = asObject(change.kind);
    const type = asString(kind?.type) ?? asString(change.kind);
    const movePath = asString(kind?.move_path);
    const resolved = type === 'add' || type === 'delete' ? type : type === 'update' ? (movePath ? 'rename' : 'update') : undefined;
    return [{
      path: filePath,
      ...(resolved ? { kind: resolved } : {}),
      ...(movePath ? { movePath } : {}),
      diff: typeof change.diff === 'string' ? change.diff : '',
    }];
  });
}

/** Added content is the raw file and deleted content the old file; updates are `@@` hunks. */
function diffLineCounts(change: FileChange): { readonly added: number; readonly removed: number } {
  const lines = change.diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (change.kind === 'add') return { added: lines.length, removed: 0 };
  if (change.kind === 'delete') return { added: 0, removed: lines.length };
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added += 1;
    else if (inHunk && line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function displayPath(filePath: string, root: string | undefined): string {
  if (!root || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function fileChangeSummary(changes: readonly FileChange[], root: string | undefined): string {
  const verbs = { add: 'Add', update: 'Edit', delete: 'Delete', rename: 'Move' } as const;
  return changes.map((change) => change.kind === 'rename' && change.movePath
    ? `Move ${displayPath(change.path, root)} → ${displayPath(change.movePath, root)}`
    : `${verbs[change.kind ?? 'update']} ${displayPath(change.path, root)}`).join('\n');
}

function webSearchQuery(item: JsonObject): string | undefined {
  const action = asObject(item.action);
  return asString(item.query) ?? asString(action?.query)
    ?? asArray(action?.queries).find((value): value is string => typeof value === 'string' && value.length > 0);
}

function webSearchTarget(item: JsonObject, query: string | undefined): string | undefined {
  const url = asString(asObject(item.action)?.url);
  if (!url) return query;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function webSearchResultText(item: JsonObject, query: string | undefined): string {
  const results = asArray(item.results).flatMap((value) => {
    const result = asObject(value);
    const title = asString(result?.title);
    const url = asString(result?.url);
    return title || url ? [{ title: title ?? url ?? '', url }] : [];
  });
  if (results.length) {
    return results.map((result, index) => `${String(index + 1)}. ${result.title}${result.url && result.url !== result.title ? `\n   ${result.url}` : ''}`).join('\n');
  }
  const action = asObject(item.action);
  const url = asString(action?.url);
  if (action?.type === 'openPage' && url) return `Opened ${url}`;
  if (action?.type === 'findInPage' && url) return `Searched ${url}${asString(action.pattern) ? ` for ${asString(action.pattern)}` : ''}`;
  if (item.status === 'interrupted') return 'Web search interrupted.';
  return query ? `Searched the web: ${query}` : 'Web search completed.';
}

function todoStatus(value: unknown): TodoItem['status'] {
  return value === 'completed' ? 'completed' : value === 'inProgress' ? 'in_progress' : 'pending';
}

/** Structured Codex adapter requiring at least the observed 0.152.1 app-server schema. */
export class CodexProviderAdapter implements AgentProviderAdapter {
  readonly providerId = 'codex';

  private readonly executable: string;
  private connection: CodexAppServerConnection | undefined;
  /** Whether this app-server offers the plan collaboration mode; asked once per connection. */
  private planCollaboration: Promise<boolean> | undefined;
  private readonly providedConnection: boolean;
  private readonly connectionFactory: (options: CodexAppServerClientOptions) => CodexAppServerConnection;
  private readonly clientOptions: CodexProviderAdapterOptions['clientOptions'];
  private readonly resolveExecutable: (command: string, signal?: AbortSignal) => Promise<string>;
  private readonly runCommand: (command: string, argv: readonly string[], signal?: AbortSignal) => Promise<CodexCommandResult>;
  private readonly probeTimeoutMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly deltaCoalescer: DeltaCoalescerOptions | undefined;
  private readonly enableUpdatePlan: boolean;
  private readonly listeners = new Set<AgentProviderEventListener>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionIdByProviderId = new Map<string, string>();
  /** Sub-agent threads (any depth) by thread id; their notifications route to the sub-agent. */
  private readonly subagentThreads = new Map<string, SessionState>();
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
    this.deltaCoalescer = options.deltaCoalescer;
    this.enableUpdatePlan = options.enableUpdatePlan ?? true;
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
        authenticationDetail: CODEX_FIRST_LAUNCH_AUTHENTICATION_DETAIL,
        ...(compatible ? {} : {
          unavailableReason: incompatibleVersionReason(executableVersion),
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
          ...(asArray(model?.supportedReasoningEfforts).length ? {
            reasoningEfforts: asArray(model?.supportedReasoningEfforts).flatMap((entry) => {
              const effort = asString(asObject(entry)?.reasoningEffort);
              return effort ? [effort] : [];
            }),
          } : {}),
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

  async listCapabilities(workspaceRoot: string, signal?: AbortSignal): Promise<ProviderCapabilityCatalog> {
    if (!path.isAbsolute(workspaceRoot)) throw new Error('An absolute workspace is required.');
    await this.ensureConnection(signal);
    const rpc = (method: string, params: JsonObject): Promise<unknown> => this.requireConnection().request(method, params, { signal });
    const [models, skills, plugins, mcp, configuration] = await Promise.allSettled([
      this.listModels(signal), rpc('skills/list', { cwds: [workspaceRoot], forceReload: true }),
      rpc('plugin/installed', { cwds: [workspaceRoot] }), rpc('mcpServerStatus/list', { limit: 100 }),
      rpc('config/read', { cwd: workspaceRoot, includeLayers: false }),
    ]);
    const items: AgentCapabilityItem[] = [];
    const issues: { section: 'models' | 'skills' | 'plugins' | 'mcp'; message: string }[] = [];
    for (const [section, result] of [['models', models], ['skills', skills], ['plugins', plugins], ['mcp', mcp]] as const) {
      if (result.status === 'rejected') issues.push({ section, message: `The installed Codex provider could not list ${section}. Refresh or update the provider.` });
    }
    const nativeConfigResult = configuration.status === 'fulfilled' ? asObject(configuration.value) : undefined;
    const nativeConfig = asObject(nativeConfigResult?.config);
    const configuredMcp = asObject(nativeConfig?.mcp_servers);
    const origins = asObject(nativeConfigResult?.origins);
    if (!nativeConfig) issues.push({ section: 'mcp', message: 'Workspace MCP settings could not be verified. Runtime status alone does not establish workspace enablement.' });
    const nativeMcpItems = new Map<string, AgentCapabilityItem>();
    for (const [name, raw] of Object.entries(configuredMcp ?? {})) {
      const config = asObject(raw);
      if (!config) continue;
      const originKey = Object.keys(origins ?? {}).filter((key) => key === `mcp_servers.${name}` || key.startsWith(`mcp_servers.${name}.`) || key === 'mcp_servers').sort((a, b) => b.length - a.length)[0];
      const configScope = asString(asObject(asObject(originKey ? origins?.[originKey] : undefined)?.name)?.type) ?? 'unknown';
      const enabled = config.enabled !== false;
      nativeMcpItems.set(name, { id: name, kind: 'mcp', name, enabled, status: enabled ? 'configured' : 'disabled', scope: configScope, actions: configScope === 'user' ? ['mcp-remove'] : [] });
    }
    if (skills.status === 'fulfilled') for (const entry of asArray(asObject(skills.value)?.data)) {
      const group = asObject(entry);
      if (asArray(group?.errors).length) issues.push({ section: 'skills', message: 'Some installed skills could not be read by Codex.' });
      for (const raw of asArray(group?.skills)) {
        const skill = asObject(raw);
        const name = asString(skill?.name);
        const source = asString(skill?.path);
        if (!name || !source) continue;
        items.push({ id: source, kind: 'skill', name, source, scope: asString(skill?.scope),
          description: asString(skill?.description), enabled: skill?.enabled === true,
          invocation: `$${name}`, actions: ['skill-enable', 'skill-disable'] });
      }
    }
    if (plugins.status === 'fulfilled') {
      const result = asObject(plugins.value);
      if (asArray(result?.marketplaceLoadErrors).length) issues.push({ section: 'plugins', message: 'Some configured marketplaces could not be read.' });
      for (const rawMarketplace of asArray(result?.marketplaces)) {
        const marketplace = asObject(rawMarketplace);
        for (const raw of asArray(marketplace?.plugins)) {
          const plugin = asObject(raw);
          const id = asString(plugin?.id);
          if (!id || plugin?.installed !== true) continue;
          items.push({ id, kind: 'plugin', name: asString(plugin?.name) ?? id,
            description: asString(asObject(plugin?.interface)?.shortDescription),
            source: asString(marketplace?.name), version: asString(plugin?.localVersion) ?? asString(plugin?.version),
            enabled: plugin?.enabled === true, scope: 'user', actions: ['plugin-remove', 'plugin-enable', 'plugin-disable'] });
        }
      }
    }
    if (mcp.status === 'fulfilled') {
      let result = asObject(mcp.value);
      const cursors = new Set<string>();
      for (let page = 0; page < 40; page += 1) {
        for (const raw of asArray(result?.data)) {
          const server = asObject(raw);
          const name = asString(server?.name);
          if (!name) continue;
          const configured = nativeMcpItems.get(name);
          if (configured) nativeMcpItems.set(name, { ...configured, status: configured.enabled ? asString(server?.runtimeStatus) ?? asString(server?.authStatus) ?? 'configured' : 'disabled' });
          // Runtime-only entries belong to the app-server context, not necessarily this workspace.
          else if (server?.pluginId) nativeMcpItems.set(name, { id: name, kind: 'mcp', name, enabled: server?.runtimeStatus !== 'disabled', status: asString(server?.runtimeStatus) ?? asString(server?.authStatus) ?? 'configured', source: asString(server?.pluginId), scope: 'plugin', actions: [] });
        }
        const cursor = asString(result?.nextCursor);
        if (!cursor) break;
        if (cursors.has(cursor) || page === 39) { issues.push({ section: 'mcp', message: 'The MCP catalog exceeds the discovery bound.' }); break; }
        cursors.add(cursor);
        try { result = asObject(await rpc('mcpServerStatus/list', { limit: 100, cursor })); }
        catch { issues.push({ section: 'mcp', message: 'The remaining MCP servers could not be loaded.' }); break; }
      }
    }
    items.push(...nativeMcpItems.values());
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
    return { models: models.status === 'fulfilled' ? models.value : [], items, issues,
      ...(nativeConfig ? { configurationRevision: createHash('sha256').update(JSON.stringify(canonical({ mcp: configuredMcp, plugins: nativeConfig.plugins, skills: nativeConfig.skills }))).digest('hex') } : {}),
      actions: [
        ...(plugins.status === 'fulfilled' ? ['plugin-install', 'plugin-remove', 'plugin-enable', 'plugin-disable', 'marketplace-add', 'marketplace-remove', 'marketplace-update'] as const : []),
        ...(skills.status === 'fulfilled' ? ['skill-enable', 'skill-disable'] as const : []),
        ...(nativeConfig ? ['mcp-add', 'mcp-remove'] as const : []),
      ] };
  }

  async manageExtension(workspaceRoot: string, command: AgentExtensionCommand, signal?: AbortSignal): Promise<void> {
    if (command.scope !== 'user') throw new Error('Codex extension changes use the native user settings.');
    await this.ensureConnection(signal);
    const request = (method: string, params: JsonObject): Promise<unknown> => this.requireConnection().request(method, params, { signal });
    const target = command.target;
    switch (command.action) {
      case 'skill-enable': case 'skill-disable':
        await request('skills/config/write', { path: target, enabled: command.action === 'skill-enable' }); break;
      case 'plugin-install': {
        const split = target.lastIndexOf('@');
        if (split < 1) throw new Error('Use plugin@marketplace.');
        const marketplaceName = target.slice(split + 1);
        const catalog = asObject(await request('plugin/list', { cwds: [workspaceRoot] }));
        const marketplace = asArray(catalog?.marketplaces).map(asObject).find((entry) => entry?.name === marketplaceName);
        const marketplacePath = asString(marketplace?.path);
        await request('plugin/install', { pluginName: target.slice(0, split), ...(marketplacePath ? { marketplacePath } : { remoteMarketplaceName: marketplaceName }), installAttemptId: command.commandId }); break;
      }
      case 'plugin-remove': await request('plugin/uninstall', { pluginId: target }); break;
      case 'plugin-enable': case 'plugin-disable':
        if (!/^[A-Za-z0-9_:@/-]+$/u.test(target)) throw new Error('Invalid plugin identifier.');
        await request('config/value/write', { keyPath: `plugins.${JSON.stringify(target)}.enabled`, value: command.action === 'plugin-enable', mergeStrategy: 'replace' }); break;
      case 'marketplace-add': await request('marketplace/add', { source: command.source ?? target }); break;
      case 'marketplace-remove': await request('marketplace/remove', { marketplaceName: target }); break;
      case 'marketplace-update': {
        const result = asObject(await request('marketplace/upgrade', { marketplaceName: target }));
        if (asArray(result?.errors).length) throw new Error('The native marketplace refresh did not complete. Check provider settings.');
        break;
      }
      case 'mcp-add': case 'mcp-remove': {
        const descriptor = this.launchDescriptor;
        if (!descriptor) throw new Error('Review the native executable before management.');
        await this.verifyLaunchDescriptor(descriptor, signal);
        await runNativeExtensionCommand(descriptor.executablePath, codexMcpArguments(command), workspaceRoot, buildProviderProcessEnvironment(descriptor.environmentVariableNames), signal);
        break;
      }
      default: throw new Error('This operation is not supported by Codex.');
    }
  }

  async createSession(context: ProviderSessionContext, signal?: AbortSignal): Promise<ProviderSessionHandle> {
    this.assertSessionContext(context);
    this.assertActive();
    const lifecycleGeneration = await this.ensureConnection(signal);
    if (this.sessions.has(context.sessionId)) throw new Error(`Codex session ${context.sessionId} already exists.`);
    this.emit({ kind: 'session-state', sessionId: context.sessionId, state: 'starting' });
    try {
      const config = { ...orchestrationConfig(context), ...(context.reasoningEffort ? { model_reasoning_effort: context.reasoningEffort } : {}),
        ...(context.environment ? { 'shell_environment_policy.set': context.environment, 'shell_environment_policy.include_only': ['*'] } : {}),
        ...(context.managedExecution ? { 'features.multi_agent': false } : {}),
        ...(this.enableUpdatePlan ? { 'tools.update_plan': { enabled: true } } : {}) };
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
      const state = this.registerSession(context, providerSessionId, asString(result?.model) ?? context.model, asString(result?.reasoningEffort));
      state.threadMode = 'default';
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
      const config = { ...orchestrationConfig(context), ...(context.reasoningEffort ? { model_reasoning_effort: context.reasoningEffort } : {}),
        ...(context.environment ? { 'shell_environment_policy.set': context.environment, 'shell_environment_policy.include_only': ['*'] } : {}),
        ...(context.managedExecution ? { 'features.multi_agent': false } : {}),
        ...(this.enableUpdatePlan ? { 'tools.update_plan': { enabled: true } } : {}) };
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
      const state = this.registerSession(context, resumedId, asString(result?.model) ?? context.model, asString(result?.reasoningEffort));
      const resumedMode = asString(asObject(result?.collaborationMode)?.mode);
      if (resumedMode === 'plan' || resumedMode === 'default') state.threadMode = resumedMode;
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
    const selectedSkills = input.context?.skills ?? [];
    if (selectedSkills.length) {
      const result = asObject(await this.requireConnection().request('skills/list', { cwds: [state.workspaceRoot], forceReload: true }, { signal }));
      const available = asArray(result?.data).flatMap((group) => asArray(asObject(group)?.skills));
      if (selectedSkills.some((selected) => selected.providerId !== 'codex' || !available.some((raw) => {
        const skill = asObject(raw);
        return skill?.enabled === true && skill.name === selected.name && skill.path === selected.id;
      }))) throw new Error('A selected Codex skill is unavailable. Refresh the extension list and preserve the draft.');
      if (state.activeTurn) throw new Error(`Codex session ${input.sessionId} already has an active turn.`);
    }
    state.activeTurn = {
      localTurnId: input.turnId,
      commandId: input.commandId,
      startedEmitted: false,
    };
    state.submittedCommandIds.add(input.commandId);
    if (state.submittedCommandIds.size > MAX_SUBMITTED_COMMANDS) {
      state.submittedCommandIds.delete(state.submittedCommandIds.values().next().value as string);
    }
    this.emit({ kind: 'session-state', sessionId: input.sessionId, state: 'working' });
    try {
      const collaborationMode = await this.collaborationModeFor(state, input);
      const result = asObject(await this.requireConnection().request('turn/start', {
        threadId: input.providerSessionId,
        clientUserMessageId: input.commandId,
        ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
        input: [
          { type: 'text', text: promptWithChatContext(input.prompt, input.context), text_elements: [] },
          ...selectedSkills.map((skill) => ({ type: 'skill', name: skill.name, path: skill.id })),
          ...(input.context?.attachments ?? []).filter((attachment) => attachment.kind === 'image').map((attachment) => ({
            type: 'image', url: `data:${attachment.mimeType};base64,${attachment.data}`,
          })),
        ],
      }, { signal }));
      const turn = asObject(result?.turn);
      const providerTurnId = asString(turn?.id);
      if (!providerTurnId) throw new Error('Codex turn/start returned no turn id.');
      if (collaborationMode) state.threadMode = collaborationMode.mode;
      const activeTurn = state.activeTurn;
      if (activeTurn && collaborationMode?.mode === 'plan') activeTurn.planMode = true;
      if (!activeTurn || activeTurn.commandId !== input.commandId) return;
      activeTurn.providerTurnId = providerTurnId;
      // The response itself authoritatively confirms this turn identity. Emit
      // that ownership before replaying any notification that raced ahead.
      this.emitTurnStarted(state, activeTurn);
      const buffered = this.takePreResponseLifecycle(state, providerTurnId);
      for (const event of buffered.events) {
        if (state.activeTurn !== activeTurn) break;
        switch (event.kind) {
          case 'started':
            this.handleTurnStarted(state, event.turn, true);
            break;
          case 'completed':
            this.handleTurnCompleted(state, event.turn);
            break;
          case 'error':
            this.handleCodexError(state, state.sessionId, providerTurnId, event.message, event.recoverable);
            break;
        }
      }
      if (state.activeTurn !== activeTurn) return;
      if (buffered.overflowedWithoutMatch) {
        const error = new Error('Codex pre-response lifecycle buffer overflowed before turn identity was confirmed.');
        this.settlePendingInterrupt(activeTurn, error);
        this.emit({
          kind: 'provider-error',
          sessionId: state.sessionId,
          turnScope: { turnId: activeTurn.localTurnId, providerTurnId },
          code: 'codex-lifecycle-buffer-overflow',
          message: error.message,
          recoverable: true,
        });
        return;
      }
      this.dispatchPendingInterrupt(state, activeTurn);
      this.emitTurnStarted(state, activeTurn);
    } catch (error) {
      if (state.activeTurn?.commandId === input.commandId) {
        this.settlePendingInterrupt(state.activeTurn, error);
        state.activeTurn = undefined;
      }
      this.clearPreResponseLifecycle(state);
      this.emit({
        kind: 'provider-error',
        sessionId: input.sessionId,
        turnScope: { turnId: input.turnId },
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
    state.deltas.flushAll();
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

  /**
   * A person's plan turn runs in Codex's plan mode, which asks questions and ends
   * with a proposed plan. Anything else runs in default mode; a thread left in plan
   * mode is switched back. A Codex without plan mode keeps the read-only sandbox.
   */
  private async collaborationModeFor(state: SessionState, input: ProviderSubmitInput): Promise<{
    readonly mode: 'plan' | 'default';
    readonly settings: { readonly model: string; readonly reasoning_effort: string | null; readonly developer_instructions: null };
  } | undefined> {
    const wantsPlan = input.attended === true && state.permissionPreset === 'plan' && !state.subagentOf;
    if (!state.model || (!wantsPlan && state.threadMode === 'default')) return undefined;
    const supported = await this.planCollaborationSupported();
    if (!supported) {
      if (wantsPlan && !state.planUnsupportedNoticed) {
        state.planUnsupportedNoticed = true;
        this.emitTranscript(state, {
          id: opaqueId('codex_plan_unsupported', state.sessionId),
          sessionId: state.sessionId,
          turnId: input.turnId,
          sequence: this.nextSequence(state),
          kind: 'notice',
          text: 'This Codex version has no plan mode, so plan mode runs read-only without a plan to approve.',
          isDelta: false,
          isSensitive: false,
          createdAt: this.isoNow(),
        });
      }
      return undefined;
    }
    return {
      mode: wantsPlan ? 'plan' : 'default',
      settings: { model: state.model, reasoning_effort: input.reasoningEffort ?? state.reasoningEffort ?? null, developer_instructions: null },
    };
  }

  private planCollaborationSupported(): Promise<boolean> {
    this.planCollaboration ??= this.requireConnection().request('collaborationMode/list', {})
      .then((result) => asArray(asObject(result)?.data).some((mask) => asObject(mask)?.mode === 'plan'))
      .catch(() => false);
    return this.planCollaboration;
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
    requireObjectResult(
      'thread/settings/update',
      await this.requireConnection().request('thread/settings/update', {
        threadId: input.providerSessionId,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.permissionPreset === undefined
          ? {}
          : permissionUpdateSettings(input.permissionPreset, state.workspaceRoot)),
      }),
    );
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
    if (pending.kind === 'proposed-plan') {
      // Running the plan leaves plan mode for the chosen access; the host then sends the request to implement it.
      if (input.decision === 'allow') {
        const mode = input.response?.kind === 'plan' ? input.response.mode : 'standard';
        await this.setSettings({ sessionId: input.sessionId, providerSessionId: input.providerSessionId, permissionPreset: mode });
      }
      return;
    }
    // Codex approvals carry only a decision; plan-mode questions also carry the answers.
    pending.resolve(this.approvalResponse(pending, input.decision, input.response));
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
    state.deltas.dispose();
    this.clearPreResponseLifecycle(state);
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
      for (const [threadId, subagent] of this.subagentThreads) {
        if (subagent.sessionId === state.sessionId) this.subagentThreads.delete(threadId);
      }
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
        state.deltas.dispose();
        this.clearPreResponseLifecycle(state);
        if (!state.activeTurn) continue;
        this.settlePendingInterrupt(
          state.activeTurn,
          new Error(`Codex session ${state.sessionId} was deactivated before its interrupt could be delivered.`),
        );
        state.activeTurn = undefined;
      }
      this.sessions.clear();
      this.sessionIdByProviderId.clear();
      this.subagentThreads.clear();
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
      let result: CodexCommandResult;
      try {
        result = await this.runCommand(canonical, ['--version'], deadlineSignal);
      } catch (error) {
        if (deadlineSignal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        throw versionCheckFailure(error);
      }
      const version = parseVersion(`${result.stdout}\n${result.stderr}`);
      if (result.exitCode !== 0) {
        throw versionCheckFailure(result.stderr.trim() || `Codex exited with code ${result.exitCode}.`);
      }
      if (!version) {
        throw new Error('Codex version check returned no valid semantic version before launch. Reinstall or update Codex, then try again.');
      }
      if (!compatibleVersion(version)) throw new Error(`${incompatibleVersionReason(version)} Update Codex, then try again.`);
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
    this.planCollaboration = undefined;
    this.unregister.push(
      connection.onNotification('*', (params, method) => this.handleNotification(method, params)),
      connection.onClose((event) => {
        if (event.expected || this.disposed) return;
        for (const approval of this.pendingApprovals.values()) {
          approval.resolve(this.approvalResponse(approval, 'deny'));
        }
        this.pendingApprovals.clear();
        for (const state of this.sessions.values()) {
          state.deltas.dispose();
          this.clearPreResponseLifecycle(state);
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
    // Plan mode asks the person through request_user_input. A secret or a question that
    // does not wait gets an empty answer: answers travel through the command outbox.
    this.unregister.push(connection.onServerRequest('item/tool/requestUserInput', async (value, context) => {
      const params = asObject(value);
      const questions = asArray(params?.questions).map(asObject);
      if (!params || params.isBlocking === false || questions.some((question) => question?.isSecret === true)
        || !questions.some((question) => asString(question?.question))) return { answers: {} };
      return this.handleApproval('user-input', params, context);
    }));
    this.unregister.push(connection.onServerRequest('mcpServer/elicitation/request', async (value, context) => {
      const params = asObject(value);
      const schema = asObject(params?.requestedSchema);
      const properties = asObject(schema?.properties);
      // Codex uses an empty form for a single MCP tool approval. Data collection,
      // URL authentication and native verification require a different UI contract.
      if (params?.mode !== 'form' || asObject(params._meta)?.codex_approval_kind !== 'mcp_tool_call'
        || schema?.type !== 'object' || !properties || Object.keys(properties).length !== 0
        || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0))) {
        throw new Error('This MCP form requires input that EZTerminal does not support yet.');
      }
      return this.handleApproval('mcp-tool', params, context);
    }));
  }

  private handleApproval(kind: ApprovalKind, value: unknown, context: CodexServerRequestContext): Promise<unknown> {
    const params = asObject(value);
    const threadId = params ? threadIdFromParams(params) : undefined;
    // A sub-agent thread asks through its session: the approval lives there, labelled with the sub-agent.
    const subagent = threadId && !this.sessionIdByProviderId.has(threadId) ? this.subagentThreads.get(threadId) : undefined;
    const sessionId = subagent?.sessionId ?? (threadId ? this.sessionIdByProviderId.get(threadId) : undefined);
    const owner = sessionId ? this.sessions.get(sessionId) : undefined;
    const providerSessionId = subagent ? owner?.providerSessionId : threadId;
    if (!params || !providerSessionId || !sessionId) {
      throw new Error('Codex approval referenced an unknown session.');
    }
    const explicitId = asString(params.approvalId);
    const providerRequestId = `${kind}:${explicitId ?? this.rpcIdKey(context.id)}`;
    if (this.pendingApprovals.has(providerRequestId)) throw new Error('Codex repeated a pending approval id.');
    const state = subagent ?? owner;
    state?.deltas.flushAll();
    const request = this.approvalRequest(kind, params, state);
    if (subagent?.subagentParent && subagent.subagentOf) {
      this.emitNativeSubagent(subagent.subagentParent, subagent.subagentOf, subagent.subagentTitle ?? 'Codex sub-agent', 'blocked');
    }
    return new Promise<unknown>((resolve) => {
      const pending: PendingApproval = {
        providerRequestId,
        kind,
        sessionId,
        providerSessionId,
        ...(asString(params.turnId) && !subagent ? { turnId: asString(params.turnId) } : {}),
        params,
        resolve,
      };
      this.pendingApprovals.set(providerRequestId, pending);
      const detail = this.approvalDetail(kind, params);
      this.emit({
        kind: 'approval-requested',
        sessionId,
        ...(pending.turnId ? { turnId: this.localTurnId(sessionId, pending.turnId) } : {}),
        ...(subagent?.subagentOf ? { providerChildId: subagent.subagentOf } : {}),
        providerRequestId,
        risk: kind === 'user-input' ? 'read' : kind === 'file-change' || kind === 'legacy-file-change' ? 'write' : 'danger',
        title: this.approvalTitle(kind),
        ...(detail ? { detail } : {}),
        ...(request ? { request } : {}),
      });
      this.emit({ kind: 'session-state', sessionId, state: 'blocked' });
    });
  }

  private approvalRequest(
    kind: ApprovalKind,
    params: JsonObject,
    state: SessionState | undefined,
  ): ApprovalRequest | undefined {
    const callId = asString(params.itemId);
    const reason = asString(params.reason);
    const shared = {
      v: 1 as const,
      ...(callId ? { callId: clip(callId) } : {}),
      ...(reason ? { reason: clip(reason) } : {}),
    };
    if (kind === 'user-input') {
      const questions = userInputQuestions(params).map(({ question, header, options }) => ({
        question: clip(question),
        ...(header ? { header: clip(header) } : {}),
        multiSelect: false,
        options: options.map((option) => ({ label: clip(option.label), ...(option.description ? { description: clip(option.description) } : {}) })),
      }));
      return questions.length ? { v: 1, ...(callId ? { callId: clip(callId) } : {}), kind: 'question', questions } : undefined;
    }
    if (kind === 'command') {
      const command = displayCommand(params);
      const cwd = asString(params.cwd);
      return command ? { ...shared, kind: 'command', command: clipApprovalBody(command), ...(cwd ? { cwd: clip(cwd) } : {}) } : undefined;
    }
    // Codex sends the patch on item/started; the approval request carries only the item id.
    const started = kind === 'file-change' && callId ? state?.startedItems.get(callId) : undefined;
    if (started?.item.type !== 'fileChange') return undefined;
    return {
      ...shared,
      kind: 'file-change',
      files: fileChanges(started.item).slice(0, 50).map((change) => ({
        path: clip(change.path),
        ...(change.kind ? { kind: change.kind } : {}),
        ...(change.diff ? { diff: clipApprovalBody(change.diff) } : {}),
      })),
    };
  }

  private approvalResponse(pending: PendingApproval, decision: 'allow' | 'deny', response?: ApprovalResponse): unknown {
    if (pending.kind === 'user-input') {
      // Answers are keyed by question text in the card and by question id for Codex.
      const answers = decision === 'allow' && response?.kind === 'answers' ? response.answers : {};
      return {
        answers: Object.fromEntries(userInputQuestions(pending.params).flatMap(({ id, question }) => {
          const answer = answers[clip(question)]?.trim();
          return answer ? [[id, { answers: [answer] }]] : [];
        })),
      };
    }
    if (pending.kind === 'mcp-tool') {
      // Omit persistent grant metadata: the user's choice applies only to this call.
      return { action: decision === 'allow' ? 'accept' : 'decline', content: decision === 'allow' ? {} : null, _meta: null };
    }
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
    // "Allow for this conversation" is Codex's own acceptForSession.
    return { decision: decision === 'allow' ? response?.kind === 'session' ? 'acceptForSession' : 'accept' : 'decline' };
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
      case 'mcp-tool':
        return 'Run MCP tool';
      case 'user-input':
        return 'Answer to continue';
      case 'proposed-plan':
        return 'Approve plan';
    }
  }

  private approvalDetail(kind: ApprovalKind, params: JsonObject): string {
    if (kind === 'mcp-tool') {
      const argumentsText = JSON.stringify(asObject(params._meta)?.tool_params ?? {});
      const detail = [boundedText(params.message, 2_000), `Server: ${boundedText(params.serverName, 200)}`, argumentsText].join('\n');
      return detail.length > 6_000 ? `${detail.slice(0, 6_000)}\n[Additional tool arguments omitted]` : detail;
    }
    if (kind === 'command') return boundedText(displayCommand(params), 4_000) || boundedText(params.reason, 4_000);
    if (kind === 'legacy-command') return asArray(params.command).filter((value): value is string => typeof value === 'string').join(' ').slice(0, 4_000);
    // Clients that cannot draw the question card still read what is asked.
    if (kind === 'user-input') return userInputQuestions(params).map((question) => question.question).join('\n').slice(0, 4_000);
    return boundedText(params.reason, 4_000) || boundedText(params.grantRoot, 4_000);
  }

  private handleNotification(method: string, value: unknown): void {
    const params = asObject(value);
    if (!params) return;
    const providerSessionId = asString(params.threadId);
    const sessionId = providerSessionId ? this.sessionIdByProviderId.get(providerSessionId) : undefined;
    const state = sessionId ? this.sessions.get(sessionId) : undefined;
    const subagent = !state && providerSessionId ? this.subagentThreads.get(providerSessionId) : undefined;
    if (subagent) {
      this.handleSubagentNotification(subagent, method, params);
      return;
    }
    if (method === 'error') {
      const error = asObject(params.error);
      const message = sanitizeProviderDiagnostic(
        asString(error?.message) ?? 'Codex reported an unknown error.',
      ).text;
      const providerTurnId = asString(params.turnId);
      const recoverable = params.willRetry === true;
      if (
        state
        && providerTurnId
        && state.activeTurn
        && !state.activeTurn.providerTurnId
      ) {
        this.bufferPreResponseLifecycle(state, providerTurnId, {
          kind: 'error',
          message,
          recoverable,
        });
        return;
      }
      this.handleCodexError(state, sessionId, providerTurnId, message, recoverable);
      return;
    }
    if (!state) return;
    switch (method) {
      case 'thread/status/changed':
        this.handleThreadStatus(state, asObject(params.status));
        return;
      case 'thread/settings/updated': {
        const mode = asString(asObject(asObject(params.threadSettings)?.collaborationMode)?.mode);
        if (mode === 'plan' || mode === 'default') state.threadMode = mode;
        return;
      }
      case 'turn/started':
        this.handleTurnStarted(state, asObject(params.turn));
        return;
      case 'turn/completed':
        this.handleTurnCompleted(state, asObject(params.turn));
        return;
      case 'item/started':
        this.handleItem(state, asString(params.turnId), asObject(params.item), false, nonNegativeInteger(params.startedAtMs));
        return;
      case 'item/completed':
        this.handleItem(state, asString(params.turnId), asObject(params.item), true, nonNegativeInteger(params.completedAtMs));
        return;
      case 'turn/plan/updated':
        this.handleTurnPlan(state, params);
        return;
      case 'item/agentMessage/delta':
        this.emitDelta(state, params, 'assistant-message');
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.emitDelta(state, params, 'reasoning');
        return;
      case 'item/plan/delta':
        this.emitDelta(state, params, 'reasoning', { v: 1, type: 'plan' });
        return;
      default:
        return;
    }
  }

  /**
   * A sub-agent thread's own stream: its items become its rows, its turn is
   * not the parent's, and finishing sends its last answer back to the parent.
   */
  private handleSubagentNotification(state: SessionState, method: string, params: JsonObject): void {
    const parent = state.subagentParent;
    const childId = state.subagentOf;
    if (!parent || !childId) return;
    const title = state.subagentTitle ?? 'Codex sub-agent';
    switch (method) {
      case 'turn/started':
        this.emitNativeSubagent(parent, childId, title, 'working');
        return;
      case 'turn/completed': {
        const turn = asObject(params.turn);
        const providerTurnId = asString(turn?.id) ?? asString(params.turnId);
        for (const itemValue of asArray(turn?.items)) {
          if (providerTurnId) this.handleItem(state, providerTurnId, asObject(itemValue), true);
        }
        if (providerTurnId) this.settleStartedItems(state, providerTurnId, turnStatus(turn?.status) === 'interrupted');
        state.deltas.flushAll();
        const outcome = turnStatus(turn?.status);
        const summary = (turn ? this.lastAssistantText(turn) : '') || state.lastAgentMessage;
        this.emitNativeSubagent(parent, childId, title, outcome === 'completed' ? 'done' : 'error', summary);
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = asObject(params.item);
        if (method === 'item/completed' && item?.type === 'agentMessage' && asString(item.text)) {
          state.lastAgentMessage = boundedText(item.text, 2_000);
        }
        this.handleItem(state, asString(params.turnId), item, method === 'item/completed',
          nonNegativeInteger(method === 'item/completed' ? params.completedAtMs : params.startedAtMs));
        return;
      }
      case 'item/agentMessage/delta':
        this.emitDelta(state, params, 'assistant-message');
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.emitDelta(state, params, 'reasoning');
        return;
      case 'error':
        if (params.willRetry !== true) {
          const message = sanitizeProviderDiagnostic(asString(asObject(params.error)?.message) ?? 'Codex reported an unknown error.').text;
          this.emitNativeSubagent(parent, childId, title, 'error', message);
        }
        return;
      default:
        return;
    }
  }

  /** A sub-agent's shadow state: same item handling, rows tagged for the sub-agent. */
  private trackSubagent(parent: SessionState, threadId: string, title: string): SessionState {
    const existing = this.subagentThreads.get(threadId);
    if (existing) return existing;
    const state: SessionState = {
      sessionId: parent.sessionId,
      providerSessionId: threadId,
      workspaceRoot: parent.workspaceRoot,
      permissionPreset: parent.permissionPreset,
      nextTranscriptSequence: 0,
      preResponseLifecycle: new Map(),
      preResponseLifecycleOverflowed: false,
      completedItemKeys: new Set(),
      nativeStateByChild: new Map(),
      deltas: new DeltaCoalescer((item) => this.emitTranscript(state, item), this.deltaCoalescer),
      startedItems: new Map(),
      submittedCommandIds: new Set(),
      planRevisions: new Map(),
      subagentOf: threadId,
      subagentParent: parent,
      subagentTitle: title,
    };
    this.subagentThreads.set(threadId, state);
    return state;
  }

  /** A sub-agent's rows go out tagged with it and without the parent's turn. */
  private emitTranscript(state: SessionState, item: DaemonTranscriptItem): void {
    if (!state.subagentOf) {
      this.emit({ kind: 'transcript', item });
      return;
    }
    const routed = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'turnId')) as unknown as DaemonTranscriptItem;
    this.emit({ kind: 'transcript', item: routed, providerChildId: state.subagentOf });
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

  private handleCodexError(
    state: SessionState | undefined,
    sessionId: string | undefined,
    providerTurnId: string | undefined,
    message: string,
    recoverable: boolean,
  ): void {
    state?.deltas.flushAll();
    const active = state?.activeTurn;
    const matchingActive = active && providerTurnId && active.providerTurnId === providerTurnId
      ? active
      : undefined;
    if (state && !recoverable && (!providerTurnId || matchingActive)) {
      this.clearActiveTurn(state, new Error(message));
    }
    this.emit({
      kind: 'provider-error',
      ...(sessionId ? { sessionId } : {}),
      ...(providerTurnId ? {
        turnScope: {
          providerTurnId,
          ...(matchingActive ? { turnId: matchingActive.localTurnId } : {}),
        },
      } : {}),
      code: 'codex-turn-error',
      message,
      recoverable,
    });
  }

  private bufferPreResponseLifecycle(
    state: SessionState,
    providerTurnId: string,
    event: PreResponseLifecycleEvent,
  ): void {
    let record = state.preResponseLifecycle.get(providerTurnId);
    if (!record) {
      if (state.preResponseLifecycle.size >= MAX_PRE_RESPONSE_LIFECYCLE_TURNS) {
        const oldestProviderTurnId = state.preResponseLifecycle.keys().next().value as string | undefined;
        if (oldestProviderTurnId) {
          state.preResponseLifecycle.delete(oldestProviderTurnId);
          state.preResponseLifecycleOverflowed = true;
        }
      }
      record = {};
      state.preResponseLifecycle.set(providerTurnId, record);
    }
    if (record.terminal) return;
    switch (event.kind) {
      case 'started':
        record.started ??= event;
        break;
      case 'completed':
        record.terminal = event;
        break;
      case 'error':
        if (event.recoverable) record.retryableError = event;
        else record.terminal = event;
        break;
    }
  }

  private takePreResponseLifecycle(
    state: SessionState,
    providerTurnId: string,
  ): { readonly events: readonly PreResponseLifecycleEvent[]; readonly overflowedWithoutMatch: boolean } {
    const record = state.preResponseLifecycle.get(providerTurnId);
    const overflowedWithoutMatch = state.preResponseLifecycleOverflowed && !record;
    state.preResponseLifecycle.clear();
    state.preResponseLifecycleOverflowed = false;
    return {
      events: record
        ? [record.started, record.retryableError, record.terminal].filter(
            (event): event is PreResponseLifecycleEvent => event !== undefined,
          )
        : [],
      overflowedWithoutMatch,
    };
  }

  private clearPreResponseLifecycle(state: SessionState): void {
    state.preResponseLifecycle.clear();
    state.preResponseLifecycleOverflowed = false;
  }

  private handleTurnStarted(
    state: SessionState,
    turn: JsonObject | undefined,
    deferInterrupt = false,
  ): void {
    if (!turn) return;
    const providerTurnId = asString(turn?.id);
    if (!providerTurnId) return;
    if (
      state.activeTurn
      && !state.activeTurn.providerTurnId
      && !this.turnMatchesActive(state.activeTurn, turn, providerTurnId)
    ) {
      this.bufferPreResponseLifecycle(state, providerTurnId, { kind: 'started', turn });
      return;
    }
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
    if (!deferInterrupt) this.dispatchPendingInterrupt(state, state.activeTurn);
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
    })).then((result) => {
      requireObjectResult('turn/interrupt', result);
    }).then(
      () => this.settlePendingInterrupt(active),
      (error) => {
        if (!this.settlePendingInterrupt(active, error)) return;
        this.emit({
          kind: 'provider-error',
          sessionId: state.sessionId,
          turnScope: {
            turnId: active.localTurnId,
            providerTurnId,
          },
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
    this.clearPreResponseLifecycle(state);
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
    state.deltas.flushAll();
    const active = state.activeTurn;
    if (
      active
      && !active.providerTurnId
      && !this.turnMatchesActive(active, turn, providerTurnId)
    ) {
      this.bufferPreResponseLifecycle(state, providerTurnId, { kind: 'completed', turn });
      return;
    }
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
    this.settleStartedItems(state, providerTurnId, outcome === 'interrupted');
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
    if (state.activeTurn === matchingActive) {
      state.activeTurn = undefined;
      this.clearPreResponseLifecycle(state);
    }
    this.emit({
      kind: 'session-state',
      sessionId: state.sessionId,
      state: outcome === 'failed' ? 'failed' : outcome === 'interrupted' ? 'interrupted' : 'idle',
      ...(asString(error?.message)
        ? { detail: sanitizeProviderDiagnostic(asString(error?.message)).text }
        : {}),
    });
    const proposal = state.proposedPlan?.providerTurnId === providerTurnId ? state.proposedPlan : undefined;
    if (proposal) state.proposedPlan = undefined;
    if (proposal && outcome === 'completed' && matchingActive?.planMode) this.proposePlan(state, providerTurnId, proposal.markdown);
  }

  /**
   * Codex ends a plan-mode turn with a proposed plan and never asks about it; the
   * host asks, as a plan approval that belongs to no turn, so it reaches the inbox,
   * notifications and phones like any other decision.
   */
  private proposePlan(state: SessionState, providerTurnId: string, markdown: string): void {
    const providerRequestId = `${PROPOSED_PLAN_REQUEST_PREFIX}${providerTurnId}`;
    if (this.pendingApprovals.has(providerRequestId)) return;
    this.pendingApprovals.set(providerRequestId, {
      providerRequestId, kind: 'proposed-plan', sessionId: state.sessionId, providerSessionId: state.providerSessionId, params: {},
      resolve: () => undefined,
    });
    this.emit({
      kind: 'approval-requested',
      sessionId: state.sessionId,
      providerRequestId,
      risk: 'write',
      title: 'Approve plan',
      detail: boundedText(markdown.split(/\r?\n/u).find((line) => line.trim()) ?? '', 2_000),
      request: { v: 1, kind: 'plan', markdown: clipApprovalBody(markdown) },
    });
  }

  private handleItem(
    state: SessionState,
    providerTurnId: string | undefined,
    item: JsonObject | undefined,
    completed: boolean,
    atMs?: number,
  ): void {
    const itemId = asString(item?.id);
    const itemType = asString(item?.type);
    if (!providerTurnId || !item || !itemId || !itemType) return;
    if (itemType === 'collabAgentToolCall' || itemType === 'subAgentActivity') {
      this.emitNativeSubagents(state, item, completed);
    }
    let durationMs: number | undefined;
    if (completed) {
      const key = `${providerTurnId}:${itemId}:${itemType}`;
      if (state.completedItemKeys.has(key)) return;
      state.completedItemKeys.add(key);
      const startedAtMs = state.startedItems.get(itemId)?.startedAtMs;
      state.startedItems.delete(itemId);
      if (startedAtMs !== undefined && atMs !== undefined) durationMs = Math.max(0, atMs - startedAtMs);
    } else if (itemType === 'reasoning' || TOOL_ITEM_TYPES.has(itemType)) {
      state.startedItems.set(itemId, { providerTurnId, item, ...(atMs !== undefined ? { startedAtMs: atMs } : {}) });
      if (state.startedItems.size > MAX_STARTED_ITEMS) {
        state.startedItems.delete(state.startedItems.keys().next().value as string);
      }
    }
    if (completed && itemType === 'plan' && !state.subagentOf) {
      const markdown = providerTranscriptText(item.text);
      if (markdown.trim()) state.proposedPlan = { providerTurnId, markdown };
    }
    const transcript = this.transcriptFromItem(
      state.sessionId,
      providerTurnId,
      item,
      this.nextSequence(state),
      this.isoNow(),
      !completed,
      durationMs,
    );
    if (!transcript) {
      state.nextTranscriptSequence -= 1;
      return;
    }
    this.emitTranscript(state, transcript);
  }

  /** Closes the turn's in-flight items; on interrupt, open tool calls get an `interrupted` result. */
  private settleStartedItems(state: SessionState, providerTurnId: string, interrupted: boolean): void {
    state.planRevisions.delete(providerTurnId);
    const open = [...state.startedItems.values()].filter((entry) => entry.providerTurnId === providerTurnId);
    for (const entry of open) {
      state.startedItems.delete(asString(entry.item.id) ?? '');
      if (interrupted && TOOL_ITEM_TYPES.has(asString(entry.item.type) ?? '')) {
        this.handleItem(state, providerTurnId, { ...entry.item, status: 'interrupted' }, true);
      }
    }
  }

  /** turn/plan/updated (the `update_plan` tool) becomes one todo notice per revision. */
  private handleTurnPlan(state: SessionState, params: JsonObject): void {
    const providerTurnId = asString(params.turnId);
    if (!providerTurnId || state.subagentOf) return;
    const items: TodoItem[] = asArray(params.plan).flatMap((value) => {
      const step = asObject(value);
      const text = asString(step?.step);
      return text ? [{ text: clip(text), status: todoStatus(step?.status) }] : [];
    }).slice(0, 100);
    const explanation = asString(params.explanation);
    if (!items.length && !explanation) return;
    const revision = (state.planRevisions.get(providerTurnId) ?? 0) + 1;
    state.planRevisions.set(providerTurnId, revision);
    const checklist = items.map((item) => item.status === 'completed'
      ? `- [x] ${item.text}`
      : `- [ ] ${item.text}${item.status === 'in_progress' ? ' (in progress)' : ''}`);
    const turnId = this.localTurnId(state.sessionId, providerTurnId);
    this.emit({
      kind: 'transcript',
      item: {
        id: opaqueId('codex_plan', state.sessionId, providerTurnId, String(revision)),
        sessionId: state.sessionId,
        ...(turnId ? { turnId } : {}),
        sequence: this.nextSequence(state),
        kind: 'notice',
        text: [explanation, ...checklist].filter(Boolean).join('\n').slice(0, MAX_SEMANTIC_TEXT),
        isDelta: false,
        isSensitive: true,
        payload: {
          v: 1,
          type: 'todo',
          source: 'codex-plan',
          items,
          ...(explanation ? { explanation: clip(explanation) } : {}),
        },
        createdAt: this.isoNow(),
      },
    });
  }

  /** Buffered deltas flush first, so a streamed message never lands after a later item. */
  private nextSequence(state: SessionState): number {
    state.deltas.flushAll();
    return ++state.nextTranscriptSequence;
  }

  private emitDelta(
    state: SessionState,
    params: JsonObject,
    kind: 'assistant-message' | 'reasoning',
    payload?: TranscriptPayload,
  ): void {
    const delta = providerTranscriptText(params.delta);
    const providerTurnId = asString(params.turnId);
    const providerItemId = asString(params.itemId);
    if (!delta || !providerTurnId || !providerItemId) return;
    const messageId = opaqueId('codex_message', state.sessionId, providerTurnId, providerItemId);
    const turnId = this.localTurnId(state.sessionId, providerTurnId);
    const createdAt = this.isoNow();
    // The sequence is taken at flush time so rows stay gapless and in emission order.
    state.deltas.append(messageId, delta, (text) => {
      const sequence = ++state.nextTranscriptSequence;
      return {
        id: opaqueId('codex_delta', state.providerSessionId, providerTurnId, providerItemId, String(sequence)),
        messageId,
        sessionId: state.sessionId,
        ...(turnId ? { turnId } : {}),
        sequence,
        kind,
        text,
        isDelta: true,
        isSensitive: true,
        ...(payload ? { payload } : {}),
        createdAt,
      };
    });
  }

  private transcriptFromItem(
    sessionId: string,
    providerTurnId: string,
    item: JsonObject,
    sequence: number,
    createdAt: string,
    started: boolean,
    durationMs?: number,
  ): DaemonTranscriptItem | undefined {
    const providerItemId = asString(item.id);
    const type = asString(item.type);
    if (!providerItemId || !type) return undefined;
    let kind: DaemonTranscriptItem['kind'];
    let text = '';
    let isSensitive = false;
    let payload: TranscriptPayload | undefined;
    switch (type) {
      case 'userMessage': {
        if (started) return undefined;
        const clientId = asString(item.clientId);
        if (clientId && this.sessions.get(sessionId)?.submittedCommandIds.has(clientId)) return undefined;
        kind = 'user-message';
        text = providerTranscriptText(item.content);
        break;
      }
      case 'agentMessage':
        if (started) return undefined;
        kind = 'assistant-message';
        text = providerTranscriptText(item.text);
        break;
      case 'reasoning':
        if (started) return undefined;
        kind = 'reasoning';
        text = [...asArray(item.summary), ...asArray(item.content)]
          .filter((value): value is string => typeof value === 'string').join('\n');
        // Codex streams no reasoning text; a timed row still shows the model thought.
        if (durationMs !== undefined) payload = { v: 1, type: 'reasoning', durationMs };
        break;
      case 'plan':
        if (started) return undefined;
        kind = 'reasoning';
        text = providerTranscriptText(item.text);
        payload = { v: 1, type: 'plan', ...(text.length <= 64_000 ? { markdown: text } : {}) };
        break;
      case 'commandExecution': {
        const command = displayCommand(item);
        const exitCode = integer(item.exitCode);
        kind = started ? 'tool-call' : 'tool-result';
        text = started
          ? `$ ${command}`
          : providerTranscriptText(item.aggregatedOutput)
            || (item.status !== 'declined' && exitCode !== undefined
              ? `Exit code ${String(exitCode)}`
              : `Command ${asString(item.status) ?? 'completed'}.`);
        isSensitive = true;
        payload = toolPayload({
          callId: providerItemId, name: 'commandExecution', ...commandShape(item, command), started, status: item.status,
          command, cwd: asString(item.cwd), exitCode, durationMs: nonNegativeInteger(item.durationMs) ?? durationMs,
        });
        break;
      }
      case 'fileChange': {
        const changes = fileChanges(item);
        const summary = fileChangeSummary(changes, this.sessions.get(sessionId)?.workspaceRoot) || 'File changes updated.';
        const status = asString(item.status);
        kind = started ? 'tool-call' : 'tool-result';
        text = started
          ? summary
          : status === 'completed'
            ? this.fileChangeRecord(item) ?? summary
            : status === 'declined' || status === 'failed' || status === 'interrupted' ? `File changes ${status}.` : summary;
        payload = toolPayload({
          callId: providerItemId,
          name: 'fileChange',
          category: changes.length > 0 && changes.every((change) => change.kind === 'add') ? 'write' : 'edit',
          started,
          status,
          target: changes.length === 1 ? changes[0]!.path : changes.length > 1 ? `${String(changes.length)} files` : undefined,
          files: changes.map((change) => ({
            path: clip(change.path),
            ...(change.kind ? { kind: change.kind } : {}),
            ...diffLineCounts(change),
          })),
          durationMs,
        });
        break;
      }
      case 'mcpToolCall':
      case 'dynamicToolCall': {
        const tool = asString(item.tool) ?? 'tool';
        const server = asString(item.server) ?? asString(item.namespace);
        const body = providerTranscriptText(started ? item.arguments : item.result ?? item.output ?? item.error);
        kind = started ? 'tool-call' : 'tool-result';
        text = `${asString(item.server) ? `${asString(item.server)}/` : ''}${asString(item.tool) ?? 'tool'}: ${asString(item.status) ?? (started ? 'started' : 'completed')}`;
        if (body) text += `\n${body}`;
        payload = toolPayload({
          callId: providerItemId, name: tool, category: 'mcp', started, status: item.status,
          target: server ? `${server} / ${tool}` : tool, server,
          durationMs: nonNegativeInteger(item.durationMs) ?? durationMs,
        });
        break;
      }
      case 'functionCallOutput':
        if (started) return undefined;
        kind = 'tool-result';
        text = providerTranscriptText(item.output) || `${asString(item.name) ?? 'function'} completed.`;
        break;
      case 'collabAgentToolCall': {
        // Spawning is the call a sub-agent hangs off; waiting and messaging are plumbing.
        if (!SPAWN_AGENT_TOOLS.has(asString(item.tool) ?? '')) return undefined;
        const prompt = asString(item.prompt);
        kind = started ? 'tool-call' : 'tool-result';
        text = started ? `spawn_agent\n${prompt ?? ''}`.trim() : `Sub-agent ${asString(item.status) ?? 'started'}.`;
        payload = toolPayload({
          callId: providerItemId, name: 'spawn_agent', category: 'agent', started, status: item.status,
          target: boundedText(prompt, 120).split(/\r?\n/u)[0] || 'Codex sub-agent', durationMs,
        });
        break;
      }
      case 'subAgentActivity': {
        if (asString(item.kind) !== 'started') return undefined;
        const title = subagentTitle(asString(item.agentPath) ?? '');
        kind = started ? 'tool-call' : 'tool-result';
        text = started ? `Sub-agent ${title}` : `Started sub-agent ${title}.`;
        payload = toolPayload({ callId: providerItemId, name: 'spawn_agent', category: 'agent', started, status: started ? 'inProgress' : 'completed', target: title, durationMs });
        break;
      }
      case 'webSearch': {
        const query = webSearchQuery(item);
        kind = started ? 'tool-call' : 'tool-result';
        text = started ? (query ? `Search the web: ${query}` : 'Search the web') : webSearchResultText(item, query);
        payload = toolPayload({
          callId: providerItemId, name: 'webSearch', category: 'web', started, status: item.status,
          target: webSearchTarget(item, query), query, durationMs,
        });
        break;
      }
      case 'imageView':
      case 'imageGeneration':
        kind = started ? 'tool-call' : 'tool-result';
        text = providerTranscriptText(item);
        if (type === 'imageView') {
          payload = toolPayload({
            callId: providerItemId, name: 'imageView', category: 'read', started, status: item.status,
            target: asString(item.path), durationMs,
          });
        }
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
    if (!text && payload?.type !== 'reasoning') return undefined;
    isSensitive ||= kind === 'user-message'
      || kind === 'assistant-message'
      || kind === 'reasoning';
    const localTurnId = this.localTurnId(sessionId, providerTurnId);
    return {
      id: opaqueId('codex_item', sessionId, providerTurnId, providerItemId, started ? 'started' : 'completed'),
      messageId: opaqueId('codex_message', sessionId, providerTurnId, providerItemId),
      sessionId,
      ...(localTurnId ? { turnId: localTurnId } : {}),
      sequence,
      kind,
      text: text.slice(0, MAX_SEMANTIC_TEXT),
      isDelta: false,
      isSensitive,
      ...(payload ? { payload } : {}),
      createdAt,
    };
  }

  private emitNativeSubagents(state: SessionState, item: JsonObject, completed: boolean): void {
    // A thread reporting back to its own parent (or a main session) is not a new sub-agent.
    const isOwnLineage = (threadId: string): boolean => this.sessionIdByProviderId.has(threadId)
      || threadId === state.providerSessionId
      || threadId === state.subagentParent?.providerSessionId;
    if (item.type === 'subAgentActivity') {
      const childId = asString(item.agentThreadId);
      if (!childId || isOwnLineage(childId)) return;
      const activity = asString(item.kind);
      const known = this.subagentThreads.get(childId);
      if (!known && activity !== 'started') return;
      const child = known ?? this.trackSubagent(state, childId, subagentTitle(asString(item.agentPath) ?? childId));
      const next = nativeState(activity);
      this.emitNativeSubagent(state, childId, child.subagentTitle ?? 'Codex sub-agent', next,
        next === 'done' || next === 'error' ? child.lastAgentMessage : undefined,
        activity === 'started' && asString(item.id) ? { toolUseId: asString(item.id)! } : {});
      return;
    }
    const receiverIds = asArray(item.receiverThreadIds).filter((value): value is string => typeof value === 'string');
    const states = asObject(item.agentsStates);
    const childIds = new Set([...receiverIds, ...Object.keys(states ?? {})]);
    const prompt = asString(item.prompt);
    for (const childId of childIds) {
      if (isOwnLineage(childId)) continue;
      const childState = asObject(states?.[childId]);
      const child = this.trackSubagent(state, childId, boundedText(prompt, 120).split(/\r?\n/u)[0] || asString(item.tool) || 'Codex sub-agent');
      const message = asString(childState?.message)
        ? sanitizeProviderDiagnostic(asString(childState?.message), { maxLength: 2_000 }).text
        : undefined;
      this.emitNativeSubagent(
        state,
        childId,
        child.subagentTitle ?? 'Codex sub-agent',
        nativeState(childState?.status ?? item.status ?? (completed ? 'completed' : 'inProgress')),
        message,
        {
          ...(SPAWN_AGENT_TOOLS.has(asString(item.tool) ?? '') && asString(item.id) ? { toolUseId: asString(item.id)! } : {}),
          ...(SPAWN_AGENT_TOOLS.has(asString(item.tool) ?? '') && prompt ? { instruction: boundedText(prompt, 8_000) } : {}),
        },
      );
    }
  }

  private emitNativeSubagent(
    state: SessionState,
    childId: string,
    title: string,
    childState: 'starting' | 'working' | 'blocked' | 'done' | 'error',
    summary?: string,
    start: { readonly toolUseId?: string; readonly instruction?: string } = {},
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
      ...(start.toolUseId ? { toolUseId: start.toolUseId } : {}),
      ...(start.instruction ? { instruction: start.instruction } : {}),
      // A sub-agent's own sub-agent nests under it.
      ...(state.subagentOf ? { parentProviderChildId: state.subagentOf } : {}),
    });
  }

  private fileChangeRecord(item: JsonObject): string | undefined {
    const changes = asArray(item.changes).flatMap(value => {
      const change = asObject(value);
      return change && typeof change.path === 'string' && typeof change.diff === 'string'
        ? [{ path: change.path, patch: change.diff, coverage: 'patch' as const }] : [];
    });
    return encodeFileChanges(changes);
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

  private registerSession(context: ProviderSessionContext, providerSessionId: string, model?: string, appliedEffort?: string | null): SessionState {
    const existingOwner = this.sessionIdByProviderId.get(providerSessionId);
    if (existingOwner && existingOwner !== context.sessionId) {
      throw new Error(`Codex thread ${providerSessionId} is already attached to another EZTerminal session.`);
    }
    const state: SessionState = {
      sessionId: context.sessionId,
      providerSessionId,
      workspaceRoot: context.workspaceRoot,
      ...(model ? { model } : {}),
      ...(context.reasoningEffort ?? appliedEffort ? { reasoningEffort: context.reasoningEffort ?? appliedEffort! } : {}),
      permissionPreset: context.permissionPreset,
      nextTranscriptSequence: 0,
      preResponseLifecycle: new Map(),
      preResponseLifecycleOverflowed: false,
      completedItemKeys: new Set(),
      nativeStateByChild: new Map(),
      deltas: new DeltaCoalescer((item) => this.emit({ kind: 'transcript', item }), this.deltaCoalescer),
      startedItems: new Map(),
      submittedCommandIds: new Set(),
      planRevisions: new Map(),
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
      ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}),
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
    if (context.toolsDisabled) throw new Error('This Codex app-server does not expose a verified tool-free mode. Choose a provider that supports tool-free planning proposals.');
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
