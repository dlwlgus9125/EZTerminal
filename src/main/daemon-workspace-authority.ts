import type { DaemonSnapshot, DaemonWorkspace } from '../shared/daemon-protocol';

type DaemonWorkspaceAuthoritySnapshot = Pick<DaemonSnapshot, 'projects' | 'workspaces'>;

/**
 * Resolves a launch-capable Workspace only while its complete ownership chain
 * remains active. The optional Project id binds an existing Session to the
 * same authority rather than trusting either persisted record independently.
 */
export function findActiveDaemonWorkspace(
  snapshot: DaemonWorkspaceAuthoritySnapshot,
  workspaceId: string,
  projectId?: string,
): DaemonWorkspace | undefined {
  const workspace = snapshot.workspaces.find((entry) => (
    entry.id === workspaceId
    && entry.archivedAt === undefined
    && (projectId === undefined || entry.projectId === projectId)
  ));
  if (!workspace) return undefined;
  return snapshot.projects.some((entry) => (
    entry.id === workspace.projectId && entry.archivedAt === undefined
  )) ? workspace : undefined;
}
