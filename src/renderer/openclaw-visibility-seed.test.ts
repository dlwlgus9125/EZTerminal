import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPENCLAW_VISIBILITY_SEED_TIMEOUT_MS,
  OpenClawVisibilitySeedLatch,
} from './openclaw-visibility-seed';

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenClawVisibilitySeedLatch', () => {
  it('fails closed and releases startup when the optional seed never resolves', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const latch = new OpenClawVisibilitySeedLatch(onTimeout);
    const waiting = latch.wait();

    await vi.advanceTimersByTimeAsync(OPENCLAW_VISIBILITY_SEED_TIMEOUT_MS);
    await expect(waiting).resolves.toBeUndefined();
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('cancels the deadline after a real seed and never invokes fail-closed', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const latch = new OpenClawVisibilitySeedLatch(onTimeout);
    const waiting = latch.wait();

    latch.settle();
    await expect(waiting).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(onTimeout).not.toHaveBeenCalled();
    await expect(latch.wait()).resolves.toBeUndefined();
  });

  it('can wait again after StrictMode-style cleanup without leaking the old timer', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const latch = new OpenClawVisibilitySeedLatch(onTimeout, 10);
    const first = latch.wait();
    latch.cancelPending();
    await expect(first).resolves.toBeUndefined();

    const second = latch.wait();
    await vi.advanceTimersByTimeAsync(10);
    await expect(second).resolves.toBeUndefined();
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
