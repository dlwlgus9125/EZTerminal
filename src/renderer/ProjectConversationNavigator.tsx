import { FileDiff, GitMerge, MessageSquarePlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isRunOwnedWorkspace, type WorkspaceWorktreeStatusView } from '../shared/workspace-worktree';
import { useAppTranslation } from './i18n';
import { IconButton } from './ui';
import { WorktreeMergeDialog } from './WorktreeDialogs';
import type { AgentProjectSummary } from '../shared/agent-history';
import type { ConversationEntry } from '../shared/conversation-history';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { daemonEventAffectsAgentSessionProjection, type DaemonAgentSessionListAccess, type DaemonAgentSessionOpenInput } from './DaemonAgentSessions';
import { ProjectConversationTree } from './ProjectConversationTree';
import type { ProjectConversationNode } from './project-conversation-tree-model';
import { TerminalSessionActions } from './TerminalSessionActions';
import { useLiveTerminalSessions, withLiveTerminalSessions } from './use-live-terminal-sessions';
import { useProjectConversationNavigation, type ProjectConversationNavigationAccess } from './use-project-conversation-navigation';

export interface ProjectConversationNavigatorProps {
  readonly projects: readonly AgentProjectSummary[];
  readonly access: ProjectConversationNavigationAccess;
  readonly daemonAccess: DaemonAgentSessionListAccess;
  readonly persistenceScope?: string;
  readonly selectedSessionId?: string;
  readonly selectedConversationId?: string;
  readonly disconnected?: boolean;
  readonly onOpenProject: (project: AgentProjectSummary) => void;
  readonly onOpenWorkflow?: (project: AgentProjectSummary, subprojectId: string, nodeId?: string) => void;
  readonly onOpenSession: (input: DaemonAgentSessionOpenInput) => void;
  readonly onOpenTerminal: (sessionId: string) => void;
  readonly onOpenHistory?: (entry: ConversationEntry) => void;
  readonly renderProjectActions?: (projectId: string) => ReactNode;
  /** Start a chat in a worktree (desktop). */
  readonly onNewConversationInWorkspace?: (projectId: string, workspaceId: string) => void;
  /** Open the change review for a folder (desktop). */
  readonly onReviewDirectory?: (directory: string) => void;
}

