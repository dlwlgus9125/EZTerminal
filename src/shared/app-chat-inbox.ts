import type { DaemonSnapshot } from './daemon-protocol';

/**
 * What app conversations need from the person, for the 받은 요청 inbox and its
 * badge: pending approvals (a subagent's are named), then conversations whose
 * turn ended while the person was not looking at them. Provider-owned
 * subagents report through their parent and are never listed on their own.
 */
export interface AppChatInboxEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: 'approval' | 'finished' | 'failed';
  readonly conversationTitle: string;
  readonly providerId: string;
  /** Approval subject, without the subagent prefix older clients read. */
  readonly detail?: string;
  readonly subagentTitle?: string;
  readonly errorCode?: string;
  readonly at: string;
}

export interface AppChatInboxSeen {
  /** Turns that ended before the inbox first ran are not news. */
  readonly epoch: string;
  /** Per conversation: when the person last had it open. */
  readonly sessions: Readonly<Record<string, string>>;
}

const MAX_ENTRIES = 50;

export function appChatInbox(
  snapshot: DaemonSnapshot,
  seen: AppChatInboxSeen,
  openSessionIds: ReadonlySet<string> = new Set(),
): AppChatInboxEntry[] {
  const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const agents = new Map(snapshot.agents.map((agent) => [agent.sessionId, agent]));
  const providerOwned = new Set(snapshot.agentRelations
    .filter((relation) => relation.owner === 'provider-native' && relation.detachedAt === undefined)
    .map((relation) => relation.childSessionId));

  const approvals: AppChatInboxEntry[] = snapshot.approvals
    .filter((approval) => approval.state === 'pending')
    .flatMap((approval) => {
      const session = sessions.get(approval.sessionId);
      const agent = agents.get(approval.sessionId);
      if (!session || !agent) return [];
      const subagentTitle = approval.request?.subagent?.title;
      const prefix = subagentTitle ? `${subagentTitle}: ` : '';
      const detail = approval.detail?.startsWith(prefix) ? approval.detail.slice(prefix.length) : approval.detail ?? approval.title;
      return [{
        id: `approval:${approval.id}`,
        sessionId: approval.sessionId,
        kind: 'approval' as const,
        conversationTitle: session.title,
        providerId: agent.providerId,
        detail,
        ...(subagentTitle ? { subagentTitle } : {}),
        at: approval.createdAt,
      }];
    })
    .sort((left, right) => right.at.localeCompare(left.at));

  const latestTurn = new Map<string, DaemonSnapshot['turns'][number]>();
  for (const turn of snapshot.turns) {
    if (turn.state !== 'completed' && turn.state !== 'failed') continue;
    if (!turn.finishedAt) continue;
    const current = latestTurn.get(turn.sessionId);
    if (!current || (current.finishedAt ?? '') < turn.finishedAt) latestTurn.set(turn.sessionId, turn);
  }
  const ended: AppChatInboxEntry[] = [...latestTurn.values()].flatMap((turn) => {
    const session = sessions.get(turn.sessionId);
    const agent = agents.get(turn.sessionId);
    if (!session || !agent || session.kind !== 'agent' || session.archivedAt || providerOwned.has(session.id)) return [];
    // Planning runs report through the planning panel, not as conversations.
    if (session.id.startsWith('planning-')) return [];
    if (openSessionIds.has(session.id)) return [];
    const since = seen.sessions[session.id] ?? seen.epoch;
    if (turn.finishedAt! <= since) return [];
    return [{
      id: `turn:${turn.id}`,
      sessionId: session.id,
      kind: turn.state === 'failed' ? 'failed' as const : 'finished' as const,
      conversationTitle: session.title,
      providerId: agent.providerId,
      ...(turn.errorCode ? { errorCode: turn.errorCode } : {}),
      at: turn.finishedAt!,
    }];
  }).sort((left, right) => right.at.localeCompare(left.at));

  return [...approvals, ...ended].slice(0, MAX_ENTRIES);
}
