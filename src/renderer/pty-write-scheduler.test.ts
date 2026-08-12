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

  it('coalesces parked output at 4Hz while preserving every flush callback', () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const flushed: number[] = [];
    const scheduler = new PtyWriteScheduler('parked', (write) => {
      delivered.push(write.bytes[0]);
      write.onFlushed();
    });
    scheduler.write({
      bytes: Uint8Array.of(1),
      onFlushed: () => flushed.push(1),
      suppressSideEffects: true,
    });
    scheduler.write({
      bytes: Uint8Array.of(2),
      onFlushed: () => flushed.push(2),
      suppressSideEffects: true,
    });
    vi.advanceTimersByTime(249);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(delivered).toEqual([1, 2]);
    expect(flushed).toEqual([1, 2]);
    scheduler.dispose();
    vi.useRealTimers();
  });
});