export function ProjectConversationNavigator({ projects, access, daemonAccess, persistenceScope = 'desktop-local', selectedSessionId, selectedConversationId, disconnected, onOpenProject, onOpenWorkflow, onOpenSession, onOpenTerminal, onOpenHistory, renderProjectActions, onNewConversationInWorkspace, onReviewDirectory }: ProjectConversationNavigatorProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const text = (korean: string, english: string): string => (i18n.resolvedLanguage ?? i18n.language).startsWith('ko') ? korean : english;
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const liveTerminals = useLiveTerminalSessions(window.ezterminal);
  const effectiveSnapshot = useMemo(() => withLiveTerminalSessions(snapshot, liveTerminals), [snapshot, liveTerminals]);
  useEffect(() => {
    let alive = true;
    let pending = false;
    let queued = false;
    const refresh = async (): Promise<void> => {
      if (pending) { queued = true; return; }
      pending = true;
      try {
        const next = await daemonAccess.getSnapshot();
        if (alive) { setSnapshot(next); setError(undefined); setLoading(false); }
      } catch (reason) { if (alive) { setError(String(reason)); setLoading(false); } }
      finally { pending = false; if (alive && queued) { queued = false; void refresh(); } }
    };
    void refresh();
    const stop = daemonAccess.observeEvents(event => { if (daemonEventAffectsAgentSessionProjection(event)) void refresh(); }, () => { void refresh(); });
    return () => { alive = false; stop(); };
  }, [daemonAccess]);
  const navigationProjects = useMemo(() => projects.map(project => ({ id: project.projectId, title: project.name, rootPath: project.primaryRoot, pinned: project.pinned, updatedAt: project.lastActiveAt ?? 0 })), [projects]);
  const worktrees = window.ezterminal?.workspaceWorktrees;
  const [workspaceStatuses, setWorkspaceStatuses] = useState<Readonly<Record<string, WorkspaceWorktreeStatusView>>>({});
  // Which worktrees exist and whether a chat is running in each. Git is read again only when this
  // changes (a chat stopping is when new work appears) or when the window comes back.
  const worktreeKey = useMemo(() => {
    const busy = new Set((snapshot?.agents ?? []).filter(agent => ['starting', 'working', 'blocked', 'queued'].includes(agent.state)).map(agent => agent.sessionId));
    return (snapshot?.workspaces ?? []).filter(workspace => workspace.kind === 'worktree' && !workspace.archivedAt && !isRunOwnedWorkspace(workspace.id))
      .map(workspace => `${workspace.projectId} ${workspace.id} ${snapshot!.sessions.some(session => session.workspaceId === workspace.id && busy.has(session.id))}`)
      .sort().join(',');
  }, [snapshot]);
  const refreshWorktrees = useCallback(async (): Promise<void> => {
    const projectIds = [...new Set(worktreeKey.split(',').filter(Boolean).map(line => line.split(' ')[0]))];
    if (!worktrees || !projectIds.length) return;
    const results = await Promise.all(projectIds.map(projectId => worktrees.status(projectId).catch(() => undefined)));
    const next: Record<string, WorkspaceWorktreeStatusView> = {};
    for (const result of results) if (result?.ok) for (const status of result.value) next[status.workspaceId] = status;
    setWorkspaceStatuses(next);
  }, [worktrees, worktreeKey]);
  useEffect(() => {
    void refreshWorktrees();
    const onFocus = (): void => { void refreshWorktrees(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshWorktrees]);
  const [mergeTarget, setMergeTarget] = useState<{ readonly workspaceId: string; readonly title: string; readonly rootPath: string }>();
  const navigation = useProjectConversationNavigation({ projects: navigationProjects, snapshot: effectiveSnapshot, access, connected: !disconnected, scope: persistenceScope, includeTerminals: true, workspaceStatuses });
  const selectedEntry = [...navigation.entries.values()].find(entry => entry.conversationId === selectedConversationId || entry.aliases?.includes(selectedConversationId ?? '') || entry.linkedSessionId === selectedSessionId && !!selectedSessionId || entry.sessionAliases?.includes(selectedSessionId ?? ''));
  const selectedId = selectedEntry ? JSON.stringify(['conversation', selectedEntry.projectId, selectedEntry.linkedSessionId ? `session:${selectedEntry.linkedSessionId}` : selectedEntry.conversationId]) : selectedSessionId && snapshot?.sessions.find(session => session.id === selectedSessionId)
    ? JSON.stringify(['conversation', snapshot.sessions.find(session => session.id === selectedSessionId)!.projectId, `session:${selectedSessionId}`]) : undefined;
  const projectFor = (projectId: string): AgentProjectSummary | undefined => {
    const existing = projects.find(project => project.projectId === projectId);
    if (existing) return existing;
    const project = snapshot?.projects.find(item => item.id === projectId);
    const entry = [...navigation.entries.values()].find(item => item.projectId === projectId);
    if (!project && !entry) return undefined;
    return { projectId, name: project?.name ?? entry!.projectTitle, primaryRoot: project?.rootPath ?? entry?.roots[0] ?? '', additionalRoots: [], pinned: false, saved: Boolean(project), sessionCount: 0, providers: [], lastActiveAt: 0 };
  };
  return <>
    {error && <p role="alert">{error}</p>}
    <ProjectConversationTree nodes={navigation.nodes} persistenceScope={persistenceScope} selectedId={selectedId ?? null} loading={loading} offline={disconnected}
      projectStatus={navigation.projectStatus} searchStatus={navigation.searchStatus}
      onInspectProject={navigation.inspectProject} onCollapseProject={navigation.collapseProject} onSearchAll={navigation.searchAll} onLoadMore={navigation.loadMore} onLoadMoreSearch={navigation.loadMoreSearch}
      renderTerminalActions={(sessionId, title) => !disconnected && window.ezterminal ? <TerminalSessionActions sessionId={sessionId} title={title} access={window.ezterminal} /> : null}
      renderProjectActions={renderProjectActions}
      renderWorkspaceActions={worktrees && !disconnected ? target => {
        const workspace = snapshot?.workspaces.find(entry => entry.id === target.workspaceId);
        if (target.local || !workspace) return null;
        const name = workspaceStatuses[workspace.id]?.branch ?? workspace.name;
        return <>
          {onNewConversationInWorkspace && <IconButton icon={MessageSquarePlus} size="sm" variant="ghost" aria-label={`${text('이 작업 위치에서 새 대화', 'New chat here')}: ${name}`} onClick={() => onNewConversationInWorkspace(workspace.projectId, workspace.id)} />}
          {onReviewDirectory && <IconButton icon={FileDiff} size="sm" variant="ghost" aria-label={`${text('변경 검토', 'Review changes')}: ${name}`} onClick={() => onReviewDirectory(workspace.rootPath)} />}
          <IconButton icon={GitMerge} size="sm" variant="ghost" aria-label={`${text('병합', 'Merge')}: ${name}`} onClick={() => setMergeTarget({ workspaceId: workspace.id, title: name, rootPath: workspace.rootPath })} data-testid="workspace-merge" />
        </>;
      } : undefined}
      onOpen={target => {
        if (target.kind === 'conversation') {
          const entry = navigation.entries.get(target.conversationId);
          if (entry && onOpenHistory) onOpenHistory(entry);
          else if (target.sessionId) {
            // A subagent has no history entry; its row already knows its name.
            const node = entry ? undefined : findConversationNode(navigation.nodes, target.conversationId);
            onOpenSession({ sessionId: target.sessionId, title: entry?.title ?? node?.title, providerLabel: entry?.providerId ?? node?.providerLabel });
          }
        } else if (target.kind === 'terminal') onOpenTerminal(target.sessionId);
        else if (target.kind === 'workspace') return;
        else {
          const project = projectFor(target.projectId);
          if (!project) return;
          if (target.kind === 'project') onOpenProject(project);
          else onOpenWorkflow?.(project, target.subprojectId, target.kind === 'stage' ? target.nodeId : undefined);
        }
      }} />
    {worktrees && mergeTarget && <WorktreeMergeDialog open onOpenChange={open => { if (!open) setMergeTarget(undefined); }} title={mergeTarget.title}
      status={workspaceStatuses[mergeTarget.workspaceId]}
      onRefresh={refreshWorktrees}
      {...(onReviewDirectory ? { onReview: () => onReviewDirectory(mergeTarget.rootPath) } : {})}
      onCommit={message => worktrees.commit(mergeTarget.workspaceId, message)}
      onMerge={() => worktrees.merge(mergeTarget.workspaceId)} />}
  </>;
}

function findConversationNode(nodes: readonly ProjectConversationNode[], conversationId: string): ProjectConversationNode | undefined {
  for (const node of nodes) {
    if (node.target.kind === 'conversation' && node.target.conversationId === conversationId) return node;
    const found = node.children ? findConversationNode(node.children, conversationId) : undefined;
    if (found) return found;
  }
  return undefined;
}
