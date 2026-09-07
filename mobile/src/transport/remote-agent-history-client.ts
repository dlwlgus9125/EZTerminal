import type {
  AgentHistorySessionPage,
  AgentLaunchPreparation,
  AgentLaunchStartRequest,
  AgentLaunchStartResult,
  AgentLaunchTarget,
  AgentProjectInput,
  AgentProjectLaunchPreparation,
  AgentProjectLauncherSummary,
  AgentProjectLaunchStartRequest,
  AgentProjectLaunchStartResult,
  AgentProjectMutationResult,
  AgentProjectPage,
  AgentResumePreparation,
  AgentResumeStartRequest,
  AgentResumeStartResult,
  AgentTranscriptPage,
} from '../../../src/shared/agent-history';

import {
  REMOTE_PROTOCOL_VERSION_AGENT_HISTORY,
  REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS,
  REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS,
  type ClientToServerMessage,
  type RemoteProtocolVersion,
  type ServerToClientMessage,
} from '../../../src/shared/remote-protocol';

import { FakeMessagePort } from './ws-transport-contract';

interface AgentHistoryConnection {
  getProtocolVersion(): RemoteProtocolVersion | null;
  newId(): string;
  tryStartMapRequest<K, R>(message: ClientToServerMessage, pending: Map<K, (result: R) => void>, key: K, resolve: (result: R) => void): boolean;
  createRunPort(runId: string): FakeMessagePort;
  publishRunPort(sessionId: string, runId: string, port: FakeMessagePort): void;
}

/** Owns history/project requests; transport alone owns live run ports. */
export class RemoteAgentHistoryClient {
  constructor(private readonly connection: AgentHistoryConnection) { }

  private readonly pendingAgentProjects = new Map<string, (result: AgentProjectPage) => void>();

  private readonly pendingAgentProjectSaves = new Map<string, (result: AgentProjectMutationResult) => void>();

  private readonly pendingAgentProjectRemovals = new Map<string, (removed: boolean) => void>();

  private readonly pendingAgentProjectLaunchers = new Map<
    string,
    (result: readonly AgentProjectLauncherSummary[]) => void
  >();

  private readonly pendingAgentProjectLaunchPreparation = new Map<
    string,
    (result: AgentProjectLaunchPreparation) => void
  >();

  private readonly pendingAgentProjectLaunchStarts = new Map<
    string,
    (result: AgentProjectLaunchStartResult) => void
  >();

  private readonly pendingAgentLaunchPreparation = new Map<
    string,
    (result: AgentLaunchPreparation) => void
  >();

  private readonly pendingAgentLaunchStarts = new Map<
    string,
    (result: AgentLaunchStartResult) => void
  >();

  private readonly pendingAgentHistorySessions = new Map<string, (result: AgentHistorySessionPage) => void>();

  private readonly pendingAgentHistoryReads = new Map<string, (result: AgentTranscriptPage | null) => void>();

  private readonly pendingAgentResumePreparation = new Map<
    string,
    (result: AgentResumePreparation | null) => void
  >();

  private readonly pendingAgentResumeStarts = new Map<
    string,
    (result: AgentResumeStartResult) => void
  >();

