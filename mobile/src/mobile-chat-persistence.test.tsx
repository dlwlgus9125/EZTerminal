import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDaemonCommand, type DaemonCommand, type DaemonCommandReceipt, type DaemonSnapshot, type DaemonTranscriptItem } from '../../src/shared/daemon-protocol';
import { MobileChatStateStore, type MobileChatScope } from './mobile-chat-state-store';
import { MobileOfflineChatCacheStore } from './mobile-offline-chat-cache';
import { mobileAgentCreateAuthorityFingerprint, type SecureStorageLike } from './mobile-agent-create-recovery-store';
import { useMobileChatDraft } from './use-mobile-chat-draft';
import { mobilePlanningDraftStorage } from './mobile-planning-draft-store';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
const receipt: DaemonCommandReceipt = { ok: true, status: 'applied', commandId: 'submit-1', revision: 5, eventSequence: 7 };

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

describe('Android draft and submit lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let secure: SecureMemory;
  let store: MobileChatStateStore;
  let transport: WsEzTerminalTransport;
  let send: ReturnType<typeof vi.fn>;
  let latest: ReturnType<typeof useMobileChatDraft>;
  let sessionId: string;
  const Harness = () => { latest = useMobileChatDraft({ transport, projectId: 'project', sessionId, store }); return <output>{latest.status}</output>; };
  const render = async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  };
  beforeEach(() => {
    localStorage.clear(); secure = new SecureMemory(); store = new MobileChatStateStore(secure); sessionId = 'chat';
    send = vi.fn(async () => receipt);
    transport = { isAuthed: false, getRemoteToken: async () => 'test-pc', sendDaemonCommand: send } as unknown as WsEzTerminalTransport;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('persists an offline draft across force-remount and never sends it on reconnect', async () => {
    await render();
    await act(async () => { latest.onDraftChange({ text: 'offline draft', selectionStart: 3, selectionEnd: 3 }); });
    expect(latest.status).toBe('saved');
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(latest.draftState?.text).toBe('offline draft');
    Object.assign(transport, { isAuthed: true }); await render();
    expect(send).not.toHaveBeenCalled();
    expect(latest.draftState?.selectionStart).toBe(3);
  });

  it('keeps a lost receipt in escrow across restart and reconciles only the original command explicitly', async () => {
    Object.assign(transport, { isAuthed: true }); send.mockResolvedValue(null);
    await render(); await act(async () => latest.onDraftChange({ text: 'draft' }));
    const original = command();
    await act(async () => { expect(await latest.send(original)).toBeNull(); });
    expect(latest.pending).toEqual(original);
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => latest.onDraftChange({ text: 'new unsent draft' }));
    await act(async () => { expect(await latest.send(command('new', 'different'))).toBeNull(); });
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue(receipt);
    await act(async () => { await latest.send(latest.pending!); });
    expect(send.mock.calls[1][0]).toEqual(original);
    expect(latest.pending).toBeUndefined();
    expect(latest.draftState?.text).toBe('new unsent draft');
  });

  it('does not dispatch when preparation cannot be saved and restores the record on storage retry', async () => {
    Object.assign(transport, { isAuthed: true }); await render();
    await act(async () => latest.onDraftChange({ text: 'draft' })); secure.fail = true;
    await act(async () => { expect(await latest.send(command())).toBeNull(); });
    expect(send).not.toHaveBeenCalled(); expect(latest.status).toBe('unavailable');
    secure.fail = false;
    await act(async () => latest.retryStorage());
    expect(latest.status).toBe('saved'); expect(send).not.toHaveBeenCalled();
  });

  it('preserves edits made while a command is in flight and binds a different session separately', async () => {
    Object.assign(transport, { isAuthed: true }); await render();
    await act(async () => latest.onDraftChange({ text: 'draft' }));
    let resolve!: (value: DaemonCommandReceipt) => void;
    send.mockImplementation(() => new Promise<DaemonCommandReceipt>(done => { resolve = done; }));
    let request!: Promise<DaemonCommandReceipt | null>;
    await act(async () => { request = latest.send(command()); await Promise.resolve(); });
    await act(async () => latest.onDraftChange({ text: 'next draft' }));
    await act(async () => { resolve(receipt); await request; });
    expect(latest.draftState?.text).toBe('next draft');
    sessionId = 'other'; await render(); expect(latest.draftState?.text).toBe('');
    sessionId = 'chat'; await render(); expect(latest.draftState?.text).toBe('next draft');
    const authority = await mobileAgentCreateAuthorityFingerprint('test-pc');
    expect((await store.load({ ...scope, authorityFingerprint: authority }))?.pending).toBeUndefined();
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
    const agentUsage = { chat: { contextPercent: 3, observedAt: 1 } };
    await store.saveSnapshot(AUTHORITY, { ...snapshot, agentUsage });
    expect([...secure.values.values()].some((raw) => raw.includes('agentUsage'))).toBe(false);
    expect((await store.load(AUTHORITY))?.snapshot).toEqual(snapshot);

    // An older build stored the whole snapshot.
    const [key] = [...secure.values.keys()];
    const stored = JSON.parse(secure.values.get(key)!) as { snapshot: DaemonSnapshot };
    secure.values.set(key, JSON.stringify({ ...stored, snapshot: { ...stored.snapshot, agentUsage } }));
    expect((await store.load(AUTHORITY))?.snapshot).not.toHaveProperty('agentUsage');
  });
});

describe('Android planning draft recovery', () => {
  it('preserves project drafts only in secure storage and rejects a record copied from another PC', async () => {
    localStorage.clear();
    const secure = new SecureMemory();
    const draft = { version: 1 as const, projectId: 'project', snapshot: null, selectedId: null, edits: {}, uncertain: null, entityDrafts: { scenes: {}, components: {}, profiles: {}, tasks: {} } };
    const store = mobilePlanningDraftStorage('project', async () => 'pc-a', secure);
    await store.saveDraft(draft);
    expect(await mobilePlanningDraftStorage('project', async () => 'pc-a', secure).loadDraft()).toEqual(draft);
    const other = mobilePlanningDraftStorage('project', async () => 'pc-b', secure);
    expect(await other.loadDraft()).toBeNull();
    const oldRaw = [...secure.values.values()][0];
    await other.saveDraft(draft);
    const otherKey = [...secure.values.keys()][1]; secure.values.set(otherKey, oldRaw);
    await expect(other.loadDraft()).rejects.toThrow('scope');
    secure.fail = true;
    await expect(store.saveDraft(draft)).rejects.toThrow('Keystore');
    expect(localStorage.length).toBe(0);
  });
});
