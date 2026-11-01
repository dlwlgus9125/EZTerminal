import type { ChatMessageContext } from '../shared/chat-message';
import type { DaemonTranscriptItem, DaemonTurn } from '../shared/daemon-protocol';
import type { SteerFallback } from '../shared/long-run';
import { parseTranscriptPayload } from '../shared/transcript-payload';

export interface ConversationQueueItem {
  readonly turnId: string;
  readonly revision: number;
  readonly text: string;
  readonly context?: ChatMessageContext;
  /** A review's 고치기: shown as the transcript names it ("검토 결과 고치기 · N개"), the message on demand. */
  readonly reviewFix?: { readonly findings: number };
  /** It was meant for the running turn and could not go in: why. */
  readonly fellBack?: SteerFallback;
}
export type ConversationQueueAction = 'remove' | 'take' | 'run-next';

/** Queue contents come from accepted user messages, never a second browser-owned queue. */
export function conversationQueue(sessionId: string, turns: readonly DaemonTurn[], items: readonly DaemonTranscriptItem[]): readonly ConversationQueueItem[] {
  const messages = new Map(items.filter(item => item.sessionId === sessionId && item.kind === 'user-message' && item.turnId).map(item => [item.turnId!, item]));
  return turns.filter(turn => turn.sessionId === sessionId && turn.state === 'queued')
    .sort((a, b) => (a.enqueueSequence ?? a.revision) - (b.enqueueSequence ?? b.revision))
    .flatMap(turn => {
      const message = messages.get(turn.id);
      if (!message) return [];
      const payload = message.payload ? parseTranscriptPayload(message.payload) : undefined;
      return [{
        turnId: turn.id, revision: turn.revision, text: message.text, context: message.context,
        ...(payload?.type === 'review-fix' ? { reviewFix: { findings: payload.findingIds.length } } : {}),
        ...(payload?.type === 'steer-queued' ? { fellBack: payload.reason } : {}),
      }];
    });
}
