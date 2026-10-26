import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ChatRecoveryView, ChatStateAccess } from './chat-recovery';
import { retainChatRecovery, sharedChatRecovery } from './chat-recovery-registry';

const desktopChatState: ChatStateAccess = {
  chatStateRead: (scope) => window.ezterminal.chatStateRead(scope),
  chatStateWrite: (scope, request) => window.ezterminal.chatStateWrite(scope, request),
};
const loading: ChatRecoveryView = { status: 'loading', draft: { text: '' } };
const noSubscribe = (): (() => void) => () => undefined;
const loadingSnapshot = (): ChatRecoveryView => loading;

/** The conversation's draft recovery, shared with every other view of the same conversation in this renderer. */
export function useChatRecovery(projectId: string | undefined, sessionId: string | null, access: ChatStateAccess = desktopChatState) {
  // Bumped when the controller looked up while rendering was replaced before this view held it.
  const [lookup, relookup] = useState(0);
  const controller = useMemo(() => projectId && sessionId
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lookup` forces a fresh lookup
    ? sharedChatRecovery({ projectId, sessionId }, access) : null, [access, projectId, sessionId, lookup]);
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
