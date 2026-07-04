import { describe, it, expect } from 'vitest';

import type { InterpreterFrame } from '../shared/ipc';
import { ptyStreamData, type PtyHandle, type PtyStreamData } from './core';
import { PTY_HIGH_WATER, PTY_LOW_WATER, TuiSignalDetector, runPtySession } from './pty-session';

/** A fake PtyHandle the test drives via emitData/emitExit. `forceXterm` mirrors
 * the `!cmd` metadata M2's evaluator threads onto PtyStreamData (Phase 3). */
function makeFakePty(forceXterm?: boolean) {
  let dataCb: (b: Uint8Array) => void = () => {};
  let exitCb: (code: number) => void = () => {};
  const calls = {
    spawnedAt: null as null | [number, number],
    writes: [] as string[],
    resizes: [] as Array<[number, number]>,
    killed: 0,
    paused: 0,
    resumed: 0,
    /** Interleaved order of lifecycle calls — proves resume-then-kill. */
    order: [] as string[],
  };
  const handle: PtyHandle = {
    onData(l) {
      dataCb = l;
    },
    onExit(l) {
      exitCb = l;
    },
    write(d) {
      calls.writes.push(d);
    },
    resize(c, r) {
      calls.resizes.push([c, r]);
    },
    pause() {
      calls.paused += 1;
      calls.order.push('pause');
    },
    resume() {
      calls.resumed += 1;
      calls.order.push('resume');
    },
    kill() {
      calls.killed += 1;
      calls.order.push('kill');
    },
  };
  const data: PtyStreamData = ptyStreamData((cols, rows) => {
    calls.spawnedAt = [cols, rows];
    return handle;
  }, forceXterm);
  return { data, calls, emitData: (b: Uint8Array) => dataCb(b), emitExit: (c: number) => exitCb(c) };
}

function collect() {
  const frames: InterpreterFrame[] = [];
  return { frames, emit: (f: InterpreterFrame) => frames.push(f) };
}

describe('runPtySession', () => {
  it('emits schema{shape:pty} first and forwards data as pty-data frames', () => {
    const fake = makeFakePty();
    const { frames, emit } = collect();
    runPtySession(fake.data, emit, new AbortController().signal, 80, 24);

    expect(frames[0]).toEqual({ type: 'schema', columns: [], shape: 'pty' });
    fake.emitData(new Uint8Array([27, 91, 65]));
    const dataFrame = frames.find((f) => f.type === 'pty-data');
    expect(dataFrame).toEqual({ type: 'pty-data', data: new Uint8Array([27, 91, 65]) });
  });

  it('spawns the PTY at the clamped initial size', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    runPtySession(fake.data, emit, new AbortController().signal, 0, 99_999);
    expect(fake.calls.spawnedAt).toEqual([1, 1000]); // clamped to [>=1, <=1000]
  });

  it('a normal exit emits a single end frame', () => {
    const fake = makeFakePty();
    const { frames, emit } = collect();
    runPtySession(fake.data, emit, new AbortController().signal, 80, 24);
    fake.emitExit(0);
    expect(frames.filter((f) => f.type === 'end')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'cancelled')).toHaveLength(0);
  });

  it('data is ordered before the terminal end frame', () => {
    const fake = makeFakePty();
    const { frames, emit } = collect();
    runPtySession(fake.data, emit, new AbortController().signal, 80, 24);
    fake.emitData(new Uint8Array([1]));
    fake.emitExit(0);
    const dataIdx = frames.findIndex((f) => f.type === 'pty-data');
    const endIdx = frames.findIndex((f) => f.type === 'end');
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(dataIdx);
  });

  it('(B2) cancel emits cancelled once, kills, and SUPPRESSES the kill-triggered exit', () => {
    const fake = makeFakePty();
    const ac = new AbortController();
    const { frames, emit } = collect();
    runPtySession(fake.data, emit, ac.signal, 80, 24);

    ac.abort();
    // killing a real PTY triggers onExit — simulate it AFTER the cancel.
    fake.emitExit(0);

    expect(fake.calls.killed).toBe(1);
    expect(frames.filter((f) => f.type === 'cancelled')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'end')).toHaveLength(0); // end suppressed
  });

  it('drops data emitted after a terminal state', () => {
    const fake = makeFakePty();
    const ac = new AbortController();
    const { frames, emit } = collect();
    runPtySession(fake.data, emit, ac.signal, 80, 24);
    ac.abort();
    fake.emitData(new Uint8Array([9]));
    expect(frames.filter((f) => f.type === 'pty-data')).toHaveLength(0);
  });

  it('write/resize delegate (resize clamped) and become no-ops after settle', () => {
    const fake = makeFakePty();
    const ac = new AbortController();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit, ac.signal, 80, 24);

    session.write('ls\r');
    session.resize(0, 50); // cols clamped to 1
    expect(fake.calls.writes).toEqual(['ls\r']);
    expect(fake.calls.resizes).toEqual([[1, 50]]);

    ac.abort();
    session.write('ignored');
    session.resize(10, 10);
    expect(fake.calls.writes).toEqual(['ls\r']); // unchanged
    expect(fake.calls.resizes).toEqual([[1, 50]]); // unchanged
  });

  it('dispose kills without emitting a terminal frame', () => {
    const fake = makeFakePty();
    const { frames, emit } = collect();
    const session = runPtySession(fake.data, emit, new AbortController().signal, 80, 24);
    session.dispose();
    expect(fake.calls.killed).toBe(1);
    expect(frames.filter((f) => f.type === 'end' || f.type === 'cancelled')).toHaveLength(0);
    // a late exit after dispose is also suppressed
    fake.emitExit(0);
    expect(frames.filter((f) => f.type === 'end')).toHaveLength(0);
  });
});

