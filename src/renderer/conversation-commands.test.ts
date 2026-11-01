import { describe, expect, it, vi } from 'vitest';

import { ChatSessionStateSchema, type ChatSessionState, type ChatStateResult, type ChatStateScope, type ChatStateSnapshot, type ChatStateWrite } from '../shared/chat-state';
import { createDaemonCommand, type DaemonCommand, type DaemonCommandReceipt, type DaemonSnapshot } from '../shared/daemon-protocol';
import type { ChatStateAccess } from './chat-recovery';
import { retainChatRecovery, sharedChatRecovery } from './chat-recovery-registry';
import { queueConversationMessage, reconcileConversationSubmit, steerConversationMessage, submitConversationMessage, type ConversationCommandAccess } from './conversation-commands';

const NOW = '2026-10-27T08:00:00.000Z';
const scope = { projectId: 'project-1', sessionId: 'session-1' };

function storage(initial: ChatSessionState) {
  let stored: ChatStateSnapshot = { version: 1, scope, revision: 1, state: initial, updatedAt: NOW };
  const access: ChatStateAccess = {
    chatStateRead: vi.fn(async (): Promise<ChatStateResult> => ({ ok: true, snapshot: structuredClone(stored) })),
    chatStateWrite: vi.fn(async (_scope: ChatStateScope, request: ChatStateWrite): Promise<ChatStateResult> => {
      if (request.expectedRevision !== stored.revision) return { ok: false, error: 'stale', revision: stored.revision, message: 'conflict' };
      stored = structuredClone({ ...stored, revision: stored.revision + 1, state: request.state });
      return { ok: true, snapshot: stored };
    }),
  };
  return { access, stored: () => stored };
}

function host() {
  const releases: Array<() => void> = [];
  const sent: DaemonCommand[] = [];
  let snapshotDelay: Promise<void> = Promise.resolve();
  const access: ConversationCommandAccess = {
    latestSnapshot: async () => { await snapshotDelay; return { revision: 7 } as DaemonSnapshot; },
    sendCommand: (command) => {
      sent.push(command);
      return new Promise<DaemonCommandReceipt>((resolve) => {
        releases.push(() => resolve({ ok: true, status: 'applied', commandId: command.commandId, revision: 8, eventSequence: 1 }));
      });
    },
  };
  return { access, sent, releases, delaySnapshot: (until: Promise<void>) => { snapshotDelay = until; } };
}

const flush = async (): Promise<void> => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

describe('submitConversationMessage', () => {
  it('sends a draft once even when two boxes send it at the same moment', async () => {
    const chat = storage({ draft: { text: 'hello' } });
    const recovery = sharedChatRecovery(scope, chat.access);
    const view = retainChatRecovery(recovery)!;
    await recovery.load();
    const daemon = host();
    let openSnapshot!: () => void;
    daemon.delaySnapshot(new Promise((resolve) => { openSnapshot = resolve; }));
    const first = submitConversationMessage(daemon.access, { sessionId: scope.sessionId, recovery, type: 'agent.submit', prompt: 'hello' });
    const second = submitConversationMessage(daemon.access, { sessionId: scope.sessionId, recovery, type: 'agent.submit', prompt: 'hello' });
    await expect(second).resolves.toMatchObject({ ok: false });
    openSnapshot();
    await flush();
    daemon.releases.shift()!();
    await expect(first).resolves.toEqual({ ok: true });
    expect(daemon.sent).toHaveLength(1);
    expect(recovery.getSnapshot().draft.text).toBe('');
    view();
  });

  it('keeps an edit made while the snapshot is read before the message is escrowed', async () => {
    const chat = storage({ draft: { text: 'message' } });
    const recovery = sharedChatRecovery(scope, chat.access);
    const view = retainChatRecovery(recovery)!;
    await recovery.load();
    const daemon = host();
    let openSnapshot!: () => void;
    daemon.delaySnapshot(new Promise((resolve) => { openSnapshot = resolve; }));
    const sending = submitConversationMessage(daemon.access, { sessionId: scope.sessionId, recovery, type: 'agent.submit', prompt: 'message' });
    await flush();
    recovery.updateDraft({ text: 'message\n\n' });
    openSnapshot();
    await flush();
    daemon.releases.shift()!();
    await expect(sending).resolves.toEqual({ ok: true });
    expect(recovery.getSnapshot().draft.text).toBe('message\n\n');
    view();
  });

  it('never sends through a draft that was forgotten and reopened elsewhere meanwhile', async () => {
    const chat = storage({ draft: { text: 'hello' } });
    const stale = sharedChatRecovery(scope, chat.access);
    const view = retainChatRecovery(stale)!;
    await stale.load();
    // The box closes while its skill check waits; the draft is forgotten and opened again elsewhere.
    view();
    await stale.flush();
    await flush();
    const reopened = sharedChatRecovery(scope, chat.access);
    expect(reopened).not.toBe(stale);
    const reopenedView = retainChatRecovery(reopened)!;
    const daemon = host();
    const result = await submitConversationMessage(daemon.access, { sessionId: scope.sessionId, recovery: stale, type: 'agent.submit', prompt: 'hello' });
    expect(result).toMatchObject({ ok: false });
    expect(daemon.sent).toHaveLength(0);
    reopenedView();
  });

  it('keeps the shared draft while its message is delivered after the box that sent it closed', async () => {
    const chat = storage({ draft: { text: 'hello' } });
    const recovery = sharedChatRecovery(scope, chat.access);
    const view = retainChatRecovery(recovery)!;
    await recovery.load();
    const daemon = host();
    const sending = submitConversationMessage(daemon.access, { sessionId: scope.sessionId, recovery, type: 'agent.submit', prompt: 'hello' });
    await flush();
    expect(daemon.sent).toHaveLength(1);
    // The box closes mid-delivery; a box opened again must see the same controller, not a stale copy.
    view();
    await recovery.flush();
    await flush();
    expect(sharedChatRecovery(scope, chat.access)).toBe(recovery);
    daemon.releases.shift()!();
    await expect(sending).resolves.toEqual({ ok: true });
    expect(chat.stored().state.pendingSubmit).toBeUndefined();
    expect(recovery.getSnapshot().pendingSubmit).toBeUndefined();
    // With nobody holding it any more, it is forgotten after its last write.
    await recovery.flush();
    await flush();
    expect(sharedChatRecovery(scope, chat.access)).not.toBe(recovery);
  });
});

