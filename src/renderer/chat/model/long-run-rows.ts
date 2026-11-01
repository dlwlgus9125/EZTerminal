import type { DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import { USAGE_LIMIT_ERROR, type TurnUsageLimit } from '../../../shared/long-run';
import { parseTranscriptPayload } from '../../../shared/transcript-payload';

/** A stop's latest row is its card. */
export function latestLimit(items: readonly DaemonTranscriptItem[]): TurnUsageLimit | undefined {
  let latest: { readonly sequence: number; readonly limit: TurnUsageLimit } | undefined;
  for (const item of items) {
    const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
    if (payload?.type === 'usage-limit' && (!latest || item.sequence >= latest.sequence)) latest = { sequence: item.sequence, limit: payload };
  }
  return latest?.limit;
}

export interface LongRunRows {
  /** The turn its latest row names, then the card: one per stop, whatever became of it. */
  readonly limits: ReadonlyMap<string, TurnUsageLimit>;
  /** By turn: stopped at the limit, or refused while that stop was open. Neither is a failure of the work. */
  readonly limited: ReadonlyMap<string, 'stopped' | 'refused'>;
}

/** Read ahead, like a turn's wrap-up cards: `items` in transcript order. */
export function longRunRows(items: readonly DaemonTranscriptItem[], turns: readonly DaemonTurn[]): LongRunRows {
  const stops = new Map<string, TurnUsageLimit>();
  // A stop's first row names the turn that stopped; a later row, a turn it refused. A limited turn no row names got no card.
  const stoppedTurns = new Set<string>();
  const refusedTurns = new Set<string>();
  const sentAt = new Map<string, string>();
  for (const item of items) {
    const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
    if (payload?.type === 'usage-limit') {
      (stops.has(payload.stopId) ? refusedTurns : stoppedTurns).add(payload.turnId);
      stops.set(payload.stopId, payload);
    } else if (payload?.type === 'app-sent') {
      sentAt.set(payload.stopId, item.createdAt);
    }
  }
  const limits = new Map<string, TurnUsageLimit>();
  for (const limit of stops.values()) {
    // A press has no schedule to date it, and the row is when it went.
    const sent = limit.phase === 'resumed' ? sentAt.get(limit.stopId) : undefined;
    limits.set(limit.turnId, sent ? { ...limit, resumeAt: sent } : limit);
  }
  const limited = new Map<string, 'stopped' | 'refused'>();
  for (const turn of turns) {
    if (turn.errorCode === USAGE_LIMIT_ERROR) limited.set(turn.id, refusedTurns.has(turn.id) && !stoppedTurns.has(turn.id) ? 'refused' : 'stopped');
  }
  return { limits, limited };
}