describe('runPtySession — byte-ack backpressure (Stage C)', () => {
  const chunk = (n: number): Uint8Array => new Uint8Array(n);

  it('pauses ONCE when sent-minus-acked exceeds the high-water mark', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    runPtySession(fake.data, emit, new AbortController().signal, 80, 24);

    fake.emitData(chunk(PTY_HIGH_WATER)); // == HIGH: not yet over
    expect(fake.calls.paused).toBe(0);
    fake.emitData(chunk(1)); // crosses HIGH
    expect(fake.calls.paused).toBe(1);
    fake.emitData(chunk(1024)); // still over — no duplicate pause
    expect(fake.calls.paused).toBe(1);
  });

  it('resumes ONCE when a cumulative ack drains to the low-water mark', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit, new AbortController().signal, 80, 24);

    fake.emitData(chunk(PTY_HIGH_WATER + 1));
    expect(fake.calls.paused).toBe(1);

    // Partial ack — still above LOW: no resume.
    session.ack(PTY_HIGH_WATER + 1 - PTY_LOW_WATER - 1);
    expect(fake.calls.resumed).toBe(0);
    // Ack down to exactly LOW unacked: resume fires once.
    session.ack(PTY_HIGH_WATER + 1 - PTY_LOW_WATER);
    expect(fake.calls.resumed).toBe(1);
    session.ack(PTY_HIGH_WATER + 1); // further acks: no duplicate resume
    expect(fake.calls.resumed).toBe(1);
  });

  it('acks are monotonic and clamped to sent (stale/garbage acks are inert)', () => {
    const fake = makeFakePty();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit, new AbortController().signal, 80, 24);

    fake.emitData(chunk(PTY_HIGH_WATER + 1));
    session.ack(Number.NaN); // garbage → ignored
    session.ack(-5); // below current → ignored
    expect(fake.calls.resumed).toBe(0);
    session.ack(Number.MAX_SAFE_INTEGER); // clamped to sent → fully drained
    expect(fake.calls.resumed).toBe(1);
    // After the clamp, a re-pause requires ANOTHER full high-water of new data.
    fake.emitData(chunk(PTY_HIGH_WATER + 1));
    expect(fake.calls.paused).toBe(2);
  });

  it('ack is a no-op after settle', () => {
    const fake = makeFakePty();
    const ac = new AbortController();
    const { emit } = collect();
    const session = runPtySession(fake.data, emit, ac.signal, 80, 24);
    fake.emitData(chunk(PTY_HIGH_WATER + 1));
    ac.abort();
    const resumesAtSettle = fake.calls.resumed;
    session.ack(PTY_HIGH_WATER + 1);
    expect(fake.calls.resumed).toBe(resumesAtSettle); // no post-settle resume
  });

  it('every teardown path resumes BEFORE killing (paused-socket kill edge)', () => {
    // cancel path
    const cancelled = makeFakePty();
    const ac = new AbortController();
    runPtySession(cancelled.data, collect().emit, ac.signal, 80, 24);
    cancelled.emitData(chunk(PTY_HIGH_WATER + 1)); // now paused
    ac.abort();
    expect(cancelled.calls.order).toEqual(['pause', 'resume', 'kill']);

    // dispose path
    const disposed = makeFakePty();
    const session = runPtySession(disposed.data, collect().emit, new AbortController().signal, 80, 24);
    disposed.emitData(chunk(PTY_HIGH_WATER + 1));
    session.dispose();
    expect(disposed.calls.order).toEqual(['pause', 'resume', 'kill']);
  });
});

