import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ChatRecoveryController, type ChatRecoveryView, type ChatStateAccess } from './chat-recovery';

const desktopChatState: ChatStateAccess = {
  chatStateRead: (scope) => window.ezterminal.chatStateRead(scope),
  chatStateWrite: (scope, request) => window.ezterminal.chatStateWrite(scope, request),
};
const loading: ChatRecoveryView = { status: 'loading', draft: { text: '' } };
const noSubscribe = (): (() => void) => () => undefined;
const loadingSnapshot = (): ChatRecoveryView => loading;

export function useChatRecovery(projectId: string | undefined, sessionId: string | null, access: ChatStateAccess = desktopChatState) {
  const controller = useMemo(() => projectId && sessionId
    ? new ChatRecoveryController({ projectId, sessionId }, access) : null, [access, projectId, sessionId]);
  const view = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? loadingSnapshot);
  useEffect(() => { if (controller) void controller.load(); }, [controller]);
  return { controller, view };
}
