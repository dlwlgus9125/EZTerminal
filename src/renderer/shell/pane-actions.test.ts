import type { DockviewApi } from 'dockview-react';
import { describe, expect, it } from 'vitest';

import { syncConversationGroupHeaders } from './pane-actions';

function group(...components: string[]) {
  return { header: { hidden: false }, panels: components.map((component) => ({ api: { component } })) };
}

describe('syncConversationGroupHeaders', () => {
  it('hides the tab strip only where one conversation is the whole group', () => {
    const conversation = group('agent-session');
    const twoConversations = group('agent-session', 'agent-session');
    const terminal = group('terminal');
    const mixed = group('agent-session', 'agent-results');
    syncConversationGroupHeaders({ groups: [conversation, twoConversations, terminal, mixed] } as unknown as DockviewApi);
    expect([conversation, twoConversations, terminal, mixed].map((entry) => entry.header.hidden)).toEqual([true, false, false, false]);
  });

  it('shows the strip again when a second tab joins', () => {
    const conversation = group('agent-session');
    const api = { groups: [conversation] } as unknown as DockviewApi;
    syncConversationGroupHeaders(api);
    expect(conversation.header.hidden).toBe(true);
    conversation.panels.push({ api: { component: 'terminal' } });
    syncConversationGroupHeaders(api);
    expect(conversation.header.hidden).toBe(false);
  });
});