describe('steerConversationMessage', () => {
  const applied = (command: DaemonCommand): DaemonCommandReceipt => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 8, eventSequence: 1 });
  const refused = (command: DaemonCommand, code: 'revision-conflict' | 'invalid-state'): DaemonCommandReceipt => ({ ok: false, status: 'rejected', commandId: command.commandId, revision: 8, error: { code, message: code, retryable: false } });

  async function steering(answers: readonly ((command: DaemonCommand) => DaemonCommandReceipt | null)[]) {
    const chat = storage({ draft: { text: 'Use the other file.' } });
    const recovery = sharedChatRecovery(scope, chat.access);
    const view = retainChatRecovery(recovery)!;
    await recovery.load();
    const sent: DaemonCommand[] = [];
    let revision = 7;
    const access: ConversationCommandAccess = {
      latestSnapshot: async () => { revision += 1; return { revision } as DaemonSnapshot; },
      sendCommand: async (command) => {
        sent.push(command);
        return (answers[sent.length - 1] ?? applied)(command);
      },
    };
    const onAccepted = vi.fn();
    const send = () => steerConversationMessage(access, { sessionId: scope.sessionId, recovery, turnId: 'turn-1', prompt: 'Use the other file.', onAccepted });
    const queue = () => queueConversationMessage(access, { sessionId: scope.sessionId, recovery, prompt: '/compact', onAccepted });
    return { access, chat, recovery, sent, onAccepted, send, queue, view };
  }

  it('sends a plain message past a lost race too: a row landing as the person presses is no reason to show them a revision', async () => {
    const run = await steering([(command) => refused(command, 'revision-conflict'), applied]);
    await expect(submitConversationMessage(run.access, { sessionId: scope.sessionId, recovery: run.recovery, type: 'agent.submit', prompt: 'Go on.', onAccepted: run.onAccepted })).resolves.toEqual({ ok: true });
    expect(run.sent).toHaveLength(2);
    expect(run.sent[0]?.commandId).not.toBe(run.sent[1]?.commandId);
    expect(run.sent[1]).toMatchObject({ type: 'agent.submit', payload: { prompt: 'Go on.' } });
    expect(run.onAccepted).toHaveBeenCalledExactlyOnceWith(run.sent[1]!.commandId);
    expect(run.recovery.getSnapshot().pendingSubmit).toBeUndefined();
    run.view();
  });

  it('queues what cannot go in as a message that says so, past a lost race', async () => {
    const run = await steering([(command) => refused(command, 'revision-conflict'), applied]);
    await expect(run.queue()).resolves.toEqual({ ok: true });
    expect(run.sent).toHaveLength(2);
    expect(run.sent[1]).toMatchObject({ type: 'agent.submit', payload: { sessionId: scope.sessionId, prompt: '/compact', notSteered: true } });
    expect(run.onAccepted).toHaveBeenCalledExactlyOnceWith(run.sent[1]!.commandId);
    expect(run.recovery.getSnapshot().pendingSubmit).toBeUndefined();
    run.view();
  });

  it('goes as agent.steer for that turn, and settles its escrow', async () => {
    const run = await steering([applied]);
    await expect(run.send()).resolves.toEqual({ ok: true });
    expect(run.sent[0]).toMatchObject({ type: 'agent.steer', payload: { sessionId: scope.sessionId, turnId: 'turn-1', prompt: 'Use the other file.' } });
    expect(run.onAccepted).toHaveBeenCalledExactlyOnceWith(run.sent[0]!.commandId);
    expect(run.recovery.getSnapshot().pendingSubmit).toBeUndefined();
    expect(run.recovery.getSnapshot().draft.text).toBe('');
    run.view();
  });

  it('loses the revision race as a matter of course: a fresh id against the latest revision each time, and one acceptance', async () => {
    const conflict = (command: DaemonCommand) => refused(command, 'revision-conflict');
    const run = await steering([conflict, conflict, applied]);
    await expect(run.send()).resolves.toEqual({ ok: true });
    expect(new Set(run.sent.map((command) => command.commandId)).size).toBe(3);
    expect(run.sent.map((command) => command.idempotencyKey)).toEqual(run.sent.map((command) => command.commandId));
    expect(run.sent.map((command) => command.expectedRevision)).toEqual([8, 9, 10]);
    expect(run.onAccepted).toHaveBeenCalledOnce();
    expect(run.recovery.getSnapshot().pendingSubmit).toBeUndefined();
    run.view();
  });

  it('stops losing it after eight tries, and keeps the words in the box', async () => {
    const run = await steering(Array.from({ length: 12 }, () => (command: DaemonCommand) => refused(command, 'revision-conflict')));
    await expect(run.send()).resolves.toMatchObject({ ok: false });
    expect(run.sent).toHaveLength(8);
    expect(run.recovery.getSnapshot().draft.text).toBe('Use the other file.');
    expect(run.recovery.getSnapshot().pendingSubmit).toBeUndefined();
    expect(run.onAccepted).not.toHaveBeenCalled();
    run.view();
  });

  it('any other refusal is an answer, and is not tried again', async () => {
    const run = await steering([(command) => refused(command, 'invalid-state')]);
    await expect(run.send()).resolves.toMatchObject({ ok: false, message: 'invalid-state' });
    expect(run.sent).toHaveLength(1);
    expect(run.recovery.getSnapshot().draft.text).toBe('Use the other file.');
    run.view();
  });

  it('no answer is never tried again: the escrow stays until delivery is checked', async () => {
    const run = await steering([() => null]);
    await expect(run.send()).resolves.toMatchObject({ ok: false, deliveryUncertain: true });
    expect(run.sent).toHaveLength(1);
    expect(run.recovery.getSnapshot().pendingSubmit).toMatchObject({ mode: 'steer', command: { type: 'agent.steer' } });
    run.view();
  });

  it('checking delivery resends the same command and shows no sent row: a steer has none until it lands', async () => {
    const run = await steering([() => null, applied]);
    await run.send();
    const onAccepted = vi.fn();
    await expect(reconcileConversationSubmit(run.access, { recovery: run.recovery, onAccepted })).resolves.toEqual({ ok: true });
    expect(run.sent[1]).toEqual(run.sent[0]);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(run.recovery.getSnapshot().pendingSubmit).toBeUndefined();
    run.view();
  });

  it('the stored escrow keeps a steer, and refuses one whose mode says otherwise', () => {
    const command = createDaemonCommand({ commandId: 'c', idempotencyKey: 'c', expectedRevision: 1, issuedAt: NOW, principal: { kind: 'desktop', id: 'ui' }, type: 'agent.steer', payload: { sessionId: 's', turnId: 't', prompt: 'x' } });
    const state = (mode: string) => ({ draft: { text: '' }, pendingSubmit: { command, mode, recordedAt: NOW } });
    expect(ChatSessionStateSchema.safeParse(state('steer')).success).toBe(true);
    expect(ChatSessionStateSchema.safeParse(state('send')).success).toBe(false);
  });
});
