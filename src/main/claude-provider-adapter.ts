import { DeltaCoalescer, type DeltaCoalescerOptions } from './delta-coalescer';
import { clipApprovalBody, parseApprovalRequest, type ApprovalRequest } from '../shared/approval-request';
import { claudeFileChange, encodeFileChanges, replacementLines, type RecordedFileChange } from '../shared/conversation-changes';
import { toolCategory, toolTarget } from '../shared/tool-catalog';
import type { TodoItem, ToolPayload, ToolStatus, TranscriptPayload } from '../shared/transcript-payload';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentCapabilityItem, AgentExtensionCommand, ProviderCapabilityCatalog } from '../shared/agent-capabilities';
import { claudeExtensionArguments, runNativeExtensionCommand } from './agent-native-extensions';

import {
  getSessionMessages,
  query,
  type CanUseTool,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { DaemonTranscriptItem, PermissionPreset } from '../shared/daemon-protocol';
import { promptWithChatContext } from '../shared/chat-message';
import {
  CLAUDE_FIRST_LAUNCH_AUTHENTICATION_DETAIL,
  DEFAULT_CLAUDE_PROVIDER_ENABLEMENT,
  getClaudeEnablementGateFailure,
  type ClaudeAuthenticationPath,
  type ClaudeProviderEnablement,
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
  buildProviderProcessEnvironment,
  sameEnvironmentVariableSet,
  sanitizeProviderDiagnostic,
} from './provider-process-security';
import { compareSemanticVersions, semanticVersion } from './provider-version';
import { providerTranscriptText } from './provider-transcript';

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 15_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_500;
const MAX_SAFE_TEXT_LENGTH = 20_000;
const MAX_RECONCILIATION_ITEMS = 2_000;
const MAX_PROVIDER_HISTORY_MESSAGES = 5_000;
const MAX_TRACKED_TOOL_CALLS = 500;
/** Oldest Claude Code CLI this adapter will review, enable and launch. */
export const CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION = '2.1.260';
const CLAUDE_AGENT_SDK_ARGV = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'stream-json',
  '--permission-prompt-tool',
  'stdio',
] as const;
const CLAUDE_NETWORK_ENVIRONMENT_VARIABLES = [
  'PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
] as const;
const CLAUDE_EXISTING_CLI_ENVIRONMENT_VARIABLES = [
  ...CLAUDE_NETWORK_ENVIRONMENT_VARIABLES,
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_RESOURCE',
] as const;

type JsonObject = Record<string, unknown>;

export type { ClaudeAuthenticationPath, ClaudeProviderEnablement } from '../shared/daemon-provider';
export { DEFAULT_CLAUDE_PROVIDER_ENABLEMENT } from '../shared/daemon-provider';

export interface ClaudeProviderEnablementStore {
  load(): Promise<ClaudeProviderEnablement>;
  save(value: ClaudeProviderEnablement): Promise<void>;
}

export class MemoryClaudeProviderEnablementStore implements ClaudeProviderEnablementStore {
  private value: ClaudeProviderEnablement;

  constructor(initial: ClaudeProviderEnablement = DEFAULT_CLAUDE_PROVIDER_ENABLEMENT) {
    this.value = { ...initial };
  }

  async load(): Promise<ClaudeProviderEnablement> {
    return { ...this.value };
  }

  async save(value: ClaudeProviderEnablement): Promise<void> {
    this.value = { ...value };
  }
}

export type ClaudeProviderErrorCode =
  | 'CLAUDE_PROVIDER_DISABLED'
  | 'CLAUDE_TERMS_REQUIRED'
  | 'CLAUDE_COMMERCIAL_APPROVAL_REQUIRED'
  | 'CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED'
  | 'CLAUDE_EXECUTABLE_NOT_FOUND'
  | 'CLAUDE_EXECUTABLE_INVALID'
  | 'CLAUDE_AUTHENTICATION_FAILED'
  | 'CLAUDE_ACCOUNT_UNAVAILABLE'
  | 'CLAUDE_BILLING_ERROR'
  | 'CLAUDE_RATE_LIMITED'
  | 'CLAUDE_OVERLOADED'
  | 'CLAUDE_MODEL_NOT_FOUND'
  | 'CLAUDE_INVALID_REQUEST'
  | 'CLAUDE_OPERATION_ABORTED'
  | 'CLAUDE_OPERATION_TIMEOUT'
  | 'CLAUDE_SESSION_NOT_FOUND'
  | 'CLAUDE_APPROVAL_NOT_FOUND'
  | 'CLAUDE_PROCESS_EXITED'
  | 'CLAUDE_PROVIDER_ERROR';

const ERROR_MESSAGES: Readonly<Record<ClaudeProviderErrorCode, string>> = {
  CLAUDE_PROVIDER_DISABLED: 'Claude Agent is disabled until its provider consent is completed.',
  CLAUDE_TERMS_REQUIRED: 'Claude Agent requires explicit acceptance of the applicable Anthropic terms.',
  CLAUDE_COMMERCIAL_APPROVAL_REQUIRED: 'Claude Agent requires explicit commercial-use approval.',
  CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED:
    'Using a claude.ai login or its subscription rate limits in a third-party product requires prior Anthropic approval. EZTerminal does not start or provide that login flow.',
  CLAUDE_EXECUTABLE_NOT_FOUND: 'An installed Claude executable could not be found.',
  CLAUDE_EXECUTABLE_INVALID:
    'The Claude executable is no longer at the reviewed path or is outside the supported version range.',
  CLAUDE_AUTHENTICATION_FAILED:
    'Claude authentication failed. Configure the installed Claude CLI or an API-key environment outside EZTerminal.',
  CLAUDE_ACCOUNT_UNAVAILABLE: 'The Claude account is currently unavailable.',
  CLAUDE_BILLING_ERROR: 'Claude could not run because of an account billing issue.',
  CLAUDE_RATE_LIMITED:
    'Claude is rate limited. EZTerminal does not provide or manage claude.ai subscription limits.',
  CLAUDE_OVERLOADED: 'Claude is temporarily overloaded. Try again later.',
  CLAUDE_MODEL_NOT_FOUND: 'The selected Claude model is unavailable.',
  CLAUDE_INVALID_REQUEST: 'Claude rejected the request.',
  CLAUDE_OPERATION_ABORTED: 'The Claude operation was interrupted.',
  CLAUDE_OPERATION_TIMEOUT: 'The Claude operation did not finish before its safety deadline.',
  CLAUDE_SESSION_NOT_FOUND: 'The Claude session is not active in this daemon.',
  CLAUDE_APPROVAL_NOT_FOUND: 'The Claude approval request is no longer pending.',
  CLAUDE_PROCESS_EXITED: 'The Claude process exited unexpectedly.',
  CLAUDE_PROVIDER_ERROR: 'Claude Agent encountered an unexpected provider error.',
};

export class ClaudeProviderError extends Error {
  readonly code: ClaudeProviderErrorCode;
  readonly recoverable: boolean;

  constructor(code: ClaudeProviderErrorCode, recoverable = false) {
    // Never retain the provider's raw error/cause: SDK errors may echo command
    // input or environment-derived authentication details.
    super(ERROR_MESSAGES[code]);
    this.name = 'ClaudeProviderError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface ClaudeExecutableResolutionOptions {
  readonly configuredPath?: string;
  readonly platform?: NodeJS.Platform;
  /** PATH is the only value inspected; credential-bearing values are ignored. */
  readonly pathValue?: string;
  readonly isFile?: (candidate: string) => Promise<boolean>;
  readonly realpath?: (candidate: string) => Promise<string>;
}

/**
 * Resolve a spawnable file without invoking a shell. On Windows npm's .cmd and
 * .ps1 launchers are never returned; their fixed package-relative native exe is
 * selected instead.
 */
export async function resolveClaudeExecutable(
  options: ClaudeExecutableResolutionOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const isFile = options.isFile ?? (async (candidate: string): Promise<boolean> => {
    try {
      return (await fs.stat(candidate)).isFile();
    } catch {
      return false;
    }
  });
  const canonicalize = options.realpath ?? (async (candidate: string): Promise<string> => {
    try {
      return await fs.realpath(candidate);
    } catch {
      return pathApi.resolve(candidate);
    }
  });

  const accept = async (candidate: string): Promise<string | null> => {
    if (!pathApi.isAbsolute(candidate) || !await isFile(candidate)) return null;
    const canonical = await canonicalize(candidate);
    if (!pathApi.isAbsolute(canonical) || !await isFile(canonical)) return null;
    if (platform === 'win32' && !/\.(?:exe|js|mjs)$/iu.test(canonical)) return null;
    return pathApi.normalize(canonical);
  };

  const nativeTargetForWindowsShim = async (shim: string): Promise<string | null> => {
    if (!/\.(?:cmd|ps1)$/iu.test(shim) || !await isFile(shim)) return null;
    return accept(pathApi.join(
      pathApi.dirname(shim),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    ));
  };

  if (options.configuredPath !== undefined) {
    if (!pathApi.isAbsolute(options.configuredPath)) return null;
    if (platform === 'win32' && /\.(?:cmd|ps1)$/iu.test(options.configuredPath)) {
      return nativeTargetForWindowsShim(pathApi.normalize(options.configuredPath));
    }
    return accept(pathApi.normalize(options.configuredPath));
  }

  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const directories = pathValue.split(delimiter).filter((entry) => entry.trim().length > 0);
  for (const directory of directories) {
    const absoluteDirectory = pathApi.resolve(directory.trim().replace(/^"|"$/gu, ''));
    if (platform === 'win32') {
      const direct = await accept(pathApi.join(absoluteDirectory, 'claude.exe'));
      if (direct) return direct;
      for (const extension of ['cmd', 'ps1'] as const) {
        const native = await nativeTargetForWindowsShim(pathApi.join(absoluteDirectory, `claude.${extension}`));
        if (native) return native;
      }
      continue;
    }
    const direct = await accept(pathApi.join(absoluteDirectory, 'claude'));
    if (direct) return direct;
  }
  return null;
}

interface ClaudeInterruptReceipt {
  readonly still_queued?: readonly string[];
}

export interface ClaudeQuerySession extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<ClaudeInterruptReceipt | undefined>;
  setPermissionMode(mode: NonNullable<Options['permissionMode']>): Promise<void>;
  setModel(model?: string): Promise<void>;
  initializationResult(): Promise<unknown>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedCommands?(): Promise<readonly { name: string; description: string }[]>;
  mcpServerStatus?(): Promise<readonly { name: string; status: string; scope?: string }[]>;
  close(): void;
  return?(value?: void): Promise<IteratorResult<SDKMessage, void>>;
}

export type ClaudeQueryFactory = (input: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}) => ClaudeQuerySession;

