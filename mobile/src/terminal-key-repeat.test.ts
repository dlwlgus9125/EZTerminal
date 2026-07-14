import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTerminalKeyRepeatController,
  TERMINAL_KEY_REPEAT_DELAY_MS,
  TERMINAL_KEY_REPEAT_INTERVAL_MS,
} from './terminal-key-repeat';

describe('terminal key repeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a non-repeatable key exactly once', () => {
    const send = vi.fn();
    const repeat = createTerminalKeyRepeatController(send);
    repeat.start('\x03', false);
    vi.advanceTimersByTime(2_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends immediately, then repeats after the bounded delay and cadence', () => {
    const send = vi.fn();
    const repeat = createTerminalKeyRepeatController(send);
    repeat.start('\x1b[A', true);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TERMINAL_KEY_REPEAT_DELAY_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(TERMINAL_KEY_REPEAT_INTERVAL_MS * 2);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('cancels both the pending delay and a running interval', () => {
    const send = vi.fn();
    const repeat = createTerminalKeyRepeatController(send);
    repeat.start('\x7f', true);
    repeat.stop();
    vi.advanceTimersByTime(1_000);
    expect(send).toHaveBeenCalledTimes(1);

    repeat.start('\x7f', true);
    vi.advanceTimersByTime(TERMINAL_KEY_REPEAT_DELAY_MS + TERMINAL_KEY_REPEAT_INTERVAL_MS);
    const beforeStop = send.mock.calls.length;
    repeat.stop();
    vi.advanceTimersByTime(1_000);
    expect(send).toHaveBeenCalledTimes(beforeStop);
  });
});
