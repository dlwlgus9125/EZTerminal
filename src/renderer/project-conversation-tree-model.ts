import type { WorkflowNavigationSnapshot } from '../shared/workflow';

export interface ProjectNavigationProject {
  readonly id: string;
  readonly title: string;
  readonly rootPath?: string;
  readonly pinned?: boolean;
  readonly updatedAt?: number;
}

/** List metadata only. Transcript bodies and provider resume identifiers do not belong here. */
export interface ProjectNavigationConversation {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly source: 'agent' | 'stage' | 'native';
  readonly providerLabel: string;
  readonly sessionId?: string;
  readonly subprojectId?: string;
  readonly subprojectTitle?: string;
  readonly nodeId?: string;
  readonly nodeTitle?: string;
  readonly archived?: boolean;
  readonly status?: string;
  /** Set while this chat is an attached subagent of that session. */
  readonly parentSessionId?: string;
  /** Provider's agent kind for a provider-native subagent, e.g. Claude `Explore`. */
  readonly subagentType?: string;
  /** Daemon workspace (local checkout or worktree) the chat runs in. */
  readonly workspaceId?: string;
}

/** Where a project's chats run. Worktrees get their own level; local checkouts share one. */
export interface ProjectNavigationWorkspace {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly kind: 'local' | 'worktree';
  readonly branch?: string;
  /** working: a chat runs here · review: idle with unmerged changes · done: merged. */
  readonly status?: 'working' | 'review' | 'done';
  readonly archived?: boolean;
  readonly updatedAt?: number;
}

export interface ProjectNavigationTerminal {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly archived?: boolean;
}

export type ProjectNavigationTarget =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'subproject'; readonly projectId: string; readonly subprojectId: string }
  | { readonly kind: 'stage'; readonly projectId: string; readonly subprojectId: string; readonly nodeId: string }
  | { readonly kind: 'workspace'; readonly projectId: string; readonly workspaceId: string; readonly local: boolean }
  | { readonly kind: 'conversation'; readonly projectId: string; readonly conversationId: string; readonly sessionId?: string }
  | { readonly kind: 'terminal'; readonly projectId: string; readonly sessionId: string };

export interface ProjectConversationNode {
  readonly id: string;
  readonly title: string;
  readonly target: ProjectNavigationTarget;
  readonly path: readonly string[];
  readonly updatedAt: number;
  readonly source?: ProjectNavigationConversation['source'];
  readonly providerLabel?: string;
  readonly archived?: boolean;
  readonly status?: string;
  readonly pinned?: boolean;
  readonly subagent?: boolean;
  readonly subagentType?: string;
  /** The most urgent state among this conversation's subagents, shown while it is collapsed. */
  readonly attention?: { readonly status: string; readonly count: number };
  readonly branch?: string;
  readonly children?: readonly ProjectConversationNode[];
}

/** What a collapsed parent must surface first: a wait on the person, a failure, then work in flight. */
const ATTENTION_RANK: Readonly<Record<string, number>> = {
  blocked: 0, 'needs-attention': 0, 'delivery-uncertain': 0, error: 1, failed: 1, working: 2, running: 2, starting: 2, queued: 3,
};

function descendantAttention(children: readonly ProjectConversationNode[]): ProjectConversationNode['attention'] {
  const statuses: string[] = [];
  const visit = (node: ProjectConversationNode): void => {
    if (node.status && ATTENTION_RANK[node.status] !== undefined) statuses.push(node.status);
    node.children?.forEach(visit);
  };
  children.forEach(visit);
  if (!statuses.length) return undefined;
  const rank = Math.min(...statuses.map(status => ATTENTION_RANK[status]!));
  const matching = statuses.filter(status => ATTENTION_RANK[status] === rank);
  return { status: matching[0]!, count: matching.length };
}

export function projectConversationNodeKey(kind: ProjectNavigationTarget['kind'], ...ids: string[]): string {
  return JSON.stringify([kind, ...ids]);
}

const byRecent = (left: ProjectConversationNode, right: ProjectConversationNode): number =>
  right.updatedAt - left.updatedAt || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);

