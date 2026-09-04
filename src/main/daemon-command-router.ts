import type { SessionInfo } from '../shared/ipc';
import {
  parseDaemonCommand,
  type DaemonCommand,
  type DaemonCommandError,
  type DaemonCommandReceipt,
  type DaemonCommandType,
  type DaemonEvent,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
} from '../shared/daemon-protocol';
import { AsyncMutationGate } from './async-mutation-gate';
import { authorizeDaemonCommand } from './daemon-command-policy';
import {
  type DaemonStoreCommit,
  type DaemonStoreMutation,
  DaemonStore,
} from './daemon-store';
import {
  planLegacyTerminalRegistrations,
  type LegacyTerminalRegistrationOptions,
} from './legacy-terminal-registration';

export type DaemonCommandExecutionResult =
  | { readonly ok: true; readonly commit?: DaemonStoreCommit }
  | { readonly ok: false; readonly error: DaemonCommandError };

export interface DaemonCommandExecutionContext {
  readonly snapshot: DaemonSnapshot;
  /** Call immediately before an operation can become externally visible. */
  markProviderDispatchStarted(): Promise<void>;
}

export type DaemonCommandHandler = (
  command: DaemonCommand,
  context: DaemonCommandExecutionContext,
) => Promise<DaemonCommandExecutionResult> | DaemonCommandExecutionResult;

export interface DaemonCommandRouterOptions {
  readonly handlers?: Partial<Record<DaemonCommandType, DaemonCommandHandler>>;
  readonly now?: () => Date;
}

function commandError(
  code: DaemonCommandError['code'],
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
): DaemonCommandError {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

function isActiveSession(state: DaemonSnapshot['sessions'][number]['state']): boolean {
  return !['completed', 'interrupted', 'failed', 'archived'].includes(state);
}

function managedDescendant(snapshot: DaemonSnapshot, rootSessionId: string, candidateSessionId: string): boolean {
  const visited = new Set<string>([rootSessionId]);
  let frontier = [rootSessionId];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    frontier = [];
    for (const relation of snapshot.agentRelations) {
      if (
        relation.owner !== 'managed'
        || relation.detachedAt !== undefined
        || !parents.has(relation.parentSessionId)
        || visited.has(relation.childSessionId)
      ) continue;
      if (relation.childSessionId === candidateSessionId) return true;
      visited.add(relation.childSessionId);
      frontier.push(relation.childSessionId);
    }
  }
  return false;
}

