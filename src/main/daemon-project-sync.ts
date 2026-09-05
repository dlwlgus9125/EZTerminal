import { createHash } from 'node:crypto';
import path from 'node:path';

import type { AgentProjectSummary } from '../shared/agent-history';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type {
  ProjectWorkspaceAccessRequest,
  ProjectWorkspaceDescriptor,
  ProjectWorkspaceDiscovery,
} from '../shared/project-workspace';
import type {
  DaemonStoreCommit,
  DaemonStoreMutation,
  DaemonSystemTransition,
  DaemonSystemTransitionState,
} from './daemon-store';

export interface DaemonProjectSyncWorkspace {
  readonly id: string;
  readonly name: string;
  readonly kind: 'local' | 'worktree';
  readonly rootPath: string;
  readonly sourceWorkspaceId?: string;
}

type ProjectWorkspaceDiscoveryError = Extract<
  ProjectWorkspaceDiscovery['roots'][number],
  { readonly status: 'unavailable' }
>['error'];

export type DaemonProjectWorkspaceRootDiscovery =
  | { readonly sourceWorkspaceId: string; readonly status: 'complete' }
  | {
      readonly sourceWorkspaceId: string;
      readonly status: 'unavailable';
      readonly error: ProjectWorkspaceDiscoveryError;
    };

export interface DaemonProjectWorkspaceDiscovery {
  readonly roots: readonly DaemonProjectWorkspaceRootDiscovery[];
}

export interface DaemonProjectSyncDescriptor {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly workspaces: readonly DaemonProjectSyncWorkspace[];
  /** Omitted legacy/captured descriptors can refresh but never prune authority. */
  readonly workspaceDiscovery?: DaemonProjectWorkspaceDiscovery;
}

export interface DaemonProjectSyncOptions {
  /** Explicit user intent to restore a previously removed native Project. */
  readonly reactivateProjectIds?: ReadonlySet<string>;
  /** Explicit user intent to restore a previously revoked Workspace grant. */
  readonly reactivateWorkspaceIds?: ReadonlySet<string>;
  /** Deterministic tombstone time for tests/compound transitions. */
  readonly archivedAt?: string;
}

export class DaemonProjectWorkspaceDiscoveryError extends Error {
  constructor(
    readonly projectId: string,
    readonly sourceWorkspaceId: string,
    readonly code: ProjectWorkspaceDiscoveryError,
  ) {
    super(`Agent Project ${projectId} Workspace discovery is unavailable: ${code}.`);
    this.name = 'DaemonProjectWorkspaceDiscoveryError';
  }
}

export interface DaemonProjectSaveIdentity {
  readonly id: string;
  readonly rootPaths: readonly string[];
}

export type DaemonProjectAuthorityRevocationResult =
  | { readonly ok: true; readonly sessionIds: readonly string[] }
  | { readonly ok: false; readonly reason: 'active-sessions'; readonly sessionIds: readonly string[] };

const TERMINAL_SESSION_STATES = new Set<DaemonSnapshot['sessions'][number]['state']>([
  'completed', 'interrupted', 'failed', 'archived',
]);

const TERMINAL_TURN_STATES = new Set<DaemonSnapshot['turns'][number]['state']>([
  'completed', 'interrupted', 'failed',
]);

/**
 * Workspace ids in ProjectWorkspaceService are scoped by root/repository.
 * Daemon Workspace ids are global, so retain the source identities while
 * namespacing them by Project and root. The hash fallback only applies to
 * legacy/custom identities that would exceed the v12 identifier bound.
 */
export function daemonWorkspaceId(
  projectId: string,
  rootId: string,
  sourceWorkspaceId: string,
): string {
  const value = `${projectId}.${rootId}.${sourceWorkspaceId}`;
  return value.length <= 256
    ? value
    : `workspace-${createHash('sha256').update(value).digest('hex')}`;
}

/** Translate one already-validated Project descriptor without rediscovering
 * its worktrees. Callers use this at the project-session launch boundary so a
 * transient follow-up Git failure cannot silently drop the selected Workspace.
 */