/** One projection is shared by the hierarchy, recent view, and title search. */
export function projectConversationTree(input: {
  readonly projects: readonly ProjectNavigationProject[];
  readonly conversations: readonly ProjectNavigationConversation[];
  readonly workflows: Readonly<Record<string, WorkflowNavigationSnapshot | undefined>>;
  readonly terminals?: readonly ProjectNavigationTerminal[];
  readonly workspaces?: readonly ProjectNavigationWorkspace[];
}): readonly ProjectConversationNode[] {
  return input.projects.map(project => {
    const workflow = input.workflows[project.id];
    const listed = input.conversations.filter(item => item.projectId === project.id);
    const sessions = new Set(listed.flatMap(item => item.sessionId ? [item.sessionId] : []));
    // A subagent chat lives under its parent conversation; one whose parent is not listed stays reachable here.
    const subagents = new Map<string, ProjectNavigationConversation[]>();
    const nested = new Set<ProjectNavigationConversation>();
    for (const item of listed) {
      if (item.parentSessionId && item.parentSessionId !== item.sessionId && sessions.has(item.parentSessionId)) {
        subagents.set(item.parentSessionId, [...subagents.get(item.parentSessionId) ?? [], item]);
        nested.add(item);
      }
    }
    const conversations = listed.filter(item => !nested.has(item));
    const links = new Map((workflow?.sessionLinks ?? []).map(link => [link.sessionId, link]));
    const assigned = new Set<string>();
    const conversationNode = (conversation: ProjectNavigationConversation, path: readonly string[], archived = false, subagent = false): ProjectConversationNode => {
      const children = (conversation.sessionId ? subagents.get(conversation.sessionId) ?? [] : [])
        .map(child => conversationNode(child, [...path, conversation.title], archived, true)).sort(byRecent);
      return {
        id: projectConversationNodeKey('conversation', project.id, conversation.sessionId ? `session:${conversation.sessionId}` : conversation.id),
        title: conversation.title,
        target: { kind: 'conversation', projectId: project.id, conversationId: conversation.id, sessionId: conversation.sessionId },
        path, updatedAt: conversation.updatedAt, source: conversation.source,
        providerLabel: conversation.providerLabel, status: conversation.status,
        archived: archived || conversation.archived,
        ...subagent ? { subagent } : {}, ...conversation.subagentType ? { subagentType: conversation.subagentType } : {},
        ...children.length ? { children, ...attentionOf(children) } : {},
      };
    };
    const attentionOf = (children: readonly ProjectConversationNode[]): { attention?: ProjectConversationNode['attention'] } => {
      const attention = descendantAttention(children);
      return attention ? { attention } : {};
    };
    const children: ProjectConversationNode[] = (workflow?.subprojects ?? []).map(subproject => {
      const subprojectPath = [project.title, subproject.title];
      const linked = conversations.filter(conversation => {
        const link = conversation.sessionId ? links.get(conversation.sessionId) : undefined;
        return (conversation.subprojectId ?? link?.subprojectId) === subproject.id;
      });
      const stageNodes: ProjectConversationNode[] = subproject.stages.map(stage => {
        const archived = subproject.status === 'archived' || stage.archived;
        const stageConversations = linked.filter(conversation => {
          const link = conversation.sessionId ? links.get(conversation.sessionId) : undefined;
          return (conversation.nodeId ?? link?.nodeId) === stage.id;
        });
        stageConversations.forEach(conversation => assigned.add(conversation.id));
        const entries = stageConversations.map(conversation => conversationNode(conversation, [...subprojectPath, stage.title], archived)).sort(byRecent);
        return {
          id: projectConversationNodeKey('stage', project.id, subproject.id, stage.id),
          title: stage.title,
          target: { kind: 'stage', projectId: project.id, subprojectId: subproject.id, nodeId: stage.id },
          path: subprojectPath, updatedAt: entries[0]?.updatedAt ?? Date.parse(subproject.updatedAt),
          archived, children: entries,
        };
      });
      const remaining = linked.filter(conversation => !assigned.has(conversation.id));
      remaining.forEach(conversation => assigned.add(conversation.id));
      return {
        id: projectConversationNodeKey('subproject', project.id, subproject.id),
        title: subproject.title,
        target: { kind: 'subproject', projectId: project.id, subprojectId: subproject.id },
        path: [project.title], updatedAt: Date.parse(subproject.updatedAt),
        archived: subproject.status === 'archived', status: subproject.status,
        children: [...remaining.map(conversation => conversationNode(conversation, subprojectPath, subproject.status === 'archived')), ...stageNodes],
      };
    });
    const loose = conversations.filter(conversation => !assigned.has(conversation.id)).map(conversation => ({
      conversation,
      node: conversationNode(conversation, [project.title, ...conversation.subprojectTitle ? [conversation.subprojectTitle] : [], ...conversation.nodeTitle ? [conversation.nodeTitle] : []]),
    }));
    // A worktree is a separate place to work: its chats sit under it. Without one,
    // every local checkout is the same folder and no extra level is shown.
    const worktrees = (input.workspaces ?? []).filter(workspace => workspace.projectId === project.id && workspace.kind === 'worktree' && !workspace.archived);
    if (worktrees.length) {
      const worktreeIds = new Set(worktrees.map(workspace => workspace.id));
      const locals = (input.workspaces ?? []).filter(workspace => workspace.projectId === project.id && workspace.kind === 'local' && !workspace.archived);
      const local = locals[0];
      const group = (id: string, title: string, entries: typeof loose, workspace: ProjectNavigationWorkspace | undefined, isLocal: boolean): ProjectConversationNode => {
        const nodes = entries.map(entry => entry.node).sort(byRecent);
        const status = isLocal
          ? nodes.some(node => node.status === 'working' || node.status === 'running') ? 'working' : undefined
          : workspace?.status;
        return {
          id: projectConversationNodeKey('workspace', project.id, id), title,
          target: { kind: 'workspace', projectId: project.id, workspaceId: id, local: isLocal },
          path: [project.title], updatedAt: Math.max(workspace?.updatedAt ?? 0, ...nodes.map(node => node.updatedAt)),
          ...status ? { status } : {}, ...workspace?.branch ? { branch: workspace.branch } : {},
          children: nodes, ...attentionOf(nodes),
        };
      };
      children.push(group(local?.id ?? `${project.id}:local`, local?.branch ?? local?.title ?? project.title,
        loose.filter(entry => !entry.conversation.workspaceId || !worktreeIds.has(entry.conversation.workspaceId)), local, true));
      for (const worktree of worktrees) {
        children.push(group(worktree.id, worktree.branch ?? worktree.title, loose.filter(entry => entry.conversation.workspaceId === worktree.id), worktree, false));
      }
    } else {
      children.push(...loose.map(entry => entry.node));
    }
    children.push(...(input.terminals ?? []).filter(terminal => terminal.projectId === project.id).map(terminal => ({
      id: projectConversationNodeKey('terminal', project.id, terminal.id),
      title: terminal.title, target: { kind: 'terminal' as const, projectId: project.id, sessionId: terminal.id },
      path: [project.title], updatedAt: terminal.updatedAt, archived: terminal.archived,
    })));
    children.sort(byRecent);
    return {
      id: projectConversationNodeKey('project', project.id), title: project.title,
      target: { kind: 'project' as const, projectId: project.id }, path: [],
      updatedAt: Math.max(project.updatedAt ?? 0, ...children.map(child => child.updatedAt)),
      pinned: project.pinned, children,
    };
  }).sort((left, right) => Number(right.pinned ?? false) - Number(left.pinned ?? false) || byRecent(left, right));
}

