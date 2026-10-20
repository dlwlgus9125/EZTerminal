import { conversationFileChanges, type ConversationFileChange } from '../../shared/conversation-changes';
import type { DaemonTranscriptItem } from '../../shared/daemon-protocol';

/**
 * A long conversation opens with only its newest items loaded. "This whole
 * conversation" reads the older part once more, page by page, and keeps only
 * the change records: the conversation's own loaded window is left alone.
 */

const PAGE = 500;

export interface BackfillProgress {
  readonly loaded: number;
  readonly total: number;
}

export async function backfillConversationChanges({ sessionId, floor, readPage, signal, onProgress }: {
  readonly sessionId: string;
  /** Sequence below the oldest item already loaded; read everything up to it. */
  readonly floor: number;
  readonly readPage: (afterSequence: number, limit: number) => Promise<readonly DaemonTranscriptItem[]>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BackfillProgress) => void;
}): Promise<readonly ConversationFileChange[]> {
  const changes: ConversationFileChange[] = [];
  let cursor = 0;
  onProgress?.({ loaded: 0, total: floor });
  while (cursor < floor) {
    if (signal?.aborted) throw new DOMException('Backfill cancelled', 'AbortError');
    const limit = Math.min(PAGE, floor - cursor);
    const page = await readPage(cursor, limit);
    if (signal?.aborted) throw new DOMException('Backfill cancelled', 'AbortError');
    const valid = page
      .filter((item) => item.sessionId === sessionId && Number.isSafeInteger(item.sequence) && item.sequence > cursor && item.sequence <= floor)
      .sort((left, right) => left.sequence - right.sequence);
    if (valid.length === 0 || valid.some((item, index) => item.sequence !== cursor + index + 1)) {
      throw new Error('The earlier conversation page contains a sequence gap.');
    }
    changes.push(...conversationFileChanges(valid, sessionId));
    cursor = valid.at(-1)!.sequence;
    onProgress?.({ loaded: cursor, total: floor });
  }
  return changes;
}