export interface ClaudeProviderAdapterOptions {
  readonly enablementStore?: ClaudeProviderEnablementStore;
  readonly queryFactory?: ClaudeQueryFactory;
  readonly historyReader?: (
    sessionId: string,
    options?: { readonly dir?: string; readonly limit?: number },
  ) => Promise<SessionMessage[]>;
  readonly executablePath?: string;
  readonly resolveExecutable?: () => Promise<string | null>;
  readonly readExecutableVersion?: (
    executablePath: string,
    environment?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly initializationTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly extensionCommand?: typeof runNativeExtensionCommand;
  /** Streaming batch timing; replay passes a scheduler that never fires so goldens are deterministic. */
  readonly deltaCoalescer?: DeltaCoalescerOptions;
  /** Expose Claude Code's task tools (TaskCreate/TaskUpdate) to tool-enabled sessions. Defaults to true. */
  readonly enableTaskTools?: boolean;
}

type TurnState = 'submitted' | 'completed' | 'interrupted' | 'failed';

interface TurnRecord {
  readonly turnId: string;
  readonly commandId: string;
  readonly clientUuid: string;
  state: TurnState;
  providerTurnId?: string;
  interruptRequested: boolean;
}

interface PendingApproval {
  readonly requestId: string;
  readonly toolUseId: string;
  readonly input: Record<string, unknown>;
  readonly turnId?: string;
  readonly promise: Promise<PermissionResult>;
  settle(result: PermissionResult): void;
}

interface ToolCallRecord {
  readonly name: string;
  readonly input: unknown;
}

/** The main thread's streaming assistant message (one at a time; blocks are sequential). */
interface StreamState {
  readonly messageId: string;
  /** Latest content_block_start; that block's final `assistant` message arrives before its stop. */
  index?: number;
  thinking?: { readonly index: number; readonly startedAt: number; text: string };
}

interface TranscriptOptions {
  readonly turnId?: string;
  readonly source: string;
  readonly messageId?: string;
  readonly payload?: TranscriptPayload;
  /** Keep an empty body; a reasoning row still carries its duration. */
  readonly allowEmpty?: boolean;
  readonly isDelta?: boolean;
}

interface SessionRecord {
  readonly context: ProviderSessionContext;
  readonly enablement: ClaudeProviderEnablement;
  handle: ProviderSessionHandle;
  readonly abortController: AbortController;
  readonly input: AsyncInputQueue<SDKUserMessage>;
  query: ClaudeQuerySession;
  streamPromise: Promise<void>;
  readonly turnsByCommand: Map<string, TurnRecord>;
  readonly turnsByUuid: Map<string, TurnRecord>;
  /** The turn the CLI is answering; only its first message carries user_message_uuid. */
  activeTurn?: TurnRecord;
  stream?: StreamState;
  readonly coalescer: DeltaCoalescer;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly toolCalls: Map<string, ToolCallRecord>;
  /** Claude Code's task list (TaskCreate/TaskUpdate ids, or TodoWrite positions). */
  readonly tasks: Map<string, TodoItem>;
  readonly fileChanges: Map<string, RecordedFileChange>;
  readonly childTitles: Map<string, string>;
  readonly transcript: DaemonTranscriptItem[];
  sequence: number;
  disposed: boolean;
  initialized: boolean;
  readonly authenticationReady: Promise<void>;
  resolveAuthentication(): void;
  rejectAuthentication(error: ClaudeProviderError): void;
  authenticationSettled: boolean;
  apiKeySource?: string;
  initializationReceived: boolean;
  accountAuthentication?: ClaudeAccountAuthenticationEvidence;
  startupError?: ClaudeProviderError;
}

interface ClaudeAccountAuthenticationEvidence {
  readonly apiProvider?: string;
  readonly apiKeySource?: string;
  readonly hasSubscription: boolean;
  readonly indicatesOAuth: boolean;
}

class AsyncInputQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new ClaudeProviderError('CLAUDE_PROCESS_EXITED', true);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function safeText(value: unknown, maxLength = MAX_SAFE_TEXT_LENGTH): string {
  return typeof value === 'string'
    ? sanitizeProviderDiagnostic(value, { maxLength }).text
    : '';
}

function compatibleClaudeExecutableVersion(version: string): boolean {
  const candidate = semanticVersion(version);
  const minimum = semanticVersion(CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION);
  if (!candidate || !minimum) return false;
  if (candidate.prerelease !== undefined) return false;
  if (candidate.core[0] !== minimum.core[0]) return false;
  return compareSemanticVersions(candidate, minimum) >= 0;
}

function incompatibleClaudeVersionReason(version: string): string {
  const candidate = semanticVersion(version);
  if (!candidate) {
    return `The installed Claude Code version could not be read; install ${CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION} or newer.`;
  }
  if (candidate.prerelease !== undefined) {
    return `Claude Code ${version} is a prerelease; install stable ${CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION} or newer.`;
  }
  return `Claude Code ${version} is outside the supported range; install ${CLAUDE_CLI_MINIMUM_SUPPORTED_VERSION} or newer within the same major version.`;
}

function claudeEnvironmentVariableNames(
  authenticationPath: ClaudeAuthenticationPath,
): readonly string[] {
  if (authenticationPath === 'api-key-environment') {
    return [...CLAUDE_NETWORK_ENVIRONMENT_VARIABLES, 'ANTHROPIC_API_KEY'];
  }
  if (authenticationPath === 'existing-cli-environment') {
    return CLAUDE_EXISTING_CLI_ENVIRONMENT_VARIABLES;
  }
  // Existing claude.ai login reads the installed CLI credential store. OAuth
  // bearer environment variables are intentionally unsupported.
  return CLAUDE_NETWORK_ENVIRONMENT_VARIABLES;
}

function safeToolName(value: unknown): string {
  const candidate = typeof value === 'string' ? value : 'tool';
  const sanitized = candidate.replace(/[^A-Za-z0-9_.:-]/gu, '').slice(0, 80);
  return sanitized || 'tool';
}

function deterministicCommandUuid(commandId: string): string {
  const bytes = createHash('sha256').update(`ezterminal:claude:${commandId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function permissionMode(preset: PermissionPreset): NonNullable<Options['permissionMode']> {
  switch (preset) {
    case 'plan': return 'plan';
    case 'full-access': return 'bypassPermissions';
    case 'standard': return 'default';
  }
}

function toolRisk(toolName: string): 'read' | 'write' | 'danger' {
  if (['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'AskUserQuestion'].includes(toolName)) return 'read';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'ExitPlanMode'].includes(toolName)) return 'write';
  return 'danger';
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Shared by streamed deltas and the block's final text so the renderer replaces one with the other. */
function claudeMessageId(providerMessageId: string, index: number): string {
  return `claude_msg:${providerMessageId}:${String(index)}`;
}

function shortText(value: string): string {
  return clipApprovalBody(value, 2_000);
}

function firstLine(value: string, limit = 160): string {
  const line = value.trim().split(/\r?\n/u, 1)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}...` : line;
}

/** Legacy `Name\n{json}` body. JSON keeps every field; a Write's path must not collapse into its content. */
function toolCallText(name: string, input: unknown): string {
  return `${name}\n${typeof input === 'object' && input !== null ? JSON.stringify(input, null, 2) : providerTranscriptText(input)}`;
}

/** ToolSearch answers with tool_reference blocks; show the loaded tool names instead of their JSON. */
function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return providerTranscriptText(content);
  return content.map((entry) => {
    const block = asObject(entry);
    return block?.type === 'tool_reference' && typeof block.tool_name === 'string'
      ? block.tool_name
      : providerTranscriptText(entry);
  }).filter(Boolean).join('\n');
}

function toolCallPayload(name: string, callId: string, input: unknown): ToolPayload {
  const category = toolCategory(name);
  const target = toolTarget(name, input);
  const command = category === 'command' ? asString(asObject(input)?.command) : null;
  return {
    v: 1,
    type: 'tool',
    callId: shortText(callId),
    name: shortText(name),
    category,
    phase: 'call',
    status: 'running',
    ...(target ? { target: shortText(target) } : {}),
    ...(command ? { command: clipApprovalBody(command, 8_000) } : {}),
  };
}

function lineCount(value: unknown): number {
  return typeof value === 'string' && value ? value.replace(/\r?\n$/u, '').split(/\r?\n/u).length : 0;
}

/** Files touched by a successful Edit/MultiEdit/Write, counted from the call input the change record came from. */
/** Lines an edit adds and removes, counted from its line diff rather than its whole old and new text. */
function editCounts(edits: readonly (JsonObject | null)[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    for (const line of replacementLines(asString(edit?.old_string) ?? '', asString(edit?.new_string) ?? '')) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

function toolResultFiles(
  name: string,
  input: unknown,
  change: RecordedFileChange | undefined,
  structured: unknown,
): ToolPayload['files'] {
  const record = asObject(input);
  if (name === 'MultiEdit') {
    const filePath = asString(record?.file_path);
    if (!filePath) return undefined;
    return [{ path: shortText(filePath), kind: 'update', ...editCounts(asArray(record?.edits).map(asObject)) }];
  }
  if (!change) return undefined;
  if (name === 'Edit') {
    return [{ path: shortText(change.path), kind: 'update', ...editCounts([record]) }];
  }
  if (name === 'Write') {
    // An overwrite reports only the new content, so its removed lines are unknown.
    const created = asObject(structured)?.type === 'create';
    return [{ path: shortText(change.path), kind: created ? 'add' : 'update', ...(created ? { added: lineCount(record?.content) } : {}) }];
  }
  return undefined;
}

function todoStatus(value: unknown): TodoItem['status'] | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined;
}

function todoChecklist(items: readonly TodoItem[]): string {
  return items.map((item) => (
    `- [${item.status === 'completed' ? 'x' : ' '}] ${item.text}${item.status === 'in_progress' ? ' (in progress)' : ''}`
  )).join('\n') || 'No tasks.';
}

function prefixedLines(prefix: '+' | '-', value: unknown): string[] {
  return typeof value === 'string' && value
    ? value.replace(/\r?\n$/u, '').split(/\r?\n/u).map((line) => `${prefix}${line}`)
    : [];
}

/** A small unified-style diff: one `@@` hunk per replacement, or the written content as additions. */
function approvalDiff(toolName: string, input: Record<string, unknown>): string {
  const hunks = toolName === 'Write'
    ? [prefixedLines('+', input.content)]
    : (toolName === 'MultiEdit' ? asArray(input.edits).map(asObject) : [input])
      .map((edit) => replacementLines(asString(edit?.old_string) ?? '', asString(edit?.new_string) ?? ''));
  return hunks.map((lines) => ['@@', ...lines].join('\n')).join('\n');
}

/**
 * The approval card's subject plus a legacy title/detail. Sensitivity is
 * metadata; approval detail is local and archive-redacted
 * (docs/design/agent-collaboration.md).
 */
function claudeApproval(
  toolName: string,
  input: Record<string, unknown>,
  callId: string,
): { readonly title: string; readonly detail?: string; readonly request?: ApprovalRequest } {
  const target = toolTarget(toolName, input);
  const generic: ApprovalRequest = {
    v: 1,
    callId: shortText(callId),
    kind: 'tool',
    toolName: shortText(toolName),
    ...(target ? { target: shortText(target) } : {}),
    input: clipApprovalBody(JSON.stringify(input, null, 2)),
  };
  let title = `Use ${toolName}`;
  let detail = target;
  let request: unknown = generic;
  if (toolCategory(toolName) === 'command') {
    const command = asString(input.command) ?? '';
    title = 'Run command';
    detail = command;
    request = { v: 1, callId: shortText(callId), kind: 'command', command: clipApprovalBody(command) };
  } else if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    const filePath = asString(input.file_path) ?? '';
    title = `Edit ${path.win32.basename(filePath) || 'file'}`;
    detail = filePath;
    request = {
      v: 1,
      callId: shortText(callId),
      kind: 'file-change',
      // Whether a Write creates or replaces is unknown until it runs.
      files: [{ path: shortText(filePath), ...(toolName === 'Write' ? {} : { kind: 'update' }), diff: clipApprovalBody(approvalDiff(toolName, input)) }],
    };
  } else if (toolName === 'AskUserQuestion') {
    const questions = asArray(input.questions).map(asObject).slice(0, 4).map((question) => ({
      question: shortText(asString(question?.question) ?? ''),
      ...(asString(question?.header) ? { header: shortText(asString(question?.header)!) } : {}),
      multiSelect: question?.multiSelect === true,
      options: asArray(question?.options).map(asObject).filter((option) => asString(option?.label)).slice(0, 8).map((option) => ({
        label: shortText(asString(option?.label)!),
        ...(asString(option?.description) ? { description: shortText(asString(option?.description)!) } : {}),
      })),
    }));
    title = 'Answer a question';
    detail = questions[0]?.question;
    request = { v: 1, callId: shortText(callId), kind: 'question', questions };
  } else if (toolName === 'ExitPlanMode') {
    const markdown = asString(input.plan);
    const filePath = asString(input.planFilePath);
    title = 'Approve plan';
    detail = markdown ?? filePath ?? undefined;
    request = {
      v: 1,
      callId: shortText(callId),
      kind: 'plan',
      ...(markdown ? { markdown: clipApprovalBody(markdown) } : {}),
      ...(filePath ? { filePath: shortText(filePath) } : {}),
    };
  }
  const summary = detail ? firstLine(detail) : '';
  return {
    title,
    ...(summary ? { detail: summary } : {}),
    request: parseApprovalRequest(request) ?? parseApprovalRequest(generic),
  };
}

function normalizeEnablement(value: ClaudeProviderEnablement): ClaudeProviderEnablement {
  const authenticationPathIsKnown = [
    'api-key-environment',
    'existing-cli-environment',
    'existing-claude-ai-login',
  ].includes(value.authenticationPath);
  const authenticationPath: ClaudeAuthenticationPath = authenticationPathIsKnown
    ? value.authenticationPath
    : 'existing-cli-environment';
  return {
    enabled: value.enabled === true && authenticationPathIsKnown,
    termsAccepted: value.termsAccepted === true,
    commercialUseApproved: value.commercialUseApproved === true,
    authenticationPath,
    anthropicThirdPartyApproval: value.anthropicThirdPartyApproval === true,
  };
}

function validateEnablement(value: ClaudeProviderEnablement): void {
  const failure = getClaudeEnablementGateFailure(value);
  if (failure) throw new ClaudeProviderError(failure.code);
}

function classifyErrorCode(value: unknown): ClaudeProviderErrorCode {
  if (value instanceof ClaudeProviderError) return value.code;
  const object = asObject(value);
  const code = [object?.error, object?.code, object?.name].find((entry): entry is string => typeof entry === 'string');
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : asString(object?.message) ?? '';
  const searchable = `${code ?? ''} ${message}`.toLocaleLowerCase('en-US');
  if (/oauth_org_not_allowed|third[- ]party|claude\.ai.*approval/u.test(searchable)) {
    return 'CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED';
  }
  if (/authentication_failed|not authenticated|authentication|unauthorized|login required/u.test(searchable)) {
    return 'CLAUDE_AUTHENTICATION_FAILED';
  }
  if (/account_on_hold|account.*(?:hold|unavailable)/u.test(searchable)) return 'CLAUDE_ACCOUNT_UNAVAILABLE';
  if (/billing_error|billing|payment required/u.test(searchable)) return 'CLAUDE_BILLING_ERROR';
  if (/rate_limit|rate limit|too many requests|\b429\b/u.test(searchable)) return 'CLAUDE_RATE_LIMITED';
  if (/overloaded|\b529\b/u.test(searchable)) return 'CLAUDE_OVERLOADED';
  if (/model_not_found|model.*not found/u.test(searchable)) return 'CLAUDE_MODEL_NOT_FOUND';
  if (/invalid_request|bad request/u.test(searchable)) return 'CLAUDE_INVALID_REQUEST';
  if (/abort|interrupt/u.test(searchable)) return 'CLAUDE_OPERATION_ABORTED';
  if (/timeout|timed out/u.test(searchable)) return 'CLAUDE_OPERATION_TIMEOUT';
  if (/enoent|not found.*executable/u.test(searchable)) return 'CLAUDE_EXECUTABLE_NOT_FOUND';
  return 'CLAUDE_PROVIDER_ERROR';
}

export function classifyClaudeProviderError(value: unknown): ClaudeProviderError {
  if (value instanceof ClaudeProviderError) return value;
  const code = classifyErrorCode(value);
  const recoverable = [
    'CLAUDE_RATE_LIMITED',
    'CLAUDE_OVERLOADED',
    'CLAUDE_OPERATION_TIMEOUT',
    'CLAUDE_PROCESS_EXITED',
    'CLAUDE_PROVIDER_ERROR',
  ].includes(code);
  return new ClaudeProviderError(code, recoverable);
}

function claudeAccountAuthenticationEvidence(
  initializationResult: unknown,
): ClaudeAccountAuthenticationEvidence {
  const account = asObject(asObject(initializationResult)?.account);
  const apiProvider = asString(account?.apiProvider) ?? undefined;
  const subscriptionType = asString(account?.subscriptionType);
  const tokenSource = asString(account?.tokenSource);
  const accountApiKeySource = asString(account?.apiKeySource);
  return {
    ...(apiProvider ? { apiProvider } : {}),
    ...(accountApiKeySource ? { apiKeySource: accountApiKeySource } : {}),
    hasSubscription: Boolean(subscriptionType?.trim()),
    indicatesOAuth: [tokenSource, accountApiKeySource].some((value) => (
      typeof value === 'string' && /oauth|claude\.ai|subscription/iu.test(value)
    )),
  };
}

/** Classifies only coarse auth evidence; account identity fields never leave the adapter. */
export function classifyClaudeAuthentication(
  authenticationPath: ClaudeAuthenticationPath,
  apiKeySource: string | undefined,
  initializationResult: unknown,
): ClaudeProviderErrorCode | null {
  return classifyClaudeAuthenticationEvidence(
    authenticationPath,
    apiKeySource,
    claudeAccountAuthenticationEvidence(initializationResult),
  );
}

function classifyClaudeAuthenticationEvidence(
  authenticationPath: ClaudeAuthenticationPath,
  apiKeySource: string | undefined,
  evidence: ClaudeAccountAuthenticationEvidence,
): ClaudeProviderErrorCode | null {
  if (!apiKeySource) return 'CLAUDE_AUTHENTICATION_FAILED';
  if (authenticationPath === 'api-key-environment') {
    return apiKeySource === 'ANTHROPIC_API_KEY' ? null : 'CLAUDE_AUTHENTICATION_FAILED';
  }

  const helperOrManagedKey = apiKeySource === 'apiKeyHelper'
    || apiKeySource === '/login managed key';
  const nonFirstPartyProvider = evidence.apiProvider !== undefined
    && evidence.apiProvider !== 'firstParty';
  if (authenticationPath === 'existing-cli-environment') {
    return helperOrManagedKey || (apiKeySource === 'none' && nonFirstPartyProvider)
      ? null
      : 'CLAUDE_AUTHENTICATION_FAILED';
  }

  const loginSource = apiKeySource === 'none' || apiKeySource === 'oauth';
  const firstPartyLogin = evidence.apiProvider === 'firstParty'
    || evidence.hasSubscription
    || evidence.indicatesOAuth
    || apiKeySource === 'oauth';
  return loginSource && firstPartyLogin
    ? null
    : 'CLAUDE_AUTHENTICATION_FAILED';
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ClaudeProviderError('CLAUDE_OPERATION_TIMEOUT', true)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new ClaudeProviderError('CLAUDE_OPERATION_ABORTED', true);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(new ClaudeProviderError('CLAUDE_OPERATION_ABORTED', true));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function defaultExecutableVersion(
  executablePath: string,
  environment = buildProviderProcessEnvironment([]),
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile(
      executablePath,
      ['--version'],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024,
        timeout: 3_000,
        windowsHide: true,
        env: environment,
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        if (error) {
          resolve('unknown');
          return;
        }
        const match = String(stdout).match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/u);
        resolve(match?.[0] ?? 'unknown');
      },
    );
  });
}

