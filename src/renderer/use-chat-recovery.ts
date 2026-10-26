import { useEffect, useMemo, useSyncExternalStore } from 'react';
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
  const controller = useMemo(() => projectId && sessionId
    ? sharedChatRecovery({ projectId, sessionId }, access) : null, [access, projectId, sessionId]);
  const view = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? loadingSnapshot);
  useEffect(() => {
    if (!controller) return undefined;
    const release = retainChatRecovery(controller, access);
    void controller.load();
    return release;
  }, [access, controller]);
  return { controller, view };
}
