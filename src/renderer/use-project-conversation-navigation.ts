import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationEntry, ConversationHistoryClient } from '../shared/conversation-history';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { WorkflowNavigationAccess, WorkflowNavigationSnapshot } from '../shared/workflow';
import { isDaemonSessionArchived, isStructuredDaemonAgentSession } from '../shared/daemon-session-visibility';
import { projectConversationTree, type ProjectNavigationConversation, type ProjectNavigationProject } from './project-conversation-tree-model';

export interface ProjectConversationNavigationAccess {
  readonly listConversations?: ConversationHistoryClient['listConversations'];
  readonly getWorkflowNavigation?: WorkflowNavigationAccess['getWorkflowNavigation'];
}

interface ProjectLoadState { readonly loading?: boolean; readonly error?: string; readonly hasMore?: boolean }

/** Loads list metadata on demand. Reading the hierarchy never reads a transcript or starts an Agent. */
export function useProjectConversationNavigation({ projects, snapshot, access, connected = true, active = true, scope, includeTerminals = false }: {
  readonly projects: readonly ProjectNavigationProject[];
  readonly snapshot?: DaemonSnapshot | null;
  readonly access: ProjectConversationNavigationAccess;
  readonly connected?: boolean;
  readonly active?: boolean;
  readonly scope: string;
  readonly includeTerminals?: boolean;
}): {
  readonly nodes: ReturnType<typeof projectConversationTree>;
  readonly entries: ReadonlyMap<string, ConversationEntry>;
  readonly projectStatus: Readonly<Record<string, ProjectLoadState>>;
  readonly inspectProject: (projectId: string) => void;
  readonly collapseProject: (projectId: string) => void;
  readonly searchAll: (query: string) => void;
  readonly loadMore: (projectId: string) => void;
  readonly loadMoreSearch: () => void;
  readonly searchStatus: ProjectLoadState;
} {
  const [workflows, setWorkflows] = useState<Readonly<Record<string, WorkflowNavigationSnapshot>>>({});
  const [entries, setEntries] = useState<ReadonlyMap<string, ConversationEntry>>(new Map());
  const [projectStatus, setProjectStatus] = useState<Readonly<Record<string, ProjectLoadState>>>({});
  const [searchStatus, setSearchStatus] = useState<ProjectLoadState>({});
  const generation = useRef(0);
  const mounted = useRef(true);
  const cursors = useRef(new Map<string, string | null>());
  const pending = useRef(new Map<string, Promise<void>>());
  const inspected = useRef(new Set<string>());
  const visibleProjects = useRef(new Set<string>());
  const query = useRef('');
  const searchCursor = useRef<string | null>(null);
  const searchGeneration = useRef(0);
  const projectsRef = useRef(projects); projectsRef.current = projects;
  useLayoutEffect(() => {
    mounted.current = true;
    generation.current += 1;
    setWorkflows({}); setEntries(new Map()); setProjectStatus({}); setSearchStatus({});
    cursors.current.clear(); pending.current.clear(); inspected.current.clear(); visibleProjects.current.clear();
    return () => { mounted.current = false; generation.current += 1; };
  }, [scope]);

  const load = useCallback((projectId: string, more = false, quiet = false): Promise<void> => {
    if (!connected || !active) return Promise.resolve();
    const inFlight = pending.current.get(projectId);
    if (inFlight) return inFlight;
    const expected = generation.current;
    inspected.current.add(projectId);
    if (!quiet) setProjectStatus(current => ({ ...current, [projectId]: { ...current[projectId], loading: true, error: undefined } }));
    const request = (async (): Promise<void> => {
      const [conversations, workflow] = await Promise.allSettled([
        access.listConversations?.({ projectId, archived: 'include', limit: 100, ...(more && cursors.current.get(projectId) ? { cursor: cursors.current.get(projectId)! } : {}) }),
        more ? undefined : access.getWorkflowNavigation?.(projectId),
      ]);
      if (!mounted.current || expected !== generation.current) return;
      const failures: string[] = [];
      if (conversations.status === 'fulfilled' && conversations.value) {
        const result = conversations.value;
        if (result.ok) {
          cursors.current.set(projectId, result.nextCursor);
          setEntries(current => {
            const next = new Map(current);
            if (!more && !result.nextCursor) for (const [id, entry] of next) if (entry.projectId === projectId) next.delete(id);
            for (const entry of result.items) {
              for (const alias of entry.aliases ?? []) next.delete(alias);
              next.set(entry.conversationId, entry);
            }
            return next;
          });
        } else failures.push(result.message);
      } else if (conversations.status === 'rejected') failures.push(String(conversations.reason));
      if (workflow.status === 'fulfilled' && workflow.value) {
        if (workflow.value.ok) { const next = workflow.value.snapshot; setWorkflows(current => ({ ...current, [projectId]: next })); }
        else failures.push(workflow.value.message);
      } else if (workflow.status === 'rejected') failures.push(String(workflow.reason));
      setProjectStatus(current => ({ ...current, [projectId]: { loading: false, hasMore: Boolean(cursors.current.get(projectId)), error: failures.length ? failures.join(' ') : undefined } }));
    })().finally(() => { if (expected === generation.current) pending.current.delete(projectId); });
    pending.current.set(projectId, request);
    return request;
  }, [access, active, connected]);
  const inspectProject = useCallback((projectId: string) => { visibleProjects.current.add(projectId); void load(projectId); }, [load]);
  const collapseProject = useCallback((projectId: string) => { visibleProjects.current.delete(projectId); }, []);
  const loadMore = useCallback((projectId: string) => { void load(projectId, true); }, [load]);

  const search = useCallback(async (nextQuery: string, more = false): Promise<void> => {
    query.current = nextQuery;
    if (!connected || !active) return;
    const expected = generation.current;
    const searchId = ++searchGeneration.current;
    setSearchStatus({ loading: true });
    try {
      const result = await access.listConversations?.({ query: nextQuery, archived: 'include', limit: 100, ...(more && searchCursor.current ? { cursor: searchCursor.current } : {}) });
      if (!mounted.current || expected !== generation.current || searchId !== searchGeneration.current) return;
      if (result && !result.ok) { setSearchStatus({ error: result.message }); return; }
      if (result?.ok) {
        searchCursor.current = result.nextCursor;
        setEntries(current => { const next = new Map(current); for (const entry of result.items) { for (const alias of entry.aliases ?? []) next.delete(alias); next.set(entry.conversationId, entry); } return next; });
      }
      setSearchStatus({ hasMore: Boolean(result?.ok && result.nextCursor) });
    } catch (reason) {
      if (mounted.current && expected === generation.current && searchId === searchGeneration.current) setSearchStatus({ error: String(reason) });
    }
    // Workflow titles are local project metadata. Limit concurrent reads and never fetch transcripts.
    const remaining = projectsRef.current.filter(project => !inspected.current.has(project.id));
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, remaining.length) }, async () => {
      while (index < remaining.length && mounted.current && expected === generation.current) {
        const project = remaining[index++];
        await load(project.id, false, true);
      }
    }));
  }, [access, active, connected, load]);
  const searchAll = useCallback((nextQuery: string) => { void search(nextQuery); }, [search]);
  const sessionIdentity = snapshot?.agents.map(agent => `${agent.sessionId}:${agent.state}`).join('|');
  useEffect(() => {
    const refresh = () => { for (const id of visibleProjects.current) void load(id, false, true); };
    const timer = window.setTimeout(refresh, 100);
    window.addEventListener('ez:conversation-navigation', refresh);
    return () => { window.clearTimeout(timer); window.removeEventListener('ez:conversation-navigation', refresh); };
  }, [sessionIdentity, load]);
  const loadMoreSearch = useCallback(() => { void search(query.current, true); }, [search]);
  useEffect(() => {
    if (!active || !connected) return;
    const refresh = (): void => {
      for (const id of visibleProjects.current) void load(id, false, true);
    };
    window.addEventListener('focus', refresh);
    // The workflow store does not publish daemon entity events. Refresh only while this navigation is visible.
    const timer = window.setInterval(() => {
      const expected = generation.current;
      for (const projectId of visibleProjects.current) void access.getWorkflowNavigation?.(projectId).then(result => {
        if (mounted.current && expected === generation.current && result.ok) setWorkflows(current => current[projectId]?.registryRevision === result.snapshot.registryRevision ? current : { ...current, [projectId]: result.snapshot });
      }).catch(() => undefined);
    }, 10_000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(timer); };
  }, [access, active, connected, load]);

  const nodes = useMemo(() => {
    const knownProjects = new Map(projects.map(project => [project.id, project]));
    for (const project of snapshot?.projects ?? []) if (!knownProjects.has(project.id) && !project.archivedAt) knownProjects.set(project.id, { id: project.id, title: project.name, rootPath: project.rootPath, updatedAt: Date.parse(project.updatedAt) });
    for (const entry of entries.values()) if (!knownProjects.has(entry.projectId)) knownProjects.set(entry.projectId, { id: entry.projectId, title: entry.projectTitle, updatedAt: entry.updatedAt });
    const agents = new Map((snapshot?.agents ?? []).map(agent => [agent.sessionId, agent]));
    const sessions = new Map((snapshot?.sessions ?? []).map(session => [session.id, session]));
    const linked = new Set([...entries.values()].flatMap(entry => [entry.linkedSessionId, ...(entry.sessionAliases ?? [])]).filter(Boolean));
    // A resumed conversation keeps its earlier sessions as aliases; their subagents nest under it.
    const current = new Map([...entries.values()].flatMap(entry => entry.linkedSessionId
      ? (entry.sessionAliases ?? []).map(alias => [alias, entry.linkedSessionId!] as const) : []));
    const parents = new Map<string, string>();
    for (const relation of snapshot?.agentRelations ?? []) {
      if (relation.detachedAt === undefined) parents.set(relation.childSessionId, current.get(relation.parentSessionId) ?? relation.parentSessionId);
    }
    const conversations: ProjectNavigationConversation[] = [...entries.values()].map(entry => {
      const session = entry.linkedSessionId ? sessions.get(entry.linkedSessionId) : undefined;
      const agent = entry.linkedSessionId ? agents.get(entry.linkedSessionId) : undefined;
      const current = session && Date.parse(session.updatedAt) >= entry.updatedAt ? session : undefined;
      return {
        id: entry.conversationId, projectId: entry.projectId, title: current?.title ?? entry.title, updatedAt: current ? Date.parse(current.updatedAt) : entry.updatedAt,
        source: entry.source === 'native' ? 'native' : entry.subprojectId ? 'stage' : 'agent',
        providerLabel: entry.providerId === 'claude' ? 'Claude' : entry.providerId === 'codex' ? 'Codex' : entry.providerId,
        sessionId: entry.linkedSessionId, subprojectId: entry.subprojectId, subprojectTitle: entry.subprojectTitle, nodeId: entry.nodeId, nodeTitle: entry.nodeTitle,
        archived: current ? isDaemonSessionArchived(current, agent) : entry.archived, status: current ? agent?.state ?? current.state : entry.state,
        parentSessionId: entry.linkedSessionId ? parents.get(entry.linkedSessionId) : undefined,
        workspaceId: session?.workspaceId ?? entry.workspaceId,
      };
    });
    for (const session of snapshot?.sessions ?? []) {
      if (!isStructuredDaemonAgentSession(session) || linked.has(session.id)) continue;
      const agent = agents.get(session.id);
      conversations.push({ id: `session:${session.id}`, projectId: session.projectId, title: session.title,
        updatedAt: Date.parse(session.updatedAt), source: 'agent', providerLabel: agent?.providerId === 'claude' ? 'Claude' : agent?.providerId === 'codex' ? 'Codex' : agent?.providerId ?? '',
        sessionId: session.id, archived: isDaemonSessionArchived(session, agent), status: agent?.state ?? session.state, parentSessionId: parents.get(session.id),
        workspaceId: session.workspaceId });
    }
    return projectConversationTree({ projects: [...knownProjects.values()], conversations, workflows,
      workspaces: (snapshot?.workspaces ?? []).map(workspace => ({
        id: workspace.id, projectId: workspace.projectId, title: workspace.name, kind: workspace.kind,
        archived: Boolean(workspace.archivedAt), updatedAt: Date.parse(workspace.updatedAt),
      })),
      terminals: (includeTerminals ? snapshot?.sessions ?? [] : []).filter(session => session.kind === 'terminal').map(session => ({
        id: session.id, projectId: session.projectId, title: session.title, updatedAt: Date.parse(session.updatedAt),
        archived: Boolean(session.archivedAt) || ['completed', 'interrupted', 'failed'].includes(session.state),
      })) });
  }, [projects, snapshot, entries, workflows, includeTerminals]);
  return { nodes, entries, projectStatus, inspectProject, collapseProject, searchAll, loadMore, loadMoreSearch, searchStatus };
}
