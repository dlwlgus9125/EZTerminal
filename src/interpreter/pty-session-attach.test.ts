/**
 * PTY mirroring attach — ring-buffer replay + per-subscriber backpressure
 * (M2 T2.2d/e, Critic C4). A `pty`-shape run may be observed by more than one
 * port: the initiating surface (existing sent/acked byte-ack, unchanged) plus
 * any number of non-initiating `attach-run` mirrors (T2.2f). Two properties
 * matter here:
 *   - a late-attaching mirror still sees recent output (bounded scrollback
 *     ring, replay-then-live), and
 *   - a SLOW mirror can never stall/gate the primary port (no head-of-line
 *     blocking) — its own lag only ever affects itself.
 *
 * ATTACH CONTRACT:
 *   pty-session.ts exports, in addition to its existing surface:
 *     - `PTY_SCROLLBACK_RING_BYTES` (bounded ring capacity, oldest bytes drop first)
 *     - `PTY_ATTACH_CAP` (max concurrent attach subscribers; the next attach() is rejected)
 *     - `PTY_ATTACH_HIGH_WATER` / `PTY_ATTACH_LOW_WATER` (this subscriber's OWN
 *       pause/resume-equivalent thresholds — independent of the primary's
 *       PTY_HIGH_WATER/PTY_LOW_WATER, which stay exactly as today)
 *   `PtySession` gains:
 *     `attach(onData: (bytes: Uint8Array) => void): PtyAttachHandle | null`
 *   returning `null` once `PTY_ATTACH_CAP` subscribers are already attached
 *   (or once the session has already settled/disposed). `PtyAttachHandle` is
 *   `{ replay; releaseLive(); ack(); detach() }`. `replay` is the semantic
 *   snapshot/tail (or bounded raw fallback) at attach time. `releaseLive()`
 *   opens the gate only after replay is posted; live bytes are bounded while
 *   the gate is closed, then dropped whenever this subscriber's own
 *   unacked-byte count is over `PTY_ATTACH_HIGH_WATER`, resuming once it acks
 *   back down to `PTY_ATTACH_LOW_WATER`.
 *
 * Uses the same fake-`PtyHandle` harness as pty-session.test.ts (no
 * MessagePortMain, no native node-pty).
 */
import { describe, it, expect } from 'vitest';

import { ptyStreamData, type PtyHandle, type PtyStreamData } from './core';
import {
  PTY_ATTACH_CAP,
  PTY_ATTACH_HIGH_WATER,
  PTY_ATTACH_LOW_WATER,
  PTY_HIGH_WATER,
  PTY_SCROLLBACK_RING_BYTES,
  runPtySession,
} from './pty-session';

function makeFakePty() {
  let dataCb: (b: Uint8Array) => void = () => {};
  let exitCb: (code: number) => void = () => {};
  const calls = { paused: 0, resumed: 0, killed: 0 };
  const handle: PtyHandle = {
    onData(l) {
      dataCb = l;
    },
    onExit(l) {
      exitCb = l;
    },
    write() {},
    resize() {},
    pause() {
      calls.paused += 1;
    },
    resume() {
      calls.resumed += 1;
    },
    kill() {
      calls.killed += 1;
    },
  };
  const data: PtyStreamData = ptyStreamData(() => handle);
  return { data, calls, emitData: (b: Uint8Array) => dataCb(b), emitExit: (c: number) => exitCb(c) };
}

function collect() {
  const frames: unknown[] = [];
  return { frames, emit: (f: unknown) => frames.push(f) };
}

const chunk = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);