function providerModel(model: ModelInfo, isDefault: boolean): ProviderModel {
  return {
    id: model.value,
    displayName: safeText(model.displayName, 200) || 'Claude',
    description: safeText(model.description, 500) || undefined,
    supportsReasoning: model.supportsEffort !== false,
    ...(model.supportedEffortLevels?.length ? { reasoningEfforts: model.supportedEffortLevels } : {}),
    isDefault,
  };
}

function orchestrationMcpServers(
  context: ProviderSessionContext,
): NonNullable<Options['mcpServers']> | undefined {
  if (!context.orchestration) return undefined;
  const { endpoint: rawEndpoint, bearerToken } = context.orchestration;
  if (
    rawEndpoint.length > 2_048
    || !/^[\x21-\x7e]{1,4096}$/u.test(bearerToken)
  ) {
    throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    || endpoint.username.length > 0
    || endpoint.password.length > 0
  ) {
    throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
  }
  return {
    ezterminal_orchestration: {
      type: 'http',
      url: endpoint.toString(),
      headers: { Authorization: `Bearer ${bearerToken}` },
    },
  };
}

export class ClaudeProviderAdapter implements AgentProviderAdapter {
  readonly providerId = 'claude';

  private readonly enablementStore: ClaudeProviderEnablementStore;
  private readonly queryFactory: ClaudeQueryFactory;
  private readonly historyReader: NonNullable<ClaudeProviderAdapterOptions['historyReader']>;
  private readonly resolveExecutable: () => Promise<string | null>;
  private readonly readExecutableVersion: NonNullable<ClaudeProviderAdapterOptions['readExecutableVersion']>;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly initializationTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly providedQueryFactory: boolean;
  private readonly extensionCommand: typeof runNativeExtensionCommand;
  private readonly deltaCoalescerOptions: DeltaCoalescerOptions | undefined;
  private readonly enableTaskTools: boolean;
  private readonly discoveryControllers = new Set<AbortController>();
  private readonly listeners = new Set<AgentProviderEventListener>();
  private readonly sessions = new Map<string, SessionRecord>();
  private executablePromise: Promise<string | null> | null = null;
  private launchDescriptor: ProviderLaunchDescriptor | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lifecycleGeneration = 0;
  private deactivatePromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: ClaudeProviderAdapterOptions = {}) {
    this.enablementStore = options.enablementStore ?? new MemoryClaudeProviderEnablementStore();
    this.queryFactory = options.queryFactory ?? ((input) => query(input) as ClaudeQuerySession);
    this.providedQueryFactory = options.queryFactory !== undefined;
    this.extensionCommand = options.extensionCommand ?? runNativeExtensionCommand;
    this.historyReader = options.historyReader ?? ((sessionId, historyOptions) =>
      getSessionMessages(sessionId, historyOptions));
    this.resolveExecutable = options.resolveExecutable ?? (async () => {
      if (options.executablePath) {
        return resolveClaudeExecutable({ configuredPath: options.executablePath });
      }
      return resolveClaudeExecutable();
    });
    this.readExecutableVersion = options.readExecutableVersion ?? defaultExecutableVersion;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.deltaCoalescerOptions = options.deltaCoalescer;
    this.enableTaskTools = options.enableTaskTools ?? true;
  }

  setLaunchDescriptor(descriptor: ProviderLaunchDescriptor): void {
    const allowedEnvironmentSets = [
      claudeEnvironmentVariableNames('api-key-environment'),
      claudeEnvironmentVariableNames('existing-cli-environment'),
      claudeEnvironmentVariableNames('existing-claude-ai-login'),
    ];
    if (
      descriptor.providerId !== this.providerId
      || descriptor.protocol !== 'claude-agent-sdk'
      || !path.isAbsolute(descriptor.executablePath)
      || descriptor.argv.length !== CLAUDE_AGENT_SDK_ARGV.length
      || !descriptor.argv.every((value, index) => value === CLAUDE_AGENT_SDK_ARGV[index])
      || !allowedEnvironmentSets.some((expected) => (
        sameEnvironmentVariableSet(descriptor.environmentVariableNames, expected)
      ))
      || !compatibleClaudeExecutableVersion(descriptor.executableVersion)
      || !/^[a-f0-9]{64}$/u.test(descriptor.reviewDigest)
    ) {
      throw new ClaudeProviderError('CLAUDE_EXECUTABLE_INVALID');
    }
    if (
      this.launchDescriptor
      && JSON.stringify(this.launchDescriptor) !== JSON.stringify(descriptor)
      && this.sessions.size > 0
    ) {
      throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
    }
    this.launchDescriptor = {
      ...descriptor,
      argv: [...descriptor.argv],
      environmentVariableNames: [...descriptor.environmentVariableNames],
    };
  }

  /**
   * Atomically validates the complete consent decision before persisting it.
   * No OAuth/login flow exists here; claude.ai mode only records prior approval.
   */
  async setEnablement(value: ClaudeProviderEnablement): Promise<ClaudeProviderEnablement> {
    const normalized = normalizeEnablement(value);
    validateEnablement(normalized);
    await this.enablementStore.save(normalized);
    return normalized;
  }

  async probe(signal?: AbortSignal): Promise<ProviderProbeResult> {
    this.throwIfAborted(signal);
    let policyError: ClaudeProviderError | null = null;
    let policy = DEFAULT_CLAUDE_PROVIDER_ENABLEMENT;
    try {
      policy = await abortable(this.readEnablement(), signal);
      validateEnablement(policy);
      if (!policy.enabled) policyError = new ClaudeProviderError('CLAUDE_PROVIDER_DISABLED');
    } catch (error) {
      if (signal?.aborted) throw error;
      policyError = classifyClaudeProviderError(error);
    }

    const executablePath = await abortable(this.executable().catch(() => null), signal);
    this.throwIfAborted(signal);
    const executableVersion = executablePath
      ? await abortable(this.executableVersion(executablePath, undefined, signal), signal)
      : 'unavailable';
    const versionIncompatible = executablePath !== null
      && !compatibleClaudeExecutableVersion(executableVersion);
    const executableError = !executablePath
      ? new ClaudeProviderError('CLAUDE_EXECUTABLE_NOT_FOUND')
      : versionIncompatible
        ? new ClaudeProviderError('CLAUDE_EXECUTABLE_INVALID')
        : null;
    const unavailable = policyError ?? executableError;
    const unavailableDetail = unavailable !== null && unavailable === executableError
      && versionIncompatible
      ? ` ${incompatibleClaudeVersionReason(executableVersion)}`
      : '';
    return {
      providerId: this.providerId,
      displayName: 'Claude Agent',
      protocol: 'claude-agent-sdk',
      available: unavailable === null,
      executablePath: executablePath ?? 'unavailable',
      executableVersion,
      argv: CLAUDE_AGENT_SDK_ARGV,
      environmentVariableNames: claudeEnvironmentVariableNames(policy.authenticationPath),
      capabilities: [
        'create',
        'resume',
        'interrupt',
        'model-change',
        'permission-change',
        'approvals',
        'native-subagents',
        'history-reconciliation',
      ],
      authenticationState: unavailable ? 'unavailable' : 'first-launch',
      authenticationDetail: unavailable
        ? 'Claude authentication cannot be verified until provider setup and executable review are complete.'
        : CLAUDE_FIRST_LAUNCH_AUTHENTICATION_DETAIL,
      reviewNotices: [
        {
          id: 'anthropic-commercial-terms',
          level: 'required',
          title: 'Anthropic commercial terms',
          message: 'Claude Agent must be enabled only after the applicable Anthropic terms and commercial-use requirements have been reviewed and accepted.',
          url: 'https://www.anthropic.com/legal/commercial-terms',
        },
        {
          id: 'anthropic-third-party-claude-ai',
          level: 'required',
          title: 'Third-party claude.ai access',
          message: 'Without prior Anthropic approval, a third-party product cannot provide claude.ai login or claude.ai subscription rate limits. EZTerminal does not start a login flow or manage those limits.',
          url: 'https://code.claude.com/docs/en/agent-sdk/overview',
        },
      ],
      ...(unavailable
        ? { unavailableReason: `${unavailable.code}: ${unavailable.message}${unavailableDetail}` }
        : {}),
    };
  }

  async listModels(signal?: AbortSignal): Promise<readonly ProviderModel[]> {
    const lifecycleGeneration = await this.enterLifecycle(signal);
    await abortable(this.assertReady(signal), signal);
    const active = await this.enqueueLifecycle(() => {
      this.assertLifecycleGeneration(lifecycleGeneration, signal);
      return [...this.sessions.values()].find((session) => !session.disposed && session.initialized);
    });
    if (!active) return (await this.listCapabilities(process.cwd(), signal)).models;
    try {
      const models = await bounded(
        abortable(active.query.supportedModels(), signal),
        this.operationTimeoutMs,
      );
      return models.map((model, index) => providerModel(model, index === 0));
    } catch (error) {
      throw classifyClaudeProviderError(error);
    }
  }

  async listCapabilities(workspaceRoot: string, signal?: AbortSignal): Promise<ProviderCapabilityCatalog> {
    const generation = await this.enterLifecycle(signal);
    const readiness = await abortable(this.assertReady(signal), signal);
    if (!path.isAbsolute(workspaceRoot)) throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.discoveryControllers.add(controller);
    const input = new AsyncInputQueue<SDKUserMessage>();
    let metadata: ClaudeQuerySession | undefined;
    let stream: Promise<void> | undefined;
    try {
      this.assertLifecycleGeneration(generation, signal);
      metadata = this.queryFactory({ prompt: input, options: {
        cwd: workspaceRoot, pathToClaudeCodeExecutable: readiness.executablePath,
        abortController: controller, persistSession: false, env: readiness.environment,
        settingSources: ['user', 'project', 'local'], permissionMode: 'plan',
        canUseTool: async () => ({ behavior: 'deny', message: 'Capability discovery does not execute tools.' }),
      } });
      const querySession = metadata;
      // The input queue deliberately stays empty. SDK control requests work before
      // a prompt; draining the output is required for their responses, not a turn.
      stream = (async () => { try { for await (const message of querySession) { void message; if (controller.signal.aborted) break; } } catch { /* Control calls report errors below. */ } })();
      const initialization = await bounded(abortable(querySession.initializationResult(), controller.signal), this.initializationTimeoutMs);
      const [models, commands, servers, installed] = await Promise.allSettled([
        bounded(abortable(querySession.supportedModels(), controller.signal), this.operationTimeoutMs),
        querySession.supportedCommands ? bounded(abortable(querySession.supportedCommands(), controller.signal), this.operationTimeoutMs) : Promise.resolve(asObject(initialization)?.commands ?? []),
        querySession.mcpServerStatus ? bounded(abortable(querySession.mcpServerStatus(), controller.signal), this.operationTimeoutMs) : Promise.reject(new Error('Unsupported MCP status')),
        this.extensionCommand(readiness.executablePath, ['plugin', 'list', '--json'], workspaceRoot, readiness.environment, controller.signal),
      ]);
      const items: AgentCapabilityItem[] = [];
      const issues: { section: 'models' | 'skills' | 'plugins' | 'mcp'; message: string }[] = [];
      if (commands.status === 'fulfilled') for (const raw of Array.isArray(commands.value) ? commands.value : []) {
        const command = asObject(raw);
        const name = typeof command?.name === 'string' ? command.name : undefined;
        if (name) items.push({ id: name, kind: 'skill', name, description: typeof command?.description === 'string' ? command.description : undefined,
          invocation: `/${name}`, enabled: true, source: 'Claude native settings', actions: [] });
      }
      if (servers.status === 'fulfilled') for (const server of servers.value) items.push({
        id: server.name, kind: 'mcp', name: server.name, status: server.status, scope: server.scope,
        enabled: server.status !== 'disabled', actions: ['user', 'project', 'local'].includes(server.scope ?? '') ? ['mcp-remove'] : [],
      });
      if (installed.status === 'fulfilled') {
        try {
          const plugins: unknown = JSON.parse(installed.value);
          for (const raw of Array.isArray(plugins) ? plugins : []) {
            const plugin = asObject(raw);
            if (typeof plugin?.id !== 'string') continue;
            if (typeof plugin.projectPath === 'string' && path.resolve(plugin.projectPath).toLowerCase() !== path.resolve(workspaceRoot).toLowerCase()) continue;
            items.push({ id: plugin.id, kind: 'plugin', name: plugin.id,
              version: typeof plugin.version === 'string' ? plugin.version : undefined,
              scope: typeof plugin.scope === 'string' ? plugin.scope : undefined,
              source: typeof plugin.installPath === 'string' ? plugin.installPath : undefined,
              enabled: plugin.enabled === true, actions: ['plugin-enable', 'plugin-disable', 'plugin-update', 'plugin-remove'] });
          }
        } catch { issues.push({ section: 'plugins', message: 'The installed Claude CLI returned an incompatible plugin catalog.' }); }
      }
      for (const [section, result] of [['models', models], ['skills', commands], ['mcp', servers], ['plugins', installed]] as const) {
        if (result.status === 'rejected') issues.push({ section, message: `Claude could not read ${section}. Refresh or update the installed provider.` });
      }
      return { models: models.status === 'fulfilled' ? models.value.map((model, index) => providerModel(model, index === 0)) : [], items, issues,
        actions: ['plugin-install', 'plugin-remove', 'plugin-enable', 'plugin-disable', 'plugin-update', 'marketplace-add', 'marketplace-remove', 'marketplace-update', 'mcp-add', 'mcp-remove'] };
    } catch (error) { throw classifyClaudeProviderError(error); }
    finally {
      input.close(); controller.abort(); metadata?.close();
      signal?.removeEventListener('abort', abort); this.discoveryControllers.delete(controller);
      if (stream) await Promise.race([stream, new Promise<void>((resolve) => { const timer = setTimeout(resolve, this.shutdownTimeoutMs); timer.unref?.(); })]);
    }
  }

  async manageExtension(workspaceRoot: string, command: AgentExtensionCommand, signal?: AbortSignal): Promise<void> {
    const readiness = await abortable(this.assertReady(signal), signal);
    await this.extensionCommand(readiness.executablePath, claudeExtensionArguments(command), workspaceRoot, readiness.environment, signal);
  }

  async createSession(context: ProviderSessionContext, signal?: AbortSignal): Promise<ProviderSessionHandle> {
    return this.startSession(context, undefined, signal);
  }

  async resumeSession(
    context: ProviderSessionContext & { readonly providerSessionId: string },
    signal?: AbortSignal,
  ): Promise<ProviderSessionHandle> {
    return this.startSession(context, context.providerSessionId, signal);
  }

  async submit(input: ProviderSubmitInput, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const session = this.session(input.sessionId, input.providerSessionId);
    if (session.turnsByCommand.has(input.commandId)) return;
    if (input.context?.skills?.length) {
      if (session.context.toolsDisabled || !session.query.supportedCommands) throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
      const commands = await bounded(abortable(session.query.supportedCommands(), signal), this.operationTimeoutMs);
      if (input.context.skills.some((skill) => skill.providerId !== 'claude' || !commands.some((command) => command.name === skill.id && command.name === skill.name))) {
        throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
      }
      if (session.turnsByCommand.has(input.commandId)) return;
    }
    const clientUuid = deterministicCommandUuid(input.commandId);
    const turn: TurnRecord = {
      turnId: input.turnId,
      commandId: input.commandId,
      clientUuid,
      state: 'submitted',
      interruptRequested: false,
    };
    session.turnsByCommand.set(input.commandId, turn);
    session.turnsByUuid.set(clientUuid, turn);
    this.emit({
      kind: 'turn-started',
      sessionId: input.sessionId,
      turnId: input.turnId,
      commandId: input.commandId,
    });
    this.emit({ kind: 'session-state', sessionId: input.sessionId, state: 'working' });
    // No user-message echo: the runtime persisted the prompt when it accepted the command.
    try {
      session.input.push({
        type: 'user',
        message: { role: 'user', content: input.context ? [
          { type: 'text', text: promptWithChatContext(input.prompt, input.context) },
          ...(input.context.attachments ?? []).filter((attachment) => attachment.kind === 'image').map((attachment) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: attachment.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: attachment.data },
          })),
        ] : input.prompt },
        parent_tool_use_id: null,
        uuid: clientUuid as SDKUserMessage['uuid'],
        session_id: input.providerSessionId,
      });
    } catch (error) {
      this.finishTurn(session, turn, 'failed', classifyClaudeProviderError(error));
      throw classifyClaudeProviderError(error);
    }
  }

  async interrupt(sessionId: string, providerSessionId: string): Promise<void> {
    const session = this.session(sessionId, providerSessionId);
    const unsettled = [...session.turnsByCommand.values()].filter((turn) => turn.state === 'submitted');
    for (const turn of unsettled) turn.interruptRequested = true;
    try {
      const receipt = await bounded(session.query.interrupt(), this.operationTimeoutMs);
      const stillQueued = new Set(receipt?.still_queued ?? []);
      if (receipt) {
        for (const turn of unsettled) {
          if (stillQueued.has(turn.clientUuid)) turn.interruptRequested = false;
        }
      } else {
        for (const turn of unsettled.slice(1)) turn.interruptRequested = false;
      }
      const interrupted = receipt
        ? unsettled.filter((turn) => !stillQueued.has(turn.clientUuid))
        : unsettled.slice(0, 1);
      for (const turn of interrupted) this.finishTurn(session, turn, 'interrupted');
      this.emit({ kind: 'session-state', sessionId, state: 'interrupted' });
    } catch (error) {
      throw classifyClaudeProviderError(error);
    }
  }

  async setSettings(input: {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly model?: string;
    readonly permissionPreset?: PermissionPreset;
  }): Promise<ProviderSessionHandle> {
    const session = this.session(input.sessionId, input.providerSessionId);
    try {
      if ('model' in input) {
        await bounded(session.query.setModel(input.model), this.operationTimeoutMs);
      }
      if (input.permissionPreset !== undefined) {
        await bounded(
          session.query.setPermissionMode(permissionMode(input.permissionPreset)),
          this.operationTimeoutMs,
        );
      }
    } catch (error) {
      throw classifyClaudeProviderError(error);
    }
    session.handle = {
      ...session.handle,
      ...('model' in input ? { model: input.model } : {}),
      ...(input.permissionPreset ? { permissionPreset: input.permissionPreset } : {}),
    };
    return session.handle;
  }

  async resolveApproval(input: ProviderApprovalDecision): Promise<void> {
    const session = this.session(input.sessionId, input.providerSessionId);
    const pending = session.pendingApprovals.get(input.providerRequestId);
    if (!pending) throw new ClaudeProviderError('CLAUDE_APPROVAL_NOT_FOUND');
    const response = input.response;
    // AskUserQuestion reads its answers from the approved input.
    const answers = input.decision === 'allow' && response?.kind === 'answers' ? response.answers : undefined;
    const plan = input.decision === 'allow' && response?.kind === 'plan' ? response : undefined;
    const feedback = input.decision === 'deny' && response?.kind === 'feedback' ? response.message : undefined;
    pending.settle(input.decision === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: answers ? { ...pending.input, answers } : pending.input,
          toolUseID: pending.toolUseId,
        }
      : {
          behavior: 'deny',
          message: feedback ?? 'Denied by the user.',
          toolUseID: pending.toolUseId,
        });
    session.pendingApprovals.delete(input.providerRequestId);
    this.appendTranscript(session, 'approval', `Claude tool request ${input.decision === 'allow' ? 'allowed' : 'denied'}.`, {
      turnId: pending.turnId,
      source: `approval:${input.providerRequestId}:${input.decision}`,
    });
    this.emit({
      kind: 'session-state',
      sessionId: input.sessionId,
      state: session.pendingApprovals.size > 0 ? 'blocked' : 'working',
    });
    if (!plan) return;
    // After the settle: the CLI itself leaves plan mode for `default` once ExitPlanMode is approved.
    try {
      await bounded(session.query.setPermissionMode(permissionMode(plan.mode)), this.operationTimeoutMs);
      session.handle = { ...session.handle, permissionPreset: plan.mode };
    } catch {
      // The approval itself was delivered, so this is not a delivery failure.
      this.appendTranscript(session, 'notice', 'Claude could not switch the permission mode after the plan approval.', {
        turnId: pending.turnId,
        source: `approval:${input.providerRequestId}:permission-mode`,
      });
    }
  }

  subscribe(listener: AgentProviderEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reconcile(
    input: ProviderReconciliationInput,
    signal?: AbortSignal,
  ): Promise<ProviderReconciliationResult> {
    this.throwIfAborted(signal);
    const live = this.sessions.get(input.sessionId);
    const matchingLive = live?.handle.providerSessionId === input.providerSessionId ? live : undefined;
    let history: SessionMessage[] | null = null;
    let historyAvailable = false;
    let historyComplete = false;
    try {
      history = await this.historyReader(input.providerSessionId, matchingLive
        ? { dir: matchingLive.context.workspaceRoot, limit: MAX_PROVIDER_HISTORY_MESSAGES }
        : { limit: MAX_PROVIDER_HISTORY_MESSAGES });
      historyAvailable = true;
      historyComplete = history.length < MAX_PROVIDER_HISTORY_MESSAGES;
    } catch {
      history = null;
    }
    this.throwIfAborted(signal);

    const historicalIds = new Set(history?.map((message) => message.uuid) ?? []);
    const commands = input.unsettledCommands.map((command) => {
      const local = matchingLive?.turnsByCommand.get(command.commandId);
      if (local) {
        return {
          commandId: command.commandId,
          state: 'applied' as const,
          ...(local.providerTurnId ? { providerTurnId: local.providerTurnId } : {}),
          turnState: local.state === 'submitted' ? 'working' as const : local.state,
        };
      }
      const appearedInHistory = historicalIds.has(deterministicCommandUuid(command.commandId));
      if (appearedInHistory) {
        if (matchingLive && command.turnId) {
          const recovered: TurnRecord = {
            turnId: command.turnId,
            commandId: command.commandId,
            clientUuid: deterministicCommandUuid(command.commandId),
            state: 'submitted',
            ...(command.providerTurnId ? { providerTurnId: command.providerTurnId } : {}),
            interruptRequested: false,
          };
          matchingLive.turnsByCommand.set(command.commandId, recovered);
          matchingLive.turnsByUuid.set(recovered.clientUuid, recovered);
        }
        return {
          commandId: command.commandId,
          state: 'applied' as const,
          ...(command.providerTurnId ? { providerTurnId: command.providerTurnId } : {}),
          turnState: command.state === 'blocked' ? 'blocked' as const : 'working' as const,
        };
      }
      return {
        commandId: command.commandId,
        state: historyAvailable && historyComplete ? 'not-applied' as const : 'delivery-uncertain' as const,
      };
    });
    const transcriptItems = matchingLive
      ? [...matchingLive.transcript]
      : history
        ? this.normalizeHistory(input.sessionId, history)
        : [];
    return { commands, transcriptItems };
  }

  async disposeSession(sessionId: string, providerSessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.handle.providerSessionId !== providerSessionId) return;
    if (session.disposed) return;
    session.coalescer.dispose();
    for (const turn of session.turnsByCommand.values()) {
      if (turn.state === 'submitted') this.finishTurn(session, turn, 'interrupted');
    }
    session.rejectAuthentication(new ClaudeProviderError('CLAUDE_OPERATION_ABORTED', true));
    session.disposed = true;
    this.rejectApprovals(session, 'Claude Agent stopped before the approval was resolved.');
    session.input.close();
    session.abortController.abort();
    session.query.close();
    const sdkCleanup = session.query.return?.(undefined) ?? Promise.resolve();
    await bounded(Promise.all([session.streamPromise, sdkCleanup]), this.shutdownTimeoutMs)
      .catch(() => undefined);
    this.sessions.delete(sessionId);
  }

  deactivate(): Promise<void> {
    for (const controller of this.discoveryControllers) controller.abort();
    if (this.deactivatePromise) return this.deactivatePromise;
    this.lifecycleGeneration += 1;
    const operation = this.enqueueLifecycle(async () => {
      const active = [...this.sessions.values()];
      await Promise.all(active.map((session) => (
        this.disposeSession(session.context.sessionId, session.handle.providerSessionId)
      )));
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

  private async startSession(
    context: ProviderSessionContext,
    resumeSessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProviderSessionHandle> {
    const lifecycleGeneration = await this.enterLifecycle(signal, context.sessionId);
    const readiness = await abortable(this.assertReady(signal), signal);
    const executablePath = readiness.executablePath;
    const mcpServers = orchestrationMcpServers(context);
    this.throwIfAborted(signal);
    const providerSessionId = resumeSessionId ?? this.createId();
    const abortController = new AbortController();
    const forwardAbort = (): void => abortController.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const input = new AsyncInputQueue<SDKUserMessage>();
    const handle: ProviderSessionHandle = {
      sessionId: context.sessionId,
      providerSessionId,
      ...(context.model ? { model: context.model } : {}),
      permissionPreset: context.permissionPreset,
    };
    let resolveAuthenticationPromise: () => void = () => undefined;
    let rejectAuthenticationPromise: (error: ClaudeProviderError) => void = () => undefined;
    const authenticationReady = new Promise<void>((resolve, reject) => {
      resolveAuthenticationPromise = resolve;
      rejectAuthenticationPromise = reject;
    });
    const session: SessionRecord = {
      context,
      enablement: readiness.enablement,
      handle,
      abortController,
      input,
      query: undefined as unknown as ClaudeQuerySession,
      streamPromise: Promise.resolve(),
      turnsByCommand: new Map(),
      turnsByUuid: new Map(),
      coalescer: new DeltaCoalescer((item) => this.recordTranscript(session, item), this.deltaCoalescerOptions),
      pendingApprovals: new Map(),
      toolCalls: new Map(),
      tasks: new Map(),
      fileChanges: new Map(),
      childTitles: new Map(),
      transcript: [],
      sequence: 0,
      disposed: false,
      initialized: false,
      authenticationReady,
      resolveAuthentication: () => {
        if (session.authenticationSettled) return;
        session.authenticationSettled = true;
        resolveAuthenticationPromise();
      },
      rejectAuthentication: (error) => {
        session.startupError = error;
        if (session.authenticationSettled) return;
        session.authenticationSettled = true;
        rejectAuthenticationPromise(error);
      },
      authenticationSettled: false,
      initializationReceived: false,
    };
    const canUseTool: CanUseTool = (toolName, toolInput, request) => context.toolsDisabled
      ? Promise.resolve({ behavior: 'deny', message: 'Tools are disabled for planning proposals.' })
      : this.requestApproval(session, toolName, toolInput, request);
    const options: Options = {
      abortController,
      cwd: context.workspaceRoot,
      pathToClaudeCodeExecutable: executablePath,
      permissionMode: permissionMode(context.permissionPreset),
      allowDangerouslySkipPermissions: context.permissionPreset === 'full-access',
      canUseTool,
      // Planning proposals are read once complete; only conversations stream.
      includePartialMessages: !context.toolsDisabled,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      persistSession: true,
      env: {
        ...readiness.environment,
        ...(this.enableTaskTools && !context.toolsDisabled ? { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } : {}),
        ...context.environment,
      },
      settingSources: ['user', 'project', 'local'],
      ...(context.managedExecution ? { disallowedTools: ['Agent', 'Task'] } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      // An empty allow-list is only an approval preference. Remove the actual
      // catalog, including configured MCP tools, and ignore ambient settings.
      ...(context.toolsDisabled ? { tools: [], disallowedTools: ['*'], settingSources: [], mcpServers: {}, plugins: [], agents: {} } : {}),
      ...(context.model ? { model: context.model } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : { sessionId: providerSessionId }),
      ...(context.reasoningEffort ? { effort: context.reasoningEffort as Options['effort'] } : {}),
    };
    try {
      const { initialization } = await this.enqueueLifecycle(() => {
        this.assertLifecycleGeneration(lifecycleGeneration, signal);
        if (this.sessions.has(context.sessionId)) {
          throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
        }
        this.emit({ kind: 'session-state', sessionId: context.sessionId, state: 'starting' });
        session.query = this.queryFactory({ prompt: input, options });
        this.sessions.set(context.sessionId, session);
        session.streamPromise = this.consume(session);
        const initialization = session.query.initializationResult().then((result) => {
          session.accountAuthentication = claudeAccountAuthenticationEvidence(result);
          session.initializationReceived = true;
          this.settleAuthentication(session);
        });
        return { initialization };
      });
      await bounded(
        abortable(Promise.all([
          initialization,
          session.authenticationReady,
        ]), signal),
        this.initializationTimeoutMs,
      );
      if (session.startupError) throw session.startupError;
      this.throwIfAborted(signal);
      session.initialized = true;
      this.emit({ kind: 'session-state', sessionId: context.sessionId, state: 'idle' });
      return handle;
    } catch (error) {
      const classified = classifyClaudeProviderError(error);
      this.emitProviderError(context.sessionId, classified);
      this.emit({
        kind: 'session-state',
        sessionId: context.sessionId,
        state: classified.code === 'CLAUDE_OPERATION_ABORTED' ? 'interrupted' : 'failed',
        detail: classified.message,
      });
      await this.disposeSession(context.sessionId, providerSessionId);
      throw classified;
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async consume(session: SessionRecord): Promise<void> {
    try {
      for await (const message of session.query) {
        if (session.disposed) break;
        this.handleMessage(session, message);
      }
      if (!session.disposed) {
        const error = session.startupError ?? new ClaudeProviderError('CLAUDE_PROCESS_EXITED', true);
        session.rejectAuthentication(error);
        this.failUnsettledTurns(session, error);
        this.emitProviderError(session.context.sessionId, error);
        this.emit({ kind: 'session-state', sessionId: session.context.sessionId, state: 'failed', detail: error.message });
      }
    } catch (error) {
      if (session.disposed || session.abortController.signal.aborted) return;
      const classified = classifyClaudeProviderError(error);
      session.rejectAuthentication(classified);
      this.failUnsettledTurns(session, classified);
      this.emitProviderError(session.context.sessionId, classified);
      this.emit({
        kind: 'session-state',
        sessionId: session.context.sessionId,
        state: classified.code === 'CLAUDE_OPERATION_ABORTED' ? 'interrupted' : 'failed',
        detail: classified.message,
      });
    }
  }

  private handleMessage(session: SessionRecord, message: SDKMessage): void {
    // command_lifecycle is not in the SDK's SDKMessage union, so switch on the raw type.
    const raw = message as unknown as JsonObject;
    switch (raw.type) {
      case 'stream_event':
        this.handleStreamEvent(session, raw);
        break;
      case 'command_lifecycle':
        this.handleCommandLifecycle(session, raw);
        break;
      case 'assistant':
        this.handleAssistant(session, raw);
        break;
      case 'user':
        this.handleProviderUserMessage(session, raw);
        break;
      case 'result':
        this.handleResult(session, raw);
        break;
      case 'rate_limit_event': {
        const info = asObject(raw.rate_limit_info);
        if (info?.status === 'rejected') {
          this.emitProviderError(
            session.context.sessionId,
            new ClaudeProviderError('CLAUDE_RATE_LIMITED', true),
          );
        }
        break;
      }
      case 'tool_progress':
        this.handleToolProgress(session, raw);
        break;
      case 'system':
        this.handleSystem(session, raw);
        break;
      default:
        break;
    }
  }

  private handleCommandLifecycle(session: SessionRecord, message: JsonObject): void {
    const uuid = asString(message.command_uuid);
    const turn = uuid ? session.turnsByUuid.get(uuid) : undefined;
    if (!turn) return;
    if (message.state === 'started') session.activeTurn = turn;
    else if ((message.state === 'completed' || message.state === 'cancelled') && session.activeTurn === turn) {
      session.activeTurn = undefined;
    }
  }

  /**
   * Partial messages of the main thread. Text streams as deltas; the block's
   * final `assistant` message then replaces them under the same messageId.
   * Subagent (child) messages are not streamed.
   */
  private handleStreamEvent(session: SessionRecord, message: JsonObject): void {
    if (typeof message.parent_tool_use_id === 'string') return;
    const event = asObject(message.event);
    if (!event) return;
    const turn = this.turnForMessage(session, message);
    const stream = session.stream;
    const index = typeof event.index === 'number' ? event.index : undefined;
    switch (event.type) {
      case 'message_start': {
        const providerMessageId = asString(asObject(event.message)?.id);
        session.stream = providerMessageId ? { messageId: providerMessageId } : undefined;
        return;
      }
      case 'content_block_start':
        if (!stream || index === undefined) return;
        stream.index = index;
        if (asObject(event.content_block)?.type === 'thinking') {
          stream.thinking = { index, startedAt: this.now().getTime(), text: '' };
        }
        return;
      case 'content_block_delta': {
        const delta = asObject(event.delta);
        if (!stream || index === undefined || !delta) return;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          const messageId = claudeMessageId(stream.messageId, index);
          session.coalescer.append(messageId, delta.text, (text) => this.transcriptItem(session, 'assistant-message', text, {
            turnId: turn?.turnId,
            source: `${messageId}:delta:${String(session.sequence + 1)}`,
            messageId,
            isDelta: true,
          }));
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && stream.thinking?.index === index) {
          stream.thinking.text += delta.thinking;
        }
        return;
      }
      case 'content_block_stop':
        session.coalescer.flushAll();
        if (stream?.thinking && stream.thinking.index === index) this.emitThinking(session, stream, turn);
        return;
      case 'message_stop':
        this.closeStream(session, turn);
        return;
      default:
        return;
    }
  }

  private emitThinking(session: SessionRecord, stream: StreamState, turn: TurnRecord | undefined): void {
    const thinking = stream.thinking;
    if (!thinking) return;
    stream.thinking = undefined;
    // The CLI redacts thinking text; the row still records how long Claude thought.
    this.appendTranscript(session, 'reasoning', thinking.text, {
      turnId: turn?.turnId,
      source: `${claudeMessageId(stream.messageId, thinking.index)}:reasoning`,
      payload: { v: 1, type: 'reasoning', durationMs: Math.max(0, Math.round(this.now().getTime() - thinking.startedAt)) },
      allowEmpty: true,
    });
  }

  /** Message end, or a turn that ended mid-stream (interrupt): land buffered text and an open thinking block. */
  private closeStream(session: SessionRecord, turn: TurnRecord | undefined): void {
    session.coalescer.flushAll();
    if (session.stream) this.emitThinking(session, session.stream, turn);
    session.stream = undefined;
  }

  private handleAssistant(session: SessionRecord, message: JsonObject): void {
    const turn = this.turnForMessage(session, message);
    const providerMessage = asObject(message.message);
    const providerMessageId = asString(providerMessage?.id);
    if (turn && providerMessage) {
      turn.providerTurnId = providerMessageId ?? asString(message.uuid) ?? turn.providerTurnId;
    }
    const content = providerMessage?.content;
    if (!Array.isArray(content)) return;
    const child = typeof message.parent_tool_use_id === 'string';
    // With partial messages each block arrives as its own assistant message.
    const stream = !child && providerMessageId && session.stream?.messageId === providerMessageId ? session.stream : undefined;
    content.forEach((rawBlock, contentIndex) => {
      const block = asObject(rawBlock);
      if (!block) return;
      const type = asString(block.type);
      const index = stream?.index !== undefined && content.length === 1 ? stream.index : contentIndex;
      const source = `${asString(message.uuid) ?? this.createId()}:${String(contentIndex)}`;
      if (type === 'text') {
        this.appendTranscript(session, child ? 'child-summary' : 'assistant-message', providerTranscriptText(block.text), {
          turnId: turn?.turnId,
          source,
          ...(!child && providerMessageId ? { messageId: claudeMessageId(providerMessageId, index) } : {}),
        });
        return;
      }
      if (type === 'thinking') {
        const text = providerTranscriptText(block.thinking);
        if (stream?.thinking?.index === index) {
          // Emitted at content_block_stop, which carries the duration.
          stream.thinking.text = text || stream.thinking.text;
          return;
        }
        this.appendTranscript(session, 'reasoning', text, {
          turnId: turn?.turnId,
          source,
          payload: { v: 1, type: 'reasoning' },
        });
        return;
      }
      if (type === 'tool_use' || type === 'server_tool_use') {
        const name = safeToolName(block.name);
        const toolId = asString(block.id);
        if (toolId) {
          session.toolCalls.set(toolId, { name, input: block.input });
          // Bound calls whose result never arrives.
          if (session.toolCalls.size > MAX_TRACKED_TOOL_CALLS) session.toolCalls.delete(session.toolCalls.keys().next().value!);
          const change = claudeFileChange(name, block.input);
          if (change && encodeFileChanges([change])) session.fileChanges.set(toolId, change);
          // Bound unfinished operations from a provider that never returns a result.
          if (session.fileChanges.size > 100) session.fileChanges.delete(session.fileChanges.keys().next().value!);
        }
        this.appendTranscript(session, 'tool-call', toolCallText(name, block.input), {
          turnId: turn?.turnId,
          source,
          ...(toolId ? { payload: toolCallPayload(name, toolId, block.input) } : {}),
        });
        if (name === 'TodoWrite' && toolId) this.applyTodoWrite(session, block.input, turn, toolId);
      }
    });
    const assistantError = asString(message.error);
    if (assistantError) {
      const classified = classifyClaudeProviderError(assistantError);
      this.emitProviderError(session.context.sessionId, classified);
    }
  }

  private handleProviderUserMessage(session: SessionRecord, message: JsonObject): void {
    const content = asObject(message.message)?.content;
    if (!Array.isArray(content)) return;
    const turn = this.turnForMessage(session, message);
    // The structured result describes the message's only tool_result.
    const structured = content.length === 1 ? message.tool_use_result : undefined;
    const meta = asArray(message.tool_result_meta).map(asObject);
    content.forEach((rawBlock, index) => {
      const block = asObject(rawBlock);
      if (!block || block.type !== 'tool_result') return;
      const toolId = asString(block.tool_use_id);
      const call = toolId ? session.toolCalls.get(toolId) : undefined;
      if (toolId) session.toolCalls.delete(toolId);
      const name = call?.name ?? 'tool';
      const failed = block.is_error === true;
      const change = toolId ? session.fileChanges.get(toolId) : undefined;
      if (toolId) session.fileChanges.delete(toolId);
      const text = toolResultText(block.content);
      const denied = meta.some((entry) => entry?.id === toolId && entry?.non_execution_kind === 'permission-rule')
        || text === 'Denied by the user.';
      const status: ToolStatus = !failed
        ? 'completed'
        : denied
          ? 'denied'
          : turn?.interruptRequested || text.startsWith('[Request interrupted by user')
            ? 'interrupted'
            : 'failed';
      const files = status === 'completed' ? toolResultFiles(name, call?.input, change, structured) : undefined;
      this.appendTranscript(session, 'tool-result', (!failed && change ? encodeFileChanges([change]) : undefined) || text || `${name} ${failed ? 'failed' : 'completed'}.`, {
        turnId: turn?.turnId,
        source: `${asString(message.uuid) ?? this.createId()}:${String(index)}`,
        ...(toolId ? {
          payload: {
            v: 1,
            type: 'tool',
            callId: shortText(toolId),
            name: shortText(name),
            category: toolCategory(name),
            phase: 'result',
            status,
            ...(files ? { files } : {}),
          },
        } : {}),
      });
      if (status === 'completed' && call && toolId) this.applyTaskResult(session, call, structured, text, turn, toolId);
    });
  }

  /** TaskCreate gets its id from the result; TaskUpdate applies once it succeeded. */
  private applyTaskResult(
    session: SessionRecord,
    call: ToolCallRecord,
    structured: unknown,
    text: string,
    turn: TurnRecord | undefined,
    toolId: string,
  ): void {
    const input = asObject(call.input);
    if (call.name === 'TaskCreate') {
      const id = asString(asObject(asObject(structured)?.task)?.id) ?? text.match(/Task #(\d+)/u)?.[1];
      const subject = asString(input?.subject);
      if (!id || !subject) return;
      const active = asString(input?.activeForm);
      session.tasks.set(id, { text: shortText(subject), status: 'pending', ...(active ? { active: shortText(active) } : {}) });
    } else if (call.name === 'TaskUpdate') {
      const id = typeof input?.taskId === 'number' ? String(input.taskId) : asString(input?.taskId);
      const task = id ? session.tasks.get(id) : undefined;
      if (!id || !task) return;
      const status = asString(asObject(asObject(structured)?.statusChange)?.to) ?? input?.status;
      if (status === 'deleted') {
        session.tasks.delete(id);
      } else {
        const subject = asString(input?.subject);
        const active = asString(input?.activeForm);
        session.tasks.set(id, {
          ...task,
          ...(subject ? { text: shortText(subject) } : {}),
          status: todoStatus(status) ?? task.status,
          ...(active ? { active: shortText(active) } : {}),
        });
      }
    } else {
      return;
    }
    this.emitTodo(session, turn, toolId);
  }

  /** TodoWrite carries the whole list, so it replaces the tracked one as soon as it is called. */
  private applyTodoWrite(session: SessionRecord, input: unknown, turn: TurnRecord | undefined, toolId: string): void {
    const todos = asArray(asObject(input)?.todos).map(asObject);
    session.tasks.clear();
    todos.forEach((todo, index) => {
      const text = asString(todo?.content);
      const status = todoStatus(todo?.status);
      if (!text || !status) return;
      const active = asString(todo?.activeForm);
      session.tasks.set(`todo:${String(index)}`, { text: shortText(text), status, ...(active ? { active: shortText(active) } : {}) });
    });
    this.emitTodo(session, turn, toolId);
  }

  private emitTodo(session: SessionRecord, turn: TurnRecord | undefined, toolId: string): void {
    const items = [...session.tasks.values()].slice(0, 100);
    this.appendTranscript(session, 'notice', todoChecklist(items), {
      turnId: turn?.turnId,
      source: `todo:${toolId}`,
      payload: { v: 1, type: 'todo', source: 'claude-todowrite', items },
    });
  }

  private handleResult(session: SessionRecord, message: JsonObject): void {
    const turns = this.turnsForResult(session, message);
    this.closeStream(session, turns[0]);
    const terminalReason = asString(message.terminal_reason);
    // A user stop ends in error_during_execution; it is an interruption, not a provider failure.
    const interrupted = terminalReason === 'aborted_streaming'
      || terminalReason === 'aborted_tools'
      || turns.some((turn) => turn.interruptRequested);
    const isError = !interrupted && (message.is_error === true || message.subtype !== 'success');
    const errorValue = asString(message.error)
      ?? (Array.isArray(message.errors) ? message.errors.find((entry): entry is string => typeof entry === 'string') : null)
      ?? (isError ? asString(message.result) : null);
    const classified = isError ? classifyClaudeProviderError(errorValue ?? 'unknown') : null;
    for (const turn of turns) {
      turn.providerTurnId = asString(message.uuid) ?? turn.providerTurnId;
      if (interrupted) this.finishTurn(session, turn, 'interrupted');
      else if (classified) this.finishTurn(session, turn, 'failed', classified);
      else this.finishTurn(session, turn, 'completed');
    }
    if (session.activeTurn && turns.includes(session.activeTurn)) session.activeTurn = undefined;
    if (classified) this.emitProviderError(session.context.sessionId, classified);
    const remaining = [...session.turnsByCommand.values()].some((turn) => turn.state === 'submitted');
    this.emit({
      kind: 'session-state',
      sessionId: session.context.sessionId,
      state: remaining ? 'working' : classified ? 'failed' : interrupted ? 'interrupted' : 'idle',
      ...(classified ? { detail: classified.message } : {}),
    });
  }

  private handleSystem(session: SessionRecord, message: JsonObject): void {
    const subtype = asString(message.subtype);
    if (subtype === 'init') {
      session.apiKeySource = asString(message.apiKeySource) ?? '';
      this.settleAuthentication(session);
      return;
    }
    if (subtype === 'task_started') {
      if (message.ambient === true || message.skip_transcript === true) return;
      const childId = asString(message.task_id);
      if (!childId) return;
      const subagentType = safeToolName(message.subagent_type ?? 'subagent');
      const title = subagentType === 'subagent' ? 'Claude subagent' : `Claude ${subagentType}`;
      session.childTitles.set(childId, title);
      this.emit({
        kind: 'native-subagent',
        sessionId: session.context.sessionId,
        providerChildId: childId,
        title,
        state: 'starting',
      });
      return;
    }
    if (subtype === 'task_progress') {
      const childId = asString(message.task_id);
      if (!childId) return;
      this.emit({
        kind: 'native-subagent',
        sessionId: session.context.sessionId,
        providerChildId: childId,
        title: session.childTitles.get(childId) ?? 'Claude subagent',
        state: 'working',
        ...(asString(message.summary) ? { summary: safeText(message.summary, 500) } : {}),
      });
      return;
    }
    if (subtype === 'task_updated') {
      const childId = asString(message.task_id);
      if (!childId) return;
      const status = asString(asObject(message.patch)?.status);
      const state = status === 'completed'
        ? 'done'
        : status === 'failed' || status === 'killed'
          ? 'error'
          : status === 'paused'
            ? 'blocked'
            : 'working';
      this.emit({
        kind: 'native-subagent',
        sessionId: session.context.sessionId,
        providerChildId: childId,
        title: session.childTitles.get(childId) ?? 'Claude subagent',
        state,
      });
      return;
    }
    if (subtype === 'task_notification') {
      const childId = asString(message.task_id);
      if (!childId) return;
      const status = asString(message.status);
      this.emit({
        kind: 'native-subagent',
        sessionId: session.context.sessionId,
        providerChildId: childId,
        title: session.childTitles.get(childId) ?? 'Claude subagent',
        state: status === 'completed' ? 'done' : 'error',
        summary: status === 'completed' ? 'Subagent completed.' : 'Subagent stopped without completing.',
      });
      return;
    }
    if (subtype === 'session_state_changed') {
      const state = message.state === 'requires_action'
        ? 'blocked'
        : message.state === 'running'
          ? 'working'
          : 'idle';
      this.emit({ kind: 'session-state', sessionId: session.context.sessionId, state });
      return;
    }
    if (subtype === 'api_retry') {
      const classified = classifyClaudeProviderError(message.error);
      this.emitProviderError(session.context.sessionId, classified);
    }
  }

  private handleToolProgress(session: SessionRecord, message: JsonObject): void {
    const taskId = asString(message.task_id);
    if (!taskId || !session.childTitles.has(taskId)) return;
    this.emit({
      kind: 'native-subagent',
      sessionId: session.context.sessionId,
      providerChildId: taskId,
      title: session.childTitles.get(taskId) ?? 'Claude subagent',
      state: 'working',
    });
  }

  private requestApproval(
    session: SessionRecord,
    toolNameValue: string,
    input: Record<string, unknown>,
    request: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (request.signal.aborted) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'The approval request was cancelled.',
        toolUseID: request.toolUseID,
      });
    }
    const existing = session.pendingApprovals.get(request.requestId);
    if (existing) return existing.promise;
    const toolName = safeToolName(toolNameValue);
    const turn = session.activeTurn?.state === 'submitted'
      ? session.activeTurn
      : [...session.turnsByCommand.values()].find((candidate) => candidate.state === 'submitted');
    // Text streamed so far belongs before the approval it led to.
    session.coalescer.flushAll();
    let settlePromise: (result: PermissionResult) => void = () => undefined;
    const promise = new Promise<PermissionResult>((resolve) => {
      let settled = false;
      settlePromise = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
    });
    const pending: PendingApproval = {
      requestId: request.requestId,
      toolUseId: request.toolUseID,
      input,
      turnId: turn?.turnId,
      promise,
      settle: settlePromise,
    };
    session.pendingApprovals.set(request.requestId, pending);
    request.signal.addEventListener('abort', () => {
      if (session.pendingApprovals.delete(request.requestId)) {
        pending.settle({
          behavior: 'deny',
          message: 'The approval request was cancelled.',
          toolUseID: request.toolUseID,
        });
      }
    }, { once: true });
    // The SDK's own title/description strings are not used; the request is built from the tool input.
    const approval = claudeApproval(toolName, input, request.toolUseID);
    this.emit({
      kind: 'approval-requested',
      sessionId: session.context.sessionId,
      ...(turn ? { turnId: turn.turnId } : {}),
      providerRequestId: request.requestId,
      risk: toolRisk(toolName),
      title: approval.title,
      ...(approval.detail ? { detail: approval.detail } : {}),
      ...(approval.request ? { request: approval.request } : {}),
    });
    this.emit({ kind: 'session-state', sessionId: session.context.sessionId, state: 'blocked' });
    return promise;
  }

  /** Emits one complete row; buffered deltas are flushed first so they never land after it. */
  private appendTranscript(
    session: SessionRecord,
    kind: DaemonTranscriptItem['kind'],
    text: string,
    options: TranscriptOptions,
  ): void {
    session.coalescer.flushAll();
    const item = this.transcriptItem(session, kind, text, options);
    if (item) this.recordTranscript(session, item);
  }

  /** Allocates the next sequence only for a row that will be emitted. */
  private transcriptItem(
    session: SessionRecord,
    kind: DaemonTranscriptItem['kind'],
    text: string,
    options: TranscriptOptions,
  ): DaemonTranscriptItem | undefined {
    const original = providerTranscriptText(text);
    // A whitespace-only delta (a paragraph break) is still part of the message.
    if (options.isDelta ? !original : !original.trim() && !options.allowEmpty) return undefined;
    session.sequence += 1;
    return {
      id: `claude_${createHash('sha256').update(`${session.handle.providerSessionId}:${options.source}`).digest('hex').slice(0, 24)}`,
      ...(options.messageId ? { messageId: options.messageId } : {}),
      sessionId: session.context.sessionId,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      sequence: session.sequence,
      kind,
      text: original,
      isDelta: options.isDelta === true,
      isSensitive: kind === 'user-message'
        || kind === 'assistant-message'
        || kind === 'reasoning',
      ...(options.payload ? { payload: options.payload } : {}),
      createdAt: this.now().toISOString(),
    };
  }

  private recordTranscript(session: SessionRecord, item: DaemonTranscriptItem): void {
    session.transcript.push(item);
    if (session.transcript.length > MAX_RECONCILIATION_ITEMS) session.transcript.shift();
    this.emit({ kind: 'transcript', item });
  }

  private normalizeHistory(sessionId: string, history: readonly SessionMessage[]): DaemonTranscriptItem[] {
    const items: DaemonTranscriptItem[] = [];
    let sequence = 0;
    const append = (kind: DaemonTranscriptItem['kind'], text: string, source: string): void => {
      const original = providerTranscriptText(text);
      if (!original.trim() || items.length >= MAX_RECONCILIATION_ITEMS) return;
      sequence += 1;
      items.push({
        id: `claude_${createHash('sha256').update(`${sessionId}:${source}`).digest('hex').slice(0, 24)}`,
        sessionId,
        sequence,
        kind,
        text: original,
        isDelta: false,
        isSensitive: kind === 'user-message'
          || kind === 'assistant-message'
          || kind === 'reasoning',
        createdAt: this.now().toISOString(),
      });
    };
    for (const message of history.slice(-MAX_RECONCILIATION_ITEMS)) {
      const envelope = asObject(message.message);
      const content = envelope?.content;
      if (typeof content === 'string' && message.type === 'user') {
        append('user-message', content, message.uuid);
        continue;
      }
      if (!Array.isArray(content)) continue;
      content.forEach((entry, index) => {
        const block = asObject(entry);
        if (!block) return;
        const source = `${message.uuid}:${String(index)}`;
        if (message.type === 'assistant' && block.type === 'text') {
          append(message.parent_tool_use_id ? 'child-summary' : 'assistant-message', asString(block.text) ?? '', source);
        } else if (message.type === 'assistant' && block.type === 'thinking') {
          append('reasoning', asString(block.thinking) ?? '', source);
        } else if (message.type === 'assistant' && (block.type === 'tool_use' || block.type === 'server_tool_use')) {
          append('tool-call', toolCallText(safeToolName(block.name), block.input), source);
        } else if (message.type === 'user' && block.type === 'tool_result') {
          append('tool-result', toolResultText(block.content) || (block.is_error === true ? 'Claude tool failed.' : 'Claude tool completed.'), source);
        } else if (message.type === 'user' && block.type === 'text') {
          append('user-message', asString(block.text) ?? '', source);
        }
      });
    }
    return items;
  }

  /**
   * Only a turn's first message carries user_message_uuid(s); it (or
   * command_lifecycle `started`) binds the active turn that later messages,
   * including late ones after an interrupt, inherit.
   */
  private turnForMessage(session: SessionRecord, message: JsonObject): TurnRecord | undefined {
    const direct = asString(message.user_message_uuid);
    if (direct) {
      const turn = session.turnsByUuid.get(direct);
      if (turn) {
        session.activeTurn = turn;
        return turn;
      }
    }
    const uuids = message.user_message_uuids;
    if (Array.isArray(uuids)) {
      for (let index = uuids.length - 1; index >= 0; index -= 1) {
        const uuid = uuids[index];
        if (typeof uuid === 'string') {
          const turn = session.turnsByUuid.get(uuid);
          if (turn) {
            session.activeTurn = turn;
            return turn;
          }
        }
      }
    }
    return session.activeTurn
      ?? [...session.turnsByCommand.values()].find((turn) => turn.state === 'submitted');
  }

  private turnsForResult(session: SessionRecord, message: JsonObject): TurnRecord[] {
    const matched: TurnRecord[] = [];
    const uuids = Array.isArray(message.user_message_uuids)
      ? message.user_message_uuids
      : [message.user_message_uuid];
    for (const uuid of uuids) {
      if (typeof uuid !== 'string') continue;
      const turn = session.turnsByUuid.get(uuid);
      if (turn && turn.state === 'submitted' && !matched.includes(turn)) matched.push(turn);
    }
    if (matched.length === 0) {
      const fallback = this.turnForMessage(session, message);
      if (fallback) matched.push(fallback);
    }
    return matched;
  }

  private finishTurn(
    session: SessionRecord,
    turn: TurnRecord,
    outcome: Exclude<TurnState, 'submitted'>,
    error?: ClaudeProviderError,
  ): void {
    if (turn.state !== 'submitted') return;
    turn.state = outcome;
    session.coalescer.flushAll();
    this.emit({
      kind: 'turn-finished',
      sessionId: session.context.sessionId,
      turnId: turn.turnId,
      outcome,
      summary: outcome === 'completed'
        ? 'Claude completed the turn.'
        : outcome === 'interrupted'
          ? 'Claude was interrupted.'
          : error?.message ?? ERROR_MESSAGES.CLAUDE_PROVIDER_ERROR,
      ...(error ? { errorCode: error.code } : {}),
    });
  }

  private failUnsettledTurns(session: SessionRecord, error: ClaudeProviderError): void {
    for (const turn of session.turnsByCommand.values()) {
      if (turn.state === 'submitted') this.finishTurn(session, turn, 'failed', error);
    }
  }

  private rejectApprovals(session: SessionRecord, message: string): void {
    for (const pending of session.pendingApprovals.values()) {
      pending.settle({
        behavior: 'deny',
        message,
        toolUseID: pending.toolUseId,
      });
    }
    session.pendingApprovals.clear();
  }

  private emitProviderError(sessionId: string | undefined, error: ClaudeProviderError): void {
    this.emit({
      kind: 'provider-error',
      ...(sessionId ? { sessionId } : {}),
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    });
  }

  private emit(event: AgentProviderEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener isolation is part of the adapter boundary.
      }
    }
  }

  private async readEnablement(): Promise<ClaudeProviderEnablement> {
    try {
      return normalizeEnablement(await this.enablementStore.load());
    } catch {
      throw new ClaudeProviderError('CLAUDE_PROVIDER_DISABLED');
    }
  }

  private async executable(): Promise<string | null> {
    this.executablePromise ??= this.resolveExecutable().then((candidate) => {
      if (!candidate || !path.isAbsolute(candidate)) return null;
      if (process.platform === 'win32' && /\.(?:cmd|ps1)$/iu.test(candidate)) return null;
      return path.normalize(candidate);
    });
    return this.executablePromise;
  }

  private settleAuthentication(session: SessionRecord): void {
    if (
      !session.initializationReceived
      || !session.accountAuthentication
    ) return;
    const evidence = session.accountAuthentication;
    const source = session.apiKeySource ?? evidence.apiKeySource;
    // Current native CLI emits system/init only after the first user input.
    // Its initialization control response already reports coarse account facts.
    // An approved first-party subscription is positive evidence; missing or
    // ambiguous metadata must fail closed instead of requiring a fake turn.
    const failure = source !== undefined
      ? classifyClaudeAuthenticationEvidence(session.enablement.authenticationPath, source || undefined, evidence)
      : session.enablement.authenticationPath === 'existing-claude-ai-login'
        && evidence.apiProvider === 'firstParty' && (evidence.hasSubscription || evidence.indicatesOAuth)
        ? null
        : 'CLAUDE_AUTHENTICATION_FAILED';
    if (!failure) {
      session.resolveAuthentication();
      return;
    }
    session.rejectAuthentication(new ClaudeProviderError(failure));
    if (session.initialized) {
      this.emitProviderError(session.context.sessionId, new ClaudeProviderError(failure));
      this.emit({ kind: 'session-state', sessionId: session.context.sessionId, state: 'failed', detail: new ClaudeProviderError(failure).message });
      session.abortController.abort();
      session.query.close();
    }
  }

  private enterLifecycle(signal?: AbortSignal, sessionId?: string): Promise<number> {
    return this.enqueueLifecycle(() => {
      this.throwIfAborted(signal);
      if (this.disposed) throw new ClaudeProviderError('CLAUDE_PROVIDER_DISABLED');
      if (sessionId && this.sessions.has(sessionId)) {
        throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
      }
      return this.lifecycleGeneration;
    });
  }

  private assertLifecycleGeneration(generation: number, signal?: AbortSignal): void {
    this.throwIfAborted(signal);
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new ClaudeProviderError('CLAUDE_PROVIDER_DISABLED');
    }
  }

  private enqueueLifecycle<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async executableVersion(
    executablePath: string,
    environment = buildProviderProcessEnvironment([]),
    signal?: AbortSignal,
  ): Promise<string> {
    return this.readExecutableVersion(executablePath, environment, signal)
      .then((value) => value.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/u)?.[0] ?? 'unknown')
      .catch(() => 'unknown');
  }

  private async assertReady(signal?: AbortSignal): Promise<{
    readonly executablePath: string;
    readonly enablement: ClaudeProviderEnablement;
    readonly environment: NodeJS.ProcessEnv;
  }> {
    const policy = await abortable(this.readEnablement(), signal);
    if (!policy.enabled) throw new ClaudeProviderError('CLAUDE_PROVIDER_DISABLED');
    validateEnablement(policy);
    const descriptor = this.launchDescriptor;
    if (!descriptor && this.providedQueryFactory) {
      const executable = await abortable(this.executable(), signal);
      if (executable) {
        const executableVersion = await abortable(
          this.executableVersion(executable, undefined, signal),
          signal,
        );
        if (!compatibleClaudeExecutableVersion(executableVersion)) {
          throw new ClaudeProviderError('CLAUDE_EXECUTABLE_INVALID');
        }
        const environmentVariableNames = claudeEnvironmentVariableNames(policy.authenticationPath);
        return {
          executablePath: executable,
          enablement: policy,
          environment: buildProviderProcessEnvironment(
            environmentVariableNames,
            process.env,
            { CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2' },
          ),
        };
      }
    }
    if (!descriptor) throw new ClaudeProviderError('CLAUDE_EXECUTABLE_INVALID');
    if (!sameEnvironmentVariableSet(
      descriptor.environmentVariableNames,
      claudeEnvironmentVariableNames(policy.authenticationPath),
    )) {
      throw new ClaudeProviderError('CLAUDE_EXECUTABLE_INVALID');
    }
    let canonical: string;
    try {
      canonical = await abortable(fs.realpath(descriptor.executablePath), signal);
    } catch {
      throw new ClaudeProviderError('CLAUDE_EXECUTABLE_NOT_FOUND');
    }
    const samePath = process.platform === 'win32'
      ? canonical.toLocaleLowerCase('en-US') === descriptor.executablePath.toLocaleLowerCase('en-US')
      : canonical === descriptor.executablePath;
    const environment = buildProviderProcessEnvironment(
      descriptor.environmentVariableNames,
      process.env,
      { CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2' },
    );
    const version = await abortable(
      this.executableVersion(canonical, buildProviderProcessEnvironment([]), signal),
      signal,
    );
    // The review binds the executable path, not one build: Claude Code auto-updates in
    // place, so any supported version at the reviewed path may launch (as with Codex).
    if (!samePath || !compatibleClaudeExecutableVersion(version)) {
      throw new ClaudeProviderError('CLAUDE_EXECUTABLE_INVALID');
    }
    return {
      executablePath: canonical,
      enablement: policy,
      environment,
    };
  }

  private session(sessionId: string, providerSessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed || session.handle.providerSessionId !== providerSessionId) {
      throw new ClaudeProviderError('CLAUDE_SESSION_NOT_FOUND');
    }
    if (session.startupError) throw session.startupError;
    return session;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ClaudeProviderError('CLAUDE_OPERATION_ABORTED', true);
  }
}
