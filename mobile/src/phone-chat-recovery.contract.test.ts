import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatRecoveryController } from '../../src/renderer/chat-recovery';
import { sharedChatRecovery } from '../../src/renderer/chat-recovery-registry';
import { reconcileConversationSubmit, submitConversationMessage } from '../../src/renderer/conversation-commands';
import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../../src/shared/daemon-protocol';
import { mobileAgentCreateAuthorityFingerprint, type SecureStorageLike } from './mobile-agent-create-recovery-store';
import { MobileChatStateStore } from './mobile-chat-state-store';
import { PHONE_PRINCIPAL, phoneChatStateAccess, phoneConversationCommands } from './phone-conversation-access';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

/**
 * The phone's conversation draft on the shared recovery controller (I4-3): every case the old
 * useMobileChatDraft hook guaranteed, on the path the conversation screen and the terminal's AI
 * input now share.
 */

class SecureMemory implements SecureStorageLike {
  readonly values = new Map<string, string>();
  fail = false;
  async getPlatform() { return { value: 'android' }; }
  async keys() { return { value: [...this.values.keys()] }; }
  async get({ key }: { key: string }) { return { value: this.values.get(key)! }; }
  async set({ key, value }: { key: string; value: string }) {
    if (this.fail) throw new Error('Keystore unavailable');
    this.values.set(key, value); return { value: true };
  }
  async remove({ key }: { key: string }) { return { value: this.values.delete(key) }; }
}

const accepted: DaemonCommandReceipt = { ok: true, status: 'applied', commandId: 'x', revision: 5, eventSequence: 7 };
const uncertain = { ok: false, status: 'delivery-uncertain', commandId: 'x', error: { code: 'delivery-uncertain', message: 'lost' } } as unknown as DaemonCommandReceipt;

function setup(secure = new SecureMemory()) {
  const store = new MobileChatStateStore(secure);
  const send = vi.fn<(command: DaemonCommand) => Promise<DaemonCommandReceipt>>(async () => accepted);
  const transport = {
    getRemoteToken: async () => 'test-pc',
    getDaemonSnapshot: async () => ({ revision: 4 }) as DaemonSnapshot,
    sendDaemonCommand: (command: DaemonCommand) => send(command),
  } as unknown as WsEzTerminalTransport;
  // A fresh storage object per "app start"; the stored record is what survives.
  const open = async (sessionId = 'chat') => {
    const controller = new ChatRecoveryController({ projectId: 'project', sessionId }, phoneChatStateAccess(transport, { store }));
    await controller.load();
    return controller;
  };
  return { secure, store, send, transport, open, commands: phoneConversationCommands(transport) };
}

describe('phone conversation draft on the shared recovery controller', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves an offline draft across a restart, writing twice in a row, and never sends it', async () => {
    const { open, send } = setup();
    const first = await open();
    expect(first.getSnapshot().status).toBe('ready');
    first.updateDraft({ text: 'offline', selectionStart: 3, selectionEnd: 3 });
    await first.flush();
    first.updateDraft({ text: 'offline draft', selectionStart: 3, selectionEnd: 3 });
    await first.flush();
    // The second write was not refused as stale (the record has no revision of its own).
    expect(first.getSnapshot().status).toBe('ready');
    const restarted = await open();
    expect(restarted.getSnapshot().draft).toEqual({ text: 'offline draft', selectionStart: 3, selectionEnd: 3 });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a lost receipt in escrow across a restart and settles only that exact command', async () => {
    const { open, send, commands } = setup();
    const before = await open();
    before.updateDraft({ text: 'draft' });
    await before.flush();
    send.mockResolvedValueOnce(uncertain);
    const result = await submitConversationMessage(commands, { sessionId: 'chat', recovery: before, type: 'agent.submit', prompt: 'draft' });
    expect(result).toMatchObject({ ok: false, deliveryUncertain: true });
    const original = send.mock.calls[0]![0];
    expect(original.principal).toEqual(PHONE_PRINCIPAL);

    const after = await open();
    expect(after.getSnapshot().pendingSubmit?.command).toEqual(original);
    after.updateDraft({ text: 'new unsent draft' });
    await after.flush();
    // A new message waits for the uncertain one.
    expect(await submitConversationMessage(commands, { sessionId: 'chat', recovery: after, type: 'agent.submit', prompt: 'new unsent draft' }))
      .toMatchObject({ ok: false, deliveryUncertain: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await reconcileConversationSubmit(commands, { recovery: after })).toEqual({ ok: true });
    expect(send.mock.calls[1]![0]).toEqual(original);
    expect(after.getSnapshot().pendingSubmit).toBeUndefined();
    expect(after.getSnapshot().draft.text).toBe('new unsent draft');
  });

  it('does not send when the escrow cannot be saved, and reads storage again on retry', async () => {
    const { open, send, commands, secure } = setup();
    const controller = await open();
    controller.updateDraft({ text: 'draft' });
    await controller.flush();
    secure.fail = true;
    const result = await submitConversationMessage(commands, { sessionId: 'chat', recovery: controller, type: 'agent.submit', prompt: 'draft' });
    expect(result.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe('error');
    secure.fail = false;
    await controller.checkStored();
    expect(controller.getSnapshot().status).toBe('ready');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps an edit made while the message is in flight and keeps sessions apart', async () => {
    const { open, send, commands, store } = setup();
    const controller = await open();
    controller.updateDraft({ text: 'draft' });
    await controller.flush();
    let resolve!: (receipt: DaemonCommandReceipt) => void;
    send.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const request = submitConversationMessage(commands, { sessionId: 'chat', recovery: controller, type: 'agent.submit', prompt: 'draft' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    controller.updateDraft({ text: 'next draft' });
    resolve(accepted);
    expect(await request).toEqual({ ok: true });
    expect(controller.getSnapshot().draft.text).toBe('next draft');
    expect((await open('other')).getSnapshot().draft.text).toBe('');
    expect((await open('chat')).getSnapshot().draft.text).toBe('next draft');
    // The record an older build reads: schema 1, no pending envelope once settled.
    const fingerprint = await mobileAgentCreateAuthorityFingerprint('test-pc');
    const stored = await store.load({ authorityFingerprint: fingerprint, projectId: 'project', sessionId: 'chat' });
    expect(stored).toMatchObject({ schemaVersion: 1, draft: { text: 'next draft' } });
    expect(stored?.pending).toBeUndefined();
  });

  it('writes an escrow an older build can read: schema 1 with the phone principal', async () => {
    const { open, send, commands, store } = setup();
    const controller = await open();
    controller.updateDraft({ text: 'hello' });
    await controller.flush();
    send.mockResolvedValueOnce(uncertain);
    await submitConversationMessage(commands, { sessionId: 'chat', recovery: controller, type: 'agent.submit', prompt: 'hello' });
    const fingerprint = await mobileAgentCreateAuthorityFingerprint('test-pc');
    const stored = await store.load({ authorityFingerprint: fingerprint, projectId: 'project', sessionId: 'chat' });
    expect(stored?.schemaVersion).toBe(1);
    expect(stored?.pending?.principal).toEqual(PHONE_PRINCIPAL);
    expect(stored?.pending?.type).toBe('agent.submit');
  });

  it('gives the conversation screen and the terminal one controller per conversation on a PC connection', () => {
    const { transport } = setup();
    const access = phoneChatStateAccess(transport);
    expect(phoneChatStateAccess(transport)).toBe(access);
    const scope = { projectId: 'project', sessionId: 'chat' };
    expect(sharedChatRecovery(scope, access)).toBe(sharedChatRecovery(scope, phoneChatStateAccess(transport)));
  });
});
