import { describe, expect, it } from 'vitest';

import type { DaemonTranscriptItem } from '../shared/daemon-protocol';
import { DeltaCoalescer } from './delta-coalescer';

function harness(maxChars = 2_048) {
  const emitted: DaemonTranscriptItem[] = [];
  let scheduled: (() => void) | undefined;
  let sequence = 0;
  const coalescer = new DeltaCoalescer((item) => emitted.push(item), {
    maxChars,
    schedule: (callback) => { scheduled = callback; return 1; },
    cancel: () => { scheduled = undefined; },
  });
  const build = (messageId: string) => (text: string): DaemonTranscriptItem => ({
    id: `delta-${sequence + 1}`, messageId, sessionId: 's', turnId: 't', sequence: ++sequence,
    kind: 'assistant-message', text, isDelta: true, isSensitive: true, createdAt: 'now',
  });
  return { coalescer, emitted, build, tick: () => scheduled?.() };
}

describe('DeltaCoalescer', () => {
  it('merges deltas of one message into a single row per tick', () => {
    const { coalescer, emitted, build, tick } = harness();
    coalescer.append('m1', 'Hel', build('m1'));
    coalescer.append('m1', 'lo', build('m1'));
    expect(emitted).toEqual([]);
    tick();
    expect(emitted.map((item) => [item.text, item.sequence])).toEqual([['Hello', 1]]);
  });

  it('flushes on the size bound without waiting for the timer', () => {
    const { coalescer, emitted, build } = harness(4);
    coalescer.append('m1', 'ab', build('m1'));
    coalescer.append('m1', 'cd', build('m1'));
    expect(emitted.map((item) => item.text)).toEqual(['abcd']);
    expect(coalescer.size).toBe(0);
  });

  it('keeps messages separate and allocates sequences only on emit', () => {
    const { coalescer, emitted, build } = harness();
    coalescer.append('m1', 'a', build('m1'));
    coalescer.append('m2', 'b', build('m2'));
    coalescer.flushAll();
    expect(emitted.map((item) => [item.messageId, item.text, item.sequence])).toEqual([['m1', 'a', 1], ['m2', 'b', 2]]);
  });

  it('flushes pending text on dispose instead of dropping it', () => {
    const { coalescer, emitted, build } = harness();
    coalescer.append('m1', 'partial', build('m1'));
    coalescer.dispose();
    expect(emitted.map((item) => item.text)).toEqual(['partial']);
  });
});
