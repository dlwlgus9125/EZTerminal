import { memo, useSyncExternalStore } from 'react';

interface ClockStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

function createClockStore(intervalMs: number): ClockStore {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  return Object.freeze({
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (timer === null) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const notify of listeners) notify();
        }, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getSnapshot: () => now,
  });
}

const SECOND_CLOCK = createClockStore(1_000);
const COARSE_CLOCK = createClockStore(30_000);
const subscribeNever = (): (() => void) => () => undefined;

function useClock(store: ClockStore, currentTime?: number): number {
  return useSyncExternalStore(
    currentTime === undefined ? store.subscribe : subscribeNever,
    currentTime === undefined ? store.getSnapshot : () => currentTime,
    currentTime === undefined ? store.getSnapshot : () => currentTime,
  );
}

export const AgentRelativeAge = memo(function AgentRelativeAge({
  updatedAt,
  formatter,
  currentTime,
}: {
  readonly updatedAt: number;
  readonly formatter: Intl.RelativeTimeFormat;
  readonly currentTime?: number;
}): JSX.Element {
  const now = useClock(COARSE_CLOCK, currentTime);
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  let label: string;
  if (seconds < 60) label = formatter.format(-seconds, 'second');
  else {
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) label = formatter.format(-minutes, 'minute');
    else {
      const hours = Math.floor(minutes / 60);
      label = hours < 24
        ? formatter.format(-hours, 'hour')
        : formatter.format(-Math.floor(hours / 24), 'day');
    }
  }
  return <>{label}</>;
});

export const AgentElapsed = memo(function AgentElapsed({
  startedAt,
  currentTime,
}: {
  readonly startedAt: number;
  readonly currentTime?: number;
}): JSX.Element {
  const now = useClock(SECOND_CLOCK, currentTime);
  const total = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  const label = minutes < 60
    ? `${String(minutes).padStart(2, '0')}:${seconds}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
  return <>{label}</>;
});

export const AgentApprovalCountdown = memo(function AgentApprovalCountdown({
  expiresAt,
  currentTime,
}: {
  readonly expiresAt: number;
  readonly currentTime?: number;
}): JSX.Element | null {
  const now = useClock(SECOND_CLOCK, currentTime);
  const total = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  if (total <= 0) return null;
  return (
    <span className="agent-approval-countdown">
      {`${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`}
    </span>
  );
});
