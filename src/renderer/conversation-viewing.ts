import { useEffect, useState } from 'react';

import { CONVERSATION_VIEWING_HEARTBEAT_MS } from '../shared/conversation-viewing';
import { usePanelRuntimeLifecycle } from './desktop-runtime-lifecycle';

/** A focus change touches every panel at once, and a quick tab switch should not reach the host. */
export const CONVERSATION_VIEWING_DEBOUNCE_MS = 250;

/**
 * This window's report to the host of the conversations on screen. One reporter for the whole renderer:
 * split panes all count, and Dockview popouts share it.
 */
export function createConversationViewingReporter(send: (sessionIds: readonly string[]) => void) {
  const panels = new Map<string, string>();
  let lastSent: readonly string[] | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const current = (): readonly string[] => [...new Set(panels.values())].sort();
  const sendNow = (sessionIds: readonly string[]): void => {
    lastSent = sessionIds;
    send(sessionIds);
    if (sessionIds.length) heartbeat ??= setInterval(() => { if (lastSent) send(lastSent); }, CONVERSATION_VIEWING_HEARTBEAT_MS);
    else if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };
  const settle = (): void => {
    debounce = undefined;
    const next = current();
    if (next.length !== lastSent?.length || next.some((id, index) => id !== lastSent?.[index])) sendNow(next);
  };

  return {
    /** `sessionId`: what this panel shows on screen now; null when it shows nothing to a person. */
    set(panelId: string, sessionId: string | null): void {
      if (sessionId) panels.set(panelId, sessionId);
      else panels.delete(panelId);
      if (debounce === undefined) debounce = setTimeout(settle, CONVERSATION_VIEWING_DEBOUNCE_MS);
    },
    /** Reports at once, empty or not, so the host knows this window answers. Returns the stop. */
    start(): () => void {
      sendNow(current());
      return () => {
        if (debounce !== undefined) clearTimeout(debounce);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        debounce = undefined;
        heartbeat = undefined;
      };
    },
  };
}

const reporter = createConversationViewingReporter((sessionIds) => window.ezterminalDesktop?.reportConversationViewing?.(sessionIds));

/** Mounted once, for the app's life. */
export function useConversationViewingReporter(): void {
  useEffect(() => reporter.start(), []);
}

/** Reports `sessionId` as on screen while `onScreen` holds. Null for a draft with no conversation yet. */
export function useConversationViewing(panelId: string, sessionId: string | null, onScreen: boolean): void {
  useEffect(() => {
    if (!sessionId || !onScreen) return undefined;
    reporter.set(panelId, sessionId);
    return () => reporter.set(panelId, null);
  }, [onScreen, panelId, sessionId]);
}

interface ViewingPanelApi {
  readonly isVisible: boolean;
  readonly location: { readonly type: string };
  getWindow(): Window;
  onDidVisibilityChange(listener: (event: { readonly isVisible: boolean }) => void): { dispose(): void };
  onDidLocationChange(listener: () => void): { dispose(): void };
}

/**
 * A person is reading this panel: it is visible and its window focused, and the board does not cover the
 * main grid. Dockview still calls a panel under the board visible; a popout stays on screen over it.
 */
export function useConversationPanelOnScreen(api: ViewingPanelApi, mainGridOnScreen: boolean): boolean {
  const tier = usePanelRuntimeLifecycle(api);
  const [inMainGrid, setInMainGrid] = useState(api.location.type === 'grid');
  useEffect(() => {
    setInMainGrid(api.location.type === 'grid');
    const location = api.onDidLocationChange(() => setInMainGrid(api.location.type === 'grid'));
    return () => location.dispose();
  }, [api]);
  return tier === 'active' && (mainGridOnScreen || !inMainGrid);
}
