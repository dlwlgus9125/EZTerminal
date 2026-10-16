// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectConversationTree } from './ProjectConversationTree';
import { projectConversationNodeKey, projectConversationTree } from './project-conversation-tree-model';
import { workflowNavigationFixture } from './workflow/workflow-fixtures';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nodes = projectConversationTree({
  projects: [{ id: 'project-story', title: 'Product' }], workflows: { 'project-story': workflowNavigationFixture() },
  conversations: [{ id: 'general', projectId: 'project-story', title: 'Unsent draft chat', sessionId: 'same-session', updatedAt: 1, source: 'agent', providerLabel: 'Codex' },
    { id: 'native', projectId: 'project-story', title: 'Yesterday in CLI', updatedAt: 2, source: 'native', providerLabel: 'Claude' },
    { id: 'stage', projectId: 'project-story', title: 'Stage review', sessionId: 'chat-stage', updatedAt: 3, source: 'stage', providerLabel: 'Codex' }],
});
describe('project conversation navigation', () => {
  let element: HTMLDivElement;
  let root: Root;
  const open = vi.fn();
  const inspect = vi.fn();
  beforeEach(() => { window.localStorage.clear(); open.mockClear(); inspect.mockClear(); element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
  afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
  const render = async (scope = 'host-a'): Promise<void> => { await act(async () => root.render(<AppI18nProvider locale="en" languages={['en']}><ProjectConversationTree nodes={nodes} persistenceScope={scope} onOpen={open} onInspectProject={inspect} /></AppI18nProvider>)); };
  const click = async (selector: string): Promise<void> => { await act(async () => (element.querySelector(selector) as HTMLElement).click()); };

  it('expands a subproject without opening it, then directly opens the exact stage session', async () => {
    await render();
    await click('button[aria-label="Expand: Login improvements"]');
    await click('button[aria-label="Expand: Investigation"]');
    expect(open).not.toHaveBeenCalled();
    await click('[role="treeitem"][aria-label^="Stage review"]');
    expect(open).toHaveBeenCalledWith({ kind: 'conversation', projectId: 'project-story', conversationId: 'stage', sessionId: 'chat-stage' });
    expect(inspect).toHaveBeenCalledWith('project-story');
  });
  it('keeps expansion and search per host while returning to the same conversation identity', async () => {
    await render();
    await click('button[aria-label="Expand: Login improvements"]');
    const input = element.querySelector('input[placeholder]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Yesterday');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(element.querySelector('[role="treeitem"][aria-label^="Yesterday in CLI"]')).not.toBeNull();
    expect(element.querySelector('[role="treeitem"][aria-label^="Unsent draft chat"]')).toBeNull();
    await render('host-b');
    expect((element.querySelector('input[placeholder]') as HTMLInputElement).value).toBe('');
    await render('host-a');
    expect((element.querySelector('input[placeholder]') as HTMLInputElement).value).toBe('Yesterday');
    const stored = JSON.parse(window.localStorage.getItem('ezterminal:project-navigation:v1:host-a')!);
    expect(stored.expanded).toContain(projectConversationNodeKey('subproject', 'project-story', 'login'));
  });
  it('lets the user collapse every project and supports keyboard navigation without execution', async () => {
    await render();
    await click('button[aria-label="Collapse: Product"]');
    expect(element.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    const project = element.querySelector('[role="treeitem"]')!;
    await act(async () => project.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(element.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(1);
    expect(open).not.toHaveBeenCalled();
    await act(async () => project.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(open).toHaveBeenCalledWith({ kind: 'project', projectId: 'project-story' });
  });
  it('restores the saved list position after asynchronous children make the list scrollable', async () => {
    const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
    const positions = new WeakMap<HTMLElement, number>();
    let maximumScroll = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true,
      get() { return positions.get(this as HTMLElement) ?? 0; },
      set(value: number) { positions.set(this as HTMLElement, Math.min(maximumScroll, value)); },
    });
    try {
      window.localStorage.setItem('ezterminal:project-navigation:v1:async-scroll', JSON.stringify({
        expanded: [nodes[0].id], query: '', view: 'projects', includeArchived: false, scrollTop: 600,
      }));
      await act(async () => root.render(<AppI18nProvider locale="en" languages={['en']}><ProjectConversationTree
        nodes={[{ ...nodes[0], children: [] }]} persistenceScope="async-scroll" onOpen={open} /></AppI18nProvider>));
      expect(element.querySelector('.project-conversation-tree__scroll')!.scrollTop).toBe(0);
      maximumScroll = 1_000;
      await render('async-scroll');
      expect(element.querySelector('.project-conversation-tree__scroll')!.scrollTop).toBe(600);
    } finally {
      if (prior) Object.defineProperty(HTMLElement.prototype, 'scrollTop', prior);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
    }
  });
  it('persists successive scroll positions after the DOM events finish dispatching', async () => {
    await act(async () => root.render(<AppI18nProvider locale="en" languages={['en']}><ProjectConversationTree
      nodes={[{ ...nodes[0], children: [] }]} persistenceScope="scroll-events" onOpen={open} /></AppI18nProvider>));
    const viewport = element.querySelector('.project-conversation-tree__scroll') as HTMLDivElement;
    await act(async () => {
      viewport.scrollTop = 120;
      viewport.dispatchEvent(new Event('scroll'));
      viewport.scrollTop = 240;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(element.querySelector('[role="tree"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem('ezterminal:project-navigation:v1:scroll-events')!).scrollTop).toBe(240);
  });
});
