import type { ChatMessageContext } from '../shared/chat-message';
import type { DaemonTranscriptItem, DaemonTurn } from '../shared/daemon-protocol';

export interface ConversationQueueItem {
  readonly turnId: string;
  readonly revision: number;
  readonly text: string;
  readonly context?: ChatMessageContext;
}
export type ConversationQueueAction = 'remove' | 'take' | 'run-next';

/** Queue contents come from accepted user messages, never a second browser-owned queue. */
export function conversationQueue(sessionId: string, turns: readonly DaemonTurn[], items: readonly DaemonTranscriptItem[]): readonly ConversationQueueItem[] {
  const messages = new Map(items.filter(item => item.sessionId === sessionId && item.kind === 'user-message' && item.turnId).map(item => [item.turnId!, item]));
  return turns.filter(turn => turn.sessionId === sessionId && turn.state === 'queued')
    .sort((a, b) => (a.enqueueSequence ?? a.revision) - (b.enqueueSequence ?? b.revision))
    .flatMap(turn => {
      const message = messages.get(turn.id);
      return message ? [{ turnId: turn.id, revision: turn.revision, text: message.text, context: message.context }] : [];
    });
}
