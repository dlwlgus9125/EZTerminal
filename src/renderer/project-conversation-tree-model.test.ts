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
