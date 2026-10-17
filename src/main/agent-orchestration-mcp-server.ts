import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandPayloads,
  type DaemonCommandReceipt,
  type DaemonCommandType,
  type DaemonEvent,
  type DaemonSnapshot,
  type PermissionPreset,
} from '../shared/daemon-protocol';
import { isRunOwnedWorkspace } from '../shared/workspace-worktree';
import { childProgress, finalAssistantText, latestFinishedTurn, reportBackRequested, type TranscriptReader } from './managed-child-transcript';
import type { ProviderSessionContext } from './agent-provider-adapter';
import type { ChatAgentProfile } from '../shared/chat-agent-profiles';
import { validateWorkflowGraph, WorkflowGraphSchema, WorkflowCommandSchema, type WorkflowCommand } from '../shared/workflow';
import type { ExecutionRun } from '../shared/planning-execution';
import { WORKFLOW_SKILL } from '../shared/workflow-skill';
import type { WorkflowService } from './workflow-service';
import type { WorkflowAuthority } from './workflow-authority';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PROMPT_LENGTH = 200_000;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const PERMISSION_PRESETS = ['plan', 'standard', 'full-access'] as const satisfies readonly PermissionPreset[];
const PERMISSION_RANK: Readonly<Record<PermissionPreset, number>> = {
  plan: 0,
  standard: 1,
  'full-access': 2,
};

type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

interface OrchestrationAuthority {
  getSnapshot(): DaemonSnapshot;
  execute(command: DaemonCommand): Promise<DaemonCommandReceipt>;
  /** Transcript pages, so an Agent can read what its descendant answered. */
  readTranscript?: TranscriptReader;
  /** Daemon change notifications, so an Agent can wait on a descendant without polling. */
  onEvent?: (listener: (event: DaemonEvent) => void) => () => void;
}

/** How long one wait_agent call may hold (clients are given a longer MCP tool timeout). */
const MAX_WAIT_SECONDS = 240;
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAITS_PER_AGENT = 8;
/** How much of a descendant's answer an Agent reads back (the full answer stays in its conversation). */
const MAX_ANSWER_LENGTH = 8_000;

interface Waiter {
  readonly ownerSessionId: string;
  readonly projectId: string;
  readonly settle: () => void;
}

export interface AgentOrchestrationMcpServerOptions {
  readonly authority: OrchestrationAuthority;
  readonly host?: string;
  readonly createId?: () => string;
  readonly createToken?: () => string;
  readonly now?: () => Date;
  readonly reportError?: (context: string, error: unknown) => void;
  readonly workflow?: () => { authority: WorkflowAuthority; service: WorkflowService } | undefined;
  readonly workflowAllowed?: (sessionId: string) => boolean;
  /** The person's saved agent profiles; `create_agent` can start a child from one. */
  readonly listProfiles?: () => readonly ChatAgentProfile[];
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface SessionCapability {
  readonly digest: Buffer;
  readonly projectId: string;
}

class McpRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'McpRequestError';
  }
}

/** A run as an agent follows it: per stage, bounded, without frozen documents or the graph. */
function workflowRunResults(run: ExecutionRun): JsonObject {
  const nodes = run.preparation.workflow?.graph.nodes ?? [];
  return {
    runId: run.runId, state: run.state, approvalPolicy: run.preparation.approvalPolicy ?? 'user',
    ...(run.integrationAuthorized ? { integrationAllowedBy: run.integrationAuthorized.by } : {}),
    awaitingApproval: (run.workflowRuntime?.activations ?? []).filter((activation) => activation.state === 'awaiting-approval')
      .map((activation) => nodes.find((node) => node.id === activation.nodeId)?.title ?? activation.nodeId),
    stages: run.tasks.map((task) => ({
      stage: nodes.find((node) => node.id === task.taskId)?.title ?? run.preparation.tasks.find((entry) => entry.taskId === task.taskId)?.title ?? task.taskId,
      state: task.state,
      attempts: run.attempts.filter((attempt) => attempt.taskId === task.taskId).map((attempt) => ({
        number: attempt.number, state: attempt.state, ...(attempt.summary ? { summary: attempt.summary.slice(0, 4_000) } : {}),
      })),
    })),
  } as unknown as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictObject(value: unknown, allowedKeys: readonly string[]): JsonObject {
  if (!isObject(value)) throw new McpRequestError(-32602, 'Tool arguments must be an object.');
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new McpRequestError(-32602, 'Tool arguments contain unsupported fields.');
  }
  return value;
}

function requiredString(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new McpRequestError(-32602, `${name} must be a non-empty string of at most ${String(maximum)} characters.`);
  }
  return value;
}

function optionalString(value: unknown, name: string, maximum = 256): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, maximum);
}

function permissionPreset(value: unknown): PermissionPreset | undefined {
  if (value === undefined) return undefined;
  if (value !== 'plan' && value !== 'standard' && value !== 'full-access') {
    throw new McpRequestError(-32602, 'permissionPreset must be plan, standard, or full-access.');
  }
  return value;
}

function defaultChildPermissionPreset(ownerPreset: PermissionPreset): PermissionPreset {
  return ownerPreset === 'plan' ? 'plan' : 'standard';
}