export function resolvedDaemonProjectSyncDescriptor(
  descriptor: ProjectWorkspaceDescriptor,
): DaemonProjectSyncDescriptor {
  const primaryRoot = descriptor.roots.find((root) => root.primary) ?? descriptor.roots[0];
  if (!primaryRoot) {
    throw new Error(`Agent Project ${descriptor.projectId} has no primary root.`);
  }

  const roots = new Map(descriptor.roots.map((root) => [root.rootId, root]));
  const workspaces = new Map<string, DaemonProjectSyncWorkspace>();
  for (const root of descriptor.roots) {
    const id = daemonWorkspaceId(descriptor.projectId, root.rootId, root.rootId);
    workspaces.set(id, {
      id,
      name: root.name,
      kind: 'local',
      rootPath: root.displayPath,
    });
  }
  for (const workspace of descriptor.workspaces ?? []) {
    if (workspace.access !== 'granted') continue;
    const root = roots.get(workspace.rootId);
    if (!root) throw new Error(`Agent Workspace ${workspace.workspaceId} has an unknown root.`);
    const id = daemonWorkspaceId(descriptor.projectId, workspace.rootId, workspace.workspaceId);
    const rootWorkspaceId = daemonWorkspaceId(descriptor.projectId, workspace.rootId, workspace.rootId);
    const kind = workspace.kind === 'managed' || workspace.kind === 'external'
      ? 'worktree'
      : 'local';
    workspaces.set(id, {
      id,
      name: workspace.name,
      kind,
      rootPath: workspace.displayPath,
      ...(kind === 'worktree' ? { sourceWorkspaceId: rootWorkspaceId } : {}),
    });
  }
  let workspaceDiscovery: DaemonProjectWorkspaceDiscovery | undefined;
  if (descriptor.workspaceDiscovery) {
    const seenRootIds = new Set<string>();
    const discoveryRoots: DaemonProjectWorkspaceRootDiscovery[] = [];
    for (const discovery of descriptor.workspaceDiscovery.roots) {
      if (!roots.has(discovery.rootId) || seenRootIds.has(discovery.rootId)) {
        throw new Error(`Agent Project ${descriptor.projectId} has invalid Workspace discovery provenance.`);
      }
      seenRootIds.add(discovery.rootId);
      const sourceWorkspaceId = daemonWorkspaceId(
        descriptor.projectId,
        discovery.rootId,
        discovery.rootId,
      );
      discoveryRoots.push(discovery.status === 'complete'
        ? { sourceWorkspaceId, status: 'complete' }
        : { sourceWorkspaceId, status: 'unavailable', error: discovery.error });
    }
    if (seenRootIds.size !== roots.size) {
      throw new Error(`Agent Project ${descriptor.projectId} has incomplete Workspace discovery provenance.`);
    }
    workspaceDiscovery = { roots: discoveryRoots };
  }
  return {
    id: descriptor.projectId,
    name: descriptor.name,
    rootPath: primaryRoot.displayPath,
    workspaces: [...workspaces.values()],
    ...(workspaceDiscovery ? { workspaceDiscovery } : {}),
  };
}

/** Workspace tombstones that may be restored without renewing external
 * consent. Registered roots and app-managed worktrees stay Project-owned;
 * external worktrees require the exact approval transition instead. */
export function trustedDaemonWorkspaceReactivationIds(
  descriptor: ProjectWorkspaceDescriptor,
): ReadonlySet<string> {
  const ids = new Set(descriptor.roots.map((root) => (
    daemonWorkspaceId(descriptor.projectId, root.rootId, root.rootId)
  )));
  for (const workspace of descriptor.workspaces ?? []) {
    if (workspace.access !== 'granted' || workspace.kind === 'external') continue;
    ids.add(daemonWorkspaceId(descriptor.projectId, workspace.rootId, workspace.workspaceId));
  }
  return ids;
}

/** Archive a removed native Project and every Workspace that can still be used
 * to launch work inside it. The returned mutations are committed together so
 * readers cannot observe an archived Project with an active child capability.
 */
