/**
 * PTY session runner — the PTY-block analogue of {@link runBlock} (Phase 2 TUI).
 *
 * A `pty-stream` is a live, bidirectional terminal, not a row/byte source, so it
 * BYPASSES the ResultStore / credit-window / chunk machinery entirely. This driver:
 *   - emits a `schema {shape:'pty'}` so the renderer mounts an xterm block,
 *   - forwards PTY output bytes as `pty-data` frames,
 *   - forwards renderer input/resize controls to the PTY,
 *   - and guarantees a SINGLE terminal frame (one-shot guard): a cancel emits
 *     `cancelled` and SUPPRESSES the `end` that `pty.kill()` then triggers, while a
 *     normal exit emits `end`. This is what makes Cancel show `cancelled` and not
 *     `done` (the renderer maps `end` → done).
 *
 * Extracted from the Electron seam so it is testable with a plain `emit` + a fake
 * {@link PtyHandle} (no MessagePortMain, no node-pty native required).
 */

import type { PtyStreamData } from './core';
import type { Emit } from './block-runner';

/** Clamp terminal dimensions to a sane range before applying to the PTY. Also
 * used by ssh-session.ts (same PTY-grid contract, post-channel). */
const MAX_DIM = 1000;
export function clampDim(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_DIM);
}

/**
 * Byte-ack backpressure thresholds (Stage C, gate B3): the interpreter pauses
 * the PTY once sent-minus-acked exceeds HIGH and resumes at/below LOW. Because
 * the pause decision lives HERE (where the sent counter is), total in-flight
 * bytes — port queue + renderer pre-sink buffer + xterm pending — are bounded
 * by HIGH + one chunk BY CONSTRUCTION, with no XON/XOFF ordering races.
 */
export const PTY_HIGH_WATER = 1024 * 1024;
export const PTY_LOW_WATER = 256 * 1024;

/**
 * M2 mirroring (T2.2d/e, Critic C4): a `pty`-shape run may be observed by more
 * than one port — the initiator (above, unchanged) plus any number of non-
 * initiating `attach-run` mirrors. Two properties matter: a late attacher
 * still sees recent output (bounded scrollback ring, replay-then-live), and a
 * SLOW mirror can never stall/gate the primary (its own lag only ever drops
 * ITS OWN future bytes — never queued, never affects the primary's pause).
 */
/** Bounded scrollback ring capacity (oldest bytes drop first) — an `attach()`
 * replays exactly this much recent output before tee-ing live. */
export const PTY_SCROLLBACK_RING_BYTES = 256 * 1024;
/** Max concurrent `attach()` subscribers — the next `attach()` is rejected (null). */
export const PTY_ATTACH_CAP = 4;
/** A subscriber's OWN pause/resume thresholds — independent of the primary's
 * `PTY_HIGH_WATER`/`PTY_LOW_WATER` above, which are untouched by attach traffic. */
export const PTY_ATTACH_HIGH_WATER = 1024 * 1024;
export const PTY_ATTACH_LOW_WATER = 256 * 1024;

/** Returned by {@link PtySession.attach}. `replay` is the ring's contents AT
 * attach time; live bytes stream via the `onData` callback passed to `attach`
 * afterward, dropped (not queued) whenever this subscriber's own unacked-byte
 * count is over `PTY_ATTACH_HIGH_WATER`, resuming once it acks back down to
 * `PTY_ATTACH_LOW_WATER`. */
export interface PtyAttachHandle {
  readonly replay: Uint8Array;
  /** Cumulative bytes this subscriber has flushed — same monotonic-ack shape as `PtySession.ack`. */
  ack(bytes: number): void;
  /** Stop receiving further live data and free the subscriber slot. Idempotent. */
  detach(): void;
}