describe('runPtySession — mirroring attach (M2 T2.2d/e, Critic C4)', () => {
  it('attach() replays the ring buffer contents so far, then tees live data', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit as never, new AbortController().signal, 80, 24);

    fake.emitData(chunk(10, 1));
    const live: Uint8Array[] = [];
    const handle = session.attach((bytes) => live.push(bytes));
    expect(handle).not.toBeNull();
    expect(handle!.replay).toEqual(chunk(10, 1));
    expect(handle!.releaseLive()).toBeNull();

    fake.emitData(chunk(5, 2));
    expect(live).toEqual([chunk(5, 2)]);
  });

  it('bounds the ring to PTY_SCROLLBACK_RING_BYTES, dropping the OLDEST bytes first', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit as never, new AbortController().signal, 80, 24);

    // First chunk is entirely evicted; the ring ends up holding exactly the
    // second chunk (proves eviction is oldest-first, not a blind tail-slice
    // of the single latest write).
    fake.emitData(chunk(1024, 9));
    fake.emitData(chunk(PTY_SCROLLBACK_RING_BYTES, 7));

    const handle = session.attach(() => {});
    expect(handle!.replay.byteLength).toBe(PTY_SCROLLBACK_RING_BYTES);
    expect(handle!.replay.every((b) => b === 7)).toBe(true);
  });

  it('caps concurrent attach subscribers at PTY_ATTACH_CAP — the next attach() is rejected (null)', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit as never, new AbortController().signal, 80, 24);

    const handles = Array.from({ length: PTY_ATTACH_CAP }, () => session.attach(() => {}));
    expect(handles.every((h) => h !== null)).toBe(true);
    expect(session.attach(() => {})).toBeNull();
  });

  it('detaching frees a subscriber slot for a new attach', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit as never, new AbortController().signal, 80, 24);

    const handles = Array.from({ length: PTY_ATTACH_CAP }, () => session.attach(() => {}));
    handles[0]!.detach();
    expect(session.attach(() => {})).not.toBeNull();
  });

  it('a lagging attach subscriber (unacked past its own high-water) is DROPPED, not queued — resumes once it acks back to its low-water', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit as never, new AbortController().signal, 80, 24);

    const live: Uint8Array[] = [];
    const handle = session.attach((bytes) => live.push(bytes));
    expect(handle).not.toBeNull();
    expect(handle!.releaseLive()).toBeNull();

    fake.emitData(chunk(PTY_ATTACH_HIGH_WATER + 1, 3)); // crosses THIS subscriber's own high-water
    const deliveredAtStall = live.length;

    fake.emitData(chunk(1024, 3)); // dropped for this subscriber while behind — not queued for later
    expect(live.length).toBe(deliveredAtStall);

    handle!.ack(PTY_ATTACH_HIGH_WATER + 1 - PTY_ATTACH_LOW_WATER); // acks down to its low-water
    fake.emitData(chunk(1024, 4));
    expect(live.at(-1)).toEqual(chunk(1024, 4)); // flowing again once caught up
  });

  it('counts a large replay in the cumulative ACK coordinate before resuming partial live output', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit as never, new AbortController().signal, 80, 24);

    fake.emitData(chunk(128 * 1024, 2));
    const live: Uint8Array[] = [];
    const handle = session.attach((bytes) => live.push(bytes));
    expect(handle).not.toBeNull();
    const replayBytes = handle!.replay.byteLength;
    expect(replayBytes).toBeGreaterThan(0);
    expect(replayBytes).toBeLessThan(PTY_ATTACH_HIGH_WATER + 1 - PTY_ATTACH_LOW_WATER);
    expect(handle!.releaseLive()).toBeNull();

    const liveBytes = PTY_ATTACH_HIGH_WATER + 1;
    fake.emitData(chunk(liveBytes, 3));
    const deliveredAtStall = live.length;
    fake.emitData(chunk(1, 4));
    expect(live.length).toBe(deliveredAtStall);

    // The renderer has consumed all replay but only this much live output.
    // Its wire ACK is replay+live. Actual live lag is LOW+replay, so the
    // subscriber must remain paused even though a live-only interpretation of
    // the same ACK would incorrectly put it exactly at LOW.
    const partiallyConsumedLive = liveBytes - PTY_ATTACH_LOW_WATER - replayBytes;
    handle!.ack(replayBytes + partiallyConsumedLive);
    fake.emitData(chunk(1, 5));
    expect(live.length).toBe(deliveredAtStall);

    // Once the true live lag reaches LOW, delivery resumes.
    handle!.ack(replayBytes + liveBytes - PTY_ATTACH_LOW_WATER);
    fake.emitData(chunk(1, 6));
    expect(live.at(-1)).toEqual(chunk(1, 6));
  });

  it("an unacked attach subscriber never triggers the PRIMARY port's own pause (independent counters, no head-of-line block)", () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit as never, new AbortController().signal, 80, 24);
    session.attach(() => {})!.releaseLive(); // never acks — immediately falls behind its own high-water

    fake.emitData(chunk(PTY_HIGH_WATER + 1)); // crosses only the PRIMARY's own high-water
    // Same single-pause invariant as the no-attach case (pty-session.test.ts)
    // — the lagging, never-acking mirror must not add or block a pause here.
    expect(fake.calls.paused).toBe(1);
  });

  it('attach() after the session has settled/disposed returns null (no zombie subscriber)', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit as never, new AbortController().signal, 80, 24);
    session.dispose();
    expect(session.attach(() => {})).toBeNull();
  });
});
