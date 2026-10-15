import type { ConversationEntry } from '../shared/conversation-history';
import type { ChatComposerDraft } from '../shared/chat-message';
import type { ChatStateSnapshot } from '../shared/chat-state';
import { ChatRecoveryController, type ChatStateAccess } from './chat-recovery';

export function hasConversationDraft(draft: ChatComposerDraft): boolean {
  return !!draft.text || !!draft.attachments?.length || !!draft.replyTo || !!draft.skills?.length;
}

/** Moves legacy session drafts into the canonical view once, without replaying their requests. */
export async function importConversationDraft(entry: ConversationEntry, recovery: ChatRecoveryController, storage: ChatStateAccess): Promise<ChatStateSnapshot | undefined> {
  await recovery.load();
  const sessions = [...new Set([entry.linkedSessionId, ...(entry.sessionAliases ?? [])].filter((id): id is string => !!id))];
  for (const sessionId of sessions) {
    if (recovery.getSnapshot().importedDraftSessionIds?.includes(sessionId)) continue;
    const result = await storage.chatStateRead({ projectId: entry.projectId, sessionId });
    if (!result.ok) throw new Error(result.message);
    if (result.snapshot.state.pendingSubmit) return result.snapshot;
    const draft = result.snapshot.state.draft;
    const current = recovery.getSnapshot();
    if (hasConversationDraft(draft) && !hasConversationDraft(current.draft)) recovery.updateDraft(draft);
    else if (hasConversationDraft(draft) && JSON.stringify(draft) !== JSON.stringify(current.draft)) continue;
    const saved = await recovery.saveComposition({ importedDraftSessionIds: [...(current.importedDraftSessionIds ?? []), sessionId] });
    if (!saved.ok) throw new Error(saved.message);
  }
  return undefined;
}
