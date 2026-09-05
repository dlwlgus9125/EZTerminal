import path from 'node:path';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { ProjectWorkspaceError } from '../shared/project-workspace';

type ProjectPathResolution =
  | { readonly ok: true; readonly request: { readonly projectId: string } }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export interface AgentProjectObservation {
  readonly cwd: string;
  readonly updatedAt: number;
}

export interface AgentProjectObservationOptions {
  readonly resolvePath: (absolutePath: string) => Promise<ProjectPathResolution>;
  readonly touchProject: (projectId: string, updatedAt: number) => Promise<boolean>;
  readonly recordProject: (canonicalRoot: string, updatedAt: number) => Promise<void>;
  readonly canonicalizeDirectory: (absolutePath: string) => Promise<string | null>;
  readonly getDaemonSnapshot: () => Pick<DaemonSnapshot, 'projects' | 'workspaces'>;
  readonly syncProjects: () => Promise<void>;
}

type DaemonPathAuthority = 'active' | 'revoked' | 'unknown';

function containsPath(rootPath: string, candidatePath: string): boolean {
  if (!path.isAbsolute(rootPath) || !path.isAbsolute(candidatePath)) return false;
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/** Resolve the most-specific durable daemon authority for a canonical path.
 * Active records win exact ties so an explicit re-add clears its tombstone;
 * a more-specific revoked Workspace still blocks fallback through its Project.
 */
export function classifyDaemonPathAuthority(
  snapshot: Pick<DaemonSnapshot, 'projects' | 'workspaces'>,
  canonicalPath: string,
): DaemonPathAuthority {
  const nativeProjects = new Map(
    snapshot.projects
      .filter((project) => project.source === 'native')
      .map((project) => [project.id, project]),
  );
  const activeProjectIds = new Set(
    [...nativeProjects.values()]
      .filter((project) => project.archivedAt === undefined)
      .map((project) => project.id),
  );
  const candidates: Array<{
    readonly rootPath: string;
    readonly authority: Exclude<DaemonPathAuthority, 'unknown'>;
  }> = [];
  for (const project of nativeProjects.values()) {
    if (!project.rootPath || !containsPath(project.rootPath, canonicalPath)) continue;
    candidates.push({
      rootPath: project.rootPath,
      authority: project.archivedAt === undefined ? 'active' : 'revoked',
    });
  }
  for (const workspace of snapshot.workspaces) {
    if (!nativeProjects.has(workspace.projectId)) continue;
    if (!containsPath(workspace.rootPath, canonicalPath)) continue;
    candidates.push({
      rootPath: workspace.rootPath,
      authority: workspace.archivedAt === undefined && activeProjectIds.has(workspace.projectId)
        ? 'active'
        : 'revoked',
    });
  }
  candidates.sort((left, right) => (
    path.normalize(right.rootPath).length - path.normalize(left.rootPath).length
    || Number(right.authority === 'active') - Number(left.authority === 'active')
  ));
  return candidates[0]?.authority ?? 'unknown';
}

/** Record one provider observation while the caller holds the Project mutation
 * FIFO. Only a definitively unknown path may become a terminal-origin Project;
 * authorization failures, transient resolution failures, and archive
 * tombstones never turn into ambient authority grants.
 */
export async function recordAgentProjectObservation(
  observation: AgentProjectObservation,
  options: AgentProjectObservationOptions,
): Promise<'updated' | 'imported' | 'ignored'> {
  const resolved = await options.resolvePath(observation.cwd);
  if (resolved.ok) {
    const touched = await options.touchProject(resolved.request.projectId, observation.updatedAt);
    if (!touched) return 'ignored';
    await options.syncProjects();
    return 'updated';
  }
  if (resolved.error !== 'path-outside-root') return 'ignored';

  const canonicalRoot = await options.canonicalizeDirectory(observation.cwd);
  if (!canonicalRoot) return 'ignored';
  if (classifyDaemonPathAuthority(options.getDaemonSnapshot(), canonicalRoot) !== 'unknown') {
    return 'ignored';
  }
  await options.recordProject(canonicalRoot, observation.updatedAt);
  await options.syncProjects();
  return 'imported';
}