export function planDaemonProjectRevocation(
  snapshot: Pick<DaemonSnapshot, 'projects' | 'workspaces'>,
  projectId: string,
  archivedAt: string,
): readonly DaemonStoreMutation[] {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (!project) return [];
  if (project.source !== 'native') {
    throw new Error(`Removed daemon Project ${projectId} is not owned by the native Project index.`);
  }

  const mutations: DaemonStoreMutation[] = snapshot.workspaces
    .filter((workspace) => workspace.projectId === projectId && workspace.archivedAt === undefined)
    .map((workspace) => ({
      kind: 'workspace.upsert',
      value: {
        id: workspace.id,
        projectId: workspace.projectId,
        name: workspace.name,
        kind: workspace.kind,
        rootPath: workspace.rootPath,
        ...(workspace.sourceWorkspaceId ? { sourceWorkspaceId: workspace.sourceWorkspaceId } : {}),
        archivedAt,
      },
    }));
  if (project.archivedAt === undefined) {
    mutations.push({
      kind: 'project.upsert',
      value: {
        id: project.id,
        name: project.name,
        ...(project.rootPath ? { rootPath: project.rootPath } : {}),
        source: project.source,
        archivedAt,
      },
    });
  }
  return mutations;
}

/** Build a fresh-snapshot planner for DaemonCommandRouter.applySystemCommit.
 * Keeping discovery inside the router gate includes commands already accepted
 * ahead of revocation instead of applying a stale pre-gate child list.
 */
export function daemonProjectRevocationCommit(
  projectId: string,
  archivedAt: string,
): (snapshot: DaemonSnapshot) => DaemonStoreCommit | undefined {
  return (snapshot) => {
    const mutations = planDaemonProjectRevocation(snapshot, projectId, archivedAt);
    return mutations.length > 0 ? { mutations } : undefined;
  };
}

