import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandPayloads,
  type DaemonCommandReceipt,
  type DaemonCommandType,
  type DaemonSnapshot,
  type PermissionPreset,
} from '../shared/daemon-protocol';
import type { ProviderSessionContext } from './agent-provider-adapter';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PROMPT_LENGTH = 200_000;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';

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
}

export interface AgentOrchestrationMcpServerOptions {
  readonly authority: OrchestrationAuthority;
  readonly host?: string;
  readonly createId?: () => string;
  readonly createToken?: () => string;
  readonly now?: () => Date;
  readonly reportError?: (context: string, error: unknown) => void;
}

interface SessionCapability {
  readonly digest: Buffer;
}

class McpRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'McpRequestError';
  }
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
    const bearerToken = this.createToken();
    if (!bearerToken || bearerToken.length < 32 || bearerToken.length > 512) {
      throw new Error('Agent orchestration token generator returned an unsafe token.');
    }
    this.capabilities.set(sessionId, { digest: digestToken(bearerToken) });
    return {
      endpoint: `http://${this.host}:${String(this.port)}/mcp/${encodeURIComponent(sessionId)}`,
      bearerToken,
    };
  }

  revokeSession(sessionId: string): void {
    this.capabilities.delete(sessionId);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const server = this.server;
    this.server = null;
    this.port = null;
    this.capabilities.clear();
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
    try {
      const result = await this.dispatch(sessionId, requestValue);
      json(response, 200, rpcResult(requestValue.id, result));
    } catch (error) {
      const normalized = error instanceof McpRequestError
        ? error
        : new McpRequestError(-32603, 'Internal server error.');
      if (!(error instanceof McpRequestError)) this.report('MCP dispatch failed', error);
      json(response, 200, rpcError(requestValue.id, normalized.code, normalized.message));
    }
  }

  private async dispatch(sessionId: string, request: JsonRpcRequest): Promise<unknown> {
    if (request.method === 'initialize') {
      const params = isObject(request.params) ? request.params : {};
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ezterminal-orchestration', version: '1.0.0' },
        instructions: 'Create and communicate with managed child Agents in the same EZTerminal Project.',
      };
    }
    this.requireLiveCapability(sessionId);
    if (request.method === 'ping') return {};
    if (request.method === 'tools/list') return { tools: this.toolDefinitions() };
    if (request.method !== 'tools/call') throw new McpRequestError(-32601, 'Method not found.');
    const params = strictObject(request.params, ['name', 'arguments']);
    const name = requiredString(params.name, 'name', 128);
    const args = params.arguments ?? {};
    try {
      return await this.callTool(sessionId, name, args);
    } catch (error) {
      if (error instanceof McpRequestError) return toolText({ ok: false, error: error.message }, true);
      throw error;
    }
  }

  private async callTool(sessionId: string, name: string, value: unknown): Promise<JsonObject> {
    const snapshot = this.requireLiveCapability(sessionId);
    const ownerSession = snapshot.sessions.find((session) => session.id === sessionId)!;
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
      case 'create_agent': {
        const args = strictObject(value, ['providerId', 'title', 'prompt', 'model', 'permissionPreset']);
        const providerId = requiredString(args.providerId, 'providerId', 128);
        const prompt = requiredString(args.prompt, 'prompt', MAX_PROMPT_LENGTH);
        const title = optionalString(args.title, 'title', 256) ?? `${providerId} Agent`;
        const model = optionalString(args.model, 'model', 256);
        const preset = permissionPreset(args.permissionPreset) ?? 'standard';
        const childSessionId = `agent-${this.createId()}`;
        const receipt = await this.executeCommand(sessionId, 'agent.create', {
          sessionId: childSessionId,
          workspaceId: ownerSession.workspaceId,
          title,
          providerId,
          ...(model ? { model } : {}),
          permissionPreset: preset,
          initialPrompt: prompt,
          parentSessionId: sessionId,
        });
        return toolText({ ok: receipt.ok, sessionId: childSessionId, receipt }, !receipt.ok);
      }
      case 'send_message': {
        const args = strictObject(value, ['sessionId', 'prompt', 'interrupt']);
        const targetSessionId = requiredString(args.sessionId, 'sessionId');
        const prompt = requiredString(args.prompt, 'prompt', MAX_PROMPT_LENGTH);
        if (args.interrupt !== undefined && typeof args.interrupt !== 'boolean') {
          throw new McpRequestError(-32602, 'interrupt must be a boolean.');
        }
        const type = args.interrupt === true ? 'agent.interrupt-and-submit' : 'agent.submit';
        const receipt = await this.executeCommand(sessionId, type, { sessionId: targetSessionId, prompt });
        return toolText({ ok: receipt.ok, receipt }, !receipt.ok);
      }
      case 'interrupt_agent': {
        const args = strictObject(value, ['sessionId']);
        const receipt = await this.executeCommand(sessionId, 'agent.interrupt', {
          sessionId: requiredString(args.sessionId, 'sessionId'),
        });
        return toolText({ ok: receipt.ok, receipt }, !receipt.ok);
      }
      case 'set_agent': {
        const args = strictObject(value, ['sessionId', 'model', 'permissionPreset']);
        const model = optionalString(args.model, 'model', 256);
        const preset = permissionPreset(args.permissionPreset);
        if (!model && !preset) throw new McpRequestError(-32602, 'model or permissionPreset is required.');
        const receipt = await this.executeCommand(sessionId, 'agent.set-settings', {
          sessionId: requiredString(args.sessionId, 'sessionId'),
          ...(model ? { model } : {}),
          ...(preset ? { permissionPreset: preset } : {}),
        });
        return toolText({ ok: receipt.ok, receipt }, !receipt.ok);
      }
      case 'cancel_agent':
      case 'detach_agent': {
        const args = strictObject(value, ['sessionId']);
        const type = name === 'cancel_agent' ? 'agent.cancel' : 'agent.detach';
        const receipt = await this.executeCommand(sessionId, type, {
          sessionId: requiredString(args.sessionId, 'sessionId'),
        });
        return toolText({ ok: receipt.ok, receipt }, !receipt.ok);
      }
      default:
        throw new McpRequestError(-32602, `Unknown tool: ${name}`);
    }
  }

  private async executeCommand<T extends DaemonCommandType>(
    ownerSessionId: string,
    type: T,
    payload: DaemonCommandPayloads[T],
  ): Promise<DaemonCommandReceipt> {
    let receipt: DaemonCommandReceipt | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.requireLiveCapability(ownerSessionId);
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
    if (
      !runtimeEnabled
      || !agent?.orchestrationEnabled
      || !session
      || session.kind !== 'agent'
      || ['completed', 'interrupted', 'failed', 'archived'].includes(session.state)
      || ['done', 'interrupted', 'error', 'archived'].includes(agent.state)
    ) {
      throw new McpRequestError(-32002, 'This Agent orchestration capability is no longer active.');
    }
    return snapshot;
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

  private toolDefinitions(): readonly JsonObject[] {
    const objectSchema = (properties: JsonObject, required: readonly string[] = []): JsonObject => ({
      type: 'object', properties, required, additionalProperties: false,
    });
    const sessionId = { type: 'string', minLength: 1, maxLength: 256 };
    const prompt = { type: 'string', minLength: 1, maxLength: MAX_PROMPT_LENGTH };
    const preset = { type: 'string', enum: ['plan', 'standard', 'full-access'] };
    return [
      {
        name: 'list_agents',
        description: 'List this Agent and its currently managed descendants.',
        inputSchema: objectSchema({}),
      },
      {
        name: 'create_agent',
        description: 'Create a direct managed child Agent in this Agent workspace.',
        inputSchema: objectSchema({
          providerId: { type: 'string', minLength: 1, maxLength: 128 },
          title: { type: 'string', minLength: 1, maxLength: 256 },
          prompt,
          model: { type: 'string', minLength: 1, maxLength: 256 },
          permissionPreset: preset,
        }, ['providerId', 'prompt']),
      },
      {
        name: 'send_message',
        description: 'Send a prompt to a managed descendant; optionally interrupt its current turn first.',
        inputSchema: objectSchema({ sessionId, prompt, interrupt: { type: 'boolean' } }, ['sessionId', 'prompt']),
      },
      {
        name: 'interrupt_agent',
        description: 'Interrupt the active turn of a managed descendant.',
        inputSchema: objectSchema({ sessionId }, ['sessionId']),
      },
      {
        name: 'set_agent',
        description: 'Change a managed descendant model or permission preset between turns.',
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
