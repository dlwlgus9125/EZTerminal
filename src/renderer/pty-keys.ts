import type { KeyboardEvent } from 'react';

/**
 * Keyset forwarded to the PTY child in plain mode (B-R4, generalized M4 for
 * WT parity): printable characters, Enter, Backspace, Tab, Escape, the arrow/
 * navigation/function keys, and Ctrl+<letter> control codes — matching
 * xterm's default plain-key sequences so a running program sees the same
 * bytes it would in Windows Terminal. IME composition is handled by the
 * caller (TerminalPane.tsx / MobileSessionView.tsx compositionend), not here.
 * A program that needs more than this either emits a high-confidence signal
 * (auto-upgrade to xterm, for full-screen/alt-screen use) or the user re-runs
 * with `!cmd` (forced xterm). Returns null for anything outside this set so
 * the caller keeps its default behavior.
 */
export function keyToPtyBytes(e: KeyboardEvent): string | null {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    // Ctrl+<letter> -> control byte (Ctrl+A=\x01 ... Ctrl+Z=\x1a), which
    // subsumes the former Ctrl+C(\x03)/Ctrl+D(\x04) special cases. Ctrl+Shift+
    // <key> is reserved for copy/paste (TerminalContextMenu) — left null, not
    // forwarded.
    if (!e.shiftKey && e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
      return String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
    }
    return null;
  }
  if (e.altKey || e.metaKey) return null;
  switch (e.key) {
    case 'Escape':
      return '\x1b';
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'Insert':
      return '\x1b[2~';
    case 'Delete':
      return '\x1b[3~';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    case 'F1':
      return '\x1bOP';
    case 'F2':
      return '\x1bOQ';
    case 'F3':
      return '\x1bOR';
    case 'F4':
      return '\x1bOS';
    case 'F5':
      return '\x1b[15~';
    case 'F6':
      return '\x1b[17~';
    case 'F7':
      return '\x1b[18~';
    case 'F8':
      return '\x1b[19~';
    case 'F9':
      return '\x1b[20~';
    case 'F10':
      return '\x1b[21~';
    case 'F11':
      return '\x1b[23~';
    case 'F12':
      return '\x1b[24~';
    default:
      break;
  }
  if (e.key.length === 1) return e.key; // any other single printable character
  return null;
}