function sameCommand(left: DaemonCommand, right: DaemonCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class DaemonCommandRouter {
  private readonly gate = new AsyncMutationGate();
  private readonly listeners = new Set<(event: DaemonEvent) => void>();
  private readonly handlers: Partial<Record<DaemonCommandType, DaemonCommandHandler>>;
  private readonly now: () => Date;

  constructor(
    private readonly store: DaemonStore,
    options: DaemonCommandRouterOptions = {},
  ) {
    this.handlers = options.handlers ?? {};
    this.now = options.now ?? (() => new Date());
  }

  getSnapshot(): DaemonSnapshot {
    return this.store.getSnapshot();
  }

  /**
   * Read semantic transcript items without exposing the SQLite store to a
   * transport. The store owns sequence ordering and the hard page bound.
   */
  getTranscript(
    sessionId: string,
    afterSequence = 0,
    limit = 500,
  ): readonly DaemonTranscriptItem[] {
    return this.store.getTranscript(sessionId, afterSequence, limit);
  }

  readTranscript(
    sessionId: string,
    afterSequence = 0,
    limit = 500,
  ): readonly DaemonTranscriptItem[] {
    return this.getTranscript(sessionId, afterSequence, limit);
  }

  onEvent(listener: (event: DaemonEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(value: unknown): Promise<DaemonCommandReceipt> {
    let command: DaemonCommand;
    try {
      command = parseDaemonCommand(value);
    } catch (error) {
      const commandId = typeof value === 'object' && value !== null && 'commandId' in value
        && typeof value.commandId === 'string' ? value.commandId : 'invalid-command';
      return {
        ok: false,
        status: 'rejected',
        commandId,
        revision: this.store.getRevision(),
        error: commandError(
          'invalid-command',
          error instanceof Error ? error.message : 'Daemon command is invalid.',
        ),
      };
    }

    return this.gate.runExclusive(() => this.executeExclusive(command));
  }

  async applySystemCommit(commit: DaemonStoreCommit): Promise<{ readonly revision: number; readonly eventSequence: number }> {
    return this.gate.runExclusive(async () => {
      const before = this.store.getEventSequence();
      const receipt = await this.store.applySystemCommit(commit);
      this.publishEventsAfter(before);
      return receipt;
    });
  }

  async registerLegacyTerminals(
    sessions: readonly SessionInfo[],
    options: LegacyTerminalRegistrationOptions = {},
  ): Promise<{ readonly revision: number; readonly eventSequence: number }> {
    return this.gate.runExclusive(async () => {
      const snapshot = this.store.getSnapshot();
      const plan = planLegacyTerminalRegistrations(sessions, snapshot, options);
      const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));
      const plannedProjectsById = new Map(plan.projects.map((project) => [project.projectId, project]));
      const workspacesById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
      const plannedWorkspacesById = new Map(plan.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
      const mutations: DaemonStoreMutation[] = [
        ...plan.projects.map((project): DaemonStoreMutation => ({
          kind: 'project.upsert',
          value: {
            id: project.projectId,
            name: project.name,
            rootPath: project.rootPath,
            source: 'legacy-import',
          },
        })),
        ...plan.workspaces.map((workspace): DaemonStoreMutation => ({
          kind: 'workspace.upsert',
          value: {
            id: workspace.workspaceId,
            projectId: workspace.projectId,
            name: workspace.name,
            kind: 'local',
            rootPath: workspace.rootPath,
          },
        })),
        ...plan.sessions.map((session): DaemonStoreMutation => {
          const workspace = workspacesById.get(session.workspaceId) ?? plannedWorkspacesById.get(session.workspaceId);
          if (!workspace) throw new Error(`Legacy terminal workspace ${session.workspaceId} is unavailable.`);
          const projectId = workspace.projectId;
          if (!projectsById.has(projectId) && !plannedProjectsById.has(projectId)) {
            throw new Error(`Legacy terminal project ${projectId} is unavailable.`);
          }
          return {
            kind: 'session.upsert',
            value: {
              id: session.sessionId,
              projectId,
              workspaceId: session.workspaceId,
              kind: 'terminal',
              title: session.title,
              state: 'running',
              source: 'legacy-pty',
            },
          };
        }),
      ];
      if (mutations.length === 0) {
        return { revision: snapshot.revision, eventSequence: snapshot.eventSequence };
      }
      const before = snapshot.eventSequence;
      const receipt = await this.store.applySystemCommit({ mutations });
      this.publishEventsAfter(before);
      return receipt;
    });
  }

  private async executeExclusive(command: DaemonCommand): Promise<DaemonCommandReceipt> {
    const snapshot = this.store.getSnapshot();
    const authorization = authorizeDaemonCommand(command, {
      isManagedDescendant: (root, candidate) => managedDescendant(snapshot, root, candidate),
    });
    if (!authorization.allowed) {
      return {
        ok: false,
        status: 'rejected',
        commandId: command.commandId,
        revision: snapshot.revision,
        error: authorization.error,
      };
    }

    const existing = this.store.findCommandByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (!sameCommand(existing.command, command)) {
        return {
          ok: false,
          status: 'rejected',
          commandId: command.commandId,
          revision: snapshot.revision,
          error: commandError('invalid-command', 'The idempotency key is already bound to another command.'),
        };
      }
      if (existing.receipt) {
        return existing.receipt.ok
          ? { ...existing.receipt, status: 'replayed' }
          : existing.receipt;
      }
    }

    const beforeSequence = snapshot.eventSequence;
    const outbox = await this.store.beginOutbox(command);
    if (outbox.receipt) return outbox.receipt;

    let providerDispatchStarted = outbox.state === 'sent';
    const markProviderDispatchStarted = async (): Promise<void> => {
      if (providerDispatchStarted) return;
      providerDispatchStarted = true;
      await this.store.markOutboxSent(command.commandId);
    };

    try {
      const handler = this.handlers[command.type];
      const result = handler
        ? await handler(command, { snapshot, markProviderDispatchStarted })
        : this.executeCoreCommand(command, snapshot);
      if (!result.ok) {
        const receipt = await this.store.rejectCommand(command.commandId, result.error);
        this.publishEventsAfter(beforeSequence);
        return receipt;
      }
      const receipt = await this.store.commitCommand(command.commandId, result.commit);
      this.publishEventsAfter(beforeSequence);
      return receipt;
    } catch (error) {
      const receipt = providerDispatchStarted
        ? await this.store.markDeliveryUncertain(
          command.commandId,
          error instanceof Error ? error.message : 'Provider delivery could not be confirmed.',
        )
        : await this.store.rejectCommand(command.commandId, commandError(
          'internal-error',
          error instanceof Error ? error.message : 'Daemon command failed.',
          false,
        ));
      this.publishEventsAfter(beforeSequence);
      return receipt;
    }
  }

  private executeCoreCommand(command: DaemonCommand, snapshot: DaemonSnapshot): DaemonCommandExecutionResult {
    const timestamp = this.now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.valueOf())) {
      throw new Error('Daemon command clock returned an invalid Date.');
    }
    const now = timestamp.toISOString();
    const project = (id: string) => snapshot.projects.find((entry) => entry.id === id);
    const workspace = (id: string) => snapshot.workspaces.find((entry) => entry.id === id);
    const session = (id: string) => snapshot.sessions.find((entry) => entry.id === id);

    switch (command.type) {
      case 'project.create':
        if (project(command.payload.projectId)) {
          return { ok: false, error: commandError('invalid-state', 'Project already exists.') };
        }
        return { ok: true, commit: { mutations: [{ kind: 'project.upsert', value: {
          id: command.payload.projectId,
          name: command.payload.name,
          ...(command.payload.rootPath ? { rootPath: command.payload.rootPath } : {}),
          source: 'native',
        } }] } };

      case 'project.update': {
        const current = project(command.payload.projectId);
        if (!current) return { ok: false, error: commandError('not-found', 'Project was not found.') };
        return { ok: true, commit: { mutations: [{ kind: 'project.upsert', value: {
          id: current.id,
          name: command.payload.name ?? current.name,
          ...(command.payload.rootPath ?? current.rootPath ? { rootPath: command.payload.rootPath ?? current.rootPath } : {}),
          source: current.source,
          ...(current.archivedAt ? { archivedAt: current.archivedAt } : {}),
        } }] } };
      }

      case 'project.archive': {
        const current = project(command.payload.projectId);
        if (!current) return { ok: false, error: commandError('not-found', 'Project was not found.') };
        if (snapshot.sessions.some((entry) => entry.projectId === current.id && isActiveSession(entry.state))) {
          return { ok: false, error: commandError('invalid-state', 'Stop active Project sessions before archiving it.') };
        }
        return { ok: true, commit: { mutations: [{ kind: 'project.upsert', value: {
          id: current.id, name: current.name, ...(current.rootPath ? { rootPath: current.rootPath } : {}),
          source: current.source, archivedAt: current.archivedAt ?? now,
        } }] } };
      }

      case 'workspace.create': {
        const owner = project(command.payload.projectId);
        if (!owner || owner.archivedAt) return { ok: false, error: commandError('not-found', 'Active Project was not found.') };
        if (workspace(command.payload.workspaceId)) return { ok: false, error: commandError('invalid-state', 'Workspace already exists.') };
        if (command.payload.sourceWorkspaceId) {
          const source = workspace(command.payload.sourceWorkspaceId);
          if (!source || source.projectId !== owner.id) {
            return { ok: false, error: commandError('invalid-state', 'Source Workspace must belong to the same Project.') };
          }
        }
        return { ok: true, commit: { mutations: [{ kind: 'workspace.upsert', value: {
          id: command.payload.workspaceId,
          projectId: owner.id,
          name: command.payload.name,
          kind: command.payload.kind,
          rootPath: command.payload.rootPath,
          ...(command.payload.sourceWorkspaceId ? { sourceWorkspaceId: command.payload.sourceWorkspaceId } : {}),
        } }] } };
      }

      case 'workspace.update': {
        const current = workspace(command.payload.workspaceId);
        if (!current) return { ok: false, error: commandError('not-found', 'Workspace was not found.') };
        return { ok: true, commit: { mutations: [{ kind: 'workspace.upsert', value: {
          id: current.id, projectId: current.projectId, name: command.payload.name ?? current.name,
          kind: current.kind, rootPath: command.payload.rootPath ?? current.rootPath,
          ...(current.sourceWorkspaceId ? { sourceWorkspaceId: current.sourceWorkspaceId } : {}),
          ...(current.archivedAt ? { archivedAt: current.archivedAt } : {}),
        } }] } };
      }

      case 'workspace.archive': {
        const current = workspace(command.payload.workspaceId);
        if (!current) return { ok: false, error: commandError('not-found', 'Workspace was not found.') };
        if (snapshot.sessions.some((entry) => entry.workspaceId === current.id && isActiveSession(entry.state))) {
          return { ok: false, error: commandError('invalid-state', 'Stop active Workspace sessions before archiving it.') };
        }
        return { ok: true, commit: { mutations: [{ kind: 'workspace.upsert', value: {
          id: current.id, projectId: current.projectId, name: current.name, kind: current.kind,
          rootPath: current.rootPath, ...(current.sourceWorkspaceId ? { sourceWorkspaceId: current.sourceWorkspaceId } : {}),
          archivedAt: current.archivedAt ?? now,
        } }] } };
      }

      case 'session.create': {
        const owner = workspace(command.payload.workspaceId);
        if (!owner || owner.archivedAt) return { ok: false, error: commandError('not-found', 'Active Workspace was not found.') };
        if (session(command.payload.sessionId)) return { ok: false, error: commandError('invalid-state', 'Session already exists.') };
        return { ok: true, commit: { mutations: [{ kind: 'session.upsert', value: {
          id: command.payload.sessionId,
          projectId: owner.projectId,
          workspaceId: owner.id,
          kind: command.payload.kind,
          title: command.payload.title,
          state: 'draft',
          source: 'structured',
        } }] } };
      }

      case 'session.update': {
        const current = session(command.payload.sessionId);
        if (!current) return { ok: false, error: commandError('not-found', 'Session was not found.') };
        return { ok: true, commit: { mutations: [{ kind: 'session.upsert', value: {
          id: current.id, projectId: current.projectId, workspaceId: current.workspaceId,
          kind: current.kind, title: command.payload.title ?? current.title,
          state: current.state, source: current.source,
          ...(current.archivedAt ? { archivedAt: current.archivedAt } : {}),
        } }] } };
      }

      case 'session.archive': {
        const current = session(command.payload.sessionId);
        if (!current) return { ok: false, error: commandError('not-found', 'Session was not found.') };
        if (isActiveSession(current.state)) {
          return { ok: false, error: commandError('invalid-state', 'Stop the Session before archiving it.') };
        }
        return { ok: true, commit: { mutations: [{ kind: 'session.upsert', value: {
          id: current.id, projectId: current.projectId, workspaceId: current.workspaceId,
          kind: current.kind, title: current.title, state: 'archived', source: current.source,
          archivedAt: current.archivedAt ?? now,
        } }] } };
      }

      default:
        return {
          ok: false,
          error: commandError(
            'invalid-state',
            `No runtime handler is configured for ${command.type}.`,
          ),
        };
    }
  }

  private publishEventsAfter(sequence: number): void {
    let cursor = sequence;
    for (;;) {
      const events = this.store.listEventsAfter(cursor, 5_000);
      if (events.length === 0) return;
      for (const event of events) {
        cursor = event.sequence;
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            // Event observers are projections and cannot roll back committed state.
          }
        }
      }
      if (events.length < 5_000) return;
    }
  }
}
