import type { DaemonAgent, DaemonSession } from './daemon-protocol';

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
