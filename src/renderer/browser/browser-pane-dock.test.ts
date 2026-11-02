// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { DockviewApi } from 'dockview-react';

import { openBrowserPane, showConversation } from './browser-pane-dock';

/** A conversation's panel as the app makes it: the daemon session in `historyId`, and the catalog's own id beside it. */
function dock(params: Record<string, unknown>) {
  const setActive = vi.fn();
  const owner = { id: 'agent-session-1', api: { component: 'agent-session', setActive }, params };
  const openPanel = vi.fn();
  const added = { id: 'browser-preview-session-1', group: { model: { openPanel } } };
  const addPanel = vi.fn(() => added);
  const api = { panels: [owner], getPanel: vi.fn(() => undefined), addPanel } as unknown as DockviewApi;
  return { api, owner, addPanel, setActive, added, openPanel };
}

describe('the pane finds the conversation it belongs to', () => {
  it('by the daemon session in the panel\'s history id, as a live conversation panel carries it', () => {
    const { api, owner, addPanel } = dock({ historyId: 'structured-session-session-1', conversationId: 'codex:catalog-entry-9', projectId: 'project-1' });
    expect(openBrowserPane(api, 'session-1', 'Browser')).toBe(true);
    expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({ params: { conversationId: 'session-1' }, position: { referencePanel: owner, direction: 'right' } }));
  });

  it('shows the page in its own group without taking the person\'s group: a new group has no shown panel of itself', () => {
    const { api, added, openPanel } = dock({ historyId: 'structured-session-session-1' });
    openBrowserPane(api, 'session-1', 'Browser');
    expect(openPanel).toHaveBeenCalledWith(added, { skipSetGroupActive: true });
  });

  it('brings that conversation forward when a decision waits there', () => {
    const { api, setActive } = dock({ historyId: 'structured-session-session-1', conversationId: 'codex:catalog-entry-9' });
    showConversation(api, 'session-1');
    expect(setActive).toHaveBeenCalled();
  });

  it('opens nothing for a conversation not on screen, or a draft', () => {
    expect(openBrowserPane(dock({ historyId: 'structured-session-another' }).api, 'session-1', 'Browser')).toBe(false);
    expect(openBrowserPane(dock({ historyId: 'structured-draft-session-1' }).api, 'session-1', 'Browser')).toBe(false);
  });
});