  listAgentProjects(
    force?: boolean,
    cursor?: string,
    limit?: number,
    query?: string,
  ): Promise<AgentProjectPage> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    if (query && (this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-projects-list', requestId, force, cursor, limit, query },
        this.pendingAgentProjects,
        requestId,
        resolve,
      )) resolve({ items: [], nextCursor: null });
    });
  }

  saveAgentProject(input: AgentProjectInput): Promise<AgentProjectMutationResult> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve({ ok: false, reason: 'invalid' });
    }
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-project-save', requestId, input },
        this.pendingAgentProjectSaves,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'invalid' });
    });
  }

  removeAgentProject(projectId: string): Promise<boolean> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-project-remove', requestId, projectId },
        this.pendingAgentProjectRemovals,
        requestId,
        resolve,
      )) resolve(false);
    });
  }

  listAgentProjectLaunchers(): Promise<readonly AgentProjectLauncherSummary[]> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-project-launchers', requestId },
        this.pendingAgentProjectLaunchers,
        requestId,
        resolve,
      )) resolve([]);
    });
  }

  async prepareAgentLaunch(
    target: AgentLaunchTarget,
    launcherId: string,
    model?: string,
  ): Promise<AgentLaunchPreparation> {
    if ((this.connection.getProtocolVersion() ?? 0) >= REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) {
      return new Promise((resolve) => {
        const requestId = this.connection.newId();
        if (!this.connection.tryStartMapRequest(
          { kind: 'agent-launch-prepare', requestId, target, launcherId, ...(model ? { model } : {}) },
          this.pendingAgentLaunchPreparation,
          requestId,
          resolve,
        )) resolve({ ok: false, reason: 'unavailable' });
      });
    }
    if (model || target.kind !== 'project') return { ok: false, reason: 'unavailable' };
    const preparation = await this.prepareAgentProjectLaunch(target.projectId, launcherId);
    return preparation.ok
      ? {
        ok: true,
        target,
        launcherId: preparation.launcherId,
        provider: preparation.provider,
        name: preparation.name,
        cwd: preparation.cwd,
        roots: preparation.roots,
        ignoredAdditionalRootCount: 0,
        revision: preparation.revision,
      }
      : preparation;
  }

  startAgentLaunch(request: AgentLaunchStartRequest): Promise<AgentLaunchStartResult> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) {
      return !request.model && request.target.kind === 'project'
        ? this.startAgentProjectLaunch({
          projectId: request.target.projectId,
          launcherId: request.launcherId,
          sessionId: request.sessionId,
          runId: request.runId,
          revision: request.revision,
        })
        : Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const port = this.connection.createRunPort(request.runId);
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      const settle = (result: AgentLaunchStartResult): void => {
        if (!result.ok) {
          port.close();
          resolve(result);
          return;
        }
        this.connection.publishRunPort(request.sessionId, request.runId, port);
        resolve(result);
      };
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-launch-start', requestId, request },
        this.pendingAgentLaunchStarts,
        requestId,
        settle,
      )) settle({ ok: false, reason: 'unavailable' });
    });
  }

  prepareAgentProjectLaunch(
    projectId: string,
    launcherId: string,
  ): Promise<AgentProjectLaunchPreparation> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-project-prepare-launch', requestId, projectId, launcherId },
        this.pendingAgentProjectLaunchPreparation,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'unavailable' });
    });
  }

  startAgentProjectLaunch(
    request: AgentProjectLaunchStartRequest,
  ): Promise<AgentProjectLaunchStartResult> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const port = this.connection.createRunPort(request.runId);
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      const settle = (result: AgentProjectLaunchStartResult): void => {
        if (!result.ok) {
          port.close();
          resolve(result);
          return;
        }
        this.connection.publishRunPort(request.sessionId, request.runId, port);
        resolve(result);
      };
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-project-start-launch', requestId, request },
        this.pendingAgentProjectLaunchStarts,
        requestId,
        settle,
      )) settle({ ok: false, reason: 'unavailable' });
    });
  }

  get supportsAgentProjectManagement(): boolean {
    return (this.connection.getProtocolVersion() ?? 0) >= REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS;
  }

  get supportsAgentDirectLaunch(): boolean {
    return (this.connection.getProtocolVersion() ?? 0) >= REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS;
  }

  listAgentHistorySessions(
    projectId: string,
    cursor?: string,
    limit?: number,
    force?: boolean,
  ): Promise<AgentHistorySessionPage> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-history-sessions', requestId, projectId, cursor, limit, force },
        this.pendingAgentHistorySessions,
        requestId,
        resolve,
      )) resolve({ items: [], nextCursor: null });
    });
  }

  readAgentHistory(
    historyId: string,
    cursor?: string,
    limit?: number,
  ): Promise<AgentTranscriptPage | null> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-history-read', requestId, historyId, cursor, limit },
        this.pendingAgentHistoryReads,
        requestId,
        resolve,
      )) resolve(null);
    });
  }

  prepareAgentResume(historyId: string): Promise<AgentResumePreparation | null> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-history-prepare-resume', requestId, historyId },
        this.pendingAgentResumePreparation,
        requestId,
        resolve,
      )) resolve(null);
    });
  }

  startAgentResume(request: AgentResumeStartRequest): Promise<AgentResumeStartResult> {
    if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const port = this.connection.createRunPort(request.runId);
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      const settle = (result: AgentResumeStartResult): void => {
        if (!result.ok) {
          port.close();
          resolve(result);
          return;
        }
        this.connection.publishRunPort(request.sessionId, request.runId, port);
        resolve(result);
      };
      if (!this.connection.tryStartMapRequest(
        { kind: 'agent-history-start-resume', requestId, request },
        this.pendingAgentResumeStarts,
        requestId,
        settle,
      )) settle({ ok: false, reason: 'unavailable' });
    });
  }
  drain(): void {
    for (const resolve of this.pendingAgentProjects.values()) {
      resolve({ items: [], nextCursor: null });
    }
    this.pendingAgentProjects.clear();
    for (const resolve of this.pendingAgentProjectSaves.values()) {
      resolve({ ok: false, reason: 'invalid' });
    }
    this.pendingAgentProjectSaves.clear();
    for (const resolve of this.pendingAgentProjectRemovals.values()) resolve(false);
    this.pendingAgentProjectRemovals.clear();
    for (const resolve of this.pendingAgentProjectLaunchers.values()) resolve([]);
    this.pendingAgentProjectLaunchers.clear();
    for (const resolve of this.pendingAgentProjectLaunchPreparation.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentProjectLaunchPreparation.clear();
    for (const resolve of this.pendingAgentProjectLaunchStarts.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentProjectLaunchStarts.clear();
    for (const resolve of this.pendingAgentLaunchPreparation.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentLaunchPreparation.clear();
    for (const resolve of this.pendingAgentLaunchStarts.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentLaunchStarts.clear();
    for (const resolve of this.pendingAgentHistorySessions.values()) {
      resolve({ items: [], nextCursor: null });
    }
    this.pendingAgentHistorySessions.clear();
    for (const resolve of this.pendingAgentHistoryReads.values()) resolve(null);
    this.pendingAgentHistoryReads.clear();
    for (const resolve of this.pendingAgentResumePreparation.values()) resolve(null);
    this.pendingAgentResumePreparation.clear();
    for (const resolve of this.pendingAgentResumeStarts.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentResumeStarts.clear();
  }
  handleMessage(msg: Extract<ServerToClientMessage, { kind: 'agent-projects-list-reply' | 'agent-project-save-reply' | 'agent-project-remove-reply' | 'agent-project-launchers-reply' | 'agent-project-prepare-launch-reply' | 'agent-project-start-launch-reply' | 'agent-launch-prepare-reply' | 'agent-launch-start-reply' | 'agent-history-sessions-reply' | 'agent-history-read-reply' | 'agent-history-prepare-resume-reply' | 'agent-history-start-resume-reply'; }>): void {
    switch (msg.kind) {
      case 'agent-projects-list-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentProjects.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjects.delete(msg.requestId);
        break;
      case 'agent-project-save-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectSaves.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjectSaves.delete(msg.requestId);
        break;
      case 'agent-project-remove-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectRemovals.get(msg.requestId)?.(msg.removed);
        this.pendingAgentProjectRemovals.delete(msg.requestId);
        break;
      case 'agent-project-launchers-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectLaunchers.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjectLaunchers.delete(msg.requestId);
        break;
      case 'agent-project-prepare-launch-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectLaunchPreparation.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjectLaunchPreparation.delete(msg.requestId);
        break;
      case 'agent-project-start-launch-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectLaunchStarts.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjectLaunchStarts.delete(msg.requestId);
        break;
      case 'agent-launch-prepare-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) break;
        this.pendingAgentLaunchPreparation.get(msg.requestId)?.(msg.result);
        this.pendingAgentLaunchPreparation.delete(msg.requestId);
        break;
      case 'agent-launch-start-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) break;
        this.pendingAgentLaunchStarts.get(msg.requestId)?.(msg.result);
        this.pendingAgentLaunchStarts.delete(msg.requestId);
        break;
      case 'agent-history-sessions-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentHistorySessions.get(msg.requestId)?.(msg.result);
        this.pendingAgentHistorySessions.delete(msg.requestId);
        break;
      case 'agent-history-read-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentHistoryReads.get(msg.requestId)?.(msg.result);
        this.pendingAgentHistoryReads.delete(msg.requestId);
        break;
      case 'agent-history-prepare-resume-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentResumePreparation.get(msg.requestId)?.(msg.result);
        this.pendingAgentResumePreparation.delete(msg.requestId);
        break;
      case 'agent-history-start-resume-reply':
        if ((this.connection.getProtocolVersion() ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentResumeStarts.get(msg.requestId)?.(msg.result);
        this.pendingAgentResumeStarts.delete(msg.requestId);
        break;
    }
  }
}
