import { createHash } from 'node:crypto';
import path from 'node:path';

import type { AgentProjectSummary } from '../shared/agent-history';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { ProjectWorkspaceDescriptor } from '../shared/project-workspace';
import type { DaemonStoreMutation } from './daemon-store';

export interface DaemonProjectSyncWorkspace {
  readonly id: string;
  readonly name: string;
  readonly kind: 'local' | 'worktree';
  readonly rootPath: string;
  readonly sourceWorkspaceId?: string;
}

export interface DaemonProjectSyncDescriptor {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly workspaces: readonly DaemonProjectSyncWorkspace[];
}

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

  const roots = new Map(descriptor.roots.map((root) => [root.rootId, root]));
  const workspaces = new Map<string, DaemonProjectSyncWorkspace>();
  for (const root of descriptor.roots) {
    const id = daemonWorkspaceId(summary.projectId, root.rootId, root.rootId);
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
    const id = daemonWorkspaceId(summary.projectId, workspace.rootId, workspace.workspaceId);
    const rootWorkspaceId = daemonWorkspaceId(summary.projectId, workspace.rootId, workspace.rootId);
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
  return {
    id: summary.projectId,
    name: summary.name,
    rootPath: primaryRoot.displayPath,
    workspaces: [...workspaces.values()],
  };
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

/**
 * Idempotent bridge from the established Agent Project index into the v12
 * daemon authority. It adds and refreshes discoverable workspaces but never
 * archives a missing checkout: sessions may still hold a durable reference.
 */
export function planDaemonProjectSync(
  snapshot: Pick<DaemonSnapshot, 'projects' | 'workspaces'>,
  descriptors: readonly DaemonProjectSyncDescriptor[],
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
  }

  const availableWorkspaceIds = new Set([
    ...snapshot.workspaces.map((workspace) => workspace.id),
    ...workspaceIds,
  ]);
  const mutations: DaemonStoreMutation[] = [];
  for (const descriptor of descriptors) {
    const currentProject = snapshot.projects.find((project) => project.id === descriptor.id);
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
  }
  return mutations;
}
