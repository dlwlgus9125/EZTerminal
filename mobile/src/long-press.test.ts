import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LongPressTracker } from './long-press';

describe('LongPressTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback with the down position after 500ms', () => {
    const onFire = vi.fn();
    const tracker = new LongPressTracker(onFire);

    tracker.down(10, 20);
    vi.advanceTimersByTime(499);
    expect(onFire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledWith(10, 20);
  });

  it('is canceled by movement past the tolerance (default 10px)', () => {
    const onFire = vi.fn();
    const tracker = new LongPressTracker(onFire);

    tracker.down(0, 0);
    tracker.move(0, 11); // 11px > 10px tolerance
    vi.advanceTimersByTime(500);

    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not cancel for movement within the tolerance', () => {
    const onFire = vi.fn();
    const tracker = new LongPressTracker(onFire);

    tracker.down(0, 0);
    tracker.move(5, 5); // within 10px
    vi.advanceTimersByTime(500);

    expect(onFire).toHaveBeenCalledWith(0, 0);
  });

  it('is canceled by a pointerup (cancel())', () => {
    const onFire = vi.fn();
    const tracker = new LongPressTracker(onFire);

    tracker.down(0, 0);
    tracker.cancel(); // pointerup/pointercancel both route here
    vi.advanceTimersByTime(500);

    expect(onFire).not.toHaveBeenCalled();
  });

  it('is canceled by a scroll (also routes through cancel())', () => {
    const onFire = vi.fn();
    const tracker = new LongPressTracker(onFire);

    tracker.down(0, 0);
    tracker.cancel(); // the scroll handler calls cancel() the same way pointerup does
    vi.advanceTimersByTime(500);

    expect(onFire).not.toHaveBeenCalled();
  });

  it('respects custom ms/moveTolerancePx', () => {
    const onFire = vi.fn();
    const tracker = new LongPressTracker(onFire, 200, 3);

    tracker.down(0, 0);
    tracker.move(0, 4); // > 3px tolerance
    vi.advanceTimersByTime(200);
    expect(onFire).not.toHaveBeenCalled();

    tracker.down(0, 0);
    vi.advanceTimersByTime(199);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledWith(0, 0);
  });

  it('a new down() cancels any previously armed timer', () => {
    const onFire = vi.fn();
    const tracker = new LongPressTracker(onFire);

    tracker.down(0, 0);
    vi.advanceTimersByTime(300);
    tracker.down(1, 1); // restarts the timer at the new position
    vi.advanceTimersByTime(300);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(1, 1);
  });
});
