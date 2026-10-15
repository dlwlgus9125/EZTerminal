import type { DaemonTranscriptItem } from '../shared/daemon-protocol';

export type ConversationTranscriptGroup<T> = { readonly id: string; readonly execution: boolean; readonly items: readonly T[] };
/** Group only adjacent execution records from the same turn; messages/approvals remain in place. */
export function conversationTranscriptGroups<T extends DaemonTranscriptItem>(items: readonly T[]): readonly ConversationTranscriptGroup<T>[] {
  const groups: { id: string; execution: boolean; items: T[] }[] = [];
  for (const item of items) {
    const execution = ['tool-call', 'tool-result', 'reasoning'].includes(item.kind);
    const previous = groups.at(-1);
    if (execution && previous?.execution && previous.items[0].sessionId === item.sessionId && previous.items[0].turnId === item.turnId) previous.items.push(item);
    else groups.push({ id: item.messageId ?? item.id, execution, items: [item] });
  }
  return groups;
}
