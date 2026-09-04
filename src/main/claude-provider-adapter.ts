import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

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
import {
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

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 15_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_500;
const MAX_SAFE_TEXT_LENGTH = 20_000;
const MAX_RECONCILIATION_ITEMS = 2_000;
const MAX_PROVIDER_HISTORY_MESSAGES = 5_000;
export const CLAUDE_AGENT_SDK_BUNDLED_CLI_VERSION = '2.1.260';
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
    'The Claude executable path or version no longer matches the pinned Agent SDK review.',
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

const moduleRequire = createRequire(import.meta.url);

/** Resolves the platform binary shipped with the pinned Agent SDK package. */
export async function resolveBundledClaudeExecutable(): Promise<string | null> {
  const packageSuffix = `${process.platform}-${process.arch}`;
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const packageJson = moduleRequire.resolve(
      `@anthropic-ai/claude-agent-sdk-${packageSuffix}/package.json`,
    );
    return fs.realpath(path.join(path.dirname(packageJson), binaryName));
  } catch {
    return null;
  }
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
  ) => Promise<string>;
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly initializationTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
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
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly toolNames: Map<string, string>;
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
  return version === CLAUDE_AGENT_SDK_BUNDLED_CLI_VERSION;
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
  if (['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].includes(toolName)) return 'read';
  if (['Edit', 'Write', 'NotebookEdit'].includes(toolName)) return 'write';
  return 'danger';
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
  private readonly listeners = new Set<AgentProviderEventListener>();
  private readonly sessions = new Map<string, SessionRecord>();
  private executablePromise: Promise<string | null> | null = null;
  private launchDescriptor: ProviderLaunchDescriptor | undefined;
  private disposed = false;

  constructor(options: ClaudeProviderAdapterOptions = {}) {
    this.enablementStore = options.enablementStore ?? new MemoryClaudeProviderEnablementStore();
    this.queryFactory = options.queryFactory ?? ((input) => query(input) as ClaudeQuerySession);
    this.providedQueryFactory = options.queryFactory !== undefined;
    this.historyReader = options.historyReader ?? ((sessionId, historyOptions) =>
      getSessionMessages(sessionId, historyOptions));
    this.resolveExecutable = options.resolveExecutable ?? (async () => {
      if (options.executablePath) {
        return resolveClaudeExecutable({ configuredPath: options.executablePath });
      }
      return await resolveBundledClaudeExecutable() ?? resolveClaudeExecutable();
    });
    this.readExecutableVersion = options.readExecutableVersion ?? defaultExecutableVersion;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
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
      policy = await this.readEnablement();
      validateEnablement(policy);
      if (!policy.enabled) policyError = new ClaudeProviderError('CLAUDE_PROVIDER_DISABLED');
    } catch (error) {
      policyError = classifyClaudeProviderError(error);
    }

    const executablePath = await this.executable().catch(() => null);
    this.throwIfAborted(signal);
    const executableVersion = executablePath
      ? await this.executableVersion(executablePath)
      : 'unavailable';
    const executableError = !executablePath
      ? new ClaudeProviderError('CLAUDE_EXECUTABLE_NOT_FOUND')
      : !compatibleClaudeExecutableVersion(executableVersion)
        ? new ClaudeProviderError('CLAUDE_EXECUTABLE_INVALID')
        : null;
    const unavailable = policyError ?? executableError;
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
        : 'Claude authentication is verified from SDK initialization metadata when the first Agent session starts.',
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
      ...(unavailable ? { unavailableReason: `${unavailable.code}: ${unavailable.message}` } : {}),
    };
  }

  async listModels(signal?: AbortSignal): Promise<readonly ProviderModel[]> {
    this.throwIfAborted(signal);
    await this.assertReady();
    const active = [...this.sessions.values()].find((session) => !session.disposed && session.initialized);
    if (!active) {
      return [{
        id: 'default',
        displayName: 'Claude',
        description: 'Use the default model selected by the installed Claude CLI.',
        supportsReasoning: true,
        isDefault: true,
      }];
    }
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
    this.appendTranscript(session, 'user-message', input.prompt, {
      turnId: input.turnId,
      source: `command:${input.commandId}`,
    });
    try {
      session.input.push({
        type: 'user',
        message: { role: 'user', content: input.prompt },
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
    pending.settle(input.decision === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: pending.input,
          toolUseID: pending.toolUseId,
        }
      : {
          behavior: 'deny',
          message: 'Denied by the user.',
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const active = [...this.sessions.values()];
    await Promise.all(active.map((session) =>
      this.disposeSession(session.context.sessionId, session.handle.providerSessionId)));
    this.listeners.clear();
  }

  private async startSession(
    context: ProviderSessionContext,
    resumeSessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProviderSessionHandle> {
    this.throwIfAborted(signal);
    if (this.disposed) throw new ClaudeProviderError('CLAUDE_PROVIDER_DISABLED');
    if (this.sessions.has(context.sessionId)) {
      throw new ClaudeProviderError('CLAUDE_INVALID_REQUEST');
    }
    const readiness = await this.assertReady();
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
      pendingApprovals: new Map(),
      toolNames: new Map(),
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
    const canUseTool: CanUseTool = (toolName, toolInput, request) =>
      this.requestApproval(session, toolName, toolInput, request);
    const options: Options = {
      abortController,
      cwd: context.workspaceRoot,
      pathToClaudeCodeExecutable: executablePath,
      permissionMode: permissionMode(context.permissionPreset),
      allowDangerouslySkipPermissions: context.permissionPreset === 'full-access',
      canUseTool,
      includePartialMessages: false,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      persistSession: true,
      env: readiness.environment,
      ...(mcpServers ? { mcpServers } : {}),
      ...(context.model ? { model: context.model } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : { sessionId: providerSessionId }),
    };
    this.emit({ kind: 'session-state', sessionId: context.sessionId, state: 'starting' });
    try {
      session.query = this.queryFactory({ prompt: input, options });
      this.sessions.set(context.sessionId, session);
      session.streamPromise = this.consume(session);
      const initialization = session.query.initializationResult().then((result) => {
        session.accountAuthentication = claudeAccountAuthenticationEvidence(result);
        session.initializationReceived = true;
        this.settleAuthentication(session);
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
    switch (message.type) {
      case 'assistant':
        this.handleAssistant(session, message as unknown as JsonObject);
        break;
      case 'user':
        this.handleProviderUserMessage(session, message as unknown as JsonObject);
        break;
      case 'result':
        this.handleResult(session, message as unknown as JsonObject);
        break;
      case 'rate_limit_event': {
        const info = asObject((message as unknown as JsonObject).rate_limit_info);
        if (info?.status === 'rejected') {
          this.emitProviderError(
            session.context.sessionId,
            new ClaudeProviderError('CLAUDE_RATE_LIMITED', true),
          );
        }
        break;
      }
      case 'tool_progress':
        this.handleToolProgress(session, message as unknown as JsonObject);
        break;
      case 'system':
        this.handleSystem(session, message as unknown as JsonObject);
        break;
      default:
        break;
    }
  }

  private handleAssistant(session: SessionRecord, message: JsonObject): void {
    const turn = this.turnForMessage(session, message);
    const providerMessage = asObject(message.message);
    if (turn && providerMessage) {
      turn.providerTurnId = asString(providerMessage.id) ?? asString(message.uuid) ?? turn.providerTurnId;
    }
    const content = providerMessage?.content;
    if (!Array.isArray(content)) return;
    const child = typeof message.parent_tool_use_id === 'string';
    content.forEach((rawBlock, index) => {
      const block = asObject(rawBlock);
      if (!block) return;
      const type = asString(block.type);
      const source = `${asString(message.uuid) ?? this.createId()}:${String(index)}`;
      if (type === 'text') {
        const text = safeText(block.text);
        if (text.trim()) {
          this.appendTranscript(session, child ? 'child-summary' : 'assistant-message', text, {
            turnId: turn?.turnId,
            source,
          });
        }
        return;
      }
      if (type === 'thinking') {
        const text = safeText(block.thinking, 4_000);
        if (text.trim()) this.appendTranscript(session, 'reasoning', text, { turnId: turn?.turnId, source });
        return;
      }
      if (type === 'tool_use' || type === 'server_tool_use') {
        const name = safeToolName(block.name);
        const toolId = asString(block.id);
        if (toolId) session.toolNames.set(toolId, name);
        this.appendTranscript(session, 'tool-call', `Claude requested ${name}.`, {
          turnId: turn?.turnId,
          source,
        });
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
    content.forEach((rawBlock, index) => {
      const block = asObject(rawBlock);
      if (!block || block.type !== 'tool_result') return;
      const toolId = asString(block.tool_use_id);
      const name = toolId ? session.toolNames.get(toolId) ?? 'tool' : 'tool';
      const failed = block.is_error === true;
      this.appendTranscript(session, 'tool-result', `${name} ${failed ? 'failed' : 'completed'}.`, {
        turnId: turn?.turnId,
        source: `${asString(message.uuid) ?? this.createId()}:${String(index)}`,
      });
    });
  }

  private handleResult(session: SessionRecord, message: JsonObject): void {
    const turns = this.turnsForResult(session, message);
    const terminalReason = asString(message.terminal_reason);
    const interrupted = terminalReason === 'aborted_streaming' || terminalReason === 'aborted_tools';
    const isError = message.is_error === true || message.subtype !== 'success';
    const errorValue = asString(message.error)
      ?? (Array.isArray(message.errors) ? message.errors.find((entry): entry is string => typeof entry === 'string') : null)
      ?? (isError ? asString(message.result) : null);
    const classified = isError ? classifyClaudeProviderError(errorValue ?? 'unknown') : null;
    for (const turn of turns) {
      turn.providerTurnId = asString(message.uuid) ?? turn.providerTurnId;
      if (interrupted || turn.interruptRequested) this.finishTurn(session, turn, 'interrupted');
      else if (classified) this.finishTurn(session, turn, 'failed', classified);
      else this.finishTurn(session, turn, 'completed');
    }
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
    const turn = [...session.turnsByCommand.values()].find((candidate) => candidate.state === 'submitted');
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
    this.emit({
      kind: 'approval-requested',
      sessionId: session.context.sessionId,
      ...(turn ? { turnId: turn.turnId } : {}),
      providerRequestId: request.requestId,
      risk: toolRisk(toolName),
      title: `Claude requests ${toolName}`,
      // Raw tool input/title/description is intentionally not placed in the
      // durable event stream because it may contain environment credentials.
    });
    this.emit({ kind: 'session-state', sessionId: session.context.sessionId, state: 'blocked' });
    return promise;
  }

  private appendTranscript(
    session: SessionRecord,
    kind: DaemonTranscriptItem['kind'],
    text: string,
    options: { readonly turnId?: string; readonly source: string },
  ): void {
    const sanitized = sanitizeProviderDiagnostic(text, { maxLength: MAX_SAFE_TEXT_LENGTH });
    if (!sanitized.text.trim()) return;
    session.sequence += 1;
    const item: DaemonTranscriptItem = {
      id: `claude_${createHash('sha256').update(`${session.handle.providerSessionId}:${options.source}`).digest('hex').slice(0, 24)}`,
      sessionId: session.context.sessionId,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      sequence: session.sequence,
      kind,
      text: sanitized.text,
      isDelta: false,
      isSensitive: sanitized.redacted
        || kind === 'user-message'
        || kind === 'assistant-message'
        || kind === 'reasoning',
      createdAt: this.now().toISOString(),
    };
    session.transcript.push(item);
    if (session.transcript.length > MAX_RECONCILIATION_ITEMS) session.transcript.shift();
    this.emit({ kind: 'transcript', item });
  }

  private normalizeHistory(sessionId: string, history: readonly SessionMessage[]): DaemonTranscriptItem[] {
    const items: DaemonTranscriptItem[] = [];
    let sequence = 0;
    const append = (kind: DaemonTranscriptItem['kind'], text: string, source: string): void => {
      const sanitized = sanitizeProviderDiagnostic(text, { maxLength: MAX_SAFE_TEXT_LENGTH });
      if (!sanitized.text.trim() || items.length >= MAX_RECONCILIATION_ITEMS) return;
      sequence += 1;
      items.push({
        id: `claude_${createHash('sha256').update(`${sessionId}:${source}`).digest('hex').slice(0, 24)}`,
        sessionId,
        sequence,
        kind,
        text: sanitized.text,
        isDelta: false,
        isSensitive: sanitized.redacted
          || kind === 'user-message'
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
          append('tool-call', `Claude requested ${safeToolName(block.name)}.`, source);
        } else if (message.type === 'user' && block.type === 'tool_result') {
          append('tool-result', block.is_error === true ? 'Claude tool failed.' : 'Claude tool completed.', source);
        } else if (message.type === 'user' && block.type === 'text') {
          append('user-message', asString(block.text) ?? '', source);
        }
      });
    }
    return items;
  }

  private turnForMessage(session: SessionRecord, message: JsonObject): TurnRecord | undefined {
    const direct = asString(message.user_message_uuid);
    if (direct) {
      const turn = session.turnsByUuid.get(direct);
      if (turn) return turn;
    }
    const uuids = message.user_message_uuids;
    if (Array.isArray(uuids)) {
      for (let index = uuids.length - 1; index >= 0; index -= 1) {
        const uuid = uuids[index];
        if (typeof uuid === 'string') {
          const turn = session.turnsByUuid.get(uuid);
          if (turn) return turn;
        }
      }
    }
    return [...session.turnsByCommand.values()].find((turn) => turn.state === 'submitted');
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
      session.authenticationSettled
      || session.apiKeySource === undefined
      || !session.initializationReceived
      || !session.accountAuthentication
    ) return;
    const failure = classifyClaudeAuthenticationEvidence(
      session.enablement.authenticationPath,
      session.apiKeySource || undefined,
      session.accountAuthentication,
    );
    if (!failure) {
      session.resolveAuthentication();
      return;
    }
    session.rejectAuthentication(new ClaudeProviderError(failure));
    if (session.initialized) {
      session.abortController.abort();
      session.query.close();
    }
  }

  private async executableVersion(
    executablePath: string,
    environment = buildProviderProcessEnvironment([]),
  ): Promise<string> {
    return this.readExecutableVersion(executablePath, environment)
      .then((value) => value.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/u)?.[0] ?? 'unknown')
      .catch(() => 'unknown');
  }

  private async assertReady(): Promise<{
    readonly executablePath: string;
    readonly enablement: ClaudeProviderEnablement;
    readonly environment: NodeJS.ProcessEnv;
  }> {
    const policy = await this.readEnablement();
    if (!policy.enabled) throw new ClaudeProviderError('CLAUDE_PROVIDER_DISABLED');
    validateEnablement(policy);
    const descriptor = this.launchDescriptor;
    if (!descriptor && this.providedQueryFactory) {
      const executable = await this.executable();
      if (executable) {
        const executableVersion = await this.executableVersion(executable);
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
      canonical = await fs.realpath(descriptor.executablePath);
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
    const version = await this.executableVersion(canonical, buildProviderProcessEnvironment([]));
    if (
      !samePath
      || version !== descriptor.executableVersion
      || !compatibleClaudeExecutableVersion(version)
    ) {
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
