import type { DockviewApi } from 'dockview-react';
import { describe, expect, it } from 'vitest';

import { syncConversationGroupHeaders } from './pane-actions';

let ids = 0;
function group(...components: string[]) {
  return { header: { hidden: false }, panels: components.map((component) => ({ id: `c${++ids}`, api: { component } })) };
}

describe('syncConversationGroupHeaders', () => {
  it('hides the tab strip only where one conversation is the whole group', () => {
    const conversation = group('agent-session');
    const twoConversations = group('agent-session', 'agent-session');
    const terminal = group('terminal');
    const mixed = group('agent-session', 'agent-results');
    const withHeader = new Set([...conversation.panels, ...twoConversations.panels, ...mixed.panels].map((panel) => panel.id));
    syncConversationGroupHeaders({ groups: [conversation, twoConversations, terminal, mixed] } as unknown as DockviewApi, withHeader);
    expect([conversation, twoConversations, terminal, mixed].map((entry) => entry.header.hidden)).toEqual([true, false, false, false]);
  });

  it('keeps the strip for a conversation without its header (opening, or failed to open)', () => {
    const conversation = group('agent-session');
    syncConversationGroupHeaders({ groups: [conversation] } as unknown as DockviewApi, new Set());
    expect(conversation.header.hidden).toBe(false);
  });

  it('shows the strip again when a second tab joins', () => {
    const conversation = group('agent-session');
    const api = { groups: [conversation] } as unknown as DockviewApi;
    const withHeader = new Set([conversation.panels[0]!.id]);
    syncConversationGroupHeaders(api, withHeader);
    expect(conversation.header.hidden).toBe(true);
    conversation.panels.push({ id: 'terminal-x', api: { component: 'terminal' } });
    syncConversationGroupHeaders(api, withHeader);
    expect(conversation.header.hidden).toBe(false);
  });
});
