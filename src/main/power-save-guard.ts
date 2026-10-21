import type { DaemonSnapshot, TurnState } from '../shared/daemon-protocol';

/** Electron's powerSaveBlocker, narrowed for tests. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/**
 * Turns the AI is working on. A turn waiting for the person (`blocked`) does not keep the PC
 * awake, so an unanswered approval does not hold it up overnight.
 */
const ACTIVE_TURN_STATES: ReadonlySet<TurnState> = new Set<TurnState>(['queued', 'submitting', 'working', 'delivery-uncertain']);

export function hasActiveAgentTurn(snapshot: DaemonSnapshot | null): boolean {
  return snapshot?.turns.some((turn) => ACTIVE_TURN_STATES.has(turn.state)) ?? false;
}

/**
 * Stops idle sleep (not the display, not a closed lid or a chosen sleep) while any source reports
 * work, so a long agent turn's stream is not cut by the PC going to sleep.
 */
export class PowerSaveGuard {
  private blockerId: number | undefined;
  private readonly sources = new Map<string, boolean>();

  constructor(private readonly blocker: PowerSaveBlockerLike) {}

  set(source: string, active: boolean): void {
    this.sources.set(source, active);
    this.apply();
  }

  dispose(): void {
    this.sources.clear();
    this.apply();
  }

  private apply(): void {
    const wanted = [...this.sources.values()].some(Boolean);
    if (wanted && this.blockerId === undefined) {
      this.blockerId = this.blocker.start('prevent-app-suspension');
    } else if (!wanted && this.blockerId !== undefined) {
      if (this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId);
      this.blockerId = undefined;
    }
  }
}
