import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentProjectSummary } from '../shared/agent-history';
import type { ConversationEntry } from '../shared/conversation-history';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { daemonEventAffectsAgentSessionProjection, type DaemonAgentSessionListAccess, type DaemonAgentSessionOpenInput } from './DaemonAgentSessions';
import { ProjectConversationTree } from './ProjectConversationTree';
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
}

export function ProjectConversationNavigator({ projects, access, daemonAccess, persistenceScope = 'desktop-local', selectedSessionId, selectedConversationId, disconnected, onOpenProject, onOpenWorkflow, onOpenSession, onOpenTerminal, onOpenHistory, renderProjectActions }: ProjectConversationNavigatorProps): JSX.Element {
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
  const navigation = useProjectConversationNavigation({ projects: navigationProjects, snapshot: effectiveSnapshot, access, connected: !disconnected, scope: persistenceScope, includeTerminals: true });
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
      renderProjectActions={renderProjectActions} onOpen={target => {
        if (target.kind === 'conversation') {
          const entry = navigation.entries.get(target.conversationId);
          if (entry && onOpenHistory) onOpenHistory(entry);
          else if (target.sessionId) onOpenSession({ sessionId: target.sessionId, title: entry?.title, providerLabel: entry?.providerId });
        } else if (target.kind === 'terminal') onOpenTerminal(target.sessionId);
        else {
          const project = projectFor(target.projectId);
          if (!project) return;
          if (target.kind === 'project') onOpenProject(project);
          else onOpenWorkflow?.(project, target.subprojectId, target.kind === 'stage' ? target.nodeId : undefined);
        }
      }} />
  </>;
}