function sessionRetirementMutations(
  state: DaemonSystemTransitionState,
  sessionIds: ReadonlySet<string>,
  archivedAt: string,
): readonly DaemonStoreMutation[] {
  const mutations: DaemonStoreMutation[] = [];
  for (const session of state.snapshot.sessions) {
    if (!sessionIds.has(session.id) || session.state === 'archived') continue;
    mutations.push({ kind: 'session.upsert', value: {
      id: session.id,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      kind: session.kind,
      title: session.title,
      state: 'archived',
      source: session.source,
      archivedAt: session.archivedAt ?? archivedAt,
    } });
  }
  for (const agent of state.snapshot.agents) {
    if (!sessionIds.has(agent.sessionId) || agent.state === 'archived') continue;
    mutations.push({ kind: 'agent.upsert', value: {
      sessionId: agent.sessionId,
      providerId: agent.providerId,
      ...(agent.providerSessionId ? { providerSessionId: agent.providerSessionId } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      permissionPreset: agent.permissionPreset,
      state: 'archived',
      queuedTurnCount: 0,
      orchestrationEnabled: false,
    } });
  }
  for (const turn of state.snapshot.turns) {
    if (!sessionIds.has(turn.sessionId) || TERMINAL_TURN_STATES.has(turn.state)) continue;
    mutations.push({ kind: 'turn.upsert', value: {
      id: turn.id,
      sessionId: turn.sessionId,
      commandId: turn.commandId,
      ...(turn.enqueueSequence === undefined ? {} : { enqueueSequence: turn.enqueueSequence }),
      state: 'interrupted',
      ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
      finishedAt: archivedAt,
      errorCode: 'project-authority-revoked',
    } });
  }
  for (const approval of state.snapshot.approvals) {
    if (!sessionIds.has(approval.sessionId) || approval.state !== 'pending') continue;
    mutations.push({ kind: 'approval.upsert', value: {
      id: approval.id,
      sessionId: approval.sessionId,
      ...(approval.turnId ? { turnId: approval.turnId } : {}),
      providerRequestId: approval.providerRequestId,
      risk: approval.risk,
      title: approval.title,
      ...(approval.detail ? { detail: approval.detail } : {}),
      state: 'expired',
      resolvedAt: archivedAt,
    } });
  }
  for (const relation of state.snapshot.agentRelations) {
    if (relation.detachedAt || (!sessionIds.has(relation.parentSessionId)
      && !sessionIds.has(relation.childSessionId))) continue;
    mutations.push({ kind: 'agent-relation.upsert', value: {
      id: relation.id,
      treeId: relation.treeId,
      parentSessionId: relation.parentSessionId,
      childSessionId: relation.childSessionId,
      owner: relation.owner,
      depth: relation.depth,
      detachedAt: archivedAt,
    } });
  }
  return mutations;
}

function heartbeatRetirementMutations(
  state: DaemonSystemTransitionState,
  sessionIds: ReadonlySet<string>,
): readonly DaemonStoreMutation[] {
  return state.snapshot.heartbeats
    .filter((heartbeat) => sessionIds.has(heartbeat.sessionId))
    .map((heartbeat) => ({ kind: 'heartbeat.delete', sessionId: heartbeat.sessionId }));
}

function automationRetirementMutations(
  state: DaemonSystemTransitionState,
  workspaceIds: ReadonlySet<string>,
  archivedAt: string,
): readonly DaemonStoreMutation[] {
  const schedules = state.snapshot.schedules.filter((schedule) => workspaceIds.has(schedule.workspaceId));
  const scheduleIds = new Set(schedules.map((schedule) => schedule.id));
  const mutations: DaemonStoreMutation[] = schedules
    .filter((schedule) => schedule.enabled || schedule.nextRunAt !== undefined)
    .map((schedule) => ({ kind: 'schedule.upsert', value: {
      id: schedule.id,
      name: schedule.name,
      workspaceId: schedule.workspaceId,
      providerId: schedule.providerId,
      ...(schedule.model ? { model: schedule.model } : {}),
      permissionPreset: schedule.permissionPreset,
      prompt: schedule.prompt,
      cron: schedule.cron,
      timezone: schedule.timezone,
      enabled: false,
      ...(schedule.maxRuns === undefined ? {} : { maxRuns: schedule.maxRuns }),
      runCount: schedule.runCount,
      ...(schedule.expiresAt ? { expiresAt: schedule.expiresAt } : {}),
    } }));
  for (const run of state.scheduleRuns) {
    if (!scheduleIds.has(run.scheduleId) || run.state !== 'queued') continue;
    mutations.push({ kind: 'schedule-run.upsert', value: {
      id: run.id,
      scheduleId: run.scheduleId,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      state: 'failed',
      scheduledFor: run.scheduledFor,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      finishedAt: archivedAt,
      summary: run.summary ?? 'Project authority was revoked before this run started.',
      errorCode: 'project-authority-revoked',
    } });
  }
  return mutations;
}

function authorityRetirementPlan(
  state: DaemonSystemTransitionState,
  revocations: readonly DaemonStoreMutation[],
  workspaceIds: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>,
  archivedAt: string,
): { readonly commit: DaemonStoreCommit; readonly value: DaemonProjectAuthorityRevocationResult } {
  const activeSessionIds = [...sessionIds].filter((sessionId) => {
    const session = state.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    return session !== undefined && !TERMINAL_SESSION_STATES.has(session.state);
  });
  if (activeSessionIds.length > 0) {
    return {
      commit: {},
      value: { ok: false, reason: 'active-sessions', sessionIds: activeSessionIds },
    };
  }
  return {
    commit: {
      mutations: [
        ...revocations,
        ...automationRetirementMutations(state, workspaceIds, archivedAt),
        ...heartbeatRetirementMutations(state, sessionIds),
        ...sessionRetirementMutations(state, sessionIds, archivedAt),
      ],
    },
    value: { ok: true, sessionIds: [...sessionIds] },
  };
}

/** Full Project removal is a fresh-snapshot fail-closed transition. Active
 * daemon Sessions must be stopped by their owner first; terminal descendants,
 * queued automation, heartbeats, and durable launch capabilities retire in the
 * same SQLite transaction as the Project/Workspace tombstones. */
export function daemonProjectRemovalTransition(
  projectId: string,
  archivedAt: string,
): DaemonSystemTransition<DaemonProjectAuthorityRevocationResult> {
  return (state) => {
    const project = state.snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project && project.source !== 'native') {
      throw new Error(`Removed daemon Project ${projectId} is not owned by the native Project index.`);
    }
    const workspaceIds = new Set(state.snapshot.workspaces
      .filter((workspace) => workspace.projectId === projectId)
      .map((workspace) => workspace.id));
    const sessionIds = new Set(state.snapshot.sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id));
    return authorityRetirementPlan(
      state,
      project ? planDaemonProjectRevocation(state.snapshot, projectId, archivedAt) : [],
      workspaceIds,
      sessionIds,
      archivedAt,
    );
  };
}

