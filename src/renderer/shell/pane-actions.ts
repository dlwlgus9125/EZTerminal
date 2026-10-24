import { createContext, useContext } from 'react';
import type { DockviewApi } from 'dockview-react';

/**
 * What a conversation's own header can do with its tab once the tab strip is
 * hidden (Board + Desk: a group showing one conversation drops its tab strip,
 * so the conversation header is the only row above the transcript).
 */
export interface PaneActions {
  readonly preview: boolean;
  readonly keep: () => void;
  readonly split: (direction: 'right' | 'below') => void;
  readonly moveToNewWindow?: () => void;
  readonly moveToMainWindow?: () => void;
  readonly close: () => void;
}

export const PaneActionsContext = createContext<PaneActions | null>(null);

export function usePaneActions(): PaneActions | null {
  return useContext(PaneActionsContext);
}

const CONVERSATION_COMPONENT = 'agent-session';

/** A group whose only tab is a conversation hides its tab strip; any other group keeps it. */
export function syncConversationGroupHeaders(api: DockviewApi): void {
  for (const group of api.groups) {
    const only = group.panels.length === 1 ? group.panels[0] : undefined;
    const hidden = only?.api.component === CONVERSATION_COMPONENT;
    if (group.header.hidden !== hidden) group.header.hidden = hidden;
  }
}

/** Keeps the rule above true as tabs open, close and move between groups and windows. */
export function installConversationGroupHeaders(api: DockviewApi): { dispose(): void } {
  let frame = 0;
  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; syncConversationGroupHeaders(api); });
  };
  syncConversationGroupHeaders(api);
  const disposables = [
    api.onDidAddPanel(schedule),
    api.onDidRemovePanel(schedule),
    api.onDidMovePanel(schedule),
    api.onDidAddGroup(schedule),
    api.onDidRemoveGroup(schedule),
    api.onDidLayoutFromJSON(schedule),
  ];
  return {
    dispose: () => {
      if (frame) cancelAnimationFrame(frame);
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
