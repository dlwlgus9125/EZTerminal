import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { AgentActivity, AgentState } from '../shared/agent';
import { isSafeAgentPromptText, MAX_AGENT_READ_LINES } from '../shared/agent-coordination';
import type {
  CreateWorkerInput,
  WorkerReportInput,
} from '../shared/agent-orchestration';
import {
  PROJECT_MAP_TYPES,
  projectMapAuthoringGuide,
  type ProjectMapType,
} from '../shared/project-map';
import type { AgentCoordinationService } from './agent-coordination-service';
import type { AgentOrchestrationService } from './agent-orchestration-service';
import { DaemonCliControl, type DaemonCliAuthority } from './daemon-cli-control';
import { findActiveDaemonWorkspace } from './daemon-workspace-authority';
import type { ManagedMergeService } from './managed-merge-service';
import type { ProjectMapService } from './project-map-service';
import { sameSecret } from './managed-merge-service';

const BODY_LIMIT_BYTES = 40 * 1024;
const REQUESTS_PER_MINUTE = 60;
const MAX_CONCURRENT_PER_SESSION = 4;
const MAX_WAIT_MS = 30 * 60_000;

interface Capability {
  readonly sessionId: string;
  readonly token: string;
  readonly issuedAt: number;
  projectId?: string;
  timestamps: number[];
  concurrent: number;
}

interface ActivityWorkspaceIdentity {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId: string;
}

type DaemonAuthorityState = 'active' | 'pending' | 'revoked';

const TERMINAL_DAEMON_SESSION_STATES = new Set(['completed', 'interrupted', 'failed', 'archived']);

function activityWorkspace(activity: AgentActivity): ActivityWorkspaceIdentity | null {
  const projectId = activity.participant?.projectId ?? activity.projectId;
  const rootId = activity.participant?.rootId ?? activity.rootId;
  const workspaceId = activity.participant?.workspaceId ?? activity.workspaceId;
  return projectId && rootId && workspaceId ? { projectId, rootId, workspaceId } : null;
}