/** Archive registered roots removed by an edit, including every Workspace
 * whose source lineage starts at one of those roots. */
export function planDaemonProjectRootRevocation(
  snapshot: Pick<DaemonSnapshot, 'workspaces'>,
  projectId: string,
  removedRootPaths: readonly string[],
  archivedAt: string,
): readonly DaemonStoreMutation[] {
  const removedPathKeys = new Set(removedRootPaths.map(pathKey));
  const archivedWorkspaceIds = new Set(snapshot.workspaces
    .filter((workspace) => (
      workspace.projectId === projectId
      && removedPathKeys.has(pathKey(workspace.rootPath))
    ))
    .map((workspace) => workspace.id));
  for (;;) {
    const previousSize = archivedWorkspaceIds.size;
    for (const workspace of snapshot.workspaces) {
      if (
        workspace.projectId === projectId
        && workspace.sourceWorkspaceId
        && archivedWorkspaceIds.has(workspace.sourceWorkspaceId)
      ) {
        archivedWorkspaceIds.add(workspace.id);
      }
    }
    if (archivedWorkspaceIds.size === previousSize) break;
  }
  return snapshot.workspaces
    .filter((workspace) => (
      archivedWorkspaceIds.has(workspace.id) && workspace.archivedAt === undefined
    ))
    .map((workspace) => ({
      kind: 'workspace.upsert',
      value: {
        id: workspace.id,
        projectId: workspace.projectId,
        name: workspace.name,
        kind: workspace.kind,
        rootPath: workspace.rootPath,
        ...(workspace.sourceWorkspaceId ? { sourceWorkspaceId: workspace.sourceWorkspaceId } : {}),
        archivedAt,
      },
    }));
}

/** One fresh-snapshot transition for Project edits: obsolete authority is
 * closed in the same daemon commit that publishes the replacement identity. */
export function planDaemonProjectSaveTransition(
  snapshot: Pick<DaemonSnapshot, 'projects' | 'workspaces'>,
  previous: DaemonProjectSaveIdentity | undefined,
  next: DaemonProjectSyncDescriptor,
  nextRootPaths: readonly string[],
  archivedAt: string,
  options: DaemonProjectSyncOptions = {},
): readonly DaemonStoreMutation[] {
  const revocations = previous && previous.id !== next.id
    ? planDaemonProjectRevocation(snapshot, previous.id, archivedAt)
    : previous
      ? planDaemonProjectRootRevocation(
          snapshot,
          previous.id,
          previous.rootPaths.filter((rootPath) => (
            !nextRootPaths.some((candidate) => pathKey(candidate) === pathKey(rootPath))
          )),
          archivedAt,
        )
      : [];
  return [...revocations, ...planDaemonProjectSync(snapshot, [next], {
    ...options,
    archivedAt,
  })];
}

export function daemonProjectSaveCommit(
  previous: DaemonProjectSaveIdentity | undefined,
  next: DaemonProjectSyncDescriptor,
  nextRootPaths: readonly string[],
  archivedAt: string,
  options: DaemonProjectSyncOptions = {},
): (snapshot: DaemonSnapshot) => DaemonStoreCommit | undefined {
  return (snapshot) => {
    const mutations = planDaemonProjectSaveTransition(
      snapshot,
      previous,
      next,
      nextRootPaths,
      archivedAt,
      options,
    );
    return mutations.length > 0 ? { mutations } : undefined;
  };
}

/** Retire only the authority made obsolete by a prepared Project save. The
 * local Project index is committed afterwards, so every crash boundary is
 * fail-closed and a retry can finish publishing the replacement. */
