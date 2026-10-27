import type { ChatComposerDraft } from '../../src/shared/chat-message';
import type { ChatStateAccess } from '../../src/renderer/chat-recovery';
import { retainChatRecovery, sharedChatRecovery } from '../../src/renderer/chat-recovery-registry';
import type { ConversationCommandAccess } from '../../src/renderer/conversation-commands';
import type { DaemonCommand } from '../../src/shared/daemon-protocol';
import type { SecureStorageLike } from './mobile-agent-create-recovery-store';
import type { MobileChatStateStoreLike } from './mobile-chat-state-store';
import { mobileConversationState } from './mobile-conversation-state';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

/** Who the phone's conversation commands are from (the host records android regardless). */
export const PHONE_PRINCIPAL = { kind: 'android', id: 'mobile-agent-ui' } as const satisfies DaemonCommand['principal'];

type PhoneChatStateAccess = ReturnType<typeof mobileConversationState>;

const accesses = new WeakMap<object, PhoneChatStateAccess>();

/**
 * The phone's encrypted draft storage for one PC connection. One object per transport: draft
 * controllers are shared per storage object, so the conversation screen, a new conversation's start
 * box and the terminal's AI input on the same conversation all hold one controller (one draft, one
 * pending send). Tests pass their own stores; those get a fresh object.
 */
export function phoneChatStateAccess(
  transport: Pick<WsEzTerminalTransport, 'getRemoteToken'>,
  options: { readonly secure?: SecureStorageLike; readonly store?: MobileChatStateStoreLike } = {},
): PhoneChatStateAccess {
  if (options.secure || options.store) return mobileConversationState(() => transport.getRemoteToken(), options.secure, options.store);
  const existing = accesses.get(transport);
  if (existing) return existing;
  const created = mobileConversationState(() => transport.getRemoteToken());
  accesses.set(transport, created);
  return created;
}

/**
 * The phone's side of the shared conversation commands (send, settle, settings, queue, stop): the
 * newest host snapshot, the host's receipt (an uncertain delivery reads as no answer, so the escrow
 * stays) and the phone's own principal.
 */
export function phoneConversationCommands(transport: WsEzTerminalTransport): ConversationCommandAccess {
  return {
    latestSnapshot: () => Promise.resolve().then(() => transport.getDaemonSnapshot()).catch(() => null),
    sendCommand: (command) => Promise.resolve()
      .then(() => transport.sendDaemonCommand(command))
      .then((receipt) => (!receipt || (!receipt.ok && (receipt.status === 'delivery-uncertain' || receipt.error.code === 'delivery-uncertain')) ? null : receipt))
      .catch(() => null),
    principal: PHONE_PRINCIPAL,
  };
}

/**
 * A flow stage's instructions put into its conversation's draft (the project screen seeds it). Through the
 * conversation's shared draft controller — the one its screen and the terminal's box hold — so an open box shows
 * them and keeps its revision, and a pending send stays. A draft already written is never replaced.
 */
export async function seedPhoneConversationDraft(
  access: ChatStateAccess,
  scope: { readonly projectId: string; readonly sessionId: string },
  draft: ChatComposerDraft,
): Promise<void> {
  const recovery = sharedChatRecovery(scope, access);
  const release = retainChatRecovery(recovery);
  try {
    await recovery.load();
    const view = recovery.getSnapshot();
    if (view.status !== 'ready') throw new Error(view.message ?? 'The draft storage on this device is unavailable.');
    if (view.draft.text && view.draft.text !== draft.text) throw new Error('A draft already exists in this conversation. It was preserved.');
    recovery.updateDraft(draft);
    await recovery.flush();
    const saved = recovery.getSnapshot();
    if (saved.status !== 'ready' || saved.unsaved) throw new Error(saved.message ?? 'The draft could not be saved on this device.');
  } finally {
    release?.();
  }
}