function permissionDoesNotExceed(candidate: PermissionPreset, ceiling: PermissionPreset): boolean {
  return PERMISSION_RANK[candidate] <= PERMISSION_RANK[ceiling];
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function rpcResult(id: string | number, result: unknown): JsonObject {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonObject {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(value: unknown, isError = false): JsonObject {
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function acceptedOrigin(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const origin = new URL(value);
    return (origin.protocol === 'http:' || origin.protocol === 'https:')
      && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost' || origin.hostname === '[::1]')
      && origin.username === ''
      && origin.password === '';
  } catch {
    return false;
  }
}

/**
 * Loopback-only, stateless MCP authority for one managed Agent capability.
 * Bearer tokens are random and memory-only; every tool call is re-authorized
 * against the current daemon snapshot before it becomes a daemon command.
 */
export class AgentOrchestrationMcpServer {
  private readonly host: string;
  private readonly createId: () => string;
  private readonly createToken: () => string;
  private readonly now: () => Date;
  private readonly capabilities = new Map<string, SessionCapability>();
  private readonly waiters = new Set<Waiter>();
  private server: Server | null = null;
  private port: number | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: AgentOrchestrationMcpServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.createId = options.createId ?? randomUUID;
    this.createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'));
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.stopping) await this.stopping;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.report('MCP request failed', error);
        if (!response.headersSent) json(response, 500, rpcError(null, -32603, 'Internal server error.'));
        else response.destroy();
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, this.host);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Agent orchestration MCP server did not bind a TCP port.');
    }
    this.server = server;
    this.port = address.port;
    server.unref();
  }

  descriptorForSession(sessionId: string): NonNullable<ProviderSessionContext['orchestration']> {
    if (!this.server || this.port === null) throw new Error('Agent orchestration MCP server is not running.');
    if (!sessionId.trim() || sessionId.length > 256) throw new Error('Agent orchestration session id is invalid.');
    const snapshot = this.requireLiveCapability(sessionId);
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!;
    const bearerToken = this.createToken();
    if (!bearerToken || bearerToken.length < 32 || bearerToken.length > 512) {
      throw new Error('Agent orchestration token generator returned an unsafe token.');
    }
    this.capabilities.set(sessionId, {
      digest: digestToken(bearerToken),
      projectId: session.projectId,
    });
    return {
      endpoint: `http://${this.host}:${String(this.port)}/mcp/${encodeURIComponent(sessionId)}`,
      bearerToken,
    };
  }

  revokeSession(sessionId: string): void {
    this.capabilities.delete(sessionId);
    for (const waiter of [...this.waiters]) if (waiter.ownerSessionId === sessionId) waiter.settle();
  }

  revokeProject(projectId: string): void {
    for (const [sessionId, capability] of this.capabilities) {
      if (capability.projectId === projectId) this.capabilities.delete(sessionId);
    }
    for (const waiter of [...this.waiters]) if (waiter.projectId === projectId) waiter.settle();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const server = this.server;
    this.server = null;
    this.port = null;
    this.capabilities.clear();
    for (const waiter of [...this.waiters]) waiter.settle();
    if (!server) return Promise.resolve();
    this.stopping = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      json(response, 405, rpcError(null, -32600, 'Only POST is supported.'));
      return;
    }
    if (!acceptedOrigin(request.headers.origin)) {
      json(response, 403, rpcError(null, -32001, 'Origin is not allowed.'));
      return;
    }
    const target = new URL(request.url ?? '/', `http://${this.host}`);
    const match = /^\/mcp\/([^/]+)$/u.exec(target.pathname);
    if (!match || target.search || target.hash) {
      json(response, 404, rpcError(null, -32600, 'Unknown MCP endpoint.'));
      return;
    }
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(match[1]!);
    } catch {
      json(response, 404, rpcError(null, -32600, 'Unknown MCP endpoint.'));
      return;
    }
    if (!this.authorized(sessionId, request.headers.authorization)) {
      response.setHeader('www-authenticate', 'Bearer');
      json(response, 401, rpcError(null, -32001, 'Invalid session capability.'));
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(await this.readBody(request));
    } catch (error) {
      const status = error instanceof McpRequestError && error.code === -32000 ? 413 : 400;
      json(response, status, rpcError(null, error instanceof McpRequestError ? error.code : -32700, 'Invalid JSON request.'));
      return;
    }
    if (!isObject(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
      json(response, 400, rpcError(null, -32600, 'Invalid JSON-RPC request.'));
      return;
    }
    const requestValue = value as unknown as JsonRpcRequest;
    if (requestValue.id !== undefined
      && typeof requestValue.id !== 'string'
      && (typeof requestValue.id !== 'number' || !Number.isSafeInteger(requestValue.id))) {
      json(response, 400, rpcError(null, -32600, 'Invalid JSON-RPC id.'));
      return;
    }
    if (requestValue.id === undefined) {
      response.writeHead(202, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    // A wait ends when its caller goes away.
    const aborted = new AbortController();
    response.once('close', () => aborted.abort());
    try {
      const result = await this.dispatch(sessionId, requestValue, aborted.signal);
      json(response, 200, rpcResult(requestValue.id, result));
    } catch (error) {
      const normalized = error instanceof McpRequestError
        ? error
        : new McpRequestError(-32603, 'Internal server error.');
      if (!(error instanceof McpRequestError)) this.report('MCP dispatch failed', error);
      json(response, 200, rpcError(requestValue.id, normalized.code, normalized.message));
    }
  }

  private async dispatch(sessionId: string, request: JsonRpcRequest, signal?: AbortSignal): Promise<unknown> {
    const snapshot = this.requireLiveCapability(sessionId);
    if (request.method === 'initialize') {
      const params = isObject(request.params) ? request.params : {};
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ezterminal-orchestration', version: '1.0.0' },
        instructions: `Create and communicate with managed child Agents in the same EZTerminal Project. To get a child's result, either call wait_agent (and read_agent) after creating it, or create it with reportBack:true and end your turn: the result then arrives as your next message, so do not also wait on it.\n${this.options.workflow?.() ? WORKFLOW_SKILL.instructions : ''}`,
      };
    }
    if (request.method === 'ping') return {};
    if (request.method === 'tools/list') {
      const ownerAgent = snapshot.agents.find((agent) => agent.sessionId === sessionId)!;
      const orchestration = snapshot.runtime.orchestrationToolsEnabled && ownerAgent.orchestrationEnabled;
      return { tools: [...(orchestration ? this.toolDefinitions(ownerAgent.permissionPreset) : []), ...(this.workflowEnabled(sessionId) ? this.workflowToolDefinitions() : [])] };
    }
    if (request.method !== 'tools/call') throw new McpRequestError(-32601, 'Method not found.');
    const params = strictObject(request.params, ['name', 'arguments', '_meta']);
    if (params._meta !== undefined) {
      if (!isObject(params._meta)) throw new McpRequestError(-32602, 'Request metadata must be an object.');
      const progressToken = params._meta.progressToken;
      if (progressToken !== undefined && typeof progressToken !== 'string'
        && (typeof progressToken !== 'number' || !Number.isInteger(progressToken))) {
        throw new McpRequestError(-32602, 'Request metadata progressToken must be a string or integer.');
      }
    }
    // MCP metadata (including client thread IDs) never supplies tool arguments or authority.
    const name = requiredString(params.name, 'name', 128);
    const args = params.arguments ?? {};
    try {
      return await this.callTool(sessionId, name, args, signal);
    } catch (error) {
      if (error instanceof McpRequestError) return toolText({ ok: false, error: error.message }, true);
      throw error;
    }
  }

  private async callTool(sessionId: string, name: string, value: unknown, signal?: AbortSignal): Promise<JsonObject> {
    const snapshot = this.requireLiveCapability(sessionId);
    const ownerSession = snapshot.sessions.find((session) => session.id === sessionId)!;
    const ownerAgent = snapshot.agents.find((agent) => agent.sessionId === sessionId)!;
    if (['workflow_read', 'workflow_command', 'validate_workflow', 'preview_workflow', 'workflow_run', 'workflow_results'].includes(name)) {
      const workflow = this.options.workflow?.();
      if (!workflow || !this.workflowEnabled(sessionId)) throw new McpRequestError(-32002, 'Workflow tools are unavailable for this session.');
      if (name === 'workflow_run') return this.workflowRun(workflow.authority, sessionId, ownerSession.projectId, ownerAgent, value);
      if (name === 'workflow_results') {
        const args = strictObject(value, ['runId']);
        const runId = requiredString(args.runId, 'runId', 160);
        const read = await workflow.authority.read(ownerSession.projectId);
        if (!read.ok) return toolText(read, true);
        const run = read.snapshot.runs.find((entry) => entry.runId === runId);
        return run ? toolText({ ok: true, run: workflowRunResults(run) }) : toolText({ ok: false, error: 'Unknown runId. Read workflow_read for this project\u2019s runs.' }, true);
      }
      if (name === 'workflow_read') {
        strictObject(value, []);
        const result = await workflow.authority.read(ownerSession.projectId);
        return toolText({ ...result, preview: workflow.service.previewForSession(sessionId) ?? null }, !result.ok);
      }
      if (name === 'preview_workflow') {
        const result = await workflow.authority.editPreview(sessionId, value); return toolText(result, !result.ok);
      }
      if (name === 'validate_workflow') {
        const parsed = WorkflowGraphSchema.safeParse(value);
        return parsed.success ? toolText({ ok: true, issues: validateWorkflowGraph(parsed.data, true) }) : toolText({ ok: false, error: 'Invalid graph schema.' }, true);
      }
      const parsed = WorkflowCommandSchema.safeParse(value);
      if (!parsed.success || parsed.data.projectId !== ownerSession.projectId) throw new McpRequestError(-32602, 'Use an explicit workflow command in this conversation project.');
      const result = await workflow.authority.execute(parsed.data, { kind: 'ai', id: `session:${sessionId}`, sessionId });
      return toolText(result, !result.ok);
    }
    if (!snapshot.runtime.orchestrationToolsEnabled || !ownerAgent.orchestrationEnabled) throw new McpRequestError(-32002, 'Agent orchestration is disabled.');
    switch (name) {
      case 'list_agents': {
        strictObject(value, []);
        const descendants = this.managedDescendants(snapshot, sessionId);
        return toolText({
          ok: true,
          agents: snapshot.agents
            .filter((agent) => agent.sessionId === sessionId || descendants.has(agent.sessionId))
            .map((agent) => {
              const session = snapshot.sessions.find((candidate) => candidate.id === agent.sessionId);
              return {
                sessionId: agent.sessionId,
                title: session?.title ?? agent.sessionId,
                providerId: agent.providerId,
                state: agent.state,
                controllable: descendants.has(agent.sessionId),
              };
            }),
        });
      }
      case 'list_profiles': {
        strictObject(value, []);
        return toolText({
          ok: true,
          profiles: (this.options.listProfiles?.() ?? []).map((profile) => ({
            profileId: profile.id,
            name: profile.name,
            providerId: profile.providerId,
            ...(profile.model ? { model: profile.model } : {}),
            ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
            permissionPreset: profile.permissionPreset,
            ...(profile.whenToUse ? { whenToUse: profile.whenToUse } : {}),
            usable: permissionDoesNotExceed(profile.permissionPreset, ownerAgent.permissionPreset),
          })),
        });
      }
      case 'create_agent': {
        const args = strictObject(value, ['providerId', 'title', 'prompt', 'model', 'permissionPreset', 'profileId', 'reportBack', 'workspaceId']);
        if (args.reportBack !== undefined && typeof args.reportBack !== 'boolean') throw new McpRequestError(-32602, 'reportBack must be a boolean.');
        const workspaceId = optionalString(args.workspaceId, 'workspaceId', 256);
        if (workspaceId) this.requireChildWorkspace(snapshot, ownerSession.projectId, workspaceId);
        const profileId = optionalString(args.profileId, 'profileId', 100);
        const profile = profileId ? this.options.listProfiles?.().find((entry) => entry.id === profileId) : undefined;
        if (profileId && !profile) throw new McpRequestError(-32602, 'Unknown profileId. Read list_profiles first.');
        if (profile && (args.providerId !== undefined || args.model !== undefined || args.permissionPreset !== undefined)) {
          throw new McpRequestError(-32602, 'profileId sets the provider, model and permission; omit them.');
        }
        const providerId = profile?.providerId ?? requiredString(args.providerId, 'providerId', 128);
        const prompt = requiredString(args.prompt, 'prompt', MAX_PROMPT_LENGTH);
        const title = optionalString(args.title, 'title', 256) ?? profile?.name ?? `${providerId} Agent`;
        const model = profile ? profile.model : optionalString(args.model, 'model', 256);
        const reasoningEffort = profile?.reasoningEffort;
        const preset = profile?.permissionPreset
          ?? permissionPreset(args.permissionPreset)
          ?? defaultChildPermissionPreset(ownerAgent.permissionPreset);
        this.requirePermissionWithinOwner(ownerAgent.permissionPreset, preset);
        const childSessionId = `agent-${this.createId()}`;
        const receipt = await this.executeCommand(sessionId, 'agent.create', {
          sessionId: childSessionId,
          workspaceId: workspaceId ?? ownerSession.workspaceId,
          title,
          providerId,
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          permissionPreset: preset,
          initialPrompt: prompt,
          parentSessionId: sessionId,
          ...(args.reportBack === true ? { reportBack: true } : {}),
        }, (current) => {
          this.requirePermissionWithinOwner(
            this.ownerPermission(current, sessionId),
            preset,
          );
          if (workspaceId) this.requireChildWorkspace(current, ownerSession.projectId, workspaceId);
        });
        return toolText({ ok: receipt.ok, sessionId: childSessionId, receipt }, !receipt.ok);
      }
      case 'read_agent': {
        const args = strictObject(value, ['sessionId']);
        const targetSessionId = this.managedTarget(snapshot, sessionId, args.sessionId);
        return toolText({ ok: true, progress: childProgress(snapshot, targetSessionId), ...this.agentReport(snapshot, sessionId, targetSessionId) });
      }
      case 'wait_agent':
        return this.waitAgent(sessionId, ownerSession.projectId, snapshot, value, signal);
      case 'send_message': {
        const args = strictObject(value, ['sessionId', 'prompt', 'interrupt']);
        const targetSessionId = this.managedExecutableTarget(snapshot, sessionId, args.sessionId);
        const prompt = requiredString(args.prompt, 'prompt', MAX_PROMPT_LENGTH);
        if (args.interrupt !== undefined && typeof args.interrupt !== 'boolean') {
          throw new McpRequestError(-32602, 'interrupt must be a boolean.');
        }
        const type = args.interrupt === true ? 'agent.interrupt-and-submit' : 'agent.submit';
        const receipt = await this.executeCommand(
          sessionId,
          type,
          { sessionId: targetSessionId, prompt },
          (current) => { this.managedExecutableTarget(current, sessionId, targetSessionId); },
        );
        return toolText({ ok: receipt.ok, receipt }, !receipt.ok);
      }
      case 'interrupt_agent': {
        const args = strictObject(value, ['sessionId']);
        const targetSessionId = this.managedTarget(snapshot, sessionId, args.sessionId);
        const receipt = await this.executeCommand(
          sessionId,
          'agent.interrupt',
          { sessionId: targetSessionId },
          (current) => { this.managedTarget(current, sessionId, targetSessionId); },
        );
        return toolText({ ok: receipt.ok, receipt }, !receipt.ok);
      }
      case 'set_agent': {
        const args = strictObject(value, ['sessionId', 'model', 'permissionPreset']);
        const model = optionalString(args.model, 'model', 256);
        const preset = permissionPreset(args.permissionPreset);
        if (!model && !preset) throw new McpRequestError(-32602, 'model or permissionPreset is required.');
        const targetSessionId = this.managedExecutableTarget(snapshot, sessionId, args.sessionId);
        if (preset) this.requirePermissionWithinOwner(ownerAgent.permissionPreset, preset);
        const receipt = await this.executeCommand(sessionId, 'agent.set-settings', {
          sessionId: targetSessionId,
          ...(model ? { model } : {}),
          ...(preset ? { permissionPreset: preset } : {}),
        }, (current) => {
          this.managedExecutableTarget(current, sessionId, targetSessionId);
          if (preset) {
            this.requirePermissionWithinOwner(this.ownerPermission(current, sessionId), preset);
          }
        });
        return toolText({ ok: receipt.ok, receipt }, !receipt.ok);
      }
      case 'cancel_agent':
      case 'archive_agent':
      case 'detach_agent': {
        const args = strictObject(value, ['sessionId']);
        const type = name === 'cancel_agent'
          ? 'agent.cancel'
          : name === 'archive_agent'
            ? 'agent.archive'
            : 'agent.detach';
        const targetSessionId = this.managedTarget(snapshot, sessionId, args.sessionId);
        const receipt = await this.executeCommand(
          sessionId,
          type,
          { sessionId: targetSessionId },
          (current) => { this.managedTarget(current, sessionId, targetSessionId); },
        );
        return toolText({ ok: receipt.ok, receipt }, !receipt.ok);
      }
      default:
        throw new McpRequestError(-32602, `Unknown tool: ${name}`);
    }
  }

  /** A child may start in another active workspace of the caller's project, not in a planning run's. */
  private requireChildWorkspace(snapshot: DaemonSnapshot, projectId: string, workspaceId: string): void {
    const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace || workspace.projectId !== projectId || workspace.archivedAt !== undefined || isRunOwnedWorkspace(workspace.id)) {
      throw new McpRequestError(-32602, 'workspaceId must be an active workspace of this project (for example one from create_worktree).');
    }
  }

  /** What an Agent learns about a descendant: where it stands and its latest answer, bounded. */
  private agentReport(snapshot: DaemonSnapshot, ownerSessionId: string, targetSessionId: string): JsonObject {
    const agent = snapshot.agents.find((entry) => entry.sessionId === targetSessionId);
    const session = snapshot.sessions.find((entry) => entry.id === targetSessionId);
    const latest = latestFinishedTurn(snapshot.turns, targetSessionId);
    const read = this.options.authority.readTranscript;
    // The full answer stays in the descendant's conversation; it is never logged here.
    const answer = latest && read ? finalAssistantText(read, targetSessionId, latest.id)?.trim() : undefined;
    return {
      sessionId: targetSessionId,
      title: session?.title ?? targetSessionId,
      ...(agent ? { providerId: agent.providerId, state: agent.state, queuedTurns: agent.queuedTurnCount } : {}),
      ...(session ? { workspaceId: session.workspaceId } : {}),
      ...(latest ? { latestTurn: { state: latest.state, ...(latest.finishedAt ? { finishedAt: latest.finishedAt } : {}), ...(latest.errorCode ? { errorCode: latest.errorCode } : {}) } } : {}),
      answer: answer ? answer.slice(0, MAX_ANSWER_LENGTH) : null,
      truncated: Boolean(answer && answer.length > MAX_ANSWER_LENGTH),
      pendingApprovals: snapshot.approvals.filter((approval) => approval.sessionId === targetSessionId && approval.state === 'pending')
        .slice(0, 5).map((approval) => ({ title: approval.title.slice(0, 200) })),
      reportBack: Boolean(read && reportBackRequested(read, targetSessionId, ownerSessionId)),
    };
  }

  /**
   * Holds until a descendant finishes, needs a person's approval, or the timeout passes. It wakes on
   * the descendant's own changes only and re-checks this Agent's capability every time.
   */
  private async waitAgent(sessionId: string, projectId: string, snapshot: DaemonSnapshot, value: unknown, signal?: AbortSignal): Promise<JsonObject> {
    const onEvent = this.options.authority.onEvent;
    if (!onEvent) throw new McpRequestError(-32601, 'wait_agent is unavailable on this host.');
    const args = strictObject(value, ['sessionId', 'timeoutSeconds']);
    const targetSessionId = this.managedTarget(snapshot, sessionId, args.sessionId);
    const timeoutSeconds = args.timeoutSeconds === undefined ? DEFAULT_WAIT_SECONDS : args.timeoutSeconds;
    if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_WAIT_SECONDS) {
      throw new McpRequestError(-32602, `timeoutSeconds must be an integer from 1 to ${MAX_WAIT_SECONDS}.`);
    }
    const read = this.options.authority.readTranscript;
    const reported = snapshot.turns.some((turn) => turn.sessionId === targetSessionId && (turn.state === 'completed' || turn.state === 'failed'));
    if (read && !reported && reportBackRequested(read, targetSessionId, sessionId)) {
      throw new McpRequestError(-32602, 'This child sends its result back as your next message; end your turn instead of waiting (read_agent shows where it stands).');
    }
    if ([...this.waiters].filter((waiter) => waiter.ownerSessionId === sessionId).length >= MAX_WAITS_PER_AGENT) {
      throw new McpRequestError(-32602, `At most ${MAX_WAITS_PER_AGENT} waits can be open at once.`);
    }
    const setTimer = this.options.setTimer ?? setTimeout;
    const clearTimer = this.options.clearTimer ?? clearTimeout;
    const outcome = await new Promise<'settled' | 'timeout' | 'revoked'>((resolve) => {
      let done = false;
      let scheduled = false;
      let unsubscribe = (): void => undefined;
      const finish = (reason: 'settled' | 'timeout' | 'revoked'): void => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimer(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
        resolve(reason);
      };
      const waiter: Waiter = { ownerSessionId: sessionId, projectId, settle: () => finish('revoked') };
      const onAbort = (): void => finish('revoked');
      const evaluate = (): void => {
        scheduled = false;
        if (done) return;
        try {
          const current = this.requireLiveCapability(sessionId);
          this.managedTarget(current, sessionId, targetSessionId);
          if (childProgress(current, targetSessionId) !== 'working') finish('settled');
        } catch {
          finish('revoked');
        }
      };
      this.waiters.add(waiter);
      // Subscribe before the first check so a change in between is not missed.
      unsubscribe = onEvent((event) => {
        try {
          const relevant = event.kind === 'runtime.changed' || event.kind === 'entity.archived'
            || (event.kind === 'entity.upserted' && event.payload.entityType === 'agent' && event.payload.entityId === targetSessionId);
          if (relevant && !scheduled && !done) {
            scheduled = true;
            setImmediate(evaluate);
          }
        } catch {
          // A notification never breaks the daemon's event loop.
        }
      });
      const timer = setTimer(() => finish('timeout'), timeoutSeconds * 1_000);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) finish('revoked');
      else evaluate();
    });
    if (outcome === 'revoked') throw new McpRequestError(-32002, 'This Agent orchestration capability is no longer active.');
    const current = this.options.authority.getSnapshot();
    const progress = childProgress(current, targetSessionId);
    return toolText({
      ok: true,
      finished: progress === 'finished',
      ...(progress === 'needs-attention' ? { needsAttention: true } : {}),
      ...this.agentReport(current, sessionId, targetSessionId),
    });
  }

  private async executeCommand<T extends DaemonCommandType>(
    ownerSessionId: string,
    type: T,
    payload: DaemonCommandPayloads[T],
    authorize?: (snapshot: DaemonSnapshot) => void,
  ): Promise<DaemonCommandReceipt> {
    let receipt: DaemonCommandReceipt | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.requireLiveCapability(ownerSessionId);
      authorize?.(snapshot);
      const id = this.createId();
      const issuedAt = this.now();
      if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.valueOf())) {
        throw new Error('Agent orchestration clock returned an invalid Date.');
      }
      const command = createDaemonCommand({
        commandId: `mcp-command-${id}`,
        idempotencyKey: `mcp-${ownerSessionId}-${id}`,
        expectedRevision: snapshot.revision,
        issuedAt: issuedAt.toISOString(),
        principal: { kind: 'mcp', id: `session-${ownerSessionId}`, sessionId: ownerSessionId },
        type,
        payload,
      }) as DaemonCommand;
      receipt = await this.options.authority.execute(command);
      if (receipt.ok || receipt.error.code !== 'revision-conflict') return receipt;
    }
    return receipt!;
  }

  private requireLiveCapability(sessionId: string): DaemonSnapshot {
    const snapshot = this.options.authority.getSnapshot();
    const runtimeEnabled = snapshot.runtime.orchestrationToolsEnabled;
    const agent = snapshot.agents.find((candidate) => candidate.sessionId === sessionId);
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    const project = session
      ? snapshot.projects.find((candidate) => (
          candidate.id === session.projectId && candidate.archivedAt === undefined
        ))
      : undefined;
    const workspace = session
      ? snapshot.workspaces.find((candidate) => (
          candidate.id === session.workspaceId
          && candidate.projectId === session.projectId
          && candidate.archivedAt === undefined
        ))
      : undefined;
    const provider = agent
      ? snapshot.providers.find((candidate) => candidate.id === agent.providerId)
      : undefined;
    if (
      (!(runtimeEnabled && agent?.orchestrationEnabled) && !this.workflowEnabled(sessionId))
      || !provider?.enabled
      || !agent
      || provider.health !== 'ready'
      || !session
      || !project
      || !workspace
      || session.kind !== 'agent'
      || ['completed', 'interrupted', 'failed', 'archived'].includes(session.state)
      || ['done', 'interrupted', 'error', 'archived'].includes(agent.state)
    ) {
      throw new McpRequestError(-32002, 'This Agent orchestration capability is no longer active.');
    }
    return snapshot;
  }

  private workflowEnabled(sessionId: string): boolean {
    return Boolean(this.options.workflow?.() && this.options.workflowAllowed?.(sessionId));
  }

  /** Runs a subproject's flow for the conversation's agent; the envelope comes from the stored state. */
  private async workflowRun(
    authority: WorkflowAuthority,
    sessionId: string,
    projectId: string,
    ownerAgent: DaemonSnapshot['agents'][number],
    value: unknown,
  ): Promise<JsonObject> {
    const args = strictObject(value, ['action', 'subprojectId', 'runId', 'reviewer']);
    const action = requiredString(args.action, 'action', 16);
    const actions = { prepare: 'run.prepare', start: 'run.start', pause: 'run.pause', resume: 'run.resume', cancel: 'run.cancel' } as const;
    if (!(action in actions)) throw new McpRequestError(-32602, 'action is one of prepare, start, pause, resume or cancel.');
    const subprojectId = requiredString(args.subprojectId, 'subprojectId', 160);
    const read = await authority.read(projectId);
    if (!read.ok) return toolText(read, true);
    const subproject = read.snapshot.subprojects.find((entry) => entry.id === subprojectId);
    if (!subproject) throw new McpRequestError(-32602, 'Unknown subprojectId. Read workflow_read first.');
    const envelope = { commandId: `mcp-run-${this.createId()}`, projectId, hostId: read.snapshot.hostId, expectedRevision: subproject.revision, subprojectId };
    let command: WorkflowCommand;
    if (action === 'prepare') {
      const reviewer = isObject(args.reviewer)
        ? { providerId: requiredString(args.reviewer.providerId, 'reviewer.providerId', 128), model: requiredString(args.reviewer.model, 'reviewer.model', 256) }
        : ownerAgent.model ? { providerId: ownerAgent.providerId, model: ownerAgent.model } : undefined;
      if (!reviewer) throw new McpRequestError(-32602, 'Give reviewer {providerId, model}: this conversation runs on its provider\u2019s default model.');
      command = { ...envelope, type: 'run.prepare', payload: { runId: `run-${this.createId()}`, reviewer } };
    } else {
      command = { ...envelope, type: actions[action as Exclude<keyof typeof actions, 'prepare'>], payload: { runId: requiredString(args.runId, 'runId', 160) } };
    }
    const result = await authority.execute(command, { kind: 'ai', id: `session:${sessionId}`, sessionId });
    return toolText({ ...result, ...(command.type === 'run.prepare' && result.ok ? { runId: command.payload.runId } : {}) }, !result.ok);
  }

  private workflowToolDefinitions(): JsonObject[] {
    const graph = { type: 'object', description: 'Graph with entryNodeId:string|null, nodes:[{id,title,operation:agent|condition|parallel|join|approval|complete,role:planning|design|implementation|review|integration,instructions,document,providerId?,model?,permissionPreset:plan|standard,acceptance:string[],allowedPaths:string[],retryLimit:0..20,position:{x,y},inputs:[{nodeId,kind:document|result}],condition?:{sourceNodeId,field:outcome,equals:passed|failed},joinPolicy?:all|any}], edges:[{id,from,to,outcome:next|passed|failed|approved|rejected,retryLimit?:1..20}]. Stable IDs preserve conversations.' };
    return [
      { name: 'workflow_read', description: 'Read this project’s subprojects, graph drafts, changes, run snapshots and this conversation’s creation preview. No model or run is started.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'workflow_command', description: `${WORKFLOW_SKILL.instructions}\nCommands: subproject.create payload {id,title,goal,presetId:feature|fix|research|parallel|custom,graph?}; workflow.patch payload {graph,summary}; workflow.undo payload {changeId}. Envelope: commandId,projectId,hostId,expectedRevision,subprojectId (required except create),type,payload.`, inputSchema: { type: 'object', properties: { commandId: { type: 'string' }, projectId: { type: 'string' }, hostId: { type: 'string' }, expectedRevision: { type: 'integer' }, subprojectId: { type: 'string' }, type: { type: 'string' }, payload: { type: 'object', properties: { graph }, additionalProperties: true } }, required: ['commandId', 'projectId', 'hostId', 'expectedRevision', 'type', 'payload'], additionalProperties: false } },
      { name: 'validate_workflow', description: 'Validate a proposed graph without changing any stored draft or starting execution.', inputSchema: graph },
      { name: 'workflow_run', description: 'Run a subproject\u2019s saved flow: prepare (freezes the current draft and returns runId; reviewer defaults to this conversation\u2019s provider and model), then start, pause, resume or cancel that runId. Approval stages and result integration are the person\u2019s, unless they turned on 자동 승인 for the subproject; read workflow_results to follow it.',
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['prepare', 'start', 'pause', 'resume', 'cancel'] }, subprojectId: { type: 'string' }, runId: { type: 'string' },
          reviewer: { type: 'object', properties: { providerId: { type: 'string' }, model: { type: 'string' } }, required: ['providerId', 'model'], additionalProperties: false } }, required: ['action', 'subprojectId'], additionalProperties: false } },
      { name: 'workflow_results', description: 'Read where a run stands: each stage\u2019s state and attempts with their bounded summaries, approvals waiting for the person, and whether integration was allowed.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false } },
      { name: 'preview_workflow', description: 'Edit the creation preview explicitly opened by the user for this conversation. This never creates a saved subproject. Read workflow_read first; the UI updates its preview and the user chooses Create or Cancel.', inputSchema: { type: 'object', properties: { commandId: { type: 'string' }, previewId: { type: 'string' }, expectedRevision: { type: 'integer' }, graph }, required: ['commandId', 'previewId', 'expectedRevision', 'graph'], additionalProperties: false } },
    ];
  }

  private managedDescendants(snapshot: DaemonSnapshot, sessionId: string): Set<string> {
    const descendants = new Set<string>();
    let frontier = [sessionId];
    while (frontier.length > 0) {
      const parents = new Set(frontier);
      frontier = [];
      for (const relation of snapshot.agentRelations) {
        if (
          relation.owner !== 'managed'
          || relation.detachedAt
          || !parents.has(relation.parentSessionId)
          || descendants.has(relation.childSessionId)
        ) continue;
        descendants.add(relation.childSessionId);
        frontier.push(relation.childSessionId);
      }
    }
    return descendants;
  }

  private managedTarget(snapshot: DaemonSnapshot, ownerSessionId: string, value: unknown): string {
    const targetSessionId = requiredString(value, 'sessionId');
    if (!this.managedDescendants(snapshot, ownerSessionId).has(targetSessionId)) {
      throw new McpRequestError(-32602, 'sessionId must identify a managed descendant.');
    }
    return targetSessionId;
  }

  private managedExecutableTarget(
    snapshot: DaemonSnapshot,
    ownerSessionId: string,
    value: unknown,
  ): string {
    const targetSessionId = this.managedTarget(snapshot, ownerSessionId, value);
    const ownerPreset = this.ownerPermission(snapshot, ownerSessionId);
    const target = snapshot.agents.find((agent) => agent.sessionId === targetSessionId);
    if (!target || !permissionDoesNotExceed(target.permissionPreset, ownerPreset)) {
      throw new McpRequestError(
        -32602,
        'The managed descendant permission preset exceeds this Agent capability.',
      );
    }
    return targetSessionId;
  }

  private ownerPermission(snapshot: DaemonSnapshot, ownerSessionId: string): PermissionPreset {
    const owner = snapshot.agents.find((agent) => agent.sessionId === ownerSessionId);
    if (!owner) throw new McpRequestError(-32002, 'This Agent orchestration capability is no longer active.');
    return owner.permissionPreset;
  }

  private requirePermissionWithinOwner(
    ownerPreset: PermissionPreset,
    requestedPreset: PermissionPreset,
  ): void {
    if (!permissionDoesNotExceed(requestedPreset, ownerPreset)) {
      throw new McpRequestError(
        -32602,
        'permissionPreset cannot exceed this Agent permission capability.',
      );
    }
  }

  private authorized(sessionId: string, authorization: string | undefined): boolean {
    const capability = this.capabilities.get(sessionId);
    if (!capability || !authorization?.startsWith('Bearer ')) return false;
    const token = authorization.slice('Bearer '.length);
    const candidate = digestToken(token);
    return candidate.length === capability.digest.length && timingSafeEqual(candidate, capability.digest);
  }

  private readBody(request: IncomingMessage): Promise<string> {
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      throw new McpRequestError(-32000, 'MCP request body is too large.');
    }
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      request.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_REQUEST_BYTES) {
          reject(new McpRequestError(-32000, 'MCP request body is too large.'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.once('error', reject);
    });
  }

  private toolDefinitions(ownerPreset: PermissionPreset): readonly JsonObject[] {
    const objectSchema = (properties: JsonObject, required: readonly string[] = []): JsonObject => ({
      type: 'object', properties, required, additionalProperties: false,
    });
    const sessionId = { type: 'string', minLength: 1, maxLength: 256 };
    const prompt = { type: 'string', minLength: 1, maxLength: MAX_PROMPT_LENGTH };
    const allowedPresets = PERMISSION_PRESETS.filter((candidate) => (
      permissionDoesNotExceed(candidate, ownerPreset)
    ));
    const defaultPreset = defaultChildPermissionPreset(ownerPreset);
    const preset = {
      type: 'string',
      enum: allowedPresets,
      description: `Cannot exceed the calling Agent's ${ownerPreset} permission capability.`,
    };
    return [
      {
        name: 'list_agents',
        description: 'List this Agent and its currently managed descendants.',
        inputSchema: objectSchema({}),
      },
      ...(this.options.listProfiles ? [{
        name: 'list_profiles',
        description: 'List the agent profiles the person saved (provider, model, effort, permission) and when to use each. Pass one as profileId to create_agent.',
        inputSchema: objectSchema({}),
      }] : []),
      {
        name: 'create_agent',
        description: `Create a direct managed child Agent without exceeding this Agent's ${ownerPreset} permission capability. Give either profileId (from list_profiles) or providerId; omitted permissionPreset defaults to ${defaultPreset}. workspaceId starts it in another workspace of this project (e.g. from create_worktree). Then wait_agent for its result, or set reportBack:true and end your turn — the result arrives as your next message; do not do both.`,
        inputSchema: objectSchema({
          profileId: { type: 'string', minLength: 1, maxLength: 100 },
          providerId: { type: 'string', minLength: 1, maxLength: 128 },
          title: { type: 'string', minLength: 1, maxLength: 256 },
          prompt,
          model: { type: 'string', minLength: 1, maxLength: 256 },
          permissionPreset: preset,
          workspaceId: { type: 'string', minLength: 1, maxLength: 256 },
          reportBack: { type: 'boolean' },
        }, ['prompt']),
      },
      ...(this.options.authority.readTranscript ? [{
        name: 'read_agent',
        description: 'Read where a managed descendant stands (finished, needs-attention or working) and its latest answer, up to 8000 characters.',
        inputSchema: objectSchema({ sessionId }, ['sessionId']),
      }] : []),
      ...(this.options.authority.readTranscript && this.options.authority.onEvent ? [{
        name: 'wait_agent',
        description: `Wait until a managed descendant finishes or needs a person's approval, up to timeoutSeconds (1-${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}); returns its state and latest answer. If finished is false, wait again or tell the person. Not for a child created with reportBack:true.`,
        inputSchema: objectSchema({ sessionId, timeoutSeconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS } }, ['sessionId']),
      }] : []),
      {
        name: 'send_message',
        description: 'Send a prompt only to a managed descendant whose permission does not exceed this Agent; optionally interrupt its current turn first.',
        inputSchema: objectSchema({ sessionId, prompt, interrupt: { type: 'boolean' } }, ['sessionId', 'prompt']),
      },
      {
        name: 'interrupt_agent',
        description: 'Interrupt the active turn of a managed descendant.',
        inputSchema: objectSchema({ sessionId }, ['sessionId']),
      },
      {
        name: 'set_agent',
        description: 'Change a managed descendant at or below this Agent permission capability; permissionPreset cannot exceed that ceiling.',
        inputSchema: objectSchema({
          sessionId,
          model: { type: 'string', minLength: 1, maxLength: 256 },
          permissionPreset: preset,
        }, ['sessionId']),
      },
      {
        name: 'cancel_agent',
        description: 'Stop a managed descendant and its queued work.',
        inputSchema: objectSchema({ sessionId }, ['sessionId']),
      },
      {
        name: 'archive_agent',
        description: 'Archive a stopped managed descendant.',
        inputSchema: objectSchema({ sessionId }, ['sessionId']),
      },
      {
        name: 'detach_agent',
        description: 'Detach a managed descendant from this orchestration tree.',
        inputSchema: objectSchema({ sessionId }, ['sessionId']),
      },
    ];
  }

  private report(context: string, error: unknown): void {
    try {
      this.options.reportError?.(context, error);
    } catch {
      // Diagnostics never weaken or terminate the local authority boundary.
    }
  }
}
