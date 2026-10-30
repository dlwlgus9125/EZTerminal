import { useEffect } from 'react';

import { CONVERSATION_VIEWING_HEARTBEAT_MS } from '../../src/shared/conversation-viewing';

/**
 * Tells the host which conversation this phone has open while the app is in front. The transport keeps the
 * latest report for a reconnect. Mounted with the agents tab, so leaving it reports nothing open.
 */
export function useConversationViewing(
  transport: { readonly reportConversationViewing?: (sessionIds: readonly string[]) => void } | undefined,
  sessionId: string | null,
  pageVisible: boolean,
): void {
  const viewed = pageVisible ? sessionId : null;
  useEffect(() => {
    if (!transport?.reportConversationViewing) return undefined;
    const report = (): void => transport.reportConversationViewing?.(viewed ? [viewed] : []);
    report();
    if (!viewed) return undefined;
    const heartbeat = setInterval(report, CONVERSATION_VIEWING_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      transport.reportConversationViewing?.([]);
    };
  }, [transport, viewed]);
}
