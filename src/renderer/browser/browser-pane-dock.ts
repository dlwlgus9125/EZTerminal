import type { DockviewApi, IDockviewPanel } from 'dockview-react';

export const BROWSER_PANE_COMPONENT = 'browser-preview';

export function browserPanelId(conversationId: string): string {
  return `browser-preview-${conversationId}`;
}

/** The person closed a conversation's pane: its view goes. A layout being replaced is not the person closing anything. */
export function watchBrowserPaneClose(api: DockviewApi, options: {
  readonly isLayoutTransactionActive: () => boolean;
  readonly close: (conversationId: string) => void;
}): { dispose(): void } {
  return api.onDidRemovePanel((panel) => {
    if (panel.api.component !== BROWSER_PANE_COMPONENT || options.isLayoutTransactionActive()) return;
    const conversationId = (panel.params as { conversationId?: unknown } | undefined)?.conversationId;
    if (typeof conversationId === 'string') options.close(conversationId);
  });
}

/**
 * A conversation's panel, by the daemon session the pane is keyed on. A live panel holds it in `historyId` (as
 * `structuredAgentSessionHistoryId` writes it, not imported: that module imports this one); its `conversationId` is the
 * catalog's own id, which is another thing.
 */
function conversationPanel(api: DockviewApi, sessionId: string): IDockviewPanel | undefined {
  return api.panels.find((panel) => {
    const params = panel.params as { historyId?: unknown; conversationId?: unknown } | undefined;
    return panel.api.component === 'agent-session' && (params?.historyId === `structured-session-${sessionId}` || params?.conversationId === sessionId);
  });
}

/** Brings a pane's conversation forward: a decision waits there. */
export function showConversation(api: DockviewApi, conversationId: string): void {
  conversationPanel(api, conversationId)?.api.setActive();
}

/**
 * Shows a conversation's pane beside it and leaves keyboard focus where it was: the AI opening a page never takes the
 * person's typing. With no such conversation on screen, nothing opens; the view stays parked and the tools work.
 */
export function openBrowserPane(api: DockviewApi, conversationId: string, title: string): boolean {
  const existing = api.getPanel(browserPanelId(conversationId));
  if (existing) {
    existing.group.model.openPanel(existing, { skipSetGroupActive: true });
    return true;
  }
  const owner = conversationPanel(api, conversationId);
  if (!owner) return false;
  const focused = document.activeElement;
  const added = api.addPanel({
    id: browserPanelId(conversationId), component: BROWSER_PANE_COMPONENT, title, renderer: 'always', inactive: true,
    params: { conversationId },
    position: { referencePanel: owner, direction: 'right' },
  });
  // `inactive` leaves a new group with no panel shown, so the pane would sit empty: it is shown in its own group, which stays inactive.
  added.group.model.openPanel(added, { skipSetGroupActive: true });
  if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  return true;
}