export function daemonProjectSaveRevocationTransition(
  previous: DaemonProjectSaveIdentity | undefined,
  nextProjectId: string,
  nextRootPaths: readonly string[],
  archivedAt: string,
): DaemonSystemTransition<DaemonProjectAuthorityRevocationResult> {
  return (state) => {
    const revocations: DaemonStoreMutation[] = [];
    const workspaceIds = new Set<string>();
    const sessionIds = new Set<string>();
    const retiredProjectIds = new Set<string>();
    const retireProject = (projectId: string): void => {
      if (retiredProjectIds.has(projectId)) return;
      retiredProjectIds.add(projectId);
      const project = state.snapshot.projects.find((candidate) => candidate.id === projectId);
      if (!project || project.source !== 'native') return;
      revocations.push(...planDaemonProjectRevocation(state.snapshot, projectId, archivedAt));
      for (const workspace of state.snapshot.workspaces) {
        if (workspace.projectId === projectId) workspaceIds.add(workspace.id);
      }
      for (const session of state.snapshot.sessions) {
        if (session.projectId === projectId) sessionIds.add(session.id);
      }
    };

    const target = state.snapshot.projects.find((project) => project.id === nextProjectId);
    if (!previous || previous.id !== nextProjectId) {
      if (previous) retireProject(previous.id);
      if (target?.source === 'native') retireProject(nextProjectId);
    } else if (target?.source === 'native' && target.archivedAt !== undefined) {
      retireProject(nextProjectId);
    } else {
      const removedRootPaths = previous.rootPaths.filter((rootPath) => (
        !nextRootPaths.some((candidate) => pathKey(candidate) === pathKey(rootPath))
      ));
      const rootRevocations = planDaemonProjectRootRevocation(
        state.snapshot,
        previous.id,
        removedRootPaths,
        archivedAt,
      );
      revocations.push(...rootRevocations);
      for (const mutation of rootRevocations) {
        if (mutation.kind === 'workspace.upsert') workspaceIds.add(mutation.value.id);
      }
      for (const session of state.snapshot.sessions) {
        if (workspaceIds.has(session.workspaceId)) sessionIds.add(session.id);
      }
    }
    return authorityRetirementPlan(
      state,
      revocations,
      workspaceIds,
      sessionIds,
      archivedAt,
    );
  };
}

/** Archive only the daemon Workspace backed by one explicitly revoked
 * external-worktree grant. Existing sessions may finish, but no new structured
 * Agent can target the archived capability.
 */
export function planDaemonWorkspaceRevocation(
  snapshot: Pick<DaemonSnapshot, 'workspaces'>,
  target: ProjectWorkspaceAccessRequest,
  archivedAt: string,
): readonly DaemonStoreMutation[] {
  const workspaceId = daemonWorkspaceId(target.projectId, target.rootId, target.workspaceId);
  const sourceWorkspaceId = daemonWorkspaceId(target.projectId, target.rootId, target.rootId);
  const current = snapshot.workspaces.find((workspace) => workspace.id === workspaceId);
  if (!current || current.archivedAt !== undefined) return [];
  if (
    current.projectId !== target.projectId
    || current.kind !== 'worktree'
    || current.sourceWorkspaceId !== sourceWorkspaceId
  ) {
    throw new Error(`Revoked daemon Workspace ${workspaceId} does not match its Project grant.`);
  }
  return [{
    kind: 'workspace.upsert',
    value: {
      id: current.id,
      projectId: current.projectId,
      name: current.name,
      kind: current.kind,
      rootPath: current.rootPath,
      sourceWorkspaceId,
      archivedAt,
    },
  }];
}

export function daemonWorkspaceRevocationCommit(
  target: ProjectWorkspaceAccessRequest,
  archivedAt: string,
): (snapshot: DaemonSnapshot) => DaemonStoreCommit | undefined {
  return (snapshot) => {
    const mutations = planDaemonWorkspaceRevocation(snapshot, target, archivedAt);
    return mutations.length > 0 ? { mutations } : undefined;
  };
}

