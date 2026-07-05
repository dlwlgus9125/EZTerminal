import type { KeyboardEvent } from 'react';

/**
 * Minimal keyset forwarded to the PTY child in plain mode (B-R4): printable
 * characters, Enter, Backspace, Ctrl+C, Ctrl+D, Tab. Richer editing (arrow
 * keys / history) and IME composition are intentionally UNSUPPORTED here — a
 * program that needs them either emits a high-confidence signal (auto-upgrade
 * to xterm) or the user re-runs with `!cmd` (forced xterm). Returns null for
 * anything outside this set so the caller keeps its default behavior.
 */
export function keyToPtyBytes(e: KeyboardEvent): string | null {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.key === 'c' || e.key === 'C') return '\x03';
    if (e.key === 'd' || e.key === 'D') return '\x04';
    return null;
  }
  if (e.altKey || e.metaKey) return null;
  if (e.key === 'Enter') return '\r';
  if (e.key === 'Backspace') return '\x7f';
  if (e.key === 'Tab') return '\t';
  if (e.key.length === 1) return e.key; // any other single printable character
  return null;
}
