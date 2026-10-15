import { expect, it } from 'vitest';
import { restoreConversationLayout } from './conversation-layout';

it('restores verified CLI history in place and marks unknown old terminals as ended without launching them', () => {
  const layout = { activeGroup: 'group', panels: {
    linked: { id: 'linked', contentComponent: 'terminal', params: { lastSurface: 'agent-cli', conversationId: 'conversation_original' } },
    unknown: { id: 'unknown', contentComponent: 'terminal' },
    shell: { id: 'shell', contentComponent: 'terminal', params: { lastSurface: 'terminal' } },
  } };
  expect(restoreConversationLayout(layout)).toEqual({ ...layout, panels: {
    linked: { id: 'linked', contentComponent: 'agent-session', params: { historyId: 'conversation_original', conversationId: 'conversation_original' } },
    unknown: { id: 'unknown', contentComponent: 'terminal', params: { restoreState: 'ended' } }, shell: layout.panels.shell,
  } });
  expect(layout.panels.linked.contentComponent).toBe('terminal');
});
