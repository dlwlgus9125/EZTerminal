import type { DaemonAgent, DaemonAgentRelation, DaemonSession } from './daemon-protocol';

/**
 * Archive transitions update both the session and Agent records. Treat either
 * marker as authoritative so a partially recovered snapshot never leaks an
 * archived Agent back into the default navigation tree.
 */
export function isDaemonSessionArchived(
  session: DaemonSession,
  agent?: DaemonAgent,
): boolean {
  return session.archivedAt !== undefined
    || session.state === 'archived'
    || agent?.state === 'archived';
}

export function isStructuredDaemonAgentSession(session: DaemonSession): boolean {
  return session.kind === 'agent' && session.source === 'structured';
}

/**
 * Subagent chats (managed or provider-native) live under their parent
 * conversation. Every flat conversation list leaves them out; detaching a
 * child makes it a conversation of its own again.
 */
export function attachedChildSessionIds(relations: readonly DaemonAgentRelation[]): ReadonlySet<string> {
  return new Set(relations.filter((relation) => relation.detachedAt === undefined).map((relation) => relation.childSessionId));
}
