import { describe, expect, it } from 'vitest';
import { projectConversationNodeKey, projectConversationTree, visibleProjectConversationRows, type ProjectNavigationConversation } from './project-conversation-tree-model';
import { workflowFixture, workflowNavigationFixture } from './workflow/workflow-fixtures';

const general: ProjectNavigationConversation = { id: 'general', projectId: 'project-story', sessionId: 'general', title: 'Build options', source: 'agent', updatedAt: 10, providerLabel: 'Codex' };
const stage: ProjectNavigationConversation = { ...general, id: 'stage', sessionId: 'chat-stage', title: 'Requirement review', updatedAt: 20 };
const native: ProjectNavigationConversation = { ...general, id: 'cli', sessionId: undefined, title: 'Yesterday in Claude', source: 'native', providerLabel: 'Claude', updatedAt: 30 };
function fixture(conversations = [general, stage, native]) {
  return projectConversationTree({ projects: [{ id: 'project-story', title: 'Product' }], conversations, workflows: { 'project-story': workflowNavigationFixture() } });
}

describe('project conversation hierarchy', () => {
  it('places general chats and subprojects at the same depth and owns each stage chat once', () => {
    const tree = fixture();
    const children = tree[0].children!;
    expect(children.find(node => node.target.kind === 'conversation' && node.title === 'Build options')).toBeDefined();
    const subproject = children.find(node => node.target.kind === 'subproject' && node.target.subprojectId === 'login')!;
    const research = subproject.children!.find(node => node.target.kind === 'stage' && node.target.nodeId === 'login:research')!;
    expect(research.children).toHaveLength(1);
    expect(research.children![0].target).toMatchObject({ kind: 'conversation', sessionId: 'chat-stage', conversationId: 'stage' });
    const rows = visibleProjectConversationRows(tree, { expanded: new Set(), query: 'Requirement review', view: 'projects', includeArchived: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].node.path).toEqual(['Product', 'Login improvements', 'Investigation']);
  });
  it('shows CLI history as a first-class leaf without inventing a session', () => {
    const row = fixture()[0].children!.find(node => node.source === 'native')!;
    expect(row.target).toEqual({ kind: 'conversation', projectId: 'project-story', conversationId: 'cli', sessionId: undefined });
  });
  it('searches collapsed descendants and uses the same leaves in recent order', () => {
    const tree = fixture();
    const collapsed = visibleProjectConversationRows(tree, { expanded: new Set(), query: '', view: 'projects', includeArchived: false });
    expect(collapsed).toHaveLength(1);
    const searched = visibleProjectConversationRows(tree, { expanded: new Set(), query: 'Yesterday', view: 'projects', includeArchived: false });
    const recent = visibleProjectConversationRows(tree, { expanded: new Set(), query: '', view: 'recent', includeArchived: false });
    expect(recent.some(row => row.node.id === searched[0].node.id)).toBe(true);
    expect(recent.filter(row => row.node.target.kind === 'conversation').map(row => row.node.title)).toEqual(['Yesterday in Claude', 'Requirement review', 'Build options']);
  });
  it('folds subagent chats under their parent and keeps them out of flat lists', () => {
    const child: ProjectNavigationConversation = { ...general, id: 'child', sessionId: 'child', title: 'Claude subagent', updatedAt: 40, parentSessionId: 'chat-stage' };
    const orphan: ProjectNavigationConversation = { ...general, id: 'orphan', sessionId: 'orphan', title: 'Orphan subagent', updatedAt: 5, parentSessionId: 'missing' };
    const tree = fixture([general, stage, native, child, orphan]);
    const research = tree[0].children!.find(node => node.target.kind === 'subproject')!.children!.find(node => node.target.kind === 'stage' && node.target.nodeId === 'login:research')!;
    const parent = research.children!.find(node => node.title === 'Requirement review')!;
    expect(parent.children!.map(node => node.target)).toEqual([{ kind: 'conversation', projectId: 'project-story', conversationId: 'child', sessionId: 'child' }]);
    expect(tree[0].children!.find(node => node.title === 'Build options')!.children).toBeUndefined();
    expect(tree[0].children!.some(node => node.title === 'Orphan subagent')).toBe(true);
    const expanded = new Set([tree[0].id, tree[0].children!.find(node => node.target.kind === 'subproject')!.id, research.id]);
    const collapsed = visibleProjectConversationRows(tree, { expanded, query: '', view: 'projects', includeArchived: false });
    expect(collapsed.some(row => row.node.title === 'Claude subagent')).toBe(false);
    const open = visibleProjectConversationRows(tree, { expanded: new Set([...expanded, parent.id]), query: '', view: 'projects', includeArchived: false });
    expect(open.find(row => row.node.title === 'Claude subagent')).toMatchObject({ parentId: parent.id, depth: 4 });
    for (const view of [{ query: '', view: 'recent' as const }, { query: 'Claude subagent', view: 'projects' as const }]) {
      expect(visibleProjectConversationRows(tree, { expanded: new Set(), includeArchived: false, ...view }).some(row => row.node.title === 'Claude subagent')).toBe(false);
    }
  });
  it('shows the most urgent subagent state on a collapsed parent', () => {
    const working: ProjectNavigationConversation = { ...general, id: 'a', sessionId: 'a', title: 'Read README title', updatedAt: 41, parentSessionId: 'general', status: 'working', subagentType: 'Explore' };
    const blocked: ProjectNavigationConversation = { ...general, id: 'b', sessionId: 'b', title: 'Delete README', updatedAt: 42, parentSessionId: 'general', status: 'blocked' };
    const done: ProjectNavigationConversation = { ...general, id: 'c', sessionId: 'c', title: 'Find greet', updatedAt: 43, parentSessionId: 'general', status: 'completed' };
    const parent = fixture([general, working, blocked, done])[0].children!.find(node => node.title === 'Build options')!;
    expect(parent.attention).toEqual({ status: 'blocked', count: 1 });
    expect(parent.children!.find(node => node.title === 'Read README title')!.subagentType).toBe('Explore');
    const quiet = fixture([general, done])[0].children!.find(node => node.title === 'Build options')!;
    expect(quiet.attention).toBeUndefined();
  });
  it('adds a workspace level only when the project has a worktree, and merges local checkouts', () => {
    const local = { id: 'w-local', projectId: 'project-story', title: 'Product', kind: 'local' as const };
    const duplicate = { ...local, id: 'w-local-main', title: 'Product (main)' };
    const worktree = { id: 'w-tree', projectId: 'project-story', title: 'fix-login', kind: 'worktree' as const, branch: 'fix-login', status: 'review' as const };
    const onTree: ProjectNavigationConversation = { ...general, id: 'tree-chat', sessionId: 'tree-chat', title: 'Fix login', workspaceId: 'w-tree', updatedAt: 50 };
    const flat = projectConversationTree({ projects: [{ id: 'project-story', title: 'Product' }], conversations: [general], workflows: {}, workspaces: [local, duplicate] });
    expect(flat[0].children!.some(node => node.target.kind === 'workspace')).toBe(false);
    const tree = projectConversationTree({ projects: [{ id: 'project-story', title: 'Product' }], conversations: [general, onTree], workflows: {}, workspaces: [local, duplicate, worktree] });
    const places = tree[0].children!.filter(node => node.target.kind === 'workspace');
    expect(places.map(node => [node.title, node.status, node.children!.map(child => child.title)])).toEqual([
      ['fix-login', 'review', ['Fix login']],
      ['Product', undefined, ['Build options']],
    ]);
    const archived = projectConversationTree({ projects: [{ id: 'project-story', title: 'Product' }], conversations: [general], workflows: {}, workspaces: [local, { ...worktree, archived: true }] });
    expect(archived[0].children!.some(node => node.target.kind === 'workspace')).toBe(false);
  });
  it('keeps a stable session identity when a refreshed history summary replaces daemon fallback', () => {
    const before = fixture([{ ...general, id: 'daemon-fallback' }]);
    const after = fixture([{ ...general, id: 'opaque-summary' }]);
    expect(before[0].children!.find(node => node.target.kind === 'conversation')!.id).toBe(after[0].children!.find(node => node.target.kind === 'conversation')!.id);
  });
  it('preserves deleted-stage history without leaking it into active general chats', () => {
    const workflow = workflowFixture();
    const owner = workflow.subprojects[0];
    owner.archivedNodes = [owner.graph.nodes[0]];
    owner.graph.nodes = owner.graph.nodes.slice(1);
    const tree = projectConversationTree({ projects: [{ id: 'project-story', title: 'Product' }], conversations: [stage], workflows: { 'project-story': workflowNavigationFixture(workflow) } });
    expect(visibleProjectConversationRows(tree, { expanded: new Set(), query: 'Requirement', view: 'recent', includeArchived: false })).toHaveLength(0);
    const archived = visibleProjectConversationRows(tree, { expanded: new Set(), query: 'Requirement', view: 'recent', includeArchived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0].node.archived).toBe(true);
    expect(tree[0].children!.filter(node => node.target.kind === 'conversation')).toHaveLength(0);
    expect(tree[0].id).toBe(projectConversationNodeKey('project', 'project-story'));
  });
});
