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
