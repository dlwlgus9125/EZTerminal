/**
 * Terminal-query detector for the mirror auto-reply gate (PtyBlock.tsx).
 *
 * A NON-controlling view must not re-answer terminal queries it merely
 * replays/tees (DA replies injected into the SHARED PTY corrupted commands —
 * the original M6 bug). The gate used to arm for EVERY mirror write, treating
 * "onData while any write is in flight" as "auto-reply". That proxy assumed
 * brief windows — but a claude-class fullscreen TUI repaints continuously
 * (spinner/HUD animation), keeping a write in flight almost permanently, which
 * was observed (2026-07-12 emulator capture) to swallow essentially ALL phone
 * input — touch-scroll mouse reports and keys alike — on a non-controlling
 * mirror. Only a write that actually CARRIES a query can make xterm emit an
 * auto-reply, so the gate now arms only for those writes.
 *
 * Query set = what xterm.js answers during parse:
 *  - DA1 `CSI Ps c`, DA2 `CSI > Ps c`, DA3 `CSI = Ps c`
 *  - DSR `CSI 5 n` (status) / CPR `CSI 6 n` (cursor position)
 *  - DECRQM `CSI ? Ps $ p`
 *  - DECREQTPARM `CSI Ps x`
 *  - XTVERSION `CSI > Ps q` (claude's startup burst carries `CSI > 0 q`)
 *  - OSC color queries `OSC 4/10/11/12 ; ... ?`
 * False positives only re-create the old brief gate for one write — harmless.
 */
// eslint-disable-next-line no-control-regex -- matching real ESC (0x1b) terminal escape sequences is the entire point
const QUERY_RE = /\x1b(?:\[(?:[0-9;]*c|>[0-9;]*c|=[0-9;]*c|[56]n|\?[0-9;]+\$p|>[0-9;]*q|[0-9;]*x)|\][0-9]+;[^\x07\x1b]*\?)/;

/** Longest query prefix that could straddle a chunk boundary. */
export const QUERY_CARRY_CHARS = 16;

/** Does this (carry + chunk) text contain a terminal query xterm would answer? */
export function containsTerminalQuery(text: string): boolean {
  return QUERY_RE.test(text);
}
