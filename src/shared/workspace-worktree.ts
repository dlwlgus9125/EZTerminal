import type { DaemonSnapshot } from './daemon-protocol';

/**
 * A planning run's task worktree (`planning-run-service` registers it). The run
 * owns it and integrates it through its own review, so it is not offered as a
 * place to work or merge from the sidebar.
 */
export function isRunOwnedWorkspace(workspaceId: string): boolean {
  return workspaceId.startsWith('planning-workspace-');
}

/**
 * What cleaning up a worktree touches in these workspaces: the chats to archive (not a provider's
 * own subagents, which follow their parent) and whether anything is still running there. Agents
 * are busy with a turn in flight, queued or awaiting approval; any other live session (terminal,
 * script, service) is busy because it keeps the folder open. A terminal's record outlives its
 * process, so `liveTerminals` (when known) says which terminals still run.
 */
export function worktreeCleanupScope(
  snapshot: DaemonSnapshot,
  workspaceIds: ReadonlySet<string>,
  liveTerminals?: ReadonlySet<string>,
): { readonly chats: readonly string[]; readonly busy: boolean } {
  const settled = new Set(['completed', 'interrupted', 'failed', 'archived']);
  const providerNative = new Set(snapshot.agentRelations.filter((relation) => relation.owner === 'provider-native' && relation.detachedAt === undefined)
    .map((relation) => relation.childSessionId));
  const chats: string[] = [];
  let busy = false;
  for (const session of snapshot.sessions) {
    if (!workspaceIds.has(session.workspaceId) || session.archivedAt !== undefined || session.state === 'archived') continue;
    if (session.kind !== 'agent') {
      const gone = session.kind === 'terminal' && session.source === 'legacy-pty' && liveTerminals !== undefined && !liveTerminals.has(session.id);
      if (!gone && !settled.has(session.state)) busy = true;
      continue;
    }
    const agent = snapshot.agents.find((entry) => entry.sessionId === session.id);
    if (!agent || agent.state === 'archived') continue;
    if (agent.currentTurnId !== undefined || agent.queuedTurnCount > 0
      || snapshot.turns.some((turn) => turn.sessionId === session.id && !['completed', 'interrupted', 'failed'].includes(turn.state))
      || snapshot.approvals.some((approval) => approval.sessionId === session.id && approval.state === 'pending')) busy = true;
    if (!providerNative.has(session.id)) chats.push(session.id);
  }
  return { chats, busy };
}

/** Desktop worktree workspaces: what the renderer asks the main process for. */
export type WorkspaceWorktreeIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'invalid' | 'dirty-worktree' | 'dirty-main' | 'nothing-to-merge' | 'conflict' | 'not-a-branch' | 'git-failed' | 'in-use' | 'not-merged';
      readonly message: string;
    };

export interface WorkspaceWorktreeStatusView {
  readonly workspaceId: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly merged: boolean;
  readonly status?: 'review' | 'done';
}

export interface WorkspaceWorktreeAccess {
  create(projectId: string, branch: string): Promise<WorkspaceWorktreeIpcResult<{ readonly workspaceId: string }>>;
  status(projectId: string): Promise<WorkspaceWorktreeIpcResult<readonly WorkspaceWorktreeStatusView[]>>;
  commit(workspaceId: string, message: string): Promise<WorkspaceWorktreeIpcResult<{ readonly commit: string }>>;
  merge(workspaceId: string): Promise<WorkspaceWorktreeIpcResult<{ readonly into: string; readonly commit: string }>>;
  /** Removes a merged worktree: archives its chats, deletes the folder and the merged branch. */
  remove(workspaceId: string): Promise<WorkspaceWorktreeIpcResult<RemovedWorkspaceWorktree>>;
}

export interface RemovedWorkspaceWorktree {
  readonly branch?: string;
  readonly branchDeleted: boolean;
  readonly archivedChats: number;
  /** What did not go as planned but did not stop the cleanup. */
  readonly notes: readonly string[];
}
