import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startAsyncPoll } from './async-poller';

describe('startAsyncPoll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never overlaps a slow task and schedules from settlement', async () => {
    let resolveTask: (() => void) | undefined;
    const task = vi.fn(() => new Promise<void>((resolve) => { resolveTask = resolve; }));
    const stop = startAsyncPoll({ task, intervalMs: () => 100 });
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(1);

    resolveTask?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(99);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not reschedule after stop even when an in-flight task settles late', async () => {
    let resolveTask: (() => void) | undefined;
    const task = vi.fn(() => new Promise<void>((resolve) => { resolveTask = resolve; }));
    const stop = startAsyncPoll({ task, intervalMs: () => 100 });
    stop();
    resolveTask?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
