import type { DaemonTranscriptItem } from '../shared/daemon-protocol';

/**
 * The provider's replies in one turn, once each, as reviewable text.
 *
 * Codex and Claude mark every user, assistant and reasoning row sensitive. That flag is metadata
 * (docs/design/agent-collaboration.md), not a reason to drop the person's own conversation from the
 * result it produced, so replies count whatever their flag. A reply streamed in deltas is its final
 * row, or its deltas joined when no final row arrived.
 */
export function turnReplies(items: readonly DaemonTranscriptItem[]): DaemonTranscriptItem[] {
  const replies = new Map<string, DaemonTranscriptItem>();
  for (const item of items) {
    if (item.kind !== 'assistant-message') continue;
    const key = item.messageId ?? item.id;
    const previous = replies.get(key);
    if (!item.isDelta) replies.set(key, item);
    else if (!previous) replies.set(key, item);
    else if (previous.isDelta) replies.set(key, { ...item, text: previous.text + item.text });
  }
  return [...replies.values()].map(item => item.isDelta ? { ...item, isDelta: false } : item).sort((a, b) => a.sequence - b.sequence);
}
