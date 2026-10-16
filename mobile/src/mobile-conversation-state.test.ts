import { describe, expect, it } from 'vitest';
import type { ChatStateScope } from '../../src/shared/chat-state';
import { createDaemonCommand } from '../../src/shared/daemon-protocol';
import { MobileChatStateStore } from './mobile-chat-state-store';
import { mobileAgentCreateAuthorityFingerprint, type SecureStorageLike } from './mobile-agent-create-recovery-store';
import { mobileConversationState } from './mobile-conversation-state';

class EncryptedStorageFixture implements SecureStorageLike {
  values = new Map<string, string>();
  platform = 'android';
  rejectWrites = false;
  async getPlatform() { return { value: this.platform }; }
  async keys() { return { value: [...this.values.keys()] }; }
  async get({ key }: { key: string }) { return { value: this.values.get(key)! }; }
  async set({ key, value }: { key: string; value: string }) {
    if (!this.rejectWrites) this.values.set(key, value);
    return { value: !this.rejectWrites };
  }
  async remove({ key }: { key: string }) { return { value: this.values.delete(key) }; }
}
const scope: ChatStateScope = { kind: 'draft', projectId: 'project', sessionId: 'draft' };

describe('encrypted mobile conversation state', () => {
  it('restores full composition and navigation after restart, isolated by PC', async () => {
    const secure = new EncryptedStorageFixture();
    const storage = mobileConversationState(async () => 'pc-one', secure);
    const draft = { text: 'unsent', selectionStart: 2, selectionEnd: 4, replyTo: { messageId: 'message', text: 'quote' } };
    expect(await storage.chatStateWrite(scope, { expectedRevision: 0, state: { draft } })).toMatchObject({ ok: true });
    await storage.saveNavigation({ draftId: 'draft', target: { workspaceId: 'workspace' } });
    const restarted = mobileConversationState(async () => 'pc-one', secure);
    expect(await restarted.chatStateRead(scope)).toMatchObject({ ok: true, snapshot: { revision: 1, state: { draft } } });
    expect(await restarted.loadNavigation()).toMatchObject({ value: { draftId: 'draft', target: { workspaceId: 'workspace' } } });
    const otherPC = mobileConversationState(async () => 'pc-two', secure);
    expect(await otherPC.chatStateRead(scope)).toMatchObject({ ok: true, snapshot: { revision: 0, state: { draft: { text: '' } } } });
    expect((await otherPC.loadNavigation()).value).toBeNull();
  });

  it('rejects a stale save without replacing newer edits', async () => {
    const secure = new EncryptedStorageFixture();
    const storage = mobileConversationState(async () => 'pc-one', secure);
    const results = await Promise.all(['newer', 'stale'].map(text => storage.chatStateWrite(scope, { expectedRevision: 0, state: { draft: { text } } })));
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false, error: 'stale' });
    expect(await storage.chatStateRead(scope)).toMatchObject({ ok: true, snapshot: { state: { draft: { text: 'newer' } } } });
  });

  it('retains an exact pending Android envelope when reading a legacy draft', async () => {
    const secure = new EncryptedStorageFixture();
    const liveScope = { projectId: 'project', sessionId: 'session' };
    const pending = createDaemonCommand({ commandId: 'submit-once', idempotencyKey: 'submit-once', expectedRevision: 4,
      issuedAt: '2026-10-14T00:00:00.000Z', principal: { kind: 'android', id: 'mobile' }, type: 'agent.submit', payload: { sessionId: 'session', prompt: 'pending message' } });
    const legacy = new MobileChatStateStore(secure);
    await legacy.save({ schemaVersion: 1, scope: { ...liveScope, authorityFingerprint: await mobileAgentCreateAuthorityFingerprint('pc-one') }, draft: { text: 'pending message' }, pending });
    const storage = mobileConversationState(async () => 'pc-one', secure);
    expect(await storage.chatStateRead(liveScope)).toMatchObject({ ok: true, snapshot: { state: { pendingSubmit: { command: pending } } } });
    expect(await storage.chatStateRead(liveScope)).toMatchObject({ ok: true, snapshot: { state: { pendingSubmit: { command: pending } } } });
  });

  it('fails closed for unavailable encryption, refused writes and foreign scope records', async () => {
    const secure = new EncryptedStorageFixture();
    const storage = mobileConversationState(async () => 'pc-one', secure);
    secure.platform = 'web';
    expect(await storage.chatStateRead(scope)).toMatchObject({ ok: false, error: 'unavailable' });
    secure.platform = 'android'; secure.rejectWrites = true;
    expect(await storage.chatStateWrite(scope, { expectedRevision: 0, state: { draft: { text: 'retain' } } })).toMatchObject({ ok: false });
    secure.rejectWrites = false;
    await storage.chatStateWrite(scope, { expectedRevision: 0, state: { draft: { text: 'retain' } } });
    const [key, raw] = [...secure.values.entries()][0];
    const record = JSON.parse(raw); record.scope.sessionId = 'another-conversation'; secure.values.set(key, JSON.stringify(record));
    expect(await storage.chatStateRead(scope)).toMatchObject({ ok: false, error: 'unavailable' });
  });
});
