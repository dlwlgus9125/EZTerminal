import { createHash } from 'node:crypto';
import path from 'node:path';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { SessionInfo } from '../shared/ipc';

export interface LegacyTerminalProjectHint {
  readonly projectId: string;
  readonly name: string;
  readonly rootPath: string;
}

export interface LegacyTerminalRegistrationPlan {
  readonly projects: readonly {
    readonly projectId: string;
    readonly name: string;
    readonly rootPath: string;
  }[];
  readonly workspaces: readonly {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly name: string;
    readonly rootPath: string;
  }[];
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly createdAt?: number;
  }[];
}

export interface LegacyTerminalRegistrationOptions {
  readonly resolveProject?: (cwd: string) => LegacyTerminalProjectHint | undefined;
}

function canonicalWindowsPath(value: string): string {
  const resolved = path.win32.resolve(value.trim()).replace(/[\\/]+$/u, '');
  return resolved.toLocaleLowerCase('en-US');
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function displayName(rootPath: string): string {
  return path.win32.basename(path.win32.resolve(rootPath)) || rootPath;
}

/**
 * Produces an idempotent import plan. It never mutates or removes the legacy
 * interpreter directory; callers transact only entries absent from snapshot.
 */
export function planLegacyTerminalRegistrations(
  legacySessions: readonly SessionInfo[],
  snapshot: Pick<DaemonSnapshot, 'projects' | 'workspaces' | 'sessions'>,
  options: LegacyTerminalRegistrationOptions = {},
): LegacyTerminalRegistrationPlan {
  const existingSessionIds = new Set(snapshot.sessions.map((session) => session.id));
  const projectsByRoot = new Map(
    snapshot.projects
      .filter((project): project is typeof project & { readonly rootPath: string } => Boolean(project.rootPath))
      .map((project) => [canonicalWindowsPath(project.rootPath), project]),
  );
  const workspacesByRoot = new Map(
    snapshot.workspaces.map((workspace) => [canonicalWindowsPath(workspace.rootPath), workspace]),
  );

  const plannedProjects = new Map<string, LegacyTerminalRegistrationPlan['projects'][number]>();
  const plannedWorkspaces = new Map<string, LegacyTerminalRegistrationPlan['workspaces'][number]>();
  const plannedSessions: LegacyTerminalRegistrationPlan['sessions'][number][] = [];

  for (const legacy of legacySessions) {
    if (!legacy.sessionId.trim() || !legacy.cwd.trim() || existingSessionIds.has(legacy.sessionId)) continue;

    const rootKey = canonicalWindowsPath(legacy.cwd);
    const existingWorkspace = workspacesByRoot.get(rootKey);
    let projectId = existingWorkspace?.projectId;
    let workspaceId = existingWorkspace?.id;

    if (!workspaceId) {
      const hint = options.resolveProject?.(legacy.cwd);
      const existingProject = projectsByRoot.get(rootKey);
      projectId = hint?.projectId ?? existingProject?.id ?? stableId('legacy-project', rootKey);
      workspaceId = stableId('legacy-workspace', `${projectId}\0${rootKey}`);

      if (!existingProject && !snapshot.projects.some((project) => project.id === projectId)) {
        plannedProjects.set(projectId, {
          projectId,
          name: hint?.name ?? displayName(legacy.cwd),
          rootPath: hint?.rootPath ?? path.win32.resolve(legacy.cwd),
        });
      }
      plannedWorkspaces.set(workspaceId, {
        workspaceId,
        projectId,
        name: 'Local',
        rootPath: path.win32.resolve(legacy.cwd),
      });
    }

    plannedSessions.push({
      sessionId: legacy.sessionId,
      workspaceId,
      title: `Terminal · ${displayName(legacy.cwd)}`,
      ...(legacy.createdAt === undefined ? {} : { createdAt: legacy.createdAt }),
    });
    existingSessionIds.add(legacy.sessionId);
  }

  return {
    projects: [...plannedProjects.values()],
    workspaces: [...plannedWorkspaces.values()],
    sessions: plannedSessions,
  };
}
