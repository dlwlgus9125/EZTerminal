import type { DaemonTurn } from '../shared/daemon-protocol';
import type { ProviderUsageLimit } from '../shared/long-run';

/** A turn a usage limit stopped, as the runtime hands it over. */
export interface LimitStop {
  readonly sessionId: string;
  readonly providerId: string;
  readonly turn: DaemonTurn;
  readonly limit: ProviderUsageLimit;
  readonly stoppedAt: string;
}

/** What the runtime needs from the coordinator (DaemonAgentRuntime option `longRun`). */
export interface DaemonLongRunHost {
  /** Whether this session launches with long-run continuity. Undefined: a limit classifies as any error does. */
  sessionContext(sessionId: string): true | undefined;
  /**
   * A limit stopped this turn. Called under the command FIFO, in the planner that ends the turn: whatever it holds
   * applies before the pump can claim the next one.
   */
  limitStopped(stop: LimitStop): void;
}
