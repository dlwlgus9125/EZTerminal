// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, ConversationPage, ConversationQuery } from '../shared/conversation-history';
import { useProjectConversationNavigation, type ProjectConversationNavigationAccess } from './use-project-conversation-navigation';
import { ProjectConversationTree } from './ProjectConversationTree';
import { AppI18nProvider } from './i18n';
import { workflowNavigationFixture } from './workflow/workflow-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const projects = [{ id: 'project-story', title: 'Product' }];
const history: ConversationEntry = { conversationId: 'cli', source: 'native', providerId: 'codex', projectId: 'project-story', projectTitle: 'Product', title: 'CLI conversation', preview: '', roots: ['C:\\Product'], createdAt: 1, updatedAt: 2, archived: false, state: 'idle', action: 'resume' };

function Surface({ access, scope = 'host-a' }: { access: ProjectConversationNavigationAccess; scope?: string }): JSX.Element {
  const navigation = useProjectConversationNavigation({ projects, access, scope });
  return <AppI18nProvider locale="en" languages={['en']}><ProjectConversationTree nodes={navigation.nodes} persistenceScope={scope}
    projectStatus={navigation.projectStatus} onInspectProject={navigation.inspectProject} onSearchAll={navigation.searchAll}
    searchStatus={navigation.searchStatus} onLoadMoreSearch={navigation.loadMoreSearch}
    onLoadMore={navigation.loadMore} onOpen={() => undefined} /></AppI18nProvider>;
}

describe('project conversation metadata access', () => {
  let element: HTMLDivElement;
  let root: Root;
  beforeEach(() => { window.localStorage.clear(); element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
  afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
  it('loads summaries when expanding a project without requiring transcript access', async () => {
    const listConversations = vi.fn(async (): Promise<ConversationPage> => ({ ok: true, items: [history], nextCursor: null }));
    const getWorkflowNavigation = vi.fn(async () => ({ ok: true as const, snapshot: workflowNavigationFixture() }));
    await act(async () => root.render(<Surface access={{ listConversations, getWorkflowNavigation }} />));
    expect(listConversations).toHaveBeenCalledWith({ projectId: 'project-story', archived: 'include', limit: 100 });
    expect(getWorkflowNavigation).toHaveBeenCalledWith('project-story');
    expect(element.textContent).toContain('CLI conversation');
    expect(element.textContent).toContain('Login improvements');
  });
  it('does not allow late replies from a previous host to enter the current tree', async () => {
    let resolveFirst!: (page: ConversationPage) => void;
    const first = new Promise<ConversationPage>(resolve => { resolveFirst = resolve; });
    const listConversations = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ ok: true, items: [{ ...history, conversationId: 'other-host', title: 'Other PC conversation' }], nextCursor: null });
    const access = { listConversations };
    await act(async () => root.render(<Surface access={access} scope="host-a" />));
    await act(async () => root.render(<Surface access={access} scope="host-b" />));
    await act(async () => resolveFirst({ ok: true, items: [history], nextCursor: null }));
    expect(element.textContent).toContain('Other PC conversation');
    expect(element.textContent).not.toContain('CLI conversation');
  });
  it('replaces a native row when the refreshed list reports the same history as a linked Agent', async () => {
    const listConversations = vi.fn().mockResolvedValueOnce({ ok: true, items: [history], nextCursor: null }).mockResolvedValue({ ok: true, items: [{ ...history, conversationId: 'linked', linkedSessionId: 'existing-agent', source: 'app', action: 'open' }], nextCursor: null });
    await act(async () => root.render(<Surface access={{ listConversations }} />));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(element.querySelectorAll('[role="treeitem"][aria-label^="CLI conversation"]')).toHaveLength(1);
    expect(element.textContent).not.toContain('Codex CLI');
  });
  it('keeps older-page navigation reachable even when the current search page is empty', async () => {
    const listConversations = vi.fn(async (query?: ConversationQuery): Promise<ConversationPage> => query?.query
      ? query.cursor ? { ok: true, items: [{ ...history, conversationId: 'older', title: 'Older release discussion' }], nextCursor: null }
        : { ok: true, items: [], nextCursor: 'older-page' }
      : { ok: true, items: [history], nextCursor: null });
    await act(async () => root.render(<Surface access={{ listConversations }} />));
    const input = element.querySelector('input[placeholder]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Older');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => new Promise(resolve => window.setTimeout(resolve, 220)));
    expect(element.textContent).toContain('No matching titles.');
    const more = [...element.querySelectorAll('button')].find(button => button.textContent === 'Load more conversations')!;
    expect(more).toBeDefined();
    await act(async () => more.click());
    expect(listConversations).toHaveBeenCalledWith({ query: 'Older', archived: 'include', limit: 100, cursor: 'older-page' });
    expect(element.textContent).toContain('Older release discussion');
  });
});
