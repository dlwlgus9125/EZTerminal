import { describe, expect, it } from 'vitest';

import { createDaemonCommand, type DaemonCommand, type DaemonSnapshot, type DaemonTranscriptItem } from '../../src/shared/daemon-protocol';
import { MobileChatStateStore, type MobileChatScope } from './mobile-chat-state-store';
import { MobileOfflineChatCacheStore } from './mobile-offline-chat-cache';
import type { SecureStorageLike } from './mobile-agent-create-recovery-store';

const NOW = '2026-10-13T00:00:00.000Z';
const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const scope: MobileChatScope = { authorityFingerprint: AUTHORITY, projectId: 'project', sessionId: 'chat' };

class SecureMemory implements SecureStorageLike {
  readonly values = new Map<string, string>();
  platform = 'android';
  fail = false;
  corruptReadback = false;
  async getPlatform() { return { value: this.platform }; }
  async keys() { return { value: [...this.values.keys()] }; }
  async get({ key }: { key: string }) { return { value: this.corruptReadback ? 'corrupt' : this.values.get(key)! }; }
  async set({ key, value }: { key: string; value: string }) {
    if (this.fail) throw new Error('Keystore unavailable');
    this.values.set(key, value); return { value: true };
  }
  async remove({ key }: { key: string }) { return { value: this.values.delete(key) }; }
}

const command = (id = 'submit-1', prompt = 'draft'): DaemonCommand => createDaemonCommand({
  commandId: id, idempotencyKey: id, expectedRevision: 4, issuedAt: NOW,
  principal: { kind: 'android', id: 'mobile-agent-ui' }, type: 'agent.submit',
  payload: { sessionId: 'chat', prompt,
    context: { attachments: [{ id: 'file', name: 'note.txt', mimeType: 'text/plain', kind: 'text', data: 'context' }], replyTo: { messageId: 'reply', text: 'Earlier message' }, skills: [{ providerId: 'codex', id: '/skills/review/SKILL.md', name: 'review', invocation: '$review' }] } },
});

describe('Android scoped secure chat persistence', () => {
  it('restores text, attachment, reply, selection and the exact command after a new store instance', async () => {
    const secure = new SecureMemory();
    const store = new MobileChatStateStore(secure);
    const pending = command();
    const draft = { text: 'draft', selectionStart: 2, selectionEnd: 4, ...('context' in pending.payload ? pending.payload.context : {}) };
    await store.save({ schemaVersion: 1, scope, draft, pending });
    expect(await new MobileChatStateStore(secure).load(scope)).toEqual({ schemaVersion: 1, scope, draft, pending });
    for (const changed of [{ projectId: 'other' }, { sessionId: 'other' }, { authorityFingerprint: `sha256:${'b'.repeat(64)}` }]) {
      expect(await store.load({ ...scope, ...changed })).toBeNull();
    }
    expect(localStorage.length).toBe(0);
  });

  it('rejects swapped scope, non-Android storage, malformed records and failed readback without plaintext fallback', async () => {
    const secure = new SecureMemory();
    const store = new MobileChatStateStore(secure);
    await store.save({ schemaVersion: 1, scope, draft: { text: 'private' } });
    const key = [...secure.values.keys()][0];
    const original = secure.values.get(key)!;
    secure.values.set(key, original.replace('"projectId":"project"', '"projectId":"wrong"'));
    await expect(store.load(scope)).rejects.toThrow('scope');
    secure.values.set(key, '{bad');
    await expect(store.load(scope)).rejects.toThrow();
    expect(secure.values.get(key)).toBe('{bad');
    secure.platform = 'web';
    await expect(store.save({ schemaVersion: 1, scope, draft: { text: 'private' } })).rejects.toThrow('Android');
    secure.platform = 'android'; secure.corruptReadback = true;
    await expect(store.save({ schemaVersion: 1, scope, draft: { text: 'private' } })).rejects.toThrow('verified');
    expect(localStorage.length).toBe(0);
  });

  it('rejects a pending command for another session and oversized context', async () => {
    const secure = new SecureMemory();
    const store = new MobileChatStateStore(secure);
    await expect(store.save({ schemaVersion: 1, scope: { ...scope, sessionId: 'wrong' }, draft: { text: '' }, pending: command() })).rejects.toThrow();
    await expect(store.save({ schemaVersion: 1, scope, draft: { text: '', attachments: [{ id: 'huge', name: 'huge.txt', mimeType: 'text/plain', kind: 'text', data: 'a'.repeat(500 * 1024) }] } })).rejects.toThrow();
    expect(secure.values.size).toBe(0);
  });
});

describe('encrypted offline transcript cache', () => {
  const snapshot: DaemonSnapshot = {
    protocolVersion: 12, revision: 1, eventSequence: 1, generatedAt: NOW,
    runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [], workspaces: [], sessions: [{ id: 'chat', projectId: 'project', workspaceId: 'workspace', kind: 'agent', title: 'Chat', state: 'idle', source: 'structured', revision: 1, createdAt: NOW, updatedAt: NOW }],
    agents: [], agentRelations: [], turns: [], transcriptHeads: [], approvals: [], providers: [], schedules: [], heartbeats: [],
  };
  const item = (sequence: number, isSensitive = false): DaemonTranscriptItem => ({ id: `item-${sequence}`, sessionId: 'chat', sequence, kind: 'assistant-message', text: 'Cached', isDelta: false, isSensitive, createdAt: NOW });
  it('serializes snapshot and transcript writes, excludes sensitive content and never crosses PC identities', async () => {
    const secure = new SecureMemory(); const store = new MobileOfflineChatCacheStore(secure);
    await Promise.all([store.saveSnapshot(AUTHORITY, snapshot), store.saveTranscript(AUTHORITY, 'chat', [item(1), item(2, true)])]);
    expect((await new MobileOfflineChatCacheStore(secure).load(AUTHORITY))?.transcripts.chat).toEqual([item(1)]);
    expect(await store.load(`sha256:${'b'.repeat(64)}`)).toBeNull();
    await store.saveSnapshot(AUTHORITY, { ...snapshot, sessions: [] });
    expect((await store.load(AUTHORITY))?.transcripts).toEqual({});
  });

  it('keeps no usage on the phone, even from a cache an older build wrote', async () => {
    const secure = new SecureMemory(); const store = new MobileOfflineChatCacheStore(secure);
    const agentUsage = { chat: { contextPercent: 3, contextObservedAt: 1 } };
    const providerUsage = { codex: { weekly: { usedPercent: 26 }, limitsObservedAt: 1 } };
    await store.saveSnapshot(AUTHORITY, { ...snapshot, agentUsage, providerUsage });
    expect([...secure.values.values()].some((raw) => raw.includes('Usage'))).toBe(false);
    expect((await store.load(AUTHORITY))?.snapshot).toEqual(snapshot);

    // An older build stored the whole snapshot.
    const [key] = [...secure.values.keys()];
    const stored = JSON.parse(secure.values.get(key)!) as { snapshot: DaemonSnapshot };
    secure.values.set(key, JSON.stringify({ ...stored, snapshot: { ...stored.snapshot, agentUsage, providerUsage } }));
    expect((await store.load(AUTHORITY))?.snapshot).toEqual(snapshot);
  });
});