export interface ProjectConversationRow {
  readonly node: ProjectConversationNode;
  readonly depth: number;
  readonly parentId?: string;
  readonly expanded: boolean;
}

export function visibleProjectConversationRows(nodes: readonly ProjectConversationNode[], options: {
  readonly expanded: ReadonlySet<string>;
  readonly query: string;
  readonly view: 'projects' | 'recent';
  readonly includeArchived: boolean;
}): readonly ProjectConversationRow[] {
  const query = options.query.trim().toLocaleLowerCase();
  const allowed = (node: ProjectConversationNode): boolean => options.includeArchived || !node.archived;
  if (options.view === 'recent' || query) {
    const matches: ProjectConversationNode[] = [];
    const visit = (node: ProjectConversationNode): void => {
      if (!allowed(node)) return;
      if ((query || ['conversation', 'subproject', 'terminal'].includes(node.target.kind))
        && (!query || [node.title, ...node.path].join(' ').toLocaleLowerCase().includes(query))) matches.push(node);
      // Subagent chats are listed only under their parent conversation.
      if (node.target.kind !== 'conversation') node.children?.forEach(visit);
    };
    nodes.forEach(visit);
    return matches.sort(byRecent).map(node => ({ node, depth: 0, expanded: false }));
  }
  const rows: ProjectConversationRow[] = [];
  const visit = (node: ProjectConversationNode, depth: number, parentId?: string): void => {
    if (!allowed(node)) return;
    const expanded = options.expanded.has(node.id);
    rows.push({ node, depth, parentId, expanded });
    if (expanded) node.children?.forEach(child => visit(child, depth + 1, node.id));
  };
  nodes.forEach(node => visit(node, 0));
  return rows;
}
