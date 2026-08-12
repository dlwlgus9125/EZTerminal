import { describe, expect, it } from 'vitest';

import {
  PTY_PRESENTATION_TAIL_BYTES,
  PtyPresentationTail,
  type PtyPresentationCheckpoint,
} from './pty-presentation-checkpoint';

const base: PtyPresentationCheckpoint = Object.freeze({
  serialized: 'base',
  tail: Object.freeze([]),
  cols: 80,
  rows: 24,
  viewportY: 0,
  selection: null,
  focused: false,
});

describe('PtyPresentationTail', () => {
  it('keeps the newest bounded bytes instead of making resume impossible on overflow', () => {
    const tail = new PtyPresentationTail();
    tail.append(new Uint8Array(PTY_PRESENTATION_TAIL_BYTES - 2).fill(1));
    tail.append(Uint8Array.of(2, 3, 4, 5));

    const merged = tail.merge(base);
    expect(merged).not.toBeNull();
    const bytes = merged!.tail.reduce((total, chunk) => total + chunk.byteLength, 0);
    expect(bytes).toBe(PTY_PRESENTATION_TAIL_BYTES);
    expect([...merged!.tail.at(-1)!]).toEqual([2, 3, 4, 5]);
  });

  it('retains only the end of one oversized chunk', () => {
    const tail = new PtyPresentationTail();
    const oversized = new Uint8Array(PTY_PRESENTATION_TAIL_BYTES + 3).fill(7);
    oversized.set([1, 2, 3], oversized.byteLength - 3);
    tail.append(oversized);

    const merged = tail.merge(base)!;
    expect(merged.tail).toHaveLength(1);
    expect(merged.tail[0]).toHaveLength(PTY_PRESENTATION_TAIL_BYTES);
    expect([...merged.tail[0]!.slice(-3)]).toEqual([1, 2, 3]);
  });

  it('bounds the combined prior and current tails across fallback generations', () => {
    const prior = Object.freeze({
      ...base,
      tail: Object.freeze([new Uint8Array(PTY_PRESENTATION_TAIL_BYTES).fill(1)]),
    });
    const tail = new PtyPresentationTail();
    tail.append(new Uint8Array(32).fill(2));

    const merged = tail.merge(prior)!;
    const bytes = merged.tail.reduce((total, chunk) => total + chunk.byteLength, 0);
    expect(bytes).toBe(PTY_PRESENTATION_TAIL_BYTES);
    expect([...merged.tail.at(-1)!]).toEqual(new Array(32).fill(2));
    expect(merged.tail[0]?.byteLength).toBe(PTY_PRESENTATION_TAIL_BYTES - 32);
  });
});
