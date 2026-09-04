import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandPayloads,
  type DaemonCommandReceipt,
  type DaemonCommandType,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
  type PermissionPreset,
} from '../shared/daemon-protocol';

const DAEMON_CLI_PREFIX = '/v1/daemon/';
const MAX_REVISION_RETRIES = 3;
const MAX_TRANSCRIPT_PAGE_SIZE = 500;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const PERMISSION_PRESETS = new Set<PermissionPreset>(['plan', 'standard', 'full-access']);

export interface DaemonCliAuthority {
  getSnapshot(): DaemonSnapshot;
  execute(command: unknown): Promise<DaemonCommandReceipt>;
  readTranscript?(
    sessionId: string,
    afterSequence?: number,
    limit?: number,
  ): readonly DaemonTranscriptItem[];
}

export interface DaemonCliSource {
  readonly sessionId: string;
  /** Optional cross-check supplied by a richer authenticated transport. */
  readonly projectId?: string;
}

export interface DaemonCliResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

interface DaemonProjectScope {
  readonly projectId: string;
  readonly snapshot: DaemonSnapshot;
  readonly workspaceIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
}

type ScopedTarget<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: DaemonCliResponse };

function response(status: number, body: Readonly<Record<string, unknown>>): DaemonCliResponse {
  return { status, body };
}

function errorResponse(status: number, error: string, message: string): DaemonCliResponse {
  return response(status, { ok: false, error, message });
}