function json(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
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
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;
  private readonly capabilities = new Map<string, Capability>();
  private readonly activeControllers = new Map<AbortController, Capability>();
  private readonly activeRequests = new Set<Promise<void>>();
  private readonly revokedProjectIds = new Set<string>();
  private readonly revokedSessionIds = new Set<string>();
  private readonly daemonControl?: DaemonCliControl;

  constructor(private readonly deps: {
    readonly coordination: AgentCoordinationService;
    readonly merges: ManagedMergeService;
    readonly maps?: ProjectMapService;
    readonly orchestration?: AgentOrchestrationService;
    readonly daemon?: DaemonCliAuthority;
  }) {
    this.daemonControl = deps.daemon ? new DaemonCliControl(deps.daemon) : undefined;
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Agent control server is stopped.'));
    if (this.startPromise) return this.startPromise;
    const starting = this.startOnce();
    this.startPromise = starting;
    void starting.catch(() => {
      if (!this.stopped && this.startPromise === starting) this.startPromise = null;
    });
    return starting;
  }

  private async startOnce(): Promise<void> {
    const server = http.createServer((request, response) => {
      this.dispatchRequest(request, response);
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
    if (this.stopped) {
      await this.closeServer(server);
      throw new Error('Agent control server stopped during startup.');
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      await this.closeServer(server);
      throw new Error('Agent control server has no loopback address.');
    }
    if (this.stopped) {
      await this.closeServer(server);
      throw new Error('Agent control server stopped during startup.');
    }
    this.server = server;
    this.origin = `http://127.0.0.1:${String(address.port)}`;
  }

  descriptorForSession(sessionId: string): string {
    if (!this.server || !this.origin) return '';
    const projectId = this.projectIdForSession(sessionId);
    const daemonAuthority = projectId
      ? this.daemonAuthorityState(sessionId, projectId)
      : 'pending';
    if (
      this.revokedSessionIds.has(sessionId)
      || (projectId && this.revokedProjectIds.has(projectId))
      || daemonAuthority === 'revoked'
    ) {
      this.denySession(sessionId);
      return '';
    }
    const existing = this.capabilities.get(sessionId);
    if (existing) {
      if (existing.projectId && projectId && existing.projectId !== projectId) {
        this.denySession(sessionId);
        return '';
      }
      if (!existing.projectId && projectId) existing.projectId = projectId;
      return JSON.stringify({ version: 1, origin: this.origin, token: existing.token });
    }
    const token = randomBytes(32).toString('base64url');
    this.capabilities.set(sessionId, {
      sessionId,
      token,
      issuedAt: Date.now(),
      ...(projectId ? { projectId } : {}),
      timestamps: [],
      concurrent: 0,
    });
    return JSON.stringify({ version: 1, origin: this.origin, token });
  }

  revokeSession(sessionId: string): void {
    this.denySession(sessionId);
  }

  revokeProject(projectId: string): void {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 128) return;
    this.revokedProjectIds.add(projectId);
    const sessionIds = new Set<string>();
    for (const activity of this.deps.coordination.getSnapshot().activities) {
      if (activityWorkspace(activity)?.projectId === projectId) sessionIds.add(activity.sessionId);
    }
    for (const session of this.deps.daemon?.getSnapshot().sessions ?? []) {
      if (session.projectId === projectId) sessionIds.add(session.id);
    }
    for (const capability of this.capabilities.values()) {
      if (capability.projectId === projectId || this.projectIdForSession(capability.sessionId) === projectId) {
        sessionIds.add(capability.sessionId);
      }
    }
    for (const sessionId of sessionIds) this.denySession(sessionId);
  }

  restoreProject(projectId: string): void {
    this.revokedProjectIds.delete(projectId);
  }

  revokeAll(): void {
    this.capabilities.clear();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    const server = this.server;
    this.server = null;
    this.origin = '';
    this.revokeAll();
    for (const controller of this.activeControllers.keys()) controller.abort();
    const starting = this.startPromise;
    this.stopPromise = (async () => {
      await Promise.allSettled([
        starting ?? Promise.resolve(),
        this.closeServer(server),
      ]);
      while (this.activeRequests.size > 0) {
        await Promise.allSettled([...this.activeRequests]);
      }
      this.activeControllers.clear();
      this.revokedProjectIds.clear();
      this.revokedSessionIds.clear();
    })();
    return this.stopPromise;
  }

  private closeServer(server: http.Server | null): Promise<void> {
    if (!server || !server.listening) {
      server?.closeAllConnections();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private dispatchRequest(request: IncomingMessage, response: ServerResponse): void {
    if (this.stopped) {
      json(response, 503, { ok: false, error: 'shutting-down' });
      return;
    }
    const handling = this.handle(request, response).catch(() => {
      json(response, 500, { ok: false, error: 'internal-error' });
    });
    this.activeRequests.add(handling);
    void handling.then(
      () => this.activeRequests.delete(handling),
      () => this.activeRequests.delete(handling),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.stopped) {
      json(response, 503, { ok: false, error: 'shutting-down' });
      return;
    }
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
    let controller: AbortController | null = null;
    try {
      const requestController = new AbortController();
      controller = requestController;
      this.activeControllers.set(requestController, capability);
      response.once('close', () => {
        if (!response.writableEnded) requestController.abort();
      });
      const daemonRoute = request.url.startsWith('/v1/daemon/');
      let source = daemonRoute ? null : this.sourceActivity(capability.sessionId);
      if (!daemonRoute) {
        if (!source) {
          json(response, 403, { ok: false, error: 'collaboration-inactive' });
          return;
        }
        if (!this.bindCapabilityProject(capability, source)) {
          json(response, 403, { ok: false, error: 'capability-expired' });
          return;
        }
        if (this.deps.orchestration?.isWorkerSession(source.sessionId)
          && request.url !== '/v1/worker/report') {
          json(response, 403, { ok: false, error: 'worker-depth-limit' });
          return;
        }
        const orchestrationRoute = request.url.startsWith('/v1/workers/')
          || request.url === '/v1/workers'
          || request.url === '/v1/worker/report';
        if (!source.participant
          && request.url !== '/v1/map/guide'
          && request.url !== '/v1/map/check'
          && !orchestrationRoute) {
          json(response, 403, { ok: false, error: 'collaboration-inactive' });
          return;
        }
      }
      const body = await this.readBody(request, requestController.signal);
      if (this.stopped || requestController.signal.aborted) {
        json(response, 503, { ok: false, error: 'shutting-down' });
        return;
      }
      if (body === null) {
        json(response, 400, { ok: false, error: 'invalid-json' });
        return;
      }
      if (!daemonRoute) {
        source = this.sourceActivity(capability.sessionId);
        if (!source || !this.bindCapabilityProject(capability, source)) {
          json(response, 403, { ok: false, error: 'capability-expired' });
          return;
        }
      }
      if (daemonRoute) {
        await this.routeDaemon(request.url, body, capability.sessionId, response);
      } else {
        await this.route(request.url, body, source!, capability, response, requestController.signal);
      }
    } finally {
      if (controller) this.activeControllers.delete(controller);
      capability.concurrent = Math.max(0, capability.concurrent - 1);
    }
  }

  private async route(
    url: string,
    body: Record<string, unknown>,
    source: AgentActivity,
    capability: Capability,
    response: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    if (url === '/v1/workers/profiles') {
      const result = this.deps.orchestration?.listProfiles(source)
        ?? { ok: false as const, error: 'unavailable' as const, message: 'Lead orchestration is unavailable.' };
      json(response, result.ok ? 200 : result.error === 'forbidden' ? 403 : 409, result);
      return;
    }
    if (url === '/v1/workers/create') {
      if (!this.deps.orchestration) {
        json(response, 503, { ok: false, error: 'unavailable' });
        return;
      }
      const result = await this.deps.orchestration.createWorker(source, body as unknown as CreateWorkerInput);
      json(response, result.ok ? 200 : this.orchestrationStatus(result.error), result);
      return;
    }
    if (url === '/v1/workers') {
      const result = this.deps.orchestration?.listWorkers(source)
        ?? { ok: false as const, error: 'unavailable' as const, message: 'Lead orchestration is unavailable.' };
      json(response, result.ok ? 200 : this.orchestrationStatus(result.error), result);
      return;
    }
    if (url === '/v1/workers/read') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const result = taskId && this.deps.orchestration
        ? this.deps.orchestration.readWorker(source, taskId)
        : { ok: false as const, error: 'invalid' as const, message: 'A task id is required.' };
      json(response, result.ok ? 200 : this.orchestrationStatus(result.error), result);
      return;
    }
    if (url === '/v1/workers/prompt') {
      const result = this.deps.orchestration
        ? await this.deps.orchestration.promptWorker(source, {
            taskId: typeof body.taskId === 'string' ? body.taskId : '',
            text: typeof body.text === 'string' ? body.text : '',
          })
        : { ok: false as const, error: 'unavailable' as const, message: 'Lead orchestration is unavailable.' };
      json(response, result.ok ? 200 : this.orchestrationStatus(result.error), result);
      return;
    }
    if (url === '/v1/workers/cancel' || url === '/v1/workers/archive') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const result = !taskId || !this.deps.orchestration
        ? { ok: false as const, error: 'invalid' as const, message: 'A task id is required.' }
        : url.endsWith('/cancel')
          ? await this.deps.orchestration.cancelWorker(source, taskId)
          : await this.deps.orchestration.archiveWorker(source, taskId);
      json(response, result.ok ? 200 : this.orchestrationStatus(result.error), result);
      return;
    }
    if (url === '/v1/workers/merge') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const targetBranch = typeof body.targetBranch === 'string' ? body.targetBranch : '';
      const result = taskId && targetBranch && this.deps.orchestration
        ? await this.deps.orchestration.requestWorkerMerge(source, taskId, targetBranch)
        : { ok: false as const, error: 'invalid' as const, message: 'Task and target branch are required.' };
      json(response, result.ok ? 200 : this.orchestrationStatus(result.error), result);
      return;
    }
    if (url === '/v1/workers/complete') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      const result = runId && this.deps.orchestration
        ? await this.deps.orchestration.completeRun(source, runId)
        : { ok: false as const, error: 'invalid' as const, message: 'A run id is required.' };
      json(response, result.ok ? 200 : this.orchestrationStatus(result.error), result);
      return;
    }
    if (url === '/v1/worker/report') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const result = taskId && this.deps.orchestration
        ? await this.deps.orchestration.reportWorker(source, taskId, body as unknown as WorkerReportInput)
        : { ok: false as const, error: 'invalid' as const, message: 'A task id is required.' };
      json(response, result.ok ? 200 : this.orchestrationStatus(result.error), result);
      return;
    }
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
      let activity = this.resolveProjectActivity(source, target);
      if (!activity) {
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
      if (!this.hasActiveDaemonAuthority(activity)) {
        json(response, 404, { ok: false, error: 'not-found' });
        return;
      }
      if (!this.bindCapabilityProject(capability, source)) {
        json(response, 403, { ok: false, error: 'capability-expired' });
        return;
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
      const liveActivity = activity && this.hasActiveDaemonAuthority(activity) ? activity : null;
      json(response, liveActivity ? 200 : 504, { ok: Boolean(liveActivity), activity: liveActivity });
      return;
    }
    if (url === '/v1/map/guide') {
      const type = typeof body.type === 'string' && (PROJECT_MAP_TYPES as readonly string[]).includes(body.type)
        ? body.type as ProjectMapType
        : undefined;
      if (!type) {
        json(response, 400, { ok: false, error: 'invalid-map-type', allowed: PROJECT_MAP_TYPES });
        return;
      }
      json(response, 200, { ok: true, guide: projectMapAuthoringGuide(type) });
      return;
    }
    if (url === '/v1/map/check') {
      const workspace = activityWorkspace(source);
      if (!this.deps.maps || !workspace) {
        json(response, 503, { ok: false, error: 'project-map-unavailable' });
        return;
      }
      const mapId = body.mapId === undefined
        ? undefined
        : typeof body.mapId === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(body.mapId)
          ? body.mapId
          : null;
      if (mapId === null) {
        json(response, 400, { ok: false, error: 'invalid-map-id' });
        return;
      }
      const quality = body.quality === undefined
        ? 'production'
        : body.quality === 'draft' || body.quality === 'production'
          ? body.quality
          : null;
      if (!quality) {
        json(response, 400, { ok: false, error: 'invalid-quality-profile' });
        return;
      }
      const result = await this.deps.maps.read({
        projectId: workspace.projectId,
        ownerRootId: workspace.rootId,
        ownerWorkspaceId: workspace.workspaceId,
        ...(mapId ? { mapId } : {}),
        quality,
      });
      if (!result.ok) {
        json(response, 409, {
          ok: false,
          error: result.error,
          state: result.state,
          diagnostics: result.diagnostics,
          lastGood: result.lastGood ? {
            mapId: result.lastGood.mapId,
            verifiedAt: result.lastGood.verification.verifiedAt,
          } : undefined,
        });
        return;
      }
      json(response, result.map.state === 'stale' ? 409 : 200, {
        ok: result.map.state === 'valid',
        state: result.map.state,
        mapId: result.map.mapId,
        type: result.map.spec.type,
        verification: result.map.verification,
        provenance: result.map.provenance,
      });
      return;
    }
    if (url === '/v1/map/job') {
      if (!this.deps.maps) {
        json(response, 503, { ok: false, error: 'project-map-unavailable' });
        return;
      }
      const jobId = typeof body.jobId === 'string' && /^[a-f0-9-]{20,64}$/u.test(body.jobId)
        ? body.jobId
        : undefined;
      const phases = [
        'analyzing', 'authoring', 'validating-draft', 'validating-production',
        'awaiting-review', 'completed', 'failed', 'canceled',
      ] as const;
      const phase = typeof body.phase === 'string' && (phases as readonly string[]).includes(body.phase)
        ? body.phase as (typeof phases)[number]
        : undefined;
      const message = body.message === undefined
        ? undefined
        : typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 512
          ? body.message
          : null;
      if (!jobId || !phase || message === null) {
        json(response, 400, { ok: false, error: 'invalid-job-update' });
        return;
      }
      const job = await this.deps.maps.reportJob(jobId, source.id, phase, message);
      json(response, job ? 200 : 409, job ? { ok: true, job } : { ok: false, error: 'job-update-rejected' });
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

  private async routeDaemon(
    url: string,
    body: Record<string, unknown>,
    sourceSessionId: string,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.daemonControl) {
      json(response, 503, { ok: false, error: 'daemon-unavailable', message: 'The local daemon control surface is unavailable.' });
      return;
    }
    const result = await this.daemonControl.handle(url, body, { sessionId: sourceSessionId });
    json(response, result?.status ?? 404, result?.body ?? { ok: false, error: 'not-found' });
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

  private orchestrationStatus(error: string): number {
    if (error === 'invalid') return 400;
    if (error === 'forbidden') return 403;
    if (error === 'not-found') return 404;
    if (error === 'unavailable') return 503;
    return 409;
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
      activity.live && activity.sessionId === sessionId && activityWorkspace(activity)
    ));
    return matches.length === 1 ? matches[0]! : null;
  }

  private projectIdForSession(sessionId: string): string | undefined {
    const daemonProjectId = this.deps.daemon?.getSnapshot().sessions
      .find((session) => session.id === sessionId)?.projectId;
    if (daemonProjectId) return daemonProjectId;
    const source = this.sourceActivity(sessionId);
    return source ? activityWorkspace(source)?.projectId : undefined;
  }

  private bindCapabilityProject(capability: Capability, source: AgentActivity): boolean {
    const projectId = activityWorkspace(source)?.projectId;
    if (
      !projectId
      || this.revokedSessionIds.has(capability.sessionId)
      || this.revokedProjectIds.has(projectId)
      || (capability.projectId !== undefined && capability.projectId !== projectId)
    ) {
      this.denySession(capability.sessionId);
      return false;
    }
    const daemonAuthority = this.daemonAuthorityState(capability.sessionId, projectId);
    if (daemonAuthority !== 'active') {
      if (daemonAuthority === 'revoked') this.denySession(capability.sessionId);
      return false;
    }
    capability.projectId = projectId;
    return true;
  }

  private daemonAuthorityState(sessionId: string, projectId: string): DaemonAuthorityState {
    const daemon = this.deps.daemon;
    if (!daemon) return 'pending';
    const snapshot = daemon.getSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) return 'pending';
    if (project.archivedAt !== undefined) return 'revoked';
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return 'pending';
    if (session.projectId !== projectId || TERMINAL_DAEMON_SESSION_STATES.has(session.state)) {
      return 'revoked';
    }
    const workspace = snapshot.workspaces.find((candidate) => candidate.id === session.workspaceId);
    if (!workspace) return 'pending';
    if (workspace.projectId !== projectId || workspace.archivedAt !== undefined) return 'revoked';
    return findActiveDaemonWorkspace(snapshot, session.workspaceId, projectId) ? 'active' : 'revoked';
  }

  private hasActiveDaemonAuthority(activity: AgentActivity): boolean {
    const identity = activityWorkspace(activity);
    return identity !== null
      && this.daemonAuthorityState(activity.sessionId, identity.projectId) === 'active';
  }

  private denySession(sessionId: string): void {
    this.revokedSessionIds.add(sessionId);
    const capability = this.capabilities.get(sessionId);
    this.capabilities.delete(sessionId);
    if (!capability) return;
    for (const [controller, activeCapability] of this.activeControllers) {
      if (activeCapability === capability) controller.abort();
    }
  }

  private sameProject(source: AgentActivity, target: AgentActivity): boolean {
    return source.participant !== undefined
      && target.participant !== undefined
      && source.participant.projectId === target.participant.projectId;
  }

  private resolveProjectActivity(source: AgentActivity, target: string): AgentActivity | null {
    const activity = this.deps.coordination.resolveActivity(target);
    return activity && this.sameProject(source, activity) && this.hasActiveDaemonAuthority(activity)
      ? activity
      : null;
  }

  private readBody(request: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let rejected = false;
      let settled = false;
      const finish = (value: Record<string, unknown> | null): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('aborted', onAbort);
        request.off('error', onAbort);
        request.off('close', onClose);
        resolve(value);
      };
      const onData = (chunk: Buffer): void => {
        if (rejected) return;
        bytes += chunk.byteLength;
        if (bytes > BODY_LIMIT_BYTES) {
          rejected = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        if (rejected) {
          finish(null);
          return;
        }
        if (bytes === 0) {
          finish({});
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          finish(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null);
        } catch {
          finish(null);
        }
      };
      const onAbort = (): void => finish(null);
      const onClose = (): void => {
        if (!request.complete) finish(null);
      };
      request.on('data', onData);
      request.once('end', onEnd);
      request.once('aborted', onAbort);
      request.once('error', onAbort);
      request.once('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}

export function descriptorFingerprint(descriptor: string): string {
  return createHash('sha256').update(descriptor).digest('hex').slice(0, 12);
}
