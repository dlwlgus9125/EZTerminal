/**
 * Whether anyone has a conversation on screen (turn wrap-up writes a recap only when nobody does). Each
 * client tells the host what it shows, through IPC or the remote bridge, never as a daemon command: that
 * would write an outbox row and bump the snapshot revision, and every bump can refuse a real command.
 */

/** Clients resend this often while they show anything, and once on a change. */
export const CONVERSATION_VIEWING_HEARTBEAT_MS = 20_000;
/** The host drops a claim this long after its last resend: a client that stopped reporting is not watching. */
export const CONVERSATION_VIEWING_TTL_MS = 50_000;
/** A phone shows one conversation; split panes are a desktop's. */
export const MAX_REMOTE_VIEWED_CONVERSATIONS = 8;
export const MAX_DESKTOP_VIEWED_CONVERSATIONS = 64;
const MAX_SESSION_ID_LENGTH = 256;

/** Only `unviewed` makes a recap: `unknown` is a window that has not reported yet. */
export type ConversationViewingStatus = 'viewed' | 'unviewed' | 'unknown';

export function isViewedSessionIds(value: unknown, maximum: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maximum
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID_LENGTH);
}
