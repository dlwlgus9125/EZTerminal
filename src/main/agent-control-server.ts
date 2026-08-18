import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { AgentActivity, AgentState } from '../shared/agent';
import { isSafeAgentPromptText, MAX_AGENT_READ_LINES } from '../shared/agent-coordination';
import type { AgentCoordinationService } from './agent-coordination-service';
import type { ManagedMergeService } from './managed-merge-service';
import { sameSecret } from './managed-merge-service';

const BODY_LIMIT_BYTES = 40 * 1024;
const REQUESTS_PER_MINUTE = 60;
const MAX_CONCURRENT_PER_SESSION = 4;
const MAX_WAIT_MS = 30 * 60_000;

interface Capability {
  readonly sessionId: string;
  readonly token: string;
  readonly issuedAt: number;
  timestamps: number[];
  concurrent: number;
}

function json(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function stateSet(value: unknown): ReadonlySet<AgentState> | null {
  const allowed = new Set<AgentState>([
    'starting', 'working', 'blocked', 'done', 'idle', 'error', 'unknown',
  ]);
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.size) return null;
  const states = new Set<AgentState>();
  for (const state of value) {
    if (typeof state !== 'string' || !allowed.has(state as AgentState)) return null;
    states.add(state as AgentState);
  }
  return states;
}

export class AgentControlServer {
  private server: http.Server | null = null;
  private origin = '';
  private readonly capabilities = new Map<string, Capability>();

