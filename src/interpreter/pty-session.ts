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

  const pty = data.spawn(clampDim(cols), clampDim(rows));

  // Schema first so the renderer mounts the pty block before any data arrives.
  emit({ type: 'schema', columns: [], shape: 'pty' });

  // Adaptive render (Phase 3): `forceXterm` (`!cmd`, M2) upgrades immediately —
  // the renderer starts directly in xterm mode with nothing to replay yet.
  // Otherwise the detector watches the live byte stream and the upgrade frame
  // fires once, on the first high-confidence TUI signal.
  let upgraded = false;
  const detector = new TuiSignalDetector();
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
    emit({ type: 'pty-data', data: bytes });
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
    },
  };
}