/**
 * Adaptive-render trigger detector (Phase 3, M0a-confirmed trigger set —
 * .omc/research/pty-signal-measurements.md §7). Fires ONCE, on the FIRST
 * high-confidence "about to read interactive input" DEC private-mode SET
 * sequence: alt-screen (`?1049h`/`?47h`), bracketed paste (`?2004h`),
 * mouse/focus tracking (`?1000h`-`?1006h`, EXCEPT `?1004h` — see below), or
 * app-cursor-keys (`?1h`). The `?` DEC-private prefix is REQUIRED — ConPTY's
 * own repaint bracketing emits a constant, unrelated BARE `ESC[25l` (no `?`)
 * that would otherwise be a severe false-positive source; this trigger set
 * never matches bare `25l` at all (the discarded `?25l` composite fallback,
 * M0a §5/§7).
 *
 * `?1004h` (focus-event tracking) is EXCLUDED from the mouse/focus range: with
 * node-pty's `useConptyDll:true` (bundled conpty.dll/OpenConsole.exe, adopted
 * 2026-07-03 to fix tail-only scrollback loss on old system ConPTY builds),
 * the backend itself unconditionally emits a fixed startup preamble —
 * `ESC[1t ESC[c ESC[?1004h ESC[?9001h` — on EVERY session before the child
 * writes anything, which is backend noise, not a program signal (same
 * principle as the bare `ESC[25l` exclusion above: a PTY backend's own
 * unconditional output can never be a valid trigger). No detection loss: M0a
 * measured claude/codex both emit `?2004h` (bracketed paste) independently,
 * which is unaffected and still fires the detector.
 */