  constructor(private readonly deps: {
    readonly coordination: AgentCoordinationService;
    readonly merges: ManagedMergeService;
  }) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        json(response, 500, { ok: false, error: 'internal-error' });
      });
    });
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Agent control server has no loopback address.');
    }
    this.server = server;
    this.origin = `http://127.0.0.1:${String(address.port)}`;
  }

  descriptorForSession(sessionId: string): string {
    if (!this.server || !this.origin) return '';
    const existing = this.capabilities.get(sessionId);
    if (existing) {
      return JSON.stringify({ version: 1, origin: this.origin, token: existing.token });
    }
    const token = randomBytes(32).toString('base64url');
    this.capabilities.set(sessionId, {
      sessionId,
      token,
      issuedAt: Date.now(),
      timestamps: [],
      concurrent: 0,
    });
    return JSON.stringify({ version: 1, origin: this.origin, token });
  }

  revokeSession(sessionId: string): void {
    this.capabilities.delete(sessionId);
  }

  revokeAll(): void {
    this.capabilities.clear();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.origin = '';
    this.revokeAll();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || !request.url?.startsWith('/v1/')) {
      json(response, 404, { ok: false, error: 'not-found' });
      return;
    }
    const capability = this.authenticate(request);
    if (!capability) {
      json(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (!this.enter(capability)) {
      json(response, 429, { ok: false, error: 'rate-limited' });
      return;
    }
    try {
      const source = this.sourceActivity(capability.sessionId);
      if (!source) {
        json(response, 403, { ok: false, error: 'collaboration-inactive' });
        return;
      }
      const body = await this.readBody(request);
      if (body === null) {
        json(response, 400, { ok: false, error: 'invalid-json' });
        return;
      }
      const controller = new AbortController();
      response.once('close', () => {
        if (!response.writableEnded) controller.abort();
      });
      await this.route(request.url, body, source, response, controller.signal);
    } finally {
      capability.concurrent = Math.max(0, capability.concurrent - 1);
    }
  }

  private async route(
    url: string,
    body: Record<string, unknown>,
    source: AgentActivity,
    response: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    if (url === '/v1/list') {
      const snapshot = this.deps.coordination.getSnapshot();
      const projectId = source.participant!.projectId;
      json(response, 200, {
        ok: true,
        snapshot: {
          ...snapshot,
          activities: snapshot.activities.filter((activity) => activity.participant?.projectId === projectId),
          projects: snapshot.projects.filter((project) => project.projectId === projectId),
          mergeRequests: snapshot.mergeRequests.filter((request) => request.projectId === projectId),
        },
      });
      return;
    }
    if (url === '/v1/read') {
      const target = typeof body.target === 'string' ? body.target : '';
      const lines = typeof body.lines === 'number'
        ? Math.max(1, Math.min(MAX_AGENT_READ_LINES, Math.floor(body.lines)))
        : 80;
      const activity = target ? this.resolveProjectActivity(source, target) : null;
      const result = activity ? await this.deps.coordination.read(activity.id, lines) : null;
      json(response, result?.ok ? 200 : 404, { ok: result?.ok === true, result });
      return;
    }
    if (url === '/v1/prompt') {
      const target = typeof body.target === 'string' ? body.target : '';
      const text = typeof body.text === 'string' ? body.text : '';
      const whenReady = body.whenReady === true;
      const wait = body.wait === true;
      if (!target || !isSafeAgentPromptText(text)) {
        json(response, 400, { ok: false, error: 'invalid-request' });
        return;
      }
      let activity = this.deps.coordination.resolveActivity(target);
      if (!activity || !this.sameProject(source, activity)) {
        json(response, 404, { ok: false, error: 'not-found' });
        return;
      }
      if ((activity.state !== 'done' && activity.state !== 'idle') || !activity.interactiveReady) {
        if (!whenReady) {
          json(response, 409, { ok: false, error: 'not-ready', activity });
          return;
        }
        activity = await this.deps.coordination.waitFor(
          activity.id,
          new Set<AgentState>(['done', 'idle']),
          activity.stateSeq,
          MAX_WAIT_MS,
          signal,
        );
        if (!activity?.interactiveReady) {
          json(response, 409, { ok: false, error: 'not-ready', activity });
          return;
        }
      }
      const beforeSeq = activity.stateSeq;
      const submitted = await this.deps.coordination.prompt(activity.id, text);
      if (!submitted.ok) {
        json(response, 409, { ok: false, error: submitted.error });
        return;
      }
      if (!wait) {
        json(response, 200, { ok: true, activity });
        return;
      }
      const accepted = await this.deps.coordination.waitFor(
        activity.id,
        new Set<AgentState>(['working', 'blocked', 'done', 'idle', 'error']),
        beforeSeq,
        5_000,
        signal,
      );
      if (!accepted) {
        json(response, 504, { ok: false, error: 'acceptance-timeout', outcome: 'unknown' });
        return;
      }
      json(response, 200, { ok: true, activity: accepted });
      return;
    }
    if (url === '/v1/wait') {
      const target = typeof body.target === 'string' ? body.target : '';
      const states = stateSet(body.states);
      const after = typeof body.afterStateSeq === 'number' && Number.isSafeInteger(body.afterStateSeq)
        ? body.afterStateSeq
        : undefined;
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : MAX_WAIT_MS;
      if (!target || !states) {
        json(response, 400, { ok: false, error: 'invalid-request' });
        return;
      }
      const resolved = this.resolveProjectActivity(source, target);
      const activity = resolved
        ? await this.deps.coordination.waitFor(resolved.id, states, after, timeoutMs, signal)
        : null;
      json(response, activity ? 200 : 504, { ok: Boolean(activity), activity });
      return;
    }
    if (url === '/v1/merge/request') {
      const targetBranch = typeof body.targetBranch === 'string' ? body.targetBranch : '';
      const result = await this.deps.merges.requestForActivity(source.id, targetBranch);
      if (!result.ok) {
        json(response, 409, result);
        return;
      }
      if (body.wait !== true) {
        json(response, 200, result);
        return;
      }
      const request = await this.deps.merges.waitForRequest(
        result.value.requestId,
        result.value.revision,
        MAX_WAIT_MS,
        true,
        signal,
      );
      json(response, request ? 200 : 504, { ok: Boolean(request), value: request });
      return;
    }
    if (url === '/v1/merge/wait') {
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      const afterRevision = typeof body.afterRevision === 'number' && Number.isSafeInteger(body.afterRevision)
        ? body.afterRevision
        : undefined;
      if (!requestId) {
        json(response, 400, { ok: false, error: 'invalid-request' });
        return;
      }
      const existing = this.deps.merges.listRequests().find((request) => request.requestId === requestId);
      if (!existing || existing.projectId !== source.participant!.projectId) {
        json(response, 404, { ok: false, error: 'not-found' });
        return;
      }
      const request = await this.deps.merges.waitForRequest(
        requestId,
        afterRevision,
        MAX_WAIT_MS,
        true,
        signal,
      );
      json(response, request ? 200 : 404, { ok: Boolean(request), value: request });
      return;
    }
    json(response, 404, { ok: false, error: 'not-found' });
  }

  private authenticate(request: IncomingMessage): Capability | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length);
    for (const capability of this.capabilities.values()) {
      if (sameSecret(capability.token, token)) return capability;
    }
    return null;
  }

  private enter(capability: Capability): boolean {
    const now = Date.now();
    capability.timestamps = capability.timestamps.filter((timestamp) => timestamp > now - 60_000);
    if (capability.timestamps.length >= REQUESTS_PER_MINUTE || capability.concurrent >= MAX_CONCURRENT_PER_SESSION) {
      return false;
    }
    capability.timestamps.push(now);
    capability.concurrent += 1;
    return true;
  }

  private sourceActivity(sessionId: string): AgentActivity | null {
    const matches = this.deps.coordination.getSnapshot().activities.filter((activity) => (
      activity.live && activity.sessionId === sessionId && activity.participant
    ));
    return matches.length === 1 ? matches[0]! : null;
  }

  private sameProject(source: AgentActivity, target: AgentActivity): boolean {
    return source.participant !== undefined
      && target.participant !== undefined
      && source.participant.projectId === target.participant.projectId;
  }

  private resolveProjectActivity(source: AgentActivity, target: string): AgentActivity | null {
    const activity = this.deps.coordination.resolveActivity(target);
    return activity && this.sameProject(source, activity) ? activity : null;
  }

  private readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let rejected = false;
      request.on('data', (chunk: Buffer) => {
        if (rejected) return;
        bytes += chunk.byteLength;
        if (bytes > BODY_LIMIT_BYTES) {
          rejected = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (rejected) {
          resolve(null);
          return;
        }
        if (bytes === 0) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null);
        } catch {
          resolve(null);
        }
      });
      request.on('error', () => resolve(null));
    });
  }
}

export function descriptorFingerprint(descriptor: string): string {
  return createHash('sha256').update(descriptor).digest('hex').slice(0, 12);
}