describe('TuiSignalDetector (Phase 3, M0a trigger set — pty-signal-measurements.md §7)', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const ESC = '\x1b';

  it('fires on alt-screen (?1049h)', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc(`${ESC}[?1049h`))).toBe(true);
  });

  it('fires on the older alt-screen variant (?47h)', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc(`${ESC}[?47h`))).toBe(true);
  });

  it('fires on bracketed paste (?2004h) — the confirmed claude/codex signal', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc(`${ESC}[?2004h`))).toBe(true);
  });

  it('does NOT fire on focus tracking (?1004h) — node-pty useConptyDll:true emits this unconditionally at session start (2026-07-03 measurement), so it is backend noise, not a program signal', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc(`${ESC}[?1004h`))).toBe(false);
  });

  it('does NOT fire on the bundled-ConPTY (useConptyDll:true) startup preamble — ESC[1t ESC[c ESC[?1004h ESC[?9001h, sent on EVERY session before the child writes anything', () => {
    const d = new TuiSignalDetector();
    const preamble = `${ESC}[1t${ESC}[c${ESC}[?1004h${ESC}[?9001h`;
    expect(d.feed(enc(preamble))).toBe(false);
  });

  it('fires on mouse click-tracking (?1000h and ?1006h, the bucket ends)', () => {
    expect(new TuiSignalDetector().feed(enc(`${ESC}[?1000h`))).toBe(true);
    expect(new TuiSignalDetector().feed(enc(`${ESC}[?1006h`))).toBe(true);
  });

  it('fires on app-cursor-keys (?1h)', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc(`${ESC}[?1h`))).toBe(true);
  });

  it('does NOT fire once already fired (one-shot)', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc(`${ESC}[?2004h`))).toBe(true);
    expect(d.feed(enc(`${ESC}[?1049h`))).toBe(false); // already fired — no second trigger
  });

  it('does NOT fire on bare (non-`?`-prefixed) 25l — ConPTY repaint noise (M0a §1.4)', () => {
    const d = new TuiSignalDetector();
    // ConPTY's own repaint bracketing: bare hide, real content, proper ?25h show.
    expect(d.feed(enc(`${ESC}[25l some redrawn content ${ESC}[?25h`))).toBe(false);
  });

  it('does NOT fire on a real ?25l cursor-hide — discarded per M0a §5/§7 (npm/pnpm collision)', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc(`${ESC}[?25l`))).toBe(false);
  });

  it('does NOT fire on absolute cursor positioning (pnpm-style multi-line progress, M0a §5)', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc(`${ESC}[2;1H${ESC}[4;1Hprogress line`))).toBe(false);
  });

  it('does NOT fire on plain text / npm-style spinner output', () => {
    const d = new TuiSignalDetector();
    expect(d.feed(enc('installing... ⠇ 42%'))).toBe(false);
  });

  it('fires on a trigger sequence split across two feed() calls (chunk-boundary carry)', () => {
    const d = new TuiSignalDetector();
    const full = enc(`${ESC}[?2004h`);
    // Split mid-sequence — the carry buffer must stitch it back together.
    const first = full.slice(0, 4); // "\x1b[?2"
    const second = full.slice(4); // "004h"
    expect(d.feed(first)).toBe(false);
    expect(d.feed(second)).toBe(true);
  });

  it('fires on the real ink-style (claude) trigger burst captured by M0a', () => {
    const d = new TuiSignalDetector();
    const burst = `${ESC}[?2004h${ESC}[?1004h${ESC}[?2031h${ESC}[<u${ESC}[>1u${ESC}[>4;2m${ESC}[>0q${ESC}[?2026h${ESC}[?2026l`;
    expect(d.feed(enc(burst))).toBe(true);
  });

  it('fires on the real ratatui-style (codex) trigger burst captured by M0a', () => {
    const d = new TuiSignalDetector();
    const burst = `${ESC}[?2004h${ESC}[?1004h${ESC}]10;?${ESC}\\${ESC}]11;?${ESC}\\`;
    expect(d.feed(enc(burst))).toBe(true);
  });
});

describe('runPtySession — adaptive render (Phase 3)', () => {
  it('forceXterm upgrades immediately, right after schema, before any data', () => {
    const fake = makeFakePty(true);
    const { frames, emit } = collect();
    runPtySession(fake.data, emit, new AbortController().signal, 80, 24);

    expect(frames[0]).toEqual({ type: 'schema', columns: [], shape: 'pty' });
    expect(frames[1]).toEqual({ type: 'pty-render-upgrade' });
    expect(frames.filter((f) => f.type === 'pty-render-upgrade')).toHaveLength(1);
  });

  it('a bare (non-forceXterm) command does NOT upgrade eagerly — plain until a trigger fires', () => {
    const fake = makeFakePty();
    const { frames, emit } = collect();
    runPtySession(fake.data, emit, new AbortController().signal, 80, 24);
    expect(frames.some((f) => f.type === 'pty-render-upgrade')).toBe(false);

    fake.emitData(new TextEncoder().encode('plain output, no signal'));
    expect(frames.some((f) => f.type === 'pty-render-upgrade')).toBe(false);
  });

  it('emits ONE pty-render-upgrade, before the triggering chunk\'s pty-data, on first detection', () => {
    const fake = makeFakePty();
    const { frames, emit } = collect();
    runPtySession(fake.data, emit, new AbortController().signal, 80, 24);

    fake.emitData(new TextEncoder().encode('\x1b[?2004h\x1b[?1004h'));
    const upgradeIdx = frames.findIndex((f) => f.type === 'pty-render-upgrade');
    const dataIdx = frames.findIndex((f) => f.type === 'pty-data');
    expect(upgradeIdx).toBeGreaterThanOrEqual(0);
    expect(dataIdx).toBeGreaterThan(upgradeIdx);

    // A second trigger-bearing chunk does not upgrade again.
    fake.emitData(new TextEncoder().encode('\x1b[?1049h'));
    expect(frames.filter((f) => f.type === 'pty-render-upgrade')).toHaveLength(1);
  });
});