// eslint-disable-next-line no-control-regex -- matching a real ESC (0x1b) terminal escape sequence is the entire point of this regex
const TRIGGER_RE = /\x1b\[\?(?:1049|47|2004|100[0-35-6]|1)h/;
const CARRY_BYTES = 16;

export class TuiSignalDetector {
  private carry = '';
  private fired = false;

  /** Feed the next output chunk. Returns true the FIRST time a trigger fires
   * (false before that and on every call after). */
  feed(chunk: Uint8Array): boolean {
    if (this.fired) return false;
    // Escape sequences are pure ASCII control/parameter bytes — a raw Latin-1
    // decode (no UTF-8 validity concerns) is enough for pattern matching; the
    // actual render decode (ansi.ts, renderer-side) is separate and unaffected.
    const text = this.carry + Buffer.from(chunk).toString('latin1');
    if (TRIGGER_RE.test(text)) {
      this.fired = true;
      return true;
    }
    this.carry = text.slice(-CARRY_BYTES);
    return false;
  }
}

/**
 * DEC private-mode state tracker (TUI scroll parity — late-attach mode resync).
 *
 * A late `attach()` replays only the bounded ring — once a long-running TUI
 * evicts its startup DECSETs (claude's full-screen redraws exceed 256 KiB in
 * seconds), a late mirror's xterm never learns the alt-screen / mouse-tracking
 * / bracketed-paste state and silently degrades. Observed on the phone
 * (2026-07-12 emulator capture): the mirror believed `mouseTrackingMode:
 * 'none'` in the NORMAL buffer, so touch/wheel scrolling fell back to local
 * viewport scrolling instead of reaching the child. Track the current SET/RST
 * state of the modes that matter to a mirror and synthesize a restoration
 * preamble `attach()` prepends to the replay — the same state-resync idea
 * tmux applies to late clients. Re-scanning bytes kept in the carry window is
 * harmless: reapplying `h`/`l` is idempotent and text order = stream order.
 *
 * Restored modes (everything else is deliberately left out — e.g. `?1004h`
 * focus reporting would make every mirror inject focus events into the SHARED
 * PTY input, `?2026h` is transient frame bracketing, `?9001h` is ConPTY
 * backend noise xterm ignores anyway):
 *  - 1    DECCKM app cursor keys (arrow-key ENCODING — wheel fallback / soft keys)
 *  - 7    DECAWM auto-wrap
 *  - 25   cursor visibility
 *  - 47 / 1049  alternate screen
 *  - 1000 / 1002 / 1003 / 1005 / 1006 / 1015 / 1016  mouse tracking + encodings
 *  - 2004 bracketed paste (a late mirror's `term.paste` framing depends on it)
 */
const RESTORED_DEC_MODES: ReadonlySet<number> = new Set([
  1, 7, 25, 47, 1000, 1002, 1003, 1005, 1006, 1015, 1016, 1049, 2004,
]);
// eslint-disable-next-line no-control-regex -- matching a real ESC (0x1b) terminal escape sequence is the entire point of this regex
const DEC_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;
/** Longer than TuiSignalDetector's carry: DECSET param lists (`?1002;1006h`) are longer. */
const MODE_CARRY_BYTES = 32;

export class DecPrivateModeTracker {
  private carry = '';
  private readonly state = new Map<number, boolean>();

  /** Feed the next output chunk (same Latin-1 rationale as TuiSignalDetector). */
  feed(chunk: Uint8Array): void {
    const text = this.carry + Buffer.from(chunk).toString('latin1');
    if (text.includes('\x1b[?')) {
      for (const m of text.matchAll(DEC_MODE_RE)) {
        const set = m[2] === 'h';
        for (const param of m[1].split(';')) {
          const mode = Number(param);
          if (RESTORED_DEC_MODES.has(mode)) this.state.set(mode, set);
        }
      }
    }
    this.carry = text.slice(-MODE_CARRY_BYTES);
  }

  /** Restoration preamble for every tracked mode's CURRENT state (empty if none seen). */
  preamble(): Uint8Array {
    let out = '';
    for (const mode of [...this.state.keys()].sort((a, b) => a - b)) {
      out += `\x1b[?${String(mode)}${this.state.get(mode) === true ? 'h' : 'l'}`;
    }
    return Buffer.from(out, 'latin1');
  }
}

export interface PtySession {
  /** Forward keystrokes / pasted text to the PTY child. */
  write(data: string): void;
  /** Resize the PTY grid (clamped). */
  resize(cols: number, rows: number): void;
  /**
   * Renderer flow ack: CUMULATIVE bytes its xterm actually flushed. Monotonic —
   * stale/duplicate acks are ignored. May resume a paused PTY.
   */
  ack(bytes: number): void;
  /** Tear down: kill the PTY + release the source. Idempotent. */
  dispose(): void;
  /**
   * M2 mirroring: attach a non-initiating observer. Returns `null` once
   * `PTY_ATTACH_CAP` subscribers are already attached, or once the session
   * has already settled/disposed (no zombie subscribers).
   */
  attach(onData: (bytes: Uint8Array) => void): PtyAttachHandle | null;
}

/**
 * Spawn the PTY at the renderer-provided initial size and wire its bidirectional
 * stream to the framed `emit`. Returns a handle the ExecutionSession drives with
 * `pty-input` / `pty-resize` controls and disposes on close.
 */
export function runPtySession(
  data: PtyStreamData,
  emit: Emit,
  signal: AbortSignal,
  cols: number,
  rows: number,
): PtySession {
  // One-shot terminal-state guard (B2): the FIRST of {exit, cancel, dispose} wins;
  // everything after it is a no-op so exactly one terminal frame is ever emitted.
  let settled = false;

  // Backpressure state (Stage C): bytes emitted vs bytes the renderer flushed.
  let sent = 0;
  let acked = 0;
  let paused = false;

  // M2 mirroring (T2.2d/e): bounded scrollback ring (oldest bytes drop first,
  // always keeping at least the newest chunk even if it alone exceeds the
  // cap) + per-`attach()` subscribers, each paced independently of `sent`/
  // `acked`/`paused` above (a slow subscriber only ever drops ITS OWN future
  // bytes — never queued, never touches `pty.pause()`/`pty.resume()`).
  interface AttachSubscriber {
    readonly onData: (bytes: Uint8Array) => void;
    sent: number;
    acked: number;
    paused: boolean;
  }
  const attachSubscribers = new Set<AttachSubscriber>();
  const ring: Uint8Array[] = [];
  let ringBytes = 0;

  const appendToRing = (data: Uint8Array): void => {
    ring.push(data);
    ringBytes += data.byteLength;
    while (ringBytes > PTY_SCROLLBACK_RING_BYTES && ring.length > 1) {
      const dropped = ring.shift();
      if (dropped) ringBytes -= dropped.byteLength;
    }
  };

  const concatRing = (): Uint8Array => {
    const out = new Uint8Array(ringBytes);
    let offset = 0;
    for (const c of ring) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  };

  const pty = data.spawn(clampDim(cols), clampDim(rows));

  // Schema first so the renderer mounts the pty block before any data arrives.
  emit({ type: 'schema', columns: [], shape: 'pty' });

  // Adaptive render (Phase 3): `forceXterm` (`!cmd`, M2) upgrades immediately —
  // the renderer starts directly in xterm mode with nothing to replay yet.
  // Otherwise the detector watches the live byte stream and the upgrade frame
  // fires once, on the first high-confidence TUI signal.
  let upgraded = false;
  const detector = new TuiSignalDetector();
  const modeTracker = new DecPrivateModeTracker();
  if (data.forceXterm) {
    upgraded = true;
    emit({ type: 'pty-render-upgrade' });
  }

  const cleanup = (): void => {
    void data.cleanup?.();
  };

  // Every teardown path resumes first: cheap, and keeps any final buffered
  // output flowing while the kill lands (gate record §Q1 — exit detection does
  // not strictly need it, but cancel/exit must never race a paused socket).
  const resumeThenKill = (): void => {
    try {
      pty.resume();
    } catch {
      // Already gone.
    }
    try {
      pty.kill();
    } catch {
      // Already gone.
    }
  };

  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    resumeThenKill();
    emit({ type: 'cancelled' });
    cleanup();
  };

  pty.onData((bytes) => {
    if (settled) return;
    sent += bytes.byteLength;
    if (!upgraded && detector.feed(bytes)) {
      upgraded = true;
      emit({ type: 'pty-render-upgrade' });
    }
    modeTracker.feed(bytes);
    emit({ type: 'pty-data', data: bytes });
    appendToRing(bytes);
    // Tee to every attach subscriber independently — a paused one just misses
    // this chunk (dropped, not queued); it never affects the primary's own
    // pause below or any OTHER subscriber's delivery (no head-of-line block).
    for (const sub of attachSubscribers) {
      if (sub.paused) continue;
      sub.onData(bytes);
      sub.sent += bytes.byteLength;
      if (sub.sent - sub.acked > PTY_ATTACH_HIGH_WATER) sub.paused = true;
    }
    if (!paused && sent - acked > PTY_HIGH_WATER) {
      paused = true;
      pty.pause();
    }
  });

  pty.onExit(() => {
    if (settled) return;
    settled = true;
    emit({ type: 'end' });
    cleanup();
  });

  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  return {
    write(input: string): void {
      if (!settled) pty.write(input);
    },
    resize(c: number, r: number): void {
      if (!settled) pty.resize(clampDim(c), clampDim(r));
    },
    ack(bytes: number): void {
      if (settled || !Number.isFinite(bytes)) return;
      if (bytes > acked) acked = Math.min(bytes, sent); // monotonic, never beyond sent
      if (paused && sent - acked <= PTY_LOW_WATER) {
        paused = false;
        pty.resume();
      }
    },
    dispose(): void {
      if (settled) return;
      settled = true;
      resumeThenKill();
      cleanup();
      attachSubscribers.clear();
    },
    attach(onData: (bytes: Uint8Array) => void): PtyAttachHandle | null {
      if (settled) return null;
      if (attachSubscribers.size >= PTY_ATTACH_CAP) return null;
      const sub: AttachSubscriber = { onData, sent: 0, acked: 0, paused: false };
      attachSubscribers.add(sub);
      // Late-attach mode resync: prepend the tracked DEC private-mode state so
      // a mirror whose ring replay no longer contains the original DECSETs
      // (evicted by heavy TUI redraws) still reconstructs alt-screen / mouse /
      // paste modes. For an early attacher the ring still holds the originals
      // and reapplying them is idempotent; the ring's own later transitions
      // replay after the preamble, so the final state always matches the child.
      const preamble = modeTracker.preamble();
      const ringData = concatRing();
      let replay = ringData;
      if (preamble.byteLength > 0) {
        replay = new Uint8Array(preamble.byteLength + ringData.byteLength);
        replay.set(preamble, 0);
        replay.set(ringData, preamble.byteLength);
      }
      return {
        replay,
        ack(bytes: number): void {
          if (settled || !Number.isFinite(bytes)) return;
          if (bytes > sub.acked) sub.acked = Math.min(bytes, sub.sent);
          if (sub.paused && sub.sent - sub.acked <= PTY_ATTACH_LOW_WATER) sub.paused = false;
        },
        detach(): void {
          attachSubscribers.delete(sub);
        },
      };
    },
  };
}
