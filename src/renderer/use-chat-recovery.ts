import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ChatRecoveryView, ChatStateAccess } from './chat-recovery';
import { retainChatRecovery, sharedChatRecovery } from './chat-recovery-registry';

/**
 * The desktop's encrypted draft storage. One object for the whole renderer: shared draft
 * controllers are kept per storage object, so every box that uses this one shares drafts.
 */
export const desktopChatStateAccess: ChatStateAccess = {
  chatStateRead: (scope) => window.ezterminal.chatStateRead(scope),
  chatStateWrite: (scope, request) => window.ezterminal.chatStateWrite(scope, request),
};
const desktopChatState = desktopChatStateAccess;
const loading: ChatRecoveryView = { status: 'loading', draft: { text: '' } };
const noSubscribe = (): (() => void) => () => undefined;
const loadingSnapshot = (): ChatRecoveryView => loading;

/** The conversation's draft recovery, shared with every other view of the same conversation in this renderer. */
export function useChatRecovery(
  projectId: string | undefined,
  sessionId: string | null,
  access: ChatStateAccess = desktopChatState,
  /** `draft`: a new conversation's start box (scoped like ConversationStartPanel). */
  kind?: 'draft',
) {
  // Bumped when the controller looked up while rendering was replaced before this view held it.
  const [lookup, relookup] = useState(0);
  const controller = useMemo(() => projectId && sessionId
    ? sharedChatRecovery({ projectId, sessionId, ...(kind ? { kind } : {}) }, access) : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `lookup` forces a fresh lookup
  [access, projectId, sessionId, kind, lookup]);
  const view = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? loadingSnapshot);
  useEffect(() => {
    if (!controller) return undefined;
    const release = retainChatRecovery(controller);
    if (!release) { relookup((value) => value + 1); return undefined; }
    void controller.load();
    return release;
  }, [controller]);
  return { controller, view };
}
