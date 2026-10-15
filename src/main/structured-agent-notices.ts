import type { DaemonSnapshot, DaemonTurn } from '../shared/daemon-protocol';

/** Which Agent setting gates the notice (AgentSettings.notifications). */
export type StructuredAgentNoticeSetting = 'waiting' | 'blocked' | 'error';

export interface StructuredAgentNotice {
  readonly setting: StructuredAgentNoticeSetting;
  readonly sessionId: string;
  readonly title: string;
  readonly body: string;
}

const ACTIVE_TURN_STATES = new Set<DaemonTurn['state']>(['queued', 'submitting', 'working', 'blocked', 'delivery-uncertain']);

/**
 * Turns daemon snapshots into "needs you" notices for structured Agent
 * conversations: a new pending approval, a turn that finished, or one that
 * failed. The first snapshot only primes the tracker, so nothing that was
 * already true at startup notifies. A user interrupt is not notified.
 */
export class StructuredAgentNoticeTracker {
  private primed = false;
  private readonly turnStates = new Map<string, DaemonTurn['state']>();
  private readonly pendingApprovals = new Set<string>();

  observe(snapshot: DaemonSnapshot): StructuredAgentNotice[] {
    const notices: StructuredAgentNotice[] = [];
    const sessionTitle = (sessionId: string): string => snapshot.sessions.find((session) => session.id === sessionId)?.title ?? 'Agent';
    const providerName = (sessionId: string): string => {
      const providerId = snapshot.agents.find((agent) => agent.sessionId === sessionId)?.providerId;
      return snapshot.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId ?? 'Agent';
    };

    const pending = new Set<string>();
    for (const approval of snapshot.approvals) {
      if (approval.state !== 'pending') continue;
      pending.add(approval.id);
      if (this.primed && !this.pendingApprovals.has(approval.id)) {
        notices.push({
          setting: 'blocked',
          sessionId: approval.sessionId,
          title: `${providerName(approval.sessionId)} needs your approval`,
          body: `${sessionTitle(approval.sessionId)} · ${approval.title}`,
        });
      }
    }
    this.pendingApprovals.clear();
    for (const id of pending) this.pendingApprovals.add(id);

    const seen = new Set<string>();
    for (const turn of snapshot.turns) {
      seen.add(turn.id);
      const previous = this.turnStates.get(turn.id);
      this.turnStates.set(turn.id, turn.state);
      if (!this.primed || previous === undefined || !ACTIVE_TURN_STATES.has(previous)) continue;
      if (turn.state === 'completed') {
        notices.push({ setting: 'waiting', sessionId: turn.sessionId, title: `${providerName(turn.sessionId)} finished`, body: sessionTitle(turn.sessionId) });
      } else if (turn.state === 'failed') {
        notices.push({ setting: 'error', sessionId: turn.sessionId, title: `${providerName(turn.sessionId)} stopped with an error`, body: sessionTitle(turn.sessionId) });
      }
    }
    for (const id of [...this.turnStates.keys()]) if (!seen.has(id)) this.turnStates.delete(id);
    this.primed = true;
    return notices;
  }
}