export function daemonWorkspaceRevocationTransition(
  target: ProjectWorkspaceAccessRequest,
  archivedAt: string,
): DaemonSystemTransition<{ readonly sessionIds: readonly string[] }> {
  return (state) => {
    const workspaceId = daemonWorkspaceId(target.projectId, target.rootId, target.workspaceId);
    const workspaceIds = new Set([workspaceId]);
    const sessionIds = new Set(state.snapshot.sessions
      .filter((session) => (
        session.projectId === target.projectId && session.workspaceId === workspaceId
      ))
      .map((session) => session.id));
    return {
      commit: {
        mutations: [
          ...planDaemonWorkspaceRevocation(state.snapshot, target, archivedAt),
          ...automationRetirementMutations(state, workspaceIds, archivedAt),
          ...heartbeatRetirementMutations(state, sessionIds),
        ],
      },
      value: { sessionIds: [...sessionIds] },
    };
  };
}

/** Translate one renderer-facing Project descriptor into daemon identities. */
export function daemonProjectSyncDescriptor(
  summary: AgentProjectSummary,
  descriptor: ProjectWorkspaceDescriptor,
): DaemonProjectSyncDescriptor {
  if (summary.projectId !== descriptor.projectId) {
    throw new Error('Agent Project and Workspace descriptor identities do not match.');
  }
  const primaryRoot = descriptor.roots.find((root) => root.primary) ?? descriptor.roots[0];
  if (!primaryRoot || pathKey(primaryRoot.displayPath) !== pathKey(summary.primaryRoot)) {
    throw new Error(`Agent Project ${summary.projectId} has no matching primary root.`);
  }
  const translated = resolvedDaemonProjectSyncDescriptor(descriptor);
  return { ...translated, name: summary.name };
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

/**
 * Idempotent bridge from the established Agent Project index into the v12
 * daemon authority. Complete per-root discovery may tombstone a missing
 * worktree launch capability; unavailable discovery fails before mutation
 * when that root still owns active child authority. Legacy descriptors with
 * no provenance remain refresh-only.
 */
export function planDaemonProjectSync(
  snapshot: Pick<DaemonSnapshot, 'projects' | 'workspaces'>,
  descriptors: readonly DaemonProjectSyncDescriptor[],
  options: DaemonProjectSyncOptions = {},
): readonly DaemonStoreMutation[] {
  const projectIds = new Set<string>();
  const workspaceIds = new Set<string>();
  for (const descriptor of descriptors) {
    if (!descriptor.id.trim() || descriptor.id.length > 256 || projectIds.has(descriptor.id)) {
      throw new Error(`Duplicate or invalid daemon Project id: ${descriptor.id}`);
    }
    if (!descriptor.name.trim() || !path.isAbsolute(descriptor.rootPath)) {
      throw new Error(`Daemon Project ${descriptor.id} is incomplete.`);
    }
    projectIds.add(descriptor.id);
    for (const workspace of descriptor.workspaces) {
      if (!workspace.id.trim() || workspace.id.length > 256 || workspaceIds.has(workspace.id)) {
        throw new Error(`Duplicate or invalid daemon Workspace id: ${workspace.id}`);
      }
      if (!workspace.name.trim() || !path.isAbsolute(workspace.rootPath)) {
        throw new Error(`Daemon Workspace ${workspace.id} is incomplete.`);
      }
      workspaceIds.add(workspace.id);
    }
    if (descriptor.workspaceDiscovery) {
      const sourceWorkspaceIds = new Set<string>();
      for (const discovery of descriptor.workspaceDiscovery.roots) {
        if (
          sourceWorkspaceIds.has(discovery.sourceWorkspaceId)
          || !descriptor.workspaces.some((workspace) => (
            workspace.id === discovery.sourceWorkspaceId
            && workspace.sourceWorkspaceId === undefined
          ))
        ) {
          throw new Error(`Daemon Project ${descriptor.id} has invalid Workspace discovery provenance.`);
        }
        sourceWorkspaceIds.add(discovery.sourceWorkspaceId);
        if (
          discovery.status === 'unavailable'
          && snapshot.workspaces.some((workspace) => (
            workspace.projectId === descriptor.id
            && workspace.kind === 'worktree'
            && workspace.sourceWorkspaceId === discovery.sourceWorkspaceId
            && workspace.archivedAt === undefined
          ))
        ) {
          throw new DaemonProjectWorkspaceDiscoveryError(
            descriptor.id,
            discovery.sourceWorkspaceId,
            discovery.error,
          );
        }
      }
    }
  }

  const availableWorkspaceIds = new Set([
    ...snapshot.workspaces.map((workspace) => workspace.id),
    ...workspaceIds,
  ]);
  const mutations: DaemonStoreMutation[] = [];
  let generatedArchivedAt: string | undefined;
  const archivedAt = (): string => {
    generatedArchivedAt ??= options.archivedAt ?? new Date().toISOString();
    return generatedArchivedAt;
  };
  for (const descriptor of descriptors) {
    const currentProject = snapshot.projects.find((project) => project.id === descriptor.id);
    const explicitProjectReactivation = options.reactivateProjectIds?.has(descriptor.id) === true;
    const legacyImportMayMigrate = currentProject?.source === 'legacy-import';
    if (
      currentProject?.source === 'native'
      && currentProject.archivedAt !== undefined
      && !explicitProjectReactivation
    ) {
      // A native archive is a durable tombstone. Ambient discovery and a
      // partial cleanup retry must never turn authority back on implicitly.
      continue;
    }
    if (
      !currentProject
      || currentProject.name !== descriptor.name
      || currentProject.source !== 'native'
      || currentProject.archivedAt !== undefined
      || !currentProject.rootPath
      || pathKey(currentProject.rootPath) !== pathKey(descriptor.rootPath)
    ) {
      mutations.push({ kind: 'project.upsert', value: {
        id: descriptor.id,
        name: descriptor.name,
        rootPath: descriptor.rootPath,
        source: 'native',
      } });
    }
    for (const workspace of descriptor.workspaces) {
      if (workspace.sourceWorkspaceId && !availableWorkspaceIds.has(workspace.sourceWorkspaceId)) {
        throw new Error(`Daemon Workspace ${workspace.id} has an unknown source Workspace.`);
      }
      const current = snapshot.workspaces.find((candidate) => candidate.id === workspace.id);
      if (
        current?.archivedAt !== undefined
        && !legacyImportMayMigrate
        && options.reactivateWorkspaceIds?.has(workspace.id) !== true
      ) {
        continue;
      }
      const sourceMatches = current?.sourceWorkspaceId === workspace.sourceWorkspaceId;
      if (
        current
        && current.projectId === descriptor.id
        && current.name === workspace.name
        && current.kind === workspace.kind
        && current.archivedAt === undefined
        && pathKey(current.rootPath) === pathKey(workspace.rootPath)
        && sourceMatches
      ) continue;
      mutations.push({ kind: 'workspace.upsert', value: {
        id: workspace.id,
        projectId: descriptor.id,
        name: workspace.name,
        kind: workspace.kind,
        rootPath: workspace.rootPath,
        ...(workspace.sourceWorkspaceId ? { sourceWorkspaceId: workspace.sourceWorkspaceId } : {}),
      } });
    }
    const authoritativeSourceWorkspaceIds = new Set(
      descriptor.workspaceDiscovery?.roots
        .filter((discovery) => discovery.status === 'complete')
        .map((discovery) => discovery.sourceWorkspaceId) ?? [],
    );
    if (authoritativeSourceWorkspaceIds.size > 0) {
      const expectedWorkspaceIds = new Set(descriptor.workspaces.map((workspace) => workspace.id));
      for (const current of snapshot.workspaces) {
        if (
          current.projectId !== descriptor.id
          || current.kind !== 'worktree'
          || current.archivedAt !== undefined
          || !current.sourceWorkspaceId
          || !authoritativeSourceWorkspaceIds.has(current.sourceWorkspaceId)
          || expectedWorkspaceIds.has(current.id)
        ) continue;
        mutations.push({ kind: 'workspace.upsert', value: {
          id: current.id,
          projectId: current.projectId,
          name: current.name,
          kind: current.kind,
          rootPath: current.rootPath,
          sourceWorkspaceId: current.sourceWorkspaceId,
          archivedAt: archivedAt(),
        } });
      }
    }
  }
  return mutations;
}
