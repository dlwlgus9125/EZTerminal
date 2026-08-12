import { describe, expect, it, vi } from 'vitest';

import { PtyWriteScheduler } from './pty-write-scheduler';

describe('PtyWriteScheduler', () => {
  it('delivers active writes immediately and passive writes at 15Hz', () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const scheduler = new PtyWriteScheduler('active', (write) => delivered.push(write.bytes[0]));
    scheduler.write({ bytes: Uint8Array.of(1), onFlushed: () => undefined, suppressSideEffects: false });
    scheduler.setTier('passive');
    scheduler.write({ bytes: Uint8Array.of(2), onFlushed: () => undefined, suppressSideEffects: false });
    expect(delivered).toEqual([1]);
    vi.advanceTimersByTime(67);
    expect(delivered).toEqual([1, 2]);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('flushes queued writes in order when a pane becomes active', () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const scheduler = new PtyWriteScheduler('passive', (write) => delivered.push(write.bytes[0]));
    scheduler.write({ bytes: Uint8Array.of(1), onFlushed: () => undefined, suppressSideEffects: false });
    scheduler.write({ bytes: Uint8Array.of(2), onFlushed: () => undefined, suppressSideEffects: true });
    scheduler.setTier('active');
    expect(delivered).toEqual([1, 2]);
    scheduler.dispose();
    vi.useRealTimers();
  });
});
