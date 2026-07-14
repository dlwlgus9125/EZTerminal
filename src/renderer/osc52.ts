/** Security policy for terminal-originated OSC 52 clipboard writes. */
export const OSC52_MAX_BYTES = 64 * 1024;
export const OSC52_MIN_INTERVAL_MS = 1_000;

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decode the write-only `clipboard;base64` payload accepted by EZTerminal.
 * Queries, non-default selections, malformed base64 and invalid UTF-8 fail
 * closed. The caller intentionally sends no terminal response.
 */
export function decodeOsc52Payload(payload: string): string | null {
  const separator = payload.indexOf(';');
  if (separator < 0) return null;
  const selection = payload.slice(0, separator);
  const encoded = payload.slice(separator + 1);
  if (selection !== 'c' || encoded === '' || encoded === '?') return null;
  if (encoded.length > Math.ceil(OSC52_MAX_BYTES / 3) * 4 || !BASE64_RE.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    if (binary.length > OSC52_MAX_BYTES) return null;
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export class Osc52WriteGate {
  private lastWriteAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs = OSC52_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  take(): boolean {
    const current = this.now();
    if (current - this.lastWriteAt < this.intervalMs) return false;
    this.lastWriteAt = current;
    return true;
  }
}

/** Reference-counted guard for asynchronous xterm writes that reconstruct
 * historical output. A release is idempotent so teardown/error paths cannot
 * underflow the depth. */
export class TerminalSideEffectSuppression {
  private depth = 0;

  get active(): boolean {
    return this.depth > 0;
  }

  enter(): () => void {
    this.depth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.depth = Math.max(0, this.depth - 1);
    };
  }
}

/** Decode first, then consume the rate slot only for a valid live clipboard
 * write. Historical replay is rendered but never consumes a slot or writes. */
export function acceptOsc52ClipboardWrite(
  payload: string,
  gate: Osc52WriteGate,
  suppressSideEffects = false,
): string | null {
  if (suppressSideEffects) return null;
  const text = decodeOsc52Payload(payload);
  if (text === null || !gate.take()) return null;
  return text;
}
