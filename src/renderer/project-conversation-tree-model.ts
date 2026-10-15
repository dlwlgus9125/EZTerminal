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
  readonly children?: readonly ProjectConversationNode[];
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
}): readonly ProjectConversationNode[] {
  return input.projects.map(project => {
    const workflow = input.workflows[project.id];
    const conversations = input.conversations.filter(item => item.projectId === project.id);
    const links = new Map((workflow?.sessionLinks ?? []).map(link => [link.sessionId, link]));
    const assigned = new Set<string>();
    const conversationNode = (conversation: ProjectNavigationConversation, path: readonly string[], archived = false): ProjectConversationNode => ({
      id: projectConversationNodeKey('conversation', project.id, conversation.sessionId ? `session:${conversation.sessionId}` : conversation.id),
      title: conversation.title,
      target: { kind: 'conversation', projectId: project.id, conversationId: conversation.id, sessionId: conversation.sessionId },
      path, updatedAt: conversation.updatedAt, source: conversation.source,
      providerLabel: conversation.providerLabel, status: conversation.status,
      archived: archived || conversation.archived,
    });
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
    children.push(...conversations.filter(conversation => !assigned.has(conversation.id)).map(conversation => conversationNode(conversation, [project.title, ...conversation.subprojectTitle ? [conversation.subprojectTitle] : [], ...conversation.nodeTitle ? [conversation.nodeTitle] : []])));
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
      node.children?.forEach(visit);
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
