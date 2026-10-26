import { describe, expect, it, vi } from 'vitest';

import type { ChatSessionState, ChatStateResult, ChatStateScope, ChatStateSnapshot, ChatStateWrite } from '../shared/chat-state';
import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import type { ChatStateAccess } from './chat-recovery';
import { retainChatRecovery, sharedChatRecovery } from './chat-recovery-registry';
import { submitConversationMessage, type ConversationCommandAccess } from './conversation-commands';

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
