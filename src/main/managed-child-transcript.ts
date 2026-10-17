import { createHash } from 'node:crypto';

import type { DaemonSnapshot, DaemonTranscriptItem, DaemonTurn } from '../shared/daemon-protocol';

/** Reads a session's transcript forward from a sequence, as the daemon router does. */
export type TranscriptReader = (sessionId: string, afterSequence: number, limit: number) => readonly DaemonTranscriptItem[];

/**
 * A managed child's first transcript row: where it came from and whether to report back.
 * Persisted rows carry this id, so it must stay `stableId('managed-child-origin', id)`.
 */
export function managedChildOriginId(childSessionId: string): string {
  return `managed-child-origin-${createHash('sha256').update(childSessionId).digest('hex').slice(0, 32)}`;
}

/** A session's last complete answer in one turn. */
export function finalAssistantText(read: TranscriptReader, sessionId: string, turnId: string): string | undefined {
  let last: string | undefined;
  let afterSequence = 0;
  for (;;) {
    const page = read(sessionId, afterSequence, 2_000);
    for (const item of page) {
      if (item.turnId === turnId && item.kind === 'assistant-message' && !item.isDelta && item.text.trim()) last = item.text;
    }
    if (page.length < 2_000) return last;
    const next = page.at(-1)?.sequence;
    if (next === undefined || next <= afterSequence) return last;
    afterSequence = next;
  }
}

/** Whether a child was created to send its first finished result back to this parent. */
export function reportBackRequested(read: TranscriptReader, childSessionId: string, parentSessionId: string): boolean {
  const origin = read(childSessionId, 0, 4).find((item) => item.id === managedChildOriginId(childSessionId));
  return origin?.payload?.type === 'subagent' && origin.payload.reportBack === true && origin.payload.parentSessionId === parentSessionId;
}

/** The session's most recently finished turn. */
export function latestFinishedTurn(turns: readonly DaemonTurn[], sessionId: string): DaemonTurn | undefined {
  return turns.filter((turn) => turn.sessionId === sessionId && turn.finishedAt)
    .sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!)).at(-1);
}

export type ChildProgress = 'finished' | 'needs-attention' | 'working';

const STOPPED_AGENT_STATES = new Set(['done', 'interrupted', 'error', 'archived']);
const SETTLED_TURN_STATES = new Set(['completed', 'interrupted', 'failed']);

/**
 * Where a child stands for an agent waiting on it: finished (nothing running or queued), waiting
 * for a person's approval, or still working (starting, queued, running or delivery unconfirmed).
 */
export function childProgress(snapshot: DaemonSnapshot, sessionId: string): ChildProgress {
  const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
  if (!agent || STOPPED_AGENT_STATES.has(agent.state)) return 'finished';
  const unsettled = snapshot.turns.some((turn) => turn.sessionId === sessionId && !SETTLED_TURN_STATES.has(turn.state));
  if (agent.currentTurnId === undefined && agent.queuedTurnCount === 0 && !unsettled) return 'finished';
  return agent.state === 'blocked' ? 'needs-attention' : 'working';
}
