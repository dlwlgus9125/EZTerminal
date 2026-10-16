import { describe, expect, it } from 'vitest';
import { createDaemonCommand } from '../shared/daemon-protocol';
import type { ChatStateSnapshot } from '../shared/chat-state';
import type { ConversationEntry } from '../shared/conversation-history';
import { ChatRecoveryController, type ChatStateAccess } from './chat-recovery';
import { importConversationDraft } from './conversation-draft-migration';

describe('canonical conversation draft migration', () => {
  it('imports the complete legacy draft once and does not resurrect it after sending', async () => {
    const scope = { projectId: 'project', sessionId: 'conversation_1', kind: 'conversation' as const };
    const legacy: ChatStateSnapshot = { version: 1, scope: { projectId: 'project', sessionId: 'session-1' }, revision: 2,
      state: { draft: { text: 'Saved question', replyTo: { messageId: 'message', text: 'quoted message' }, selectionStart: 2, selectionEnd: 2 } }, updatedAt: null };
    let canonical: ChatStateSnapshot = { version: 2, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null };
    const storage: ChatStateAccess = { chatStateRead: async target => ({ ok: true, snapshot: target.kind ? canonical : legacy }),
      chatStateWrite: async (_target, request) => { canonical = { ...canonical, state: request.state, revision: canonical.revision + 1 }; return { ok: true, snapshot: canonical }; } };
    const entry = { projectId: 'project', linkedSessionId: 'session-1' } as ConversationEntry;
    const recovery = new ChatRecoveryController(scope, storage);
    expect(await importConversationDraft(entry, recovery, storage)).toBeUndefined();
    expect(recovery.getSnapshot().draft).toEqual(legacy.state.draft);
    recovery.updateDraft({ text: '' }); await recovery.flush();
    const restarted = new ChatRecoveryController(scope, storage);
    await importConversationDraft(entry, restarted, storage);
    expect(restarted.getSnapshot().draft.text).toBe('');
  });
  it('returns an unconfirmed legacy message for explicit reconciliation without moving it', async () => {
    const scope = { projectId: 'project', sessionId: 'conversation_1', kind: 'conversation' as const };
    const command = createDaemonCommand({ commandId: 'message-1', idempotencyKey: 'message-1', expectedRevision: 1, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' }, type: 'agent.submit', payload: { sessionId: 'session-1', prompt: 'Hello' } });
    const legacy: ChatStateSnapshot = { version: 1, scope: { projectId: 'project', sessionId: 'session-1' }, revision: 2,
      state: { draft: { text: 'Newer draft' }, pendingSubmit: { command, mode: 'send', recordedAt: command.issuedAt } }, updatedAt: null };
    const storage: ChatStateAccess = { chatStateRead: async target => ({ ok: true, snapshot: target.kind ? { version: 2, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null } : legacy }),
      chatStateWrite: async () => { throw new Error('Must not mutate pending recovery while reading'); } };
    const recovery = new ChatRecoveryController(scope, storage);
    expect(await importConversationDraft({ projectId: 'project', linkedSessionId: 'session-1' } as ConversationEntry, recovery, storage)).toEqual(legacy);
    expect(recovery.getSnapshot().draft.text).toBe('');
  });
});