function hasOnlyKeys(body: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(body).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function optionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function optionalIsoTimestamp(value: unknown): value is string | undefined {
  return value === undefined || (isNonEmptyString(value) && Number.isFinite(Date.parse(value)));
}

function commandStatus(receipt: DaemonCommandReceipt): number {
  if (receipt.ok) return 200;
  switch (receipt.error.code) {
    case 'invalid-command':
      return 400;
    case 'unauthorized':
      return 403;
    case 'not-found':
      return 404;
    case 'provider-unavailable':
    case 'provider-incompatible':
      return 503;
    case 'internal-error':
      return 500;
    default:
      return 409;
  }
}

/**
 * Project-scoped local CLI adapter over the same daemon command authority used
 * by Desktop, Android, and MCP. The loopback server authenticates the caller;
 * this module owns target scoping, v12 envelope construction, and bounded
 * optimistic-revision retries.
 */
export class DaemonCliControl {
  constructor(
    private readonly authority: DaemonCliAuthority,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async handle(
    route: string,
    body: Readonly<Record<string, unknown>>,
    source: DaemonCliSource,
  ): Promise<DaemonCliResponse | null> {
    if (!route.startsWith(DAEMON_CLI_PREFIX)) return null;
    const scope = this.projectScope(source);
    if (!scope.ok) return scope.response;

    switch (route) {
      case '/v1/daemon/status':
        return this.status(scope.value, source.sessionId);
      case '/v1/daemon/snapshot':
        return response(200, {
          ok: true,
          projectId: scope.value.projectId,
          sourceSessionId: source.sessionId,
          snapshot: this.scopedSnapshot(scope.value),
        });
      case '/v1/daemon/sessions':
        return response(200, {
          ok: true,
          protocolVersion: scope.value.snapshot.protocolVersion,
          revision: scope.value.snapshot.revision,
          items: scope.value.snapshot.sessions.filter((session) => scope.value.sessionIds.has(session.id)),
        });
      case '/v1/daemon/agents':
        return response(200, {
          ok: true,
          protocolVersion: scope.value.snapshot.protocolVersion,
          revision: scope.value.snapshot.revision,
          items: scope.value.snapshot.agents
            .filter((agent) => scope.value.sessionIds.has(agent.sessionId))
            .map((agent) => ({
              session: scope.value.snapshot.sessions.find((session) => session.id === agent.sessionId),
              agent,
            })),
        });
      case '/v1/daemon/agents/read':
        return this.readAgent(scope.value, body);
      case '/v1/daemon/schedules':
        return response(200, {
          ok: true,
          protocolVersion: scope.value.snapshot.protocolVersion,
          revision: scope.value.snapshot.revision,
          items: scope.value.snapshot.schedules
            .filter((schedule) => scope.value.workspaceIds.has(schedule.workspaceId))
            .map((schedule) => ({
              workspace: scope.value.snapshot.workspaces.find((workspace) => workspace.id === schedule.workspaceId),
              schedule,
            })),
        });
      case '/v1/daemon/agents/send':
        return this.send(scope.value, body, source.sessionId);
      case '/v1/daemon/agents/interrupt-and-send':
        return this.interruptAndSend(scope.value, body, source.sessionId);
      case '/v1/daemon/agents/interrupt':
        return this.agentSessionCommand(scope.value, body, source.sessionId, 'agent.interrupt');
      case '/v1/daemon/agents/cancel':
        return this.agentSessionCommand(scope.value, body, source.sessionId, 'agent.cancel');
      case '/v1/daemon/agents/archive':
        return this.agentSessionCommand(scope.value, body, source.sessionId, 'agent.archive');
      case '/v1/daemon/agents/detach':
        return this.agentSessionCommand(scope.value, body, source.sessionId, 'agent.detach');
      case '/v1/daemon/agents/settings':
        return this.setAgentSettings(scope.value, body, source.sessionId);
      case '/v1/daemon/schedules/create':
        return this.createSchedule(scope.value, body, source.sessionId);
      case '/v1/daemon/schedules/update':
        return this.updateSchedule(scope.value, body, source.sessionId);
      case '/v1/daemon/schedules/delete':
        return this.scheduleCommand(scope.value, body, source.sessionId, 'schedule.delete');
      case '/v1/daemon/schedules/run':
        return this.scheduleCommand(scope.value, body, source.sessionId, 'schedule.run-now');
      case '/v1/daemon/heartbeats/configure':
        return this.configureHeartbeat(scope.value, body, source.sessionId);
      case '/v1/daemon/heartbeats/trigger':
        return this.triggerHeartbeat(scope.value, body, source.sessionId);
      default:
        return errorResponse(404, 'not-found', 'Unknown daemon CLI route.');
    }
  }

  private projectScope(source: DaemonCliSource): ScopedTarget<DaemonProjectScope> {
    const snapshot = this.authority.getSnapshot();
    const sourceSession = snapshot.sessions.find((session) => session.id === source.sessionId);
    if (sourceSession && source.projectId && sourceSession.projectId !== source.projectId) {
      return {
        ok: false,
        response: errorResponse(403, 'unauthorized', 'The local capability no longer matches its Project.'),
      };
    }
    if (!sourceSession) {
      return {
        ok: false,
        response: errorResponse(409, 'scope-unavailable', 'The local Session is not registered with the daemon yet.'),
      };
    }
    if (['completed', 'interrupted', 'failed', 'archived'].includes(sourceSession.state)) {
      return {
        ok: false,
        response: errorResponse(403, 'capability-expired', 'The local Session capability is no longer active.'),
      };
    }
    const projectId = sourceSession.projectId;
    if (!snapshot.projects.some((project) => project.id === projectId)) {
      return {
        ok: false,
        response: errorResponse(409, 'scope-unavailable', 'The local Project is not registered with the daemon yet.'),
      };
    }
    const workspaceIds = new Set(
      snapshot.workspaces.filter((workspace) => workspace.projectId === projectId).map((workspace) => workspace.id),
    );
    const sessionIds = new Set(
      snapshot.sessions.filter((session) => session.projectId === projectId).map((session) => session.id),
    );
    return { ok: true, value: { projectId, snapshot, workspaceIds, sessionIds } };
  }

  private status(scope: DaemonProjectScope, sourceSessionId: string): DaemonCliResponse {
    const snapshot = scope.snapshot;
    const sessions = snapshot.sessions.filter((session) => scope.sessionIds.has(session.id));
    const agents = snapshot.agents.filter((agent) => scope.sessionIds.has(agent.sessionId));
    const schedules = snapshot.schedules.filter((schedule) => scope.workspaceIds.has(schedule.workspaceId));
    return response(200, {
      ok: true,
      protocolVersion: snapshot.protocolVersion,
      revision: snapshot.revision,
      eventSequence: snapshot.eventSequence,
      generatedAt: snapshot.generatedAt,
      projectId: scope.projectId,
      sourceSessionId,
      runtime: snapshot.runtime,
      counts: {
        workspaces: scope.workspaceIds.size,
        sessions: sessions.length,
        activeAgents: agents.filter((agent) => !['done', 'interrupted', 'error', 'archived'].includes(agent.state)).length,
        schedules: schedules.length,
        enabledSchedules: schedules.filter((schedule) => schedule.enabled).length,
      },
    });
  }

  private scopedSnapshot(scope: DaemonProjectScope): DaemonSnapshot {
    const snapshot = scope.snapshot;
    const providerIds = new Set([
      ...snapshot.agents.filter((agent) => scope.sessionIds.has(agent.sessionId)).map((agent) => agent.providerId),
      ...snapshot.schedules.filter((schedule) => scope.workspaceIds.has(schedule.workspaceId)).map((schedule) => schedule.providerId),
    ]);
    return {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id === scope.projectId),
      workspaces: snapshot.workspaces.filter((workspace) => scope.workspaceIds.has(workspace.id)),
      sessions: snapshot.sessions.filter((session) => scope.sessionIds.has(session.id)),
      agents: snapshot.agents.filter((agent) => scope.sessionIds.has(agent.sessionId)),
      agentRelations: snapshot.agentRelations.filter((relation) => (
        scope.sessionIds.has(relation.parentSessionId) && scope.sessionIds.has(relation.childSessionId)
      )),
      turns: snapshot.turns.filter((turn) => scope.sessionIds.has(turn.sessionId)),
      transcriptHeads: snapshot.transcriptHeads.filter((head) => scope.sessionIds.has(head.sessionId)),
      approvals: snapshot.approvals.filter((approval) => scope.sessionIds.has(approval.sessionId)),
      providers: snapshot.providers.filter((provider) => providerIds.has(provider.id)),
      schedules: snapshot.schedules.filter((schedule) => scope.workspaceIds.has(schedule.workspaceId)),
      heartbeats: snapshot.heartbeats.filter((heartbeat) => scope.sessionIds.has(heartbeat.sessionId)),
    };
  }

  private async send(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
  ): Promise<DaemonCliResponse> {
    if (!hasOnlyKeys(body, new Set(['target', 'prompt', 'requestId']))) {
      return errorResponse(400, 'invalid-request', 'The Agent send request contains unsupported fields.');
    }
    const target = this.resolveAgent(scope, body.target);
    if (!target.ok) return target.response;
    if (!isNonEmptyString(body.prompt)) {
      return errorResponse(400, 'invalid-request', 'Prompt text is required.');
    }
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, 'agent.submit', {
      sessionId: target.value.session.id,
      prompt: body.prompt,
    });
  }

  private async interruptAndSend(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
  ): Promise<DaemonCliResponse> {
    if (!hasOnlyKeys(body, new Set(['target', 'prompt', 'requestId']))) {
      return errorResponse(400, 'invalid-request', 'The Agent interrupt-and-send request contains unsupported fields.');
    }
    const target = this.resolveAgent(scope, body.target);
    if (!target.ok) return target.response;
    if (!isNonEmptyString(body.prompt)) {
      return errorResponse(400, 'invalid-request', 'Prompt text is required.');
    }
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, 'agent.interrupt-and-submit', {
      sessionId: target.value.session.id,
      prompt: body.prompt,
    });
  }

  private readAgent(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
  ): DaemonCliResponse {
    if (!hasOnlyKeys(body, new Set(['target', 'afterSequence', 'limit']))) {
      return errorResponse(400, 'invalid-request', 'The Agent read request contains unsupported fields.');
    }
    const target = this.resolveAgent(scope, body.target);
    if (!target.ok) return target.response;
    const afterSequence = body.afterSequence ?? 0;
    const limit = body.limit ?? 100;
    if (typeof afterSequence !== 'number' || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return errorResponse(400, 'invalid-request', 'afterSequence must be a non-negative safe integer.');
    }
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_PAGE_SIZE) {
      return errorResponse(400, 'invalid-request', `limit must be between 1 and ${String(MAX_TRANSCRIPT_PAGE_SIZE)}.`);
    }
    if (!this.authority.readTranscript) {
      return errorResponse(503, 'unavailable', 'The daemon transcript reader is unavailable.');
    }
    try {
      const sessionId = target.value.session.id;
      return response(200, {
        ok: true,
        protocolVersion: scope.snapshot.protocolVersion,
        revision: scope.snapshot.revision,
        session: target.value.session,
        agent: target.value.agent,
        relation: scope.snapshot.agentRelations.find((relation) => relation.childSessionId === sessionId),
        children: scope.snapshot.agentRelations.filter((relation) => relation.parentSessionId === sessionId),
        turns: scope.snapshot.turns.filter((turn) => turn.sessionId === sessionId),
        transcriptHead: scope.snapshot.transcriptHeads.find((head) => head.sessionId === sessionId),
        heartbeat: scope.snapshot.heartbeats.find((heartbeat) => heartbeat.sessionId === sessionId),
        transcript: this.authority.readTranscript(sessionId, afterSequence, limit),
      });
    } catch {
      return errorResponse(500, 'internal-error', 'The Agent transcript could not be read.');
    }
  }

  private async agentSessionCommand(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
    type: 'agent.interrupt' | 'agent.cancel' | 'agent.archive' | 'agent.detach',
  ): Promise<DaemonCliResponse> {
    if (!hasOnlyKeys(body, new Set(['target', 'requestId']))) {
      return errorResponse(400, 'invalid-request', 'The Agent lifecycle request contains unsupported fields.');
    }
    const target = this.resolveAgent(scope, body.target);
    if (!target.ok) return target.response;
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, type, { sessionId: target.value.session.id });
  }

  private async setAgentSettings(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
  ): Promise<DaemonCliResponse> {
    if (!hasOnlyKeys(body, new Set(['target', 'model', 'permissionPreset', 'requestId']))) {
      return errorResponse(400, 'invalid-request', 'The Agent settings request contains unsupported fields.');
    }
    const target = this.resolveAgent(scope, body.target);
    if (!target.ok) return target.response;
    if (!optionalNonEmptyString(body.model)) {
      return errorResponse(400, 'invalid-request', 'model must be a non-empty string when provided.');
    }
    if (body.permissionPreset !== undefined && !PERMISSION_PRESETS.has(body.permissionPreset as PermissionPreset)) {
      return errorResponse(400, 'invalid-request', 'permissionPreset must be plan, standard, or full-access.');
    }
    if (body.model === undefined && body.permissionPreset === undefined) {
      return errorResponse(400, 'invalid-request', 'At least one Agent setting is required.');
    }
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, 'agent.set-settings', {
      sessionId: target.value.session.id,
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.permissionPreset !== undefined
        ? { permissionPreset: body.permissionPreset as PermissionPreset }
        : {}),
    });
  }

  private async createSchedule(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
  ): Promise<DaemonCliResponse> {
    const allowed = new Set([
      'scheduleId', 'name', 'workspace', 'workspaceId', 'providerId', 'model', 'permissionPreset',
      'prompt', 'cron', 'timezone', 'maxRuns', 'expiresAt', 'enabled', 'requestId',
    ]);
    if (!hasOnlyKeys(body, allowed)) {
      return errorResponse(400, 'invalid-request', 'The Schedule create request contains unsupported fields.');
    }
    if (body.workspace !== undefined && body.workspaceId !== undefined) {
      return errorResponse(400, 'invalid-request', 'Use either workspace or workspaceId, not both.');
    }
    const workspace = this.resolveWorkspace(scope, body.workspace ?? body.workspaceId);
    if (!workspace.ok) return workspace.response;
    const requiredStrings = [body.scheduleId, body.name, body.providerId, body.prompt, body.cron, body.timezone];
    if (!requiredStrings.every(isNonEmptyString)) {
      return errorResponse(400, 'invalid-request', 'Schedule id, name, provider, prompt, cron, and timezone are required.');
    }
    if (!optionalNonEmptyString(body.model)
      || !optionalPositiveInteger(body.maxRuns)
      || !optionalIsoTimestamp(body.expiresAt)
      || typeof body.enabled !== 'boolean'
      || !PERMISSION_PRESETS.has(body.permissionPreset as PermissionPreset)) {
      return errorResponse(400, 'invalid-request', 'The Schedule configuration is invalid.');
    }
    const provider = scope.snapshot.providers.find((entry) => entry.id === body.providerId);
    if (!provider) return errorResponse(404, 'not-found', 'Provider was not found.');
    if (!provider.enabled) return errorResponse(409, 'invalid-state', 'Provider is disabled.');
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, 'schedule.create', {
      scheduleId: body.scheduleId as string,
      name: body.name as string,
      workspaceId: workspace.value.id,
      providerId: body.providerId as string,
      ...(body.model !== undefined ? { model: body.model } : {}),
      permissionPreset: body.permissionPreset as PermissionPreset,
      prompt: body.prompt as string,
      cron: body.cron as string,
      timezone: body.timezone as string,
      ...(body.maxRuns !== undefined ? { maxRuns: body.maxRuns } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      enabled: body.enabled,
    });
  }

  private async updateSchedule(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
  ): Promise<DaemonCliResponse> {
    const allowed = new Set([
      'target', 'name', 'prompt', 'cron', 'timezone', 'maxRuns', 'expiresAt', 'enabled', 'requestId',
    ]);
    if (!hasOnlyKeys(body, allowed)) {
      return errorResponse(400, 'invalid-request', 'The Schedule update request contains unsupported fields.');
    }
    const target = this.resolveSchedule(scope, body.target);
    if (!target.ok) return target.response;
    if (!optionalNonEmptyString(body.name)
      || !optionalNonEmptyString(body.prompt)
      || !optionalNonEmptyString(body.cron)
      || !optionalNonEmptyString(body.timezone)
      || !optionalPositiveInteger(body.maxRuns)
      || !optionalIsoTimestamp(body.expiresAt)
      || (body.enabled !== undefined && typeof body.enabled !== 'boolean')) {
      return errorResponse(400, 'invalid-request', 'The Schedule update is invalid.');
    }
    const fields = ['name', 'prompt', 'cron', 'timezone', 'maxRuns', 'expiresAt', 'enabled'] as const;
    if (!fields.some((field) => body[field] !== undefined)) {
      return errorResponse(400, 'invalid-request', 'At least one Schedule update is required.');
    }
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, 'schedule.update', {
      scheduleId: target.value.id,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.cron !== undefined ? { cron: body.cron } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.maxRuns !== undefined ? { maxRuns: body.maxRuns } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    });
  }

  private async scheduleCommand(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
    type: 'schedule.delete' | 'schedule.run-now',
  ): Promise<DaemonCliResponse> {
    if (!hasOnlyKeys(body, new Set(['target', 'requestId']))) {
      return errorResponse(400, 'invalid-request', 'The Schedule lifecycle request contains unsupported fields.');
    }
    const target = this.resolveSchedule(scope, body.target);
    if (!target.ok) return target.response;
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, type, { scheduleId: target.value.id });
  }

  private async configureHeartbeat(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
  ): Promise<DaemonCliResponse> {
    if (!hasOnlyKeys(body, new Set(['target', 'prompt', 'cron', 'timezone', 'enabled', 'requestId']))) {
      return errorResponse(400, 'invalid-request', 'The heartbeat configure request contains unsupported fields.');
    }
    const target = this.resolveAgent(scope, body.target);
    if (!target.ok) return target.response;
    if (!isNonEmptyString(body.prompt)
      || !isNonEmptyString(body.cron)
      || !isNonEmptyString(body.timezone)
      || typeof body.enabled !== 'boolean') {
      return errorResponse(400, 'invalid-request', 'Heartbeat prompt, cron, timezone, and enabled are required.');
    }
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, 'heartbeat.configure', {
      sessionId: target.value.session.id,
      prompt: body.prompt,
      cron: body.cron,
      timezone: body.timezone,
      enabled: body.enabled,
    });
  }

  private async triggerHeartbeat(
    scope: DaemonProjectScope,
    body: Readonly<Record<string, unknown>>,
    sourceSessionId: string,
  ): Promise<DaemonCliResponse> {
    if (!hasOnlyKeys(body, new Set(['target', 'requestId']))) {
      return errorResponse(400, 'invalid-request', 'The heartbeat trigger request contains unsupported fields.');
    }
    const target = this.resolveAgent(scope, body.target);
    if (!target.ok) return target.response;
    if (!scope.snapshot.heartbeats.some((heartbeat) => heartbeat.sessionId === target.value.session.id)) {
      return errorResponse(404, 'not-found', 'The target Agent has no configured heartbeat.');
    }
    const requestId = this.requestId(body.requestId);
    if (!requestId.ok) return requestId.response;
    return this.execute(sourceSessionId, requestId.value, 'heartbeat.trigger', { sessionId: target.value.session.id });
  }

  private resolveAgent(
    scope: DaemonProjectScope,
    value: unknown,
  ): ScopedTarget<{
      readonly session: DaemonSnapshot['sessions'][number];
      readonly agent: DaemonSnapshot['agents'][number];
    }> {
    const session = this.resolveSession(scope, value);
    if (!session.ok) return session;
    const agent = scope.snapshot.agents.find((entry) => entry.sessionId === session.value.id);
    if (session.value.kind !== 'agent' || !agent) {
      return { ok: false, response: errorResponse(409, 'invalid-state', 'The target is not a structured Agent session.') };
    }
    return { ok: true, value: { session: session.value, agent } };
  }

  private resolveSession(
    scope: DaemonProjectScope,
    value: unknown,
  ): ScopedTarget<DaemonSnapshot['sessions'][number]> {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, response: errorResponse(400, 'invalid-request', 'A Session id or unique title is required.') };
    }
    const target = value.trim();
    const sessions = scope.snapshot.sessions.filter((session) => scope.sessionIds.has(session.id));
    const exact = sessions.find((session) => session.id === target);
    if (exact) return { ok: true, value: exact };
    const titleMatches = sessions.filter((session) => session.title.toLocaleLowerCase('en-US') === target.toLocaleLowerCase('en-US'));
    if (titleMatches.length === 1) return { ok: true, value: titleMatches[0]! };
    return titleMatches.length > 1
      ? { ok: false, response: errorResponse(409, 'ambiguous-target', 'More than one Session has that title; use its id.') }
      : { ok: false, response: errorResponse(404, 'not-found', 'Session was not found in this Project.') };
  }

  private resolveWorkspace(
    scope: DaemonProjectScope,
    value: unknown,
  ): ScopedTarget<DaemonSnapshot['workspaces'][number]> {
    if (!isNonEmptyString(value)) {
      return { ok: false, response: errorResponse(400, 'invalid-request', 'A Workspace id or unique name is required.') };
    }
    const target = value.trim();
    const workspaces = scope.snapshot.workspaces.filter((workspace) => scope.workspaceIds.has(workspace.id));
    const exact = workspaces.find((workspace) => workspace.id === target);
    if (exact) return { ok: true, value: exact };
    const nameMatches = workspaces.filter((workspace) => (
      workspace.name.toLocaleLowerCase('en-US') === target.toLocaleLowerCase('en-US')
    ));
    if (nameMatches.length === 1) return { ok: true, value: nameMatches[0]! };
    return nameMatches.length > 1
      ? { ok: false, response: errorResponse(409, 'ambiguous-target', 'More than one Workspace has that name; use its id.') }
      : { ok: false, response: errorResponse(404, 'not-found', 'Workspace was not found in this Project.') };
  }

  private resolveSchedule(
    scope: DaemonProjectScope,
    value: unknown,
  ): ScopedTarget<DaemonSnapshot['schedules'][number]> {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, response: errorResponse(400, 'invalid-request', 'A Schedule id or unique name is required.') };
    }
    const target = value.trim();
    const schedules = scope.snapshot.schedules.filter((schedule) => scope.workspaceIds.has(schedule.workspaceId));
    const exact = schedules.find((schedule) => schedule.id === target);
    if (exact) return { ok: true, value: exact };
    const nameMatches = schedules.filter((schedule) => schedule.name.toLocaleLowerCase('en-US') === target.toLocaleLowerCase('en-US'));
    if (nameMatches.length === 1) return { ok: true, value: nameMatches[0]! };
    return nameMatches.length > 1
      ? { ok: false, response: errorResponse(409, 'ambiguous-target', 'More than one Schedule has that name; use its id.') }
      : { ok: false, response: errorResponse(404, 'not-found', 'Schedule was not found in this Project.') };
  }

  private requestId(value: unknown): ScopedTarget<string> {
    if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
      return {
        ok: false,
        response: errorResponse(400, 'invalid-request', 'A valid local request id is required.'),
      };
    }
    return { ok: true, value };
  }

  private async execute<T extends DaemonCommandType>(
    sourceSessionId: string,
    requestId: string,
    type: T,
    payload: DaemonCommandPayloads[T],
  ): Promise<DaemonCliResponse> {
    let receipt: DaemonCommandReceipt | undefined;
    for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
      const issuedAt = this.now();
      if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.valueOf())) {
        return errorResponse(500, 'internal-error', 'The local CLI clock is invalid.');
      }
      const suffix = `${requestId}-${String(attempt + 1)}`;
      const command = createDaemonCommand({
        commandId: `cli-command-${suffix}`,
        idempotencyKey: `cli-${suffix}`,
        expectedRevision: this.authority.getSnapshot().revision,
        issuedAt: issuedAt.toISOString(),
        principal: { kind: 'cli', id: sourceSessionId, sessionId: sourceSessionId },
        type,
        payload,
      }) as DaemonCommand;
      receipt = await this.authority.execute(command);
      if (receipt.ok || receipt.error.code !== 'revision-conflict') break;
    }
    if (!receipt) return errorResponse(500, 'internal-error', 'The daemon command did not return a receipt.');
    return response(commandStatus(receipt), receipt as unknown as Readonly<Record<string, unknown>>);
  }
}
